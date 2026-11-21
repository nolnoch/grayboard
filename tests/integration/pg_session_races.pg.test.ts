// #807 P3 C11a: session races on Postgres through a real server (tests/support/pg_server.ts, its pool gb-test-b): the
// store-level E3/E4 and the writes_as/bind race of src/server/session_end.pg.test.ts and C10a-b, with one side a real
// request. One server can't race itself (one write queue), so the other side is a separate store on the server's
// database (A, gb-test-a) running the server's own composed code over its Repo (`srv.app.repo`) on A's Tx, as a second
// pod would. In tests/support/pg_race.ts raceRequest's shape: A holds its transaction open, the request runs until it
// is blocked on a lock or settles, then A commits. The end state is asserted before `waited`, so a race whose lock is
// gone fails on what it broke (a hold or a child on an ended session, two users on one alias), not on a timeout.
// Without GRAYBOARD_TEST_PG_URL they skip.
import { expect, setDefaultTimeout, test } from "bun:test";
import { SubscriberError } from "../../adapters/hosted-core/src/wire.ts";
import { boardAccess } from "../../src/server/access.ts";
import { ApplicationError } from "../../src/server/application.ts";
import { verifySessionToken } from "../../src/server/auth.ts";
import type { Repo } from "../../src/server/db.ts";
import { endSessionServer } from "../../src/server/session_end.ts";
import { pgCoreAuditSink } from "../../src/server/store/pg/audit.ts";
import { makePgTransactions } from "../../src/server/store/pg/tx.ts";
import type { Tx } from "../../src/server/store/tx_base.ts";
import { describePg } from "../support/pg.ts";
import { blockedOrSettled, committed, gate, holdCall, outcome, raceRequest, settle, type Settled } from "../support/pg_race.ts";
import { pgServers } from "../support/pg_server.ts";
import type { TestServer } from "../support/server.ts";

// Above the pool's 5 s lock_timeout (pg/tx.ts), so a wait a broken lock leaves fails 55P03 or 40P01, not on Bun's timeout.
setDefaultTimeout(30_000);

type Row = Record<string, unknown>;
const W = "w@example.com", B = "b@example.com";
const LEAD = "ops/lead";
const LIMITS = { hostedRequestLimit: { burst: 10_000, perSec: 10_000 } };

// One server on side b, and A: a store on its database labelled gb-test-a, closed before the server and the drop.
async function world() {
  const pg = await pgServers(1, { sides: ["b"], overrides: LIMITS });
  const a = makePgTransactions(pg.db.url, { max: 2, applicationName: "gb-test-a" });
  const srv = pg.servers[0]!;
  return {
    pg, a, p: { db: pg.db, a }, srv, repo: srv.app.repo, sql: pg.db.sql,
    async [Symbol.asyncDispose]() { try { await a.close(); } finally { await pg[Symbol.asyncDispose](); } },
  };
}

const end = (repo: Repo, id: string) => (tx: Tx) => {
  const now = Date.now();
  return endSessionServer(repo, boardAccess(repo, "team"), tx, id, { why: "revoked", now, audit: pgCoreAuditSink(tx, now) });
};

// A refusal's code: an application session's ApplicationError, a subscriber tool's SubscriberError.
const refused = (s: Settled<unknown>) =>
  !s.ok && (s.error instanceof ApplicationError || s.error instanceof SubscriberError) ? `refused ${s.error.code}` : outcome(s);

// A hosted session's ID, from the raw session ID its client sent.
const hostedId = async (w: { repo: Repo }, raw: string) => (await w.repo.hosted.all(w.repo.read)).find(h => h.source_session_id === raw)!.session_id;

const authedOf = async (srv: TestServer, token: string) => (await verifySessionToken(token, srv.app.repo, srv.app.touches, 0, 0))!;

