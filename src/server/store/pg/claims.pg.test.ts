// #807 P3 C10b: the claims store's races on Postgres (c10-scope §2 K1-K6, docs/future/postgres-server.md D3), each in
// T-P12's shape (tests/support/pg_race.ts): A's body holds its transaction open at a gate, B's starts, and the race
// waits until B is blocked on a lock or done. The end state is asserted before `waited`, so a race whose guard is gone
// fails on what it broke (two holders, an ack of a claim another lane now holds, two expiry announcements, an orphan
// watch), not on a timeout. Each names the mutation it must catch. On SQLite none of these interleave: the single writer
// runs each body whole. Without GRAYBOARD_TEST_PG_URL they skip.
import { expect, test } from "bun:test";
import { describePg } from "../../../../tests/support/pg.ts";
import { committed, outcome, pgPair, race, type PgPair } from "../../../../tests/support/pg_race.ts";
import type { TakeRow } from "../claims.ts";
import type { Tx } from "../tx_base.ts";
import { makePgClaims } from "./claims.ts";

const T0 = 1_800_000_000_000;
const ME = "you@example.com";
const FE = `${ME}/fe`, BE = `${ME}/be`, SIM = `${ME}/sim`;
const K = "queue:jobs:1";
// The store's clock, far from T0 (every call's `now`): a method reading clock() in place of its argument fails a race.
const CLOCK = T0 + 1_000_000_000;
const cl = makePgClaims({ clock: () => CLOCK });

const take = (as: string, more: Partial<TakeRow> = {}): TakeRow => ({ key: K, as, note: null, board: null, now: T0, expires: T0 + 60_000, user: null, ...more });

async function claim(p: PgPair, key: string, holder: string, expires: number): Promise<void> {
  await p.db.sql`INSERT INTO claims (key, holder, note, board, acquired_at, expires_at) VALUES (${key}, ${holder}, 'held', NULL, 1, ${expires})`;
}
const holders = async (p: PgPair) => (await p.db.sql`SELECT key, holder FROM claims ORDER BY key`).map((r: Record<string, unknown>) => ({ ...r }));
const watches = async (p: PgPair) => (await p.db.sql`SELECT key, handle FROM claim_watches ORDER BY key, handle`).map((r: Record<string, unknown>) => ({ ...r }));
const events = async (p: PgPair) => (await p.db.sql`SELECT key, handle, event, note FROM claim_events ORDER BY id`).map((r: Record<string, unknown>) => ({ ...r }));

