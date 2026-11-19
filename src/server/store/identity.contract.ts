// The identity store's contract (#807 P3 C3, docs/future/postgres-server.md D9): users, sessions, principals, teams,
// roles and services, written once over a harness so SQLite runs it today and the Postgres store (C3b) runs the same
// rows. Not a *.test.ts file, so Bun doesn't discover it: a backend's test file registers it under a describe().
// The real grantRole, revokeRole and authorize run on the harness's groups (roles.ts RoleStores, policy.ts
// PolicyStores), so the role refusals and the decision reads are the contract's too.
//
// Portability rules the rows follow:
// - Each row opens a fresh store and asserts no absolute id: ids are compared to the rows the row itself made.
// - A refusal a caller catches and commits past (PrincipalTaken, LastOwner) is caught inside the write body, which
//   then commits: what the row checks is that the store's own savepoint undid the refused write, not that a
//   rejected write rolled back (every backend does that).
// - An error the store doesn't map is matched by a phrase both backends' messages carry (/unique/i, /foreign key/i).
// - Fixture writes the groups don't offer (a disabled user, a pre-F-13 issuer-only row, a session's ids row, a
//   policy no setter writes) and the raw reads (principal rows, audit rows) are the harness's, so no row touches a
//   connection. users.setDisabled isn't used here: what it ends is OAuth state, so oauth.contract.ts covers it and
//   sessions.revokeAllForUser on both backends.
// - Rows that force an interleaving with a SQLite trigger are registered on SQLite only (`sqliteOnly`), with their
//   reason. Postgres runs each as a two-connection race in pg/identity.pg.test.ts: T-C3-6 for the teams.create name
//   race, T-C3-5b for the sign-in link race below.
import { expect, test } from "bun:test";
import { grantRole, revokeRole, type Granter, type RoleSpec } from "../roles.ts";
import { authorize, type AuthzRequest } from "../policy.ts";
import { AuthorityLost, LastOwner, PrincipalTaken } from "./errors.ts";
import type { IdentityGroups, MemberAuthority, User } from "./identity.ts";
import type { Read, Tx } from "./tx_base.ts";

// One store, fresh per row.
export type IdentityStore = IdentityGroups & {
  write<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  read: Read;
  // Fixture writes, each in its own transaction.
  disable(userId: number): Promise<void>;
  // Sets both IdP columns as an admin's SQL would; rejects as the store's unique index does.
  setIdp(userId: number, issuer: string | null, subject: string | null): Promise<void>;
  // A team's policy column, unchecked: a value no setter writes reads back as "open".
  setPolicyRaw(teamId: number, policy: string): Promise<void>;
  // A session's ids row naming its principal (what registerId writes).
  registerId(id: string, principal: string | null): Promise<void>;
  // Raw reads: every principal row in id order; an action's access_log rows in id order, detail parsed, with
  // detail_type the stored detail's JSON type as the database computes it (SQLite json_type, Postgres jsonb_typeof).
  // A stored object is "object" on both, so a detail written as a JSON string (a double stringify) fails a row that
  // asserts it, whatever the harness's parse makes of the value.
  principalRows(): Promise<{ kind: string; name: string; user_id: number | null; team_id: number | null }[]>;
  audits(action: string): Promise<{ actor: string | null; target: string | null; detail: unknown; detail_type: string | null }[]>;
  // SQLite only: runs a statement on the writer outside any transaction (a TEMP trigger).
  raw?(sql: string): void;
  close(): void | Promise<void>;
};

export type IdentityBackend = { kind: "sqlite" | "postgres"; open(): Promise<IdentityStore> };

const G = "https://accounts.google.com", OKTA = "https://example.okta.com";
const A = "a@example.com", B = "b@example.com", C = "c@example.com", D = "d@example.com";

export function identityContract(backend: IdentityBackend): void {
  const it = (name: string, fn: (h: IdentityStore) => Promise<void>) => test(name, async () => {
    const h = await backend.open();
    try { await fn(h); } finally { await h.close(); }
  });
  // A row whose interleaving only a SQLite trigger can force; `why` is in its name.
  const sqliteOnly = (name: string, why: string, fn: (h: IdentityStore) => Promise<void>) => {
    if (backend.kind === "sqlite") it(`${name} [SQLite only: ${why}]`, fn);
  };
  users(it, sqliteOnly);
  sessionsAndPrincipals(it);
  teams(it, sqliteOnly);
  roles(it);
  services(it);
}

type It = (name: string, fn: (h: IdentityStore) => Promise<void>) => void;

const upsert = (h: IdentityStore, email: string, name: string | null = null) => h.write(tx => h.users.upsertByEmail(tx, email, name));
const signIn = (h: IdentityStore, issuer: string, subject: string, email: string, name: string | null) =>
  h.write(tx => h.users.signIn(tx, issuer, subject, email, name));
// The error a body's call rejects with, caught inside the body so the write commits.
async function caught(f: () => Promise<unknown>): Promise<unknown> {
  try { await f(); } catch (e) { return e; }
  return undefined;
}

