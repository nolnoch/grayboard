// The identity store groups on Postgres (#807 P3 C3, docs/future/postgres-server.md D3, D6): users, sessions,
// principals, teams, roles and services over store/identity.ts's interfaces, each function on its caller's handle
// through pgOf. The SQLite store (db.ts makeRepo) is the reference; what differs, and why:
// - Under READ COMMITTED each statement sees a new snapshot, and a statement that waits on a row lock re-checks only
//   that row's WHERE, not its subqueries. Every lock and savepoint below follows from that.
// - Role-binding and membership writes (roles.grant, roles.revoke, teams.addMember, teams.removeMember) take one
//   transaction-scoped advisory lock first (ROLE_WRITE_LOCK), outside the store's own savepoints: ROLLBACK TO frees a
//   lock taken inside one. It closes the last-owner counts, the mutual org_admin revoke (each DELETE re-checks its own
//   revoker's binding, which the other's uncommitted DELETE leaves visible), an owner grant racing a member removal,
//   and a member added or removed by an owner whose binding is being revoked, in one lock order, so no deadlock.
//   removeMember takes it unconditionally: revokeBinding returns early for a non-owner, the very case the grant race is.
//   addMember takes it even for "none": the count a concurrent revoke of the last owner makes must see the new member.
// - A refusal thrown after a write (revokeBinding's LastOwner, upsertUser's PrincipalTaken) runs in the store's own
//   savepoint: a caller that catches it, as revokeRole and the member routes catch LastOwner, commits nothing the
//   refused call wrote. So does every statement whose 23505 is control flow (teams.create, services.create, the
//   sign-in link), and the savepoint covers errors rethrown unmapped too: a raw error there would abort the caller's
//   whole transaction.
// - users.setDisabled and sessions.revokeAllForUser (C4b) end the user's OAuth rows and, through the injected hosted
//   port (makePgHostedEnds), their hosted sessions. Each locks the users row first, setDisabled by its UPDATE and
//   revokeAllForUser by FOR NO KEY UPDATE, against every OAuth mint's FOR SHARE on it (pg/oauth.ts activeUser): a
//   mint that read the user as enabled commits first and the revoke's later statements see its row, or it waits and
//   finds the user disabled. users.isDisabled and users.active port with the auth cache (C9).
//
// Runtime imports stay off bun:sqlite and db.ts (pg/isolation.test.ts).
import { addressParts } from "../../../core/addresses.ts";
import type { Principal } from "../../../core/resolver.ts";
import { AuthorityLost, LastOwner, PrincipalTaken } from "../errors.ts";
import {
  DEV_SESSION_LABEL, TEAM_POLICIES,
  type IdentityGroups, type IdpSignIn, type MemberAuthority, type MemberRemoval, type PrincipalRow, type RoleAuthority, type RoleBinding, type RoleRevoke,
  type Session, type Team, type TeamMember, type TeamPolicy, type User,
} from "../identity.ts";
import type { Read, Tx } from "../tx_base.ts";
import { insertAudit } from "./audit_row.ts";
import { principalTaken, SERVICE_NAME_CONSTRAINTS, uniqueViolation } from "./errors.ts";
import type { PgHostedEnds } from "./hosted_port.ts";
import { endSignIns } from "./oauth.ts";
import { int8, int8OrNull } from "./sql.ts";
import { pgOf, type PgFragment, type PgSql } from "./tx.ts";

// pg_advisory_xact_lock's key for every role-binding write (#807 P3 C3 decision 1). One key serializes role writes
// server-wide, which their rate allows; keyed by org if that ever runs hot. Advisory keys are per database.
export const ROLE_WRITE_LOCK = 0x6762726f6c657321n; // "gbroles!"

export type PgIdentity = IdentityGroups;

type Row = Record<string, unknown>;
const str = (v: unknown) => v as string;
const strOrNull = (v: unknown) => v as string | null;

