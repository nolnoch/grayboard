import { describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterCommit } from "../../core/sqlite.ts";
import { openDatabase } from "../db.ts";
import { writeAudit } from "../audit.ts";
import { queueFor, WriteQueue } from "./queue.ts";
import { scratchDbPath } from "../../../tests/support/scratch_db.ts";
import { until } from "../../../tests/support/until.ts";

// A synchronous IMMEDIATE transaction straight on the connection: the queue's guards judge it (the deleted
// Repo.atomic was exactly this).
const txn = <T>(db: ReturnType<typeof open>["db"], fn: () => T): T => db.transaction(fn).immediate() as T;
const open = () => openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
// A user row written on the ambient connection, not a Tx (#807 P1c-7): the queue's own guards, which `txn` and a
// bare statement go through, are what these tests exercise.
const addUser = (db: ReturnType<typeof open>["db"], email: string) => { db.run("INSERT INTO users (email, created_at) VALUES (?, 0)", [email]); };
// A user row written on a body's Tx, synchronously: users.upsertByEmail answers with a promise (#807 P3 A6b), and
// these tests need a body that finishes before its post or write returns.
const putUser = (tx: Tx, email: string) => { sqliteOf(tx).run("INSERT INTO users (email, created_at) VALUES (?, 0)", [email]); };
// A user row read on the ambient connection, synchronously (the deleted repo.policyNow.userByEmail's read, #807 P3
// C10d2-a): what the connection sees right now, a body's uncommitted rows included.
const userOn = (db: ReturnType<typeof open>["db"], email: string) => db.query("SELECT id FROM users WHERE email = ?").get(email) ?? undefined;
import { sqliteOf, type Tx } from "./tx.ts";
import { txContract } from "./tx.contract.ts";
import { sqliteBackend } from "./tx.contract.sqlite.ts";

test("an idle queue runs a synchronous body before run() returns", async () => {
  const q = new WriteQueue();
  const seen: string[] = [];
  const done = q.run(() => { seen.push("body"); return 1; });
  seen.push("returned");
  expect(seen).toEqual(["body", "returned"]);
  expect(q.held).toBe(false);
  expect(await done).toBe(1);
});

test("an async body holds the queue; later bodies run after it, in order", async () => {
  const q = new WriteQueue();
  const seen: string[] = [];
  let release!: () => void;
  const first = q.run(async () => { seen.push("a:start"); await new Promise<void>(r => { release = r; }); seen.push("a:end"); });
  const second = q.run(() => { seen.push("b"); });
  const third = q.run(async () => { seen.push("c"); });
  expect(q.held).toBe(true);
  expect(seen).toEqual(["a:start"]);
  release();
  await Promise.all([first, second, third]);
  expect(seen).toEqual(["a:start", "a:end", "b", "c"]);
  expect(q.held).toBe(false);
});

test("a body that throws or rejects releases the queue and rejects its caller", async () => {
  const q = new WriteQueue();
  await expect(q.run(() => { throw new Error("sync"); })).rejects.toThrow("sync");
  await expect(q.run(async () => { throw new Error("async"); })).rejects.toThrow("async");
  expect(q.held).toBe(false);
  expect(await q.run(() => 2)).toBe(2);
});

test("#925: a backlog of synchronous bodies drains in a loop, not one stack frame per body", async () => {
  const q = new WriteQueue();
  const N = 200_000;
  let release!: () => void;
  const head = q.run(() => new Promise<void>(r => { release = r; }));
  let ran = 0, inOrder = true;
  const tail = Array.from({ length: N }, (_, i) => q.run(() => { if (ran !== i) inOrder = false; ran++; return i; }));
  release();
  await head;
  const out = await Promise.all(tail);
  expect(ran).toBe(N);
  expect(inOrder).toBe(true);
  expect(out[N - 1]).toBe(N - 1);
  expect(q.held).toBe(false);
});

test("#925: a body that returns a thenable that isn't a Promise holds the queue until it settles", async () => {
  const q = new WriteQueue();
  const seen: string[] = [];
  let settle!: (v: number) => void;
  const inner = new Promise<number>(r => { settle = r; });
  const thenable = { then: (ok: (v: number) => unknown, bad?: (e: unknown) => unknown) => inner.then(ok, bad) };
  const first = q.run(() => thenable as unknown as Promise<number>);
  const second = q.run(() => { seen.push("b"); });
  expect(q.held).toBe(true);
  await Promise.resolve();
  expect(seen).toEqual([]);
  settle(5);
  expect(await first).toBe(5);
  await second;
  expect(seen).toEqual(["b"]);
  expect(q.held).toBe(false);
});