function users(it: It, sqliteOnly: (name: string, why: string, fn: (h: IdentityStore) => Promise<void>) => void): void {
  it("users.upsertByEmail creates the user and its principal; a repeat renames it", async h => {
    const u = await upsert(h, A, "Ada");
    expect(u).toMatchObject({ email: A, display_name: "Ada", disabled_at: null, idp_issuer: null, idp_subject: null, kind: "user" });
    expect(typeof u.id).toBe("number");
    expect(await h.principalRows()).toEqual([{ kind: "user", name: A, user_id: u.id, team_id: null }]);
    expect(await upsert(h, A, "Ada B")).toMatchObject({ id: u.id, display_name: "Ada B" });
    expect(await h.users.findById(h.read, u.id)).toEqual({ ...u, display_name: "Ada B" });
    expect(await h.users.findByEmail(h.read, A)).toEqual({ ...u, display_name: "Ada B" });
    expect(await h.principalRows()).toHaveLength(1);
    expect(await h.users.findByEmail(h.read, B)).toBeUndefined();
    expect(await h.users.findById(h.read, u.id + 1000)).toBeUndefined();
  });

  it("users.upsertByEmail: a service's name is PrincipalTaken, and a caller that catches it commits no rename", async h => {
    await h.write(tx => h.services.create(tx, "ingest"));
    const e = await h.write(tx => caught(() => h.users.upsertByEmail(tx, "ingest", "Person")));
    expect(e).toBeInstanceOf(PrincipalTaken);
    expect(await h.users.findByEmail(h.read, "ingest")).toMatchObject({ display_name: null, kind: "service" });
    expect((await h.principalRows()).map(p => p.kind)).toEqual(["service"]);
  });

  // Security audit F-13, #928 D4: users are matched by (issuer, subject) first, so a reassigned email can't inherit an
  // account, and one IdP's account never signs into another IdP's by email.
  it("users.signIn D4 branch 1: this (issuer, subject)'s user signs in, or is refused when its email changed", async h => {
    const u = await signIn(h, G, "s-1", A, "A");
    expect(await signIn(h, G, "s-1", A, "A 2")).toMatchObject({ status: "ok", linked: false, user: { id: u.user.id, display_name: "A 2" } });
    expect(await h.users.findById(h.read, u.user.id)).toMatchObject({ display_name: "A 2" });
    // The same IdP account reporting another email is refused, and no user is created.
    expect(await signIn(h, G, "s-1", "renamed@example.com", null)).toMatchObject({ status: "email_changed", user: { id: u.user.id } });
    expect(await h.users.findByEmail(h.read, "renamed@example.com")).toBeUndefined();
  });

  it("users.signIn D4 branch 2: another subject under the same issuer is subject_mismatch, and nothing changes", async h => {
    const u = (await signIn(h, G, "s-1", A, null)).user;
    expect(await signIn(h, G, "s-intruder", A, null)).toEqual({ status: "subject_mismatch", user: u });
    expect(await h.users.findById(h.read, u.id)).toEqual(u);
  });

  it("users.signIn D4 branch 3: an email another issuer holds, with or without a subject, is issuer_mismatch naming the holder", async h => {
    const linked = (await signIn(h, G, "s-1", A, null)).user;
    expect(await signIn(h, OKTA, "o-1", A, null)).toEqual({ status: "issuer_mismatch", user: linked, issuer: G });
    // A pre-F-13 row: Google's issuer, no subject. Reserved for Google.
    const legacy = await upsert(h, "old@example.com");
    await h.setIdp(legacy.id, G, null);
    expect(await signIn(h, OKTA, "o-2", "old@example.com", null)).toMatchObject({ status: "issuer_mismatch", user: { id: legacy.id, idp_subject: null }, issuer: G });
    expect(await h.users.findById(h.read, legacy.id)).toMatchObject({ idp_issuer: G, idp_subject: null });
  });

  it("users.signIn D4 branch 4: this issuer's subjectless row links", async h => {
    const legacy = await upsert(h, "old@example.com");
    await h.setIdp(legacy.id, G, null);
    expect(await signIn(h, G, "s-old", "old@example.com", "Old")).toMatchObject({ status: "ok", linked: true, user: { id: legacy.id, idp_issuer: G, idp_subject: "s-old", display_name: "Old" } });
    expect(await h.users.findById(h.read, legacy.id)).toMatchObject({ idp_issuer: G, idp_subject: "s-old", display_name: "Old" });
  });

  it("users.signIn D4 branch 5: a row with neither links to whichever issuer signs in first, both columns set", async h => {
    const dev = await upsert(h, "dev@example.com");
    expect(dev).toMatchObject({ idp_issuer: null, idp_subject: null });
    expect(await signIn(h, OKTA, "o-1", "dev@example.com", null)).toMatchObject({ status: "ok", linked: true, user: { id: dev.id, idp_issuer: OKTA, idp_subject: "o-1" } });
    expect(await h.users.findById(h.read, dev.id)).toMatchObject({ idp_issuer: OKTA, idp_subject: "o-1" });
    expect(await signIn(h, G, "s-1", "dev@example.com", null)).toMatchObject({ status: "issuer_mismatch", issuer: OKTA });
  });

  it("users.signIn D4 branch 6: no row creates the user with issuer and subject, and its principal", async h => {
    const r = await signIn(h, G, "s-new", "new@example.com", "New");
    expect(r).toMatchObject({ status: "ok", linked: false, user: { email: "new@example.com", idp_issuer: G, idp_subject: "s-new", display_name: "New" } });
    expect(await h.users.findByEmail(h.read, "new@example.com")).toMatchObject({ idp_issuer: G, idp_subject: "s-new" });
    expect(await h.principalRows()).toEqual([{ kind: "user", name: "new@example.com", user_id: r.user.id, team_id: null }]);
  });

  it("users.signIn: a service's name is refused as service, whatever the issuer, and stays unlinked", async h => {
    const svc = await h.write(tx => h.services.create(tx, "ingest"));
    expect(await signIn(h, G, "s-1", "ingest", "Person")).toMatchObject({ status: "service", user: { id: svc.id, kind: "service" } });
    expect(await h.users.findById(h.read, svc.id)).toMatchObject({ idp_issuer: null, idp_subject: null, display_name: null });
  });

  it("users.signIn: the same sub under two issuers is two users; one issuer can't hold a sub twice", async h => {
    const a = (await signIn(h, G, "same", A, null)).user;
    const b = (await signIn(h, OKTA, "same", B, null)).user;
    expect(a.id).not.toBe(b.id);
    expect(await signIn(h, OKTA, "same", B, null)).toMatchObject({ status: "ok", user: { id: b.id } });
    expect(await signIn(h, G, "same", A, null)).toMatchObject({ status: "ok", user: { id: a.id } });
    const c = await upsert(h, C);
    await expect(h.setIdp(c.id, G, "same")).rejects.toThrow(/unique/i);
  });

  it("users.clearSubject clears issuer and subject, so the next sign-in from any issuer takes the email", async h => {
    const u = (await signIn(h, G, "s-1", A, null)).user;
    await h.write(tx => h.users.clearSubject(tx, u.id));
    expect(await h.users.findById(h.read, u.id)).toMatchObject({ idp_issuer: null, idp_subject: null });
    expect(await signIn(h, OKTA, "o-1", A, null)).toMatchObject({ status: "ok", linked: true, user: { id: u.id, idp_issuer: OKTA, idp_subject: "o-1" } });
  });

  it("users.signIn: a disabled account without a subject isn't bound to whoever signs in", async h => {
    const departed = await upsert(h, "gone@example.com");
    await h.disable(departed.id);
    expect(await signIn(h, G, "s-hire", "gone@example.com", null)).toMatchObject({ status: "ok", linked: false, user: { id: departed.id } });
    expect(await h.users.findById(h.read, departed.id)).toMatchObject({ idp_issuer: null, idp_subject: null });
  });

  // D3: the link is a conditional write. A trigger links the row to another account between signIn's read and its
  // write (what a concurrent sign-in does on Postgres) and drops signIn's own update: signIn re-reads and refuses.
  // On Postgres, T-C3-5b (pg/identity.pg.test.ts) runs it with two connections (security audit F-13: one unlinked
  // email row, two sign-ins with different subjects), from the same issuer and from another.
  for (const [winner, status] of [[OKTA, "issuer_mismatch"], [G, "subject_mismatch"]] as const) {
    sqliteOnly(`users.signIn: a row linked between the read and the conditional write ends in ${status}, not a double link`, "a trigger forces the interleaving", async h => {
      const u = await upsert(h, "race@example.com");
      h.raw!(`CREATE TEMP TRIGGER race BEFORE UPDATE OF idp_subject ON users WHEN NEW.idp_subject = 's-mine' BEGIN
        UPDATE users SET idp_issuer = '${winner}', idp_subject = 's-theirs' WHERE id = OLD.id;
        SELECT RAISE(IGNORE);
      END`);
      expect(await signIn(h, G, "s-mine", "race@example.com", null)).toMatchObject({ status, user: { id: u.id, idp_issuer: winner, idp_subject: "s-theirs" } });
      expect(await h.users.findById(h.read, u.id)).toMatchObject({ idp_issuer: winner, idp_subject: "s-theirs" });
    });
  }
}

