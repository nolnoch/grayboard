import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterCommit } from "../../core/sqlite.ts";
import { openDatabase } from "../db.ts";
import { writeAudit } from "../audit.ts";
import { queueFor, WriteQueue } from "./queue.ts";
import { scratchDbPath } from "../../../tests/support/scratch_db.ts";

const open = () => openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
// A user row written on the ambient connection, not a Tx (#807 P1c-7): the queue's own guards, which atomic and a
// bare statement go through, are what these tests exercise.
const addUser = (db: ReturnType<typeof open>["db"], email: string) => { db.run("INSERT INTO users (email, created_at) VALUES (?, 0)", [email]); };
import type { Tx } from "./tx.ts";

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

test("Repo.write commits a transaction, rolls it back on a throw, and refuses inside an open one", async () => {
  const { repo } = open();
  await repo.write(tx => repo.users.upsertByEmail(tx, "a@example.com", null));
  expect(repo.users.findByEmail("a@example.com")).toBeDefined();
  await expect(repo.write(tx => { repo.users.upsertByEmail(tx, "b@example.com", null); throw new Error("boom"); })).rejects.toThrow("boom");
  expect(repo.users.findByEmail("b@example.com")).toBeUndefined();
  let nested: Promise<unknown> | undefined;
  await repo.write(() => { nested = repo.write(() => 1); });
  await expect(nested!).rejects.toThrow("nested code calls atomic");
});

test("#807: writeNow runs its transaction now through an idle queue, and refuses while the queue is held or a transaction is open", async () => {
  const { db, repo } = open();
  const seen: string[] = [];
  expect(repo.writeNow(tx => { repo.users.upsertByEmail(tx, "now@example.com", null); afterCommit(db, () => { seen.push("committed"); }); return 7; })).toBe(7);
  expect(seen).toEqual(["committed"]);
  expect(repo.users.findByEmail("now@example.com")).toBeDefined();
  expect(() => repo.writeNow(tx => { repo.users.upsertByEmail(tx, "rolled@example.com", null); throw new Error("boom"); })).toThrow("boom");
  expect(repo.users.findByEmail("rolled@example.com")).toBeUndefined();
  expect(queueFor(db).held).toBe(false);
  let release!: () => void;
  const holder = queueFor(db).run(() => new Promise<void>(r => { release = r; }));
  expect(() => repo.writeNow(tx => repo.users.upsertByEmail(tx, "held@example.com", null))).toThrow("writeNow while the write queue is held");
  expect(() => repo.hosted.writeNow(() => 1)).toThrow("writeNow while the write queue is held");
  release();
  await holder;
  expect(repo.users.findByEmail("held@example.com")).toBeUndefined();
  expect(repo.hosted.writeNow(() => 2)).toBe(2);
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
    inside = repo.atomic(() => { addUser(db, "holder@example.com"); return "opened"; });
  });
  expect(queueFor(db).mine).toBe(false);
  expect(() => repo.atomic(() => addUser(db, "other@example.com"))).toThrow("another body holds the write queue");
  expect(() => repo.hosted.atomic(() => 1)).toThrow("another body holds the write queue");
  expect(repo.users.findByEmail("other@example.com")).toBeUndefined();
  release();
  await holder;
  expect(inside).toBe("opened");
  // Idle again: a direct transaction, or an autocommit write, is still outside the queue (#807 P1b-4e).
  expect(() => repo.atomic(() => addUser(db, "after@example.com"))).toThrow("write outside the write queue");
  expect(() => addUser(db, "after@example.com")).toThrow("write outside the write queue");
  // A bare autocommit write, by a statement or by exec (db.run with no bindings); DDL stays open to tests.
  expect(() => db.prepare("DELETE FROM users WHERE email = ?").run("holder@example.com")).toThrow("write outside the write queue");
  expect(() => db.run("DELETE FROM users WHERE email = 'holder@example.com'")).toThrow("write outside the write queue");
  expect(() => db.exec("DELETE FROM users WHERE email = 'holder@example.com'")).toThrow("write outside the write queue");
  expect(repo.users.findByEmail("holder@example.com")).toBeDefined();
  db.run("CREATE TEMP TRIGGER IF NOT EXISTS t_queue_test AFTER INSERT ON users BEGIN SELECT 1; END");
  // #995: a script that leads with DDL is still checked for the writes after it, and a statement prepared with its
  // bindings (native, past the routing) is refused.
  expect(() => db.run("CREATE TEMP TABLE IF NOT EXISTS t995(a); DELETE FROM users WHERE email = 'holder@example.com'")).toThrow("write outside the write queue");
  expect(() => db.exec("CREATE TEMP TABLE IF NOT EXISTS t995(a); DELETE FROM users WHERE email = 'holder@example.com'")).toThrow("write outside the write queue");
  expect(repo.users.findByEmail("holder@example.com")).toBeDefined();
  expect(() => db.prepare("DELETE FROM users WHERE email = ?", ["holder@example.com"])).toThrow("prepare(sql, params) on a routed connection");
  expect(repo.users.findByEmail("holder@example.com")).toBeDefined();
  expect(repo.users.findByEmail("after@example.com")).toBeUndefined();
  // committed runs inside its body, so a write there (cancel's settle) opens.
  expect(await repo.write(() => 1, v => repo.atomic(() => { addUser(db, "committed@example.com"); return v + 1; }))).toBe(2);
  expect(repo.users.findByEmail("committed@example.com")).toBeDefined();
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
        try { repo.atomic(() => 1); seen = "opened"; } catch (e) { seen = (e as Error).message; }
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
  expect(repo.post(tx => { mine = queueFor(db).mine; repo.users.upsertByEmail(tx, "idle@example.com", null); })).toBe(true);
  expect(mine).toBe(true);
  expect(repo.users.findByEmail("idle@example.com")).toBeDefined();
  expect(() => repo.post(() => { throw new Error("now"); })).toThrow("now");
  expect(queueFor(db).held).toBe(false);
});