describePg("session end races through the server (Postgres)", () => {
  // E4 through the server, end first: an ID's end (revoke's endIdsIn runs endSessionServer, held on A) against that
  // session's own bind request. Mutation: take without its lockLive (pg/bindings.ts; the hold lands on the ended ID and
  // outlives it). The reverse order has no request to drive it: an ID's end is never a request of its own (startup's
  // leftovers and a revoke's endIdsIn), and session_end.pg.test.ts E4 covers it at the store.
  test("E4: a session's bind while its ID's end is in flight waits on the ids row, then takes nothing", async () => {
    await using w = await world();
    const s = await w.srv.connected(await w.srv.login(W), "be");
    const r = await raceRequest(w.p, end(w.repo, s.id), () => s.bind("fe"));
    expect(committed(r.a)).toMatchObject({ ended: true, held: [`${W}/be`] });
    // take answers null on the ended ID, and the bind names the end, not a holder.
    expect(refused(r.b)).toBe("refused id_ended");
    expect(await w.sql`SELECT address, id FROM alias_holds`).toEqual([]);
    expect((await w.sql`SELECT ended_at FROM ids WHERE id = ${s.id}`)[0]!.ended_at).not.toBeNull();
    expect(r.waited).toBe(true);
  });

  // E3's server shape. No server path registers a child under an ids-level root (registerId's rootId is the local
  // mode's): a hosted child registers through its root's session_register, and a hosted root's ID is never ended (its
  // ownership is the store's), so the root's end here is the hosted store's (store/pg/hosted.ts end), on A. End first:
  // the request's own settle (hosted.ts withGate) waits on the root's row, then starts the root a new ownership, and
  // the child registers under that one. No mutation of its own (no lock here decides it; the next test's does): it
  // pins that no child lands under the ended ownership.
  test("E3: a root's session_register behind its ownership's end waits, then registers under a new ownership, never the ended one", async () => {
    await using w = await world();
    const root = await w.srv.hosted(W, "be");
    const R = await hostedId(w, root.sessionId);
    const old = (await w.repo.hosted.get(w.repo.read, R))!.ownership_id;
    const r = await raceRequest(w.p, tx => w.repo.hosted.end(tx, R, "closed", Date.now()), () => root.subscriber.call("session_register", { child: "kid-1" }));
    expect(committed(r.a)).toBe(true);
    const child = await hostedId(w, "kid-1");
    expect(outcome(r.b)).toEqual({ message: "registered", child, root: R });
    const rows = await w.sql`SELECT session_id, ownership_id::int8 AS own, root_session_id FROM hosted_sessions ORDER BY root_session_id NULLS FIRST`;
    expect(rows.map((x: Row) => x.own)).not.toContain(String(old));
    expect(rows.map((x: Row) => [x.session_id, x.root_session_id])).toEqual([[R, null], [child, R]]);
    expect((await w.sql`SELECT ended_at FROM hosted_ownerships WHERE id = ${old}`)[0]!.ended_at).not.toBeNull();
    expect(r.waited).toBe(true);
  });

  // The end lands inside the registration: the request is held at its transaction's first grant read (after it read
  // the root's ownership), the end commits on A, and the registration's root lock waits for it. Mutation: register
  // without its ownership check (hosted.ts `root.ownership_id !== before.ownership_id`: rowFor re-creates the ended root
  // under a new ownership and the child registers there, though the request was made under the ended one).
  test("E3: an ownership's end between a session_register's read of its root and its root lock: the lock waits, then the registration is refused", async () => {
    await using w = await world();
    const root = await w.srv.hosted(W, "be");
    const R = await hostedId(w, root.sessionId);
    // The request's second grantLive is its registration body's (the first is its settle's).
    const held = holdCall(w.repo.hosted, "grantLive", { skip: 1 });
    const ended = gate(), release = gate();
    let done = false, waitEvent: string | null = null, a: Promise<Settled<boolean>> | undefined;
    const b = settle(root.subscriber.call("session_register", { child: "kid-1" })).finally(() => { done = true; });
    try {
      await Promise.race([held.reached, b]);
      a = settle(w.a.write(async tx => {
        const v = await w.repo.hosted.end(tx, R, "closed", Date.now());
        ended.open();
        await release.wait;
        return v;
      }));
      await Promise.race([ended.wait, a]);
      held.open();
      waitEvent = await blockedOrSettled(w.pg, () => done, "the registration blocked on the root's row, or settled");
    } finally {
      held.open();
      release.open();
      held.undo();
    }
    expect(committed(await a!)).toBe(true);
    // hosted.ts register: "session binding changed; select the current binding again".
    expect(refused(await b)).toBe("refused unbound");
    expect(await w.sql`SELECT session_id FROM hosted_sessions WHERE root_session_id IS NOT NULL`).toEqual([]);
    expect(await w.sql`SELECT id FROM ids WHERE root_id IS NOT NULL`).toEqual([]);
    expect(waitEvent).not.toBeNull();
  });
});

