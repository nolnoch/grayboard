// The server's authorization seam (#806). Every allow-or-deny decision the
// server makes about who may do what is `authorize()`: pure, writing nothing.
// The caller that owns a requested act records its decision with
// `recordDecision` (an `authz.decision` row: every deny, and the allows of
// team management and admin routes); filter checks (board visibility, mention
// fan-out, a thread reply's reach, the alias sweep) write no rows. The rule
// helpers below are this module's own: nothing else calls them (policy.test.ts).
import { addressParts, type ScopeKind } from "../core/addresses.ts";
import type { Principal } from "../core/resolver.ts";
import { HUMAN_NAME, HUMAN_RESERVED } from "../shared/addressing.ts";
import { writeAudit } from "./audit.ts";
import type { Repo, Team } from "./db.ts";
import { RateLimiter, type RateLimit } from "./rate_limit.ts";

// Who besides you can reach your human (your phone, through the Slack
// bridge): people who share a team with you, or everyone signed in.
export type HumanReach = "team" | "all";

export type PolicyContext = { humanReach?: HumanReach; admins?: readonly string[] };

export type ActScope = { scope_kind: ScopeKind; scope_ref: string };

// The verb fixes the resource. msg.send: a requested DM (canSend);
// human.reach: the same rule as a filter (mentions, thread replies);
// alias.bind / act_as / scope.act: principal p acting in a scope, for a bind
// or writes_as, an HTTP `as`, and visibility or the alias sweep (a bind and an
// `as` name the alias, which is never `human`; an `as` whose scope no
// principal owns has a null scope); session.act: an HTTP `as` naming a session
// ID, with that ID's row as the caller found it; hosted.session: a hosted MCP
// request reaching a hosted session row (its own, or a session_end target), by
// the requester's and the row's user ID and OAuth client; team.read / team.manage /
// team.leave: a user reading, changing or leaving a team's membership; admin: an
// admin route; msg.wake: whether a delivery written by one signed-in user
// wakes a session of another (users by email: the writer recorded at write
// time and the receiving session's user, never an address's spelling, F-01).
export type AuthzRequest =
  | { verb: "msg.send" | "human.reach"; from: string; to: string }
  | { verb: "scope.act"; principal: Principal; scope: ActScope }
  | { verb: "alias.bind"; principal: Principal; scope: ActScope; name: string }
  | { verb: "act_as"; principal: Principal; address: string; name: string; scope: ActScope | null }
  | { verb: "session.act"; user: string; session: string; row: SessionFacts | undefined }
  | { verb: "hosted.session"; session: string; user: number; client: string; row: { user: number; client: string } }
  | { verb: "team.read" | "team.manage" | "team.leave"; user: { id: number; email: string }; team: Team | undefined }
  | { verb: "admin"; email: string }
  | { verb: "msg.wake"; from_user: string; to_user: string };

// What session.act judges of an ID's row: whose it is, and whether it's a
// viewer's or has ended.
export type SessionFacts = { principal: string | null; viewer: boolean; ended_at: number | null };

export type Decision =
  | { allow: true; rule: string }
  | { allow: false; code: "forbidden" | "not_found"; reason: string; rule: string };

// Who asked: the signed-in user (null for none), and, when the act came
// through a session, the address it acted as and the session's ID. The Slack
// bridge's human connections have no session ID. (The OAuth client joins
// these rows with #847.)
export type Actor = { user: string | null; address?: string; session?: string };

const allow = (rule: string): Decision => ({ allow: true, rule });
const deny = (rule: string, reason: string, code: "forbidden" | "not_found" = "forbidden"): Decision => ({ allow: false, code, reason, rule });