// #807 P3 A3: an idle-queue post's synchronous failures outside fn are thrown too, as queuedNow threw them.
test("post on an idle queue throws a failed BEGIN and a throwing committed, once, without logging them", async () => {
  const { db, repo } = open();
  const logged: unknown[][] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    db.run("BEGIN"); // outside the queue: the post's BEGIN IMMEDIATE fails
    try { expect(() => repo.post(() => {}, undefined, "begin write")).toThrow(); } finally { db.run("ROLLBACK"); }
    expect(queueFor(db).held).toBe(false);
    expect(() => repo.post(tx => { repo.users.upsertByEmail(tx, "kept@example.com", null); }, () => { throw new Error("committed threw"); }, "committed write")).toThrow("committed threw");
    expect(repo.users.findByEmail("kept@example.com")).toBeDefined();
    for (let i = 0; i < 5; i++) await Promise.resolve();
  } finally { console.error = error; }
  expect(logged.filter(a => String(a[0]).includes("begin write") || String(a[0]).includes("committed write"))).toEqual([]);
});

test("post waits behind another body's hold, lands after it, and outlives the holder's rollback", async () => {
  const { db, repo } = open();
  let release!: () => void;
  const holder = queueFor(db).run(async () => {
    await new Promise<void>(r => { release = r; });
    try { repo.atomic(() => { addUser(db, "holder@example.com"); throw new Error("holder rolls back"); }); } catch {}
  });
  const seen: string[] = [];
  expect(repo.post(tx => { repo.users.upsertByEmail(tx, "posted@example.com", null); }, () => seen.push("committed"))).toBe(false);
  expect(repo.users.findByEmail("posted@example.com")).toBeUndefined();
  release();
  await holder;
  await queueFor(db).run(() => {});
  expect(repo.users.findByEmail("holder@example.com")).toBeUndefined();
  expect(repo.users.findByEmail("posted@example.com")).toBeDefined();
  expect(seen).toEqual(["committed"]);
});

// #807 P3 A3: a body's write goes on its Tx; a post inside an open transaction refuses, and the body rolls back.
test("post inside a write body refuses: the body's write goes on its Tx", async () => {
  const { repo } = open();
  const seen: string[] = [];
  await expect(repo.write(() => {
    repo.post(tx => { repo.users.upsertByEmail(tx, "rolled@example.com", null); }, () => seen.push("never"), "in-body write");
  })).rejects.toThrow("post inside an open transaction (in-body write)");
  expect(repo.users.findByEmail("rolled@example.com")).toBeUndefined();
  expect(seen).toEqual([]);
});