const toUser = (r: Row): User => ({
  id: int8(r.id), email: str(r.email), display_name: strOrNull(r.display_name), created_at: int8(r.created_at),
  disabled_at: int8OrNull(r.disabled_at), idp_issuer: strOrNull(r.idp_issuer), idp_subject: strOrNull(r.idp_subject),
  kind: r.kind as User["kind"],
});
const toSession = (r: Row): Session => ({
  id: int8(r.id), user_id: int8(r.user_id), token_hash: str(r.token_hash), created_at: int8(r.created_at),
  last_used_at: int8(r.last_used_at), revoked_at: int8OrNull(r.revoked_at), label: strOrNull(r.label),
});
const toPrincipal = (r: Row): PrincipalRow => ({
  id: int8(r.id), kind: r.kind as PrincipalRow["kind"], name: str(r.name), user_id: int8OrNull(r.user_id),
  team_id: int8OrNull(r.team_id), parent_id: int8OrNull(r.parent_id), created_at: int8(r.created_at),
});
const toTeam = (r: Row): Team => ({ id: int8(r.id), name: str(r.name), created_by: int8(r.created_by), policy: str(r.policy), created_at: int8(r.created_at) });
const toBinding = (r: Row): RoleBinding => ({
  id: int8(r.id), principal_id: int8(r.principal_id), principal: str(r.principal), role: str(r.role),
  scope_id: int8OrNull(r.scope_id), scope: strOrNull(r.scope), granted_by: int8OrNull(r.granted_by), granter: strOrNull(r.granter),
  granted_at: int8(r.granted_at),
});

// db.ts USER_SQL: the kind is the service principal's, read with the row.
const userFrom = (sql: PgSql) => sql.fragment`SELECT u.id, u.email, u.display_name, u.created_at, u.disabled_at, u.idp_issuer, u.idp_subject,
  CASE WHEN p.id IS NULL THEN 'user' ELSE 'service' END AS kind
  FROM users u LEFT JOIN principals p ON p.user_id = u.id AND p.kind = 'service'`;
// db.ts BINDING_SQL.
const bindingFrom = (sql: PgSql) => sql.fragment`SELECT b.id, b.principal_id, p.name AS principal, b.role, b.scope_id, s.name AS scope, b.granted_by, g.name AS granter, b.granted_at
  FROM role_bindings b JOIN principals p ON p.id = b.principal_id LEFT JOIN principals s ON s.id = b.scope_id LEFT JOIN principals g ON g.id = b.granted_by`;

const first = async <T>(rows: Promise<Row[]>, map: (r: Row) => T): Promise<T | undefined> => {
  const [r] = await rows;
  return r ? map(r) : undefined;
};

const userById = (sql: PgSql, id: number) => first(sql`${userFrom(sql)} WHERE u.id = ${id}`, toUser);
const userByEmail = (sql: PgSql, email: string) => first(sql`${userFrom(sql)} WHERE u.email = ${email}`, toUser);
const principalByName = (sql: PgSql, name: string) => first(sql`SELECT * FROM principals WHERE name = ${name}`, toPrincipal);
const bindingById = async (sql: PgSql, id: number) => (await first(sql`${bindingFrom(sql)} WHERE b.id = ${id}`, toBinding))!;

const roleLock = async (sql: PgSql) => { await sql`SELECT pg_advisory_xact_lock(${ROLE_WRITE_LOCK.toString()}::int8)`; };

// The granter's authority as of this statement (db.ts authoritySql): `scope` the column naming the binding's scope.
// "none" is TRUE: Postgres refuses SQLite's bare 1 in a WHERE (42804).
function authority(sql: PgSql, a: RoleAuthority, byUser: number | null, scope: () => PgFragment): PgFragment {
  const admin = () => sql.fragment`EXISTS (SELECT 1 FROM role_bindings ga JOIN principals gp ON gp.id = ga.principal_id WHERE gp.kind = 'user' AND gp.user_id = ${byUser} AND ga.role = 'org_admin' AND ga.scope_id IS NULL)`;
  if (a === "none") return sql.fragment`TRUE`;
  if (a === "org_admin") return admin();
  return sql.fragment`(${admin()} OR EXISTS (SELECT 1 FROM role_bindings gt JOIN principals gp ON gp.id = gt.principal_id WHERE gp.kind = 'user' AND gp.user_id = ${byUser} AND gt.role = 'team_owner' AND gt.scope_id = ${scope()}))`;
}

// A membership change's authority on the team, as of this statement.
const teamAuthority = (sql: PgSql, by: MemberAuthority, teamId: number): PgFragment =>
  authority(sql, by.authority, by.byUser, () => sql.fragment`(SELECT id FROM principals WHERE kind = 'team' AND team_id = ${teamId})`);
const authorityHolds = async (sql: PgSql, by: MemberAuthority, teamId: number): Promise<boolean> =>
  (await sql`SELECT ${teamAuthority(sql, by, teamId)} AS ok`)[0]!.ok === true;
