import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterCommit } from "../../core/sqlite.ts";
import { openDatabase } from "../db.ts";
import { queueFor, WriteQueue } from "./queue.ts";

const open = () => openDatabase(":memory:", { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });

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

test("Repo.write commits a transaction, rolls it back on a throw, and refuses inside an open one", async () => {
  const { repo } = open();
  await repo.write(() => repo.users.upsertByEmail("a@example.com", null));
  expect(repo.users.findByEmail("a@example.com")).toBeDefined();
  await expect(repo.write(() => { repo.users.upsertByEmail("b@example.com", null); throw new Error("boom"); })).rejects.toThrow("boom");
  expect(repo.users.findByEmail("b@example.com")).toBeUndefined();
  let nested: Promise<unknown> | undefined;
  repo.atomic(() => { nested = repo.write(() => 1); });
  await expect(nested!).rejects.toThrow("nested code calls atomic");
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