// #807 P3 A3: an async post body holds the queue across its awaits, as an async write body does.
test("an async post on an idle queue holds the queue until it settles, then commits and runs committed", async () => {
  const { db, repo } = open();
  let resume!: () => void;
  const seen: string[] = [];
  expect(repo.post(async tx => {
    await new Promise<void>(r => { resume = r; });
    repo.users.upsertByEmail(tx, "async@example.com", null);
    return 7;
  }, v => seen.push(`committed ${v}`))).toBe(false);
  expect(queueFor(db).held).toBe(true);
  let waited = false;
  const behind = repo.write(() => { waited = repo.users.findByEmail("async@example.com") !== undefined; });
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
      repo.users.upsertByEmail(tx, "undone@example.com", null);
      await Promise.resolve();
      throw new Error("async late");
    }, undefined, "async write")).toBe(false);
    await queueFor(db).run(() => {});
    for (let i = 0; i < 5; i++) await Promise.resolve();
  } finally { console.error = error; }
  expect(repo.users.findByEmail("undone@example.com")).toBeUndefined();
  expect(logged.some(a => a[0] === "[grayboard] async write failed:" && String(a[1]).includes("async late"))).toBe(true);
});

test("an async post from the holder outside a transaction refuses and rolls back", async () => {
  const { db, repo } = open();
  let thrown: unknown;
  await repo.write(() => 1, () => {
    try {
      repo.post(async tx => { repo.users.upsertByEmail(tx, "holder-async@example.com", null); await Promise.resolve(); }, undefined, "holder async");
    } catch (error) { thrown = error; }
  });
  expect(String(thrown)).toContain("async post from the write queue's holder (holder async)");
  expect(db.inTransaction).toBe(false);
  expect(repo.users.findByEmail("holder-async@example.com")).toBeUndefined();
});

test("post from the holder outside a transaction (its committed callback) opens its own", async () => {
  const { db, repo } = open();
  let inTxn: boolean | undefined;
  await repo.write(() => 1, () => {
    expect(db.inTransaction).toBe(false);
    expect(repo.post(tx => { inTxn = db.inTransaction; repo.users.upsertByEmail(tx, "committed-post@example.com", null); })).toBe(true);
  });
  expect(inTxn).toBe(true);
  expect(repo.users.findByEmail("committed-post@example.com")).toBeDefined();
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
    expect(repo.post(tx => { repo.users.upsertByEmail(tx, "idle@example.com", null); }, rejecting("idle"), "idle write")).toBe(true);
    // An async body on the idle queue: committed after it settles and commits.
    expect(repo.post(async tx => { await Promise.resolve(); repo.users.upsertByEmail(tx, "async@example.com", null); }, rejecting("async"), "async write")).toBe(false);
    await queueFor(db).run(() => {});
    // The holder outside a transaction (its own committed callback).
    await repo.write(() => 1, () => { repo.post(tx => { repo.users.upsertByEmail(tx, "holder@example.com", null); }, rejecting("holder"), "holder write"); });
    // Behind another body's hold: it waits.
    let release!: () => void;
    const holder = queueFor(db).run(() => new Promise<void>(r => { release = r; }));
    expect(repo.post(tx => { repo.users.upsertByEmail(tx, "waited@example.com", null); }, rejecting("waited"), "waited write")).toBe(false);
    release();
    await holder;
    await queueFor(db).run(() => {});
    await settle();
  } finally { console.error = error; }
  for (const branch of ["idle", "async", "holder", "waited"]) {
    expect(repo.users.findByEmail(`${branch}@example.com`)).toBeDefined();
    expect(logged.filter(a => a[0] === `[grayboard] ${branch} write failed:` && String(a[1]).includes(`committed ${branch}`))).toHaveLength(1);
  }
});

test("writeAudit under another body's hold waits for it rather than writing into it", async () => {
  const { db, repo } = open();
  let release!: () => void;
  const holder = queueFor(db).run(() => new Promise<void>(r => { release = r; }));
  writeAudit(repo, repo.read, "hosted.stream_closed", null, "s-1", { reason: "test" });
  expect(repo.audit.last(repo.read, "hosted.stream_closed", "s-1")).toBeUndefined();
  release();
  await holder;
  await queueFor(db).run(() => {});
  expect(repo.audit.last(repo.read, "hosted.stream_closed", "s-1")).toBeDefined();
});