function sessionsAndPrincipals(it: It): void {
  it("sessions: create, find by token hash and id, revoke, touch", async h => {
    const { u, s } = await h.write(async tx => {
      const u = await h.users.upsertByEmail(tx, A, null);
      return { u, s: await h.sessions.create(tx, u.id, "hash123", "test") };
    });
    expect(s).toMatchObject({ user_id: u.id, token_hash: "hash123", label: "test", revoked_at: null });
    expect(typeof s.id).toBe("number");
    expect(await h.sessions.findByTokenHash(h.read, "hash123")).toEqual(s);
    expect(await h.sessions.findById(h.read, s.id)).toEqual(s);
    await h.write(tx => h.sessions.touch(tx, s.id, s.last_used_at + 5000));
    expect((await h.sessions.findById(h.read, s.id))?.last_used_at).toBe(s.last_used_at + 5000);
    await h.write(tx => h.sessions.revoke(tx, s.id));
    expect(await h.sessions.findByTokenHash(h.read, "hash123")).toBeUndefined();
    // By row, a revoked one still reads, with its revoked_at.
    expect((await h.sessions.findById(h.read, s.id))?.revoked_at).not.toBeNull();
    expect(await h.sessions.findById(h.read, s.id + 100)).toBeUndefined();
  });

  it("sessions.revokeDev revokes only live dev-labelled sessions and counts them", async h => {
    await h.write(async tx => {
      const u = await h.users.upsertByEmail(tx, A, null);
      await h.sessions.create(tx, u.id, "dev-1", "dev");
      await h.sessions.create(tx, u.id, "dev-2", "dev");
      await h.sessions.create(tx, u.id, "cli", null);
    });
    expect(await h.write(tx => h.sessions.revokeDev(tx))).toBe(2);
    expect(await h.write(tx => h.sessions.revokeDev(tx))).toBe(0);
    expect(await h.sessions.findByTokenHash(h.read, "dev-1")).toBeUndefined();
    expect(await h.sessions.findByTokenHash(h.read, "dev-2")).toBeUndefined();
    expect(await h.sessions.findByTokenHash(h.read, "cli")).toMatchObject({ label: null, revoked_at: null });
  });

  it("principals.findByName reads users, teams and services, ids as numbers; principals.of resolves addresses", async h => {
    const { u, eng, svc } = await h.write(async tx => {
      const u = await h.users.upsertByEmail(tx, A, null);
      return { u, eng: await h.teams.create(tx, "eng", u.id), svc: await h.services.create(tx, "ingest") };
    });
    const user = await h.principals.findByName(h.read, A);
    expect(user).toMatchObject({ kind: "user", name: A, user_id: u.id, team_id: null, parent_id: null });
    expect(typeof user!.id).toBe("number");
    expect(typeof user!.created_at).toBe("number");
    const team = await h.principals.findByName(h.read, "eng");
    expect(team).toMatchObject({ kind: "team", user_id: null, team_id: eng.id });
    expect(typeof team!.id).toBe("number");
    expect(await h.principals.findByName(h.read, "ingest")).toMatchObject({ kind: "service", user_id: svc.id, team_id: null });
    expect(await h.principals.findByName(h.read, "ops")).toBeUndefined();

    const id = "id:0123456789abc";
    await h.registerId(id, A);
    await h.registerId("id:0123456789abd", null);
    expect(await h.principals.of(h.read, id)).toEqual({ kind: "user", name: A });
    expect(await h.principals.of(h.read, "id:0123456789abd")).toBeNull();
    expect(await h.principals.of(h.read, "id:0123456789abe")).toBeNull();
    expect(await h.principals.of(h.read, `${A}/fe`)).toEqual({ kind: "user", name: A });
    expect(await h.principals.of(h.read, "eng/be")).toEqual({ kind: "team", name: "eng" });
    expect(await h.principals.of(h.read, "team:eng")).toEqual({ kind: "team", name: "eng" });
    expect(await h.principals.of(h.read, "ingest/worker")).toEqual({ kind: "service", name: "ingest" });
    // team:x names a team, never a service; a bare name acts for no one.
    expect(await h.principals.of(h.read, "team:ingest")).toBeNull();
    expect(await h.principals.of(h.read, `${B}/fe`)).toBeNull();
    expect(await h.principals.of(h.read, "fe")).toBeNull();
    // A person scope (an email) is only a user's, and a user's principal is reached only through one: a team named
    // with an email, and a user row whose email isn't one (an upsert of a bare name), act for no one under a scope.
    await h.write(tx => h.teams.create(tx, C, u.id));
    expect(await h.principals.findByName(h.read, C)).toMatchObject({ kind: "team" });
    expect(await h.principals.of(h.read, `${C}/fe`)).toBeNull();
    await upsert(h, "legacy");
    expect(await h.principals.findByName(h.read, "legacy")).toMatchObject({ kind: "user" });
    expect(await h.principals.of(h.read, "legacy/fe")).toBeNull();
  });
}

