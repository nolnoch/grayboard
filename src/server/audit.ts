import type { Repo } from "./db.ts";

export type AuditAction =
  | `oauth.${string}`
  | `hosted.${string}`
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
  | "auth.rate_limit_ended"
  | "auth.rate_limit_full"
  | "auth.rate_limited"
  | "auth.session_revoked"
  | "auth.user_disabled"
  | "auth.user_enabled"
  | "bridge.notified"
  | "bridge.stopped"
  | "alias.created"
  | "alias.deleted"
  | "hello.rate_limit_ended"
  | "hello.rate_limited"
  | "hosted.rate_limit_ended"
  | "hosted.rate_limited"
  | "id.collision"
  | "message.retracted"
  | "request.replayed"
  | "request.resent"
  | "slack.linked"
  | "slack.unlinked"
  | "team.created"
  | "team.member_added"
  | "team.member_removed"
  | "delegation.requested"
  | "delegation.refused"
  | "handle.launcher_set";

/** A request's user agent as audit rows and sessions carry it: at most 120 characters. */
export function userAgent(req: Request): string | null {
  return req.headers.get("user-agent")?.slice(0, 120) ?? null;
}

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
