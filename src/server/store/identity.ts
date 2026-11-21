// The identity store's row types and group interfaces (#807 P3 C3a, docs/future/postgres-server.md D2): users,
// sessions, principals, teams, roles and services, which Repo (db.ts) composes and the Postgres store (pg/) implements.
// It imports nothing at runtime, so a module under pg/ may import it (pg/isolation.test.ts); db.ts re-exports every
// name. Its two consts are the only runtime values.
import type { Principal } from "../../core/resolver.ts";
import type { Read, Tx } from "./tx_base.ts";

// Row types
// idp_issuer + idp_subject: the IdP that proved the user's email and its stable
// account ID there (Google `sub`), keyed together (security audit F-13, #928
// D3). Both: linked. Issuer only: a pre-F-13 row, reserved for that IdP.
// Neither: a dev-auth user, or one an admin unlinked.
// A user row (#270 D1): a person, or a service whose `email` holds its name (never an email: it has no "@"). The kind
// is its principal row's, read with the row (USER_SQL): there's no users.kind column.
export type User     = { id: number; email: string; display_name: string | null; created_at: number; disabled_at: number | null; idp_issuer: string | null; idp_subject: string | null; idp_checked_at: number | null; kind: "user" | "service" };
// What an IdP sign-in resolved to (security audit F-13, #928 D4). `linked`: the
// user had no subject yet and now has this one. Refusals: `subject_mismatch`,
// the email's user belongs to another account at the same IdP (the email was
// reassigned); `issuer_mismatch`, the email's user belongs to another IdP
// (`issuer`, the one holding it); `email_changed`, this IdP account's user has
// another email; `service`, the email names a service principal (#270 D1).
export type IdpSignIn =
  | { status: "ok"; user: User; linked: boolean }
  | { status: "subject_mismatch" | "email_changed" | "service"; user: User }
  | { status: "issuer_mismatch"; user: User; issuer: string };
// The label `grayboard login --dev` sessions carry: a server started without dev auth revokes them (#805 F-04).
export const DEV_SESSION_LABEL = "dev";
export type Session  = { id: number; user_id: number; token_hash: string; created_at: number; last_used_at: number; revoked_at: number | null; label: string | null };
// A scope owner (#284 decision 5): a user (name = email), a team or a service principal.
export type PrincipalRow = { id: number; kind: Principal["kind"]; name: string; user_id: number | null; team_id: number | null; parent_id: number | null; created_at: number };

export type Team     = { id: number; name: string; created_by: number; policy: string; created_at: number };
// A team's wake policy (#806): 'open' (the default) isolates members' agents
// from each other's wakes, as from anyone's; 'collaborative' grants members'
// agents a wake across users (vision.md principle 9); 'delegating' (#256)
// is collaborative and also lets a member's session name another member's
// launcher in `delegate`'s `to`.
export type TeamPolicy = "open" | "collaborative" | "delegating";
export const TEAM_POLICIES: readonly TeamPolicy[] = ["open", "collaborative", "delegating"];

// A team member's role as the roster shows it (security audit F-02): an owner holds a team_owner binding on the
// team (#927); every other member is a member. Owners (and org admins) manage membership; members read.
export type TeamRole = "owner" | "member";
export type TeamMember = { user_id: number; email: string; role: TeamRole };

// A role binding (#927) with its principals' names: holder, scope (null for the org) and granter (null when seeded).
export type RoleBinding = {
  id: number; principal_id: number; principal: string; role: string;
  scope_id: number | null; scope: string | null; granted_by: number | null; granter: string | null; granted_at: number;
};
// The service_invoke binding that carries a principal's right on a service (#270 D6): its id, and the team that holds
// it when the right is a member's through their team (null for the principal's own binding).
export type InvokeBinding = { id: number; team: string | null };
// Whose authority a grant or revoke re-checks in its own write (#927): none (a bootstrap admin, whose env list
// doesn't change at runtime, a team's creator, a member's own removal), the granter's org_admin binding, or their
// team_owner binding on the binding's scope or an org_admin binding.
export type RoleAuthority = "none" | "org_admin" | "owner_or_admin";
// Who changes a team's membership and the authority the write re-checks, as a grant's `byUser` and `authority`
// (owner_or_admin: their team_owner binding on the team, or org_admin). Omitted, "none": a team's creator joining it,
// a member leaving it, a fixture.
export type MemberAuthority = { byUser: number | null; authority: RoleAuthority };
// A removal's authority, and its role.revoked row's actor and the fields its detail carries beside the binding.
export type MemberRemoval = MemberAuthority & { actor: string | null; audit?: AuditFields };
// A JSON value, as an audit row's detail stores it: fields a caller adds beside the binding (`audit`) are JSON,
// never a value that serializes to something else or to nothing (a Date, a function, a bigint).
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [k: string]: JsonValue | undefined };
export type AuditFields = { readonly [k: string]: JsonValue | undefined };
export type RoleGrant = {
  holder: string; role: string; scope: string | null;
  // The role table's facts (policy.ts ROLES): the holder kinds allowed, the scope's kind (null: the org).
  holderKinds: readonly Principal["kind"][]; scopeKind: Principal["kind"] | null;
  // Whether the holder must be a member of the scope's team (team_owner).
  member: boolean;
  // The granter's principal name, recorded as granted_by; their user id, whose bindings `authority` checks (the
  // same key as roles.ts's follow-up read, so the two can't disagree on who the granter is).
  by: string; byUser: number | null; authority: RoleAuthority;
  // The audit row's actor, and fields its detail carries beside the binding (as_admin).
  actor: string; audit?: AuditFields;
};
// byUser: the revoking user's id, whose bindings `authority` checks (null with authority "none").
export type RoleRevoke = { holder: string; role: string; scope: string | null; byUser: number | null; authority: RoleAuthority; actor: string | null; audit?: AuditFields };
export type RoleFilter = { role?: string; principal?: string; scope?: string };
// A service principal as the admin list shows it (#270 D1): id is its principals row's.
export type ServiceRow = { id: number; name: string; created_at: number; disabled_at: number | null; owners: string[] };