test("#925 audit: a lazy thenable's then runs as the holder; a throwing then getter rejects its caller and frees the queue", async () => {
  const q = new WriteQueue();
  let mineInThen: boolean | undefined;
  const lazy = { then: (ok: (v: number) => unknown) => { mineInThen = q.mine; ok(4); } };
  expect(await q.run(() => lazy as unknown as Promise<number>)).toBe(4);
  expect(mineInThen).toBe(true);
  const hostile = Object.defineProperty({}, "then", { get() { throw new Error("getter"); } });
  await expect(q.run(() => hostile)).rejects.toThrow("getter");
  expect(q.held).toBe(false);
  let release!: () => void;
  const head = q.run(() => new Promise<void>(r => { release = r; }));
  const bad = q.run(() => hostile);
  const after = q.run(() => 9);
  release();
  await head;
  await expect(bad).rejects.toThrow("getter");
  expect(await after).toBe(9);
  expect(q.held).toBe(false);
});

test("#925: a synchronous body that throws in a backlog rejects only its caller; the drain goes on", async () => {
  const q = new WriteQueue();
  let release!: () => void;
  const head = q.run(() => new Promise<void>(r => { release = r; }));
  const a = q.run(() => 1);
  const b = q.run(() => { throw new Error("b"); });
  const c = q.run(() => 3);
  release();
  await head;
  expect(await a).toBe(1);
  await expect(b).rejects.toThrow("b");
  expect(await c).toBe(3);
  expect(q.held).toBe(false);
});

test("#1408: a body that waited runs in its enqueuer's async context, not the releasing holder's, and is the holder", async () => {
  const q = new WriteQueue();
  const request = new AsyncLocalStorage<string>();
  let release!: () => void;
  const seen: Array<{ store: string | undefined; mine: boolean }> = [];
  const look = () => { seen.push({ store: request.getStore(), mine: q.mine }); };
  // The holder runs as request A and releases from A's continuation; the waiters were queued as B and C.
  const head = request.run("A", () => q.run(async () => { look(); await new Promise<void>(r => { release = r; }); }));
  const b = request.run("B", () => q.run(() => { look(); }));
  const c = request.run("C", () => q.run(async () => { await Promise.resolve(); look(); }));
  // One queued outside any request: it sees no store, not A's or B's.
  const d = q.run(() => { look(); });
  request.run("A", () => release());
  await Promise.all([head, b, c, d]);
  expect(seen).toEqual([
    { store: "A", mine: true },
    { store: "B", mine: true },
    { store: "C", mine: true },
    { store: undefined, mine: true },
  ]);
  expect(q.held).toBe(false);
});

// #1510: the scheduler's conflict rule. A body that holds until its gate opens, recording its start and end.
function holding(q: WriteQueue, seen: string[], name: string, keys?: string[]) {
  let open!: () => void;
  const gate = new Promise<void>(r => { open = r; });
  const fn = async () => { seen.push(`${name}:start`); await gate; seen.push(`${name}:end`); };
  const done = keys ? q.runKeyed(keys, fn) : q.run(fn);
  return { open, done };
}

