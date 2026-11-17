// The server's authorization seam (#806). Every allow-or-deny decision the
// server makes about who may do what is `decide()`'s, writing nothing. Its rules
// are generators that yield each storage read they need (#807 P3 A7e): one set of
// rule bodies, driven by `authorize` over the store's reads on the caller's
// handle, synchronously over `repo.policyNow` by `authorizeNow` (the SQLite-only
// loader, for the callers that can't await yet: #807 A7g, B, C for healthz), or with no reads at all by `decidePure`.
// The caller that owns a requested act records its decision with
// `recordDecision` (an `authz.decision` row: every deny, and the allows of
// team management and admin routes); filter checks (board visibility, mention
// fan-out, a thread reply's reach, the alias sweep) write no rows. The rule
// helpers below are this module's own: nothing else calls them (policy.test.ts).
// One rule's body lives in core, shared with local mode: attachment.read names
// the rule from core's attachmentReach facts (who may read is canReadAttachment's).
import type { Read } from "./store/tx.ts";
import { addressParts, type ScopeKind } from "../core/addresses.ts";
import type { AttachmentReach } from "../core/attachments.ts";
import type { Principal, Resolver } from "../core/resolver.ts";
import { HUMAN_NAME, HUMAN_RESERVED } from "../shared/addressing.ts";
import { writeAudit } from "./audit.ts";
import type { Alias, PrincipalRow, Repo, Team, User } from "./db.ts";
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
// the requester's and the row's user ID and OAuth client; attachment.read: an
// identity downloading an attachment (by its requested ID's text), with core's
// facts of its carrier (none: no such attachment); team.read / team.manage /
// team.leave: a user reading, changing or leaving a team's membership; admin: an
// admin route; msg.wake: whether a delivery written by one signed-in user
// wakes a session of another (users by email: the writer recorded at write
// time and the receiving session's user, never an address's spelling, F-01);
// delegate.to: whether a user's session may name another user's launcher in
// `delegate`'s `to` (#256; users by email, the target's from the session
// that holds the address).
// alias.see: whether principal p may see that an alias of a scope exists (a
// filter for listings and name suggestions, #348).
export type AuthzRequest =
  | { verb: "msg.send" | "human.reach"; from: string; to: string }
  | { verb: "scope.act"; principal: Principal; scope: ActScope }
  | { verb: "alias.bind"; principal: Principal; scope: ActScope; name: string }
  | { verb: "act_as"; principal: Principal; address: string; name: string; scope: ActScope | null }
  | { verb: "session.act"; user: string; session: string; row: SessionFacts | undefined }
  | { verb: "hosted.session"; session: string; user: number; client: string; row: { user: number; client: string } }
  | { verb: "attachment.read"; identity: string; attachment: string; reach: AttachmentReach | undefined }
  | { verb: "team.read" | "team.manage" | "team.leave"; user: { id: number; email: string }; team: Team | undefined }
  | { verb: "admin"; email: string }
  | { verb: "msg.wake" | "delegate.to"; from_user: string; to_user: string }
  | { verb: "alias.see"; principal: Principal; scope: ActScope };

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

// Every storage read a rule makes, synchronously. `repo.policyNow` implements it (and AccessReadsSync) over the
// SQLite connection (#807 P3 A7e1): reads in the caller's own transaction see its writes, as routeReads gives them.
// `PolicyReads` is the same reads as promises, on one handle (A7e3).
export interface PolicyReadsSync extends Resolver {
  principalByName(name: string): PrincipalRow | undefined;
  teamByName(name: string): Team | undefined;
  isMember(teamId: number, userId: number): boolean;
  isOwner(teamId: number, userId: number): boolean;
  shareAny(userA: number, userB: number): boolean;
  shareCollaborative(userA: number, userB: number): boolean;
  shareDelegating(userA: number, userB: number): boolean;
  userByEmail(email: string): User | undefined;
}

// The alias reads serverAccess's resolveMention makes beside its policy decisions (B5b moves them).
export interface AccessReadsSync {
  alias(address: string): Alias | undefined;
  aliasesNamed(name: string): Alias[];
}

type ReadName = keyof PolicyReadsSync;
export type PolicyReads = { [K in ReadName]: (...args: Parameters<PolicyReadsSync[K]>) => Promise<ReturnType<PolicyReadsSync[K]>> };
type Op = { [K in ReadName]: { read: K; args: Parameters<PolicyReadsSync[K]> } }[ReadName];
// A rule: yields the reads it needs, one at a time, and returns its answer.
type Rule<T> = Generator<Op, T, unknown>;

function* ask<K extends ReadName>(read: K, ...args: Parameters<PolicyReadsSync[K]>): Generator<Op, ReturnType<PolicyReadsSync[K]>, unknown> {
  return (yield { read, args } as Op) as ReturnType<PolicyReadsSync[K]>;
}

