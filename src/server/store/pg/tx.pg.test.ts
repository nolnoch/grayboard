// #807 P3 C2: the Postgres store's transactions. The backend-neutral contract (tx.contract.ts) runs here on Postgres,
// then the behaviour only Postgres has: aborted transactions, commit-time failures, a dropped connection, the
// read-only pool, pinned isolation, lock_timeout and the two-store race shape later store ports copy.
// Each test gets its own database; without GRAYBOARD_TEST_PG_URL they skip (tests/support/pg.ts).
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { describePg, pgDatabase, pgEmptyDatabase, type PgDatabase } from "../../../../tests/support/pg.ts";
import { commitCutProxy } from "../../../../tests/support/pg_proxy.ts";
import { until } from "../../../../tests/support/until.ts";
import { MESSAGE_LIMITS } from "../messages.contract.ts";
import { DEFAULT_DATABASE_WRITERS } from "../queue.ts";
import { txContract, type TxBackend } from "../tx.contract.ts";
import { sqliteOf, sqliteRead } from "../tx.ts";
import { ProbeWrite, type Read, type Tx } from "../tx_base.ts";
import { makeNotices } from "../notices.ts";
import { makePgAuthGeneration } from "./auth_generation.ts";
import { makePgBoards } from "./boards.ts";
import { makePgHosted } from "./hosted.ts";
import { makePgMessages } from "./messages.ts";
import { makePgClaims } from "./claims.ts";
import { makePgTransactions, pgOf, refuseKeyed, TxAborted, type PgTransactions } from "./tx.ts";

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
async function scratch(opts: { max?: number; writers?: number; app?: string } = {}): Promise<{ db: PgDatabase; s: PgTransactions; [Symbol.asyncDispose](): Promise<void> }> {
  const db = await pgEmptyDatabase({ max: 4 });
  await db.sql`CREATE TABLE t (seq int8 GENERATED ALWAYS AS IDENTITY, v text)`;
  const s = makePgTransactions(db.url, { max: opts.max ?? 4, writers: opts.writers ?? 4, applicationName: opts.app ?? "gb-test-tx" });
  return { db, s, async [Symbol.asyncDispose]() { await s.close(); await db[Symbol.asyncDispose](); } };
}