describe("#1510 write scheduler", () => {
  test("keyed bodies with no key in common overlap; one sharing a key, or an exclusive one, waits", async () => {
    const q = new WriteQueue(4);
    const seen: string[] = [];
    const a = holding(q, seen, "a", ["root:1"]);
    const b = holding(q, seen, "b", ["root:2", "root:3"]);
    const c = holding(q, seen, "c", ["root:3"]);
    expect(seen).toEqual(["a:start", "b:start"]);
    b.open();
    await b.done;
    // c shared root:3 with b only: it starts as b releases, while a still runs.
    expect(seen).toEqual(["a:start", "b:start", "b:end", "c:start"]);
    const x = holding(q, seen, "x");
    expect(seen.at(-1)).toBe("c:start");
    a.open(); c.open();
    await Promise.all([a.done, c.done]);
    expect(seen.slice(-1)).toEqual(["x:start"]);
    x.open();
    await x.done;
    expect(q.held).toBe(false);
  });

  test("conflicting bodies keep arrival order: same-key bodies run FIFO, and an exclusive one runs in its place", async () => {
    const q = new WriteQueue(4);
    const seen: string[] = [];
    const head = holding(q, seen, "head", ["root:1"]);
    const runs = [
      q.runKeyed(["root:1"], () => { seen.push("k1"); }),
      q.run(() => { seen.push("x"); }),
      q.runKeyed(["root:1"], async () => { await Promise.resolve(); seen.push("k2"); }),
      q.runKeyed(["root:1"], () => { seen.push("k3"); }),
    ];
    head.open();
    await Promise.all([head.done, ...runs]);
    expect(seen).toEqual(["head:start", "head:end", "k1", "x", "k2", "k3"]);
  });

  test("an exclusive body is never starved: keyed bodies arriving behind it wait, though they share no key with what runs", async () => {
    const q = new WriteQueue(8);
    const seen: string[] = [];
    const a = holding(q, seen, "a", ["root:1"]);
    const x = holding(q, seen, "x");
    // A stream of keyed bodies on other keys, each of which could run beside a.
    const later = [holding(q, seen, "b", ["root:2"]), holding(q, seen, "c", ["root:3"])];
    expect(seen).toEqual(["a:start"]);
    a.open();
    await a.done;
    expect(seen).toEqual(["a:start", "a:end", "x:start"]);
    x.open();
    await x.done;
    expect(seen).toEqual(["a:start", "a:end", "x:start", "x:end", "b:start", "c:start"]);
    for (const l of later) l.open();
    await Promise.all(later.map(l => l.done));
  });

  test("a keyed body behind a waiting keyed body that shares its key waits too, though what runs doesn't conflict with it", async () => {
    const q = new WriteQueue(8);
    const seen: string[] = [];
    const a = holding(q, seen, "a", ["root:1"]);
    const b = holding(q, seen, "b", ["root:1", "root:2"]);
    const c = holding(q, seen, "c", ["root:2"]);
    const d = holding(q, seen, "d", ["root:3"]);
    expect(seen).toEqual(["a:start", "d:start"]);
    a.open();
    await a.done;
    expect(seen.slice(-1)).toEqual(["b:start"]);
    b.open();
    await b.done;
    expect(seen.slice(-1)).toEqual(["c:start"]);
    c.open(); d.open();
    await Promise.all([c.done, d.done]);
  });

  test("the cap bounds how many bodies run; the next in arrival order takes a freed slot", async () => {
    const q = new WriteQueue(2);
    const seen: string[] = [];
    const a = holding(q, seen, "a", ["root:1"]);
    const b = holding(q, seen, "b", ["root:2"]);
    const c = holding(q, seen, "c", ["root:3"]);
    const d = holding(q, seen, "d", ["root:4"]);
    expect(seen).toEqual(["a:start", "b:start"]);
    b.open();
    await b.done;
    expect(seen).toEqual(["a:start", "b:start", "b:end", "c:start"]);
    a.open(); c.open(); d.open();
    await Promise.all([a.done, c.done, d.done]);
    expect(seen.filter(s => s.endsWith(":start"))).toEqual(["a:start", "b:start", "c:start", "d:start"]);
    expect(() => new WriteQueue(0)).toThrow("whole number from 1");
  });

  test("each body has its own token: overlapping bodies are each `mine` to themselves only, and a body's continuation stops being mine once it releases", async () => {
    const q = new WriteQueue(2);
    let releaseA!: () => void, releaseB!: () => void, resumeAfter!: () => void;
    const tokens: Array<object | undefined> = [];
    let aLate: { mine: boolean; token: object | undefined } | undefined;
    const after = new Promise<void>(r => { resumeAfter = r; });
    const a = q.runKeyed(["root:1"], async () => {
      tokens.push(q.token);
      // Left running past a's release, as an async afterCommit effect is.
      void after.then(() => { aLate = { mine: q.mine, token: q.token }; });
      await new Promise<void>(r => { releaseA = r; });
      expect(q.mine).toBe(true);
    });
    const b = q.runKeyed(["root:2"], async () => {
      tokens.push(q.token);
      await new Promise<void>(r => { releaseB = r; });
      expect(q.mine).toBe(true);
    });
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toBeDefined();
    expect(tokens[1]).toBeDefined();
    expect(tokens[0]).not.toBe(tokens[1]);
    // Outside both bodies.
    expect(q.mine).toBe(false);
    expect(q.held).toBe(true);
    releaseA();
    await a;
    resumeAfter();
    await until(() => aLate, 5000, "a's left-over continuation to run");
    // b still runs; a's continuation is not b, and not a any more.
    expect(aLate).toEqual({ mine: false, token: undefined });
    releaseB();
    await b;
    expect(q.held).toBe(false);
  });

  test("a body that arrives from a synchronous body's start waits for that body, even keyed on another key, then runs", async () => {
    const q = new WriteQueue(4);
    const seen: string[] = [];
    let inner: Promise<void> | undefined;
    await q.runKeyed(["root:1"], () => {
      inner = q.runKeyed(["root:2"], () => { seen.push("inner"); });
      seen.push("outer");
    });
    await inner;
    expect(seen).toEqual(["outer", "inner"]);
  });

  // Audit L1: the holder store is one AsyncLocalStorage for every queue; a token answers only for its own.
  test("a body of one queue is not `mine` on another, and has no token there", async () => {
    const a = new WriteQueue(), b = new WriteQueue(2);
    const seen: unknown[] = [];
    await a.run(() => { seen.push(a.mine, a.token !== undefined, b.mine, b.token, b.held); });
    await b.runKeyed(["root:1"], async () => { await Promise.resolve(); seen.push(b.mine, a.mine, a.token); });
    expect(seen).toEqual([true, true, false, undefined, false, true, false, undefined]);
  });

  test("runKeyed refuses an empty key list or key", async () => {
    const q = new WriteQueue(2);
    await expect(q.runKeyed([], () => 1)).rejects.toThrow("at least one key");
    await expect(q.runKeyed([""], () => 1)).rejects.toThrow("non-empty string");
    expect(q.held).toBe(false);
  });

  test("#1408 holds for keyed waiters: each starts in its enqueuer's context with its own token", async () => {
    const q = new WriteQueue(4);
    const request = new AsyncLocalStorage<string>();
    const seen: Array<{ store: string | undefined; mine: boolean }> = [];
    let release!: () => void;
    const head = request.run("A", () => q.runKeyed(["root:1"], async () => { await new Promise<void>(r => { release = r; }); }));
    const b = request.run("B", () => q.runKeyed(["root:1"], () => { seen.push({ store: request.getStore(), mine: q.mine }); }));
    request.run("A", () => release());
    await Promise.all([head, b]);
    expect(seen).toEqual([{ store: "B", mine: true }]);
  });
});

