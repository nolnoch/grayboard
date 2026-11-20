// #807 P3 C10a-b: the bindings store's races on Postgres (c10-scope §2 T1-T6, docs/future/postgres-server.md D3), each
// in T-P12's shape (tests/support/pg_race.ts): A's body holds its transaction open at a gate, B's starts, and the race
// waits until B is blocked on a lock or done. The end state is asserted before `waited`, so a race whose lock is gone
// fails on what it broke (an overwritten hold, a hold for an ended ID, a raw 23505, a lost tombstone, a lost label
// update), not on a timeout. Each names the mutation it must catch. The alias-lock races against a delete and a
// tools-only root's writes_as (T-C5-4…6) are aliases.pg.test.ts's. On SQLite none of these interleave: the single
// writer runs each body whole. Without GRAYBOARD_TEST_PG_URL they skip.
import { expect, test } from "bun:test";
import { describePg } from "../../../../tests/support/pg.ts";
import { committed, outcome, pgPair, race, type PgPair } from "../../../../tests/support/pg_race.ts";
import { IdCollision } from "../../../core/errors.ts";
import type { IdFacts } from "../bindings.ts";
import type { Tx } from "../tx_base.ts";
import { makePgAliases } from "./aliases.ts";
import { makePgBindings } from "./bindings.ts";
import { pgOf } from "./tx.ts";

const CLOCK = 1_800_000_000_000;
const U = "you@example.com";
const X = `${U}/x`;
const [S1, S2] = ["id:0000000000001", "id:0000000000002"];
const al = makePgAliases({ clock: () => CLOCK });
const b = makePgBindings({ clock: () => CLOCK, aliases: al });

type Row = Record<string, unknown>;
const holds = async (p: PgPair) => (await p.db.sql`SELECT address, id, bound_at::int4 AS bound_at FROM alias_holds ORDER BY address`).map((r: Row) => ({ ...r }));
const facts = (id: string, more: Partial<IdFacts> = {}): IdFacts => ({ id, principal: U, launcher: false, ...more });
// One alias and two live sessions of one user.
async function world(p: PgPair) {
  await p.a.write(async tx => {
    await al.create(tx, { scope_kind: "person", scope_ref: U, name: "x" }, U);
    for (const id of [S1, S2]) await b.registerId(tx, facts(id));
  });
}
// The error a body's call rejects with, caught inside the body so the body goes on.
async function caught(f: () => Promise<unknown>): Promise<unknown> {
  try { await f(); } catch (e) { return e; }
  return undefined;
}

