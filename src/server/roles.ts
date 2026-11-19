// Granting and revoking a role binding (#927), for every writer: the admin role routes, `team add --role` and team
// creation (http.ts). The store's grant and revoke are one statement each, which re-checks the granter's authority and
// the binding's preconditions and writes the audit row (db.ts roles); when one writes nothing, the reads here say why.
import type { Repo } from "./db.ts";
import { ROLES, type Decision, type Role } from "./policy.ts";
import { LastOwner } from "./store/errors.ts";
import type { AuditFields, RoleAuthority, RoleBinding, RoleGrant } from "./store/identity.ts";
import type { Tx } from "./store/tx_base.ts";

export type RoleSpec = { holder: string; role: Role; scope: string | null };
// Who grants or revokes: their user, and the authority their write re-checks.
export type Granter = { email: string; userId: number; authority: RoleAuthority };
export type Refusal = { status: number; code: string; message: string };
export type RoleOutcome = { binding: RoleBinding; changed: boolean } | { refused: Refusal };
// The store groups a grant or revoke reads and writes: a Repo's, or another backend's without one (#807 P3 C3a).
export type RoleStores = Pick<Repo, "roles" | "principals" | "teams">;

const refuse = (status: number, code: string, message: string): RoleOutcome => ({ refused: { status, code, message } });

// The authority a decision's allow carries into the write that follows it: a bootstrap admin's needs no check
// (the env list doesn't change at runtime), a binding's must still exist when the write runs.
export function authorityOf(d: Decision): RoleAuthority {
  if (d.rule === "role.org_admin") return "org_admin";
  if (d.rule === "role.team_owner") return "owner_or_admin";
  return "none";
}

// A request body's role, holder and scope, checked against the role table: the spec, or why not. Names are lowercased,
// as every principal's is stored.
export function roleSpec(body: { principal?: unknown; role?: unknown; scope?: unknown } | null): RoleSpec | Refusal {
  const role = body?.role;
  if (typeof role !== "string" || !Object.hasOwn(ROLES, role)) return { status: 400, code: "bad_request", message: `role must be one of ${Object.keys(ROLES).join(", ")}` };
  if (typeof body?.principal !== "string" || !body.principal) return { status: 400, code: "bad_request", message: "principal required: a user's email, or a team's or service's name" };
  const scopeKind = ROLES[role as Role].scope;
  const scope = body.scope === undefined || body.scope === null ? null : body.scope;
  if (scope !== null && (typeof scope !== "string" || !scope)) return { status: 400, code: "bad_request", message: "scope must be a name" };
  if (scopeKind === null && scope !== null) return { status: 400, code: "bad_request", message: `${role} is held on the whole server; it takes no scope` };
  if (scopeKind !== null && scope === null) return { status: 400, code: "bad_request", message: `${role} is held on a ${scopeKind}: name it with scope` };
  return { holder: body.principal.toLowerCase(), role: role as Role, scope: scope === null ? null : (scope as string).toLowerCase() };
}

// Whether the granter's authority still holds, read on the write's own transaction: the follow-up to a write that
// changed nothing.
async function authorityHolds(repo: RoleStores, tx: Tx, g: Granter, spec: RoleSpec): Promise<boolean> {
  if (g.authority === "none") return true;
  if ((await repo.roles.bindingOf(tx, g.userId, "org_admin", null)) !== undefined) return true;
  if (g.authority !== "owner_or_admin" || spec.scope === null) return false;
  const team = await repo.teams.findByName(tx, spec.scope);
  return !!team && (await repo.roles.bindingOf(tx, g.userId, "team_owner", team.id)) !== undefined;
}

// The names' principals, or the 404 for the first missing one; a scope must be of the role's kind.
async function resolve(repo: RoleStores, tx: Tx, spec: RoleSpec): Promise<Refusal | null> {
  const kind = ROLES[spec.role].scope;
  if (!(await repo.principals.findByName(tx, spec.holder))) {
    return { status: 404, code: "not_found", message: `no principal named "${spec.holder}"; a user must sign in to grayboard once first` };
  }
  if (kind !== null && (await repo.principals.findByName(tx, spec.scope!))?.kind !== kind) {
    return { status: 404, code: "not_found", message: `no ${kind} named "${spec.scope}"` };
  }
  return null;
}