// Runs a rule to its answer, each yielded read answered synchronously from `reads`. A read that throws propagates.
function drive<T>(g: Rule<T>, reads: PolicyReadsSync): T {
  for (let s = g.next(); ; ) {
    if (s.done) return s.value;
    const { read, args } = s.value;
    s = g.next((reads[read] as (...a: unknown[]) => unknown).apply(reads, args));
  }
}

// The same, each read awaited. The rule resumes only after its read settles, so the reads stay sequential.
async function driveAsync<T>(g: Rule<T>, reads: PolicyReads): Promise<T> {
  for (let s = g.next(); ; ) {
    if (s.done) return s.value;
    const { read, args } = s.value;
    s = g.next(await (reads[read] as (...a: unknown[]) => Promise<unknown>).apply(reads, args));
  }
}

// Policy's reads on one handle: `r` is the caller's body's `Tx` inside a transaction, so the rule sees its writes,
// else `repo.read`, committed state (#807 P3 A7e3).
function policyReads(repo: Repo, r: Read): PolicyReads {
  return {
    principalByName: (name) => repo.principals.findByName(r, name),
    principalOf: (address) => repo.principals.of(r, address),
    teamByName: (name) => repo.teams.findByName(r, name),
    isMember: (teamId, userId) => repo.teams.isMember(r, teamId, userId),
    isOwner: (teamId, userId) => repo.teams.isOwner(r, teamId, userId),
    shareAny: (userA, userB) => repo.teams.shareAny(r, userA, userB),
    shareCollaborative: (userA, userB) => repo.teams.shareCollaborative(r, userA, userB),
    shareDelegating: (userA, userB) => repo.teams.shareDelegating(r, userA, userB),
    userByEmail: (email) => repo.users.findByEmail(r, email),
  };
}

// The decision, its reads on the caller's handle `r` (#807 P3 A7e3): the form every caller reaches by A7f. No
// decision is recorded here, so nothing it returns depends on state an await could change underneath the caller.
export function authorize(repo: Repo, r: Read, ctx: PolicyContext, req: AuthzRequest): Promise<Decision> {
  return driveAsync(decide(ctx, req), policyReads(repo, r));
}

// The decision over the SQLite connection's reads, synchronously: the form for callers that can't await yet (#807
// P3 A7f converts them to `authorize`). The reads see the caller's own transaction when it holds one.
export function authorizeNow(repo: Repo, ctx: PolicyContext, req: AuthzRequest): Decision {
  return drive(decide(ctx, req), repo.policyNow);
}

// The verbs whose rules read no storage: their callers hand over every fact.
export type PureRequest = Extract<AuthzRequest, { verb: "session.act" | "hosted.session" | "attachment.read" | "admin" }>;

// The decision of a verb that reads nothing, with no store at all. A rule that asks for a read here is a bug: it throws.
export function decidePure(ctx: PolicyContext, req: PureRequest): Decision {
  const s = decide(ctx, req).next();
  if (!s.done) throw new Error(`policy: ${req.verb} asked for a storage read (${s.value.read})`);
  return s.value;
}

