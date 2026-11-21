// The server's authorization seam (#806). Every allow-or-deny decision the
// server makes about who may do what is `decide()`'s, writing nothing. Its rules
// are generators that yield each storage read they need (#807 P3 A7e): one set of
// rule bodies, driven by `authorize` over the store's reads on the caller's
// handle, or with no reads at all by `decidePure`.
// The caller that owns a requested act records its decision with
// `recordDecision` (an `authz.decision` row: every deny, and the allows of
// team management and admin routes); filter checks (board visibility, mention
// fan-out, a thread reply's reach, the alias sweep) write no rows. The rule
// helpers below are this module's own: nothing else calls them (policy.test.ts).
// One rule's body lives in core, shared with local mode: attachment.read names
// the rule from core's attachmentReach facts (who may read is canReadAttachment's).
import { isTx, type Read } from "./store/tx.ts";
import { addressParts, type ScopeKind } from "../core/addresses.ts";
import type { AttachmentReach } from "../core/attachments.ts";
import type { Principal } from "../core/resolver.ts";
import { HUMAN_NAME, HUMAN_RESERVED } from "../shared/addressing.ts";
import { writeAudit } from "./audit.ts";
import type { InvokeBinding, PrincipalRow, Repo, Team, User } from "./db.ts";
import { RateLimiter, type RateLimit } from "./rate_limit.ts";

// Who besides you can reach your human (your phone, through the Slack
// bridge): people who share a team with you, or everyone signed in.
export type HumanReach = "team" | "all";

export type PolicyContext = { humanReach?: HumanReach; admins?: readonly string[] };

export type ActScope = { scope_kind: ScopeKind; scope_ref: string };

// The verb fixes the resource. msg.send: a requested DM;
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
// admin route, by the signed-in user (id and email: a role rule finds its principal); msg.wake: whether a delivery written by one signed-in user
// wakes a session of another (users by email: the writer recorded at write
// time and the receiving session's user, never an address's spelling, F-01);
// delegate.to: whether a user's session may name another user's launcher in
// `delegate`'s `to` (#256; users by email, the target's from the session
// that holds the address). A msg.wake about a board post carries `post`: the
// post's board and scope and each side's acting principal (the post's author
// address's, and the reading address's), which wake.service_invoke judges (#270 D6).
// alias.see: whether principal p may see that an alias of a scope exists (a
// filter for listings and name suggestions, #348).
// service.invoke: whether principal p (the acting address's: a team-scoped
// name's is the team) may post on service `service`'s board `board` (#270 D6):
// requested by a post, a filter for the board's visibility.
export type AuthzRequest =
  | { verb: "msg.send" | "human.reach"; from: string; to: string }
  | { verb: "scope.act"; principal: Principal; scope: ActScope }
  | { verb: "alias.bind"; principal: Principal; scope: ActScope; name: string }
  | { verb: "act_as"; principal: Principal; address: string; name: string; scope: ActScope | null }
  | { verb: "session.act"; user: string; session: string; row: SessionFacts | undefined }
  | { verb: "hosted.session"; session: string; user: number; client: string; row: { user: number; client: string } }
  | { verb: "attachment.read"; identity: string; attachment: string; reach: AttachmentReach | undefined }
  | { verb: "team.read" | "team.manage" | "team.leave"; user: SignedIn; team: Team | undefined }
  | { verb: "admin"; user: SignedIn }
  | { verb: "msg.wake"; from_user: string; to_user: string; post?: WakePost }
  | { verb: "delegate.to"; from_user: string; to_user: string }
  | { verb: "alias.see"; principal: Principal; scope: ActScope }
  | { verb: "service.invoke"; principal: Principal | null; service: string; board: string };

// A board post's facts for msg.wake (#270 D6): its board and the board's scope, and the acting principal of each
// side, the writer's (its author address's) and the reader's (null: the address names none).
export type WakePost = { board: string; scope: string | null; from: Principal | null; to: Principal | null };

// The service a board belongs to (#270 D5: scope `service:<name>`), or null.
export const serviceOfScope = (scope: string | null): string | null => (scope?.startsWith("service:") ? scope.slice(8) : null);