// Grants the role: the new binding, or the one already held (changed false: no second role.granted row, as teamAdd
// answers an existing member), or the refusal.
export async function grantRole(repo: RoleStores, tx: Tx, spec: RoleSpec, g: Granter, audit: AuditFields = {}): Promise<RoleOutcome> {
  const role = ROLES[spec.role];
  const grant: RoleGrant = {
    holder: spec.holder, role: spec.role, scope: spec.scope, holderKinds: role.holders, scopeKind: role.scope,
    member: spec.role === "team_owner", by: g.email, byUser: g.userId, authority: g.authority, actor: g.email, audit,
  };
  const b = await repo.roles.grant(tx, grant);
  if (b) return { binding: b, changed: true };
  const missing = await resolve(repo, tx, spec);
  if (missing) return { refused: missing };
  const holder = (await repo.principals.findByName(tx, spec.holder))!;
  if (!role.holders.includes(holder.kind)) {
    return refuse(400, "bad_request", role.holders.length ? `${spec.role} is held by a ${role.holders.join(" or a ")}, and "${spec.holder}" is a ${holder.kind}` : `no principal may hold ${spec.role} yet: its holders arrive with #270's invocation step`);
  }
  if (!(await authorityHolds(repo, tx, g, spec))) return refuse(403, "forbidden", `${g.email} no longer holds the role that allowed this grant`);
  const held = await repo.roles.find(tx, spec.holder, spec.role, spec.scope);
  if (held) return { binding: held, changed: false };
  // Every read above found the grant's preconditions met. On Postgres (READ COMMITTED) each read is a newer snapshot
  // than the grant's statement, so a precondition that committed in between (the holder's sign-in, the scope's
  // creation; not a membership, whose write waits on the grant's role lock) passes here though the statement missed it
  // (#807 P3 C3 R6). One more attempt, a new
  // statement, sees it; SQLite's single writer makes it a no-op repeat.
  const again = await repo.roles.grant(tx, grant);
  if (again) return { binding: again, changed: true };
  if (spec.role === "team_owner") {
    return refuse(409, "conflict", `${spec.holder} isn't a member of team "${spec.scope}"; an owner is a member: add them first with grayboard team add ${spec.scope} ${spec.holder}`);
  }
  throw new Error(`grant of ${spec.role} to ${spec.holder} wrote nothing, for no reason a read finds`);
}

// Revokes the role: the deleted binding, or the refusal (404 when it isn't held, 409 for the last owner of a team
// with members). `bootstrap`: whether the holder is a GRAYBOARD_ADMINS email, whose org_admin no revoke removes.
export async function revokeRole(repo: RoleStores, tx: Tx, spec: RoleSpec, g: Granter, bootstrap: boolean, audit: AuditFields = {}): Promise<RoleOutcome> {
  let b: RoleBinding | null;
  try {
    b = await repo.roles.revoke(tx, { holder: spec.holder, role: spec.role, scope: spec.scope, byUser: g.userId, authority: g.authority, actor: g.email, audit });
  } catch (e) {
    if (e instanceof LastOwner) return refuse(409, "conflict", e.message);
    throw e;
  }
  if (b) return { binding: b, changed: true };
  if (!(await authorityHolds(repo, tx, g, spec))) return refuse(403, "forbidden", `${g.email} no longer holds the role that allowed this revoke`);
  if (bootstrap && spec.role === "org_admin") {
    return refuse(409, "conflict", `${spec.holder} is an admin by the server's GRAYBOARD_ADMINS, not by a binding; remove the email there and restart the server`);
  }
  const missing = await resolve(repo, tx, spec);
  if (missing) return { refused: missing };
  return refuse(404, "not_found", `${spec.holder} holds no ${spec.role}${spec.scope === null ? "" : ` on ${spec.scope}`}`);
}
