// The write queue's Tx/Read handles (#807 P1c-1, docs/future/postgres-server.md D8).
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type Repo } from "../db.ts";
import { scratchDbPath } from "../../../tests/support/scratch_db.ts";
import { sqliteOf, type Read, type Tx } from "./tx.ts";

async function open(): Promise<Repo> {
  const { repo } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  await repo.write(tx => { sqliteOf(tx).run("CREATE TABLE t (v TEXT)"); });
  return repo;
}
const put = (tx: Tx, v: string) => { sqliteOf(tx).run("INSERT INTO t (v) VALUES (?)", [v]); };
const rows = (r: Read) => sqliteOf(r).query<{ v: string }, []>("SELECT v FROM t ORDER BY rowid").all().map(x => x.v);
const tick = () => new Promise<void>(r => setTimeout(r, 0));

test("a write body's Tx writes in its transaction; the read handle sees the commit", async () => {
  const repo = await open();
  await repo.write(tx => { put(tx, "a"); expect(rows(tx)).toEqual(["a"]); });
  await repo.write(async tx => { await tick(); put(tx, "b"); });
  expect(rows(repo.read)).toEqual(["a", "b"]);
});

test("a Tx used after its body settles throws, and writes nothing", async () => {
  const repo = await open();
  let kept!: Tx;
  await repo.write(tx => { kept = tx; });
  expect(() => put(kept, "late")).toThrow("Tx used after its transaction settled");
  // An async body that leaves a timer behind: the timer fires after the commit.
  let late: unknown;
  await repo.write(async tx => {
    setTimeout(() => { try { put(tx, "timer"); } catch (e) { late = e; } }, 0);
  });
  await tick(); await tick();
  expect(String(late)).toContain("Tx used after its transaction settled");
  expect(() => kept.afterCommit(() => {})).toThrow("settled");
  expect(rows(repo.read)).toEqual([]);
});

// D4, #807 P1c-15c-2: a body awaits only its own statements. Even the raw connection a body reached through
// `repo.coreOn(tx)`, used by a timer or un-awaited promise after the body settled, is refused: the write queue's owner
// check runs on every write, with the queue idle or held by a later body.
test("D4: a write a body leaves running past its settle is refused, on its raw connection too, idle queue or held", async () => {
  const repo = await open();
  const refused: string[] = [];
  const attempt = (c: ReturnType<Repo["coreOn"]>, v: string) => { try { c.run("INSERT INTO t (v) VALUES (?)", [v]); } catch (e) { refused.push(`${v}: ${String(e)}`); } };
  let fire!: () => void;
  const gate = new Promise<void>(r => { fire = r; });
  await repo.write(async tx => {
    const c = repo.coreOn(tx);
    setTimeout(() => attempt(c, "timer, idle"), 0);
    void (async () => { await gate; attempt(c, "promise, held"); })();
  });
  await tick(); await tick();
  // A later body holds the queue while the first body's un-awaited promise writes.
  await repo.write(async tx => { put(tx, "later"); fire(); await tick(); await tick(); });
  expect(refused).toHaveLength(2);
  expect(refused[0]).toContain("timer, idle: Error: write outside the write queue");
  expect(refused[1]).toContain("promise, held: Error: write or top-level transaction while another body holds the write queue");
  expect(rows(repo.read)).toEqual(["later"]);
});

test("a rolled-back body's Tx is closed too", async () => {
  const repo = await open();
  let kept!: Tx;
  await expect(repo.write(async tx => { kept = tx; put(tx, "x"); throw new Error("no"); })).rejects.toThrow("no");
  expect(() => put(kept, "y")).toThrow("settled");
  expect(rows(repo.read)).toEqual([]);
});

test("Tx.afterCommit runs after the commit, never on rollback", async () => {
  const repo = await open();
  const seen: string[] = [];
  await repo.write(tx => { tx.afterCommit(() => { seen.push(`ok:${rows(repo.read).length}`); }); put(tx, "a"); seen.push("body"); });
  expect(seen).toEqual(["body", "ok:1"]);
  await expect(repo.write(tx => { tx.afterCommit(() => { seen.push("rolled back"); }); throw new Error("no"); })).rejects.toThrow("no");
  expect(seen).toEqual(["body", "ok:1"]);
});