// The signed-in principal of a user-keyed verb: its users row's id and name, and its kind (#270 D1: a service is a
// users row too, and holds no admin or team authority).
export type SignedIn = { id: number; email: string; kind: "user" | "service" };

// What session.act judges of an ID's row: whose it is, and whether it's a
// viewer's or has ended.
export type SessionFacts = { principal: string | null; viewer: boolean; ended_at: number | null };

// A role-based decision (#927) names its rule from a closed set (`role.org_admin`, `role.team_owner`) and carries
// the role and scope (a team's name, null for the org) it looked for; an allow also carries the binding that allowed
// it. The id rides beside the rule, never in it: callers compare rule strings, and rows group by them.
// `team`: the team whose binding carried a member's right (#270 D6), so the row ties the act to the membership.
export type RoleFacts = { binding?: number; role?: Role; scope?: string | null; team?: string };
export type Decision =
  | ({ allow: true; rule: string } & RoleFacts)
  | ({ allow: false; code: "forbidden" | "not_found"; reason: string; rule: string } & Omit<RoleFacts, "binding">);

// The roles (#927): each fixes its scope's kind (null: the org) and the principal kinds that may hold it.
// A row whose role isn't here grants nothing: every lookup names its role. service_owner (#270 D1) is a service's
// accountability record and carries no power yet: no rule reads it. service_invoke (#270 D6) is the right to post on
// a service's board and be woken by its replies; a team's binding counts for its members, so a whole team is
// grantable (a service is never a team member, so it holds only directly).
export type Role = "org_admin" | "team_owner" | "service_owner" | "service_invoke";
export const ROLES: Readonly<Record<Role, { scope: "team" | "service" | null; holders: readonly Principal["kind"][] }>> = {
  org_admin: { scope: null, holders: ["user"] },
  team_owner: { scope: "team", holders: ["user"] },
  service_owner: { scope: "service", holders: ["user"] },
  service_invoke: { scope: "service", holders: ["user", "service", "team"] },
};
export const isRole = (r: unknown): r is Role => typeof r === "string" && Object.hasOwn(ROLES, r);

// Whether a decision exercised admin authority, by the env list or a binding: `as_admin` on the act's audit rows.
export const byAdmin = (d: Decision): boolean => d.allow && (d.rule === "admin.env" || d.rule === "role.org_admin");

// Who asked: the signed-in user (null for none), and, when the act came
// through a session, the address it acted as and the session's ID. The Slack
// bridge's human connections have no session ID. (The OAuth client joins
// these rows with #847.)
export type Actor = { user: string | null; address?: string; session?: string };

const allow = (rule: string, facts: RoleFacts = {}): Decision => ({ allow: true, rule, ...facts });
const deny = (rule: string, reason: string, code: "forbidden" | "not_found" = "forbidden", facts: Omit<RoleFacts, "binding"> = {}): Decision => ({ allow: false, code, reason, rule, ...facts });

// Every storage read a rule makes, on one handle (#807 P3 A7e3): `policyReads` gives them over a Repo's groups.
export interface PolicyReads {
  principalOf(address: string): Promise<Principal | null>;
  principalByName(name: string): Promise<PrincipalRow | undefined>;
  teamByName(name: string): Promise<Team | undefined>;
  isMember(teamId: number, userId: number): Promise<boolean>;
  // A user's binding id for a role on the org (teamId null) or a team, if held (#927).
  roleBinding(userId: number, role: Role, teamId: number | null): Promise<number | undefined>;
  // A principal's service_invoke binding on a service, its own or a team's it's a member of (#270 D6).
  invokeBinding(holder: Principal, service: string): Promise<InvokeBinding | undefined>;
  shareAny(userA: number, userB: number): Promise<boolean>;
  shareCollaborative(userA: number, userB: number): Promise<boolean>;
  shareDelegating(userA: number, userB: number): Promise<boolean>;
  userByEmail(email: string): Promise<User | undefined>;
}