export function* decide(ctx: PolicyContext, req: AuthzRequest): Rule<Decision> {
  switch (req.verb) {
    case "msg.send":
    case "human.reach": {
      const rule = yield* humanRule(ctx.humanReach ?? "team", req.from, req.to);
      return rule.allow ? allow(rule.rule) : deny(rule.rule, `${req.to} is a person's phone, reachable only by their teammates' agents`);
    }
    case "scope.act":
      return yield* actIn(req.principal, req.scope);
    case "alias.bind":
      return req.name === HUMAN_NAME ? deny("alias.human_reserved", HUMAN_RESERVED) : yield* actIn(req.principal, req.scope);
    case "act_as":
      if (req.name === HUMAN_NAME) return deny("alias.human_reserved", HUMAN_RESERVED);
      if (!req.scope) return deny("scope.ownerless", `no principal owns the scope of "${req.address}"`);
      return yield* actIn(req.principal, req.scope);
    case "session.act":
      return sessionRule(req.user, req.session, req.row);
    case "hosted.session":
      // Another user's row and another client's of the same user read alike, as missing (#851).
      if (req.row.user !== req.user) return deny("hosted.other_user", "session not found", "not_found");
      if (req.row.client !== req.client) return deny("hosted.other_client", "session not found", "not_found");
      return allow("hosted.own");
    case "attachment.read": {
      // Anything unreadable reads as missing, not forbidden (docs/attachments.md).
      const missing = `no attachment ${req.attachment} on a message or post you can read`;
      if (!req.reach) return deny("attachment.unknown", missing, "not_found");
      const rule = { post: "attachment.board_visible", message: "attachment.dm_party", unbound: "attachment.uploader" }[req.reach.carrier];
      return req.reach.readable ? allow(rule) : deny(rule, missing, "not_found");
    }
    case "team.leave":
      return req.team && (yield* ask("isMember", req.team.id, req.user.id)) ? allow("team.member") : deny("team.member", "not found", "not_found");
    case "team.read": {
      const { team, user } = req;
      if (team && (yield* ask("isMember", team.id, user.id))) return allow("team.member");
      if (team && isAdmin(ctx, user.email)) return allow("admin.env");
      return deny("team.member", "not found", "not_found");
    }
    case "team.manage": {
      const { team, user } = req;
      const member = !!team && (yield* ask("isMember", team.id, user.id));
      if (!team || (!member && !isAdmin(ctx, user.email))) return deny("team.member", "not found", "not_found");
      if (member && (yield* ask("isOwner", team.id, user.id))) return allow("team.owner");
      if (isAdmin(ctx, user.email)) return allow("admin.env");
      return deny("team.owner", `only an owner of team "${team.name}" (or an admin) can add or remove members; \`grayboard team members ${team.name}\` lists its owners`);
    }
    case "msg.wake":
      return yield* wakeRule(req.from_user, req.to_user);
    case "delegate.to":
      return yield* delegateRule(req.from_user, req.to_user);
    case "alias.see":
      // The directory of people's names is open in the org (vision.md
      // principle 9); a team's names are its members' (and the team's own),
      // as its boards and roster are: to anyone else the team reads as
      // missing (#348). No admin exemption: admin is a server role, not a
      // directory grant (as for msg.wake).
      if (req.scope.scope_kind === "person") return allow("alias.see_person");
      if (req.principal.kind === "team" && req.scope.scope_kind === "team" && req.principal.name === req.scope.scope_ref) return allow("alias.see_own_team");
      return yield* actIn(req.principal, req.scope);
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
    case "attachment.read":
      return { target: `attachment:${req.attachment}`, detail: { identity: req.identity } };
    case "team.read":
    case "team.manage":
    case "team.leave":
      return { target: req.team ? `team:${req.team.name}` : null, detail: { team: req.team?.name ?? null } };
    case "admin":
      return { target: null, detail: {} };
    case "msg.wake":
    case "delegate.to":
      return { target: req.to_user, detail: { from_user: req.from_user, to_user: req.to_user } };
    case "alias.see":
      return { target: `${req.scope.scope_kind}:${req.scope.scope_ref}`, detail: { principal: req.principal.name, scope_kind: req.scope.scope_kind, scope_ref: req.scope.scope_ref } };
  }
}

