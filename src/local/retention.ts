// Local mode's retention: the server's rule (src/server/retention.ts) for a
// bus with no operator. Every session runs it; a row in the bus marks the last
// run, so the sessions sharing a bus prune it at most once a day between them.
// A setting stored in the bus (`grayboard retention`) outranks each session's
// env, so no session can disagree with it: off means no history is deleted.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

import { DEFAULT_RETENTION_DAYS, parseRetentionDays, pruneEndedIds, prunePosts } from "../core/boards.ts";
import { dropAttachments, pruneUnbound, sweepBlobs, type BlobStore } from "../core/attachments.ts";
import { openSqlite } from "../core/sqlite.ts";
import { UNBOUND_TTL_MS } from "../shared/attachments.ts";
import { refuseForbiddenBus, RETENTION_SETTING_SQL } from "./open.ts";
import { privateDbFiles, privateDir } from "./perms.ts";

const DAY_MS = 86_400_000;
// How often a long session checks whether a day has passed since the last run.
const CHECK_MS = 3_600_000;

// BUS_RETENTION_DAYS: how long messages and posts keep (default: the server's).
// Null if it isn't a positive whole number — the shared rule is src/core/boards.ts's
// parseRetentionDays; this wrapper keeps local's env shape and null-on-invalid contract.
export function retentionDays(env: Record<string, string | undefined> = process.env): number | null {
  return parseRetentionDays(env.BUS_RETENTION_DAYS, DEFAULT_RETENTION_DAYS);
}

// The stored setting: days null is off. Null if none is stored.
export type RetentionSetting = { days: number | null; set_at: number };

function storedSetting(db: Database): RetentionSetting | null {
  return db.prepare(`SELECT days, set_at FROM retention_setting WHERE id = 1`).get() as RetentionSetting | null;
}

// The bus's setting at `path`, read without creating or upgrading anything.
export function readRetentionSetting(path: string): RetentionSetting | null {
  if (!existsSync(path)) return null;
  const db = new Database(path, { readonly: true });
  try {
    const table = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'retention_setting'`).get();
    return table ? storedSetting(db) : null;
  } finally { db.close(); }
}

// Stores `days` (null: off), or clears the setting (undefined), and returns the
// setting it replaced. It runs before an upgrade's first session can prune, on a
// bus that older sessions may be serving, so it touches its own table alone: no
// schema upgrade, and no ending of dead sessions, unlike openLocalDb.
export function writeRetentionSetting(path: string, days: number | null | undefined, now = Date.now()): RetentionSetting | null {
  refuseForbiddenBus(path);
  privateDir(dirname(path));
  privateDbFiles(path);
  const db = openSqlite(path, "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;", (d) => d.exec(RETENTION_SETTING_SQL));
  try {
    return db.transaction(() => {
      const before = storedSetting(db);
      if (days === undefined) db.prepare(`DELETE FROM retention_setting WHERE id = 1`).run();
      else db.prepare(`INSERT OR REPLACE INTO retention_setting (id, days, set_at) VALUES (1, ?, ?)`).run(days, now);
      return before;
    }).immediate();
  } finally { db.close(); }
}

// Replies outlive pruned parents as roots; parent_id is a foreign key.
function pruneMessages(db: Database, olderThanMs: number, deleted: Record<string, number>): void {
  const counts = db.transaction(() => {
    const dm_acks = db.prepare(`DELETE FROM dm_acks WHERE message_id IN (SELECT id FROM messages WHERE created_at < ?)`).run(olderThanMs).changes;
    db.prepare(`UPDATE messages SET parent_id = NULL WHERE parent_id IN (SELECT id FROM messages WHERE created_at < ?)`).run(olderThanMs);
    const attachments = dropAttachments(db, "message", "SELECT id FROM messages WHERE created_at < ?", olderThanMs);
    const messages = db.prepare(`DELETE FROM messages WHERE created_at < ?`).run(olderThanMs).changes;
    return { messages, dm_acks, attachments };
  }).immediate();
  for (const [table, n] of Object.entries(counts)) deleted[table] = (deleted[table] ?? 0) + n;
}

// Takes today's run for this process, reading the window in the same
// transaction: undefined if another session ran within a day, else the days to
// keep (null: off). Off still takes the run, so its upload cleanup stays daily;
// turning retention back on can therefore wait up to a day.
function claimRun(db: Database, now: number, fallbackDays: number): number | null | undefined {
  return db.transaction(() => {
    const row = db.prepare(`SELECT last_run FROM retention_runs WHERE id = 1`).get() as { last_run: number } | null;
    if (row && now - row.last_run < DAY_MS) return undefined;
    db.prepare(`INSERT OR REPLACE INTO retention_runs (id, last_run) VALUES (1, ?)`).run(now);
    const stored = storedSetting(db);
    return stored ? stored.days : fallbackDays;
  }).immediate();
}

// Messages, posts and ended sessions older than the window, uploads left unbound,
// then the bytes nothing names any more. The window is the bus's stored setting,
// re-read on every run so a long session sees a change, else `fallbackDays`; with
// retention off only the unbound uploads and unnamed bytes go. Returns false
// without pruning if the bus was pruned within the last day.
export async function runLocalRetention(db: Database, blobs: BlobStore, fallbackDays: number, now = Date.now()): Promise<boolean> {
  const deleted: Record<string, number> = {};
  try {
    const days = claimRun(db, now, fallbackDays);
    if (days === undefined) return false;
    if (days !== null) {
      const cutoff = now - days * DAY_MS;
      pruneMessages(db, cutoff, deleted);
      prunePosts(db, cutoff, deleted);
      deleted.audit_log = db.prepare(`DELETE FROM audit_log WHERE at < ?`).run(cutoff).changes;
      deleted.ids = pruneEndedIds(db, cutoff, now);
    }
    deleted.attachments = (deleted.attachments ?? 0) + pruneUnbound(db, now - UNBOUND_TTL_MS);
  } catch (e) {
    console.error("[grayboard] retention failed:", e);
  }
  // In both cases: a failed step's predecessors have committed.
  if (Object.values(deleted).some((n) => n > 0)) {
    const counts = Object.entries(deleted).sort(([a], [b]) => a.localeCompare(b)).map(([table, n]) => `${table}=${n}`).join(" ");
    console.error(`[grayboard] retention: deleted ${counts}`);
  }
  // Also finishes any sweep a crash or a failed delete left.
  const swept = await sweepBlobs(db, blobs);
  if (swept) console.error(`[grayboard] retention: deleted ${swept} attachment blobs`);
  return true;
}

// Runs retention now and checks hourly after, for sessions that stay up for days.
export function startLocalRetention(db: Database, blobs: BlobStore, fallbackDays: number): { stop(): void } {
  const run = () => void runLocalRetention(db, blobs, fallbackDays);
  run();
  const timer = setInterval(run, CHECK_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
