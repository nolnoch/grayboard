// Local mode's retention: the server's rule (src/server/retention.ts) for a
// bus with no operator. Every session runs it; a row in the bus marks the last
// run, so the sessions sharing a bus prune it at most once a day between them.
import type { Database } from "bun:sqlite";

import { DEFAULT_RETENTION_DAYS, parseRetentionDays, prunePosts } from "../core/boards.ts";
import { dropAttachments, pruneUnbound, sweepBlobs, type BlobStore } from "../core/attachments.ts";
import { UNBOUND_TTL_MS } from "../shared/attachments.ts";

const DAY_MS = 86_400_000;
// How often a long session checks whether a day has passed since the last run.
const CHECK_MS = 3_600_000;

// BUS_RETENTION_DAYS: how long messages and posts keep (default: the server's).
// Null if it isn't a positive whole number — the shared rule is src/core/boards.ts's
// parseRetentionDays; this wrapper keeps local's env shape and null-on-invalid contract.
export function retentionDays(env: Record<string, string | undefined> = process.env): number | null {
  return parseRetentionDays(env.BUS_RETENTION_DAYS, DEFAULT_RETENTION_DAYS);
}

// Replies outlive pruned parents as roots; parent_id is a foreign key.
function pruneMessages(db: Database, olderThanMs: number): void {
  db.transaction(() => {
    db.prepare(`DELETE FROM dm_acks WHERE message_id IN (SELECT id FROM messages WHERE created_at < ?)`).run(olderThanMs);
    db.prepare(`UPDATE messages SET parent_id = NULL WHERE parent_id IN (SELECT id FROM messages WHERE created_at < ?)`).run(olderThanMs);
    dropAttachments(db, "message", "SELECT id FROM messages WHERE created_at < ?", olderThanMs);
    db.prepare(`DELETE FROM messages WHERE created_at < ?`).run(olderThanMs);
  }).immediate();
}

// Takes today's run for this process: false if another session ran within a day.
function claimRun(db: Database, now: number): boolean {
  return db.transaction(() => {
    const row = db.prepare(`SELECT last_run FROM retention_runs WHERE id = 1`).get() as { last_run: number } | null;
    if (row && now - row.last_run < DAY_MS) return false;
    db.prepare(`INSERT OR REPLACE INTO retention_runs (id, last_run) VALUES (1, ?)`).run(now);
    return true;
  }).immediate();
}

// Messages and posts older than `days`, uploads left unbound, then the bytes
// nothing names any more. Returns false without pruning if the bus was pruned
// within the last day.
export async function runLocalRetention(db: Database, blobs: BlobStore, days: number, now = Date.now()): Promise<boolean> {
  try {
    if (!claimRun(db, now)) return false;
    pruneMessages(db, now - days * DAY_MS);
    prunePosts(db, now - days * DAY_MS);
    pruneUnbound(db, now - UNBOUND_TTL_MS);
  } catch (e) {
    console.error("[grayboard] retention failed:", e);
  }
  // Also finishes any sweep a crash or a failed delete left.
  const swept = await sweepBlobs(db, blobs);
  if (swept) console.error(`[grayboard] retention: deleted ${swept} attachment blobs`);
  return true;
}

// Runs retention now and checks hourly after, for sessions that stay up for days.
export function startLocalRetention(db: Database, blobs: BlobStore, days: number): { stop(): void } {
  const run = () => void runLocalRetention(db, blobs, days);
  run();
  const timer = setInterval(run, CHECK_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
