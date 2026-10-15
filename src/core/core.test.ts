import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createBoard,
  listBoards,
  markDelivered,
  pendingFor,
  post,
  read,
  subscribe,
  touchHandle,
} from "./boards.ts";
import { claim, listClaims, release } from "./claims.ts";
import { initCoreSchema } from "./schema.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  initCoreSchema(db);
  for (const h of ["be", "sim", "fe"]) touchHandle(db, h);
  createBoard(db, "be", "#e2e", "End-to-end fixtures and runs");
});

const drain = (h: string) => {
  const items = pendingFor(db, h);
  for (const i of items) markDelivered(db, h, i);
  return items;
};

test("new subscribers start at the tip", () => {
  post(db, "be", "e2e", "old news");
  subscribe(db, "sim", "e2e", "digest");
  expect(listBoards(db, "sim")[0]!.unread).toBe(0);
  expect(pendingFor(db, "sim")).toEqual([]);
});

test("push-mode subscriber gets full post; author does not", () => {
  const { wake } = post(db, "sim", "e2e", "fixture ready");
  expect(wake).toEqual(["be"]); // creator is push-subscribed
  const items = drain("be");
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ kind: "push", reason: "subscription" });
  expect(drain("sim")).toEqual([]);
  expect(listBoards(db, "be")[0]!.unread).toBe(0); // push counts as read
});

test("digest coalesces until the reader catches up", () => {
  subscribe(db, "sim", "e2e", "digest");
  post(db, "be", "e2e", "one");
  post(db, "be", "e2e", "two");
  const first = drain("sim");
  expect(first).toHaveLength(1);
  expect(first[0]).toMatchObject({ kind: "digest", unread: 2 });

  post(db, "be", "e2e", "three");
  expect(drain("sim")).toEqual([]); // suppressed: not caught up yet

  const r = read(db, "sim", "e2e");
  expect(r.posts.map((p) => p.body)).toEqual(["one", "two", "three"]);
  expect(r.unread_remaining).toBe(0);

  post(db, "be", "e2e", "four");
  expect(drain("sim")).toMatchObject([{ kind: "digest", unread: 1 }]); // re-armed
});

test("posting does not mark others' unread posts as read", () => {
  subscribe(db, "sim", "e2e", "digest");
  post(db, "be", "e2e", "one");
  post(db, "be", "e2e", "two");
  post(db, "sim", "e2e", "reply without reading");
  expect(listBoards(db, "sim")[0]!.unread).toBe(2);
  expect(drain("sim")).toMatchObject([{ kind: "digest", unread: 2 }]);
  expect(read(db, "sim", "e2e").posts.map((p) => p.body)).toEqual(["one", "two"]);
});

test("quiet subscribers are never pushed but see unread counts", () => {
  subscribe(db, "sim", "e2e", "quiet");
  const { wake } = post(db, "be", "e2e", "hi");
  expect(wake).not.toContain("sim");
  expect(listBoards(db, "sim")[0]!.unread).toBe(1);
});

test("mentions push to known handles even without a subscription", () => {
  const { wake } = post(db, "be", "e2e", "@fe can you check this? cc @nobody and foo@bar.com");
  expect(wake.sort()).toEqual(["fe"]);
  expect(drain("fe")).toMatchObject([{ kind: "push", reason: "mention" }]);
});

test("thread participants are pushed on replies", () => {
  const root = post(db, "sim", "e2e", "question").post;
  post(db, "fe", "e2e", "me too", root.id);
  drain("be");
  drain("sim");
  const reply = post(db, "be", "e2e", "answer", root.id);
  expect(reply.wake.sort()).toEqual(["fe", "sim"]);
  expect(drain("sim")).toMatchObject([{ kind: "push", reason: "thread" }]);
  expect(read(db, "fe", "e2e", { thread: reply.post.id }).posts).toHaveLength(3);
});

test("reading clears pending pushes for posts already seen", () => {
  post(db, "be", "e2e", "@fe look");
  subscribe(db, "fe", "e2e", "quiet");
  read(db, "fe", "e2e", { before_id: 999 });
  expect(pendingFor(db, "fe")).toEqual([]);
});

test("claims are exclusive, renewable, and expire", () => {
  const a = claim(db, "be", "ticket:ENG-142", { note: "signature work" });
  expect(a.ok).toBe(true);
  const b = claim(db, "sim", "ticket:ENG-142");
  expect(b).toMatchObject({ ok: false, held_by: "be", note: "signature work" });

  const renew = claim(db, "be", "ticket:ENG-142", { ttl_minutes: 60 });
  expect(renew).toMatchObject({ ok: true, renewed: true });
  if (renew.ok) expect(renew.claim.note).toBe("signature work");

  db.prepare(`UPDATE claims SET expires_at = 0`).run();
  expect(listClaims(db)).toEqual([]);
  expect(claim(db, "sim", "ticket:ENG-142")).toMatchObject({ ok: true, renewed: false });
});

test("only the holder can release; claims announce on a board", () => {
  subscribe(db, "sim", "e2e", "push");
  claim(db, "be", "lane:fixtures", { board: "e2e" });
  expect(() => release(db, "sim", "lane:fixtures")).toThrow(/held by be/);
  const { wake } = release(db, "be", "lane:fixtures");
  expect(wake).toContain("sim");
  expect(read(db, "sim", "e2e", { before_id: 999 }).posts.map((p) => p.body)).toEqual([
    "[claim] lane:fixtures",
    "[release] lane:fixtures",
  ]);
});

test("claim prefix filter escapes LIKE wildcards", () => {
  claim(db, "be", "a_b");
  claim(db, "be", "axb");
  expect(listClaims(db, "a_").map((c) => c.key)).toEqual(["a_b"]);
});

test("two connections cannot both win a claim", () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-"));
  const path = join(dir, "bus.db");
  const a = new Database(path);
  a.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000;");
  initCoreSchema(a);
  const b = new Database(path);
  b.exec("PRAGMA busy_timeout = 2000;");
  const r1 = claim(a, "be", "k");
  const r2 = claim(b, "sim", "k");
  expect([r1.ok, r2.ok]).toEqual([true, false]);
});
