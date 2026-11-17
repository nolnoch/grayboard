// #807 P3 A2: writeAudit writes on the handle it's given. A live Tx: the row joins the caller's transaction and rolls
// back with it. A settled Tx: refused (D4). A Read outside any body: posted through the write queue.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db.ts";
import { writeAudit } from "./audit.ts";
import type { Tx } from "./store/tx.ts";

const cleanups: (() => unknown)[] = [];
afterEach(() => { for (const c of cleanups.splice(0).reverse()) c(); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "gb-audith-"));
  const opened = openDatabase(join(dir, "db.sqlite"), { blobDir: join(dir, "blobs") });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => opened.db.close());
  return opened;
}

test("#807 A2: a row written on a body's Tx rolls back with the body", async () => {
  const { repo } = setup();
  const posts: string[] = [];
  const post = repo.post.bind(repo);
  repo.post = ((fn, committed, what) => { posts.push(what ?? ""); return post(fn, committed, what); }) as typeof repo.post;
  await expect(repo.write((tx) => {
    writeAudit(repo, tx, "auth.login", "a@example.com", "rolled-back");
    throw new Error("body failed");
  })).rejects.toThrow("body failed");
  expect(await repo.audit.last(repo.read, "auth.login", "rolled-back")).toBeUndefined();
  await repo.write((tx) => { writeAudit(repo, tx, "auth.login", "a@example.com", "kept"); });
  expect((await repo.audit.last(repo.read, "auth.login", "kept"))?.actor).toBe("a@example.com");
  // Neither went through post: the Tx took them.
  expect(posts).toEqual([]);
});

test("#807 A2: a settled Tx is refused; a Read posts the row", async () => {
  const { repo } = setup();
  let kept!: Tx;
  await repo.write((tx) => { kept = tx; });
  expect(() => writeAudit(repo, kept, "auth.login", null, "late")).toThrow("Tx used after its transaction settled");
  expect(await repo.audit.last(repo.read, "auth.login", "late")).toBeUndefined();
  writeAudit(repo, repo.read, "auth.login", null, "posted");
  expect(await repo.audit.last(repo.read, "auth.login", "posted")).toBeDefined();
});

// #807 P3 A6h: audit.write stays synchronous on every store, so its contract is what a buffering store (Postgres)
// must keep: `last` on the writing Tx sees the row before the commit, and a savepoint's rows roll back with it alone.
test("#807 A6h: last on the writing Tx sees its row; a rolled-back savepoint's row is gone, its parent's kept", async () => {
  const { repo } = setup();
  const seen = await repo.write(async (tx) => {
    writeAudit(repo, tx, "auth.login", "a@example.com", "in-body");
    const before = await repo.audit.last(tx, "auth.login", "in-body");
    await expect(tx.savepoint(async (sp) => {
      writeAudit(repo, sp, "auth.login", "a@example.com", "in-savepoint");
      expect((await repo.audit.last(sp, "auth.login", "in-savepoint"))?.actor).toBe("a@example.com");
      throw new Error("savepoint failed");
    })).rejects.toThrow("savepoint failed");
    return { before, after: await repo.audit.last(tx, "auth.login", "in-savepoint") };
  });
  expect(seen.before?.actor).toBe("a@example.com");
  expect(seen.after).toBeUndefined();
  expect((await repo.audit.last(repo.read, "auth.login", "in-body"))?.actor).toBe("a@example.com");
  expect(await repo.audit.last(repo.read, "auth.login", "in-savepoint")).toBeUndefined();
});
