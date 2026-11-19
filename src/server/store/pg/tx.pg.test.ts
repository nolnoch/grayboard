// #807 P3 C2: the Postgres store's transactions. The backend-neutral contract (tx.contract.ts) runs here on Postgres,
// then the behaviour only Postgres has: aborted transactions, commit-time failures, a dropped connection, the
// read-only pool, pinned isolation, lock_timeout and the two-store race shape later store ports copy.
// Each test gets its own database; without GRAYBOARD_TEST_PG_URL they skip (tests/support/pg.ts).
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { describePg, pgEmptyDatabase, type PgDatabase } from "../../../../tests/support/pg.ts";
import { commitCutProxy } from "../../../../tests/support/pg_proxy.ts";
import { until } from "../../../../tests/support/until.ts";
import { txContract, type TxBackend } from "../tx.contract.ts";
import { sqliteOf, sqliteRead } from "../tx.ts";
import type { Read, Tx } from "../tx_base.ts";
import { makePgTransactions, pgOf, TxAborted, type PgTransactions } from "./tx.ts";

// Written as a store function will be: a plain `await` on pgOf's statement, which pgOf sends as it's built.
const put = async (tx: Tx, v: string) => { await pgOf(tx)`INSERT INTO t (v) VALUES (${v})`; };
const rows = async (r: Read) => (await pgOf(r)`SELECT v FROM t ORDER BY seq`).map((x: { v: string }) => x.v) as string[];
const tick = () => new Promise<void>(r => setTimeout(r, 0));

function gate(): { wait: Promise<void>; open(): void } {
  let open!: () => void;
  const wait = new Promise<void>(r => { open = r; });
  return { wait, open };
}

async function capturingErrors(fn: (logged: unknown[][]) => Promise<void>): Promise<unknown[][]> {
  const logged: unknown[][] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try { await fn(logged); } finally { console.error = error; }
  return logged;
}

const rejection = async (p: Promise<unknown>): Promise<any> => {
  try { await p; } catch (e) { return e; }
  throw new Error("expected a rejection");
};

// A scratch database with the contract's table, and a store on it. `db.sql` is the database's own read-write pool:
// the test's admin and second reader.
async function scratch(opts: { max?: number; app?: string } = {}): Promise<{ db: PgDatabase; s: PgTransactions; [Symbol.asyncDispose](): Promise<void> }> {
  const db = await pgEmptyDatabase({ max: 4 });
  await db.sql`CREATE TABLE t (seq int8 GENERATED ALWAYS AS IDENTITY, v text)`;
  const s = makePgTransactions(db.url, { max: opts.max ?? 4, applicationName: opts.app ?? "gb-test-tx" });
  return { db, s, async [Symbol.asyncDispose]() { await s.close(); await db[Symbol.asyncDispose](); } };
}

const pgBackend: TxBackend = {
  postRunsNow: { idle: false, holder: false },
  async open() {
    const { db, s, [Symbol.asyncDispose]: dispose } = await scratch();
    void db;
    return {
      write: s.write, post: s.post, read: s.read, queue: s.queue,
      put, rows,
      inTransaction: s.inTransaction,
      drain: () => s.write(() => {}),
      close: dispose,
    };
  },
};

describePg("contract (Postgres)", () => txContract(pgBackend, "all"));

