import type { Repo } from "./db.ts";
import type { Config } from "./config.ts";

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

export function startRetentionJobs(repo: Repo, config: Config): void {
  const runNightly = () => {
    const now = Date.now();
    pruneMessages(repo, now - config.messageRetentionDays * 86_400_000);
    pruneAudit(repo, now - config.auditRetentionDays * 86_400_000);
  };

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
