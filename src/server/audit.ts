import type { Repo } from "./db.ts";

export type AuditAction =
  | "auth.login"
  | "auth.logout"
  | "auth.session_revoked"
  | "auth.user_disabled"
  | "auth.user_enabled"
  | "identity.created"
  | "identity.deleted"
  | "team.created"
  | "team.member_added"
  | "team.member_removed";

export function writeAudit(
  repo: Repo,
  action: AuditAction,
  actor: string | null,
  target: string | null,
  detail?: Record<string, unknown>,
): void {
  repo.audit.write({
    at: Date.now(),
    actor,
    action,
    target,
    detail: detail ? JSON.stringify(detail) : null,
  });
}