export function authorize(repo: Repo, ctx: PolicyContext, req: AuthzRequest): Decision {
  switch (req.verb) {
    case "msg.send":
    case "human.reach": {
      const rule = humanRule(repo, ctx.humanReach ?? "team", req.from, req.to);
      return rule.allow ? allow(rule.rule) : deny(rule.rule, `${req.to} is a person's phone, reachable only by their teammates' agents`);
    }
    case "scope.act":
      return actIn(repo, req.principal, req.scope);
    case "alias.bind":
      return req.name === HUMAN_NAME ? deny("alias.human_reserved", HUMAN_RESERVED) : actIn(repo, req.principal, req.scope);
    case "act_as":
      if (req.name === HUMAN_NAME) return deny("alias.human_reserved", HUMAN_RESERVED);
      if (!req.scope) return deny("scope.ownerless", `no principal owns the scope of "${req.address}"`);
      return actIn(repo, req.principal, req.scope);
    case "session.act":
      return sessionRule(req.user, req.session, req.row);
    case "hosted.session":
      // Another user's row and another client's of the same user read alike, as missing (#851).
      if (req.row.user !== req.user) return deny("hosted.other_user", "session not found", "not_found");
      if (req.row.client !== req.client) return deny("hosted.other_client", "session not found", "not_found");
      return allow("hosted.own");
    case "team.leave":
      return req.team && repo.teams.isMember(req.team.id, req.user.id) ? allow("team.member") : deny("team.member", "not found", "not_found");
    case "team.read": {
      const { team, user } = req;
      if (team && repo.teams.isMember(team.id, user.id)) return allow("team.member");
      if (team && isAdmin(ctx, user.email)) return allow("admin.env");
      return deny("team.member", "not found", "not_found");
    }
    case "team.manage": {
      const { team, user } = req;
      const member = !!team && repo.teams.isMember(team.id, user.id);
      if (!team || (!member && !isAdmin(ctx, user.email))) return deny("team.member", "not found", "not_found");
      if (member && repo.teams.isOwner(team.id, user.id)) return allow("team.owner");
      if (isAdmin(ctx, user.email)) return allow("admin.env");
      return deny("team.owner", `only an owner of team "${team.name}" (or an admin) can add or remove members; \`grayboard team members ${team.name}\` lists its owners`);
    }
    case "msg.wake":
      return wakeRule(repo, req.from_user, req.to_user);
    case "admin": {
      if (isAdmin(ctx, req.email)) return allow("admin.env");
      const admins = ctx.admins ?? [];
      return deny("admin.env", admins.length === 0 ? "no admins are configured on this server (GRAYBOARD_ADMINS)" : `${req.email} is not an admin`);
    }
  }
}

// The request's subject, for the row's target and detail: what was asked for.
function subject(req: AuthzRequest): { target: string | null; detail: Record<string, unknown> } {
  switch (req.verb) {
    case "msg.send":
    case "human.reach":
      return { target: req.to, detail: { from: req.from, to: req.to } };
    case "scope.act":
      return { target: `${req.scope.scope_kind}:${req.scope.scope_ref}`, detail: { principal: req.principal.name, scope_kind: req.scope.scope_kind, scope_ref: req.scope.scope_ref } };
    case "alias.bind":
      return { target: `${req.scope.scope_kind}:${req.scope.scope_ref}`, detail: { principal: req.principal.name, scope_kind: req.scope.scope_kind, scope_ref: req.scope.scope_ref, name: req.name } };
    case "act_as":
      // The actor's address is the alias asked for; an ownerless one has no scope, so the target is the address.
      return { target: req.scope ? `${req.scope.scope_kind}:${req.scope.scope_ref}` : req.address, detail: { principal: req.principal.name, scope_kind: req.scope?.scope_kind ?? null, scope_ref: req.scope?.scope_ref ?? null, name: req.name } };
    case "session.act":
      return { target: req.session, detail: { session_requested: req.session } };
    case "hosted.session":
      return { target: req.session, detail: { session_requested: req.session, client: req.client } };
    case "team.read":
    case "team.manage":
    case "team.leave":
      return { target: req.team ? `team:${req.team.name}` : null, detail: { team: req.team?.name ?? null } };
    case "admin":
      return { target: null, detail: {} };
    case "msg.wake":
      return { target: req.to_user, detail: { from_user: req.from_user, to_user: req.to_user } };
  }
}

