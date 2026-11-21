import type { Repo } from "./db.ts";
import { isTx, type Read } from "./store/tx.ts";
import { atSite } from "./store/queue.ts";

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
  | "auth.dev_login_refused"
  | "auth.dev_sessions_revoked"
  | "auth.grant_revoked"
  | "auth.login"
  | "auth.logout"
  | "auth.rate_limit_ended"
  | "auth.rate_limit_full"
  | "auth.rate_limited"
  | "auth.session_revoked"
  | "auth.subject_cleared"
  | "auth.subject_linked"
  | "auth.subject_refused"
  | "auth.user_disabled"
  | "auth.user_enabled"
  | "auth.user_refused"
  | "bridge.notified"
  | "bridge.stopped"
  | "alias.created"
  | "alias.meta_set"
  | "alias.revoked"
  | "alias.deleted"
  | "bind.rate_limit_ended"
  | "bind.rate_limited"
  | "hosted.alias_lost_notified"
  | "hosted.alias_lost_seen"
  | "hosted.capacity_refused"
  | "hosted.child_parked"
  | "hosted.child_registered"
  | "hosted.child_released"
  | "hosted.child_unparked"
  | "hosted.grant_attached"
  | "hosted.lease_closed"
  | "hosted.lease_detached"
  | "hosted.lease_opened"
  | "hosted.lease_restart_credit"
  | "hosted.legacy_dormant"
  | "hosted.legacy_dropped"
  | "hosted.legacy_rehydrated"
  | "hosted.ownership_started"
  | "hosted.stale_capability"
  | "hosted.stream_closed"
  | "hosted.write"
  | "oauth.authorize"
  | "oauth.authorize_refused"
  | "oauth.builtin_client_grant_revoked"
  | "oauth.cimd_failed"
  | "oauth.cimd_refused"
  | "oauth.code_replay_revoked"
  | "oauth.consent_approved"
  | "oauth.consent_denied"
  | "oauth.domain_refused"
  | "oauth.grant_issued"
  | "oauth.rate_limit_ended"
  | "oauth.rate_limit_full"
  | "oauth.rate_limited"
  | "oauth.refresh_replay_revoked"
  | "oauth.refreshed"
  | "oauth.request_failed"
  | "oauth.request_refused"
  | "oauth.revoke_requested"
  | "oauth.revoked"
  | "oauth.session_issued"
  | "oauth.token_issued"
  | "oauth.upstream_authenticated"
  | "oauth.upstream_denied"
  | "oauth.upstream_failed"
  | "oauth.user_refused"
  | "hosted.rate_limit_ended"
  | "hosted.rate_limited"
  | "id.collision"
  | "id.detached"
  | "id.end_failed"
  | "alias.revoke_failed"
  | "id.ended"
  | "id.child_fallback"
  | "id.child_seen"
  | "id.facts_changed"
  | "id.promoted"
  | "id.reattached"
  | "id.registered"
  | "id.reopened"
  | "id.reused"
  | "id.signed_in_local"
  | "message.retracted"
  | "request.receipt_stale"
  | "request.replayed"
  | "request.resent"
  | "role.granted"
  | "role.revoked"
  | "server.started"
  | "service.created"
  | "service.credential_added"
  | "service.credential_revoked"
  | "slack.link_refused"
  | "slack.linked"
  | "slack.relinked"
  | "slack.unlinked"
  | "team.created"
  | "team.member_added"
  | "team.policy_set"
  | "team.member_removed"
  | "delegation.requested"
  | "authz.decision"
  | "authz.suppressed"
  | "delegation.refused"
  | "delegation.throttled"
  | "delegation.throttle_ended"
  | "handle.launcher_set";

/** A request's user agent as audit rows and sessions carry it: at most 120 characters. */
export function userAgent(req: Request): string | null {
  return req.headers.get("user-agent")?.slice(0, 120) ?? null;
}

// `h`: the caller's live `Tx` inside a write body, whose transaction the row joins (and rolls back with); outside one,
// `repo.read`, and the row is posted: through the write queue, waiting behind another body's transaction rather than
// landing inside it (#807 P1b-4b). A post inside an open transaction refuses (#807 P3 A3), so an in-body caller passes its Tx.
// A posted row is keyed (#1510, docs/future/postgres-server.md D4) by its subject: `audit:t:<target>`, or
// `audit:a:<actor>` for a row with no target. On Postgres it overlaps every keyed body but one posting about the same
// subject, and conflicts with exclusive ones. The body is one INSERT into access_log, which has no foreign key or unique
// column beyond its identity, takes no lock another body waits on, and reads no in-memory state (the row is built here).
// A subject's rows commit in posting order, so its history reads in order by id (a session's legacy_dormant before its
// legacy_dropped), and audit.last, a (action, target) pair's newest by time then id, never sees an older row as newest.
// Rows of different subjects may commit out of posting order; nothing orders across subjects. The one read-then-write
// over access_log, the bridge-notice dedup (audit.lock, then audit.last), runs in exclusive bodies.
export function writeAudit(
  repo: Repo,
  h: Read,
  action: AuditAction,
  actor: string | null,
  target: string | null,
  detail?: Record<string, unknown>,
): void {
  const row = { at: repo.now(), actor, action, target, detail: detail ? JSON.stringify(detail) : null };
  if (isTx(h)) { repo.audit.write(h, row); return; }
  atSite("audit", () => repo.postKeyed([target === null ? `audit:a:${actor ?? ""}` : `audit:t:${target}`], (tx) => repo.audit.write(tx, row), undefined, `audit ${action}`));
}