const NO_AUTHORITY: MemberRemoval = { byUser: null, authority: "none", actor: null };

const bindingDetail = (b: RoleBinding) => ({
  binding: b.id, role: b.role, principal: b.principal, principal_id: b.principal_id, scope: b.scope, scope_id: b.scope_id,
  granted_by: b.granted_by, granter: b.granter, granted_at: b.granted_at,
});

// A sign-in attempt's lost conditional link: thrown inside the attempt's savepoint so nothing the attempt wrote stays.
class LostLink extends Error {}

export function makePgIdentity({ now, hosted }: { now: () => number; hosted: PgHostedEnds }): PgIdentity {
  // What a disable and a revoke-all both end (db.ts setDisabled, revokeAllForUser): the CLI sessions, the OAuth grants,
  // then the hosted sessions, the browser sessions (a live one consents without the IdP, #1552) and the unredeemed codes. The users row is already
  // locked (see the header), so each statement here sees every row a concurrent mint for the user committed.
  const revokeUser = async (tx: Tx, userId: number, reason: "revoked" | "disabled", at: number) => {
    const sql = pgOf(tx);
    // CLI tokens too, so enable-user doesn't revive them (security audit F-14).
    await sql`UPDATE sessions SET revoked_at = ${at} WHERE user_id = ${userId} AND revoked_at IS NULL`;
    await sql`UPDATE oauth_grants SET revoked_at = ${at} WHERE user_id = ${userId} AND revoked_at IS NULL`;
    // After the grants' revoke, as revokeGrant orders its own end (hosted_port.ts: the lock order).
    await hosted.endForUser(tx, userId, reason, at);
    await sql`DELETE FROM oauth_browsers WHERE user_id = ${userId}`;
    await sql`DELETE FROM oauth_codes WHERE user_id = ${userId} AND grant_id IS NULL`;
  };

  // A user row by email, created or renamed, with its principal (db.ts upsertUser). In a savepoint: the PrincipalTaken
  // for a service's name comes after the rename, so a caller that catches it commits no rename. That's the store's
  // guarantee; no caller catches it today (devLogin and the sign-in's new user propagate it). Three statements, not one
  // conditional upsert: a NOT EXISTS in the upsert reads the snapshot from before it waited on a concurrent
  // services.create, and renames the service; the re-read is a new statement and sees it.
  const upsertUser = (tx: Tx, email: string, displayName: string | null): Promise<User> => tx.savepoint(async sp => {
    const sql = pgOf(sp);
    const at = now();
    const [row] = await sql`INSERT INTO users (email, display_name, created_at) VALUES (${email}, ${displayName}, ${at})
      ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name RETURNING id`;
    const user = (await userById(sql, int8(row.id)))!;
    // A service's row is never a person's (#270 D1).
    if (user.kind === "service") throw new PrincipalTaken(email);
    await sql`INSERT INTO principals (kind, name, user_id, created_at) VALUES ('user', ${email}, ${user.id}, ${at}) ON CONFLICT DO NOTHING`;
    return user;
  });

  // One sign-in attempt (db.ts signIn's loop body): the outcome, or LostLink / a 23505 on idx_users_idp_identity when a
  // concurrent sign-in linked first.
  async function signInAttempt(tx: Tx, issuer: string, subject: string, email: string, displayName: string | null): Promise<IdpSignIn> {
    const sql = pgOf(tx);
    // Conditional on the row still being unlinked and enabled (D3): another sign-in may have linked it, or an admin
    // disabled it, since the read. Zero rows takes the lost-link path, whose re-read decides as a serial run would.
    const link = async (id: number) => (await sql`UPDATE users SET idp_issuer = ${issuer}, idp_subject = ${subject}, display_name = ${displayName}
      WHERE id = ${id} AND idp_subject IS NULL AND (idp_issuer IS NULL OR idp_issuer = ${issuer}) AND disabled_at IS NULL RETURNING id`).length === 1;
    // 1. This IdP account's user.
    const bySubject = await first(sql`${userFrom(sql)} WHERE u.idp_issuer = ${issuer} AND u.idp_subject = ${subject}`, toUser);
    if (bySubject) {
      if (bySubject.email !== email) return { status: "email_changed", user: bySubject };
      await sql`UPDATE users SET display_name = ${displayName} WHERE id = ${bySubject.id}`;
      return { status: "ok", user: { ...bySubject, display_name: displayName }, linked: false };
    }
    const byEmail = await userByEmail(sql, email);
    if (byEmail?.kind === "service") return { status: "service", user: byEmail };
    if (byEmail) {
      // 3. Another IdP holds the email; 2. another account at this IdP does.
      if (byEmail.idp_issuer !== null && byEmail.idp_issuer !== issuer) return { status: "issuer_mismatch", user: byEmail, issuer: byEmail.idp_issuer };
      if (byEmail.idp_subject !== null) return { status: "subject_mismatch", user: byEmail };
      // A disabled account isn't bound to whoever tried (security audit F-13).
      if (byEmail.disabled_at !== null) return { status: "ok", user: byEmail, linked: false };
      // 4 and 5.
      if (await link(byEmail.id)) return { status: "ok", user: { ...byEmail, idp_issuer: issuer, idp_subject: subject, display_name: displayName }, linked: true };
      throw new LostLink();
    }
    // 6. A new user, created with both.
    const user = await upsertUser(tx, email, displayName);
    if (await link(user.id)) return { status: "ok", user: { ...user, idp_issuer: issuer, idp_subject: subject }, linked: false };
    throw new LostLink();
  }

  // One binding deleted by ids, if the revoker's authority holds, with its role.revoked row (db.ts revokeBinding). The
  // caller holds ROLE_WRITE_LOCK, taken outside this savepoint. The savepoint is what makes LastOwner a refusal: it
  // comes after the DELETE, and the callers (revokeRole, teamLeave, member removal) catch it and commit. The lock
  // outlives the ROLLBACK TO, so a caller that goes on writing bindings still holds it.
  const revokeBinding = (tx: Tx, principalId: number, role: string, scopeId: number | null, r: Pick<RoleRevoke, "byUser" | "authority" | "actor" | "audit">): Promise<RoleBinding | null> =>
    tx.savepoint(async sp => {
      const sql = pgOf(sp);
      const scopeIs = (col: () => PgFragment) => scopeId === null ? sql.fragment`${col()} IS NULL` : sql.fragment`${col()} = ${scopeId}`;
      const before = await first(sql`${bindingFrom(sql)} WHERE b.principal_id = ${principalId} AND b.role = ${role} AND ${scopeIs(() => sql.fragment`b.scope_id`)}`, toBinding);
      const gone = await sql`DELETE FROM role_bindings WHERE principal_id = ${principalId} AND role = ${role} AND ${scopeIs(() => sql.fragment`scope_id`)}
        AND ${authority(sql, r.authority, r.byUser, () => sql.fragment`role_bindings.scope_id`)} RETURNING id`;
      if (!gone.length || !before) return null;
      if (role === "team_owner" && scopeId !== null) {
        const [c] = await sql`SELECT (SELECT count(*) FROM role_bindings WHERE scope_id = ${scopeId} AND role = 'team_owner') AS owners,
                (SELECT count(*) FROM team_members WHERE team_id = t.id) AS members, t.name AS team
           FROM principals pt JOIN teams t ON t.id = pt.team_id WHERE pt.id = ${scopeId}`;
        if (c && int8(c.owners) === 0 && int8(c.members) > 1) throw new LastOwner(str(c.team), "team");
      }
      // Every service keeps an owner (#270 D1), with no sole-member exception.
      if (role === "service_owner" && scopeId !== null) {
        const [c] = await sql`SELECT (SELECT count(*) FROM role_bindings WHERE scope_id = ${scopeId} AND role = 'service_owner') AS owners, ps.name
           FROM principals ps WHERE ps.id = ${scopeId} AND ps.kind = 'service'`;
        if (c && int8(c.owners) === 0) throw new LastOwner(str(c.name), "service");
      }
      await insertAudit(sql, now(), r.actor, "role.revoked", before.principal, { ...bindingDetail(before), ...r.audit });
      return before;
    });

  // Whether two users share a team, of one of these policies when given.
  const sharePolicy = async (r: Read, userA: number, userB: number, policies?: readonly TeamPolicy[]): Promise<boolean> => {
    const sql = pgOf(r);
    const rows = await sql`SELECT 1 FROM team_members a
      JOIN team_members b ON b.team_id = a.team_id AND b.user_id = ${userB}
      ${policies ? sql.fragment`JOIN teams t ON t.id = a.team_id AND t.policy = ANY(${policies})` : sql.fragment``}
      WHERE a.user_id = ${userA} LIMIT 1`;
    return rows.length > 0;
  };

  return {
    users: {
      upsertByEmail: (tx, email, displayName) => upsertUser(tx, email, displayName),
      // Each attempt in its own savepoint (decision 5): an attempt that loses its link to a concurrent sign-in (zero rows,
      // or 23505 on idx_users_idp_identity when two emails link one subject) leaves nothing, not even the user its
      // upsert created, and the next attempt re-reads and decides as a serial run would.
      async signIn(tx, issuer, subject, email, displayName) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            return await tx.savepoint(sp => signInAttempt(sp, issuer, subject, email, displayName));
          } catch (e) {
            if (e instanceof LostLink || uniqueViolation(e) === "idx_users_idp_identity") continue;
            throw e;
          }
        }
        throw new Error(`sign-in for ${email} kept losing its link to concurrent sign-ins`);
      },
      async clearSubject(tx, userId) {
        await pgOf(tx)`UPDATE users SET idp_issuer = NULL, idp_subject = NULL WHERE id = ${userId}`;
      },
      findByEmail: (r, email) => userByEmail(pgOf(r), email),
      findById: (r, userId) => userById(pgOf(r), userId),
      // The UPDATE is the users row's lock: it waits for a mint holding FOR SHARE, and a mint after it waits, then finds
      // the user disabled. Re-enabling revives nothing the disable revoked.
      async setDisabled(tx, userId, disabled) {
        const at = now();
        await pgOf(tx)`UPDATE users SET disabled_at = ${disabled ? at : null} WHERE id = ${userId}`;
        if (disabled) await revokeUser(tx, userId, "disabled", at);
      },
    },

    sessions: {
      async create(tx, userId, tokenHash, label) {
        const at = now();
        const [row] = await pgOf(tx)`INSERT INTO sessions (user_id, token_hash, created_at, last_used_at, label)
          VALUES (${userId}, ${tokenHash}, ${at}, ${at}, ${label}) RETURNING *`;
        return toSession(row);
      },
      findByTokenHash: (r, hash) => first(pgOf(r)`SELECT * FROM sessions WHERE token_hash = ${hash} AND revoked_at IS NULL`, toSession),
      // By row, revoked ones included: the caller reads revoked_at (#351).
      findById: (r, sessionId) => first(pgOf(r)`SELECT * FROM sessions WHERE id = ${sessionId}`, toSession),
      async revoke(tx, sessionId) {
        await pgOf(tx)`UPDATE sessions SET revoked_at = ${now()} WHERE id = ${sessionId}`;
      },
      async listLive(r, userId, usedAfter, limit) {
        return (await pgOf(r)`SELECT * FROM sessions WHERE user_id = ${userId} AND revoked_at IS NULL AND last_used_at > ${usedAfter}
          ORDER BY last_used_at DESC, id DESC LIMIT ${limit}`).map(toSession);
      },
      // The users row first, as revokeUserGrant (pg/oauth.ts) and for the same consent race (#1552).
      async revokeOwn(tx, userId, sessionId) {
        const sql = pgOf(tx);
        await sql`SELECT 1 FROM users WHERE id = ${userId} FOR NO KEY UPDATE`;
        if (!(await sql`UPDATE sessions SET revoked_at = ${now()} WHERE id = ${sessionId} AND user_id = ${userId} AND revoked_at IS NULL RETURNING id`).length) return false;
        await endSignIns(sql, userId);
        return true;
      },
      // Writes no users row, so it locks it: FOR NO KEY UPDATE conflicts with a mint's FOR SHARE (a plain FK insert's
      // KEY SHARE would not), so a CLI session, grant or code minted concurrently is either committed and revoked here
      // or minted after this commits.
      async revokeAllForUser(tx, userId) {
        await pgOf(tx)`SELECT 1 FROM users WHERE id = ${userId} FOR NO KEY UPDATE`;
        await revokeUser(tx, userId, "revoked", now());
      },
      async revokeDev(tx) {
        return (await pgOf(tx)`UPDATE sessions SET revoked_at = ${now()} WHERE label = ${DEV_SESSION_LABEL} AND revoked_at IS NULL RETURNING 1`).length;
      },
      async touch(tx, sessionId, at) {
        await pgOf(tx)`UPDATE sessions SET last_used_at = ${at} WHERE id = ${sessionId}`;
      },
    },

    principals: {
      findByName: (r, name) => principalByName(pgOf(r), name),
      // db.ts principalOf.
      async of(r, address): Promise<Principal | null> {
        const sql = pgOf(r);
        const p = addressParts(address);
        if (!p || p.kind === "bare") return null;
        const name = p.kind === "id"
          ? (await first(sql`SELECT principal FROM ids WHERE id = ${p.address}`, row => strOrNull(row.principal)))
          : p.kind === "alias" ? p.scope : p.name;
        const row = name ? await principalByName(sql, name) : undefined;
        // team:x names a team, never a service; a person scope (an email) is only a user's.
        if (!row || (p.kind === "team" && row.kind !== "team")) return null;
        if (p.kind === "alias" && (p.scopeKind === "person") !== (row.kind === "user")) return null;
        return { kind: row.kind, name: row.name };
      },
    },

    teams: {
      // No prior read (D3): the UNIQUE names decide. The savepoint keeps the caller's transaction usable after any
      // error here, mapped (PrincipalTaken, which teamCreate answers 409 and commits past) or not.
      async create(tx, name, createdBy) {
        try {
          return await tx.savepoint(async sp => {
            const sql = pgOf(sp);
            const at = now();
            const [row] = await sql`INSERT INTO teams (name, created_by, created_at) VALUES (${name}, ${createdBy}, ${at}) RETURNING *`;
            const team = toTeam(row);
            await sql`INSERT INTO principals (kind, name, team_id, created_at) VALUES ('team', ${name}, ${team.id}, ${at})`;
            return team;
          });
        } catch (e) {
          throw principalTaken(e, name) ?? e;
        }
      },
      findByName: (r, name) => first(pgOf(r)`SELECT * FROM teams WHERE name = ${name}`, toTeam),
      async listForUser(r, userId) {
        return (await pgOf(r)`SELECT t.* FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE tm.user_id = ${userId} ORDER BY t.id`).map(toTeam);
      },
      // A missing team or user is the caller's 23503, rethrown: callers check both first. Under the role lock, and
      // conditional on the actor's authority: an owner revoked after the route's decision adds no one, and one revoked
      // after this commits finds the new member in its last-owner count. Zero rows is an existing member or the
      // authority gone; under the lock a second statement reads the same bindings and says which.
      async addMember(tx, teamId, userId, by = NO_AUTHORITY) {
        const sql = pgOf(tx);
        await roleLock(sql);
        const added = (await sql`INSERT INTO team_members (team_id, user_id, joined_at)
          SELECT ${teamId}::int8, ${userId}::int8, ${now()}::int8 WHERE ${teamAuthority(sql, by, teamId)}
          ON CONFLICT DO NOTHING RETURNING 1`).length > 0;
        if (!added && !(await authorityHolds(sql, by, teamId))) throw new AuthorityLost();
        return added;
      },
      // The role lock first and unconditionally: a removal racing a team_owner grant to the same user must serialize
      // with it even when the user isn't an owner yet (revokeBinding returns early then), or the grant commits an owner
      // who is no longer a member. The actor's authority is read once under it, before any write: the revoke may
      // delete the very binding it rests on (an owner removing themselves), so a re-check after it would refuse what
      // the decision allowed. Only lock holders change bindings, so the read stays true until commit.
      async removeMember(tx, teamId, userId, by = NO_AUTHORITY) {
        const sql = pgOf(tx);
        await roleLock(sql);
        if (!(await authorityHolds(sql, by, teamId))) throw new AuthorityLost();
        const [ids] = await sql`SELECT (SELECT id FROM principals WHERE kind = 'user' AND user_id = ${userId}) AS pu,
          (SELECT id FROM principals WHERE kind = 'team' AND team_id = ${teamId}) AS pt`;
        const pu = int8OrNull(ids.pu), pt = int8OrNull(ids.pt);
        // An owner is a member (#927): their binding goes first, through revoke, with its row and the guard.
        const revoked = pu !== null && pt !== null
          ? await revokeBinding(tx, pu, "team_owner", pt, { byUser: by.byUser, authority: by.authority, actor: by.actor, audit: by.audit })
          : null;
        await sql`DELETE FROM team_members WHERE team_id = ${teamId} AND user_id = ${userId}`;
        return revoked;
      },
      async listMembers(r, teamId): Promise<TeamMember[]> {
        const rows = await pgOf(r)`SELECT u.id AS user_id, u.email, EXISTS (
            SELECT 1 FROM role_bindings b JOIN principals pu ON pu.id = b.principal_id JOIN principals pt ON pt.id = b.scope_id
             WHERE b.role = 'team_owner' AND pu.kind = 'user' AND pu.user_id = u.id AND pt.kind = 'team' AND pt.team_id = tm.team_id
          ) AS owner FROM users u
          JOIN team_members tm ON tm.user_id = u.id WHERE tm.team_id = ${teamId} ORDER BY tm.user_id`;
        return rows.map((m: Row) => ({ user_id: int8(m.user_id), email: str(m.email), role: m.owner === true ? "owner" : "member" }));
      },
      async listMemberUserIds(r, teamId) {
        return (await pgOf(r)`SELECT user_id FROM team_members WHERE team_id = ${teamId} ORDER BY user_id`).map((row: Row) => int8(row.user_id));
      },
      async isMember(r, teamId, userId) {
        return (await pgOf(r)`SELECT 1 FROM team_members WHERE team_id = ${teamId} AND user_id = ${userId}`).length > 0;
      },
      // FOR UPDATE: a concurrent setPolicy waits, then reads this one's value, so each audit row's previous policy is
      // the one it replaced.
      async setPolicy(tx, teamId, policy) {
        const sql = pgOf(tx);
        const [row] = await sql`SELECT policy FROM teams WHERE id = ${teamId} FOR UPDATE`;
        if (!row) return null;
        await sql`UPDATE teams SET policy = ${policy} WHERE id = ${teamId}`;
        return (TEAM_POLICIES as readonly string[]).includes(str(row.policy)) ? row.policy as TeamPolicy : "open";
      },
      shareAny: (r, userA, userB) => sharePolicy(r, userA, userB),
      shareCollaborative: (r, userA, userB) => sharePolicy(r, userA, userB, ["collaborative", "delegating"]),
      shareDelegating: (r, userA, userB) => sharePolicy(r, userA, userB, ["delegating"]),
    },

    roles: {
      // One INSERT ... SELECT under the role lock: the holder and scope by name with their kinds, the membership
      // precondition and the granter's authority all in its WHERE; zero rows is already held or a failed precondition.
      async grant(tx, g) {
        const sql = pgOf(tx);
        await roleLock(sql);
        const at = now();
        const scoped = g.scope !== null;
        const rows = await sql`INSERT INTO role_bindings (principal_id, role, scope_id, granted_by, granted_at)
          SELECT h.id, ${g.role}, ${scoped ? sql.fragment`s.id` : sql.fragment`NULL`}, (SELECT id FROM principals WHERE name = ${g.by}), ${at}
            FROM principals h ${scoped ? sql.fragment`JOIN principals s ON s.name = ${g.scope} AND s.kind = ${g.scopeKind}` : sql.fragment``}
           WHERE h.name = ${g.holder} AND h.kind = ANY(${g.holderKinds})
             ${scoped && g.member ? sql.fragment`AND EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = s.team_id AND tm.user_id = h.user_id)` : sql.fragment``}
             AND ${authority(sql, g.authority, g.byUser, () => scoped ? sql.fragment`s.id` : sql.fragment`NULL`)}
          ON CONFLICT DO NOTHING RETURNING id`;
        if (!rows.length) return null;
        const b = await bindingById(sql, int8(rows[0].id));
        await insertAudit(sql, at, g.actor, "role.granted", b.principal, { ...bindingDetail(b), ...g.audit });
        return b;
      },
      async revoke(tx, r) {
        const sql = pgOf(tx);
        await roleLock(sql);
        const [ids] = await sql`SELECT (SELECT id FROM principals WHERE name = ${r.holder}) AS pu, (SELECT id FROM principals WHERE name = ${r.scope}) AS ps`;
        const pu = int8OrNull(ids.pu), ps = int8OrNull(ids.ps);
        if (pu === null || (r.scope !== null && ps === null)) return null;
        return revokeBinding(tx, pu, r.role, r.scope === null ? null : ps, r);
      },
      async find(r, holder, role, scope) {
        const sql = pgOf(r);
        return first(sql`${bindingFrom(sql)} WHERE p.name = ${holder} AND b.role = ${role}
          AND ${scope === null ? sql.fragment`b.scope_id IS NULL` : sql.fragment`s.name = ${scope}`}`, toBinding);
      },
      async bindingOf(r, userId, role, teamId) {
        const sql = pgOf(r);
        return first(sql`SELECT b.id FROM role_bindings b JOIN principals p ON p.id = b.principal_id AND p.kind = 'user' AND p.user_id = ${userId}
          WHERE b.role = ${role} AND ${teamId === null ? sql.fragment`b.scope_id IS NULL` : sql.fragment`b.scope_id = (SELECT id FROM principals WHERE kind = 'team' AND team_id = ${teamId})`}`,
        row => int8(row.id));
      },
      // The SQLite store's statement (#270 D6): the holder's own binding, then its teams', each an index probe. The
      // team name sorts COLLATE "C", SQLite's bytewise order: a locale collation orders '-' and '_' differently, and
      // the decision row must name the same binding on both backends.
      async invokeBinding(r, holder, service) {
        const sql = pgOf(r);
        return first(sql`SELECT id, team FROM (
            SELECT b.id AS id, NULL::text AS team
              FROM principals h JOIN principals s ON s.name = ${service} AND s.kind = 'service'
              JOIN role_bindings b ON b.principal_id = h.id AND b.role = 'service_invoke' AND b.scope_id = s.id
             WHERE h.name = ${holder.name} AND h.kind = ${holder.kind}
            UNION ALL
            SELECT b.id, pt.name
              FROM principals h JOIN team_members tm ON tm.user_id = h.user_id
              JOIN principals pt ON pt.team_id = tm.team_id AND pt.kind = 'team'
              JOIN principals s ON s.name = ${service} AND s.kind = 'service'
              JOIN role_bindings b ON b.principal_id = pt.id AND b.role = 'service_invoke' AND b.scope_id = s.id
             WHERE ${holder.kind} = 'user' AND h.name = ${holder.name} AND h.kind = 'user') x
          ORDER BY team IS NOT NULL, team COLLATE "C" LIMIT 1`,
        row => ({ id: int8(row.id), team: strOrNull(row.team) }));
      },
      async list(r, f, after, limit) {
        const sql = pgOf(r);
        const none = () => sql.fragment``;
        return (await sql`${bindingFrom(sql)} WHERE b.id > ${after}
          ${f.role !== undefined ? sql.fragment`AND b.role = ${f.role}` : none()}
          ${f.principal !== undefined ? sql.fragment`AND p.name = ${f.principal}` : none()}
          ${f.scope !== undefined ? sql.fragment`AND s.name = ${f.scope}` : none()}
          ORDER BY b.id LIMIT ${limit}`).map(toBinding);
      },
    },

    services: {
      // Both rows in a savepoint, no prior read: the UNIQUE names decide, users_email_key among them (a service's name
      // is its users row's email), and the caller's transaction stays usable after any error.
      async create(tx, name) {
        try {
          return await tx.savepoint(async sp => {
            const sql = pgOf(sp);
            const at = now();
            const [row] = await sql`INSERT INTO users (email, display_name, created_at) VALUES (${name}, NULL, ${at}) RETURNING id`;
            const id = int8(row.id);
            await sql`INSERT INTO principals (kind, name, user_id, created_at) VALUES ('service', ${name}, ${id}, ${at})`;
            return (await userById(sql, id))!;
          });
        } catch (e) {
          throw principalTaken(e, name, SERVICE_NAME_CONSTRAINTS) ?? e;
        }
      },
      async list(r, after, limit) {
        return (await pgOf(r)`SELECT p.id, p.name, p.created_at, u.disabled_at,
                ARRAY(SELECT h.name FROM role_bindings b JOIN principals h ON h.id = b.principal_id
                       WHERE b.scope_id = p.id AND b.role = 'service_owner' ORDER BY h.name) AS owners
           FROM principals p JOIN users u ON u.id = p.user_id
          WHERE p.kind = 'service' AND p.id > ${after} ORDER BY p.id LIMIT ${limit}`)
          .map((row: Row) => ({ id: int8(row.id), name: str(row.name), created_at: int8(row.created_at), disabled_at: int8OrNull(row.disabled_at), owners: row.owners as string[] }));
      },
      async orphanedBy(r, userId) {
        return (await pgOf(r)`SELECT s.name FROM role_bindings b
            JOIN principals h ON h.id = b.principal_id AND h.kind = 'user'
            JOIN principals s ON s.id = b.scope_id AND s.kind = 'service'
           WHERE b.role = 'service_owner' AND h.user_id = ${userId}
             AND NOT EXISTS (SELECT 1 FROM role_bindings o JOIN principals oh ON oh.id = o.principal_id JOIN users ou ON ou.id = oh.user_id
                              WHERE o.scope_id = b.scope_id AND o.role = 'service_owner' AND ou.disabled_at IS NULL)
           ORDER BY s.name`).map((row: Row) => str(row.name));
      },
    },
  };
}