type ReadName = keyof PolicyReads;
type Op = { [K in ReadName]: { read: K; args: Parameters<PolicyReads[K]> } }[ReadName];
// A rule: yields the reads it needs, one at a time, and returns its answer.
export type Rule<T> = Generator<Op, T, unknown>;

function* ask<K extends ReadName>(read: K, ...args: Parameters<PolicyReads[K]>): Generator<Op, Awaited<ReturnType<PolicyReads[K]>>, unknown> {
  return (yield { read, args } as Op) as Awaited<ReturnType<PolicyReads[K]>>;
}

// Runs a rule to its answer, each read awaited. The rule resumes only after its read settles, so the reads stay sequential.
async function driveAsync<T>(g: Rule<T>, reads: PolicyReads): Promise<T> {
  for (let s = g.next(); ; ) {
    if (s.done) return s.value;
    const { read, args } = s.value;
    s = g.next(await (reads[read] as (...a: unknown[]) => Promise<unknown>).apply(reads, args));
  }
}

// The store groups the decision reads: a Repo's, or another backend's without one (#807 P3 C3a).
export type PolicyStores = Pick<Repo, "principals" | "teams" | "roles"> & { users: Pick<Repo["users"], "findByEmail"> };

// Policy's reads on one handle: `r` is the caller's body's `Tx` inside a transaction, so the rule sees its writes,
// else `repo.read`, committed state (#807 P3 A7e3).
export function policyReads(repo: PolicyStores, r: Read): PolicyReads {
  return {
    principalByName: (name) => repo.principals.findByName(r, name),
    principalOf: (address) => repo.principals.of(r, address),
    teamByName: (name) => repo.teams.findByName(r, name),
    isMember: (teamId, userId) => repo.teams.isMember(r, teamId, userId),
    roleBinding: (userId, role, teamId) => repo.roles.bindingOf(r, userId, role, teamId),
    invokeBinding: (holder, service) => repo.roles.invokeBinding(r, holder, service),
    shareAny: (userA, userB) => repo.teams.shareAny(r, userA, userB),
    shareCollaborative: (userA, userB) => repo.teams.shareCollaborative(r, userA, userB),
    shareDelegating: (userA, userB) => repo.teams.shareDelegating(r, userA, userB),
    userByEmail: (email) => repo.users.findByEmail(r, email),
  };
}

// The decision, its reads on the caller's handle `r` (#807 P3 A7e3): the form every caller reaches by A7f. No
// decision is recorded here, so nothing it returns depends on state an await could change underneath the caller.
export function authorize(repo: PolicyStores, r: Read, ctx: PolicyContext, req: AuthzRequest): Promise<Decision> {
  return driveAsync(decide(ctx, req), policyReads(repo, r));
}

// The verbs whose rules read no storage: their callers hand over every fact.
export type PureRequest = Extract<AuthzRequest, { verb: "session.act" | "hosted.session" | "attachment.read" }>;

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
      const admin = team ? yield* orgAdmin(ctx, user) : null;
      return admin ?? deny("team.member", "not found", "not_found");
    }
    case "team.manage": {
      // An owner is a member (#927): a non-member's binding, if one were left, manages nothing.
      const { team, user } = req;
      if (!team) return deny("team.member", "not found", "not_found");
      const member = yield* ask("isMember", team.id, user.id);
      const owner = member ? yield* ask("roleBinding", user.id, "team_owner", team.id) : undefined;
      if (owner !== undefined) return allow("role.team_owner", { binding: owner, role: "team_owner", scope: team.name });
      const admin = yield* orgAdmin(ctx, user);
      if (admin) return admin;
      if (!member) return deny("team.member", "not found", "not_found");
      return deny("role.team_owner", `only an owner of team "${team.name}" (or an admin) can add or remove members; \`grayboard team members ${team.name}\` lists its owners`, "forbidden", { role: "team_owner", scope: team.name });
    }
    case "msg.wake":
      return yield* wakeRule(req.from_user, req.to_user, req.post);
    case "service.invoke":
      return yield* invokeRule(req.principal, req.service);
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
      // A service's names are the service's and its invokers' (#270 D4), as a team's are its members'.
      if (req.scope.scope_kind === "service" && !(req.principal.kind === "service" && req.principal.name === req.scope.scope_ref)) {
        const g = yield* invokeGrant(req.principal, req.scope.scope_ref);
        return g ? allow("alias.see_service", g) : deny("alias.see_service", `no service ${req.scope.scope_ref} that ${req.principal.name} may see`, "not_found", { role: "service_invoke", scope: req.scope.scope_ref });
      }
      return yield* actIn(req.principal, req.scope);
    case "admin":
      return (yield* orgAdmin(ctx, req.user)) ?? deny("role.org_admin", `${req.user.email} is not an org admin`, "forbidden", { role: "org_admin", scope: null });
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
      return { target: req.to_user, detail: { from_user: req.from_user, to_user: req.to_user, ...(req.post ? { board: req.post.board } : {}) } };
    case "delegate.to":
      return { target: req.to_user, detail: { from_user: req.from_user, to_user: req.to_user } };
    case "service.invoke":
      return { target: `service:${req.service}`, detail: { principal: req.principal?.name ?? null, principal_kind: req.principal?.kind ?? null, board: req.board } };
    case "alias.see":
      return { target: `${req.scope.scope_kind}:${req.scope.scope_ref}`, detail: { principal: req.principal.name, scope_kind: req.scope.scope_kind, scope_ref: req.scope.scope_ref } };
  }
}

