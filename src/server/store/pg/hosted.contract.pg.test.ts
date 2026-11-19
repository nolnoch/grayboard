// #807 P3 C8b1: the hosted store's contract (hosted.contract.ts) on Postgres: the same rows SQLite runs from db.test.ts,
// over makePgHosted with the session-end recorder (tests/support/pg_hosted.ts) as its child-ID end, so `idEnded` reads
// the `ids.ended_at` the recorder marks. Fixture writes and raw reads go through the database's own read-write pool.
// Each row gets its own database. Below the contract, the rows only Postgres has: PgHostedEnds (contract row 9), the
// lost-hold order where the heap's order differs from (at, seq), and the locks the seams and the ends hold, seen from a
// second connection with NOWAIT (a lock refused at once, never a wait). The two-connection races are C8b2's
// (pg/hosted.pg.test.ts). Without GRAYBOARD_TEST_PG_URL it skips (tests/support/pg.ts).
import { expect, setDefaultTimeout, test } from "bun:test";
import { describePg, pgDatabase, type PgDatabase } from "../../../../tests/support/pg.ts";
import { sessionEndRecorder } from "../../../../tests/support/pg_hosted.ts";
import type { HostedSession } from "../../hosted-types.ts";
import { hostedContract, type HostedBackend, type HostedHarness } from "../hosted.contract.ts";
import type { HostedStore } from "../hosted.ts";
import type { Tx } from "../tx_base.ts";
import { HOSTED_CAP_LOCK, makePgHosted } from "./hosted.ts";
import { makePgHostedEnds } from "./hosted_port.ts";
import { int8, int8OrNull } from "./sql.ts";
import { makePgTransactions, type PgTransactions } from "./tx.ts";

// Above the pool's 5 s lock_timeout, so a row that waits on a lock it shouldn't fails on 55P03, not on bun's timeout.
setDefaultTimeout(30_000);

type Row = Record<string, unknown>;
type PgHosted = HostedHarness & { hosted: HostedStore; db: PgDatabase; s: PgTransactions; ended: ReturnType<typeof sessionEndRecorder> };

async function openPgHosted(): Promise<PgHosted> {
  const db = await pgDatabase({ max: 3 });
  const s = makePgTransactions(db.url, { max: 4, applicationName: "gb-test-hosted" });
  const ended = sessionEndRecorder();
  const sql = db.sql;
  return {
    db, s, ended,
    hosted: makePgHosted({ sessionEnd: ended.port }),
    write: fn => s.write(fn),
    read: s.read,
    seedUser: async (email, disabled = false) =>
      int8((await sql`INSERT INTO users (email, created_at, disabled_at) VALUES (${email}, 0, ${disabled ? 1 : null}::int8) RETURNING id`)[0].id),
    async seedGrant(id, user, expiresAt, revokedAt = null) {
      await sql`INSERT INTO oauth_grants (id, user_id, expires_at, revoked_at, data) VALUES (${id}, ${user}, ${expiresAt}, ${revokedAt}::int8, '{}'::jsonb)`;
    },
    async seedIds(id, f = {}) {
      // held_aliases_json is the JSON text; cast through text so it's parsed, not stored as a string scalar.
      await sql`INSERT INTO ids (id, started_at, last_seen, root_id, ended_at, held_aliases_json, writes_as, launcher)
        VALUES (${id}, 0, 0, ${f.rootId ?? null}::text, ${f.endedAt ?? null}::int8, ${f.heldAliasesJson ?? null}::text::jsonb, ${f.writesAs ?? null}::text, ${f.launcher ?? false})`;
    },
    async seedHold(address, id, boundAt) { await sql`INSERT INTO alias_holds (address, id, bound_at) VALUES (${address}, ${id}, ${boundAt})`; },
    async ids(id) {
      const [r] = await sql`SELECT root_id, ended_at, held_aliases_json::text AS held_aliases_json, writes_as, launcher FROM ids WHERE id = ${id}`;
      return r && { root_id: r.root_id, ended_at: int8OrNull(r.ended_at), held_aliases_json: r.held_aliases_json, writes_as: r.writes_as, launcher: r.launcher === true };
    },
    async ownership(id) {
      const [r] = await sql`SELECT session_id, ended_at, end_reason FROM hosted_ownerships WHERE id = ${id}`;
      return r && { session_id: r.session_id, ended_at: int8OrNull(r.ended_at), end_reason: r.end_reason };
    },
    holdRows: async () => (await sql`SELECT address, id FROM alias_holds ORDER BY address`).map((r: Row) => ({ ...r })),
    bindingRows: async () => (await sql`SELECT session_id, name, event, detail FROM binding_events ORDER BY id`).map((r: Row) => ({ ...r })),
    // jsonb comes back parsed.
    auditRows: async () => (await sql`SELECT actor, action, target, detail FROM access_log ORDER BY id`).map((r: Row) => ({ ...r })),
    lostRows: async () => (await sql`SELECT session_id, alias FROM hosted_alias_lost ORDER BY session_id, alias`).map((r: Row) => ({ ...r })),
    idEnded: async id => int8OrNull((await sql`SELECT ended_at FROM ids WHERE id = ${id}`)[0]?.ended_at),
    async close() {
      await s.close();
      await db[Symbol.asyncDispose]();
    },
  };
}

