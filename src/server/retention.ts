import type { Repo } from "./db.ts";
import { sweepStoredBlobs } from "./attachments.ts";
import type { Tx } from "./store/tx.ts";
import type { Config } from "./config.ts";
import { UNBOUND_TTL_MS } from "../shared/attachments.ts";
import { WRITE_DEDUP_WINDOW_MS } from "../shared/dedup.ts";
import { logReclaimed, RECLAIM_PAGES_PER_RUN } from "../core/sqlite.ts";
import { testPauseAsync } from "../shared/testpause.ts";

export { RECLAIM_PAGES_PER_RUN };

export function pruneMessages(repo: Repo, tx: Tx, cutoffMs: number): Promise<void> {
  return repo.messages.prune(tx, cutoffMs);
}

export function pruneAudit(repo: Repo, tx: Tx, cutoffMs: number): Promise<void> {
  return repo.audit.prune(tx, cutoffMs);
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
export async function reclaimFreePages(repo: Repo, maxPages = RECLAIM_PAGES_PER_RUN): Promise<void> {
  logReclaimed(await repo.storage.reclaimFreePages(maxPages), "docs/guide/server.md §Reclaiming disk space");
}

// The nightly job: messages, posts, ended sessions and audit rows past retention, uploads
// left unbound, write receipts past the dedup window (each write prunes its
// own session's; this is the backstop for sessions that stopped writing),
// then the bytes nothing names any more, then the free pages that left. `stopped`: the server's stop has begun, so
// the steps not yet started are skipped and the pass settles before the store closes (#1489); each step is its own
// transaction, so stopping between two leaves nothing half done.
type BoardsChanged = (boards: string[]) => void | Promise<void>;
export async function runRetention(repo: Repo, config: Config, now = Date.now(), onBoardsChanged?: BoardsChanged, stopped: () => boolean = () => false): Promise<void> {
  // Each prune is its own transaction through the write queue (#807 D4), short as the separate statements were,
  // so requests interleave between them rather than wait out the whole run. Each has its own try (#1387): one that
  // fails (on Postgres, a deadlock victim) is logged and the rest still run.
  const step = async (name: string, run: () => Promise<unknown>) => {
    if (stopped()) return;
    try {
      await run();
    } catch (e) {
      console.error(`[grayboard] retention failed (${name}):`, e);
    }
  };
  const cutoff = now - config.messageRetentionDays * 86_400_000;
  // Board posts share the message retention window.
  await step("messages", () => repo.write(tx => pruneMessages(repo, tx, cutoff)));
  await testPauseAsync("retention:between");
  await step("posts", () => repo.write((tx: Tx) => repo.boards.prunePosts(tx, cutoff), boards => {
    if (boards.length) {
      try { void Promise.resolve(onBoardsChanged?.(boards)).catch(() => {}); } catch {}
    }
  }));
  // Ended sessions' rows share it too (#328): a keyed one leaves a
  // tombstone, so its key coming back is audited as reused.
  await step("ended sessions", () => repo.write(tx => repo.sessionEnd.pruneEnded(tx, cutoff, now)));
  await step("audit", () => repo.write((tx) => pruneAudit(repo, tx, now - config.auditRetentionDays * 86_400_000)));
  await step("unbound uploads", () => repo.write(tx => repo.attachments.pruneUnbound(tx, now - UNBOUND_TTL_MS)));
  await step("write receipts", () => repo.write(tx => repo.writeReceipts.prune(tx, now - WRITE_DEDUP_WINDOW_MS)));
  if (stopped()) return;
  // Also finishes any sweep a crash or a failed delete left.
  const swept = await sweepStoredBlobs(repo);
  if (swept) console.error(`[grayboard] retention: deleted ${swept} attachment blobs`);
  if (stopped()) return;
  try {
    // As the queue's holder: no other write is mid-transaction while the pages go.
    await repo.write(() => reclaimFreePages(repo));
  } catch (e) {
    console.error("[grayboard] retention: reclaiming free pages failed:", e);
  }
}

// The returned stop clears the timers and resolves once a pass already running has settled (#1489): the server's
// stop awaits it before it closes the store, so the pass never resumes onto a closed database.
export function startRetentionJobs(repo: Repo, config: Config, opts: { firstDelayMs?: number } = {}, onBoardsChanged?: BoardsChanged): () => Promise<void> {
  let stopped = false;
  let running: Promise<void> | undefined;
  const runNightly = () => {
    // One pass at a time: a day-long pass (it never is) skips the next tick rather than overlapping it.
    if (stopped || running) return;
    const pass = runRetention(repo, config, repo.now(), onBoardsChanged, () => stopped)
      .catch(e => console.error("[grayboard] retention failed:", e))
      .finally(() => { if (running === pass) running = undefined; });
    running = pass;
  };

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
    stopped = true;
    if (nightly) clearTimeout(nightly);
    if (daily) clearInterval(daily);
    return running ?? Promise.resolve();
  };
}
