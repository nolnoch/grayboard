import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import {
  createBoard,
  getBoard,
  markDelivered,
  pendingFor,
  post,
  setStatus,
  subscribe,
  touchHandle,
} from "./boards.ts";
import { release, sweepExpired, listClaims } from "./claims.ts";
import { initCoreSchema } from "./schema.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  initCoreSchema(db);
  for (const h of ["be", "sim", "fe"]) touchHandle(db, h);
  createBoard(db, "be", "work", "the work queue", null, { kind: "queue" });
  subscribe(db, "sim", "work", "push");
  subscribe(db, "fe", "work", "push");
});

const claimKey = (postId: number) => `queue:work:${postId}`;
const claimEvents = (key: string) =>
  db.prepare(`SELECT event, handle FROM claim_events WHERE key = ? ORDER BY at`).all(key) as {
    event: string;
    handle: string;
  }[];

test("exactly one subscriber wakes per queue post; the others get nothing", () => {
  const r = post(db, "be", "work", "first work item");
  expect(r.wake).toEqual(["fe"]); // never-woken lanes sort first; fe wins the tiebreak
  // Exactly one outbox row total: the other two have none.
  const rows = db.prepare(`SELECT handle FROM outbox WHERE post_id = ?`).all(r.post.id) as { handle: string }[];
  expect(rows.map((x) => x.handle)).toEqual(["fe"]);
  // The claim IS the delivery: the picked lane holds the post.
  const claim = db.prepare(`SELECT holder FROM claims WHERE key = ?`).get(claimKey(r.post.id));
  expect((claim as { holder: string }).holder).toBe("fe");
});

test("the rotation moves to the least-recently-woken subscriber", () => {
  post(db, "be", "work", "first");
  const r2 = post(db, "be", "work", "second");
  expect(r2.wake).toEqual(["sim"]); // fe was woken; sim is the least-recently-woken
});

test("the claim is atomic: a second claim for the same post is ignored", () => {
  const r = post(db, "be", "work", "work item");
  const dup = db
    .prepare(
      `INSERT OR IGNORE INTO claims (key, holder, note, board, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(claimKey(r.post.id), "sim", "queue post", "work", Date.now(), Date.now() + 30 * 60_000);
  expect(dup.changes).toBe(0); // INSERT OR IGNORE: the claim PK prevents theft
  const claims = db.prepare(`SELECT holder FROM claims WHERE key = ?`).all(claimKey(r.post.id)) as { holder: string }[];
  expect(claims.map((c) => c.holder)).toEqual(["fe"]);
});

test("TTL takeover: an expired claim releases and the next post rotates", () => {
  const r = post(db, "be", "work", "work item");
  // fe holds it, never acks; the claim expires.
  sweepExpired(db, Date.now() + 31 * 60_000);
  expect(listClaims(db).some((c) => c.key === claimKey(r.post.id))).toBe(false);
  // A later post rotates to the other subscriber (fe's wake is the most recent).
  const r2 = post(db, "be", "work", "second work item");
  expect(r2.wake).toEqual(["sim"]);
  // The audit chain: take -> expire.
  expect(claimEvents(claimKey(r.post.id)).map((e) => e.event)).toEqual(["take", "expire"]);
});

test("a decline releases the claim immediately, before TTL", () => {
  const r = post(db, "be", "work", "work item");
  release(db, "fe", claimKey(r.post.id), "not my lane");
  expect(listClaims(db).some((c) => c.key === claimKey(r.post.id))).toBe(false);
  // The audit chain: take -> release.
  expect(claimEvents(claimKey(r.post.id)).map((e) => e.event)).toEqual(["take", "release"]);
});

test("a resolved @mention is direct addressing and bypasses the rotation", () => {
  const r = post(db, "be", "work", "@sim take this one");
  const rows = db.prepare(`SELECT handle FROM outbox WHERE post_id = ?`).all(r.post.id) as { handle: string }[];
  expect(rows.map((x) => x.handle)).toEqual(["sim"]);
});

test("a busy subscriber is skipped in the rotation", () => {
  setStatus(db, "fe", "heads-down on another task");
  const r = post(db, "be", "work", "work item");
  expect(r.wake).toEqual(["sim"]);
});

test("broadcast boards keep fanning out to every push subscriber", () => {
  createBoard(db, "be", "chat", "the default kind");
  subscribe(db, "sim", "chat", "push");
  subscribe(db, "fe", "chat", "push");
  const r = post(db, "be", "chat", "to everyone");
  expect(r.wake.sort()).toEqual(["fe", "sim"]);
  // Broadcast posts are unclaimed: no queue claims on a broadcast board.
  expect(listClaims(db).length).toBe(0);
});

test("a pre-kind database opens with the broadcast default", () => {
  // A legacy boards table without the kind column: the guarded ALTER adds it
  // with the broadcast default, so existing databases open unchanged.
  const legacy = new Database(":memory:");
  legacy.exec(
    `CREATE TABLE boards (
      name        TEXT PRIMARY KEY,
      purpose     TEXT NOT NULL,
      scope       TEXT,
      created_by  TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    )`,
  );
  legacy.exec(`INSERT INTO boards VALUES ('legacy', 'a pre-kind board', NULL, 'be', 0)`);
  initCoreSchema(legacy);
  const row = legacy.prepare(`SELECT kind FROM boards WHERE name = 'legacy'`).get() as { kind: string };
  expect(row.kind).toBe("broadcast");
});
