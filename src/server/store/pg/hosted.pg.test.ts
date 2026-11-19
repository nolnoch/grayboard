// #807 P3 C8b2: the Postgres hosted store's races (c8-scope §5.2 T-C8-1…9, plus T-C8-10…12; postgres-server.md D3),
// each in T-P12's shape (tests/support/pg_race.ts): A's body holds its transaction open at a gate, B's starts, and the
// race waits until B is blocked on a lock or done. Two stores over one database stand for two pods. The end state is
// asserted before `waited`, so a race whose lock is gone fails on what it broke (a second insert past the cap, a
// second lease_closed, an orphan child, a session outliving its grant), not on a timeout. The callers' bodies (rowFor,
// attach, register, a revoke, the nested sweep) are restated here as their store steps; hosted.test.ts's spy rows pin
// that hosted.ts takes those steps in this order. The child-ID end is the recorder (tests/support/pg_hosted.ts) until
// C10d2's. Without GRAYBOARD_TEST_PG_URL they skip.
import { expect, setDefaultTimeout, test } from "bun:test";
import { describePg } from "../../../../tests/support/pg.ts";
import { sessionEndRecorder } from "../../../../tests/support/pg_hosted.ts";
import { blockedOrSettled, committed, outcome, pgPair, race, settle, type PgPair, type Settled } from "../../../../tests/support/pg_race.ts";
import type { HostedSession } from "../../hosted-types.ts";
import type { HostedStore } from "../hosted.ts";
import type { Tx } from "../tx_base.ts";
import { makePgHosted } from "./hosted.ts";
import { makePgHostedEnds } from "./hosted_port.ts";
import { int8, int8OrNull } from "./sql.ts";
import { pgOf } from "./tx.ts";

// Above the pool's 5 s lock_timeout (pg/tx.ts), so a wait a broken lock leaves fails 55P03, not on Bun's 5 s timeout.
setDefaultTimeout(30_000);

const T0 = 1_800_000_000_000;
const ME = "you@example.com";
type Row = Record<string, unknown>;

// Two pods' stores over one pair, one session-end recorder between them (its calls are every child-ID end, either side).
type World = { p: PgPair; ha: HostedStore; hb: HostedStore; ends: ReturnType<typeof sessionEndRecorder>; user: number };
async function world(p: PgPair): Promise<World> {
  const ends = sessionEndRecorder();
  const user = int8((await p.db.sql`INSERT INTO users (email, created_at) VALUES (${ME}, 0) RETURNING id`)[0].id);
  await p.db.sql`INSERT INTO oauth_grants (id, user_id, expires_at, data) VALUES ('g', ${user}, ${T0 + 1_000_000}, '{}'::jsonb)`;
  return { p, ends, user, ha: makePgHosted({ sessionEnd: ends.port }), hb: makePgHosted({ sessionEnd: ends.port }) };
}
const rowOf = (over: Partial<HostedSession> & Pick<HostedSession, "session_id" | "ownership_id" | "user_id">): HostedSession => ({
  client_id: "client", grant_id: "g", source_session_id: over.session_id, writes_as: null, bind_gen: 0, root_session_id: null, place: null,
  lease_deadline: null, created_at: T0, last_seen_at: T0, suggested: null, parked_at: null, ...over,
});
// rowFor's create: an ownership, then the row.
const createRoot = async (h: HostedStore, tx: Tx, id: string, user: number, over: Partial<HostedSession> = {}) => {
  const row = rowOf({ session_id: id, ownership_id: await h.start(tx, id, user, "client", T0), user_id: user, ...over });
  await h.insert(tx, row);
  return row;
};
const childOf = (id: string, root: HostedSession, over: Partial<HostedSession> = {}) =>
  rowOf({ session_id: id, ownership_id: root.ownership_id, user_id: root.user_id, root_session_id: root.session_id, ...over });
const root = (w: World, id: string, over: Partial<HostedSession> = {}) => w.p.a.write(tx => createRoot(w.ha, tx, id, w.user, over));
const child = async (w: World, id: string, parent: HostedSession, over: Partial<HostedSession> = {}) => {
  const row = childOf(id, parent, over);
  await w.p.a.write(tx => w.ha.insert(tx, row));
  return row;
};
const seedIds = (w: World, ...ids: string[]) => Promise.all(ids.map(id => w.p.db.sql`INSERT INTO ids (id, started_at, last_seen) VALUES (${id}, 0, 0)`));