describePg("Postgres transactions", () => {
  test("T-P1 a body that swallows a statement error and runs another rejects TxAborted (25P02); nothing runs after", async () => {
    await using x = await scratch();
    const seen: string[] = [];
    const e = await rejection(x.s.write(async tx => {
      tx.afterCommit(() => { seen.push("effect"); });
      await put(tx, "before");
      try { await pgOf(tx)`SELECT 1/0`; } catch { /* swallowed without a savepoint */ }
      await put(tx, "after");
    }, () => { seen.push("committed"); }));
    expect(e).toBeInstanceOf(TxAborted);
    expect(e.name).toBe("TxAbortedError");
    expect(e.message).toContain("wrap the statement that may fail in tx.savepoint");
    expect(e.cause.errno).toBe("25P02");
    expect([e.code, e.errno]).toEqual(["ERR_POSTGRES_SERVER_ERROR", "25P02"]);
    expect(seen).toEqual([]);
    await x.s.write(tx => put(tx, "next"));
    expect(await rows(x.s.read)).toEqual(["next"]);
  });

  test("T-P2 a body that swallows a statement error and returns rejects TxAborted (rolled-back COMMIT), not success", async () => {
    await using x = await scratch();
    const seen: string[] = [];
    const logged = await capturingErrors(async () => {
      const e = await rejection(x.s.write(async tx => {
        tx.afterCommit(() => { seen.push("effect"); });
        await put(tx, "lost");
        try { await pgOf(tx)`SELECT 1/0`; } catch { /* swallowed */ }
        return 1;
      }, () => { seen.push("committed"); }));
      expect(e).toBeInstanceOf(TxAborted);
      expect(e.cause.code).toBe("ERR_POSTGRES_COMMIT_ROLLED_BACK");
    });
    // A rolled-back COMMIT is a known outcome.
    expect(logged).toEqual([]);
    expect(seen).toEqual([]);
    expect(await rows(x.s.read)).toEqual([]);
  });

  test("T-P3 a savepoint whose body swallows an error rejects TxAborted; its rows, effects and hooks go; the parent's stay", async () => {
    await using x = await scratch();
    const seen: string[] = [];
    let spError: any;
    await x.s.write(async tx => {
      await put(tx, "outer");
      tx.afterCommit(() => { seen.push("outer effect"); });
      tx.beforeCommit({}, async root => { seen.push("outer hook"); await put(root, "hook"); });
      spError = await rejection(tx.savepoint(async sp => {
        await put(sp, "inner");
        sp.afterCommit(() => { seen.push("inner effect"); });
        sp.beforeCommit({}, async () => { seen.push("inner hook"); });
        try { await pgOf(sp)`SELECT 1/0`; } catch { /* swallowed inside the savepoint */ }
      }));
      // The failed RELEASE was undone: the parent's transaction goes on.
      await put(tx, "after");
    });
    expect(spError).toBeInstanceOf(TxAborted);
    expect(spError.cause.errno).toBe("25P02");
    expect(await rows(x.s.read)).toEqual(["outer", "after", "hook"]);
    expect(seen).toEqual(["outer hook", "outer effect"]);
  });

  test("T-P4 a deferred constraint failing at COMMIT rejects the write (23503) with no effects, and releases the queue", async () => {
    await using x = await scratch();
    await x.db.sql.unsafe(`
      CREATE TABLE parent (id int4 PRIMARY KEY);
      CREATE TABLE child (p int4 REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);
    `);
    const seen: string[] = [];
    const logged = await capturingErrors(async () => {
      const e = await rejection(x.s.write(async tx => {
        await pgOf(tx)`INSERT INTO child (p) VALUES (99)`;
        await put(tx, "body");
        tx.afterCommit(() => { seen.push("effect"); });
      }, () => { seen.push("committed"); }));
      expect(e).not.toBeInstanceOf(TxAborted);
      expect(e.errno).toBe("23503");
    });
    expect(logged).toEqual([]);
    expect(seen).toEqual([]);
    expect(x.s.queue.held).toBe(false);
    expect(x.s.inTransaction()).toBe(false);
    await x.s.write(tx => put(tx, "next"));
    expect(await rows(x.s.read)).toEqual(["next"]);
  });

  test("T-P5 a connection killed mid-body rejects the write (57P01) with no effects; the next write succeeds", async () => {
    await using x = await scratch();
    const seen: string[] = [];
    const entered = gate(), resume = gate();
    let pid = 0;
    const w = x.s.write(async tx => {
      tx.afterCommit(() => { seen.push("effect"); });
      await put(tx, "lost");
      pid = (await pgOf(tx)`SELECT pg_backend_pid() AS p`)[0].p;
      entered.open();
      await resume.wait;
      await put(tx, "lost too");
    }, () => { seen.push("committed"); });
    await entered.wait;
    await x.db.sql`SELECT pg_terminate_backend(${pid})`;
    resume.open();
    expect((await rejection(w)).errno).toBe("57P01");
    expect(seen).toEqual([]);
    expect(x.s.queue.held).toBe(false);
    await x.s.write(tx => put(tx, "next"));
    expect(await rows(x.s.read)).toEqual(["next"]);
  });

  test("T-P6 effects flush after COMMIT resolves and before the queue's next body; committed sees the row from another pool", async () => {
    await using x = await scratch();
    const hold = gate();
    let flag = false;
    let effectRead: Promise<string[]> | undefined;
    const first = x.s.write(async tx => {
      await put(tx, "one");
      tx.afterCommit(() => {
        flag = true;
        // Started in the effect's synchronous part, on a connection outside the transaction: it sees the commit.
        effectRead = x.db.sql`SELECT v FROM t`.then((r: { v: string }[]) => r.map(y => y.v));
      });
      await hold.wait;
    }, async () => (await x.db.sql`SELECT v FROM t`).map((y: { v: string }) => y.v));
    const second = x.s.write(() => flag);
    hold.open();
    expect(await first).toEqual(["one"]);
    expect(await second).toBe(true);
    expect(await effectRead).toEqual(["one"]);
  });

  test("T-P7 isolation is READ COMMITTED and read-write on every BEGIN, whatever the database default", async () => {
    const db = await pgEmptyDatabase({ max: 2 });
    await db.sql.unsafe(`ALTER DATABASE "${db.name}" SET default_transaction_isolation = 'serializable'`);
    const s = makePgTransactions(db.url, { max: 2 });
    try {
      // The default took: the pool's own transactions are serializable and read-only.
      const [pool] = await pgOf(s.read)`SELECT current_setting('transaction_isolation') AS iso, current_setting('transaction_read_only') AS ro`;
      expect(pool).toEqual({ iso: "serializable", ro: "on" });
      const inBody = await s.write(async tx =>
        (await pgOf(tx)`SELECT current_setting('transaction_isolation') AS iso, current_setting('transaction_read_only') AS ro`)[0]);
      expect(inBody).toEqual({ iso: "read committed", ro: "off" });
    } finally { await s.close(); await db[Symbol.asyncDispose](); }
  });

  test("T-P8 the store's pool refuses writes (25006); a body's Tx writes", async () => {
    await using x = await scratch();
    expect((await rejection(pgOf(x.s.read)`INSERT INTO t (v) VALUES ('pool')`)).errno).toBe("25006");
    expect((await rejection(pgOf(x.s.read)`SELECT v FROM t FOR UPDATE`)).errno).toBe("25006");
    await x.s.write(tx => put(tx, "tx"));
    expect(await rows(x.s.read)).toEqual(["tx"]);
  });

  test("T-P9 on a one-connection pool, a body and its hook's savepoint run on the Tx; the store's Read refuses instead of hanging", async () => {
    await using x = await scratch({ max: 1 });
    const seen: string[][] = [];
    let refusal = "";
    await x.s.write(async tx => {
      await put(tx, "a");
      try { pgOf(x.s.read); } catch (e) { refusal = String(e); }
      tx.beforeCommit({}, async root => {
        seen.push(await root.savepoint(async sp => { await put(sp, "hook"); return rows(sp); }));
      });
    });
    expect(refusal).toContain("repo.read inside the caller's own transaction");
    expect(seen).toEqual([["a", "hook"]]);
    expect(await rows(x.s.read)).toEqual(["a", "hook"]);
  }, 15000);

  test("T-P3b a savepoint whose RELEASE is still in flight when its body returns is dropped with its effects", async () => {
    await using x = await scratch();
    const seen: string[] = [];
    let settled: Promise<unknown> = Promise.resolve();
    await x.s.write(async tx => {
      let inner!: Tx;
      settled = tx.savepoint(async sp => {
        inner = sp;
        sp.afterCommit(() => { seen.push("effect"); });
      }).catch(e => e);
      // The savepoint's Tx closes as its body settles, and the template sends RELEASE in the same synchronous step.
      // Microtasks only: the ack is socket I/O, which can't arrive until the body yields to the event loop.
      for (let i = 0; (inner as unknown as { live: boolean }).live; i++) {
        if (i > 1000) throw new Error("the savepoint's body never settled");
        await Promise.resolve();
      }
    });
    expect(String(await settled)).toContain("savepoint outlived its transaction");
    expect(seen).toEqual([]);
  });

  test("T-P10 pgOf refuses a SQLite handle, a plain object and a settled Tx; sqliteOf refuses a Postgres handle", async () => {
    await using x = await scratch();
    const sqlite = new Database(":memory:");
    try {
      expect(() => pgOf(sqliteRead(sqlite))).toThrow("not a Postgres store handle");
      expect(() => pgOf({} as Read)).toThrow("not a Postgres store handle");
      expect(() => sqliteOf(x.s.read)).toThrow("not a SQLite store handle");
    } finally { sqlite.close(); }
    let kept!: Tx;
    await x.s.write(tx => { kept = tx; });
    expect(() => pgOf(kept)).toThrow("Tx used after its transaction settled");
  });

  test("T-P11 a post from the holder's committed callback returns false and commits after the holder and the bodies waiting; its rejection is logged", async () => {
    await using x = await scratch();
    const hold = gate(), entered = gate();
    const order: string[] = [];
    let posted: boolean | undefined;
    const holder = x.s.write(async tx => { await put(tx, "holder"); entered.open(); await hold.wait; }, () => {
      posted = x.s.post(async t => { await tick(); await put(t, "posted"); }, () => { order.push("posted committed"); }, "holder post");
      order.push("holder committed");
    });
    await entered.wait;
    const waiter = x.s.write(tx => put(tx, "waiter"), () => { order.push("waiter committed"); });
    hold.open();
    await Promise.all([holder, waiter]);
    await x.s.write(() => {});
    expect(posted).toBe(false);
    expect(order).toEqual(["holder committed", "waiter committed", "posted committed"]);
    expect(await rows(x.s.read)).toEqual(["holder", "waiter", "posted"]);
    const logged = await capturingErrors(async logged => {
      await x.s.write(() => 1, () => {
        x.s.post(async t => { await put(t, "undone"); await tick(); throw new Error("posted late"); }, undefined, "holder post");
      });
      await until(() => logged.some(a => a[0] === "[grayboard] holder post failed:" && String(a[1]).includes("posted late")), 5000, "the holder's post failure to be logged");
    });
    expect(logged).toHaveLength(1);
    expect(await rows(x.s.read)).toEqual(["holder", "waiter", "posted"]);
  });

  // The shape a D3 race test takes (#807 §2.4): two stores on one database are two pools and two queues, so the second
  // writer bypasses the first's queue and meets it at the row lock, as an outside writer or a second pod would.
  test("T-P12 two stores: B's UPDATE waits on A's FOR UPDATE row lock until A commits", async () => {
    await using x = await scratch({ app: "gb-test-a" });
    const b = makePgTransactions(x.db.url, { max: 2, applicationName: "gb-test-b" });
    try {
      expect(b.queue).not.toBe(x.s.queue);
      await x.s.write(tx => put(tx, "row"));
      const locked = gate(), release = gate();
      const order: string[] = [];
      const a = x.s.write(async tx => {
        await pgOf(tx)`SELECT v FROM t WHERE seq = 1 FOR UPDATE`;
        locked.open();
        await release.wait;
        await pgOf(tx)`UPDATE t SET v = 'a' WHERE seq = 1`;
      }, () => { order.push("a"); });
      await locked.wait;
      const bw = b.write(async tx => { await pgOf(tx)`UPDATE t SET v = v || '+b' WHERE seq = 1`; }, () => { order.push("b"); });
      await until(async () => (await x.db.sql`SELECT 1 FROM pg_stat_activity
        WHERE datname = ${x.db.name} AND application_name = 'gb-test-b' AND wait_event_type = 'Lock'`).length > 0, 5000, "B's UPDATE to wait on A's row lock");
      expect(order).toEqual([]);
      release.open();
      await Promise.all([a, bw]);
      expect(order).toEqual(["a", "b"]);
      expect(await rows(x.s.read)).toEqual(["a+b"]);
    } finally { await b.close(); }
  });

  test("T-P13 lock_timeout: a write blocked by an outside lock holder fails 55P03 within about 5 s and releases the queue", async () => {
    await using x = await scratch();
    expect((await pgOf(x.s.read)`SHOW lock_timeout`)[0].lock_timeout).toBe("5s");
    await x.s.write(tx => put(tx, "row"));
    const outside = await x.db.sql.reserve();
    try {
      await outside`BEGIN`;
      await outside`SELECT v FROM t FOR UPDATE`;
      const started = Date.now();
      const e = await rejection(x.s.write(async tx => { await pgOf(tx)`UPDATE t SET v = 'blocked'`; }));
      const waited = Date.now() - started;
      expect(e.errno).toBe("55P03");
      expect(waited).toBeGreaterThanOrEqual(4500);
      expect(waited).toBeLessThan(9000);
      expect(x.s.queue.held).toBe(false);
      await outside`ROLLBACK`;
    } finally { outside.release(); }
    await x.s.write(async tx => { await pgOf(tx)`UPDATE t SET v = 'free'`; });
    expect(await rows(x.s.read)).toEqual(["free"]);
  }, 20000);

  test("T-P14 pgOf's handle sends a statement as it's built: a parent statement started beside a savepoint stays the parent's", async () => {
    await using x = await scratch();
    const pool = pgOf(x.s.read);
    await x.s.write(async tx => {
      // Plain awaits, as a store function writes them. Lazily sent, these would follow the SAVEPOINT and roll back.
      await Promise.allSettled([
        (async () => { await pgOf(tx)`INSERT INTO t (v) VALUES ('parent')`; })(),
        (async () => { await pgOf(tx).unsafe("INSERT INTO t (v) VALUES ('parent unsafe')"); })(),
        tx.savepoint(async sp => { await pgOf(sp)`INSERT INTO t (v) VALUES ('rolled back')`; throw new Error("expected"); }),
      ]);
      // A handle taken before the savepoint opened checks again as each statement is sent: it refuses rather than
      // landing inside the savepoint.
      const sql = pgOf(tx);
      const open = tx.savepoint(async () => { await tick(); });
      expect(() => sql`INSERT INTO t (v) VALUES ('refused')`).toThrow("Tx used while its savepoint is open");
      expect(() => sql.unsafe("INSERT INTO t (v) VALUES ('refused')")).toThrow("Tx used while its savepoint is open");
      await open;
      // And a pool handle taken outside refuses inside the transaction's own task.
      expect(() => pool`SELECT 1`).toThrow("repo.read inside the caller's own transaction");
      await sql`INSERT INTO t (v) VALUES ('after')`;
    });
    expect(await rows(x.s.read)).toEqual(["parent", "parent unsafe", "after"]);
  });

  test("T-P15 pgOf's handle: helpers and fragments build without sending, a fragment refuses an await; no begin, reserve or savepoint", async () => {
    await using x = await scratch();
    await x.s.write(async tx => {
      const sql = pgOf(tx);
      await sql`INSERT INTO t ${sql([{ v: "a" }, { v: "b" }])}`;
      await sql`INSERT INTO t ${sql({ v: "c" }, "v")}`;
      const where = sql.fragment`WHERE ${sql("v")} IN ${sql(["a", "c"])}`;
      expect(await sql`SELECT v FROM t ${where} ORDER BY seq`).toEqual([{ v: "a" }, { v: "c" }]);
      // Run alone, Bun would send "v" as a statement (a syntax error that aborts the transaction).
      await expect((async () => await (sql("v") as unknown as Promise<unknown>))()).rejects.toThrow("fragment awaited");
      await expect((async () => await (where as unknown as Promise<unknown>))()).rejects.toThrow("fragment awaited");
      await sql`INSERT INTO t (v) VALUES ('d')`;
    });
    expect(await rows(x.s.read)).toEqual(["a", "b", "c", "d"]);
    for (const h of [pgOf(x.s.read), await x.s.write(tx => pgOf(tx))]) {
      for (const name of ["begin", "reserve", "savepoint", "close", "transaction", "file"]) expect(name in h).toBe(false);
    }
    // @ts-expect-error a store function can't open a transaction outside the queue (D4)
    void pgOf(x.s.read).begin;
    // @ts-expect-error nor reach Bun's savepoint (tx.savepoint is the one, D2)
    void pgOf(x.s.read).savepoint;
    // @ts-expect-error nor hold a connection
    void pgOf(x.s.read).reserve;
  });

  test("T-P16 a savepoint opened in an already-aborted transaction rejects TxAborted, and so does the write", async () => {
    await using x = await scratch();
    let spError: any;
    const e = await rejection(x.s.write(async tx => {
      try { await pgOf(tx)`SELECT 1/0`; } catch { /* swallowed without a savepoint: the transaction is aborted */ }
      spError = await rejection(tx.savepoint(async sp => { await put(sp, "x"); }));
      throw spError;
    }));
    expect(spError).toBeInstanceOf(TxAborted);
    expect(spError.errno).toBe("25P02");
    expect(e).toBe(spError);
    await x.s.write(tx => put(tx, "next"));
    expect(await rows(x.s.read)).toEqual(["next"]);
  });

  test("T-P17 a failed post logs a Postgres error as its class, code and SQLSTATE, never the row values it quotes", async () => {
    await using x = await scratch();
    await x.db.sql`CREATE UNIQUE INDEX t_v ON t (v)`;
    await x.s.write(tx => put(tx, "alice@example.com"));
    const logged = await capturingErrors(async logged => {
      expect(x.s.post(tx => put(tx, "alice@example.com"), undefined, "dup write")).toBe(false);
      expect(x.s.post(async tx => { try { await put(tx, "alice@example.com"); } catch { /* swallowed */ } }, undefined, "aborted write")).toBe(false);
      await until(() => logged.length === 2, 5000, "both posts' failures to be logged");
    });
    expect(logged).toEqual([
      ["[grayboard] dup write failed:", { class: "PostgresError", code: "ERR_POSTGRES_SERVER_ERROR", sqlstate: "23505" }],
      ["[grayboard] aborted write failed:", { class: "TxAbortedError", code: "ERR_POSTGRES_COMMIT_ROLLED_BACK" }],
    ]);
    expect(Bun.inspect(logged)).not.toContain("alice");
  });
});

