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
  expect(repo.audit.last(repo.read, "auth.login", "rolled-back")).toBeUndefined();
  await repo.write((tx) => { writeAudit(repo, tx, "auth.login", "a@example.com", "kept"); });
  expect(repo.audit.last(repo.read, "auth.login", "kept")?.actor).toBe("a@example.com");
  // Neither went through post: the Tx took them.
  expect(posts).toEqual([]);
});

test("#807 A2: a settled Tx is refused; a Read posts the row", async () => {
  const { repo } = setup();
  let kept!: Tx;
  await repo.write((tx) => { kept = tx; });
  expect(() => writeAudit(repo, kept, "auth.login", null, "late")).toThrow("Tx used after its transaction settled");
  expect(repo.audit.last(repo.read, "auth.login", "late")).toBeUndefined();
  writeAudit(repo, repo.read, "auth.login", null, "posted");
  expect(repo.audit.last(repo.read, "auth.login", "posted")).toBeDefined();
});