const got = (w: World, id: string) => w.ha.get(w.p.a.read, id);
const rowsOf = async (w: World, ownership: number) => int8((await w.p.db.sql`SELECT count(*) AS n FROM hosted_sessions WHERE ownership_id = ${ownership}`)[0].n);
const audits = async (w: World, action: string) => int8((await w.p.db.sql`SELECT count(*) AS n FROM access_log WHERE action = ${action}`)[0].n);
const ownershipEnded = async (w: World, ownership: number) => int8OrNull((await w.p.db.sql`SELECT ended_at FROM hosted_ownerships WHERE id = ${ownership}`)[0].ended_at);
// What a third connection gets asking for a row's lock at once: "free" (and let go), or the SQLSTATE.
const probeRow = async (w: World, id: string) => {
  try { await w.p.db.sql`SELECT 1 FROM hosted_sessions WHERE session_id = ${id} FOR UPDATE NOWAIT`; return "free"; }
  catch (e) { return String((e as { errno?: string }).errno ?? e); }
};

describePg("hosted store races (Postgres)", () => {
  // admit's shape: the capacity lock, then the count, then the insert unless full. A cap of 2 with one root seeded.
  const admit = (h: HostedStore, w: World, id: string) => async (tx: Tx) => {
    await h.lockCapacity(tx);
    const n = await h.counts(tx, w.user);
    if (n.total >= 2) return "refused";
    await createRoot(h, tx, id, w.user);
    return "admitted";
  };

  // Mutation: lockCapacity takes no lock (both count 1 and insert: 3 rows at a cap of 2, probe C1).
  test("T-C8-1: two admissions at the last slot: one inserts, the other counts it and is refused", async () => {
    await using p = await pgPair();
    const w = await world(p);
    await root(w, "r0");
    const r = await race(p, admit(w.ha, w, "a"), admit(w.hb, w, "b"));
    expect([outcome(r.a), outcome(r.b)]).toEqual(["admitted", "refused"]);
    expect(await w.ha.counts(p.a.read, w.user)).toEqual({ total: 2, user: 2 });
    expect(r.waitEvent).toBe("advisory");
  });

  // rowFor's create: an unlocked read finds no row, then the capacity lock and the read again (scope §2.2).
  // Mutations: the read again dropped (`reread`), or lockCapacity no lock: B inserts x again, 23505 hosted_sessions_pkey.
  const rowFor = (h: HostedStore, w: World) => async (tx: Tx) => {
    let row = await h.get(tx, "x");
    if (!row) {
      await h.lockCapacity(tx);
      row = await h.get(tx, "x"); // reread
    }
    if (row) return "found";
    await createRoot(h, tx, "x", w.user);
    return "created";
  };
  test("T-C8-2: two first requests of one session ID: the second reads it again under the capacity lock and finds it", async () => {
    await using p = await pgPair();
    const w = await world(p);
    const r = await race(p, rowFor(w.ha, w), rowFor(w.hb, w));
    expect([outcome(r.a), outcome(r.b)]).toEqual(["created", "found"]);
    expect(int8((await p.db.sql`SELECT count(*) AS n FROM hosted_sessions WHERE session_id = 'x'`)[0].n)).toBe(1);
    expect(int8((await p.db.sql`SELECT count(*) AS n FROM hosted_ownerships WHERE session_id = 'x'`)[0].n)).toBe(1);
    expect(r.waitEvent).toBe("advisory");
  });

  // Mutation: end judges an unlocked read (B reads r before A commits, deletes nothing, and audits lease_closed again: E2b).
  test("T-C8-3: two ends of one root: the second finds it gone and returns false; one lease_closed, one child_released and one ID end per child", async () => {
    await using p = await pgPair();
    const w = await world(p);
    const r = await root(w, "r", { lease_deadline: T0 + 1_000 });
    await child(w, "c1", r, { created_at: T0 + 1 });
    await child(w, "c2", r, { created_at: T0 + 2 });
    await seedIds(w, "c1", "c2");
    const res = await race(p, tx => w.ha.end(tx, "r", "closed", T0 + 50), tx => w.hb.end(tx, "r", "closed", T0 + 50));
    expect([outcome(res.a), outcome(res.b)]).toEqual([true, false]);
    expect(await rowsOf(w, r.ownership_id)).toBe(0);
    expect([await audits(w, "hosted.lease_closed"), await audits(w, "hosted.child_released")]).toEqual([1, 2]);
    expect(w.ends.calls.map(c => c.id)).toEqual(["c1", "c2"]);
    expect(res.waited).toBe(true);
  });

  // The sweep's expiry (deadline guard) and idle end (cutoff guard) against a renewal and a touch committed while they
  // waited: each guard reads the locked row (scope §2.3 E4; the C8a audit's n2: a bind's contender end, judged on an
  // unlocked read, is the same call). Mutation: end judges an unlocked read (it ends the renewed or touched root).
  test("T-C8-4: an expiry or idle end racing a renewal or touch of the root: the guard reads the renewed row and refuses", async () => {
    await using p = await pgPair();
    const w = await world(p);
    const leased = await root(w, "r", { lease_deadline: T0 + 100 });
    const idle = await root(w, "q", { last_seen_at: T0 });
    const renew = await race(p, async tx => { await w.ha.lock(tx, "r"); await w.ha.update(tx, "r", { lease_deadline: T0 + 300 }); },
      tx => w.hb.end(tx, "r", "expired", T0 + 150, T0 + 100));
    committed(renew.a);
    expect(outcome(renew.b)).toBe(false);
    expect((await got(w, "r"))?.lease_deadline).toBe(T0 + 300);
    expect(await ownershipEnded(w, leased.ownership_id)).toBeNull();
    expect(renew.waited).toBe(true);
    const touched = await race(p, async tx => { await w.ha.lock(tx, "q"); await w.ha.touch(tx, "q", T0 + 200); },
      tx => w.hb.end(tx, "q", "idle", T0 + 250, undefined, T0 + 100));
    committed(touched.a);
    expect(outcome(touched.b)).toBe(false);
    expect((await got(w, "q"))?.last_seen_at).toBe(T0 + 200);
    expect(await ownershipEnded(w, idle.ownership_id)).toBeNull();
    expect(touched.waited).toBe(true);
  });

  // A bind (bind_gen + 1) and a delivery renew of one root, each a locked read and a patch. The renew's body also has
  // the row withGate read before it (`earlier`). Mutations: `lock` without FOR UPDATE (the renew reads generation 0),
  // or the renew writing the row from `earlier` whole (`full row`: bind_gen back to 0, probe U1).
  test("T-C8-5: a bind and a renew of one root: the renew waits, reads the new generation, and its patch keeps it", async () => {
    await using p = await pgPair();
    const w = await world(p);
    await root(w, "r", { lease_deadline: T0 + 100 });
    const earlier = (await got(w, "r"))!;
    const r = await race(p, async tx => {
      const row = (await w.ha.lock(tx, "r"))!;
      await w.ha.update(tx, "r", { bind_gen: row.bind_gen + 1 });
    }, async tx => {
      const row = (await w.hb.lock(tx, "r"))!;
      if (row.ownership_id !== earlier.ownership_id) return "unbound";
      await w.hb.update(tx, "r", { lease_deadline: T0 + 400, last_seen_at: T0 + 50 });
      return row.bind_gen;
    });
    committed(r.a);
    expect(outcome(r.b)).toBe(1);
    const row = (await got(w, "r"))!;
    expect([row.bind_gen, row.lease_deadline, row.last_seen_at]).toEqual([1, T0 + 400, T0 + 50]);
    expect(r.waited).toBe(true);
  });

  // register's steps under attach (scope §2.4): the root locked, then the child inserted under its ownership; and the
  // root's end. Mutation: `lock` without FOR UPDATE (an orphan child either way, probes R1 and R2).
  const register = (h: HostedStore) => async (tx: Tx) => {
    const r = await h.lock(tx, "r");
    if (!r) return "unbound";
    await h.insert(tx, childOf("c", r));
    return "registered";
  };
  test("T-C8-6a: a root's end, then a register under it: the register waits, finds the root gone, and inserts nothing", async () => {
    await using p = await pgPair();
    const w = await world(p);
    const r = await root(w, "r");
    const res = await race(p, tx => w.ha.end(tx, "r", "closed", T0 + 50), register(w.hb));
    expect([outcome(res.a), outcome(res.b)]).toEqual([true, "unbound"]);
    expect(await rowsOf(w, r.ownership_id)).toBe(0);
    expect(await got(w, "c")).toBeUndefined();
    expect(res.waited).toBe(true);
  });
  test("T-C8-6b: a register under a root, then the root's end: the end waits and ends the child with it", async () => {
    await using p = await pgPair();
    const w = await world(p);
    const r = await root(w, "r");
    await seedIds(w, "c");
    const res = await race(p, register(w.ha), tx => w.hb.end(tx, "r", "closed", T0 + 50));
    expect([outcome(res.a), outcome(res.b)]).toEqual(["registered", true]);
    expect(await rowsOf(w, r.ownership_id)).toBe(0);
    expect(w.ends.calls.map(c => c.id)).toEqual(["c"]);
    expect(res.waited).toBe(true);
  });

  // A write body under the request's grant (rowFor's create, scope §2.5): grantLive first, then the insert; and the
  // revoke: the grant's UPDATE, then endForGrant (pg/oauth.ts revokeGrant). Mutation: grantLive without FOR SHARE (the
  // session outlives the revoke either way, probe G1).
  const underGrant = (h: HostedStore, w: World) => async (tx: Tx) => {
    if (!await h.grantLive(tx, "g", T0)) return "revoked";
    await createRoot(h, tx, "s", w.user);
    return "inserted";
  };
  const revoke = (h: HostedStore) => async (tx: Tx) => {
    await pgOf(tx)`UPDATE oauth_grants SET revoked_at = ${T0 + 10} WHERE id = 'g'`;
    await makePgHostedEnds(h).endForGrant(tx, "g", T0 + 10);
    return "revoked";
  };
  const liveOnG = async (w: World) => (await w.p.db.sql`SELECT session_id FROM hosted_sessions WHERE grant_id = 'g'`).map((x: Row) => x.session_id);
  test("T-C8-7a: an insert under a grant, then its revoke: the revoke waits and ends the session", async () => {
    await using p = await pgPair();
    const w = await world(p);
    const res = await race(p, underGrant(w.ha, w), revoke(w.hb));
    expect([outcome(res.a), outcome(res.b)]).toEqual(["inserted", "revoked"]);
    expect(await liveOnG(w)).toEqual([]);
    expect(int8OrNull((await p.db.sql`SELECT ended_at FROM hosted_ownerships WHERE session_id = 's'`)[0].ended_at)).toBe(T0 + 10);
    expect(res.waited).toBe(true);
  });
  test("T-C8-7b: a grant's revoke, then an insert under it: the insert waits, reads the grant revoked, and inserts nothing", async () => {
    await using p = await pgPair();
    const w = await world(p);
    const res = await race(p, revoke(w.ha), underGrant(w.hb, w));
    expect([outcome(res.a), outcome(res.b)]).toEqual(["revoked", "revoked"]);
    expect(await liveOnG(w)).toEqual([]);
    expect(int8((await p.db.sql`SELECT count(*) AS n FROM hosted_ownerships`)[0].n)).toBe(0);
    expect(res.waited).toBe(true);
  });

  // Mutation: tellLost as a read, then a mark (both take both rows, probe T1).
  test("T-C8-8: two agent takes of one session's lost holds: the first takes them, the second waits and takes none", async () => {
    await using p = await pgPair();
    const w = await world(p);
    await root(w, "r");
    for (const alias of ["x", "y"]) await p.a.write(tx => w.ha.lose(tx, "r", { alias: `a/${alias}`, reason: "taken", primary: false }, T0));
    const res = await race(p, tx => w.ha.tellLost(tx, "r", T0 + 1), tx => w.hb.tellLost(tx, "r", T0 + 2));
    const aliases = (s: unknown) => (s as { alias: string }[]).map(l => l.alias);
    expect([aliases(committed(res.a)), aliases(outcome(res.b))]).toEqual([["a/x", "a/y"], []]);
    expect(res.waited).toBe(true);
  });

  // A request's touch of a child against the sweep's park of it as idle (scope §2.6). Mutation: park without its
  // `last_seen_at < idleBefore` guard (the touched child parks).
  test("T-C8-9: a touch of a child, then the sweep's park of it as idle: the park re-reads the touch and leaves it active", async () => {
    await using p = await pgPair();
    const w = await world(p);
    const r = await root(w, "r");
    await child(w, "c", r, { last_seen_at: T0 });
    const res = await race(p, tx => w.ha.touch(tx, "c", T0 + 200), tx => w.hb.park(tx, "c", T0 + 250, T0 + 100));
    committed(res.a);
    expect(outcome(res.b)).toBe(false);
    expect((await got(w, "c"))?.parked_at).toBeNull();
    expect(res.waited).toBe(true);
  });

  // The nested sweep inside `full()` runs holding the capacity lock (the C8a audit's order: capacity last), so its
  // end, childEnd and park skip what another body holds rather than wait on it: that body may want capacity next.
  // A holds the root (a settle's lock), only the child (its touch), or only an ids row; B, capped, runs the sweep's
  // calls. B returns at once, refused, without waiting, and writes nothing; once A commits, the same capped calls act.
  // Mutations: SKIP LOCKED dropped on the target row, on the end's children, or on the ids rows (B waits, then acts).
  const sweepWorld = async (w: World) => {
    const r = await root(w, "r", { last_seen_at: T0 });
    await child(w, "c", r, { last_seen_at: T0 });
    await seedIds(w, "r", "c");
    return r;
  };
  const untouched = async (w: World, r: HostedSession) => {
    expect((await got(w, "r"))?.session_id).toBe("r");
    expect((await got(w, "c"))?.parked_at).toBeNull();
    expect(await ownershipEnded(w, r.ownership_id)).toBeNull();
    expect(w.ends.calls).toEqual([]);
    expect([await audits(w, "hosted.child_released"), await audits(w, "hosted.lease_closed")]).toEqual([0, 0]);
  };
  const idleEnd = (h: HostedStore) => (tx: Tx) => h.end(tx, "r", "idle", T0 + 500, undefined, T0 + 100);
  const sweepAll = (h: HostedStore) => async (tx: Tx) => {
    await h.lockCapacity(tx);
    return [await idleEnd(h)(tx), await h.park(tx, "c", T0 + 500, T0 + 100), await h.childEnd(tx, "c", T0 + 500, "closed")];
  };
  const cappedOne = <T>(h: HostedStore, call: (tx: Tx) => Promise<T>) => async (tx: Tx) => { await h.lockCapacity(tx); return call(tx); };

  test("T-C8-10a: under the capacity lock, an end of a root another body holds returns false at once and writes nothing", async () => {
    await using p = await pgPair();
    const w = await world(p);
    const r = await sweepWorld(w);
    const res = await race(p, async tx => { await w.ha.lock(tx, "r"); }, cappedOne(w.hb, idleEnd(w.hb)));
    committed(res.a);
    expect(outcome(res.b)).toBe(false);
    await untouched(w, r);
    expect(res.waited).toBe(false);
    // A committed: the same capped end acts.
    expect(await p.b.write(cappedOne(w.hb, idleEnd(w.hb)))).toBe(true);
    expect(await rowsOf(w, r.ownership_id)).toBe(0);
  });
  test("T-C8-10b: under the capacity lock, with only the child held elsewhere, the root's end, the child's park and its childEnd all return at once and write nothing", async () => {
    await using p = await pgPair();
    const w = await world(p);
    const r = await sweepWorld(w);
    // A holds only the child: a touch writes the child's row and not its root's (the value it had, so the park still could).
    const res = await race(p, tx => w.ha.touch(tx, "c", T0), sweepAll(w.hb));
    committed(res.a);
    expect(outcome(res.b)).toEqual([false, false, undefined]);
    await untouched(w, r);
    expect(res.waited).toBe(false);
    expect(await p.b.write(cappedOne(w.hb, tx => w.hb.park(tx, "c", T0 + 500, T0 + 100)))).toBe(true);
    await p.b.write(cappedOne(w.hb, tx => w.hb.childEnd(tx, "c", T0 + 500, "evicted")));
    expect(await got(w, "c")).toBeUndefined();
    expect(await p.b.write(cappedOne(w.hb, idleEnd(w.hb)))).toBe(true);
    expect(w.ends.calls.map(c => c.id)).toEqual(["c"]);
  });
  test("T-C8-10c: under the capacity lock, with only an ids row held elsewhere, the root's end (its own or its child's ids) and the child's childEnd (its ids) return at once and write nothing", async () => {
    await using p = await pgPair();
    const w = await world(p);
    const r = await sweepWorld(w);
    const holdIds = (id: string) => async (tx: Tx) => { await pgOf(tx)`SELECT 1 FROM ids WHERE id = ${id} FOR UPDATE`; };
    const root = await race(p, holdIds("r"), cappedOne(w.hb, idleEnd(w.hb)));
    committed(root.a);
    expect(outcome(root.b)).toBe(false);
    await untouched(w, r);
    expect(root.waited).toBe(false);
    const kid = await race(p, holdIds("c"), async tx => {
      await w.hb.lockCapacity(tx);
      return [await idleEnd(w.hb)(tx), await w.hb.childEnd(tx, "c", T0 + 500, "closed")];
    });
    committed(kid.a);
    expect(outcome(kid.b)).toEqual([false, undefined]);
    await untouched(w, r);
    expect(kid.waited).toBe(false);
    await p.b.write(cappedOne(w.hb, tx => w.hb.childEnd(tx, "c", T0 + 500, "closed")));
    expect(await got(w, "c")).toBeUndefined();
    expect(await p.b.write(cappedOne(w.hb, idleEnd(w.hb)))).toBe(true);
    expect(w.ends.calls.map(c => c.id)).toEqual(["c"]);
  });

  // `lock(child)` locks the child's root first (store/hosted.ts's order), so a body waiting on a root holds none of its
  // children meanwhile. A third connection asks for the child with NOWAIT while B waits. Mutation: lock(child) locking
  // the child before its root (the probe meets B's lock: 55P03).
  test("T-C8-11: lock(child) while another body holds the root: it waits on the root holding nothing, then locks both", async () => {
    await using p = await pgPair();
    const w = await world(p);
    const r = await root(w, "r");
    await child(w, "c", r);
    const res = await race(p, async tx => { await w.ha.lock(tx, "r"); }, async tx => (await w.hb.lock(tx, "c"))?.session_id, () => probeRow(w, "c"));
    committed(res.a);
    expect(outcome(res.b)).toBe("c");
    expect(res.seen).toBe("free");
    expect(res.waited).toBe(true);
  });

  // Two revokes' ends at once (a grant's and a user's, pg/hosted_port.ts), each over both roots. Each call locks its roots
  // in one statement, so without ORDER BY the order it locks them in is its plan's. Two shapes, each its own database:
  // - `inserted r2 first`: both sequential scans, which meet the roots in insertion order, r2 before r1, while the
  //   other call (ORDER BY) takes r1 first. Catches either call without ORDER BY.
  // - `plans differ`: r1 inserted first, then HOT-updated, which moves it past r2 in the heap but not in the index; the
  //   grant's call runs an index scan (r1, r2), the user's a sequential one (r2, r1). Catches both without ORDER BY.
  // A third connection holds both roots until both calls wait on them, then lets go: each wakes holding its first row
  // and wanting the other's. The real revokes also serialize on the grant row first (both revoke g); these calls skip
  // that UPDATE, so what is tested is the ends' own order, which also stands against any other locker of many roots.
  // Mutation: no ORDER BY session_id (the two cross: 40P01).
  const seqScan = async (tx: Tx) => { await pgOf(tx)`SET LOCAL enable_indexscan = off`; await pgOf(tx)`SET LOCAL enable_bitmapscan = off`; };
  const indexScan = async (tx: Tx) => { await pgOf(tx)`SET LOCAL enable_seqscan = off`; await pgOf(tx)`SET LOCAL enable_bitmapscan = off`; };
  for (const shape of ["inserted r2 first", "plans differ"] as const) test(`T-C8-12a (${shape}): a grant's and a user's revoke ending the same roots at once lock them in one order: no deadlock, each root ends once`, async () => {
    await using p = await pgPair();
    const w = await world(p);
    const [grantPlan, userPlan] = shape === "plans differ" ? [indexScan, seqScan] : [seqScan, seqScan];
    for (const id of shape === "plans differ" ? ["r1", "r2"] : ["r2", "r1"]) await root(w, id, { lease_deadline: T0 + 1_000 });
    if (shape === "plans differ") await p.db.sql`UPDATE hosted_sessions SET last_seen_at = ${T0 + 1} WHERE session_id = 'r1'`;
    const order = (plan: (tx: Tx) => Promise<void>, where: "grant" | "user") => p.a.write(async tx => {
      await plan(tx);
      const sql = pgOf(tx);
      const rows = where === "grant" ? await sql`SELECT session_id FROM hosted_sessions WHERE grant_id = 'g' AND root_session_id IS NULL`
        : await sql`SELECT session_id FROM hosted_sessions WHERE user_id = ${w.user} AND root_session_id IS NULL`;
      return rows.map((x: Row) => x.session_id);
    });
    // What each call's plan meets the roots in, without ORDER BY.
    expect([await order(grantPlan, "grant"), await order(userPlan, "user")]).toEqual(shape === "plans differ" ? [["r1", "r2"], ["r2", "r1"]] : [["r2", "r1"], ["r2", "r1"]]);
    const holder = await p.db.sql.reserve();
    let a: Promise<Settled<void>> | undefined, b: Promise<Settled<void>> | undefined;
    try {
      await holder`BEGIN`;
      await holder`SELECT 1 FROM hosted_sessions WHERE session_id IN ('r1', 'r2') FOR UPDATE`;
      let aDone = false, bDone = false;
      a = settle(p.a.write(async tx => { await grantPlan(tx); await makePgHostedEnds(w.ha).endForGrant(tx, "g", T0 + 10); })).finally(() => { aDone = true; });
      expect(await blockedOrSettled(p, () => aDone, "the grant's revoke blocked on the held roots", "a")).not.toBeNull();
      b = settle(p.b.write(async tx => { await userPlan(tx); await makePgHostedEnds(w.hb).endForUser(tx, w.user, "disabled", T0 + 20); })).finally(() => { bDone = true; });
      expect(await blockedOrSettled(p, () => bDone, "the user's revoke blocked on the held roots", "b")).not.toBeNull();
    } finally {
      await holder`ROLLBACK`;
      holder.release();
    }
    expect([outcome((await a)!), outcome((await b)!)]).toEqual([undefined, undefined]);
    expect(int8((await p.db.sql`SELECT count(*) AS n FROM hosted_sessions`)[0].n)).toBe(0);
    expect(await audits(w, "hosted.lease_closed")).toBe(2);
    // Each root ended once, by whichever call reached it first.
    const ended = (await p.db.sql`SELECT session_id, end_reason FROM hosted_ownerships ORDER BY session_id`).map((x: Row) => x.session_id);
    expect(ended).toEqual(["r1", "r2"]);
    expect(int8((await p.db.sql`SELECT count(*) AS n FROM hosted_ownerships WHERE ended_at IS NULL`)[0].n)).toBe(0);
  });

  // A grant re-attach (attach: grantLive on the new grant, the root locked, every row of the ownership moved to it)
  // against the old grant's revoke. The revoke's roots are read FOR UPDATE, so its read waits for the attach and then
  // re-checks grant_id: the root, now on a live grant, is not its. Mutation: endForGrant reading its roots without
  // FOR UPDATE (it reads the root on g, waits in end, and ends a session on the live grant g2).
  test("T-C8-12b: a re-attach to a new grant, then the old grant's revoke: the revoke waits, re-reads the root on the new grant, and leaves it", async () => {
    await using p = await pgPair();
    const w = await world(p);
    await p.db.sql`INSERT INTO oauth_grants (id, user_id, expires_at, data) VALUES ('g2', ${w.user}, ${T0 + 1_000_000}, '{}'::jsonb)`;
    const r = await root(w, "r");
    await child(w, "c", r);
    const res = await race(p, async tx => {
      if (!await w.ha.grantLive(tx, "g2", T0)) return "revoked";
      const fresh = (await w.ha.lock(tx, "r"))!;
      for (const row of await w.ha.ofOwnership(tx, fresh.ownership_id)) await w.ha.update(tx, row.session_id, { grant_id: "g2" });
      return "attached";
    }, revoke(w.hb));
    expect([outcome(res.a), outcome(res.b)]).toEqual(["attached", "revoked"]);
    expect([(await got(w, "r"))?.grant_id, (await got(w, "c"))?.grant_id]).toEqual(["g2", "g2"]);
    expect(await ownershipEnded(w, r.ownership_id)).toBeNull();
    expect(w.ends.calls).toEqual([]);
    expect(res.waited).toBe(true);
  });
});