describePg("writes_as against bind through the server (Postgres, C10a Q4)", () => {
  // W and B both in team ops, whose alias ops/lead exists (so neither side's lazy create is what serializes them).
  async function team(w: Awaited<ReturnType<typeof world>>) {
    const tw = await w.srv.login(W), tb = await w.srv.login(B);
    const [aw, ab] = [await authedOf(w.srv, tw), await authedOf(w.srv, tb)];
    await w.repo.write(async tx => {
      const t = await w.repo.teams.create(tx, "ops", aw.user_id);
      await w.repo.teams.addMember(tx, t.id, aw.user_id);
      await w.repo.teams.addMember(tx, t.id, ab.user_id);
    });
    await w.sql`INSERT INTO aliases (address, scope_kind, scope_ref, name, created_at, last_seen) VALUES (${LEAD}, 'team', 'ops', 'lead', 0, 0)`;
    return { tw, tb, aw, ab };
  }
  const users = async (w: Awaited<ReturnType<typeof world>>) => ({
    holds: (await w.sql`SELECT h.id, i.principal FROM alias_holds h JOIN ids i ON i.id = h.id WHERE h.address = ${LEAD}`) as Row[],
    writers: (await w.sql`SELECT id, principal FROM ids WHERE writes_as = ${LEAD} AND ended_at IS NULL`) as Row[],
  });

  // A tools-only root's registration first (rowFor's create path: hostedWritesAs under the alias's "use" lock, then
  // hostedRegister writing ids.writes_as), held on A; B's real bind of the same name. Mutation: take without its
  // aliases.lock (pg/bindings.ts; the bind's userOf reads before A commits, and W writes as ops/lead while B holds it).
  test("a bind of a name a tools-only root of another user is registering as: the bind waits, then is refused", async () => {
    await using w = await world();
    const { tb, aw } = await team(w);
    const s = await w.srv.connected(tb, null);
    const T = "id:tools-only-root";
    const register = async (tx: Tx) => {
      const as = await w.srv.app.application.hostedWritesAs(tx, aw, T, LEAD, true);
      await w.srv.app.application.hostedRegister(tx, aw, T, "test", as, () => { throw new Error("unexpected id_collision"); });
      return as;
    };
    const r = await raceRequest(w.p, register, () => s.bind(LEAD));
    expect(committed(r.a)).toBe(LEAD);
    expect(refused(r.b)).toBe("refused alias_held");
    expect(await users(w)).toEqual({ holds: [], writers: [{ id: T, principal: W }] });
    expect(r.waited).toBe(true);
  });

  // The other order: B's bind (bindNow, the server's composed bind) on A, held after its take, at its touchAlias, whose
  // UPDATE of the alias row would make W's lazy create (ON CONFLICT DO NOTHING) wait on its own, lock or no lock; W's
  // real tools-only registration of the same name (an application session's connect: hostedWritesAs, then
  // hostedRegister). Mutation: hostedWritesAs's create path without lockedUserOf's lock (alias_use.ts; W registers as
  // ops/lead while B holds it).
  test("a tools-only root registering as a name another user's bind has just taken: the registration waits, then is refused", async () => {
    await using w = await world();
    const { tw, tb } = await team(w);
    const s = await w.srv.connected(tb, null);
    const held = holdCall(w.repo.bindings, "touchAlias");
    let done = false, waitEvent: string | null = null, b: Promise<Settled<unknown>> | undefined;
    const a = settle(w.a.write(tx => w.srv.app.application.bindNow(tx, s.session, { alias: LEAD })));
    try {
      await Promise.race([held.reached, a]);
      b = settle(w.srv.connected(tw, LEAD, { push: false })).finally(() => { done = true; });
      waitEvent = await blockedOrSettled(w.pg, () => done, "the registration blocked on the alias row, or settled");
    } finally {
      held.open();
      held.undo();
    }
    expect(committed(await a)).toMatchObject({ alias: LEAD, held: [LEAD] });
    expect(refused(await b!)).toBe("refused alias_held");
    expect(await users(w)).toEqual({ holds: [{ id: s.id, principal: B }], writers: [] });
    expect(waitEvent).not.toBeNull();
  });
});