// A proxy between the store and the database cuts the connection at the client's COMMIT (tests/support/pg_proxy.ts).
describePg("Postgres in-doubt COMMIT", () => {
  for (const mode of ["dropped", "ack lost"] as const) {
    test(`T-P18 COMMIT ${mode}: the write rejects, "commit outcome unknown" is logged, no effect runs, the queue goes on`, async () => {
      const db = await pgEmptyDatabase({ max: 2 });
      await db.sql`CREATE TABLE t (seq int8 GENERATED ALWAYS AS IDENTITY, v text)`;
      const proxy = commitCutProxy(db.url, mode);
      const s = makePgTransactions(proxy.url, { max: 2 });
      const seen: string[] = [];
      try {
        const logged = await capturingErrors(async () => {
          let deadline: ReturnType<typeof setTimeout> | undefined;
          const e = await Promise.race([
            rejection(s.write(async tx => {
              await put(tx, "in doubt");
              tx.afterCommit(() => { seen.push("effect"); });
              proxy.arm();
            }, () => { seen.push("committed"); })),
            new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("the in-doubt write never settled within 10 s")), 10000); }),
          ]).finally(() => clearTimeout(deadline)) as any;
          expect(e.code).toBe("ERR_POSTGRES_CONNECTION_CLOSED");
          expect(e.errno).toBeUndefined();
        });
        expect(logged).toEqual([["[grayboard] commit outcome unknown:", { class: "PostgresError", code: "ERR_POSTGRES_CONNECTION_CLOSED" }]]);
        expect(seen).toEqual([]);
        expect(s.queue.held).toBe(false);
        expect(s.inTransaction()).toBe(false);
        // The server's outcome is what the client couldn't learn.
        expect((await db.sql`SELECT v FROM t`).map((r: { v: string }) => r.v)).toEqual(mode === "dropped" ? [] : ["in doubt"]);
        await s.write(tx => put(tx, "next"));
        expect((await db.sql`SELECT v FROM t ORDER BY seq`).map((r: { v: string }) => r.v)).toEqual(mode === "dropped" ? ["next"] : ["in doubt", "next"]);
      } finally {
        await s.close();
        proxy.stop();
        await db[Symbol.asyncDispose]();
      }
    }, 30000);
  }
});