function teams(it: It, sqliteOnly: (name: string, why: string, fn: (h: IdentityStore) => Promise<void>) => void): void {
  // #284 decision 5, #807 P2-3 (D3): teams.create reads nothing first; the UNIQUE names refuse a taken one.
  it("teams.create: a user's, a team's or a service's name is PrincipalTaken, and the transaction goes on without its rows", async h => {
    const u = await upsert(h, A);
    await h.write(tx => h.services.create(tx, "ingest"));
    const { taken, ops } = await h.write(async tx => {
      await h.teams.create(tx, "eng", u.id);
      const taken = [await caught(() => h.teams.create(tx, "eng", u.id)), await caught(() => h.teams.create(tx, A, u.id)), await caught(() => h.teams.create(tx, "ingest", u.id))];
      return { taken, ops: await h.teams.create(tx, "ops", u.id) };
    });
    for (const e of taken) expect(e).toBeInstanceOf(PrincipalTaken);
    expect(await h.teams.findByName(h.read, A)).toBeUndefined();
    expect(await h.teams.findByName(h.read, "ingest")).toBeUndefined();
    expect(await h.teams.findByName(h.read, "ops")).toEqual(ops);
    expect(ops).toMatchObject({ name: "ops", created_by: u.id, policy: "open" });
    expect(await h.principalRows()).toEqual([
      { kind: "user", name: A, user_id: u.id, team_id: null },
      { kind: "service", name: "ingest", user_id: expect.any(Number), team_id: null },
      { kind: "team", name: "eng", user_id: null, team_id: (await h.teams.findByName(h.read, "eng"))!.id },
      { kind: "team", name: "ops", user_id: null, team_id: ops.id },
    ]);
    // Any other constraint is the caller's error, not a taken name.
    const missing = await h.write(tx => caught(() => h.teams.create(tx, "qa", u.id + 1000))).catch(e => e);
    expect(missing).toBeInstanceOf(Error);
    expect(missing).not.toBeInstanceOf(PrincipalTaken);
    expect(String(missing)).toMatch(/foreign key/i);
    expect(await h.teams.findByName(h.read, "qa")).toBeUndefined();
  });

  sqliteOnly("teams.create refuses a name another principal takes mid-create", "a trigger lands the principal inside the create", async h => {
    const u = await upsert(h, A);
    h.raw!(`CREATE TEMP TRIGGER land_ingest AFTER INSERT ON teams WHEN NEW.name = 'ingest'
      BEGIN INSERT INTO principals (kind, name, created_at) VALUES ('service', 'ingest', 0); END`);
    expect(await h.write(tx => caught(() => h.teams.create(tx, "ingest", u.id)))).toBeInstanceOf(PrincipalTaken);
    expect(await h.teams.findByName(h.read, "ingest")).toBeUndefined();
    expect((await h.principalRows()).filter(p => p.name === "ingest")).toEqual([]);
  });

  it("teams: addMember once, isMember, and the list reads in id order whatever the insert order", async h => {
    const { us, ts } = await h.write(async tx => {
      const us: User[] = [];
      for (const e of [A, B, C]) us.push(await h.users.upsertByEmail(tx, e, null));
      const ts = [];
      for (const n of ["t1", "t2", "t3"]) ts.push(await h.teams.create(tx, n, us[0]!.id));
      return { us, ts };
    });
    const [u1, u2, u3] = us as [User, User, User];
    const added = await h.write(async tx => [
      await h.teams.addMember(tx, ts[0]!.id, u3.id), await h.teams.addMember(tx, ts[0]!.id, u1.id), await h.teams.addMember(tx, ts[0]!.id, u2.id),
      await h.teams.addMember(tx, ts[2]!.id, u1.id), await h.teams.addMember(tx, ts[1]!.id, u1.id),
      await h.teams.addMember(tx, ts[0]!.id, u3.id),
    ]);
    expect(added).toEqual([true, true, true, true, true, false]);
    // On Postgres an UPDATE writes the row's new version at the end of the heap, so a scan with no ORDER BY now meets
    // u1 and t1 last: the id order below must come from the reads' ORDER BY. SQLite updates in place.
    await h.write(async tx => { await h.users.upsertByEmail(tx, A, "Ada"); await h.teams.setPolicy(tx, ts[0]!.id, "open"); });
    expect(await h.teams.isMember(h.read, ts[0]!.id, u2.id)).toBe(true);
    expect(await h.teams.isMember(h.read, ts[1]!.id, u2.id)).toBe(false);
    expect((await h.teams.listForUser(h.read, u1.id)).map(t => t.id)).toEqual(ts.map(t => t.id));
    expect(await h.teams.listForUser(h.read, u1.id)).toEqual(ts);
    expect(await h.teams.listForUser(h.read, u2.id)).toEqual([ts[0]]);
    expect(await h.teams.listMemberUserIds(h.read, ts[0]!.id)).toEqual([u1.id, u2.id, u3.id]);
    expect(await h.teams.listMembers(h.read, ts[0]!.id)).toEqual([
      { user_id: u1.id, email: A, role: "member" }, { user_id: u2.id, email: B, role: "member" }, { user_id: u3.id, email: C, role: "member" },
    ]);
    // A member's role is the team_owner binding's on this team: u1 owning t2 is still a member of t1.
    await h.write(async tx => {
      await grantRole(h, tx, { holder: B, role: "team_owner", scope: "t1" }, { email: A, userId: u1.id, authority: "none" });
      await grantRole(h, tx, { holder: A, role: "team_owner", scope: "t2" }, { email: A, userId: u1.id, authority: "none" });
    });
    expect((await h.teams.listMembers(h.read, ts[0]!.id)).map(m => m.role)).toEqual(["member", "owner", "member"]);
    expect(await h.teams.listMembers(h.read, ts[1]!.id)).toEqual([{ user_id: u1.id, email: A, role: "owner" }]);
  });

  it("teams.setPolicy returns the previous policy (one no setter writes reads as open), null for no team", async h => {
    const t = await h.write(async tx => h.teams.create(tx, "eng", (await h.users.upsertByEmail(tx, A, null)).id));
    expect(await h.write(tx => h.teams.setPolicy(tx, t.id, "collaborative"))).toBe("open");
    expect(await h.write(tx => h.teams.setPolicy(tx, t.id, "delegating"))).toBe("collaborative");
    expect((await h.teams.findByName(h.read, "eng"))?.policy).toBe("delegating");
    await h.setPolicyRaw(t.id, "bogus");
    expect(await h.write(tx => h.teams.setPolicy(tx, t.id, "open"))).toBe("open");
    expect((await h.teams.findByName(h.read, "eng"))?.policy).toBe("open");
    expect(await h.write(tx => h.teams.setPolicy(tx, t.id + 1000, "open"))).toBeNull();
  });

  it("teams.shareAny, shareCollaborative and shareDelegating follow the shared team's policy", async h => {
    const { a, b, c, t } = await h.write(async tx => {
      const [a, b, c] = [await h.users.upsertByEmail(tx, A, null), await h.users.upsertByEmail(tx, B, null), await h.users.upsertByEmail(tx, C, null)];
      const t = await h.teams.create(tx, "eng", a.id);
      await h.teams.addMember(tx, t.id, a.id);
      await h.teams.addMember(tx, t.id, b.id);
      return { a, b, c, t };
    });
    const share = async (x: number, y: number) => [
      await h.teams.shareAny(h.read, x, y), await h.teams.shareCollaborative(h.read, x, y), await h.teams.shareDelegating(h.read, x, y),
    ];
    expect(await share(a.id, b.id)).toEqual([true, false, false]);
    expect(await share(a.id, c.id)).toEqual([false, false, false]);
    await h.write(tx => h.teams.setPolicy(tx, t.id, "collaborative"));
    expect(await share(b.id, a.id)).toEqual([true, true, false]);
    await h.write(tx => h.teams.setPolicy(tx, t.id, "delegating"));
    expect(await share(a.id, b.id)).toEqual([true, true, true]);
    expect(await share(c.id, b.id)).toEqual([false, false, false]);
  });

  it("teams.removeMember revokes an owner's binding with its audit row; a non-owner goes with none", async h => {
    const { t, b } = await h.write(async tx => {
      const [a, b, c] = [await h.users.upsertByEmail(tx, A, null), await h.users.upsertByEmail(tx, B, null), await h.users.upsertByEmail(tx, C, null)];
      const t = await h.teams.create(tx, "eng", a.id);
      for (const u of [a, b, c]) await h.teams.addMember(tx, t.id, u.id);
      for (const e of [A, B]) await grantRole(h, tx, { holder: e, role: "team_owner", scope: "eng" }, { email: A, userId: a.id, authority: "none" });
      return { t, b, c };
    });
    const before = await h.roles.find(h.read, B, "team_owner", "eng");
    const revoked = await h.write(tx => h.teams.removeMember(tx, t.id, b.id, { byUser: null, authority: "none", actor: A, audit: { via: "test" } }));
    expect(revoked).toEqual(before!);
    expect(await h.roles.find(h.read, B, "team_owner", "eng")).toBeUndefined();
    expect((await h.teams.listMembers(h.read, t.id)).map(m => m.email)).toEqual([A, C]);
    expect(await h.audits("role.revoked")).toEqual([{ actor: A, target: B, detail_type: "object", detail: expect.objectContaining({ binding: before!.id, role: "team_owner", principal: B, scope: "eng", via: "test" }) }]);
    const c = (await h.users.findByEmail(h.read, C))!;
    expect(await h.write(tx => h.teams.removeMember(tx, t.id, c.id))).toBeNull();
    expect(await h.teams.listMemberUserIds(h.read, t.id)).toEqual([(await h.users.findByEmail(h.read, A))!.id]);
    expect(await h.audits("role.revoked")).toHaveLength(1);
    // A sole member may give up the last ownership: there's no one left to manage.
    const a = (await h.users.findByEmail(h.read, A))!;
    expect(await h.write(tx => h.teams.removeMember(tx, t.id, a.id))).toMatchObject({ principal: A, role: "team_owner" });
    expect(await h.teams.listMembers(h.read, t.id)).toEqual([]);
  });

  it("teams.removeMember of the last owner with members left is LastOwner, and a caller that catches it commits neither delete", async h => {
    const { t, a } = await h.write(async tx => {
      const [a, b] = [await h.users.upsertByEmail(tx, A, null), await h.users.upsertByEmail(tx, B, null)];
      const t = await h.teams.create(tx, "eng", a.id);
      await h.teams.addMember(tx, t.id, a.id);
      await h.teams.addMember(tx, t.id, b.id);
      await grantRole(h, tx, { holder: A, role: "team_owner", scope: "eng" }, { email: A, userId: a.id, authority: "none" });
      return { t, a };
    });
    const e = await h.write(tx => caught(() => h.teams.removeMember(tx, t.id, a.id)));
    expect(e).toBeInstanceOf(LastOwner);
    expect(e).toMatchObject({ scope: "eng", kind: "team" });
    expect(await h.teams.isMember(h.read, t.id, a.id)).toBe(true);
    expect(await h.roles.find(h.read, A, "team_owner", "eng")).toBeDefined();
    expect(await h.audits("role.revoked")).toEqual([]);
  });

  // Revocation is strict for membership (#807 P3 C3b audit M-1): the route decides before the write, and the store
  // re-checks the actor's binding in it. On Postgres T-C3-9 races the revoke against each.
  const asOwner = (u: User): MemberAuthority => ({ byUser: u.id, authority: "owner_or_admin" });
  const ownedEng = (h: IdentityStore) => h.write(async tx => {
    const us: User[] = [];
    for (const e of [A, B, C, D]) us.push(await h.users.upsertByEmail(tx, e, null));
    const [a, b, c] = us as [User, User, User];
    const t = await h.teams.create(tx, "eng", a.id);
    for (const u of [a, b, c]) await h.teams.addMember(tx, t.id, u.id);
    for (const e of [A, B]) await grantRole(h, tx, { holder: e, role: "team_owner", scope: "eng" }, { email: A, userId: a.id, authority: "none" });
    return { t, us: us as [User, User, User, User] };
  });

  it("teams.addMember re-checks its actor's authority: an owner or an admin adds, one whose binding is gone is AuthorityLost and adds no one", async h => {
    const { t, us: [a, b, c, d] } = await ownedEng(h);
    expect(await h.write(tx => h.teams.addMember(tx, t.id, d.id, asOwner(b)))).toBe(true);
    expect(await h.write(tx => h.teams.addMember(tx, t.id, d.id, asOwner(b)))).toBe(false);
    await h.write(tx => revokeRole(h, tx, { holder: B, role: "team_owner", scope: "eng" }, { email: A, userId: a.id, authority: "none" }, false));
    await h.write(tx => h.teams.removeMember(tx, t.id, d.id));
    // Caught in the body, which commits: a new member and an existing one alike.
    for (const u of [d, c]) expect(await h.write(tx => caught(() => h.teams.addMember(tx, t.id, u.id, asOwner(b))))).toBeInstanceOf(AuthorityLost);
    expect(await h.teams.listMemberUserIds(h.read, t.id)).toEqual([a.id, b.id, c.id]);
    // org_admin: refused while D holds none, then added once they do.
    const asAdmin: MemberAuthority = { byUser: d.id, authority: "org_admin" };
    expect(await h.write(tx => caught(() => h.teams.addMember(tx, t.id, d.id, asAdmin)))).toBeInstanceOf(AuthorityLost);
    await h.write(tx => grantRole(h, tx, { holder: D, role: "org_admin", scope: null }, { email: D, userId: d.id, authority: "none" }));
    expect(await h.write(tx => h.teams.addMember(tx, t.id, d.id, asAdmin))).toBe(true);
    expect(await h.write(tx => h.teams.addMember(tx, t.id, d.id, { byUser: d.id, authority: "owner_or_admin" }))).toBe(false);
  });

  it("teams.removeMember re-checks its actor's authority before any write: an owner may remove themselves, then is AuthorityLost and removes no one", async h => {
    const { t, us: [a, b, c] } = await ownedEng(h);
    // The revoke deletes the binding the authority rests on: read before it, the removal goes through.
    expect(await h.write(tx => h.teams.removeMember(tx, t.id, a.id, { ...asOwner(a), actor: A }))).toMatchObject({ principal: A, role: "team_owner" });
    expect(await h.teams.isMember(h.read, t.id, a.id)).toBe(false);
    for (const u of [b, c]) {
      expect(await h.write(tx => caught(() => h.teams.removeMember(tx, t.id, u.id, { ...asOwner(a), actor: A })))).toBeInstanceOf(AuthorityLost);
    }
    expect(await h.teams.listMemberUserIds(h.read, t.id)).toEqual([b.id, c.id]);
    expect(await h.roles.find(h.read, B, "team_owner", "eng")).toBeDefined();
    expect((await h.audits("role.revoked")).map(r => r.target)).toEqual([A]);
    expect(await h.write(tx => h.teams.removeMember(tx, t.id, c.id, { ...asOwner(b), actor: B }))).toBeNull();
    expect(await h.teams.listMemberUserIds(h.read, t.id)).toEqual([b.id]);
  });
}