test("Repo.write commits a transaction, rolls it back on a throw, and refuses inside an open one", async () => {
  const { db, repo } = open();
  await repo.write(tx => repo.users.upsertByEmail(tx, "a@example.com", null));
  expect(userOn(db, "a@example.com")).toBeDefined();
  await expect(repo.write(tx => { putUser(tx, "b@example.com"); throw new Error("boom"); })).rejects.toThrow("boom");
  expect(userOn(db, "b@example.com")).toBeUndefined();
  let nested: Promise<unknown> | undefined;
  await repo.write(() => { nested = repo.write(() => 1); });
  await expect(nested!).rejects.toThrow("nested code calls its Tx's savepoint");
});

test("the Repo and the hosted store share one queue, and a commit's effects flush before the next body", async () => {
  const { db, repo } = open();
  const seen: string[] = [];
  let release!: () => void;
  // Holds the queue the way an awaited transaction body will (P1b), so the next two wait behind it.
  const holder = queueFor(db).run(() => new Promise<void>(r => { release = r; }));
  const viaRepo = repo.write(() => { seen.push("repo"); afterCommit(db, () => { seen.push("repo:committed"); }); });
  const viaHosted = repo.hosted.write(() => { seen.push("hosted"); });
  expect(seen).toEqual([]);
  release();
  await Promise.all([holder, viaRepo, viaHosted]);
  expect(seen).toEqual(["repo", "repo:committed", "hosted"]);
});