const pgHostedBackend: HostedBackend = { kind: "postgres", open: openPgHosted };

describePg("hosted contract (Postgres)", () => hostedContract(pgHostedBackend));

const T0 = 1_800_000_000_000;
const ME = "you@example.com";
const rowOf = (over: Partial<HostedSession> & Pick<HostedSession, "session_id" | "ownership_id" | "user_id">): HostedSession => ({
  client_id: "client", grant_id: "g1", source_session_id: over.session_id, writes_as: null, bind_gen: 0, root_session_id: null, place: null,
  lease_deadline: null, created_at: T0, last_seen_at: T0, suggested: null, parked_at: null, ...over,
});
async function root(h: PgHosted, id: string, user: number, over: Partial<HostedSession> = {}): Promise<HostedSession> {
  return h.write(async tx => {
    const row = rowOf({ session_id: id, ownership_id: await h.hosted.start(tx, id, user, "client", T0), user_id: user, ...over });
    await h.hosted.insert(tx, row);
    return row;
  });
}
async function child(h: PgHosted, id: string, parent: HostedSession, over: Partial<HostedSession> = {}): Promise<HostedSession> {
  const row = rowOf({ session_id: id, ownership_id: parent.ownership_id, user_id: parent.user_id, root_session_id: parent.session_id, ...over });
  await h.write(tx => h.hosted.insert(tx, row));
  return row;
}

// What a second connection gets asking for `lock` at once: "free" when it got it (and let it go), or the SQLSTATE.
async function probe(h: PgHosted, lock: "row" | "grant" | "capacity", key: string): Promise<string> {
  const sql = h.db.sql;
  try {
    if (lock === "row") await sql`SELECT 1 FROM hosted_sessions WHERE session_id = ${key} FOR UPDATE NOWAIT`;
    else if (lock === "grant") await sql`SELECT 1 FROM oauth_grants WHERE id = ${key} FOR UPDATE NOWAIT`;
    else {
      const [r] = await sql`SELECT pg_try_advisory_xact_lock(${HOSTED_CAP_LOCK}::int4, 0) AS got`;
      return r.got ? "free" : "held";
    }
    return "free";
  } catch (e) { return String((e as { errno?: string }).errno ?? e); }
}

