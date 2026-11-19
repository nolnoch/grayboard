// SQLite's auth generation source (db.ts, #853, #996, #807 P1c-2) where only SQLite can express it: a failed counter
// read, an autocommit write, a synchronous post. The cache's rows on every backend are the auth cache contract
// (store/auth_cache.contract.ts, rows A1-A9, run on SQLite by db.test.ts).
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type Repo } from "./db.ts";
import { sqliteOf, type Tx } from "./store/tx.ts";
import { scratchDbPath } from "../../tests/support/scratch_db.ts";

const open = (): Repo => openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) }).repo;
const gate = () => { let open!: () => void; const p = new Promise<void>(r => { open = r; }); return { p, open }; };

// Holds a write body open after `fn`'s writes until the returned release() is called; settles with the body.
function hold(repo: Repo, fn: (tx: Tx) => unknown) {
  const g = gate(), wrote = gate();
  const done = repo.write(async tx => {
    await fn(tx);
    wrote.open();
    await g.p;
  });
  return { wrote: wrote.p, release: g.open, done };
}

// The commit of an auth-table write is contract row A3; a synchronous post's is SQLite's alone.
test("a synchronous post's commit moves the generation too", async () => {
  const repo = open();
  const before = repo.authGeneration();
  // A synchronous body (users.upsertByEmail answers with a promise, #807 P3 A6b): the user row on its Tx.
  expect(repo.post(tx => { sqliteOf(tx).run("INSERT INTO users (email, created_at) VALUES (?, 0)", ["d@example.com"]); })).toBe(true);
  expect(repo.authGeneration()).not.toBe(before);
});

test("a failed counter read leaves the generation undefined, never stale, until a commit reads it again", async () => {
  const repo = open();
  await repo.write(tx => repo.users.upsertByEmail(tx, "g@example.com", null));
  // Drops the counter table: the commit's hook can't read it.
  await repo.write(tx => { sqliteOf(tx).run("DROP TABLE temp.auth_generation"); });
  const h = hold(repo, () => {});
  await h.wrote;
  expect(repo.authGeneration()).toBeUndefined();
  expect(await repo.authRead(() => repo.authGeneration())).toBeUndefined();
  h.release();
  await h.done;
  await repo.write(tx => { sqliteOf(tx).run("CREATE TEMP TABLE auth_generation(n INTEGER NOT NULL); INSERT INTO auth_generation(n) VALUES (7)"); });
  const h2 = hold(repo, () => {});
  await h2.wrote;
  expect(repo.authGeneration()).toStartWith("7:");
  h2.release();
  await h2.done;
});

test("an auth-table write that commits without a tracked boundary still moves the generation", async () => {
  const repo = open();
  const user = await repo.write(tx => repo.users.upsertByEmail(tx, "h@example.com", null));
  const before = repo.authGeneration();
  // A holder's committed callback, outside any transaction: a bare autocommit UPDATE (clearSubject's statement).
  await repo.write(() => {}, () => { sqliteOf(repo.read).run("UPDATE users SET idp_issuer = NULL, idp_subject = NULL WHERE id = ?", [user.id]); });
  expect(repo.authGeneration()).not.toBe(before);
});