test("committed runs after its commit and before the queue's next body; a promise it returns doesn't hold the queue", async () => {
  const { db, repo } = open();
  const seen: string[] = [];
  let release!: () => void, finish!: () => void;
  const holder = queueFor(db).run(() => new Promise<void>(r => { release = r; }));
  const first = repo.hosted.write(() => { seen.push("body 1"); return 1; }, value => {
    seen.push(`committed 1 (${db.inTransaction ? "in" : "after"} txn)`);
    return new Promise<number>(r => { finish = () => r(value + 1); });
  });
  const second = repo.write(() => { seen.push("body 2"); return 2; });
  release();
  expect(await second).toBe(2);
  expect(seen).toEqual(["body 1", "committed 1 (after txn)", "body 2"]);
  finish();
  expect(await first).toBe(2);
  await holder;
});

test("a top-level transaction refuses unless its caller holds the queue; the holder's own code, after an await or in committed, opens one", async () => {
  const { db, repo } = open();
  let release!: () => void;
  let inside: string | undefined;
  const holder = queueFor(db).run(async () => {
    await new Promise<void>(r => { release = r; });
    // The holder, resumed after its await: its own transaction opens.
    inside = txn(db, () => { addUser(db, "holder@example.com"); return "opened"; });
  });
  expect(queueFor(db).mine).toBe(false);
  expect(() => txn(db, () => addUser(db, "other@example.com"))).toThrow("another body holds the write queue");
  expect(userOn(db, "other@example.com")).toBeUndefined();
  release();
  await holder;
  expect(inside).toBe("opened");
  // Idle again: a direct transaction, or an autocommit write, is still outside the queue (#807 P1b-4e).
  expect(() => txn(db, () => addUser(db, "after@example.com"))).toThrow("write outside the write queue");
  expect(() => addUser(db, "after@example.com")).toThrow("write outside the write queue");
  // A bare autocommit write, by a statement or by exec (db.run with no bindings); DDL stays open to tests.
  expect(() => db.prepare("DELETE FROM users WHERE email = ?").run("holder@example.com")).toThrow("write outside the write queue");
  expect(() => db.run("DELETE FROM users WHERE email = 'holder@example.com'")).toThrow("write outside the write queue");
  expect(() => db.exec("DELETE FROM users WHERE email = 'holder@example.com'")).toThrow("write outside the write queue");
  expect(userOn(db, "holder@example.com")).toBeDefined();
  db.run("CREATE TEMP TRIGGER IF NOT EXISTS t_queue_test AFTER INSERT ON users BEGIN SELECT 1; END");
  // #995: a script that leads with DDL is still checked for the writes after it, and a statement prepared with its
  // bindings (native, past the routing) is refused.
  expect(() => db.run("CREATE TEMP TABLE IF NOT EXISTS t995(a); DELETE FROM users WHERE email = 'holder@example.com'")).toThrow("write outside the write queue");
  expect(() => db.exec("CREATE TEMP TABLE IF NOT EXISTS t995(a); DELETE FROM users WHERE email = 'holder@example.com'")).toThrow("write outside the write queue");
  expect(userOn(db, "holder@example.com")).toBeDefined();
  expect(() => db.prepare("DELETE FROM users WHERE email = ?", ["holder@example.com"])).toThrow("prepare(sql, params) on a routed connection");
  expect(userOn(db, "holder@example.com")).toBeDefined();
  expect(userOn(db, "after@example.com")).toBeUndefined();
  // committed runs inside its body, so a write there (cancel's settle) opens.
  expect(await repo.write(() => 1, v => txn(db, () => { addUser(db, "committed@example.com"); return v + 1; }))).toBe(2);
  expect(userOn(db, "committed@example.com")).toBeDefined();
});

test("an async afterCommit effect a body started doesn't pass for a later holder", async () => {
  const { db, repo } = open();
  let resume!: () => void, release!: () => void;
  const parked = new Promise<void>(r => { resume = r; });
  let seen: unknown;
  // Body 1's effect carries body 1's async context past body 1's release.
  const effect = new Promise<void>(done => {
    void repo.write(() => {
      afterCommit(db, async () => {
        await parked;
        try { txn(db, () => 1); seen = "opened"; } catch (e) { seen = (e as Error).message; }
        done();
      });
    });
  });
  const holder = queueFor(db).run(() => new Promise<void>(r => { release = r; }));
  resume();
  await effect;
  expect(String(seen)).toContain("another body holds the write queue");
  release();
  await holder;
});