// #807 P1b-4e: a write body may await. Its transaction stays open, and the queue held, across the await; meanwhile
// every other task is outside it.
test("an async write body keeps its transaction across awaits: others read committed state, their writes wait or are refused", async () => {
  const { db, repo } = open();
  const seen: string[] = [];
  let resume!: () => void, entered!: () => void;
  const paused = new Promise<void>(r => { resume = r; }), inside = new Promise<void>(r => { entered = r; });
  const body = repo.write(async tx => {
    repo.users.upsertByEmail(tx, "async@example.com", null);
    entered();
    await paused;
    // Resumed: still its own transaction. It reads its uncommitted row, a nested atomic is a savepoint in it, and
    // an effect waits for the commit.
    expect(repo.users.findByEmail("async@example.com")).toBeDefined();
    repo.atomic(() => repo.users.upsertByEmail(tx, "nested@example.com", null));
    afterCommit(db, () => { seen.push("holder committed"); });
    expect(seen).toEqual(["other's effect"]);
    return "done";
  });
  await inside;
  expect(db.inTransaction).toBe(true);
  // Another task reads committed state (the reader), not the holder's uncommitted row.
  expect(repo.users.findByEmail("async@example.com")).toBeUndefined();
  // Its autocommit write and its top-level transaction are refused; its effect runs now.
  expect(() => addUser(db, "other@example.com")).toThrow("another body holds the write queue");
  expect(() => repo.atomic(() => 1)).toThrow("another body holds the write queue");
  afterCommit(db, () => { seen.push("other's effect"); });
  expect(seen).toEqual(["other's effect"]);
  // A queued write waits its turn and commits after the holder.
  const waiting = repo.write(tx => { seen.push("queued body"); return repo.users.upsertByEmail(tx, "queued@example.com", null); });
  expect(seen).toEqual(["other's effect"]);
  resume();
  expect(await body).toBe("done");
  await waiting;
  expect(seen).toEqual(["other's effect", "holder committed", "queued body"]);
  for (const who of ["async", "nested", "queued"]) expect(repo.users.findByEmail(`${who}@example.com`)).toBeDefined();
  expect(repo.users.findByEmail("other@example.com")).toBeUndefined();
  expect(db.inTransaction).toBe(false);
  expect(queueFor(db).held).toBe(false);
});

test("an async write body that rejects after an await rolls back, drops its effects and releases the queue", async () => {
  const { db, repo } = open();
  const seen: string[] = [];
  await expect(repo.write(async tx => {
    repo.users.upsertByEmail(tx, "gone@example.com", null);
    afterCommit(db, () => { seen.push("effect"); });
    await Promise.resolve();
    repo.atomic(() => repo.users.upsertByEmail(tx, "gone-too@example.com", null));
    throw new Error("late");
  })).rejects.toThrow("late");
  expect(repo.users.findByEmail("gone@example.com")).toBeUndefined();
  expect(repo.users.findByEmail("gone-too@example.com")).toBeUndefined();
  expect(seen).toEqual([]);
  expect(db.inTransaction).toBe(false);
  expect(queueFor(db).held).toBe(false);
  // The queue goes on: the next body commits.
  await repo.write(tx => repo.users.upsertByEmail(tx, "next@example.com", null));
  expect(repo.users.findByEmail("next@example.com")).toBeDefined();
});

test("a COMMIT that fails rolls the body back, drops its effects and releases the queue", async () => {
  const { db, repo } = open();
  // A deferred foreign key is checked at COMMIT, so the body runs clean and its COMMIT fails.
  db.run("CREATE TABLE fk_parent (id INTEGER PRIMARY KEY)");
  db.run("CREATE TABLE fk_child (p INTEGER REFERENCES fk_parent(id) DEFERRABLE INITIALLY DEFERRED)");
  const seen: string[] = [];
  for (const body of [() => 1, async () => { await Promise.resolve(); return 1; }]) {
    await expect(repo.write(((tx: Tx) => {
      repo.users.upsertByEmail(tx, "orphaned@example.com", null);
      db.query("INSERT INTO fk_child (p) VALUES (?)").run(99);
      afterCommit(db, () => { seen.push("effect"); });
      return body();
    }) as (tx: Tx) => Promise<number>)).rejects.toThrow(/FOREIGN KEY/);
    expect(repo.users.findByEmail("orphaned@example.com")).toBeUndefined();
    expect(seen).toEqual([]);
    expect(db.inTransaction).toBe(false);
    expect(queueFor(db).held).toBe(false);
  }
  await repo.write(tx => repo.users.upsertByEmail(tx, "next@example.com", null));
  expect(repo.users.findByEmail("next@example.com")).toBeDefined();
});