// Deny rows per user (security audit F-19): an authenticated client looping
// on a refused act, over HTTP routes no request limiter covers, would
// otherwise write a 90-day row per request. Past the burst a user's denies go
// unrecorded until the bucket refills; the streak's end writes one
// `authz.suppressed` row with the count. Allows aren't thinned: only owners
// and admins reach them. One limiter per Repo (per server). The streak's end fires
// inside recordDecision's sweep or take, so its row goes on the handle that call was
// given (`suppressedOn`): the caller's body `Tx`, or a post outside any body.
export const DENY_ROW_LIMIT: RateLimit = { burst: 30, perSec: 0.5 };
const denyLimiters = new WeakMap<Repo, RateLimiter>();
let suppressedOn: Read | undefined;
function denyLimiter(repo: Repo): RateLimiter {
  let l = denyLimiters.get(repo);
  if (!l) {
    l = new RateLimiter(DENY_ROW_LIMIT, { start() {}, end: (user, refused) => writeAudit(repo, suppressedOn ?? repo.read, "authz.suppressed", user, null, { refused }) }, Date.now, 4096);
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
export function recordDecision(repo: Repo, h: Read, actor: Actor, req: AuthzRequest, d: Decision, extra: Record<string, unknown> = {}): void {
  if (!d.allow) {
    const limiter = denyLimiter(repo);
    suppressedOn = h;
    let ok: boolean;
    try { limiter.sweep(); ok = limiter.take(actor.user ?? "").ok; } finally { suppressedOn = undefined; }
    if (!ok) return;
  }
  const { target, detail } = subject(req);
  writeAudit(repo, h, "authz.decision", actor.user, typeof target === "string" ? (clip(target) as string) : target, {
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
function* actIn(p: Principal, scope: ActScope): Rule<Decision> {
  const ref = scope.scope_ref;
  if (scope.scope_kind === "service" || p.kind === "service") return deny("scope.service", "service principals arrive with #270");
  if (p.kind !== "user") return deny("scope.user_only", `${p.name} is a ${p.kind}, not a user`);
  if (scope.scope_kind === "person") return ref === p.name ? allow("scope.own_person") : deny("scope.own_person", `${ref}'s scope isn't ${p.name}'s`);
  const userId = (yield* ask("principalByName", p.name))?.user_id;
  const team = yield* ask("teamByName", ref);
  return userId != null && team && (yield* ask("isMember", team.id, userId))
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
// shared 'collaborative' or 'delegating' team do (delegating implies it, #256). No admin exemption: admin is a server role,
// not a messaging grant. One indexed lookup per decision (principle 11).
function* wakeRule(fromUser: string, toUser: string): Rule<Decision> {
  if (fromUser === toUser) return allow("wake.same_user");
  const a = yield* ask("userByEmail", fromUser), b = yield* ask("userByEmail", toUser);
  if (a && b && (yield* ask("shareCollaborative", a.id, b.id))) return allow("wake.team_policy");
  return deny("wake.cross_user", `${fromUser} shares no collaborative team with ${toUser}; delivered as mail that doesn't wake their agent`);
}

// Whether a user's session may hand a task to another user's launcher by
// name (#256). A user's own launchers take it; across users, only members of
// a shared 'delegating' team. The grant is the team's, set by its owner; an
// owner-approved grant per launcher is #874. No admin exemption, as for wakes.
function* delegateRule(fromUser: string, toUser: string): Rule<Decision> {
  if (fromUser === toUser) return allow("delegate.same_user");
  const a = yield* ask("userByEmail", fromUser), b = yield* ask("userByEmail", toUser);
  if (a && b && (yield* ask("shareDelegating", a.id, b.id))) return allow("delegate.team_policy");
  return deny("delegate.cross_user", `${fromUser} shares no team whose policy is delegating with ${toUser}`);
}

// Whether the address `from` may wake `to` when `to` is a human
// (`<email>/human`), and the rule that decided. A person reaches their own
// human, and a teammate's (reach "team"); a team alias reaches a member's
// (#284 S12), the analogue of sharing a team. Board mentions and thread
// replies go through this too (access.ts), so a post can't reach a phone a
// DM can't.
function* humanRule(reach: HumanReach, from: string, to: string): Rule<{ allow: boolean; rule: string }> {
  const t = addressParts(to);
  if (t?.kind !== "alias" || t.name !== HUMAN_NAME) return { allow: true, rule: "human.not_human" };
  if (reach === "all") return { allow: true, rule: "human.reach_all" };
  const f = yield* ask("principalOf", from);
  const them = t.scopeKind === "person" ? yield* ask("userByEmail", t.scope) : undefined;
  if (!f || !them) return { allow: false, rule: "human.teammates" };
  if (f.kind === "team") {
    const team = yield* ask("teamByName", f.name);
    return { allow: !!team && (yield* ask("isMember", team.id, them.id)), rule: "human.team_alias" };
  }
  if (f.kind !== "user") return { allow: false, rule: "human.teammates" };
  if (f.name === them.email) return { allow: true, rule: "human.self" };
  const me = yield* ask("userByEmail", f.name);
  if (!me) return { allow: false, rule: "human.teammates" };
  // One statement, not each side's team list: two reads across an await could pair states that never coexisted.
  return { allow: yield* ask("shareAny", me.id, them.id), rule: "human.teammates" };
}

// The pre-seam entry points, as authorizeNow() answers them, for the unit tests
// that exercise each rule directly (can_send.test.ts, access.test.ts). Nothing
// outside this module and tests calls them.
export type SendContext = { db: Repo; now: number; humanReach: HumanReach };
export type SendTarget = { kind: "user"; address: string };
export type SendDecision = { allow: true } | { allow: false; code: "forbidden" | "not_found"; reason: string };

const plain = (d: Decision): SendDecision => (d.allow ? { allow: true } : { allow: false, code: d.code, reason: d.reason });

export function canSend(from: string, target: SendTarget, ctx: SendContext): SendDecision {
  return plain(authorizeNow(ctx.db, { humanReach: ctx.humanReach }, { verb: "msg.send", from, to: target.address }));
}

export function reachesHuman(repo: Repo, reach: HumanReach, from: string, to: string): boolean {
  return authorizeNow(repo, { humanReach: reach }, { verb: "human.reach", from, to }).allow;
}

export function canAdmin(email: string, admins: readonly string[]): SendDecision {
  return plain(decidePure({ admins }, { verb: "admin", email }));
}

export function mayActIn(repo: Repo, p: Principal, scope: ActScope): string | null {
  const d = authorizeNow(repo, {}, { verb: "scope.act", principal: p, scope });
  return d.allow ? null : d.reason;
}