// The groups, as Repo carries them.
export interface UsersStore {
  upsertByEmail(tx: Tx, email: string, displayName: string | null): Promise<User>;
  // An IdP sign-in: matches (issuer, subject) first, then the email (F-13, #928 D4).
  signIn(tx: Tx, issuer: string, subject: string, email: string, displayName: string | null): Promise<IdpSignIn>;
  // Forgets a user's IdP issuer and subject, so the next sign-in with the email, from any IdP, links its account. The
  // IdP clock stays, and a missing one starts at 0: with no issuer, a null clock would read as exempt (#930).
  clearSubject(tx: Tx, userId: number): Promise<void>;
  // Starts the user's IdP clock now (#930): a dev login, the one sign-in with no IdP to stamp it.
  stampIdpChecked(tx: Tx, userId: number): Promise<void>;
  findByEmail(r: Read, email: string): Promise<User | undefined>;
  // Uncached: a fresh read on the caller's handle.
  findById(r: Read, userId: number): Promise<User | undefined>;
  // findById(r, id)?.disabled_at != null, cached on authGeneration (#853); inside the caller's own transaction it
  // reads on its Tx, uncached.
  isDisabled(r: Read, userId: number): Promise<boolean>;
  // The user's email and kind (#270 D1) while it exists and isn't disabled, cached as isDisabled is.
  active(r: Read, userId: number): Promise<{ email: string; kind: User["kind"] } | undefined>;
  setDisabled(tx: Tx, userId: number, disabled: boolean): Promise<void>;
}
export interface SessionsStore {
  create(tx: Tx, userId: number, tokenHash: string, label: string | null): Promise<Session>;
  findByTokenHash(r: Read, hash: string): Promise<Session | undefined>;
  findById(r: Read, sessionId: number): Promise<Session | undefined>;
  revoke(tx: Tx, sessionId: number): Promise<void>;
  revokeAllForUser(tx: Tx, userId: number): Promise<void>;
  // The user's unrevoked sessions used after `usedAfter` (the idle cutoff; 0 for all), newest use first, at most
  // `limit` (#930's per-grant list).
  listLive(r: Read, userId: number, usedAfter: number, limit: number): Promise<Session[]>;
  // Revokes one of the user's live sessions in one conditional statement; false when it isn't theirs or is already
  // revoked, so of two concurrent revokes one answers true (#930).
  revokeOwn(tx: Tx, userId: number, sessionId: number): Promise<boolean>;
  // Revokes every live dev-auth session (`grayboard login --dev`); returns how many.
  revokeDev(tx: Tx): Promise<number>;
  touch(tx: Tx, sessionId: number, now: number): Promise<void>;
}
// Policy's reads on the caller's handle (#807 P3 A7e3), as are the teams reads below and users.findByEmail.
export interface PrincipalsStore {
  findByName(r: Read, name: string): Promise<PrincipalRow | undefined>;
  // Who an address acts for (#284 S12): an ID's registering user, an alias's scope owner, a team broadcast's team.
  of(r: Read, address: string): Promise<Principal | null>;
}
// The writes return promises (#807 P3 A6g), and so do the reads, on the caller's handle (A7e3).
export interface TeamsStore {
  // Inserts the team's principal in the same transaction; rejects with
  // PrincipalTaken if another principal has the name.
  create(tx: Tx, name: string, createdBy: number): Promise<Team>;
  findByName(r: Read, name: string): Promise<Team | undefined>;
  // In team id order.
  listForUser(r: Read, userId: number): Promise<Team[]>;
  // Adds a member; an existing member is left as is (false). Ownership is a role binding (#927): roles.grant.
  // Conditional on `by`'s authority as roles.grant is, serialized with every role-binding write: rejects with
  // AuthorityLost, adding no one, when it no longer holds.
  addMember(tx: Tx, teamId: number, userId: number, by?: MemberAuthority): Promise<boolean>;
  // Removes a member, revoking their team_owner binding first through the roles revoke (its role.revoked row with
  // `by`'s actor and audit fields), which rejects with LastOwner rather than leave a team with members and no owner
  // (security audit F-02). Rejects with AuthorityLost, before any write, when `by`'s authority no longer holds. The
  // revoked binding, or null.
  removeMember(tx: Tx, teamId: number, userId: number, by?: MemberRemoval): Promise<RoleBinding | null>;
  // The roster, each member's role read from the team's team_owner bindings. Both in user id order.
  listMembers(r: Read, teamId: number): Promise<TeamMember[]>;
  listMemberUserIds(r: Read, teamId: number): Promise<number[]>;
  isMember(r: Read, teamId: number, userId: number): Promise<boolean>;
  // The previous policy, or null when the team is gone.
  setPolicy(tx: Tx, teamId: number, policy: TeamPolicy): Promise<TeamPolicy | null>;
  // Whether two users share a team whose policy is 'collaborative' or
  // 'delegating': the grant under which one's agents may wake the other's (#806).
  shareCollaborative(r: Read, userA: number, userB: number): Promise<boolean>;
  // Whether two users share a team whose policy is 'delegating': the grant
  // under which one's session may delegate to the other's launcher (#256).
  shareDelegating(r: Read, userA: number, userB: number): Promise<boolean>;
  // Whether two users share any team: the human-reach rule's teammates, in one statement (A7e3).
  shareAny(r: Read, userA: number, userB: number): Promise<boolean>;
}
// Runtime role bindings (#927). Grant and revoke name the binding by its principals' names, resolved inside their
// statements; each writes its role.granted or role.revoked row in the caller's transaction.
export interface RolesStore {
  // One INSERT ... SELECT: the binding inserted, or null when nothing was (already held, or a precondition failed:
  // a name with no principal, a kind the role doesn't take, a team_owner holder who isn't a member, the granter's
  // authority gone). The caller's follow-up reads say which.
  grant(tx: Tx, g: RoleGrant): Promise<RoleBinding | null>;
  // One DELETE ... RETURNING: the binding deleted, or null when there was none or the granter's authority is gone.
  // Rejects with LastOwner rather than leave a team with members and no owner.
  revoke(tx: Tx, r: RoleRevoke): Promise<RoleBinding | null>;
  // The binding a principal holds, by names.
  find(r: Read, holder: string, role: string, scope: string | null): Promise<RoleBinding | undefined>;
  // A user's binding id for a role on the org (teamId null) or a team: a decision's one indexed lookup.
  bindingOf(r: Read, userId: number, role: string, teamId: number | null): Promise<number | undefined>;
  // The service_invoke binding a principal holds on a service (#270 D6): its own, else, for a user, one a team it's a
  // member of holds (`team` names that team), the lowest team name first. One statement driven from the holder:
  // 1 + its team count probes of the unique (principal_id, role, scope_id) index, never a scan of the service's
  // holders (principle 13); membership read live (principle 11). A service is never a team member (D1), and a team
  // principal holds only by its own binding.
  invokeBinding(r: Read, holder: Principal, service: string): Promise<InvokeBinding | undefined>;
  // Bindings with ids above `after`, in id order, at most `limit`, filtered by role, holder name and scope name.
  list(r: Read, filter: RoleFilter, after: number, limit: number): Promise<RoleBinding[]>;
}
// Service principals (#270 D1): a users row whose email column holds the service's name, and a principals row of
// kind 'service' on it. Lifecycle is the admin routes' (`/api/admin/services`); nothing deletes one.
export interface ServicesStore {
  // Both rows, in one statement each and no prior read: the UNIQUE names decide, so a name a user, team or
  // service already holds throws PrincipalTaken. Owners are the caller's grants, in the same transaction.
  create(tx: Tx, name: string): Promise<User>;
  // Services with principal ids above `after`, in id order, at most `limit`, each with its owners' names.
  list(r: Read, after: number, limit: number): Promise<ServiceRow[]>;
  // The services this user owns whose every owner is now disabled: what disabling them left without an
  // accountable owner; an admin grants the replacement (no automatic pick).
  orphanedBy(r: Read, userId: number): Promise<string[]>;
}

// The groups as the Postgres store implements them: users.setDisabled and sessions.revokeAllForUser came with the OAuth
// store (C4b); users.isDisabled and users.active port with the auth cache (C9).
export type IdentityGroups = {
  users: Omit<UsersStore, "isDisabled" | "active">;
  sessions: SessionsStore;
  principals: PrincipalsStore;
  teams: TeamsStore;
  roles: RolesStore;
  services: ServicesStore;
};