// Deny rows per user (security audit F-19): an authenticated client looping
// on a refused act, over HTTP routes no request limiter covers, would
// otherwise write a 90-day row per request. Past the burst a user's denies go
// unrecorded until the bucket refills; the streak's end writes one
// `authz.suppressed` row with the count. Allows aren't thinned: only owners
// and admins reach them. One limiter per Repo (per server).
export const DENY_ROW_LIMIT: RateLimit = { burst: 30, perSec: 0.5 };
const denyLimiters = new WeakMap<Repo, RateLimiter>();
function denyLimiter(repo: Repo): RateLimiter {
  let l = denyLimiters.get(repo);
  if (!l) {
    l = new RateLimiter(DENY_ROW_LIMIT, { start() {}, end: (user, refused) => writeAudit(repo, "authz.suppressed", user, null, { refused }) }, Date.now, 4096);
    denyLimiters.set(repo, l);
  }
  return l;
}

// A caller-chosen string (a URL path, a requested team name) is clipped
// before it lands in a row.
const MAX_DETAIL = 128;
const clip = (v: unknown): unknown => (typeof v === "string" && v.length > MAX_DETAIL ? `${v.slice(0, MAX_DETAIL)}…` : v);

// An `authz.decision` row: the actor's user in the actor column, both halves
// of who asked (user, and address/session) in the detail. Written through
// writeAudit, so a request's IP and user agent join it (F-19).
export function recordDecision(repo: Repo, actor: Actor, req: AuthzRequest, d: Decision, extra: Record<string, unknown> = {}): void {
  if (!d.allow) {
    const limiter = denyLimiter(repo);
    limiter.sweep();
    if (!limiter.take(actor.user ?? "").ok) return;
  }
  const { target, detail } = subject(req);
  writeAudit(repo, "authz.decision", actor.user, typeof target === "string" ? (clip(target) as string) : target, {
    verb: req.verb,
    allow: d.allow,
    rule: d.rule,
    ...(d.allow ? {} : { code: d.code, reason: d.reason }),
    ...Object.fromEntries(Object.entries({ ...detail, ...extra }).map(([k, v]) => [k, clip(v)])),
    user: actor.user,
    address: actor.address ?? null,
    session: actor.session ?? null,
  });
}

function isAdmin(ctx: PolicyContext, email: string): boolean {
  return (ctx.admins ?? []).includes(email.toLowerCase());
}

// Whether principal p may act in a scope: bind an alias there, or write as
// one (#284 S9). Keyed by principal, not by email: a user acts in its own
// person scope and in the teams it belongs to. Service scopes, and service
// principals acting anywhere, wait for #270's grants.
function actIn(repo: Repo, p: Principal, scope: ActScope): Decision {
  const ref = scope.scope_ref;
  if (scope.scope_kind === "service" || p.kind === "service") return deny("scope.service", "service principals arrive with #270");
  if (p.kind !== "user") return deny("scope.user_only", `${p.name} is a ${p.kind}, not a user`);
  if (scope.scope_kind === "person") return ref === p.name ? allow("scope.own_person") : deny("scope.own_person", `${ref}'s scope isn't ${p.name}'s`);
  const userId = repo.principals.findByName(p.name)?.user_id;
  const team = repo.teams.findByName(ref);
  return userId != null && team && repo.teams.isMember(team.id, userId)
    ? allow("scope.team_member")
    : deny("scope.team_member", `${p.name} isn't a member of team ${ref}`);
}

// Whether a user may act as a session ID over HTTP (an `as`, #284 S11): its
// own live, non-viewer session. A missing row, a viewer's and another user's
// read alike, so a refusal never says whose an ID is.
function sessionRule(user: string, session: string, row: SessionFacts | undefined): Decision {
  const notYours = `${session} isn't a session of yours`;
  if (!row) return deny("session.unknown", notYours);
  if (row.viewer) return deny("session.viewer", notYours);
  if (row.principal !== user) return deny("session.other_user", notYours);
  if (row.ended_at !== null) return deny("session.ended", `${session} ended at ${new Date(row.ended_at).toISOString()}`);
  return allow("session.own");
}