test("a savepoint that throws rolls back its writes and effects alone; the outer body's stand", async () => {
  const repo = await open();
  const seen: string[] = [];
  await repo.write(async tx => {
    put(tx, "outer");
    tx.afterCommit(() => { seen.push("outer"); });
    await expect(tx.savepoint(async sp => {
      put(sp, "inner");
      sp.afterCommit(() => { seen.push("inner"); });
      await tick();
      throw new Error("inner failed");
    })).rejects.toThrow("inner failed");
    expect(rows(tx)).toEqual(["outer"]);
    put(tx, "after");
  });
  expect(rows(repo.read)).toEqual(["outer", "after"]);
  expect(seen).toEqual(["outer"]);
});

test("a committed savepoint's effects wait for the outer commit, and drop with the outer rollback", async () => {
  const repo = await open();
  const seen: string[] = [];
  await repo.write(async tx => {
    await tx.savepoint(async sp => { put(sp, "a"); sp.afterCommit(() => { seen.push("sp"); }); await tick(); });
    expect(seen).toEqual([]);
    expect(rows(tx)).toEqual(["a"]);
  });
  expect(seen).toEqual(["sp"]);
  await expect(repo.write(async tx => {
    await tx.savepoint(sp => { put(sp, "b"); sp.afterCommit(() => { seen.push("dropped"); }); });
    throw new Error("outer failed");
  })).rejects.toThrow("outer failed");
  expect(seen).toEqual(["sp"]);
  expect(rows(repo.read)).toEqual(["a"]);
});

test("nested savepoints: an inner rollback inside a committed savepoint", async () => {
  const repo = await open();
  await repo.write(async tx => {
    await tx.savepoint(async a => {
      put(a, "a1");
      await a.savepoint(async b => { put(b, "b1"); await b.savepoint(c => { put(c, "c1"); }); });
      await expect(a.savepoint(async b => { put(b, "b2"); await tick(); throw new Error("b2"); })).rejects.toThrow("b2");
      put(a, "a2");
    });
  });
  expect(rows(repo.read)).toEqual(["a1", "b1", "c1", "a2"]);
});

test("the parent Tx refuses statements and a second savepoint while a savepoint is open", async () => {
  const repo = await open();
  await repo.write(async tx => {
    let parentErr: unknown, siblingErr: unknown;
    await tx.savepoint(async sp => {
      put(sp, "in");
      try { put(tx, "parent"); } catch (e) { parentErr = e; }
      try { await tx.savepoint(() => {}); } catch (e) { siblingErr = e; }
    });
    expect(String(parentErr)).toContain("savepoint is open");
    expect(String(siblingErr)).toContain("savepoint is open");
    put(tx, "out");
  });
  expect(rows(repo.read)).toEqual(["in", "out"]);
});

test("a body that returns without awaiting its savepoint: the savepoint dies with the transaction, the next one is sound", async () => {
  const repo = await open();
  let kept!: Tx, settled: Promise<unknown> = Promise.resolve();
  await repo.write(tx => {
    settled = tx.savepoint(async sp => { kept = sp; put(sp, "a"); await tick(); }).catch(e => e);
  });
  expect(() => put(kept, "late")).toThrow("settled");
  expect(String(await settled)).toContain("savepoint outlived its transaction");
  // The next transaction's effects run at its commit: no frame of the dead savepoint is left to swallow them.
  const seen: string[] = [];
  await repo.write(tx => { put(tx, "b"); tx.afterCommit(() => { seen.push("next"); }); });
  expect(seen).toEqual(["next"]);
  expect(rows(repo.read)).toEqual(["a", "b"]);
});

test("write and post bodies get a Tx live only for the body", async () => {
  const repo = await open();
  let a!: Tx, b!: Tx;
  await repo.write(tx => { a = tx; put(tx, "now"); });
  expect(repo.post(tx => { b = tx; put(tx, "post"); })).toBe(true);
  expect(() => put(a, "x")).toThrow("settled");
  expect(() => put(b, "x")).toThrow("settled");
  expect(rows(repo.read)).toEqual(["now", "post"]);
});

