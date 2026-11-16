// The auth cache's generation under a write body held open across an await (#996, #807 P1c-2): another task keys
// its cache on committed state, never on the holder's uncommitted bump.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type Repo } from "./db.ts";
import { sqliteOf } from "./store/tx.ts";
import { scratchDbPath } from "../../tests/support/scratch_db.ts";

const open = (): Repo => openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) }).repo;
const gate = () => { let open!: () => void; const p = new Promise<void>(r => { open = r; }); return { p, open }; };

// Holds a write body open after `fn`'s writes until the returned release() is called; settles with the body.
function hold(repo: Repo, fn: () => void, fail = false) {
  const g = gate(), wrote = gate();
  const done = repo.write(async () => {
    fn();
    wrote.open();
    await g.p;
    if (fail) throw new Error("rolled back");
  });
  return { wrote: wrote.p, release: g.open, done: fail ? done.catch(() => {}) : done };
}

test("another task's generation stays the committed one while a holder's uncommitted write is open", async () => {
  const repo = open();
  const user = repo.writeNow(() => repo.users.upsertByEmail("a@example.com", null));
  const before = repo.authGeneration();
  expect(before).toBeDefined();
  expect(repo.users.activeEmail(user.id)).toBe("a@example.com");
  let inside: string | undefined = "unset";
  const h = hold(repo, () => { repo.users.setDisabled(user.id, true); inside = repo.authGeneration(); });
  await h.wrote;
  expect(inside).toBeUndefined();
  // Outside the holder's transaction: the committed generation, and the committed (enabled) user.
  expect(repo.authGeneration()).toBe(before);
  expect(repo.users.activeEmail(user.id)).toBe("a@example.com");
  expect(repo.authRead(() => repo.authGeneration())).toBe(before);
  h.release();
  await h.done;
  expect(repo.authGeneration()).not.toBe(before);
  expect(repo.users.activeEmail(user.id)).toBeUndefined();
});

test("a rolled-back holder leaves the generation and the cached user as committed", async () => {
  const repo = open();
  const user = repo.writeNow(() => repo.users.upsertByEmail("b@example.com", null));
  const before = repo.authGeneration();
  const h = hold(repo, () => { repo.users.setDisabled(user.id, true); }, true);
  await h.wrote;
  expect(repo.users.activeEmail(user.id)).toBe("b@example.com");
  h.release();
  await h.done;
  expect(repo.authGeneration()).toBe(before);
  expect(repo.users.activeEmail(user.id)).toBe("b@example.com");
});

test("a synchronous transaction's commit moves the generation too", () => {
  const repo = open();
  const before = repo.authGeneration();
  repo.writeNow(() => repo.users.upsertByEmail("c@example.com", null));
  const mid = repo.authGeneration();
  expect(mid).not.toBe(before);
  expect(repo.post(() => { repo.users.upsertByEmail("d@example.com", null); })).toBe(true);
  expect(repo.authGeneration()).not.toBe(mid);
});

test("a failed counter read leaves the generation undefined, never stale, until a commit reads it again", async () => {
  const repo = open();
  repo.writeNow(() => repo.users.upsertByEmail("g@example.com", null));
  // Drops the counter table: the commit's hook can't read it.
  repo.writeNow(tx => { sqliteOf(tx).run("DROP TABLE temp.auth_generation"); });
  const h = hold(repo, () => {});
  await h.wrote;
  expect(repo.authGeneration()).toBeUndefined();
  expect(repo.authRead(() => repo.authGeneration())).toBeUndefined();
  h.release();
  await h.done;
  repo.writeNow(tx => { sqliteOf(tx).run("CREATE TEMP TABLE auth_generation(n INTEGER NOT NULL); INSERT INTO auth_generation(n) VALUES (7)"); });
  const h2 = hold(repo, () => {});
  await h2.wrote;
  expect(repo.authGeneration()).toStartWith("7:");
  h2.release();
  await h2.done;
});

test("an auth-table write that commits without a tracked boundary still moves the generation", async () => {
  const repo = open();
  const user = repo.writeNow(() => repo.users.upsertByEmail("h@example.com", null));
  const before = repo.authGeneration();
  // A holder's committed callback, outside any transaction: clearSubject is a bare autocommit UPDATE.
  await repo.write(() => {}, () => { repo.users.clearSubject(user.id); });
  expect(repo.authGeneration()).not.toBe(before);
});