// Whether what one user's session wrote may wake another user's session
// (security audit F-03, #103; vision.md principle 9). Sending stays open
// (msg.send); without this grant the item is delivered as mail that doesn't
// wake. A user's own agents wake each other; across users, only members of a
// shared 'collaborative' team do. No admin exemption: admin is a server role,
// not a messaging grant. One indexed lookup per decision (principle 11).
function wakeRule(repo: Repo, fromUser: string, toUser: string): Decision {
  if (fromUser === toUser) return allow("wake.same_user");
  const a = repo.users.findByEmail(fromUser), b = repo.users.findByEmail(toUser);
  if (a && b && repo.teams.shareCollaborative(a.id, b.id)) return allow("wake.team_policy");
  return deny("wake.cross_user", `${fromUser} shares no collaborative team with ${toUser}; delivered as mail that doesn't wake their agent`);
}

// Whether the address `from` may wake `to` when `to` is a human
// (`<email>/human`), and the rule that decided. A person reaches their own
// human, and a teammate's (reach "team"); a team alias reaches a member's
// (#284 S12), the analogue of sharing a team. Board mentions and thread
// replies go through this too (access.ts), so a post can't reach a phone a
// DM can't.
function humanRule(repo: Repo, reach: HumanReach, from: string, to: string): { allow: boolean; rule: string } {
  const t = addressParts(to);
  if (t?.kind !== "alias" || t.name !== HUMAN_NAME) return { allow: true, rule: "human.not_human" };
  if (reach === "all") return { allow: true, rule: "human.reach_all" };
  const f = repo.resolver.principalOf(from);
  const them = t.scopeKind === "person" ? repo.users.findByEmail(t.scope) : undefined;
  if (!f || !them) return { allow: false, rule: "human.teammates" };
  if (f.kind === "team") {
    const team = repo.teams.findByName(f.name);
    return { allow: !!team && repo.teams.isMember(team.id, them.id), rule: "human.team_alias" };
  }
  if (f.kind !== "user") return { allow: false, rule: "human.teammates" };
  if (f.name === them.email) return { allow: true, rule: "human.self" };
  const me = repo.users.findByEmail(f.name);
  if (!me) return { allow: false, rule: "human.teammates" };
  const theirs = new Set(repo.teams.listForUser(them.id).map((x) => x.id));
  return { allow: repo.teams.listForUser(me.id).some((x) => theirs.has(x.id)), rule: "human.teammates" };
}

// The pre-seam entry points, as authorize() answers them, for the unit tests
// that exercise each rule directly (can_send.test.ts, access.test.ts). Nothing
// outside this module and tests calls them.
export type SendContext = { db: Repo; now: number; humanReach: HumanReach };
export type SendTarget = { kind: "user"; address: string };
export type SendDecision = { allow: true } | { allow: false; code: "forbidden" | "not_found"; reason: string };

const plain = (d: Decision): SendDecision => (d.allow ? { allow: true } : { allow: false, code: d.code, reason: d.reason });

export function canSend(from: string, target: SendTarget, ctx: SendContext): SendDecision {
  return plain(authorize(ctx.db, { humanReach: ctx.humanReach }, { verb: "msg.send", from, to: target.address }));
}

export function reachesHuman(repo: Repo, reach: HumanReach, from: string, to: string): boolean {
  return authorize(repo, { humanReach: reach }, { verb: "human.reach", from, to }).allow;
}

export function canAdmin(email: string, admins: readonly string[]): SendDecision {
  return plain(authorize(undefined as unknown as Repo, { admins }, { verb: "admin", email }));
}

export function mayActIn(repo: Repo, p: Principal, scope: ActScope): string | null {
  const d = authorize(repo, {}, { verb: "scope.act", principal: p, scope });
  return d.allow ? null : d.reason;
}
