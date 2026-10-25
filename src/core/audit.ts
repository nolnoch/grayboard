// Local mode's audit trail (the server's is src/server/audit.ts through the
// Repo facade). The delegation slice writes the same actions both modes
// write: delegation.requested, delegation.refused, handle.launcher_set;
// message.retracted, which a repeated dm_retract is answered from (#254); and
// id.collision, a session refused because its ID already has a row, and
// alias.created, a name's first bind or declaration (#284).
// Rows land in the shared audit_log table (core/schema.ts) and are pruned
// with the bus's retention (src/local/retention.ts).
import type { Database } from "bun:sqlite";

export type CoreAuditAction = "alias.created" | "delegation.requested" | "delegation.refused" | "handle.launcher_set" | "id.collision" | "message.retracted";

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

// The newest row for this action and target, or undefined.
export function lastCoreAudit(
  db: Database,
  action: CoreAuditAction,
  target: string,
): { at: number; actor: string | null; detail: string | null } | undefined {
  return (db
    .prepare(`SELECT at, actor, detail FROM audit_log WHERE action = ? AND target = ? ORDER BY at DESC, rowid DESC LIMIT 1`)
    .get(action, target) as { at: number; actor: string | null; detail: string | null } | null) ?? undefined;
}
