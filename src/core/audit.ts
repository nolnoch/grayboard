// Local mode's audit trail (the server's is src/server/audit.ts through the
// Repo facade). The delegation slice writes the same actions both modes
// write: delegation.requested, delegation.refused, handle.launcher_set.
// Rows land in the shared audit_log table (core/schema.ts) and are pruned
// with the bus's retention (src/local/retention.ts).
import type { Database } from "bun:sqlite";

export type CoreAuditAction = "delegation.requested" | "delegation.refused" | "handle.launcher_set";

export function writeCoreAudit(
  db: Database,
  action: CoreAuditAction,
  actor: string,
  target: string | null,
  detail?: Record<string, unknown>,
): void {
  db.prepare(`INSERT INTO audit_log (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)`).run(
    Date.now(),
    actor,
    action,
    target,
    detail ? JSON.stringify(detail) : null,
  );
}
