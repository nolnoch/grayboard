// The transaction contract every store backend honours (#807 D2, D9, docs/future/postgres-server.md): the portable
// part of tx.test.ts and queue.test.ts, written once over a harness so SQLite runs it today and Postgres runs the same
// tests. Not a *.test.ts file, so Bun doesn't discover it: a backend's test file registers it under a describe().
//
// What stays out: the synchronous-only paths (a post that runs now, a synchronous body's Tx, a nested
// db.transaction), the raw connection's writer check and the per-backend handle checks. Each backend's own test file
// keeps those; the existing SQLite tests still cover them unchanged.
//
// Portability rules the tests follow:
// - Every statement is awaited: a Postgres query nobody awaits never runs. `put` and `rows` answer synchronously on
//   SQLite, so `tx => h.put(tx, v)` is a synchronous body there and an async one on Postgres; `post`'s result for
//   such a body is the backend's (`postRunsNow`), never assumed.
// - An afterCommit effect records synchronously: only an effect's synchronous part is ordered before the queue's
//   next body (D4), so one that awaited a read would race the next body on Postgres.
// - A post's outcome is observed after `drain()`, and a logged failure with until(), never by counting ticks.
import { expect, test } from "bun:test";
import { until } from "../../../tests/support/until.ts";
import { afterCommitOf, isTx, type Read, type Tx } from "./tx_base.ts";

// One store, fresh per test, over a table of text values in insertion order.
export type TxStore = {
  write<T, R = T>(fn: (tx: Tx) => T | Promise<T>, committed?: (value: T) => R): Promise<Awaited<R>>;
  post<T>(fn: (tx: Tx) => T | Promise<T>, committed?: (value: T) => unknown, what?: string): boolean;
  read: Read;
  // The store's write queue (store/queue.ts).
  queue: { readonly held: boolean; readonly mine: boolean; run<T>(fn: () => T | PromiseLike<T>): Promise<T> };
  // One row on the handle's transaction, and the table's values on any handle. Each refuses as the store's handle
  // check does (a settled Tx, the holder's own read); synchronously or by rejecting, as the backend's statements run.
  put(tx: Tx, v: string): void | Promise<void>;
  rows(r: Read): string[] | Promise<string[]>;
  // Whether the store's root transaction is open: false in a commit's `committed` callback and its effects.
  inTransaction(): boolean;
  // Resolves once every write queued before it has settled (a post's included).
  drain(): Promise<void>;
  close(): void | Promise<void>;
};

export type TxBackend = {
  open(): Promise<TxStore>;
  // post's result for a body that finishes synchronously, on an idle queue and from the queue's holder outside a
  // transaction (its committed callback): true where it commits before post returns (SQLite), false where every
  // commit is async (Postgres). A post that waits, or whose body is async, is false on every backend.
  postRunsNow: { idle: boolean; holder: boolean };
};

// "handles": tx.test.ts's portable rows; "write-path": queue.test.ts's. A backend that runs both from one file omits it.
export type ContractPart = "handles" | "write-path" | "all";

const tick = () => new Promise<void>(r => setTimeout(r, 0));

// The error a call throws or rejects with, as text: a handle check refuses synchronously on SQLite and may reject on
// another backend.
async function failure(f: () => unknown): Promise<string> {
  try { await f(); } catch (error) { return String(error); }
  return "(no error)";
}

function gate(): { wait: Promise<void>; open(): void } {
  let open!: () => void;
  const wait = new Promise<void>(r => { open = r; });
  return { wait, open };
}

// console.error's calls while fn runs, restored after it.
async function capturingErrors(fn: (logged: unknown[][]) => Promise<void>): Promise<unknown[][]> {
  const logged: unknown[][] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try { await fn(logged); } finally { console.error = error; }
  return logged;
}
const failedAs = (logged: unknown[][], what: string, text: string) =>
  logged.filter(a => a[0] === `[grayboard] ${what} failed:` && String(a[1]).includes(text));

