// #1510 chunk 2: the Postgres store's guard on keyed write bodies (docs/future/postgres-server.md D4). A keyed body's
// transaction carries its keys, savepoints included; the stores refuse an id-allocating insert unless the body holds
// that stream's key, refuse the capacity lock outright, and a keyed body that wrote an auth table rolls back. Each
// refusal names the operation and the keys. Without GRAYBOARD_TEST_PG_URL it skips.
import { expect, test } from "bun:test";
import { describePg, pgDatabase } from "../../../../tests/support/pg.ts";
import { until } from "../../../../tests/support/until.ts";
import { MESSAGE_LIMITS } from "../messages.contract.ts";
import type { Tx } from "../tx_base.ts";
import { makePgBoards } from "./boards.ts";
import { makePgHosted } from "./hosted.ts";
import { makePgMessages } from "./messages.ts";
import { DEFAULT_DATABASE_WRITERS } from "../queue.ts";
import { makePgTransactions, type PgTransactions } from "./tx.ts";

const T0 = 1_800_000_000_000;
const messages = makePgMessages({ clock: () => T0, attachmentLimits: MESSAGE_LIMITS });
const boards = makePgBoards({ clock: () => T0 });
// lockCapacity reaches no session end.
const hosted = makePgHosted({ sessionEnd: undefined as never });

const post = (board: string) => ({ board, author: "a@example.com/fe", body: "p", parentId: null, now: T0, expiresAt: null, authorId: null, via: null, authorUser: "a@example.com", human: false });
const rejection = async (p: Promise<unknown>): Promise<Error> => {
  try { await p; } catch (e) { return e as Error; }
  throw new Error("expected a rejection");
};

async function store(opts: { ownAuthCommit?: () => void } = {}): Promise<{ s: PgTransactions; sql: Awaited<ReturnType<typeof pgDatabase>>["sql"]; [Symbol.asyncDispose](): Promise<void> }> {
  const db = await pgDatabase({ max: 2 });
  const s = makePgTransactions(db.url, { max: 2, writers: 2, applicationName: "gb-test-keyed", ...opts });
  return { s, sql: db.sql, async [Symbol.asyncDispose]() { await s.close(); await db[Symbol.asyncDispose](); } };
}

