// The server's authorization seam (#806). Every allow-or-deny decision the
// server makes about who may do what is `authorize()`: pure, writing nothing.
// The caller that owns a requested act records its decision with
// `recordDecision` (an `authz.decision` row: every deny, and the allows of
// team management and admin routes); filter checks (board visibility, mention
// fan-out, a thread reply's reach, the alias sweep) write no rows. The rule
// helpers below are this module's own: nothing else calls them (policy.test.ts).
import { addressParts, type ScopeKind } from "../core/addresses.ts";
import type { Principal } from "../core/resolver.ts";
import { HUMAN_NAME } from "../shared/addressing.ts";
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
// or writes_as, an HTTP `as`, and visibility or the alias sweep; team.read /
// team.manage: a user reading or changing a team's membership; admin: an
// admin route.
export type AuthzRequest =
  | { verb: "msg.send" | "human.reach"; from: string; to: string }
  | { verb: "alias.bind" | "act_as" | "scope.act"; principal: Principal; scope: ActScope }
  | { verb: "team.read" | "team.manage"; user: { id: number; email: string }; team: Team | undefined }
  | { verb: "admin"; email: string };

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
    case "alias.bind":
    case "act_as":
    case "scope.act":
      return actIn(repo, req.principal, req.scope);
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
    case "alias.bind":
    case "act_as":
    case "scope.act":
      return { target: `${req.scope.scope_kind}:${req.scope.scope_ref}`, detail: { principal: req.principal.name, scope_kind: req.scope.scope_kind, scope_ref: req.scope.scope_ref } };
    case "team.read":
    case "team.manage":
      return { target: req.team ? `team:${req.team.name}` : null, detail: { team: req.team?.name ?? null } };
    case "admin":
      return { target: null, detail: {} };
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