export function txContract(backend: TxBackend, part: ContractPart = "all"): void {
  const it = (name: string, fn: (h: TxStore) => Promise<void>) => test(name, async () => {
    const h = await backend.open();
    try { await fn(h); } finally { await h.close(); }
  });
  if (part !== "write-path") handles(backend, it);
  if (part !== "handles") writePath(backend, it);
}

type It = (name: string, fn: (h: TxStore) => Promise<void>) => void;

function handles(backend: TxBackend, it: It): void {
  it("a write body's Tx writes in its transaction; the read handle sees the commit", async h => {
    await h.write(async tx => { await h.put(tx, "a"); expect(await h.rows(tx)).toEqual(["a"]); });
    await h.write(async tx => { await tick(); await h.put(tx, "b"); });
    await h.write(tx => h.put(tx, "c"));
    expect(await h.rows(h.read)).toEqual(["a", "b", "c"]);
  });

  it("a Tx used after its body settles refuses every use and writes nothing", async h => {
    let kept!: Tx;
    await h.write(tx => { kept = tx; });
    expect(await failure(() => h.put(kept, "late"))).toContain("Tx used after its transaction settled");
    expect(() => kept.afterCommit(() => {})).toThrow("settled");
    expect(() => kept.beforeCommit({}, async () => {})).toThrow("settled");
    await expect(kept.savepoint(() => {})).rejects.toThrow("settled");
    // An async body that leaves a timer behind: the timer fires after the body settled.
    let late: string | undefined;
    await h.write(async tx => {
      setTimeout(() => { void failure(() => h.put(tx, "timer")).then(e => { late = e; }); }, 0);
    });
    expect(await until(() => late, 5000, "the timer's write to settle")).toContain("Tx used after its transaction settled");
    expect(await h.rows(h.read)).toEqual([]);
  });

  it("a rolled-back body's Tx is closed too", async h => {
    let kept!: Tx;
    await expect(h.write(async tx => { kept = tx; await h.put(tx, "x"); throw new Error("no"); })).rejects.toThrow("no");
    expect(await failure(() => h.put(kept, "y"))).toContain("settled");
    expect(await h.rows(h.read)).toEqual([]);
  });

  it("afterCommit effects run after the commit in registration order, never on rollback", async h => {
    const seen: string[] = [];
    await h.write(async tx => {
      tx.afterCommit(() => { seen.push(`first ${h.inTransaction() ? "in" : "after"} txn`); });
      await h.put(tx, "a");
      tx.afterCommit(() => { seen.push("second"); });
      seen.push("body");
    });
    expect(seen).toEqual(["body", "first after txn", "second"]);
    await expect(h.write(async tx => {
      tx.afterCommit(() => { seen.push("rolled back"); });
      await h.put(tx, "b");
      throw new Error("no");
    })).rejects.toThrow("no");
    expect(seen).toEqual(["body", "first after txn", "second"]);
    expect(await h.rows(h.read)).toEqual(["a"]);
  });

  it("isTx and afterCommitOf dispatch on the handle: a Tx defers to its commit, a Read runs now", async h => {
    const seen: string[] = [];
    expect(isTx(h.read)).toBe(false);
    afterCommitOf(h.read, () => { seen.push("read: now"); });
    expect(seen).toEqual(["read: now"]);
    let kept!: Tx;
    await h.write(async tx => {
      kept = tx;
      expect(isTx(tx)).toBe(true);
      afterCommitOf(tx, () => { seen.push(`tx: ${h.inTransaction() ? "in" : "after"} txn`); });
      seen.push("body");
    });
    expect(seen).toEqual(["read: now", "body", "tx: after txn"]);
    expect(isTx(kept)).toBe(true);
    expect(() => afterCommitOf(kept, () => {})).toThrow("settled");
    expect(() => afterCommitOf({} as Read, () => {})).toThrow("store handle");
  });

  it("a savepoint that throws rolls back its writes and effects alone; the outer body's stand", async h => {
    const seen: string[] = [];
    await h.write(async tx => {
      await h.put(tx, "outer");
      tx.afterCommit(() => { seen.push("outer"); });
      await expect(tx.savepoint(async sp => {
        await h.put(sp, "inner");
        sp.afterCommit(() => { seen.push("inner"); });
        await tick();
        throw new Error("inner failed");
      })).rejects.toThrow("inner failed");
      expect(await h.rows(tx)).toEqual(["outer"]);
      await h.put(tx, "after");
    });
    expect(await h.rows(h.read)).toEqual(["outer", "after"]);
    expect(seen).toEqual(["outer"]);
  });

  it("a committed savepoint's effects wait for the outer commit, and drop with the outer rollback", async h => {
    const seen: string[] = [];
    await h.write(async tx => {
      expect(await tx.savepoint(async sp => { await h.put(sp, "a"); sp.afterCommit(() => { seen.push("sp"); }); await tick(); return 5; })).toBe(5);
      expect(seen).toEqual([]);
      expect(await h.rows(tx)).toEqual(["a"]);
    });
    expect(seen).toEqual(["sp"]);
    await expect(h.write(async tx => {
      await tx.savepoint(async sp => { await h.put(sp, "b"); sp.afterCommit(() => { seen.push("dropped"); }); });
      throw new Error("outer failed");
    })).rejects.toThrow("outer failed");
    expect(seen).toEqual(["sp"]);
    expect(await h.rows(h.read)).toEqual(["a"]);
  });

  it("nested savepoints: an inner rollback inside a committed savepoint", async h => {
    await h.write(async tx => {
      await tx.savepoint(async a => {
        await h.put(a, "a1");
        await a.savepoint(async b => { await h.put(b, "b1"); await b.savepoint(c => h.put(c, "c1")); });
        await expect(a.savepoint(async b => { await h.put(b, "b2"); await tick(); throw new Error("b2"); })).rejects.toThrow("b2");
        await h.put(a, "a2");
      });
    });
    expect(await h.rows(h.read)).toEqual(["a1", "b1", "c1", "a2"]);
  });

  it("a savepoint's Tx is closed once its savepoint settles, committed or rolled back", async h => {
    let committed!: Tx, rolled!: Tx;
    await h.write(async tx => {
      await tx.savepoint(async sp => { committed = sp; await h.put(sp, "a"); });
      await expect(tx.savepoint(async sp => { rolled = sp; throw new Error("no"); })).rejects.toThrow("no");
      for (const sp of [committed, rolled]) {
        expect(await failure(() => h.put(sp, "late"))).toContain("Tx used after its transaction settled");
        expect(() => sp.afterCommit(() => {})).toThrow("settled");
        await expect(sp.savepoint(() => {})).rejects.toThrow("settled");
      }
      await h.put(tx, "b");
    });
    expect(await h.rows(h.read)).toEqual(["a", "b"]);
  });

  it("the parent Tx refuses statements, effects and a second savepoint while a savepoint is open", async h => {
    const errors: string[] = [];
    await h.write(async tx => {
      await tx.savepoint(async sp => {
        await h.put(sp, "in");
        errors.push(await failure(() => h.put(tx, "parent")));
        errors.push(await failure(() => tx.savepoint(() => {})));
        errors.push(await failure(() => tx.afterCommit(() => {})));
        errors.push(await failure(() => tx.beforeCommit({}, async () => {})));
      });
      await h.put(tx, "out");
    });
    expect(errors).toHaveLength(4);
    for (const e of errors) expect(e).toContain("savepoint is open");
    expect(await h.rows(h.read)).toEqual(["in", "out"]);
  });

  it("a body that returns without awaiting its savepoint: the savepoint dies with the transaction, the next one is sound", async h => {
    let kept!: Tx, settled: Promise<unknown> = Promise.resolve();
    await h.write(tx => {
      settled = tx.savepoint(async sp => { kept = sp; await h.put(sp, "a"); await tick(); }).catch(e => e);
    });
    expect(await failure(() => h.put(kept, "late"))).toContain("settled");
    expect(String(await settled)).toContain("savepoint outlived its transaction");
    // The next transaction's effects run at its commit: no frame of the dead savepoint is left to swallow them.
    const seen: string[] = [];
    await h.write(async tx => { await h.put(tx, "b"); tx.afterCommit(() => { seen.push("next"); }); });
    expect(seen).toEqual(["next"]);
    expect(await h.rows(h.read)).toEqual(["a", "b"]);
  });

  it("write and post bodies get a Tx live only for the body", async h => {
    let a!: Tx, b!: Tx;
    await h.write(tx => { a = tx; return h.put(tx, "now"); });
    expect(h.post(tx => { b = tx; return h.put(tx, "post"); })).toBe(backend.postRunsNow.idle);
    await h.drain();
    expect(await failure(() => h.put(a, "x"))).toContain("settled");
    expect(await failure(() => h.put(b, "x"))).toContain("settled");
    expect(await h.rows(h.read)).toEqual(["now", "post"]);
  });

  it("a post body run from a write's committed callback gets a Tx closed after it", async h => {
    let after!: Tx;
    await h.write(() => 1, () => {
      expect(h.post(tx => { after = tx; return h.put(tx, "after"); })).toBe(backend.postRunsNow.holder);
    });
    await h.drain();
    expect(await failure(() => h.put(after, "x"))).toContain("settled");
    expect(await h.rows(h.read)).toEqual(["after"]);
  });

  it("an orphaned savepoint that fails during a later transaction leaves that transaction alone", async h => {
    let fail!: () => void;
    const orphan = new Promise<void>((_, reject) => { fail = () => reject(new Error("orphan failed")); });
    let settled: Promise<unknown> = Promise.resolve();
    await h.write(tx => { settled = tx.savepoint(async sp => { await h.put(sp, "a"); await orphan; }).catch(e => e); });
    await h.write(async tx => {
      await h.put(tx, "b");
      fail();
      expect(String(await settled)).toContain("orphan failed");
      await h.put(tx, "c");
    });
    expect(await h.rows(h.read)).toEqual(["a", "b", "c"]);
  });

  it("a savepoint rolled back with an inner one left open: the caller's later effects still run (#999 audit B)", async h => {
    const seen: string[] = [];
    let inner: Promise<unknown> = Promise.resolve();
    await h.write(async tx => {
      await expect(tx.savepoint(async sp => {
        inner = sp.savepoint(async isp => { await h.put(isp, "inner"); await tick(); await tick(); }).catch(e => e);
        throw new Error("outer savepoint failed");
      })).rejects.toThrow("outer savepoint failed");
      await h.put(tx, "after");
      tx.afterCommit(() => { seen.push("after"); });
      await inner;
    });
    expect(seen).toEqual(["after"]);
    expect(await h.rows(h.read)).toEqual(["after"]);
  });

  it("a savepoint committing with an inner one still open rolls back instead of staying open (#999 audit B)", async h => {
    const seen: string[] = [];
    let inner: Promise<unknown> = Promise.resolve();
    await h.write(async tx => {
      await expect(tx.savepoint(async sp => {
        await h.put(sp, "sp");
        sp.afterCommit(() => { seen.push("sp"); });
        inner = sp.savepoint(async isp => { await h.put(isp, "inner"); await tick(); await tick(); }).catch(e => e);
      })).rejects.toThrow("savepoint commit out of order");
      await h.put(tx, "after");
      tx.afterCommit(() => { seen.push("after"); });
      await inner;
    });
    expect(seen).toEqual(["after"]);
    expect(await h.rows(h.read)).toEqual(["after"]);
  });

  // #807 P3 A7e2 (D2): the holder's read of the store's Read handle would see its own uncommitted rows on SQLite and
  // hang a small Postgres pool; it passes its Tx. Every other task's read is committed state.
  it("the store's Read inside the caller's own transaction is refused; the body's Tx, other tasks and post-commit reads aren't", async h => {
    const refusal = "repo.read inside the caller's own transaction";
    expect(await h.rows(h.read)).toEqual([]);
    // In a body, before and after an await: refused; the Tx reads the body's rows.
    await h.write(async tx => {
      await h.put(tx, "a");
      expect(await failure(() => h.rows(h.read))).toContain(refusal);
      expect(await h.rows(tx)).toEqual(["a"]);
      await tick();
      expect(await failure(() => h.rows(h.read))).toContain(refusal);
    });
    // Another task, while a body holding the transaction awaits: committed state.
    const held = gate(), entered = gate();
    const body = h.write(async tx => { await h.put(tx, "b"); entered.open(); await held.wait; });
    await entered.wait;
    expect(await h.rows(h.read)).toEqual(["a"]);
    held.open();
    await body;
    // The committed callback and the Tx's afterCommit run after the close: the Read reads the commit. The effect
    // starts its read synchronously, so a refusal would surface here rather than in the effect's log.
    let effectRead: Promise<string[]> | undefined;
    const committedRead = await h.write(async tx => {
      await h.put(tx, "c");
      tx.afterCommit(() => { effectRead = Promise.resolve(h.rows(h.read)); });
    }, () => h.rows(h.read));
    expect(committedRead).toEqual(["a", "b", "c"]);
    expect(await effectRead).toEqual(["a", "b", "c"]);
    // A timer the body starts, firing while its transaction is still open, is the holder's task: refused.
    let timerError = "";
    await h.write(async tx => {
      await h.put(tx, "d");
      await new Promise<void>(r => setTimeout(() => { void failure(() => h.rows(h.read)).then(e => { timerError = e; r(); }); }, 0));
    });
    expect(timerError).toContain(refusal);
    expect(await h.rows(h.read)).toEqual(["a", "b", "c", "d"]);
  });

  // #807 P3 A7g: Tx.beforeCommit.
  it("beforeCommit runs once per key after the body, before COMMIT, on the root Tx with the queue held", async h => {
    const seen: string[] = [];
    const key = {};
    const started = gate(), queued = gate();
    const write = h.write(async tx => {
      tx.afterCommit(() => { seen.push("after"); });
      tx.beforeCommit(key, async root => {
        seen.push(`hook:${(await h.rows(root)).join(",")}`);
        seen.push(`held:${h.queue.mine},${h.inTransaction()}`);
        started.open();
        await queued.wait;
        await h.put(root, "hook");
      });
      tx.beforeCommit(key, async () => { seen.push("second"); });
      await tx.savepoint(async sp => { sp.beforeCommit(key, async () => { seen.push("third"); }); await h.put(sp, "sp"); });
      await h.put(tx, "body");
      seen.push("body");
    });
    await started.wait;
    // Another task's write, queued while the hook awaits: it runs after the commit, not between the hook and COMMIT.
    const other = h.write(t => { seen.push("other"); return h.put(t, "other"); });
    queued.open();
    await Promise.all([write, other]);
    expect(seen).toEqual(["body", "hook:sp,body", "held:true,true", "after", "other"]);
    expect(await h.rows(h.read)).toEqual(["sp", "body", "hook", "other"]);
  });

  it("a beforeCommit rejection rolls the transaction back and rejects the write", async h => {
    const seen: string[] = [];
    await expect(h.write(async tx => {
      await h.put(tx, "a");
      tx.afterCommit(() => { seen.push("after"); });
      tx.beforeCommit({}, async root => { await h.put(root, "hook"); throw new Error("hook failed"); });
    })).rejects.toThrow("hook failed");
    expect(await h.rows(h.read)).toEqual([]);
    expect(seen).toEqual([]);
    await h.write(tx => h.put(tx, "next"));
    expect(await h.rows(h.read)).toEqual(["next"]);
  });

  it("beforeCommit from a savepoint runs at the outer commit on the root Tx, and drops with the savepoint's rollback", async h => {
    const seen: string[] = [];
    const kept = {}, dropped = {}, shared = {}, nested = {};
    await h.write(async tx => {
      tx.beforeCommit(shared, async () => { seen.push("shared"); });
      await tx.savepoint(async sp => {
        sp.beforeCommit(kept, async root => { await h.put(root, "kept"); seen.push("kept"); });
        await sp.savepoint(async inner => { inner.beforeCommit(nested, async () => { seen.push("nested"); }); });
      });
      await expect(tx.savepoint(async sp => {
        sp.beforeCommit(dropped, async () => { seen.push("dropped"); });
        sp.beforeCommit(shared, async () => { seen.push("shared again"); });
        await tick();
        throw new Error("sp failed");
      })).rejects.toThrow("sp failed");
      // A committed savepoint's nested key drops with an outer savepoint that later rolls back.
      await expect(tx.savepoint(async a => {
        await a.savepoint(async b => { b.beforeCommit({ late: true }, async () => { seen.push("late"); }); });
        throw new Error("a failed");
      })).rejects.toThrow("a failed");
    });
    expect(seen).toEqual(["shared", "kept", "nested"]);
    expect(await h.rows(h.read)).toEqual(["kept"]);
  });

  it("a hook a beforeCommit hook registers runs before COMMIT; a body that returns no promise runs its hooks too", async h => {
    await h.write(tx => {
      tx.beforeCommit({}, async root => {
        await h.put(root, "first");
        root.beforeCommit({}, async again => { await h.put(again, "second"); });
      });
    });
    expect(await h.rows(h.read)).toEqual(["first", "second"]);
  });

  // #1182 audit: a savepoint's hook keys follow its frame, not its settle path.
  it("beforeCommit keys of a savepoint whose RELEASE fails, or of an un-awaited one inside a rolled-back savepoint, drop", async h => {
    const seen: string[] = [];
    const release = gate();
    const stray: Promise<unknown>[] = [];
    await h.write(async tx => {
      // P fulfils with C still open: P's commit refuses (out of order) and rolls P back; the body catches and goes on.
      await expect(tx.savepoint(async p => {
        p.beforeCommit({}, async () => { seen.push("released-p"); });
        await h.put(p, "p");
        stray.push(p.savepoint(async c => { c.beforeCommit({}, async () => { seen.push("released-c"); }); await release.wait; }).catch(() => {}));
      })).rejects.toThrow("out of order");
      // P rejects with C still open: C's key goes with P's rollback.
      await expect(tx.savepoint(async p => {
        stray.push(p.savepoint(async c => { c.beforeCommit({}, async () => { seen.push("rolled-c"); }); await release.wait; }).catch(() => {}));
        throw new Error("p failed");
      })).rejects.toThrow("p failed");
      await h.put(tx, "body");
    });
    release.open();
    await Promise.all(stray);
    expect(seen).toEqual([]);
    expect(await h.rows(h.read)).toEqual(["body"]);
  });

  it("a hook that re-registers its own key doesn't run again; a key from a hook's rolled-back savepoint drops", async h => {
    const seen: string[] = [];
    const key = {};
    await h.write(async tx => {
      tx.beforeCommit(key, async root => {
        seen.push("hook");
        root.beforeCommit(key, async () => { seen.push("again"); });
        await expect(root.savepoint(async sp => {
          sp.beforeCommit({}, async () => { seen.push("dropped"); });
          await h.put(sp, "sp");
          throw new Error("sp failed");
        })).rejects.toThrow("sp failed");
        await h.put(root, "hook");
      });
    });
    expect(seen).toEqual(["hook"]);
    expect(await h.rows(h.read)).toEqual(["hook"]);
  });
}