// Deny rows per user (security audit F-19): an authenticated client looping
// on a refused act, over HTTP routes no request limiter covers, would
// otherwise write a 90-day row per request. Past the burst a user's denies go
// unrecorded until the bucket refills; the streak's end writes one
// `authz.suppressed` row with the count. Allows aren't thinned: only owners
// and admins reach them. One limiter per Repo (per server). Inside a body only the
// caller's own key is taken: its streak's end fires in that take and its row goes on
// the body's `Tx` (`suppressedOn`), beside the decision row. Every other user's
// refilled bucket is swept once the body commits (its afterCommit), each row posted:
// a body that fails to commit sweeps nothing, so their buckets, and the counts the rows
// will carry, wait for the next sweep (#1436). Outside a body the sweep runs now.
// Buckets age on the store's clock (#1082), the one a test injects, like every row's stamp (#1390).
export const DENY_ROW_LIMIT: RateLimit = { burst: 30, perSec: 0.5 };
const denyLimiters = new WeakMap<Repo, RateLimiter>();
let suppressedOn: Read | undefined;
function denyLimiter(repo: Repo): RateLimiter {
  let l = denyLimiters.get(repo);
  if (!l) {
    l = new RateLimiter(DENY_ROW_LIMIT, { start() {}, end: (user, refused) => writeAudit(repo, suppressedOn ?? repo.read, "authz.suppressed", user, null, { refused }) }, () => repo.now(), 4096);
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
    let ok: boolean;
    if (isTx(h)) {
      suppressedOn = h;
      try { ok = limiter.take(actor.user ?? "").ok; } finally { suppressedOn = undefined; }
      h.afterCommit(() => limiter.sweep());
    } else {
      limiter.sweep();
      ok = limiter.take(actor.user ?? "").ok;
    }
    if (!ok) return;
  }
  const { target, detail } = subject(req);
  writeAudit(repo, h, "authz.decision", actor.user, typeof target === "string" ? (clip(target) as string) : target, {
    verb: req.verb,
    allow: d.allow,
    rule: d.rule,
    ...(d.allow ? {} : { code: d.code, reason: d.reason }),
    // The binding that allowed, or the role and scope a deny looked for (#927).
    ...(d.allow && d.binding !== undefined ? { binding: d.binding } : {}),
    ...(d.role !== undefined ? { role: d.role, scope: d.scope ?? null } : {}),
    ...(d.allow && d.team !== undefined ? { team: d.team } : {}),
    ...Object.fromEntries(Object.entries({ ...detail, ...extra }).map(([k, v]) => [k, clip(v)])),
    user: actor.user,
    address: actor.address ?? null,
    session: actor.session ?? null,
  });
}

