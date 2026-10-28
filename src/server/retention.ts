import type { Repo } from "./db.ts";
import type { Config } from "./config.ts";
import { pruneEndedIds, prunePosts, type CoreDb } from "../core/boards.ts";
import { pruneUnbound, sweepBlobs } from "../core/attachments.ts";
import { UNBOUND_TTL_MS } from "../shared/attachments.ts";
import { WRITE_DEDUP_WINDOW_MS } from "../shared/dedup.ts";

export function pruneMessages(repo: Repo, cutoffMs: number): void {
  repo.messages.prune(cutoffMs);
}

export function pruneAudit(repo: Repo, cutoffMs: number): void {
  repo.audit.prune(cutoffMs);
}

function msUntilMidnightUTC(): number {
  const now = new Date();
  const midnight = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
  return midnight.getTime() - Date.now();
}

function isFirstSundayOfMonth(d: Date): boolean {
  return d.getUTCDay() === 0 && d.getUTCDate() <= 7;
}

// The nightly job: messages, posts, ended sessions and audit rows past retention, uploads
// left unbound, write receipts past the dedup window (each write prunes its
// own session's; this is the backstop for sessions that stopped writing),
// then the bytes nothing names any more.
type BoardsChanged = (boards: string[]) => void | Promise<void>;
export async function runRetention(repo: Repo, db: CoreDb, config: Config, now = Date.now(), onBoardsChanged?: BoardsChanged): Promise<void> {
  try {
    // Board posts share the message retention window.
    pruneMessages(repo, now - config.messageRetentionDays * 86_400_000);
    const boards = prunePosts(db, now - config.messageRetentionDays * 86_400_000);
    if (boards.length) {
      try { void Promise.resolve(onBoardsChanged?.(boards)).catch(() => {}); } catch {}
    }
    // Ended sessions' rows share it too (#328): a keyed one leaves a
    // tombstone, so its key coming back is audited as reused.
    pruneEndedIds(db, now - config.messageRetentionDays * 86_400_000, now);
    pruneAudit(repo, now - config.auditRetentionDays * 86_400_000);
    pruneUnbound(db, now - UNBOUND_TTL_MS);
    repo.writeReceipts.prune(now - WRITE_DEDUP_WINDOW_MS);
  } catch (e) {
    console.error("[grayboard] retention failed:", e);
  }
  // Also finishes any sweep a crash or a failed delete left.
  const swept = await sweepBlobs(db, repo.blobs);
  if (swept) console.error(`[grayboard] retention: deleted ${swept} attachment blobs`);
}

export function startRetentionJobs(repo: Repo, db: CoreDb, config: Config, opts: { firstDelayMs?: number } = {}, onBoardsChanged?: BoardsChanged): () => void {
  const runNightly = () => void runRetention(repo, db, config, Date.now(), onBoardsChanged);

  const runVacuumIfNeeded = () => {
    const d = new Date();
    if (d.getUTCHours() === 4 && isFirstSundayOfMonth(d)) {
      // VACUUM requires direct DB access; skipped in v1 POC.
      // Future: expose incremental_vacuum via Repo and call it here.
    }
  };

  let nightly: ReturnType<typeof setTimeout> | undefined;
  let daily: ReturnType<typeof setInterval> | undefined;

  const scheduleNightly = () => {
    const delay = opts.firstDelayMs ?? msUntilMidnightUTC();
    nightly = setTimeout(() => {
      nightly = undefined;
      runNightly();
      runVacuumIfNeeded();
      daily = setInterval(() => {
        runNightly();
        runVacuumIfNeeded();
      }, 86_400_000);
    }, delay);
  };

  scheduleNightly();
  return () => {
    if (nightly) clearTimeout(nightly);
    if (daily) clearInterval(daily);
  };
}