const pgBackend: TxBackend = {
  postRunsNow: { idle: false, holder: false },
  async open() {
    const { db, s, [Symbol.asyncDispose]: dispose } = await scratch();
    void db;
    return {
      // The contract's keyed bodies register effects and pass `committed`: the store's opt-in (D4) lets them.
      write: s.write, writeKeyed: (keys, fn, committed) => s.writeKeyed(keys, fn, committed, { effects: true }), post: s.post, read: s.read, queue: s.queue,
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
    // Handled from the start: once Bun sees the connection close, its begin() rejects at once, with the body still
    // parked, so the write can reject while the terminate below is awaited (#1283).
    const failed = rejection(w);
    await entered.wait;
    await x.db.sql`SELECT pg_terminate_backend(${pid})`;
    resume.open();
    expect((await failed).errno).toBe("57P01");
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
      // Both after-commit callbacks ran once. Their order is not asserted: once A's COMMIT releases the lock, B can
      // commit and its client handle B's acknowledgement before A's client handles A's (#1389). The row is what
      // proves B's UPDATE ran after A's commit.
      expect(order.toSorted()).toEqual(["a", "b"]);
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

// #1510: keyed bodies overlap, each on its own write-pool connection, and what "inside a body" means is per body.
describePg("Postgres write scheduler", () => {
  // p, or a rejection naming `what` once `ms` pass: a gate that never opens fails the test, not the run.
  const within = <T>(p: Promise<T>, what: string, ms = 10000): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} within ${ms} ms`)), ms); })])
      .finally(() => clearTimeout(timer));
  };

  test("T-P19 two keyed bodies with no key in common are open at once, on two connections; an exclusive one waits for both", async () => {
    await using x = await scratch({ writers: 2 });
    const aIn = gate(), bIn = gate();
    const pids: number[] = [];
    const body = (v: string, mine: ReturnType<typeof gate>, other: ReturnType<typeof gate>) => async (tx: Tx) => {
      await put(tx, v);
      pids.push((await pgOf(tx)`SELECT pg_backend_pid() AS pid`)[0].pid);
      mine.open();
      // Each waits for the other to be inside its own transaction: on one slot this never happens.
      await within(other.wait, `the other keyed body to start beside ${v}`);
    };
    let exclusiveRan = false;
    const a = x.s.writeKeyed(["root:a"], body("a", aIn, bIn));
    const b = x.s.writeKeyed(["root:b"], body("b", bIn, aIn));
    const exclusive = x.s.write(async tx => { exclusiveRan = true; expect((await rows(tx)).sort()).toEqual(["a", "b"]); });
    await Promise.all([a, b]);
    await exclusive;
    expect(exclusiveRan).toBe(true);
    expect(new Set(pids).size).toBe(2);
    expect((await rows(x.s.read)).sort()).toEqual(["a", "b"]);
  });

  test("T-P20 the pool-read refusal and inTransaction answer for the calling body, not for any open one", async () => {
    await using x = await scratch({ writers: 2 });
    await x.s.write(tx => put(tx, "seed"));
    const aIn = gate(), bIn = gate(), aGo = gate(), aDone = gate(), lateGo = gate(), timerFired = gate(), bGo = gate();
    const seen: Record<string, unknown> = {};
    const refused = async (what: string) => {
      const e = await rejection(rows(x.s.read));
      seen[what] = String(e.message).includes("repo.read inside the caller's own transaction") ? "refused" : e;
    };
    const a = x.s.writeKeyed(["root:a"], async tx => {
      await put(tx, "a");
      seen.aInTx = x.s.inTransaction();
      await refused("aRead");
      // A timer A leaves behind fires while A's transaction is still open: still A's.
      setTimeout(() => { void refused("aTimer").then(timerFired.open); }, 0);
      await within(timerFired.wait, "A's timer to fire");
      // Left running past A's release, as an async afterCommit effect's continuation is.
      tx.afterCommit(() => {
        void lateGo.wait.then(async () => {
          seen.aLate = { inTx: x.s.inTransaction(), mine: x.s.queue.mine, rows: (await rows(x.s.read)).sort() };
        });
      });
      aIn.open();
      await within(aGo.wait, "the test to let A commit");
    }, undefined, { effects: true });
    const b = x.s.writeKeyed(["root:b"], async tx => {
      await put(tx, "b");
      bIn.open();
      await within(aIn.wait, "A to be open beside B");
      seen.bInTx = x.s.inTransaction();
      await refused("bRead");
      // B stays open until A's left-over continuation has run.
      await within(bGo.wait, "the test to let B commit");
      expect(await rows(tx)).toContain("b");
    });
    await within(Promise.all([aIn.wait, bIn.wait]), "both bodies to open");
    // A task outside both bodies reads the pool while both transactions are open.
    seen.outside = { inTx: x.s.inTransaction(), rows: await rows(x.s.read) };
    void a.then(aDone.open);
    aGo.open();
    await within(aDone.wait, "A to commit");
    lateGo.open();
    await until(() => seen.aLate, 5000, "A's left-over continuation to run");
    bGo.open();
    await b;
    expect(seen).toEqual({
      aInTx: true, aRead: "refused", aTimer: "refused",
      bInTx: true, bRead: "refused",
      outside: { inTx: false, rows: ["seed"] },
      // B is still open here: A's continuation is neither A (released) nor B.
      aLate: { inTx: false, mine: false, rows: ["a", "seed"] },
    });
  });

  // Audit M2: a live body whose own transaction has closed (its afterCommit flush, its committed callback) is outside,
  // though another body's transaction is open: "any open transaction while I hold a slot" would refuse its pool read
  // and bypass the auth cache for it.
  test("T-P22 a body past its own commit is outside while another's transaction is open: inTransaction, pool reads and ownsTx", async () => {
    await using x = await scratch({ writers: 2 });
    await x.s.write(tx => put(tx, "seed"));
    // The production ownsTx (pg_repo.ts wires the same), never started: no listener.
    const gen = makePgAuthGeneration({ url: x.db.url, transactions: x.s, openListener: (() => { throw new Error("test: not started"); }) as never });
    const state = async () => ({ inTx: x.s.inTransaction(), ownsTx: gen.ownsTx(), rows: await rows(x.s.read).catch((e: Error) => e.message) });
    const aIn = gate(), aGo = gate();
    const seen: Record<string, unknown> = {};
    const a = x.s.writeKeyed(["root:a"], async tx => {
      await put(tx, "a");
      seen.a = { inTx: x.s.inTransaction(), ownsTx: gen.ownsTx() };
      aIn.open();
      await within(aGo.wait, "the test to let A commit");
    });
    await within(aIn.wait, "A to open");
    let flushed: Promise<void> | undefined;
    const b = x.s.writeKeyed(["root:b"], async tx => {
      await put(tx, "b");
      seen.b = { inTx: x.s.inTransaction(), ownsTx: gen.ownsTx() };
      tx.afterCommit(() => { flushed = state().then(v => { seen.bEffect = v; }); });
    }, async () => {
      seen.bMine = x.s.queue.mine;
      seen.bCommitted = await state();
    }, { effects: true });
    await b;
    await flushed;
    seen.outside = { inTx: x.s.inTransaction(), ownsTx: gen.ownsTx() };
    aGo.open();
    await a;
    const after = { inTx: false, ownsTx: false, rows: ["seed", "b"] };
    expect(seen).toEqual({
      a: { inTx: true, ownsTx: true },
      b: { inTx: true, ownsTx: true },
      // B still holds its slot here, and A's transaction is open.
      bMine: true, bEffect: after, bCommitted: after,
      outside: { inTx: false, ownsTx: false },
    });
  });

  test("T-P21 two overlapping transactions' change notices carry each its own facts, read on its own transaction", async () => {
    await using x = await scratch({ writers: 2 });
    const notices = makeNotices((tx, effect) => tx.afterCommit(effect));
    const seen: Array<[string | null, unknown]> = [];
    notices.subscribe<number>((id, facts) => { seen.push([id, facts]); },
      async (tx, id) => (await pgOf(tx)`SELECT count(*)::int AS n FROM t WHERE v = ${id}`)[0].n);
    const marked = notices.marks((tx: Tx, v: string) => put(tx, v), (_tx, v) => v);
    const aMarked = gate(), bMarked = gate();
    // Opted in to effects (KeyedOptions): a notice is an afterCommit effect, which a keyed body otherwise refuses.
    const a = x.s.writeKeyed(["root:a"], async tx => {
      await marked(tx, "a");
      aMarked.open();
      // B marks its row before A commits: A's hook must not read B's (on A's transaction, B's row isn't there).
      await within(bMarked.wait, "B to mark its row");
    }, undefined, { effects: true });
    const b = x.s.writeKeyed(["root:b"], async tx => {
      await within(aMarked.wait, "A to mark its row");
      await marked(tx, "b");
      await marked(tx, "b");
      bMarked.open();
      await a;
    }, undefined, { effects: true });
    await Promise.all([a, b]);
    expect(seen).toEqual([["a", 1], ["b", 2], ["b", 2]]);
  });
});

// #1510 chunk 2: the Postgres store's guard on keyed write bodies (docs/future/postgres-server.md D4). A keyed body's
// transaction carries its keys, savepoints included; the stores refuse an id-allocating insert unless the body holds
// that stream's key, refuse the capacity lock outright, and a keyed body that wrote an auth table rolls back. Each
// refusal names the operation and the keys. Without GRAYBOARD_TEST_PG_URL it skips.
const KT0 = 1_800_000_000_000;
const messages = makePgMessages({ clock: () => KT0, attachmentLimits: MESSAGE_LIMITS });
const boards = makePgBoards({ clock: () => KT0 });
// lockCapacity reaches no session end.
const hosted = makePgHosted({ sessionEnd: undefined as never });

const post = (board: string) => ({ board, author: "a@example.com/fe", body: "p", parentId: null, now: KT0, expiresAt: null, authorId: null, via: null, authorUser: "a@example.com", human: false });

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
    const e = await rejection(x.s.writeKeyed(["root:a"], tx => messages.bounce(tx, "a@example.com/fe", "a@example.com/be", parent.id, "gone", KT0)));
    expect(e.message).toContain("messages.bounce refused in a keyed write body (keys root:a) without the key dm:a@example.com/be");
    expect(await x.s.writeKeyed(["dm:a@example.com/be"], tx => messages.bounce(tx, "a@example.com/fe", "a@example.com/be", parent.id, "gone", KT0))).not.toBeNull();
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

  // #1510 chunk 3 (#1527 L2): what D4 promised and chunk 2 didn't enforce. A keyed body's afterCommit effect and its
  // `committed` refuse unless the caller opted in; so does every change notice (pg_repo's marks/change, through
  // makeNotices' refuse) and every claim_events insert.
  // Mutation: drop PgTx.deferEffect's refuseKeyed (the keyed effect is queued, the body commits and the effect runs).
  test("a keyed body's afterCommit effect refuses, naming the keys, through a savepoint too, and the body rolls back; opted in, it runs", async () => {
    await using x = await scratch();
    let ran = 0;
    const e = await rejection(x.s.writeKeyed(["root:a"], async tx => { await put(tx, "gone"); tx.afterCommit(() => { ran++; }); }));
    expect(e.message).toBe("afterCommit effect refused in a keyed write body (keys root:a): it runs in an exclusive body (write) (docs/future/postgres-server.md D4)");
    const sp = await rejection(x.s.writeKeyed(["root:b"], tx => tx.savepoint(async inner => { inner.afterCommit(() => { ran++; }); })));
    expect(sp.message).toContain("afterCommit effect refused in a keyed write body (keys root:b)");
    await x.s.writeKeyed(["root:a"], async tx => { await put(tx, "kept"); tx.afterCommit(() => { ran++; }); }, undefined, { effects: true });
    await x.s.write(async tx => { tx.afterCommit(() => { ran++; }); });
    expect(ran).toBe(2);
    expect(await rows(x.s.read)).toEqual(["kept"]);
  });

  // Mutations: drop run's committed refusal (the keyed body commits and `committed` runs); drop post's (postKeyed
  // queues the body).
  test("a keyed body's committed callback refuses before the body runs, for writeKeyed and postKeyed; opted in, it runs", async () => {
    await using x = await scratch();
    let body = 0, after = 0;
    const e = await rejection(x.s.writeKeyed(["root:a", "root:b"], async tx => { body++; await put(tx, "gone"); }, () => { after++; }));
    expect(e.message).toBe("a committed callback refused in a keyed write body (keys root:a, root:b): it runs in an exclusive body (write) (docs/future/postgres-server.md D4)");
    expect(() => x.s.postKeyed(["root:c"], async tx => { body++; await put(tx, "posted"); }, () => { after++; })).toThrow("a committed callback refused in a keyed write body (keys root:c)");
    expect(await x.s.writeKeyed(["root:a"], async tx => { body++; await put(tx, "kept"); return 2; }, v => { after++; return v * 2; }, { effects: true })).toBe(4);
    await x.s.write(() => {});
    expect([body, after]).toEqual([1, 1]);
    expect(await rows(x.s.read)).toEqual(["kept"]);
  });

  // Mutation: makeNotices' marks/change without the refuse call (the keyed mark's write is sent; the notice's
  // afterCommit refusal still fires, but only after its statement ran, so the op's name is missing from the error).
  test("a change notice's op refuses in a keyed body before its statement is sent, naming the op and the keys; an exclusive body marks", async () => {
    await using x = await scratch();
    const notices = makeNotices((tx, effect) => tx.afterCommit(effect), (tx, op) => refuseKeyed(tx, op));
    const seen: Array<string | null> = [];
    notices.subscribe<null>(id => { seen.push(id); }, async () => null);
    let sent = 0;
    const marked = notices.marks(async (tx: Tx, v: string) => { sent++; await put(tx, v); }, (_tx, v) => v, "t.put");
    const changed = notices.change(async (tx: Tx) => { sent++; await put(tx, "c"); }, "t.change");
    const e = await rejection(x.s.writeKeyed(["root:a"], tx => marked(tx, "m")));
    expect(e.message).toBe("t.put (it queues a change notice) refused in a keyed write body (keys root:a): it runs in an exclusive body (write) (docs/future/postgres-server.md D4)");
    expect((await rejection(x.s.writeKeyed(["root:a"], tx => tx.savepoint(inner => changed(inner))))).message).toContain("t.change (it queues a change notice) refused in a keyed write body (keys root:a)");
    expect(sent).toBe(0);
    await x.s.write(async tx => { await marked(tx, "m"); await changed(tx); });
    expect(seen).toEqual(["m", null]);
  });

  // Mutation: drop insertClaimEvent's refuseKeyed (the keyed event commits).
  test("a claim_events insert refuses in a keyed body, naming the keys; an exclusive body logs it", async () => {
    await using x = await store();
    const claims = makePgClaims({ clock: () => KT0 });
    const e = await rejection(x.s.writeKeyed(["root:a"], tx => claims.logEvent(tx, "take", "a@example.com/fe", { key: "ticket:1" }, KT0)));
    expect(e.message).toBe("claim_events insert refused in a keyed write body (keys root:a): it runs in an exclusive body (write) (docs/future/postgres-server.md D4)");
    await x.s.write(tx => claims.logEvent(tx, "take", "a@example.com/fe", { key: "ticket:1" }, KT0));
    expect((await x.sql`SELECT count(*)::int AS n FROM claim_events`)[0].n).toBe(1);
  });
});

// #1510 chunk 3: readsOnly, the read-only probe the hosted gate's keyed fast path runs settle and rowFor under. A
// statement that isn't a SELECT, or names an advisory lock, refuses ProbeWrite before it's sent; refuseKeyed's
// refusals become the probe's; a refusal the probed code swallowed still rejects the probe; the probe ends with fn.
describePg("readsOnly (Postgres read-only probe)", () => {
  // Mutations: probeCheck returning at once (the INSERT is sent and the probe resolves); readsOnly without its
  // after-fn `probe.refused` rethrow (the swallowed refusal resolves the probe).
  test("a write refuses ProbeWrite before it's sent, even when the probed code swallows it; reads and row locks pass; the probe ends with fn", async () => {
    await using x = await scratch();
    await x.s.write(tx => put(tx, "a"));
    const out = await x.s.writeKeyed(["root:a"], async tx => {
      const read = await x.s.readsOnly(tx, async () => (await pgOf(tx)`SELECT v FROM t WHERE v = 'a' FOR UPDATE`).length);
      const e = await rejection(x.s.readsOnly(tx, () => put(tx, "probed")));
      const swallowed = await rejection(x.s.readsOnly(tx, async () => { await put(tx, "swallowed").catch(() => {}); return "went on"; }));
      const advisory = await rejection(x.s.readsOnly(tx, async () => { await pgOf(tx)`SELECT pg_advisory_xact_lock(1)`; }));
      const data = await rejection(x.s.readsOnly(tx, async () => { await pgOf(tx)`WITH d AS (DELETE FROM t RETURNING 1) SELECT 1`; }));
      // After the probe the body writes.
      await put(tx, "after");
      return { read, e, swallowed, advisory, data };
    });
    expect(out.read).toBe(1);
    for (const e of [out.e, out.swallowed, out.advisory, out.data]) expect(e).toBeInstanceOf(ProbeWrite);
    expect(out.e.message).toBe(`the statement "INSERT INTO t …" refused in a read-only probe (keys root:a): the probed code would write (docs/future/postgres-server.md D4)`);
    expect(out.advisory.message).toContain(`the statement "SELECT pg_advisory_xact_lock(1) …" refused in a read-only probe`);
    expect(await rows(x.s.read)).toEqual(["a", "after"]);
  });

  // Mutation: refuseKeyed without its probe branch (the store's refusal is a plain Error, which the gate counts as a
  // failure, not a miss).
  test("a store's keyed refusal inside the probe is the probe's ProbeWrite, before anything is sent", async () => {
    await using x = await store();
    const e = await x.s.writeKeyed(["root:a"], tx => rejection(x.s.readsOnly(tx, () => hosted.lockCapacity(tx))));
    expect(e).toBeInstanceOf(ProbeWrite);
    expect(e.message).toBe("hosted.lockCapacity refused in a read-only probe (keys root:a): the probed code would write (docs/future/postgres-server.md D4)");
  });

  test("readsOnly refuses a nested probe and a Tx that isn't Postgres's", async () => {
    await using x = await scratch();
    await x.s.writeKeyed(["root:a"], async tx => {
      expect((await rejection(x.s.readsOnly(tx, () => x.s.readsOnly(tx, async () => 1)))).message).toBe("readsOnly nested in a probe");
    });
    expect((await rejection(x.s.readsOnly({} as Tx, async () => 1))).message).toBe("readsOnly needs a Postgres body's Tx");
  });
});