describePg("claims store races (Postgres)", () => {
  // Mutation: the take's conflict WHERE dropped, or a read then an insert (B overwrites A's claim, or fails 23505).
  test("K1: two takes of a new key: one holds it, the other is answered held and its body goes on", async () => {
    await using p = await pgPair();
    const r = await race(p, tx => cl.take(tx, take(FE)), async tx => ({ held: await cl.take(tx, take(BE)), next: (await cl.take(tx, take(BE, { key: "other" })))?.holder }));
    expect(committed(r.a)?.holder).toBe(FE);
    expect(outcome(r.b)).toEqual({ held: null, next: BE });
    expect(await holders(p)).toEqual([{ key: "other", holder: BE }, { key: K, holder: FE }]);
    expect(r.waited).toBe(true);
  });

  // Mutation: the take's conflict WHERE dropped (B, judging the lapsed row it read, takes over A's fresh claim).
  test("K2: two takeovers of a lapsed key: one holds it, the other is answered held", async () => {
    await using p = await pgPair();
    await claim(p, K, SIM, T0 - 1);
    const r = await race(p, tx => cl.take(tx, take(FE)), tx => cl.take(tx, take(BE)));
    expect(committed(r.a)).toMatchObject({ holder: FE, acquired_at: T0 });
    expect(outcome(r.b)).toBeNull();
    expect(await holders(p)).toEqual([{ key: K, holder: FE }]);
    expect(r.waited).toBe(true);
  });

  // K3, the old holder's ack after a takeover. core ackQueueClaim reads the row, checks its holder, then deletes by key:
  // under READ COMMITTED its read sees the old holder while the takeover is uncommitted, and its delete, waiting on the
  // takeover's row, then matches the new one. On SQLite the single writer runs the read and the delete with nothing
  // between them, so core's form can't meet a takeover there.
  // Mutation: core's read-then-DELETE-by-key form (it deletes the new holder's claim).
  test("K3a: a reply's ack racing a takeover of the lapsed claim (the upsert) deletes nothing and logs no ack", async () => {
    await using p = await pgPair();
    await claim(p, K, FE, T0 - 1);
    const r = await race(p, tx => cl.take(tx, take(BE)), tx => cl.ackQueue(tx, [FE], K, T0));
    expect(committed(r.a)?.holder).toBe(BE);
    expect(outcome(r.b)).toBe(false);
    expect(await holders(p)).toEqual([{ key: K, holder: BE }]);
    expect(await events(p)).toEqual([]);
    expect(r.waited).toBe(true);
  });

  // Mutation: core's read-then-DELETE form (its delete finds nothing, yet it answers acked and logs an ack release
  // for a post the redelivery gave another lane).
  test("K3b: a reply's ack racing a sweep's redelivery (expire, then the next lane's claim) acks nothing", async () => {
    await using p = await pgPair();
    await claim(p, K, FE, T0 - 1);
    const redeliver = async (tx: Tx) => {
      const gone = await cl.expire(tx, T0);
      await cl.take(tx, take(BE));
      return gone.map(c => c.key);
    };
    const r = await race(p, redeliver, tx => cl.ackQueue(tx, [FE], K, T0));
    expect(committed(r.a)).toEqual([K]);
    expect(outcome(r.b)).toBe(false);
    expect(await holders(p)).toEqual([{ key: K, holder: BE }]);
    expect(await events(p)).toEqual([]);
    expect(r.waited).toBe(true);
  });

  // Mutation: a SELECT of the lapsed rows then a DELETE (both pods return the row and announce it), or expire's
  // `expires_at <= now` dropped (the live claim goes too).
  test("K4: two sweeps expire one lapsed claim: one returns it and logs its expiry, the other gets nothing", async () => {
    await using p = await pgPair();
    await claim(p, "lapsed", FE, T0);
    await claim(p, "live", FE, T0 + 1);
    const sweep = async (tx: Tx) => {
      const gone = await cl.expire(tx, T0);
      for (const c of gone) await cl.logEvent(tx, "expire", c.holder, c, T0);
      return gone.map(c => c.key);
    };
    const r = await race(p, sweep, sweep);
    expect(committed(r.a)).toEqual(["lapsed"]);
    expect(outcome(r.b)).toEqual([]);
    expect(await holders(p)).toEqual([{ key: "live", holder: FE }]);
    expect(await events(p)).toEqual([{ key: "lapsed", handle: FE, event: "expire", note: "held" }]);
    expect(r.waited).toBe(true);
  });

  // claim_watch's store steps (serverWatch) and claim_release's (serverRelease).
  const watch = (handle: string) => async (tx: Tx) => {
    const c = await cl.liveForWatch(tx, K, T0);
    if (c) await cl.addWatch(tx, K, handle);
    return !!c;
  };
  const release = async (tx: Tx) => {
    const gone = await cl.release(tx, K, FE, T0);
    return { gone: gone?.key ?? null, told: gone ? await cl.takeWatchers(tx, K) : [] };
  };

  // Mutation: liveForWatch without FOR SHARE (the release doesn't wait, takes no watchers, and the watch commits after
  // it: a watch on a claim that's gone).
  test("K5a: a watch racing a release, watch first: the release waits and tells the watcher", async () => {
    await using p = await pgPair();
    await claim(p, K, FE, T0 + 1);
    const r = await race(p, watch(BE), release);
    expect(committed(r.a)).toBe(true);
    expect(outcome(r.b)).toEqual({ gone: K, told: [BE] });
    expect(await holders(p)).toEqual([]);
    expect(await watches(p)).toEqual([]);
    expect(r.waited).toBe(true);
  });

  // Mutation: liveForWatch without FOR SHARE (the watch reads the claim the uncommitted release deleted, and watches it).
  test("K5b: a watch racing a release, release first: the watch waits and finds no claim", async () => {
    await using p = await pgPair();
    await claim(p, K, FE, T0 + 1);
    const r = await race(p, release, watch(BE));
    expect(committed(r.a)).toEqual({ gone: K, told: [] });
    expect(outcome(r.b)).toBe(false);
    expect(await holders(p)).toEqual([]);
    expect(await watches(p)).toEqual([]);
    expect(r.waited).toBe(true);
  });

  // K6: takeWatchers is one DELETE … RETURNING, so the watchers it reports are exactly the watches it deleted. A watch
  // committed before its statement is deleted and told; one committed after stays, on a claim still live (a release
  // under it waits on liveForWatch's FOR SHARE, K5). A watch lost between a read and a delete needs a commit to land
  // between two statements, which no lock forces; the row below catches the same split form by its other symptom.
  test("K6a: a watch added while the watchers are taken stays, on the live claim: never deleted untold", async () => {
    await using p = await pgPair();
    await claim(p, K, FE, T0 + 1);
    await p.a.write(tx => cl.addWatch(tx, K, "w1"));
    const r = await race(p, tx => cl.addWatch(tx, K, "w2"), tx => cl.takeWatchers(tx, K));
    committed(r.a);
    expect(outcome(r.b)).toEqual(["w1"]);
    expect(await holders(p)).toEqual([{ key: K, holder: FE }]);
    expect(await watches(p)).toEqual([{ key: K, handle: "w2" }]);
  });

  // Mutation: takeWatchers as a SELECT then a DELETE (core's form): it reads w1 before w1's unwatch commits and tells
  // a watcher whose watch its delete never removed.
  test("K6b: an unwatch racing the watchers' take: the take waits and tells only the watches it deleted", async () => {
    await using p = await pgPair();
    await claim(p, K, FE, T0 + 1);
    await p.a.write(async tx => { await cl.addWatch(tx, K, "w1"); await cl.addWatch(tx, K, "w2"); });
    const r = await race(p, tx => cl.unwatch(tx, K, "w1"), tx => cl.takeWatchers(tx, K));
    committed(r.a);
    expect(outcome(r.b)).toEqual(["w2"]);
    expect(await watches(p)).toEqual([]);
    expect(r.waited).toBe(true);
  });

  // Not a race: list is the one method on the store's clock, which the contract can't pin portably (SQLite's core reads
  // Date.now()). Mutation: `expires_at > clock` → `>=` (a claim lapsing this instant listed as live).
  test("list: a claim expiring exactly at the store's clock has lapsed", async () => {
    await using p = await pgPair();
    await claim(p, "at", FE, CLOCK);
    await claim(p, "after", FE, CLOCK + 1);
    expect((await cl.list(p.a.read)).map(c => c.key)).toEqual(["after"]);
  });
});