describePg("bindings store races (Postgres)", () => {
  // Mutation: the conflict WHERE dropped, or a read then an insert (B restamps A's hold and answers bound).
  test("T1: two IDs of one user take one alias: one holds it, the other gets null and its body goes on", async () => {
    await using p = await pgPair();
    await world(p);
    await p.a.write(tx => al.create(tx, { scope_kind: "person", scope_ref: U, name: "y" }, U));
    const r = await race(p, tx => b.take(tx, X, S1, U, 100), async tx => ({ x: await b.take(tx, X, S2, U, 200), y: await b.take(tx, `${U}/y`, S2, U, 200) }));
    expect(committed(r.a)).toEqual({ bound_at: 100 });
    expect(outcome(r.b)).toEqual({ x: null, y: { bound_at: 200 } });
    expect(await holds(p)).toEqual([{ address: X, id: S1, bound_at: 100 }, { address: `${U}/y`, id: S2, bound_at: 200 }]);
    expect(r.waited).toBe(true);
  });

  // Mutation: the conflict WHERE changed to refuse the same ID (B's re-take answers null).
  test("T2: one ID's two takes of one alias: both hold, and the second moves bound_at", async () => {
    await using p = await pgPair();
    await world(p);
    const r = await race(p, tx => b.take(tx, X, S1, U, 100), tx => b.take(tx, X, S1, U, 200));
    expect(committed(r.a)).toEqual({ bound_at: 100 });
    expect(outcome(r.b)).toEqual({ bound_at: 200 });
    expect(await holds(p)).toEqual([{ address: X, id: S1, bound_at: 200 }]);
    expect(r.waited).toBe(true);
  });

  // E4's lock shape (the full end-vs-take race is C10d2-b's): an end locks the ID's row FOR UPDATE, then marks it ended.
  // Mutation: take without the ids row's lock (it reads the row unended under the uncommitted end and holds X for an
  // ended ID); FOR SHARE in place of FOR KEY SHARE (the presence touch blocks it).
  test("T3: a take waits on an end's FOR UPDATE of its ID and then holds nothing; a presence touch doesn't block it", async () => {
    {
      await using p = await pgPair();
      await world(p);
      const end = async (tx: Tx) => {
        await pgOf(tx)`SELECT 1 FROM ids WHERE id = ${S1} FOR UPDATE`;
        await pgOf(tx)`UPDATE ids SET ended_at = 50 WHERE id = ${S1}`;
      };
      const r = await race(p, end, tx => b.take(tx, X, S1, U, 100));
      expect(outcome(r.b)).toBeNull();
      expect(await holds(p)).toEqual([]);
      expect(r.waited).toBe(true);
      expect(r.waitEvent).toBe("transactionid");
    }
    {
      await using p = await pgPair();
      await world(p);
      const r = await race(p, tx => b.touchId(tx, S1, 70), tx => b.take(tx, X, S1, U, 100));
      expect(outcome(r.b)).toEqual({ bound_at: 100 });
      expect(r.waited).toBe(false);
      expect(await holds(p)).toEqual([{ address: X, id: S1, bound_at: 100 }]);
    }
  });

  // Mutation: registerId as a plain INSERT (B fails 23505, its body aborts, and the write rejects TxAborted).
  test("T4: two registrations of one ID: the second gets IdCollision with the first's ended_at, and its body goes on", async () => {
    for (const endedAt of [null, 1_700_000_000_000]) {
      await using p = await pgPair();
      const first = async (tx: Tx) => {
        await b.registerId(tx, facts(S1, { harness: "first" }));
        if (endedAt !== null) await pgOf(tx)`UPDATE ids SET ended_at = ${endedAt} WHERE id = ${S1}`;
      };
      const r = await race(p, first, async tx => {
        const e = await caught(() => b.registerId(tx, facts(S1, { principal: "other@example.com", harness: "second" })));
        await b.registerId(tx, facts(S2));
        return { collision: e instanceof IdCollision, id: (e as IdCollision).id, endedAt: (e as IdCollision).endedAt };
      });
      committed(r.a);
      expect(outcome(r.b)).toEqual({ collision: true, id: S1, endedAt });
      expect((await p.db.sql`SELECT id, principal, harness FROM ids ORDER BY id`).map((x: Row) => ({ ...x })))
        .toEqual([{ id: S1, principal: U, harness: "first" }, { id: S2, principal: U, harness: null }]);
      expect(r.waited).toBe(true);
    }
  });

  // A stand-in for C10d1's sessionEnd.pruneEnded (core pruneEndedIds' two statements, as its Postgres form writes them):
  // the tombstone, then the delete. Mutation: registerId reads (consumes) the tombstone before its insert (it reads
  // none under the uncommitted prune and returns null, and the tombstone stays for an ID that is live again).
  test("T5: a registration racing a prune of the same keyed ID waits on the delete and returns the tombstone", async () => {
    await using p = await pgPair();
    const K = "id:000000000000K";
    await p.a.write(tx => b.registerId(tx, facts(K, { keyed: true })));
    await p.db.sql`UPDATE ids SET ended_at = 5 WHERE id = ${K}`;
    const prune = async (tx: Tx) => {
      await pgOf(tx)`INSERT INTO pruned_ids (id, ended_at, pruned_at) SELECT id, ended_at, 9 FROM ids WHERE ended_at < 10 AND keyed
        ON CONFLICT (id) DO UPDATE SET ended_at = EXCLUDED.ended_at, pruned_at = EXCLUDED.pruned_at`;
      return (await pgOf(tx)`DELETE FROM ids WHERE ended_at < 10 RETURNING id`).length;
    };
    const r = await race(p, prune, tx => b.registerId(tx, facts(K, { keyed: true })));
    expect(committed(r.a)).toBe(1);
    expect(outcome(r.b)).toEqual({ ended_at: 5, pruned_at: 9 });
    expect([...await p.db.sql`SELECT id FROM pruned_ids`]).toEqual([]);
    expect((await p.db.sql`SELECT id, ended_at FROM ids`).map((x: Row) => ({ ...x }))).toEqual([{ id: K, ended_at: null }]);
    expect(r.waited).toBe(true);
  });

  // Mutation: setMeta's or setIdFacts' read without FOR NO KEY UPDATE (B diffs against the values before A's commit: its
  // before misses A's after, and an equal value reads as a change).
  test("T6: two label writes on one alias, and two facts writes on one ID, diff against each other's commits", async () => {
    await using p = await pgPair();
    await world(p);
    const meta = (m: Parameters<typeof b.setMeta>[2]) => (tx: Tx) => b.setMeta(tx, X, m);
    // One field: B's before is A's after.
    let r = await race(p, meta({ task: "t1" }), meta({ task: "t2" }));
    expect(committed(r.a)).toEqual({ before: { task: null }, after: { task: "t1" } });
    expect(outcome(r.b)).toEqual({ before: { task: "t1" }, after: { task: "t2" } });
    expect(r.waited).toBe(true);
    // The same value again: no change.
    r = await race(p, meta({ owner: "o" }), meta({ owner: "o" }));
    expect(committed(r.a)).toEqual({ before: { owner: null }, after: { owner: "o" } });
    expect(outcome(r.b)).toBeNull();
    expect(r.waited).toBe(true);
    // Different fields: both land.
    r = await race(p, meta({ description: "d" }), meta({ spec_hash: "h" }));
    expect(outcome(r.b)).toEqual({ before: { spec_hash: null }, after: { spec_hash: "h" } });
    expect((await p.db.sql`SELECT task, owner, spec_hash, description FROM aliases WHERE address = ${X}`).map((x: Row) => ({ ...x })))
      .toEqual([{ task: "t2", owner: "o", spec_hash: "h", description: "d" }]);
    const model = (m: string) => (tx: Tx) => b.setIdFacts(tx, S1, { model: m });
    const f = await race(p, model("m2"), model("m3"));
    expect(committed(f.a)).toEqual({ before: { model: null, effort: null }, after: { model: "m2", effort: null } });
    expect(outcome(f.b)).toEqual({ before: { model: "m2", effort: null }, after: { model: "m3", effort: null } });
    expect(f.waited).toBe(true);
  });

  // E3, serially (the race against the root's end is C10d2-b's): a child of an ended root is refused, writing nothing;
  // a live root's child registers. The contract leaves this unpinned (SQLite registers it). Mutation: no root read.
  test("registerId refuses a child of an ended root and registers a live root's", async () => {
    await using p = await pgPair();
    await world(p);
    await p.db.sql`UPDATE ids SET ended_at = 5 WHERE id = ${S2}`;
    const child = (root: string) => p.a.write(tx => b.registerId(tx, facts("id:000000000000C", { rootId: root })));
    expect(outcome(await child(S2).then(v => ({ ok: true as const, value: v }), error => ({ ok: false as const, error }))))
      .toBe(`threw CoreError: root session ${S2} has ended; a child can't register under it`);
    expect([...await p.db.sql`SELECT id FROM ids WHERE id = 'id:000000000000C'`]).toEqual([]);
    expect(await child(S1)).toBeNull();
    expect((await p.db.sql`SELECT root_id FROM ids WHERE id = 'id:000000000000C'`)[0].root_id).toBe(S1);
  });

  // Byte order within one bound_at (HOLD_ORDER), as SQLite's binary collation gives it: "B" sorts before "a".
  test("holdsOf orders a bound_at tie by address in byte order", async () => {
    await using p = await pgPair();
    await world(p);
    await p.db.sql`INSERT INTO alias_holds (address, id, bound_at) VALUES (${`${U}/a`}, ${S1}, 1), (${`${U}/B`}, ${S1}, 1), (${`${U}/_`}, ${S1}, 1)`;
    expect(await b.holdsOf(p.a.read, S1)).toEqual([`${U}/B`, `${U}/_`, `${U}/a`]);
    expect(await b.holdsOfMany(p.a.read, [S1])).toEqual(new Map([[S1, [`${U}/B`, `${U}/_`, `${U}/a`]]]));
  });
});