describePg("hosted store (Postgres): beyond the contract", () => {
  const withStore = (name: string, fn: (h: PgHosted) => Promise<void>) => test(name, async () => {
    const h = await openPgHosted();
    try { await fn(h); } finally { await h.close(); }
  });

  // Row 9.
  withStore("PgHostedEnds: endForGrant ends the grant's roots and their children only; endForUser ends the user's roots with its reason", async h => {
    const ends = makePgHostedEnds(h.hosted);
    const u = await h.seedUser(ME), v = await h.seedUser("them@example.com");
    const a = await root(h, "a", u, { grant_id: "g-a", lease_deadline: T0 + 100 });
    await child(h, "a-kid", a, { grant_id: "g-a" });
    const b = await root(h, "b", u, { grant_id: "g-b" });
    const other = await root(h, "v", v, { grant_id: "g-a" });
    await h.write(tx => ends.endForGrant(tx, "g-a", T0 + 5));
    for (const id of ["a", "a-kid", "v"]) expect(await h.hosted.get(h.read, id)).toBeUndefined();
    expect(await h.ownership(a.ownership_id)).toMatchObject({ ended_at: T0 + 5, end_reason: "revoked" });
    expect(await h.ownership(other.ownership_id)).toMatchObject({ ended_at: T0 + 5, end_reason: "revoked" });
    expect(await h.hosted.get(h.read, "b")).toBeDefined();
    expect(h.ended.calls).toEqual([{ id: "a-kid", why: "revoked", now: T0 + 5 }]);
    expect(h.hosted.takeEnded().map(e => e.id)).toEqual(["a-kid"]);
    // A grant with nothing on it ends nothing.
    await h.write(tx => ends.endForGrant(tx, "g-none", T0 + 6));
    expect(await h.hosted.get(h.read, "b")).toBeDefined();
    // The user's: b and its child, with the reason given; v's next root stays.
    await child(h, "b-kid", b);
    const w = await root(h, "w", v);
    await h.write(tx => ends.endForUser(tx, u, "disabled", T0 + 7));
    for (const id of ["b", "b-kid"]) expect(await h.hosted.get(h.read, id)).toBeUndefined();
    expect(await h.ownership(b.ownership_id)).toMatchObject({ ended_at: T0 + 7, end_reason: "disabled" });
    expect(await h.hosted.get(h.read, "w")).toBeDefined();
    expect(await h.ownership(w.ownership_id)).toMatchObject({ ended_at: null });
    expect(h.ended.calls.slice(1)).toEqual([{ id: "b-kid", why: "disabled", now: T0 + 7 }]);
    await h.write(tx => ends.endForUser(tx, v, "revoked", T0 + 8));
    expect(await h.ownership(w.ownership_id)).toMatchObject({ ended_at: T0 + 8, end_reason: "revoked" });
  });

  // seq, not the heap: inserts land in the heap in seq order, and a re-arm's update is HOT, so its tuple keeps its
  // place; CLUSTER rewrites the heap in alias order, which a scan (and an UPDATE's RETURNING) then follows.
  withStore("lost holds read and take by (at, seq) where the heap's order differs", async h => {
    const u = await h.seedUser(ME);
    await root(h, "r", u);
    for (const alias of ["b", "a", "c"]) await h.write(tx => h.hosted.lose(tx, "r", { alias, reason: "x", primary: false }, T0));
    await h.db.sql`CLUSTER hosted_alias_lost USING hosted_alias_lost_pkey`;
    expect((await h.db.sql`SELECT alias FROM hosted_alias_lost WHERE session_id = 'r'`).map((r: Row) => r.alias)).toEqual(["a", "b", "c"]);
    const order = (l: { alias: string }[]) => l.map(x => x.alias);
    expect(order(await h.hosted.lost(h.read, "r", "agent"))).toEqual(["b", "a", "c"]);
    expect(order(await h.write(tx => h.hosted.tellLost(tx, "r", T0 + 1)))).toEqual(["b", "a", "c"]);
    expect(order(await h.write(tx => h.hosted.reportLost(tx, "r", T0 + 2)))).toEqual(["b", "a", "c"]);
    expect(order(await h.write(tx => h.hosted.seeLost(tx, "r", T0 + 3)))).toEqual(["b", "a", "c"]);
  });

  // The port says whether it ended the ID; one already ended (a racing end got there first) wakes nobody again.
  withStore("childEnd queues nothing for a child whose ID the port did not end", async h => {
    const u = await h.seedUser(ME);
    const r = await root(h, "r", u);
    await child(h, "c", r);
    await h.seedIds("c", { rootId: "r", endedAt: T0 - 1 });
    await h.write(tx => h.hosted.childEnd(tx, "c", T0 + 1, "closed"));
    expect(await h.hosted.get(h.read, "c")).toBeUndefined();
    expect(h.ended.calls).toEqual([{ id: "c", why: "closed", now: T0 + 1 }]);
    expect(await h.idEnded("c")).toBe(T0 - 1);
    expect(h.hosted.takeEnded()).toEqual([]);
  });

  withStore("the seams hold their locks to the body's end: lock a child's root and the child, grantLive the grant, lockCapacity the advisory key", async h => {
    const u = await h.seedUser(ME);
    await h.seedGrant("live", u, T0 + 10);
    const r = await root(h, "r", u);
    await child(h, "c", r);
    await root(h, "other", u);
    const seen = await h.write(async tx => {
      await h.hosted.lock(tx, "c");
      await h.hosted.grantLive(tx, "live", T0);
      await h.hosted.lockCapacity(tx);
      return [await probe(h, "row", "r"), await probe(h, "row", "c"), await probe(h, "row", "other"), await probe(h, "grant", "live"), await probe(h, "capacity", "")];
    });
    expect(seen).toEqual(["55P03", "55P03", "free", "55P03", "held"]);
    // A root locks itself only; everything is free once the body ends.
    expect(await h.write(async tx => { await h.hosted.lock(tx, "r"); return [await probe(h, "row", "r"), await probe(h, "row", "c")]; })).toEqual(["55P03", "free"]);
    expect([await probe(h, "row", "r"), await probe(h, "grant", "live"), await probe(h, "capacity", "")]).toEqual(["free", "free", "free"]);
  });

  withStore("end and childEnd lock their row before judging it: a refused guard still holds it", async h => {
    const u = await h.seedUser(ME);
    const r = await root(h, "r", u, { lease_deadline: T0 + 10, last_seen_at: T0 + 5 });
    await child(h, "c", r);
    for (const [name, end] of [
      ["deadline", (tx: Tx) => h.hosted.end(tx, "r", "expired", T0 + 20, T0 + 9)],
      ["idle", (tx: Tx) => h.hosted.end(tx, "r", "idle", T0 + 20, undefined, T0 + 5)],
    ] as const) {
      expect(`${name}: ${await h.write(async tx => [await end(tx), await probe(h, "row", "r")].join(" "))}`).toBe(`${name}: false 55P03`);
    }
    expect(await h.write(async tx => { await h.hosted.childEnd(tx, "c", T0 + 20, "evicted"); return probe(h, "row", "c"); })).toBe("55P03");
    expect(await h.hosted.get(h.read, "c")).toBeDefined();
  });

  // The nested sweep inside `full()` holds the capacity lock: its ends and parks skip a row another body holds rather
  // than wait on it (the C8a audit's lock order: capacity last). Outside the capacity lock they wait (C8b2's races).
  withStore("under the capacity lock, end, childEnd and park skip a row another transaction holds, and write nothing", async h => {
    const u = await h.seedUser(ME);
    const r = await root(h, "r", u, { last_seen_at: T0 });
    await child(h, "c", r, { last_seen_at: T0 });
    await h.seedIds("c", { rootId: "r" });
    const other = await h.db.sql.reserve();
    try {
      await other`BEGIN`;
      await other`SELECT 1 FROM hosted_sessions WHERE session_id IN ('r', 'c') FOR UPDATE`;
      const got = await h.write(async tx => {
        await h.hosted.lockCapacity(tx);
        return [await h.hosted.end(tx, "r", "idle", T0 + 50, undefined, T0 + 1), await h.hosted.park(tx, "c", T0 + 50, T0 + 1),
          await h.hosted.childEnd(tx, "c", T0 + 50, "closed")];
      });
      expect(got).toEqual([false, false, undefined]);
    } finally {
      await other`ROLLBACK`;
      other.release();
    }
    expect((await h.hosted.get(h.read, "r"))?.session_id).toBe("r");
    expect((await h.hosted.get(h.read, "c"))?.parked_at).toBeNull();
    expect(h.ended.calls).toEqual([]);
    expect(h.hosted.takeEnded()).toEqual([]);
    // Free again: the same calls under the lock act.
    expect(await h.write(async tx => { await h.hosted.lockCapacity(tx); return h.hosted.park(tx, "c", T0 + 50, T0 + 1); })).toBe(true);
    expect(await h.write(async tx => { await h.hosted.lockCapacity(tx); return h.hosted.end(tx, "r", "idle", T0 + 60, undefined, T0 + 1); })).toBe(true);
    expect(h.hosted.takeEnded().map(e => e.id)).toEqual(["c"]);
  });
});