function isAdmin(ctx: PolicyContext, email: string): boolean {
  return (ctx.admins ?? []).includes(email.toLowerCase());
}

// The org admin's allow, or null (#927): a GRAYBOARD_ADMINS email first, reading nothing, so a bootstrap admin
// keeps its powers whatever the table holds; else the user's org_admin binding, one indexed lookup, never cached.
// A service is never an admin (#270 D1), even one whose name was put in GRAYBOARD_ADMINS: checked first.
function* orgAdmin(ctx: PolicyContext, user: SignedIn): Rule<Decision | null> {
  if (user.kind !== "user") return null;
  if (isAdmin(ctx, user.email)) return allow("admin.env");
  const b = yield* ask("roleBinding", user.id, "org_admin", null);
  return b === undefined ? null : allow("role.org_admin", { binding: b, role: "org_admin", scope: null });
}

// Whether principal p may act in a scope: bind an alias there, or write as
// one (#284 S9). Keyed by principal, not by email: a user acts in its own
// person scope and in the teams it belongs to; a service acts in its own
// service scope and nowhere else, and no user acts in a service's scope, its
// owners included (#270 D1, principle 9): the names' mail is the service's.
function* actIn(p: Principal, scope: ActScope): Rule<Decision> {
  const ref = scope.scope_ref;
  if (p.kind === "service") {
    return scope.scope_kind === "service" && ref === p.name ? allow("scope.own_service") : deny("scope.own_service", `${p.name} is a service; it acts only in its own scope`);
  }
  // Read as a missing scope by callers, as a team's is to a non-member: a refusal doesn't say a service exists.
  if (scope.scope_kind === "service") return deny("scope.service", `no user acts in service ${ref}'s scope`);
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
// A post on a service's board (#270 D6, principles 9 and 10) also wakes across accounts when one side is that service
// and the other side's acting principal holds service_invoke on it, in both directions: an invoker's request wakes a
// lane, the lane's reply wakes the invoker. Re-decided at each pull or read, so a revoked binding or a removed
// membership turns what's queued to ungranted data. Board posts only: a DM between them stays mail (open question 7).
function* wakeRule(fromUser: string, toUser: string, post?: WakePost): Rule<Decision> {
  if (fromUser === toUser) return allow("wake.same_user");
  const service = post ? serviceOfScope(post.scope) : null;
  if (post && service !== null) {
    const isService = (p: Principal | null) => p?.kind === "service" && p.name === service;
    const other = isService(post.from) ? post.to : isService(post.to) ? post.from : null;
    const g = other ? yield* invokeGrant(other, service) : undefined;
    if (g) return allow("wake.service_invoke", g);
  }
  const a = yield* ask("userByEmail", fromUser), b = yield* ask("userByEmail", toUser);
  if (a && b && (yield* ask("shareCollaborative", a.id, b.id))) return allow("wake.team_policy");
  return deny("wake.cross_user", `${fromUser} shares no collaborative team with ${toUser}; delivered as mail that doesn't wake their agent`);
}

// The service_invoke binding that carries principal p's right on a service (#270 D6), as a decision's role facts: its
// own binding, else for a user a team's it's a member of (the team named). One statement, read live, never cached
// (principles 11, 13).
function* invokeGrant(p: Principal, service: string): Rule<RoleFacts | undefined> {
  const b = yield* ask("invokeBinding", p, service);
  return b ? { binding: b.id, role: "service_invoke", scope: service, ...(b.team !== null ? { team: b.team } : {}) } : undefined;
}

// Whether principal p may post on service `service`'s board (#270 D6): the service itself (`service.own`), or a holder
// of service_invoke on it. A deny reads as a missing board (not_found), the hidden board's refusal, so it never says
// the service or its board exists. No admin exemption: admin is a server role, not a grant to a service's work.
function* invokeRule(p: Principal | null, service: string): Rule<Decision> {
  if (p?.kind === "service" && p.name === service) return allow("service.own");
  const g = p ? yield* invokeGrant(p, service) : undefined;
  return g ? allow("role.service_invoke", g) : deny("role.service_invoke", "no such board", "not_found", { role: "service_invoke", scope: service });
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

