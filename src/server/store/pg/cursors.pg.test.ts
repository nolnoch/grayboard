// #807 P3 C67b: the read point's race on Postgres (c6c7-scope §5.2 T-C6-1/2, docs/future/postgres-server.md D3), in
// T-P12's shape (tests/support/pg_race.ts): A's advance holds its transaction open, B's starts, and the race waits until
// B is blocked on A's row (or uncommitted insert) or done. The end state is asserted before `waited`, so an advance
// that reads then writes fails on what it broke (a 23505 on a first insert, a read point moved back), not on a
// timeout. Without GRAYBOARD_TEST_PG_URL they skip.
import { expect, setDefaultTimeout, test } from "bun:test";
import { describePg } from "../../../../tests/support/pg.ts";
import { committed, outcome, pgPair, race, type PgPair } from "../../../../tests/support/pg_race.ts";
import { makePgCursors } from "./cursors.ts";

const A = "a@example.com/fe";
const cursors = makePgCursors();
const advance = (id: number) => (tx: Parameters<typeof cursors.advance>[0]) => cursors.advance(tx, A, "direct", A, id);
const readPoint = (p: PgPair) => cursors.directFor(p.a.read, A);

// Above the pool's 5 s lock_timeout (pg/tx.ts), so a wait a broken lock leaves fails 55P03, not on Bun's 5 s timeout.
setDefaultTimeout(30_000);

describePg("read point races (Postgres)", () => {
  // Mutation: advance as a read then a write in JS (B's first insert fails 23505 on mailbox_cursors_pkey).
  test("T-C6-1: two first advances of one read point, 10 and 5 in both orders: it ends at 10", async () => {
    for (const [first, second] of [[10, 5], [5, 10]] as const) {
      await using p = await pgPair();
      const r = await race(p, advance(first), advance(second));
      committed(r.a);
      expect(outcome(r.b)).toBeUndefined();
      expect(await readPoint(p)).toBe(10);
      expect(r.waitEvent).toBe("transactionid");
    }
  });

  // Mutation: advance as a read then a write in JS (B read 1 before A's 10 committed, and writes 5 over it).
  test("T-C6-2: advances of an existing read point, 10 (A) against 5 (B): it ends at 10", async () => {
    await using p = await pgPair();
    await p.a.write(advance(1));
    const r = await race(p, advance(10), advance(5));
    committed(r.a);
    expect(outcome(r.b)).toBeUndefined();
    expect(await readPoint(p)).toBe(10);
    expect(r.waitEvent).toBe("transactionid");
  });
});