// post (#807 P1b-4b): a write no caller awaits.
test("post runs now on an idle queue, through it, and throws its error there", () => {
  const { db, repo } = open();
  let mine = false;
  expect(repo.post(tx => { mine = queueFor(db).mine; putUser(tx, "idle@example.com"); })).toBe(true);
  expect(mine).toBe(true);
  expect(userOn(db, "idle@example.com")).toBeDefined();
  expect(() => repo.post(() => { throw new Error("now"); })).toThrow("now");
  expect(queueFor(db).held).toBe(false);
});

// #807 P3 A3: an idle-queue post's synchronous failures outside fn are thrown too, as the old writeNow threw them.
test("post on an idle queue throws a failed BEGIN and a throwing committed, once, without logging them", async () => {
  const { db, repo } = open();
  const logged: unknown[][] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    db.run("BEGIN"); // outside the queue: the post's BEGIN IMMEDIATE fails
    try { expect(() => repo.post(() => {}, undefined, "begin write")).toThrow(); } finally { db.run("ROLLBACK"); }
    expect(queueFor(db).held).toBe(false);
    expect(() => repo.post(tx => { putUser(tx, "kept@example.com"); }, () => { throw new Error("committed threw"); }, "committed write")).toThrow("committed threw");
    expect(userOn(db, "kept@example.com")).toBeDefined();
    for (let i = 0; i < 5; i++) await Promise.resolve();
  } finally { console.error = error; }
  expect(logged.filter(a => String(a[0]).includes("begin write") || String(a[0]).includes("committed write"))).toEqual([]);
});

test("post waits behind another body's hold, lands after it, and outlives the holder's rollback", async () => {
  const { db, repo } = open();
  let release!: () => void;
  const holder = queueFor(db).run(async () => {
    await new Promise<void>(r => { release = r; });
    try { txn(db, () => { addUser(db, "holder@example.com"); throw new Error("holder rolls back"); }); } catch {}
  });
  const seen: string[] = [];
  expect(repo.post(tx => { putUser(tx, "posted@example.com"); }, () => seen.push("committed"))).toBe(false);
  expect(userOn(db, "posted@example.com")).toBeUndefined();
  release();
  await holder;
  await queueFor(db).run(() => {});
  expect(userOn(db, "holder@example.com")).toBeUndefined();
  expect(userOn(db, "posted@example.com")).toBeDefined();
  expect(seen).toEqual(["committed"]);
});

// #807 P3 A3: a body's write goes on its Tx; a post inside an open transaction refuses, and the body rolls back.
test("post inside a write body refuses: the body's write goes on its Tx", async () => {
  const { db, repo } = open();
  const seen: string[] = [];
  await expect(repo.write(() => {
    repo.post(tx => { putUser(tx, "rolled@example.com"); }, () => seen.push("never"), "in-body write");
  })).rejects.toThrow("post inside an open transaction (in-body write)");
  expect(userOn(db, "rolled@example.com")).toBeUndefined();
  expect(seen).toEqual([]);
});

// #807 P3 A3: an async post body holds the queue across its awaits, as an async write body does.
test("an async post on an idle queue holds the queue until it settles, then commits and runs committed", async () => {
  const { db, repo } = open();
  let resume!: () => void;
  const seen: string[] = [];
  expect(repo.post(async tx => {
    await new Promise<void>(r => { resume = r; });
    putUser(tx, "async@example.com");
    return 7;
  }, v => seen.push(`committed ${v}`))).toBe(false);
  expect(queueFor(db).held).toBe(true);
  let waited = false;
  const behind = repo.write(() => { waited = userOn(db, "async@example.com") !== undefined; });
  resume();
  await behind;
  expect(waited).toBe(true);
  expect(seen).toEqual(["committed 7"]);
});

test("an async post that rejects rolls back and is logged as its `what`", async () => {
  const { db, repo } = open();
  const logged: unknown[][] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    expect(repo.post(async tx => {
      putUser(tx, "undone@example.com");
      await Promise.resolve();
      throw new Error("async late");
    }, undefined, "async write")).toBe(false);
    await queueFor(db).run(() => {});
    for (let i = 0; i < 5; i++) await Promise.resolve();
  } finally { console.error = error; }
  expect(userOn(db, "undone@example.com")).toBeUndefined();
  expect(logged.some(a => a[0] === "[grayboard] async write failed:" && String(a[1]).includes("async late"))).toBe(true);
});