function writePath(backend: TxBackend, it: It): void {
  it("write commits a transaction, rolls it back on a throw, and refuses inside an open one", async h => {
    await h.write(tx => h.put(tx, "a"));
    await expect(h.write(() => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(h.write(async tx => { await h.put(tx, "c"); throw new Error("boom"); })).rejects.toThrow("boom");
    let nested: Promise<unknown> | undefined;
    await h.write(() => { nested = h.write(() => 1); });
    await expect(nested!).rejects.toThrow("nested code calls its Tx's savepoint");
    nested = undefined;
    await h.write(async () => { await tick(); nested = h.write(() => 1); });
    await expect(nested!).rejects.toThrow("nested code calls its Tx's savepoint");
    expect(await h.rows(h.read)).toEqual(["a"]);
  });

  it("a commit's effects flush before the queue's next body", async h => {
    const seen: string[] = [];
    const hold = gate();
    const holder = h.queue.run(() => hold.wait);
    const first = h.write(tx => { seen.push("1"); tx.afterCommit(() => { seen.push("1:committed"); }); });
    const second = h.write(() => { seen.push("2"); });
    expect(seen).toEqual([]);
    hold.open();
    await Promise.all([holder, first, second]);
    expect(seen).toEqual(["1", "1:committed", "2"]);
  });

  it("committed runs after its commit and before the queue's next body; a promise it returns doesn't hold the queue", async h => {
    const seen: string[] = [];
    const hold = gate();
    let finish!: () => void;
    const holder = h.queue.run(() => hold.wait);
    const first = h.write(() => { seen.push("body 1"); return 1; }, value => {
      seen.push(`committed 1 (${h.inTransaction() ? "in" : "after"} txn)`);
      return new Promise<number>(r => { finish = () => r(value + 1); });
    });
    const second = h.write(() => { seen.push("body 2"); return 2; });
    hold.open();
    expect(await second).toBe(2);
    expect(seen).toEqual(["body 1", "committed 1 (after txn)", "body 2"]);
    finish();
    expect(await first).toBe(2);
    await holder;
  });

  it("an async afterCommit effect a body started doesn't pass for a later holder", async h => {
    const parked = gate(), hold = gate(), holding = gate();
    const mine = new Promise<boolean>(done => {
      void h.write(tx => { tx.afterCommit(async () => { await parked.wait; done(h.queue.mine); }); });
    });
    const holder = h.queue.run(() => { holding.open(); return hold.wait; });
    await holding.wait;
    parked.open();
    expect(await mine).toBe(false);
    hold.open();
    await holder;
  });

  it("an async write body that rejects after an await rolls back, drops its effects and releases the queue", async h => {
    const seen: string[] = [];
    await expect(h.write(async tx => {
      await h.put(tx, "gone");
      tx.afterCommit(() => { seen.push("effect"); });
      await tick();
      await tx.savepoint(sp => h.put(sp, "gone too"));
      throw new Error("late");
    })).rejects.toThrow("late");
    expect(seen).toEqual([]);
    expect(h.inTransaction()).toBe(false);
    expect(h.queue.held).toBe(false);
    await h.write(tx => h.put(tx, "next"));
    expect(await h.rows(h.read)).toEqual(["next"]);
  });

  // post (#807 P1b-4b): a write no caller awaits.
  it("post waits behind another body's hold, lands after it, and outlives the holder's rollback", async h => {
    const hold = gate(), entered = gate();
    const holder = h.write(async tx => { await h.put(tx, "holder"); entered.open(); await hold.wait; throw new Error("holder rolls back"); });
    await entered.wait;
    const seen: string[] = [];
    expect(h.post(tx => h.put(tx, "posted"), () => { seen.push("committed"); })).toBe(false);
    expect(await h.rows(h.read)).toEqual([]);
    hold.open();
    await expect(holder).rejects.toThrow("holder rolls back");
    await h.drain();
    expect(await h.rows(h.read)).toEqual(["posted"]);
    expect(seen).toEqual(["committed"]);
  });

  // #807 P3 A3: a body's write goes on its Tx; a post inside an open transaction refuses, and the body rolls back.
  it("post inside a write body refuses: the body's write goes on its Tx", async h => {
    const seen: string[] = [];
    await expect(h.write(() => {
      h.post(tx => h.put(tx, "rolled"), () => { seen.push("never"); }, "in-body write");
    })).rejects.toThrow("post inside an open transaction (in-body write)");
    await expect(h.write(async tx => {
      await h.put(tx, "rolled too");
      h.post(t => h.put(t, "posted"), () => { seen.push("never"); }, "async body write");
    })).rejects.toThrow("post inside an open transaction (async body write)");
    await h.drain();
    expect(await h.rows(h.read)).toEqual([]);
    expect(seen).toEqual([]);
  });

  // #807 P3 A3: an async post body holds the queue across its awaits, as an async write body does.
  it("an async post on an idle queue holds the queue until it settles, then commits and runs committed", async h => {
    const resume = gate();
    const seen: string[] = [];
    expect(h.post(async tx => {
      await resume.wait;
      await h.put(tx, "async");
      return 7;
    }, v => { seen.push(`committed ${v}`); })).toBe(false);
    expect(h.queue.held).toBe(true);
    let waited: string[] = [];
    const behind = h.write(async tx => { waited = await h.rows(tx); });
    resume.open();
    await behind;
    expect(waited).toEqual(["async"]);
    expect(seen).toEqual(["committed 7"]);
  });

  it("an async post that rejects rolls back and is logged as its `what`", async h => {
    const logged = await capturingErrors(async logged => {
      expect(h.post(async tx => {
        await h.put(tx, "undone");
        await tick();
        throw new Error("async late");
      }, undefined, "async write")).toBe(false);
      await until(() => failedAs(logged, "async write", "async late").length, 5000, "the async post's failure to be logged");
    });
    expect(failedAs(logged, "async write", "async late")).toHaveLength(1);
    await h.drain();
    expect(await h.rows(h.read)).toEqual([]);
  });

  it("a post that waited and failed is logged as its `what`, not thrown", async h => {
    const hold = gate();
    const holder = h.queue.run(() => hold.wait);
    const logged = await capturingErrors(async logged => {
      expect(h.post(() => { throw new Error("late"); }, undefined, "test write")).toBe(false);
      hold.open();
      await holder;
      await until(() => failedAs(logged, "test write", "late").length, 5000, "the waited post's failure to be logged");
    });
    expect(failedAs(logged, "test write", "late")).toHaveLength(1);
  });

  // #1051: no caller awaits a post, so an async committed's rejection is logged as its `what` on every branch, once.
  it("a post's async committed that rejects is logged as its `what` on every branch, once", async h => {
    const branches = ["idle", "async", "holder", "waited"];
    const rejecting = (branch: string) => async () => { throw new Error(`committed ${branch}`); };
    const logged = await capturingErrors(async logged => {
      // Idle queue, a body that finishes synchronously.
      expect(h.post(tx => h.put(tx, "idle"), rejecting("idle"), "idle write")).toBe(backend.postRunsNow.idle);
      await h.drain();
      // An async body on the idle queue: committed after it settles and commits.
      expect(h.post(async tx => { await tick(); await h.put(tx, "async"); }, rejecting("async"), "async write")).toBe(false);
      await h.drain();
      // The holder outside a transaction (its own committed callback).
      await h.write(() => 1, () => {
        expect(h.post(tx => h.put(tx, "holder"), rejecting("holder"), "holder write")).toBe(backend.postRunsNow.holder);
      });
      await h.drain();
      // Behind another body's hold: it waits.
      const hold = gate();
      const holder = h.queue.run(() => hold.wait);
      expect(h.post(tx => h.put(tx, "waited"), rejecting("waited"), "waited write")).toBe(false);
      hold.open();
      await holder;
      await h.drain();
      await until(() => branches.every(b => failedAs(logged, `${b} write`, `committed ${b}`).length), 5000, "every branch's committed failure to be logged");
      await tick();
    });
    for (const b of branches) expect(failedAs(logged, `${b} write`, `committed ${b}`)).toHaveLength(1);
    expect(await h.rows(h.read)).toEqual(branches);
  });
}