// A fixture: an admin (org_admin through a bootstrap grant), alice and bob, team eng with alice a member.
async function cast(h: IdentityStore) {
  return h.write(async tx => {
    const admin = await h.users.upsertByEmail(tx, D, null);
    const alice = await h.users.upsertByEmail(tx, A, null);
    const bob = await h.users.upsertByEmail(tx, B, null);
    const eng = await h.teams.create(tx, "eng", admin.id);
    await h.teams.addMember(tx, eng.id, alice.id);
    const boot: Granter = { email: D, userId: admin.id, authority: "none" };
    const org = await grantRole(h, tx, { holder: D, role: "org_admin", scope: null }, boot);
    if (!("binding" in org)) throw new Error("cast: org_admin not granted");
    return { admin, alice, bob, eng, org: org.binding, asAdmin: { email: D, userId: admin.id, authority: "org_admin" } as Granter };
  });
}
const spec = (holder: string, role: RoleSpec["role"], scope: string | null): RoleSpec => ({ holder, role, scope });

function roles(it: It): void {
  it("roles.grant writes the binding and a role.granted row whose detail is an object; a repeat changes nothing", async h => {
    const { admin, alice, eng, org, asAdmin } = await cast(h);
    expect(org).toMatchObject({ principal: D, role: "org_admin", scope: null, scope_id: null, granter: D });
    const out = await h.write(tx => grantRole(h, tx, spec(A, "team_owner", "eng"), asAdmin, { as_admin: true }));
    expect(out).toMatchObject({ changed: true, binding: { principal: A, role: "team_owner", scope: "eng", granter: D } });
    const b = "binding" in out ? out.binding : undefined;
    if (!b) throw new Error("grant refused");
    expect(typeof b!.id).toBe("number");
    expect(await h.roles.find(h.read, A, "team_owner", "eng")).toEqual(b);
    expect(await h.roles.find(h.read, D, "org_admin", null)).toEqual(org);
    expect(await h.roles.find(h.read, A, "org_admin", null)).toBeUndefined();
    expect(await h.roles.find(h.read, A, "team_owner", null)).toBeUndefined();
    expect(await h.roles.bindingOf(h.read, admin.id, "org_admin", null)).toBe(org.id);
    expect(await h.roles.bindingOf(h.read, alice.id, "team_owner", eng.id)).toBe(b!.id);
    expect(await h.roles.bindingOf(h.read, alice.id, "team_owner", null)).toBeUndefined();
    expect(await h.roles.bindingOf(h.read, admin.id, "team_owner", eng.id)).toBeUndefined();
    const audits = await h.audits("role.granted");
    expect(audits).toEqual([
      { actor: D, target: D, detail_type: "object", detail: { binding: org.id, role: "org_admin", principal: D, principal_id: org.principal_id, scope: null, scope_id: null, granted_by: org.granted_by, granter: D, granted_at: org.granted_at } },
      { actor: D, target: A, detail_type: "object", detail: { binding: b!.id, role: "team_owner", principal: A, principal_id: b!.principal_id, scope: "eng", scope_id: b!.scope_id, granted_by: b!.granted_by, granter: D, granted_at: b!.granted_at, as_admin: true } },
    ]);
    // Held already: the binding, unchanged, and no second row.
    expect(await h.write(tx => grantRole(h, tx, spec(A, "team_owner", "eng"), asAdmin))).toEqual({ binding: b, changed: false });
    expect(await h.audits("role.granted")).toHaveLength(2);
  });

  it("roles.grant refusals: no such name, a holder or scope of the wrong kind, authority gone, an owner who isn't a member", async h => {
    const { bob, asAdmin } = await cast(h);
    await h.write(tx => h.services.create(tx, "ingest"));
    const grant = (s: RoleSpec, g: Granter = asAdmin) => h.write(tx => grantRole(h, tx, s, g));
    const refused = async (s: RoleSpec, status: number, code: string, message: RegExp, g?: Granter) =>
      expect(await grant(s, g)).toMatchObject({ refused: { status, code, message: expect.stringMatching(message) } });
    await refused(spec("nobody@example.com", "team_owner", "eng"), 404, "not_found", /no principal named "nobody@example.com"/);
    await refused(spec(A, "team_owner", "nope"), 404, "not_found", /no team named "nope"/);
    await refused(spec(A, "service_owner", "eng"), 404, "not_found", /no service named "eng"/);
    await refused(spec("eng", "team_owner", "eng"), 400, "bad_request", /held by a user, and "eng" is a team/);
    // An org role has no membership precondition, so only the holder-kind check in the grant's statement refuses this.
    await refused(spec("eng", "org_admin", null), 400, "bad_request", /"eng" is a team/);
    // service_invoke's holder list is empty: no principal matches it.
    await refused(spec(A, "service_invoke", "ingest"), 400, "bad_request", /no principal may hold service_invoke/);
    await refused(spec(A, "org_admin", null), 403, "forbidden", /no longer holds/, { email: B, userId: bob.id, authority: "org_admin" });
    await refused(spec(A, "team_owner", "eng"), 403, "forbidden", /no longer holds/, { email: B, userId: bob.id, authority: "owner_or_admin" });
    await refused(spec(B, "team_owner", "eng"), 409, "conflict", /isn't a member of team "eng"/);
    expect(await h.audits("role.granted")).toHaveLength(1);
    expect(await h.roles.list(h.read, {}, 0, 100)).toHaveLength(1);
    // A team owner's authority covers their own team.
    await grant(spec(A, "team_owner", "eng"));
    const alice = (await h.users.findByEmail(h.read, A))!;
    await h.write(async tx => h.teams.addMember(tx, (await h.teams.findByName(tx, "eng"))!.id, bob.id));
    expect(await grant(spec(B, "team_owner", "eng"), { email: A, userId: alice.id, authority: "owner_or_admin" })).toMatchObject({ changed: true });
  });

  it("roles.revoke deletes the binding and writes a role.revoked row carrying all of it", async h => {
    const { bob, eng, asAdmin } = await cast(h);
    await h.write(async tx => {
      await h.teams.addMember(tx, eng.id, bob.id);
      for (const e of [A, B]) await grantRole(h, tx, spec(e, "team_owner", "eng"), asAdmin);
    });
    const b = (await h.roles.find(h.read, B, "team_owner", "eng"))!;
    expect(await h.write(tx => revokeRole(h, tx, spec(B, "team_owner", "eng"), asAdmin, false, { as_admin: true }))).toEqual({ binding: b, changed: true });
    expect(await h.roles.find(h.read, B, "team_owner", "eng")).toBeUndefined();
    expect(await h.audits("role.revoked")).toEqual([{ actor: D, target: B, detail_type: "object", detail: {
      binding: b.id, role: "team_owner", principal: B, principal_id: b.principal_id, scope: "eng", scope_id: b.scope_id,
      granted_by: b.granted_by, granter: D, granted_at: b.granted_at, as_admin: true,
    } }]);
    expect(await h.write(tx => revokeRole(h, tx, spec(B, "team_owner", "eng"), asAdmin, false))).toMatchObject({ refused: { status: 404, code: "not_found" } });
    // The revoker's authority is re-checked in the write: bob holds no org_admin.
    expect(await h.write(tx => revokeRole(h, tx, spec(A, "team_owner", "eng"), { email: B, userId: bob.id, authority: "org_admin" }, false)))
      .toMatchObject({ refused: { status: 403, code: "forbidden" } });
    expect(await h.roles.find(h.read, A, "team_owner", "eng")).toBeDefined();
    expect(await h.write(tx => revokeRole(h, tx, spec(A, "team_owner", "nope"), asAdmin, false))).toMatchObject({ refused: { status: 404, message: expect.stringContaining("no team named") } });
    expect(await h.audits("role.revoked")).toHaveLength(1);
  });

  it("roles.revoke of a team's or service's last owner is LastOwner, and a caller that commits past it keeps the binding", async h => {
    const { bob, eng, asAdmin } = await cast(h);
    await h.write(async tx => {
      await h.teams.addMember(tx, eng.id, bob.id);
      await grantRole(h, tx, spec(A, "team_owner", "eng"), asAdmin);
      await h.services.create(tx, "ingest");
      await grantRole(h, tx, spec(A, "service_owner", "ingest"), asAdmin);
    });
    expect(await h.write(tx => revokeRole(h, tx, spec(A, "team_owner", "eng"), asAdmin, false)))
      .toMatchObject({ refused: { status: 409, code: "conflict", message: expect.stringContaining('last owner of team "eng"') } });
    expect(await h.write(tx => revokeRole(h, tx, spec(A, "service_owner", "ingest"), asAdmin, false)))
      .toMatchObject({ refused: { status: 409, code: "conflict", message: expect.stringContaining('service "ingest" must keep an owner') } });
    // The store's own refusal, caught by a caller that commits.
    const e = await h.write(tx => caught(() => h.roles.revoke(tx, { holder: A, role: "service_owner", scope: "ingest", byUser: null, authority: "none", actor: D })));
    expect(e).toMatchObject({ scope: "ingest", kind: "service" });
    expect(e).toBeInstanceOf(LastOwner);
    expect(await h.roles.find(h.read, A, "team_owner", "eng")).toBeDefined();
    expect(await h.roles.find(h.read, A, "service_owner", "ingest")).toBeDefined();
    expect(await h.audits("role.revoked")).toEqual([]);
  });

  it("roles.list filters by role, holder and scope name, in id order after a cursor, up to a limit", async h => {
    const { bob, eng, org, asAdmin } = await cast(h);
    await h.write(async tx => {
      await h.teams.addMember(tx, eng.id, bob.id);
      await h.services.create(tx, "ingest");
      await grantRole(h, tx, spec(B, "team_owner", "eng"), asAdmin);
      await grantRole(h, tx, spec(A, "service_owner", "ingest"), asAdmin);
      await grantRole(h, tx, spec(A, "team_owner", "eng"), asAdmin);
    });
    const all = await h.roles.list(h.read, {}, 0, 100);
    expect(all.map(b => [b.principal, b.role, b.scope])).toEqual([
      [D, "org_admin", null], [B, "team_owner", "eng"], [A, "service_owner", "ingest"], [A, "team_owner", "eng"],
    ]);
    expect(all[0]).toEqual(org);
    const ids = all.map(b => b.id);
    expect(ids).toEqual([...ids].sort((x, y) => x - y));
    const names = (bs: { principal: string; role: string }[]) => bs.map(b => `${b.principal} ${b.role}`);
    expect(names(await h.roles.list(h.read, { role: "team_owner" }, 0, 100))).toEqual([`${B} team_owner`, `${A} team_owner`]);
    expect(names(await h.roles.list(h.read, { principal: A }, 0, 100))).toEqual([`${A} service_owner`, `${A} team_owner`]);
    expect(names(await h.roles.list(h.read, { scope: "eng" }, 0, 100))).toEqual([`${B} team_owner`, `${A} team_owner`]);
    expect(names(await h.roles.list(h.read, { role: "team_owner", principal: A, scope: "eng" }, 0, 100))).toEqual([`${A} team_owner`]);
    expect(await h.roles.list(h.read, { scope: "ingest", role: "team_owner" }, 0, 100)).toEqual([]);
    expect(await h.roles.list(h.read, {}, ids[1]!, 2)).toEqual(all.slice(2, 4));
    expect(await h.roles.list(h.read, {}, 0, 1)).toEqual([org]);
  });

  it("authorize reads the identity groups: team.manage, admin and msg.wake decision on bindings, membership and policy", async h => {
    const { admin, alice, bob, eng, org, asAdmin } = await cast(h);
    const owner = await h.write(async tx => {
      await h.teams.addMember(tx, eng.id, bob.id);
      return grantRole(h, tx, spec(A, "team_owner", "eng"), asAdmin);
    });
    const ownerId = "binding" in owner ? owner.binding.id : -1;
    const team = (await h.teams.findByName(h.read, "eng"))!;
    const as = (u: User) => ({ id: u.id, email: u.email, kind: u.kind });
    const decision = (req: AuthzRequest) => authorize(h, h.read, {}, req);
    expect(await decision({ verb: "team.manage", user: as(alice), team })).toMatchObject({ allow: true, rule: "role.team_owner", binding: ownerId });
    expect(await decision({ verb: "team.manage", user: as(bob), team })).toMatchObject({ allow: false, rule: "role.team_owner", code: "forbidden" });
    expect(await decision({ verb: "team.manage", user: as(admin), team })).toMatchObject({ allow: true, rule: "role.org_admin", binding: org.id });
    expect(await decision({ verb: "admin", user: as(admin) })).toMatchObject({ allow: true, rule: "role.org_admin" });
    expect(await decision({ verb: "admin", user: as(alice) })).toMatchObject({ allow: false, code: "forbidden" });
    expect(await decision({ verb: "msg.wake", from_user: A, to_user: B })).toMatchObject({ allow: false, rule: "wake.cross_user" });
    await h.write(tx => h.teams.setPolicy(tx, eng.id, "collaborative"));
    expect(await decision({ verb: "msg.wake", from_user: A, to_user: B })).toMatchObject({ allow: true, rule: "wake.team_policy" });
  });
}

function services(it: It): void {
  it("services.create makes a service user and principal; a user's, team's or service's name is PrincipalTaken", async h => {
    const { u } = await h.write(async tx => {
      const u = await h.users.upsertByEmail(tx, A, null);
      await h.teams.create(tx, "eng", u.id);
      return { u };
    });
    const svc = await h.write(tx => h.services.create(tx, "ingest"));
    expect(svc).toMatchObject({ email: "ingest", display_name: null, disabled_at: null, idp_issuer: null, idp_subject: null, kind: "service" });
    expect(typeof svc.id).toBe("number");
    const { taken, other } = await h.write(async tx => ({
      taken: [await caught(() => h.services.create(tx, A)), await caught(() => h.services.create(tx, "eng")), await caught(() => h.services.create(tx, "ingest"))],
      other: await h.services.create(tx, "other"),
    }));
    for (const e of taken) expect(e).toBeInstanceOf(PrincipalTaken);
    expect(await h.users.findByEmail(h.read, "eng")).toBeUndefined();
    expect(await h.users.findByEmail(h.read, A)).toMatchObject({ id: u.id, kind: "user" });
    expect((await h.principalRows()).map(p => `${p.kind} ${p.name}`)).toEqual([`user ${A}`, "team eng", "service ingest", "service other"]);
    expect(await h.users.findById(h.read, other.id)).toEqual(other);
  });

  it("services.list shows owners in name order and disabled services; orphanedBy names services left with no enabled owner", async h => {
    const { alice, bob, asAdmin } = await cast(h);
    const [ingest, other] = await h.write(async tx => {
      const s = [await h.services.create(tx, "ingest"), await h.services.create(tx, "other")];
      await grantRole(h, tx, spec(B, "service_owner", "ingest"), asAdmin);
      await grantRole(h, tx, spec(A, "service_owner", "ingest"), asAdmin);
      await grantRole(h, tx, spec(A, "service_owner", "other"), asAdmin);
      return s;
    });
    const list = await h.services.list(h.read, 0, 100);
    expect(list).toEqual([
      { id: expect.any(Number), name: "ingest", created_at: ingest!.created_at, disabled_at: null, owners: [A, B] },
      { id: expect.any(Number), name: "other", created_at: other!.created_at, disabled_at: null, owners: [A] },
    ]);
    expect(list[0]!.id).toBeLessThan(list[1]!.id);
    expect(await h.services.list(h.read, list[0]!.id, 100)).toEqual([list[1]]);
    expect(await h.services.list(h.read, 0, 1)).toEqual([list[0]]);
    expect(await h.services.orphanedBy(h.read, alice.id)).toEqual([]);
    await h.disable(alice.id);
    expect(await h.services.orphanedBy(h.read, alice.id)).toEqual(["other"]);
    await h.disable(bob.id);
    expect(await h.services.orphanedBy(h.read, alice.id)).toEqual(["ingest", "other"]);
    expect(await h.services.orphanedBy(h.read, bob.id)).toEqual(["ingest"]);
    await h.disable(ingest!.id);
    expect((await h.services.list(h.read, 0, 100))[0]!.disabled_at).toEqual(expect.any(Number));
    // Read on a write's Tx too: the groups take either handle.
    expect(await h.write(tx => h.services.orphanedBy(tx, alice.id))).toEqual(["ingest", "other"]);
  });
}
