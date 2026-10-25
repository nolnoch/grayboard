import type { Repo } from "./db.ts";

export type AuditAction =
  | "attachment.bound"
  | "attachment.downloaded"
  | "attachment.download_failed"
  | "attachment.download_refused"
  | "attachment.released"
  | "attachment.sent_to_slack"
  | "attachment.slack_refused"
  | "attachment.upload_failed"
  | "attachment.upload_refused"
  | "attachment.uploaded"
  | "auth.login"
  | "auth.logout"
  | "auth.session_revoked"
  | "auth.user_disabled"
  | "auth.user_enabled"
  | "hello.rate_limited"
  | "identity.created"
  | "identity.deleted"
  | "slack.linked"
  | "slack.unlinked"
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
