import type { Repo } from "./db.ts";
import type { Config } from "./config.ts";
import { pruneEndedIds, prunePosts, type CoreDb } from "../core/boards.ts";
import { pruneUnbound, sweepBlobs } from "../core/attachments.ts";
import { UNBOUND_TTL_MS } from "../shared/attachments.ts";
import { WRITE_DEDUP_WINDOW_MS } from "../shared/dedup.ts";
import { logReclaimed, RECLAIM_PAGES_PER_RUN } from "../core/sqlite.ts";

export { RECLAIM_PAGES_PER_RUN };

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

// Shrinks the file by the pages retention freed (#137). A database created
// before #170 has auto_vacuum=NONE and reclaims nothing: say so, with the fix,
// while it has free pages to reclaim.
export function reclaimFreePages(repo: Repo, maxPages = RECLAIM_PAGES_PER_RUN): void {
  logReclaimed(repo.storage.reclaimFreePages(maxPages), "docs/guide/server.md §Reclaiming disk space");
}

// The nightly job: messages, posts, ended sessions and audit rows past retention, uploads
// left unbound, write receipts past the dedup window (each write prunes its
// own session's; this is the backstop for sessions that stopped writing),
// then the bytes nothing names any more, then the free pages that left.
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
  try {
    reclaimFreePages(repo);
  } catch (e) {
    console.error("[grayboard] retention: reclaiming free pages failed:", e);
  }
}

export function startRetentionJobs(repo: Repo, db: CoreDb, config: Config, opts: { firstDelayMs?: number } = {}, onBoardsChanged?: BoardsChanged): () => void {
  const runNightly = () => void runRetention(repo, db, config, repo.now(), onBoardsChanged);

  let nightly: ReturnType<typeof setTimeout> | undefined;
  let daily: ReturnType<typeof setInterval> | undefined;

  const scheduleNightly = () => {
    const delay = opts.firstDelayMs ?? msUntilMidnightUTC();
    nightly = setTimeout(() => {
      nightly = undefined;
      runNightly();
      daily = setInterval(runNightly, 86_400_000);
    }, delay);
  };

  scheduleNightly();
  return () => {
    if (nightly) clearTimeout(nightly);
    if (daily) clearInterval(daily);
  };
}