test("sqliteOf refuses a handle that isn't a SQLite store's", () => {
  expect(() => sqliteOf({} as Read)).toThrow("not a SQLite store handle");
});

test("an orphaned savepoint that fails during a later transaction leaves that transaction alone", async () => {
  const repo = await open();
  let fail!: () => void;
  const gate = new Promise<void>((_, reject) => { fail = () => reject(new Error("orphan failed")); });
  let settled: Promise<unknown> = Promise.resolve();
  await repo.write(tx => { settled = tx.savepoint(async sp => { put(sp, "a"); await gate; }).catch(e => e); });
  await repo.write(async tx => {
    put(tx, "b");
    fail();
    expect(String(await settled)).toContain("orphan failed");
    put(tx, "c");
  });
  expect(rows(repo.read)).toEqual(["a", "b", "c"]);
});

test("a synchronous body's Tx refuses a savepoint (#999 audit A)", async () => {
  const repo = await open();
  const errs: string[] = [];
  // post from the queue's holder outside a transaction (its committed callback): its own Tx, synchronous. A post
  // through the queue gets a write body's Tx, which may open one (#807 P3 A3).
  await repo.write(() => 1, () => {
    expect(repo.post(tx => { tx.savepoint(() => {}).catch(e => errs.push(String(e))); put(tx, "holder"); })).toBe(true);
  });
  await tick();
  expect(errs).toHaveLength(1);
  for (const e of errs) expect(e).toContain("savepoint in a synchronous write body");
  // Effects of later transactions still run: no frame was left behind.
  const seen: string[] = [];
  await repo.write(tx => { tx.afterCommit(() => { seen.push("later"); }); });
  expect(seen).toEqual(["later"]);
  expect(rows(repo.read)).toEqual(["holder"]);
});

test("a post body run from a write's committed callback gets a Tx closed after it", async () => {
  const repo = await open();
  let after!: Tx;
  await repo.write(() => 1, () => { repo.post(tx => { after = tx; put(tx, "after"); }); });
  expect(() => put(after, "x")).toThrow("settled");
  expect(rows(repo.read)).toEqual(["after"]);
});

test("an unawaited savepoint started inside atomic doesn't strand the atomic's frame (#999 audit A)", async () => {
  const repo = await open();
  const seen: string[] = [];
  let settled: Promise<unknown> = Promise.resolve();
  await repo.write(async tx => {
    repo.atomic(() => { settled = tx.savepoint(async sp => { put(sp, "sp"); await tick(); }).catch(e => e); });
    await settled;
    tx.afterCommit(() => { seen.push("outer"); });
  });
  expect(seen).toEqual(["outer"]);
  await repo.write(tx => { tx.afterCommit(() => { seen.push("next"); }); });
  expect(seen).toEqual(["outer", "next"]);
});

test("a savepoint rolled back with an inner one left open: the caller's later effects still run (#999 audit B)", async () => {
  const repo = await open();
  const seen: string[] = [];
  let inner: Promise<unknown> = Promise.resolve();
  await repo.write(async tx => {
    await expect(tx.savepoint(async sp => {
      inner = sp.savepoint(async () => { await tick(); await tick(); }).catch(e => e);
      throw new Error("outer savepoint failed");
    })).rejects.toThrow("outer savepoint failed");
    put(tx, "after");
    tx.afterCommit(() => { seen.push("after"); });
    await inner;
  });
  expect(seen).toEqual(["after"]);
  expect(rows(repo.read)).toEqual(["after"]);
});

test("a savepoint committing with an inner one still open rolls back instead of staying open (#999 audit B)", async () => {
  const repo = await open();
  const seen: string[] = [];
  let inner: Promise<unknown> = Promise.resolve();
  await repo.write(async tx => {
    await expect(tx.savepoint(async sp => {
      put(sp, "sp");
      inner = sp.savepoint(async isp => { put(isp, "inner"); await tick(); await tick(); }).catch(e => e);
    })).rejects.toThrow("out of order");
    put(tx, "after");
    tx.afterCommit(() => { seen.push("after"); });
    await inner;
  });
  expect(seen).toEqual(["after"]);
  expect(rows(repo.read)).toEqual(["after"]);
});