describePg("keyed write bodies (Postgres store guard)", () => {
  // #1520 L4: tests reach production's W through the default; W = 1 stays the explicit single-queue control.
  // Mutation: makePgTransactions' default back to 1 (the default's cap is 1).
  test("a store with no writers option runs at DEFAULT_DATABASE_WRITERS; writers 1 runs disjoint keyed bodies one at a time", async () => {
    const db = await pgDatabase({ max: 2 });
    const d = makePgTransactions(db.url, { max: 2, applicationName: "gb-test-keyed" });
    const one = makePgTransactions(db.url, { max: 2, writers: 1, applicationName: "gb-test-keyed" });
    try {
      expect(DEFAULT_DATABASE_WRITERS).toBe(4);
      expect(d.queue.cap).toBe(DEFAULT_DATABASE_WRITERS);
      let release!: () => void;
      const held = new Promise<void>(r => { release = r; });
      const a = one.writeKeyed(["root:a"], () => held);
      const b = one.writeKeyed(["root:b"], () => null);
      await until(() => one.queue.waiting === 1, 5000, "root:b queued behind root:a at writers 1");
      release();
      await Promise.all([a, b]);
    } finally { await d.close(); await one.close(); await db[Symbol.asyncDispose](); }
  });

  // Mutation: drop messages.ts insert's refuseKeyed (the keyed insert commits).
  test("messages.insert refuses a keyed body without the recipient's dm key, naming the keys; with it, and in an exclusive body, it inserts", async () => {
    await using x = await store();
    const e = await rejection(x.s.writeKeyed(["root:a", "root:b"], tx => messages.insert(tx, "a@example.com/fe", "user", "a@example.com/be", "hi", null)));
    expect(e.message).toBe("messages.insert refused in a keyed write body (keys root:a, root:b) without the key dm:a@example.com/be: it runs in an exclusive body (write) (docs/future/postgres-server.md D4)");
    // Through a savepoint: the keys are the transaction's, not the handle's.
    const sp = await rejection(x.s.writeKeyed(["root:a"], tx => tx.savepoint(inner => messages.insert(inner, "a@example.com/fe", "user", "a@example.com/be", "sp", null))));
    expect(sp.message).toContain("messages.insert refused in a keyed write body (keys root:a)");
    await x.s.writeKeyed(["root:a", "dm:a@example.com/be"], tx => messages.insert(tx, "a@example.com/fe", "user", "a@example.com/be", "keyed", null));
    await x.s.write(tx => messages.insert(tx, "a@example.com/fe", "user", "a@example.com/be", "exclusive", null));
    expect((await x.sql`SELECT body FROM messages ORDER BY id`).map((r: { body: string }) => r.body)).toEqual(["keyed", "exclusive"]);
  });

  // Mutation: drop messages.ts bounce's refuseKeyed (the keyed bounce commits).
  test("messages.bounce, an insert too, refuses a keyed body without the bounced-to dm key", async () => {
    await using x = await store();
    const parent = await x.s.write(tx => messages.insert(tx, "a@example.com/be", "user", "a@example.com/fe", "q", null));
    const e = await rejection(x.s.writeKeyed(["root:a"], tx => messages.bounce(tx, "a@example.com/fe", "a@example.com/be", parent.id, "gone", T0)));
    expect(e.message).toContain("messages.bounce refused in a keyed write body (keys root:a) without the key dm:a@example.com/be");
    expect(await x.s.writeKeyed(["dm:a@example.com/be"], tx => messages.bounce(tx, "a@example.com/fe", "a@example.com/be", parent.id, "gone", T0))).not.toBeNull();
  });

  // Mutation: drop boards.ts insertPost's refuseKeyed (the keyed post commits).
  test("boards.insertPost refuses a keyed body without the board's key; with it, it inserts", async () => {
    await using x = await store();
    await x.sql`INSERT INTO boards (name, purpose, created_by, created_at) VALUES ('e2e', '', 'a@example.com/fe', 0)`;
    const e = await rejection(x.s.writeKeyed(["root:a", "board:other"], tx => boards.insertPost(tx, post("e2e"))));
    expect(e.message).toBe("boards.insertPost refused in a keyed write body (keys root:a, board:other) without the key board:e2e: it runs in an exclusive body (write) (docs/future/postgres-server.md D4)");
    expect((await x.s.writeKeyed(["board:e2e"], tx => boards.insertPost(tx, post("e2e")))).board).toBe("e2e");
    expect((await x.sql`SELECT count(*)::int AS n FROM posts`)[0].n).toBe(1);
  });

  // Mutation: drop hosted.ts lockCapacity's refuseKeyed (the keyed body takes the lock and commits).
  test("hosted.lockCapacity refuses every keyed body, through a savepoint too; an exclusive body takes it", async () => {
    await using x = await store();
    const e = await rejection(x.s.writeKeyed(["root:a"], tx => hosted.lockCapacity(tx)));
    expect(e.message).toBe("hosted.lockCapacity refused in a keyed write body (keys root:a): it runs in an exclusive body (write) (docs/future/postgres-server.md D4)");
    const sp = await rejection(x.s.writeKeyed(["root:a"], tx => tx.savepoint(inner => hosted.lockCapacity(inner))));
    expect(sp.message).toContain("hosted.lockCapacity refused in a keyed write body (keys root:a)");
    await x.s.write(tx => hosted.lockCapacity(tx));
  });

  // Mutation: drop tx.ts's keyed auth-mark refusal (the keyed user row commits and the generation is bumped).
  test("a keyed body that writes an auth table rolls back with an error naming its keys; an exclusive one commits and bumps the generation", async () => {
    let bumps = 0;
    await using x = await store({ ownAuthCommit: () => { bumps++; } });
    const user = (email: string) => async (tx: Tx) => { await (tx as unknown as { txn: { conn: Awaited<ReturnType<typeof pgDatabase>>["sql"] } }).txn.conn`INSERT INTO users (email, created_at) VALUES (${email}, 0)`; };
    const e = await rejection(x.s.writeKeyed(["root:a"], user("keyed@example.com")));
    expect(e.message).toBe("a keyed write body (keys root:a) wrote an auth table (gb.auth_touched): auth-table writers run in an exclusive body (write); rolled back (docs/future/postgres-server.md D4, D5)");
    expect(bumps).toBe(0);
    // Without a listener for the mark the keyed body still reads it.
    await using y = await store();
    expect((await rejection(y.s.writeKeyed(["root:b"], user("unheard@example.com")))).message).toContain("keyed write body (keys root:b) wrote an auth table");
    expect((await y.sql`SELECT count(*)::int AS n FROM users`)[0].n).toBe(0);
    // An auth write a savepoint rolled back leaves no mark (ROLLBACK TO undoes it): the keyed body commits.
    await x.s.writeKeyed(["root:a"], async tx => { await tx.savepoint(async sp => { await user("undone@example.com")(sp); throw new Error("undo"); }).catch(() => {}); });
    await x.s.write(user("exclusive@example.com"));
    expect(bumps).toBe(1);
    expect((await x.sql`SELECT email FROM users ORDER BY email`).map((r: { email: string }) => r.email)).toEqual(["exclusive@example.com"]);
  });
});