test("an async post from the holder outside a transaction refuses and rolls back", async () => {
  const { db, repo } = open();
  let thrown: unknown;
  await repo.write(() => 1, () => {
    try {
      repo.post(async tx => { putUser(tx, "holder-async@example.com"); await Promise.resolve(); }, undefined, "holder async");
    } catch (error) { thrown = error; }
  });
  expect(String(thrown)).toContain("async post from the write queue's holder (holder async)");
  expect(db.inTransaction).toBe(false);
  expect(userOn(db, "holder-async@example.com")).toBeUndefined();
});

test("post from the holder outside a transaction (its committed callback) opens its own", async () => {
  const { db, repo } = open();
  let inTxn: boolean | undefined;
  await repo.write(() => 1, () => {
    expect(db.inTransaction).toBe(false);
    expect(repo.post(tx => { inTxn = db.inTransaction; putUser(tx, "committed-post@example.com"); })).toBe(true);
  });
  expect(inTxn).toBe(true);
  expect(userOn(db, "committed-post@example.com")).toBeDefined();
});

test("a post that waited and failed is logged as its `what`, not thrown", async () => {
  const { db, repo } = open();
  let release!: () => void;
  const holder = queueFor(db).run(() => new Promise<void>(r => { release = r; }));
  const logged: unknown[][] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    expect(repo.post(() => { throw new Error("late"); }, undefined, "test write")).toBe(false);
    release();
    await holder;
    await queueFor(db).run(() => {});
    await Promise.resolve();
  } finally { console.error = error; }
  expect(logged.some(a => a[0] === "[grayboard] test write failed:" && String(a[1]).includes("late"))).toBe(true);
});

// #1051: no caller awaits a post, so an async committed's rejection is logged as its `what` on every branch, once.
test("a post's async committed that rejects is logged as its `what` on every branch, once", async () => {
  const { db, repo } = open();
  const logged: unknown[][] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  const rejecting = (branch: string) => async () => { throw new Error(`committed ${branch}`); };
  const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  try {
    // Idle queue: runs now, through it.
    expect(repo.post(tx => { putUser(tx, "idle@example.com"); }, rejecting("idle"), "idle write")).toBe(true);
    // An async body on the idle queue: committed after it settles and commits.
    expect(repo.post(async tx => { await Promise.resolve(); putUser(tx, "async@example.com"); }, rejecting("async"), "async write")).toBe(false);
    await queueFor(db).run(() => {});
    // The holder outside a transaction (its own committed callback).
    await repo.write(() => 1, () => { repo.post(tx => { putUser(tx, "holder@example.com"); }, rejecting("holder"), "holder write"); });
    // Behind another body's hold: it waits.
    let release!: () => void;
    const holder = queueFor(db).run(() => new Promise<void>(r => { release = r; }));
    expect(repo.post(tx => { putUser(tx, "waited@example.com"); }, rejecting("waited"), "waited write")).toBe(false);
    release();
    await holder;
    await queueFor(db).run(() => {});
    await settle();
  } finally { console.error = error; }
  for (const branch of ["idle", "async", "holder", "waited"]) {
    expect(userOn(db, `${branch}@example.com`)).toBeDefined();
    expect(logged.filter(a => a[0] === `[grayboard] ${branch} write failed:` && String(a[1]).includes(`committed ${branch}`))).toHaveLength(1);
  }
});

test("writeAudit under another body's hold waits for it rather than writing into it", async () => {
  const { db, repo } = open();
  let release!: () => void;
  const holder = queueFor(db).run(() => new Promise<void>(r => { release = r; }));
  writeAudit(repo, repo.read, "hosted.stream_closed", null, "s-1", { reason: "test" });
  expect(await repo.audit.last(repo.read, "hosted.stream_closed", "s-1")).toBeUndefined();
  release();
  await holder;
  await queueFor(db).run(() => {});
  expect(await repo.audit.last(repo.read, "hosted.stream_closed", "s-1")).toBeDefined();
});

