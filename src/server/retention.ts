import type { Repo } from "./db.ts";
import type { Config } from "./config.ts";
import { prunePosts, type CoreDb } from "../core/boards.ts";
import { pruneUnbound, sweepBlobs } from "../core/attachments.ts";
import { UNBOUND_TTL_MS } from "../shared/attachments.ts";

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

// The nightly job: messages, posts and audit rows past retention, uploads
// left unbound, then the bytes nothing names any more.
export async function runRetention(repo: Repo, db: CoreDb, config: Config, now = Date.now()): Promise<void> {
  try {
    // Board posts share the message retention window.
    pruneMessages(repo, now - config.messageRetentionDays * 86_400_000);
    prunePosts(db, now - config.messageRetentionDays * 86_400_000);
    pruneAudit(repo, now - config.auditRetentionDays * 86_400_000);
    pruneUnbound(db, now - UNBOUND_TTL_MS);
  } catch (e) {
    console.error("[grayboard] retention failed:", e);
  }
  // Also finishes any sweep a crash or a failed delete left.
  const swept = await sweepBlobs(db, repo.blobs);
  if (swept) console.error(`[grayboard] retention: deleted ${swept} attachment blobs`);
}

export function startRetentionJobs(repo: Repo, db: CoreDb, config: Config): void {
  const runNightly = () => void runRetention(repo, db, config);

  const runVacuumIfNeeded = () => {
    const d = new Date();
    if (d.getUTCHours() === 4 && isFirstSundayOfMonth(d)) {
      // VACUUM requires direct DB access; skipped in v1 POC.
      // Future: expose incremental_vacuum via Repo and call it here.
    }
  };

  const scheduleNightly = () => {
    const delay = msUntilMidnightUTC();
    setTimeout(() => {
      runNightly();
      runVacuumIfNeeded();
      setInterval(() => {
        runNightly();
        runVacuumIfNeeded();
      }, 86_400_000);
    }, delay);
  };

  scheduleNightly();
}
