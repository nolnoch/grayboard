// #807 P3 C1: the classifier against errors a real Postgres raises through Bun.SQL. The constructed errors in
// errors.test.ts would keep passing if a Bun upgrade moved the SQLSTATE or the constraint name; these would not.
import { expect, test } from "bun:test";
import { describePg, pgDatabase, pgEmptyDatabase, type PgDatabase } from "../../../../tests/support/pg.ts";
import { MissingParent } from "../errors.ts";
import { missingParent, pgFailure } from "./errors.ts";

const failure = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return pgFailure(e) ?? { unclassified: String(e) }; }
  throw new Error("expected the statement to fail");
};

async function scratch(): Promise<PgDatabase> {
  const db = await pgEmptyDatabase({ max: 4 });
  await db.sql.unsafe(`
    CREATE TABLE parent (id int4 PRIMARY KEY, v int4 NOT NULL DEFAULT 0);
    CREATE TABLE child (id int4 PRIMARY KEY, p int4 REFERENCES parent(id), u text, CONSTRAINT child_u_key UNIQUE (u));
    INSERT INTO parent (id) VALUES (1), (2);
    INSERT INTO child (id, p, u) VALUES (1, 1, 'a');
  `);
  return db;
}

describePg("SQLSTATEs as Bun.SQL reports them", () => {
  test("23505 and 23503 carry their constraint names", async () => {
    await using db = await scratch();
    expect(await failure(db.sql`INSERT INTO child (id, u) VALUES (2, 'a')`)).toEqual({ kind: "unique", constraint: "child_u_key" });
    expect(await failure(db.sql`INSERT INTO child (id, p) VALUES (3, 99)`)).toEqual({ kind: "foreign_key", constraint: "child_p_fkey" });
  });

  // #807 P3 C5b: the messages store's backstop. The migrated schema's own constraint name, so a rename fails here.
  test("23503 on messages_parent_id_fkey classifies as MissingParent; another constraint's doesn't", async () => {
    await using db = await pgDatabase({ max: 2 });
    let caught: unknown;
    try { await db.sql`INSERT INTO messages (sender, recipient_type, recipient, body, parent_id, created_at) VALUES ('a', 'user', 'b', 'x', 99, 0)`; }
    catch (e) { caught = e; }
    const m = missingParent(caught, 99);
    expect(m).toBeInstanceOf(MissingParent);
    expect(m?.message).toBe("parent_id 99 is not a message you sent or received");
    await using other = await scratch();
    try { await other.sql`INSERT INTO child (id, p) VALUES (3, 99)`; } catch (e) { caught = e; }
    expect(missingParent(caught, 99)).toBeUndefined();
  });

  test("an error a body swallows without a savepoint aborts the transaction (25P02); inside a savepoint it doesn't", async () => {
    await using db = await scratch();
    const swallowed = db.sql.begin(async tx => {
      try { await tx`INSERT INTO child (id, u) VALUES (2, 'a')`; } catch { /* swallowed */ }
      await tx`SELECT 1`;
    });
    expect(await failure(swallowed)).toEqual({ kind: "aborted" });
    // Nothing after the swallowed error: the COMMIT is answered with ROLLBACK, which Bun reports with no SQLSTATE.
    const silent = db.sql.begin(async tx => {
      try { await tx`INSERT INTO child (id, u) VALUES (2, 'a')`; } catch { /* swallowed */ }
    });
    expect(await failure(silent)).toEqual({ kind: "aborted" });
    expect((await db.sql`SELECT count(*)::int4 AS n FROM child`)[0].n).toBe(1);
    const saved = await db.sql.begin(async tx => {
      try { await tx.savepoint(sp => sp`INSERT INTO child (id, u) VALUES (2, 'a')`); } catch { /* rolled back to the savepoint */ }
      const [r] = await tx`SELECT count(*)::int4 AS n FROM child`;
      return r.n;
    });
    expect(saved).toBe(1);
  });

  test("55P03 from FOR UPDATE NOWAIT on a row another transaction holds", async () => {
    await using db = await scratch();
    const holder = await db.sql.reserve();
    try {
      await holder`BEGIN`;
      await holder`SELECT id FROM parent WHERE id = 1 FOR UPDATE`;
      expect(await failure(db.sql`SELECT id FROM parent WHERE id = 1 FOR UPDATE NOWAIT`)).toEqual({ kind: "lock_unavailable" });
      await holder`ROLLBACK`;
    } finally { holder.release(); }
  });

  test("40P01 from two transactions locking two rows in opposite orders", async () => {
    await using db = await scratch();
    const a = await db.sql.reserve(), b = await db.sql.reserve();
    try {
      await a`BEGIN`; await b`BEGIN`;
      await a`UPDATE parent SET v = 1 WHERE id = 1`;
      await b`UPDATE parent SET v = 1 WHERE id = 2`;
      const results = await Promise.allSettled([a`UPDATE parent SET v = 2 WHERE id = 2`, b`UPDATE parent SET v = 2 WHERE id = 1`]);
      const failed = results.filter(r => r.status === "rejected").map(r => pgFailure((r as PromiseRejectedResult).reason));
      expect(failed).toEqual([{ kind: "conflict", sqlstate: "40P01" }]);
      await a`ROLLBACK`; await b`ROLLBACK`;
    } finally { a.release(); b.release(); }
  });

  test("40001 from SERIALIZABLE write skew", async () => {
    await using db = await scratch();
    const a = await db.sql.reserve(), b = await db.sql.reserve();
    try {
      await a`BEGIN ISOLATION LEVEL SERIALIZABLE`; await b`BEGIN ISOLATION LEVEL SERIALIZABLE`;
      await a`SELECT sum(v) FROM parent`; await b`SELECT sum(v) FROM parent`;
      await a`UPDATE parent SET v = v + 1 WHERE id = 1`;
      await b`UPDATE parent SET v = v + 1 WHERE id = 2`;
      await a`COMMIT`;
      expect(await failure(b`COMMIT`)).toEqual({ kind: "conflict", sqlstate: "40001" });
    } finally { a.release(); b.release(); }
  });
});
