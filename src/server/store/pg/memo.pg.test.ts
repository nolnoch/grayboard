// #1618: the identity memo of a keyed Postgres body (tx.ts memoized). A repeated identity read inside one keyed body
// sends one statement and answers from the first read, even after another store committed a change (the pin); the
// body's own write to a memoized table, a row lock on one, and a ROLLBACK TO drop the memo, so the next read sees that
// commit. An exclusive body and the next keyed body read fresh. Without GRAYBOARD_TEST_PG_URL they skip.
import { expect, test } from "bun:test";
import { describePg } from "../../../../tests/support/pg.ts";
import { pgPair, type PgPair } from "../../../../tests/support/pg_race.ts";
import type { User } from "../identity.ts";
import type { Tx } from "../tx_base.ts";
import { makePgBoards } from "./boards.ts";
import { noHosted } from "./hosted_port.ts";
import { makePgIdentity, type PgIdentity } from "./identity.ts";
import { pgOf, sentOf } from "./tx.ts";

const A = "a@example.com", B = "b@example.com";
type Pair = PgPair & { g: PgIdentity };
const pair = async (): Promise<Pair> => Object.assign(await pgPair(), { g: makePgIdentity({ now: Date.now, hosted: noHosted }) });

async function seed(p: Pair): Promise<User> {
  return p.a.write(tx => p.g.users.upsertByEmail(tx, A, null));
}
// Disables `id` in a body of the other store, committed before this returns.
const disable = (p: Pair, id: number) => p.b.write(tx => p.g.users.setDisabled(tx, id, true));
// Runs `read` on tx and returns its answer with the statements it sent.
async function counted<T>(tx: Tx, read: () => Promise<T>): Promise<[T, number]> {
  const before = sentOf(tx)!;
  const v = await read();
  return [v, sentOf(tx)! - before];
}
const keyed = <T>(p: Pair, fn: (tx: Tx) => Promise<T>) => p.a.writeKeyed(["root:memo"], fn);

describePg("identity memo (Postgres, #1618)", () => {
  test("a keyed body's repeated user reads send one statement, by id and by email", async () => {
    await using p = await pair();
    const u = await seed(p);
    const sent = await keyed(p, async tx => [
      (await counted(tx, () => p.g.users.findById(tx, u.id)))[1],
      (await counted(tx, () => p.g.users.findById(tx, u.id)))[1],
      (await counted(tx, () => p.g.users.findByEmail(tx, A)))[1],
      (await counted(tx, () => p.g.principals.findByName(tx, A)))[1],
      (await counted(tx, () => p.g.principals.findByName(tx, A)))[1],
      (await counted(tx, () => p.g.teams.shareAny(tx, u.id, u.id)))[1],
      (await counted(tx, () => p.g.teams.shareAny(tx, u.id, u.id)))[1],
    ]);
    expect(sent).toEqual([1, 0, 0, 1, 0, 1, 0]);
  });

  test("two tasks of one body share the read in flight", async () => {
    await using p = await pair();
    const u = await seed(p);
    const sent = await keyed(p, async tx => (await counted(tx, () => Promise.all([p.g.users.findById(tx, u.id), p.g.users.findById(tx, u.id)])))[1]);
    expect(sent).toBe(1);
  });

  test("a keyed body keeps its first read past another store's commit; an exclusive body and the next keyed body see it", async () => {
    await using p = await pair();
    const u = await seed(p);
    const keyedSeen = await keyed(p, async tx => {
      await p.g.users.findById(tx, u.id);
      await disable(p, u.id);
      return [(await p.g.users.findById(tx, u.id))!.disabled_at, (await p.g.users.findByEmail(tx, A))!.disabled_at];
    });
    expect(keyedSeen).toEqual([null, null]);
    expect((await keyed(p, tx => p.g.users.findById(tx, u.id)))!.disabled_at).not.toBeNull();
    // Mutation: memo on exclusive bodies too (the Txn's memo built for every body) fails here.
    await p.b.write(tx => p.g.users.setDisabled(tx, u.id, false));
    const exclusiveSeen = await p.a.write(async tx => {
      await p.g.users.findById(tx, u.id);
      await disable(p, u.id);
      return (await p.g.users.findById(tx, u.id))!.disabled_at;
    });
    expect(exclusiveSeen).not.toBeNull();
  });

  // Each case: read, another store commits the disable, then the statement under test, then read again.
  const after = async (between: (tx: Tx) => Promise<unknown>) => {
    await using p = await pair();
    const u = await seed(p);
    return keyed(p, async tx => {
      await p.g.users.findById(tx, u.id);
      await disable(p, u.id);
      await between(tx);
      const [row, sent] = await counted(tx, () => p.g.users.findById(tx, u.id));
      return { fresh: row!.disabled_at !== null, sent };
    });
  };

  test("the body's own write naming a memoized table drops the memo", async () => {
    expect(await after(tx => pgOf(tx)`UPDATE boards SET purpose = purpose WHERE false`)).toEqual({ fresh: true, sent: 1 });
  });

  test("a row lock on a memoized table drops the memo", async () => {
    expect(await after(tx => pgOf(tx)`SELECT 1 FROM principals WHERE false FOR KEY SHARE`)).toEqual({ fresh: true, sent: 1 });
  });

  test("a savepoint's rollback drops the memo", async () => {
    expect(await after(tx => tx.savepoint(async () => { throw new Error("undo"); }).catch(() => {}))).toEqual({ fresh: true, sent: 1 });
  });

  test("a write to an unrelated table, and a plain read, keep the memo", async () => {
    // Mutation: stale() true for every non-SELECT (or every statement) fails here.
    expect(await after(async tx => {
      await pgOf(tx)`UPDATE sessions SET label = label WHERE false`;
      await pgOf(tx)`SELECT 1 FROM users WHERE false`;
    })).toEqual({ fresh: false, sent: 0 });
  });

  test("a miss is read again, and a caller's edit of a row doesn't reach the next caller", async () => {
    await using p = await pair();
    const u = await seed(p);
    const out = await keyed(p, async tx => {
      const misses = [(await counted(tx, () => p.g.users.findByEmail(tx, B)))[1], (await counted(tx, () => p.g.users.findByEmail(tx, B)))[1]];
      const first = (await p.g.users.findById(tx, u.id))!;
      first.email = "edited@example.com";
      return { misses, email: (await p.g.users.findById(tx, u.id))!.email };
    });
    expect(out).toEqual({ misses: [1, 1], email: A });
  });

  test("boards.get is memoized, and a lock read for a post drops it", async () => {
    await using p = await pair();
    const boards = makePgBoards({ clock: Date.now });
    await p.a.write(tx => pgOf(tx)`INSERT INTO boards (name, purpose, created_by, created_at, kind) VALUES ('b1', 'one', 'x', 1, 'board')`);
    const out = await keyed(p, async tx => {
      const sent = [(await counted(tx, () => boards.get(tx, "b1")))[1], (await counted(tx, () => boards.get(tx, "b1")))[1]];
      await p.b.write(tx2 => pgOf(tx2)`UPDATE boards SET purpose = 'two' WHERE name = 'b1'`);
      const pinned = (await boards.get(tx, "b1"))!.purpose;
      const locked = (await boards.lockForPost(tx, "b1"))!.purpose;
      return { sent, pinned, locked, after: (await boards.get(tx, "b1"))!.purpose };
    });
    expect(out).toEqual({ sent: [1, 0], pinned: "one", locked: "two", after: "two" });
  });
});
