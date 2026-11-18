// #807 P3 C3b: the identity store's races on Postgres, each in T-P12's shape (tx.pg.test.ts): two stores on one
// database, the first body runs to a gate and holds its transaction open, the second starts, and the test waits until
// the second is either blocked on a lock (pg_stat_activity) or done, then releases the first and checks the end state.
// The end state is asserted before the wait, so a race whose lock or savepoint is gone fails on what it broke (zero
// owners, an owner who isn't a member, a stray user), not on a timeout. Without GRAYBOARD_TEST_PG_URL they skip.
import { expect, test } from "bun:test";
import { describePg, pgDatabase, type PgDatabase } from "../../../../tests/support/pg.ts";
import { until } from "../../../../tests/support/until.ts";
import { grantRole, revokeRole, type Granter, type RoleSpec, type RoleStores } from "../../roles.ts";
import { LastOwner, PrincipalTaken } from "../errors.ts";
import type { User } from "../identity.ts";
import type { Tx } from "../tx_base.ts";
import { makePgIdentity, type PgIdentity } from "./identity.ts";
import { makePgTransactions, TxAborted, type PgTransactions } from "./tx.ts";

const G = "https://accounts.google.com", OKTA = "https://example.okta.com";
const A = "a@example.com", B = "b@example.com", C = "c@example.com", D = "d@example.com";
const NONE = (u: User): Granter => ({ email: u.email, userId: u.id, authority: "none" });
const spec = (holder: string, role: RoleSpec["role"], scope: string | null): RoleSpec => ({ holder, role, scope });

type Pair = { db: PgDatabase; a: PgTransactions; b: PgTransactions; g: PgIdentity; [Symbol.asyncDispose](): Promise<void> };

async function pair(): Promise<Pair> {
  const db = await pgDatabase({ max: 2 });
  const a = makePgTransactions(db.url, { max: 2, applicationName: "gb-test-a" });
  const b = makePgTransactions(db.url, { max: 2, applicationName: "gb-test-b" });
  return {
    db, a, b, g: makePgIdentity({ now: Date.now }),
    async [Symbol.asyncDispose]() { await a.close(); await b.close(); await db[Symbol.asyncDispose](); },
  };
}

function gate(): { wait: Promise<void>; open(): void } {
  let open!: () => void;
  const wait = new Promise<void>(r => { open = r; });
  return { wait, open };
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: any };
const settle = <T>(p: Promise<T>): Promise<Settled<T>> => p.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));

// `first` runs on store A and holds its transaction open after its body; `second` runs on store B. `waited`: B was
// seen blocked on a lock while A held.
async function race<TA, TB>(p: Pair, first: (tx: Tx) => Promise<TA>, second: (tx: Tx) => Promise<TB>): Promise<{ a: Settled<TA>; b: Settled<TB>; waited: boolean }> {
  const held = gate(), release = gate();
  const a = settle(p.a.write(async tx => { const v = await first(tx); held.open(); await release.wait; return v; }));
  // A body that fails before holding settles A instead.
  await Promise.race([held.wait, a]);
  let done = false, waited = false;
  const b = settle(p.b.write(second)).finally(() => { done = true; });
  await until(async () => {
    if ((await p.db.sql`SELECT 1 FROM pg_stat_activity WHERE application_name = 'gb-test-b' AND wait_event_type = 'Lock'`).length > 0) waited = true;
    return waited || done;
  }, 5000, "B blocked on a lock, or settled");
  release.open();
  return { a: await a, b: await b, waited };
}

async function caught(f: () => Promise<unknown>): Promise<unknown> {
  try { await f(); } catch (e) { return e; }
  return undefined;
}

// Users by email, in one write.
const users = (p: Pair, ...emails: string[]) => p.a.write(async tx => {
  const out: User[] = [];
  for (const e of emails) out.push(await p.g.users.upsertByEmail(tx, e, null));
  return out;
});

// Team eng with these members, the first `owners` of them team owners.
async function team(p: Pair, members: User[], owners: number) {
  return p.a.write(async tx => {
    const t = await p.g.teams.create(tx, "eng", members[0]!.id);
    for (const u of members) await p.g.teams.addMember(tx, t.id, u.id);
    for (const u of members.slice(0, owners)) await grantRole(p.g, tx, spec(u.email, "team_owner", "eng"), NONE(members[0]!));
    return t;
  });
}

const holders = async (p: Pair, role: string, scope: string | null) =>
  (await p.g.roles.list(p.a.read, { role, ...(scope === null ? {} : { scope }) }, 0, 100)).map(b => b.principal);