// #807 P1b-4e: a write body may await. Its transaction stays open, and the queue held, across the await; meanwhile
// every other task is outside it.
test("an async write body keeps its transaction across awaits: others read committed state, their writes wait or are refused", async () => {
  const { db, repo } = open();
  const seen: string[] = [];
  let resume!: () => void, entered!: () => void;
  const paused = new Promise<void>(r => { resume = r; }), inside = new Promise<void>(r => { entered = r; });
  const body = repo.write(async tx => {
    putUser(tx, "async@example.com");
    entered();
    await paused;
    // Resumed: still its own transaction. It reads its uncommitted row, a savepoint nests in it, and an effect
    // waits for the commit.
    expect(userOn(db, "async@example.com")).toBeDefined();
    await tx.savepoint(sp => putUser(sp, "nested@example.com"));
    afterCommit(db, () => { seen.push("holder committed"); });
    expect(seen).toEqual(["other's effect"]);
    return "done";
  });
  await inside;
  expect(db.inTransaction).toBe(true);
  // Another task reads committed state (the reader), not the holder's uncommitted row.
  expect(userOn(db, "async@example.com")).toBeUndefined();
  // Its autocommit write and its top-level transaction are refused; its effect runs now.
  expect(() => addUser(db, "other@example.com")).toThrow("another body holds the write queue");
  expect(() => txn(db, () => 1)).toThrow("another body holds the write queue");
  afterCommit(db, () => { seen.push("other's effect"); });
  expect(seen).toEqual(["other's effect"]);
  // A queued write waits its turn and commits after the holder.
  const waiting = repo.write(tx => { seen.push("queued body"); return putUser(tx, "queued@example.com"); });
  expect(seen).toEqual(["other's effect"]);
  resume();
  expect(await body).toBe("done");
  await waiting;
  expect(seen).toEqual(["other's effect", "holder committed", "queued body"]);
  for (const who of ["async", "nested", "queued"]) expect(userOn(db, `${who}@example.com`)).toBeDefined();
  expect(userOn(db, "other@example.com")).toBeUndefined();
  expect(db.inTransaction).toBe(false);
  expect(queueFor(db).held).toBe(false);
});

test("an async write body that rejects after an await rolls back, drops its effects and releases the queue", async () => {
  const { db, repo } = open();
  const seen: string[] = [];
  await expect(repo.write(async tx => {
    putUser(tx, "gone@example.com");
    afterCommit(db, () => { seen.push("effect"); });
    await Promise.resolve();
    await tx.savepoint(sp => putUser(sp, "gone-too@example.com"));
    throw new Error("late");
  })).rejects.toThrow("late");
  expect(userOn(db, "gone@example.com")).toBeUndefined();
  expect(userOn(db, "gone-too@example.com")).toBeUndefined();
  expect(seen).toEqual([]);
  expect(db.inTransaction).toBe(false);
  expect(queueFor(db).held).toBe(false);
  // The queue goes on: the next body commits.
  await repo.write(tx => repo.users.upsertByEmail(tx, "next@example.com", null));
  expect(userOn(db, "next@example.com")).toBeDefined();
});

test("a COMMIT that fails rolls the body back, drops its effects and releases the queue", async () => {
  const { db, repo } = open();
  // A deferred foreign key is checked at COMMIT, so the body runs clean and its COMMIT fails.
  db.run("CREATE TABLE fk_parent (id INTEGER PRIMARY KEY)");
  db.run("CREATE TABLE fk_child (p INTEGER REFERENCES fk_parent(id) DEFERRABLE INITIALLY DEFERRED)");
  const seen: string[] = [];
  for (const body of [() => 1, async () => { await Promise.resolve(); return 1; }]) {
    await expect(repo.write(((tx: Tx) => {
      putUser(tx, "orphaned@example.com");
      db.query("INSERT INTO fk_child (p) VALUES (?)").run(99);
      afterCommit(db, () => { seen.push("effect"); });
      return body();
    }) as (tx: Tx) => Promise<number>)).rejects.toThrow(/FOREIGN KEY/);
    expect(userOn(db, "orphaned@example.com")).toBeUndefined();
    expect(seen).toEqual([]);
    expect(db.inTransaction).toBe(false);
    expect(queueFor(db).held).toBe(false);
  }
  await repo.write(tx => repo.users.upsertByEmail(tx, "next@example.com", null));
  expect(userOn(db, "next@example.com")).toBeDefined();
});

// The portable Repo-level rows above, as the backend-neutral contract every store runs (tx.contract.ts).
describe("contract (SQLite)", () => txContract(sqliteBackend, "write-path"));