describePg("identity races (Postgres)", () => {
  test("T-C3-1 last team owner: two revokes of the two owners, other members present, leave one owner; the second is LastOwner", async () => {
    await using p = await pair();
    const [a, b, c] = await users(p, A, B, C);
    await team(p, [a!, b!, c!], 2);
    const revoke = (holder: string) => (tx: Tx) => p.g.roles.revoke(tx, { holder, role: "team_owner", scope: "eng", byUser: null, authority: "none", actor: D });
    const r = await race(p, revoke(A), revoke(B));
    expect(r.a).toMatchObject({ ok: true, value: { principal: A } });
    expect(r.b.ok ? r.b.value : r.b.error).toBeInstanceOf(LastOwner);
    expect(await holders(p, "team_owner", "eng")).toEqual([B]);
    expect(r.waited).toBe(true);
  });

  test("T-C3-2 last service owner: two revokes of the two owners leave one; the second is LastOwner", async () => {
    await using p = await pair();
    const [a] = await users(p, A, B);
    await p.a.write(async tx => {
      await p.g.services.create(tx, "ingest");
      for (const e of [A, B]) await grantRole(p.g, tx, spec(e, "service_owner", "ingest"), NONE(a!));
    });
    const revoke = (holder: string) => (tx: Tx) => p.g.roles.revoke(tx, { holder, role: "service_owner", scope: "ingest", byUser: null, authority: "none", actor: D });
    const r = await race(p, revoke(A), revoke(B));
    expect(r.a).toMatchObject({ ok: true, value: { principal: A } });
    expect(r.b.ok ? r.b.value : r.b.error).toMatchObject({ kind: "service", scope: "ingest" });
    expect(await holders(p, "service_owner", "ingest")).toEqual([B]);
    expect(r.waited).toBe(true);
  });

  test("T-C3-3 mutual org_admin revoke: each admin revoking the other leaves exactly one admin, the second refused 403, no deadlock", async () => {
    await using p = await pair();
    const [x, y] = await users(p, D, A);
    await p.a.write(async tx => {
      for (const e of [D, A]) await grantRole(p.g, tx, spec(e, "org_admin", null), NONE(x!));
    });
    const asAdmin = (u: User): Granter => ({ email: u.email, userId: u.id, authority: "org_admin" });
    const r = await race(p,
      tx => revokeRole(p.g, tx, spec(A, "org_admin", null), asAdmin(x!), false),
      tx => revokeRole(p.g, tx, spec(D, "org_admin", null), asAdmin(y!), false));
    expect(r.a).toMatchObject({ ok: true, value: { changed: true } });
    // A deadlock (40P01) would reject B's write instead.
    expect(r.b).toMatchObject({ ok: true, value: { refused: { status: 403, code: "forbidden" } } });
    expect(await holders(p, "org_admin", null)).toEqual([D]);
    expect(r.waited).toBe(true);
  });

  for (const grantFirst of [true, false]) {
    test(`T-C3-4 owner grant vs member removal (${grantFirst ? "grant" : "removal"} first): never an owner who isn't a member`, async () => {
      await using p = await pair();
      const [o, y] = await users(p, D, A);
      const t = await team(p, [o!, y!], 1);
      const grant = (tx: Tx) => grantRole(p.g, tx, spec(A, "team_owner", "eng"), NONE(o!));
      const remove = (tx: Tx) => p.g.teams.removeMember(tx, t.id, y!.id, D);
      const r = grantFirst ? await race(p, grant, remove) : await race(p, remove, grant);
      const member = await p.g.teams.isMember(p.a.read, t.id, y!.id);
      const owner = (await holders(p, "team_owner", "eng")).includes(A);
      expect({ owner, member }).toEqual({ owner: false, member: false });
      const [g, rm] = grantFirst ? [r.a, r.b] : [r.b, r.a];
      if (grantFirst) {
        expect(g).toMatchObject({ ok: true, value: { changed: true } });
        // The removal waited for the grant, then revoked the binding it made.
        expect(rm).toMatchObject({ ok: true, value: { principal: A, role: "team_owner" } });
      } else {
        expect(rm).toMatchObject({ ok: true, value: null });
        expect(g).toMatchObject({ ok: true, value: { refused: { status: 409, code: "conflict" } } });
      }
      expect(r.waited).toBe(true);
    });
  }

  test("T-C3-5 two emails linking one (issuer, subject): the second gets email_changed and leaves no user or principal", async () => {
    await using p = await pair();
    const r = await race(p, tx => p.g.users.signIn(tx, G, "sub", A, null), tx => p.g.users.signIn(tx, G, "sub", B, null));
    expect(r.a).toMatchObject({ ok: true, value: { status: "ok", user: { email: A, idp_subject: "sub" } } });
    const a = r.a.ok ? r.a.value.user : undefined;
    expect(r.b).toMatchObject({ ok: true, value: { status: "email_changed", user: { id: a?.id, email: A } } });
    expect(await p.g.users.findByEmail(p.a.read, B)).toBeUndefined();
    expect(await p.g.principals.findByName(p.a.read, B)).toBeUndefined();
    expect(r.waited).toBe(true);
  });

  // Security audit F-13 (C3a audit M-1): one unlinked row, two sign-ins with its email. B's link waits on A's row
  // lock, then re-checks `idp_subject IS NULL` on A's committed row and matches nothing; the re-read refuses.
  for (const [issuer, status] of [[G, "subject_mismatch"], [OKTA, "issuer_mismatch"]] as const) {
    test(`T-C3-5b one unlinked row, A links it from ${issuer === G ? "Google" : "Okta"} while B links it from Google: B gets ${status}, the row keeps A's link`, async () => {
      await using p = await pair();
      const [u] = await users(p, "race@example.com");
      const r = await race(p,
        tx => p.g.users.signIn(tx, issuer, "s-A", "race@example.com", null),
        tx => p.g.users.signIn(tx, G, "s-B", "race@example.com", null));
      expect(r.a).toMatchObject({ ok: true, value: { status: "ok", linked: true } });
      expect(r.b).toMatchObject({ ok: true, value: { status, user: { id: u!.id, idp_issuer: issuer, idp_subject: "s-A" } } });
      expect(await p.g.users.findById(p.a.read, u!.id)).toMatchObject({ idp_issuer: issuer, idp_subject: "s-A" });
      expect(r.waited).toBe(true);
    });
  }

  test("T-C3-6 two teams.create of one name: the second is PrincipalTaken and its transaction goes on", async () => {
    await using p = await pair();
    const [u] = await users(p, A);
    const r = await race(p,
      tx => p.g.teams.create(tx, "eng", u!.id),
      async tx => ({ taken: await caught(() => p.g.teams.create(tx, "eng", u!.id)), next: await p.g.teams.create(tx, "ops", u!.id) }));
    expect(r.a).toMatchObject({ ok: true, value: { name: "eng" } });
    if (!r.b.ok) expect(r.b.error).not.toBeInstanceOf(TxAborted);
    expect(r.b).toMatchObject({ ok: true, value: { next: { name: "ops" } } });
    expect(r.b.ok && r.b.value.taken).toBeInstanceOf(PrincipalTaken);
    expect((await p.g.teams.findByName(p.a.read, "eng"))?.id).toBe(r.a.ok ? r.a.value.id : -1);
    expect(r.waited).toBe(true);
  });

  test("T-C3-7 two setPolicy calls: the second returns the first's policy as previous", async () => {
    await using p = await pair();
    const [u] = await users(p, A);
    const t = await p.a.write(tx => p.g.teams.create(tx, "eng", u!.id));
    const r = await race(p, tx => p.g.teams.setPolicy(tx, t.id, "collaborative"), tx => p.g.teams.setPolicy(tx, t.id, "delegating"));
    expect(r.a).toEqual({ ok: true, value: "open" });
    expect(r.b).toEqual({ ok: true, value: "collaborative" });
    expect((await p.g.teams.findByName(p.a.read, "eng"))?.policy).toBe("delegating");
    expect(r.waited).toBe(true);
  });

  test("T-C3-8 upsertByEmail racing services.create of the name: PrincipalTaken, and the service keeps a null display name", async () => {
    await using p = await pair();
    const r = await race(p,
      tx => p.g.services.create(tx, "svc"),
      // A caller that catches the refusal and commits, as http.ts and idp.ts do.
      tx => caught(() => p.g.users.upsertByEmail(tx, "svc", "Person")));
    expect(r.a).toMatchObject({ ok: true, value: { email: "svc", kind: "service" } });
    expect(r.b.ok && r.b.value).toBeInstanceOf(PrincipalTaken);
    expect(await p.g.users.findByEmail(p.a.read, "svc")).toMatchObject({ display_name: null, kind: "service" });
    expect((await p.g.principals.findByName(p.a.read, "svc"))?.kind).toBe("service");
    expect(r.waited).toBe(true);
  });

  // Decision 5 (R6): grantRole's follow-up reads run on newer snapshots than its grant statement. A membership that
  // commits between them makes every read pass; the grant runs once more and writes, rather than answering a stale 409
  // or throwing "wrote nothing, for no reason a read finds".
  test("T-C3-R6 a membership committed between the grant's statement and its follow-up reads: the retry grants", async () => {
    await using p = await pair();
    const [o, y] = await users(p, D, A);
    const t = await team(p, [o!], 1);
    let landed = false;
    const stores: RoleStores = {
      ...p.g,
      roles: {
        ...p.g.roles,
        async grant(tx, g) {
          const b = await p.g.roles.grant(tx, g);
          if (!b && !landed) {
            landed = true;
            await p.b.write(tx2 => p.g.teams.addMember(tx2, t.id, y!.id));
          }
          return b;
        },
      },
    };
    const out = await p.a.write(tx => grantRole(stores, tx, spec(A, "team_owner", "eng"), NONE(o!)));
    expect(landed).toBe(true);
    expect(out).toMatchObject({ changed: true, binding: { principal: A, role: "team_owner", scope: "eng" } });
    expect(await holders(p, "team_owner", "eng")).toEqual([D, A]);
  });
});
