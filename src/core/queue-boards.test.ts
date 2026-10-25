import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import {
  acknowledge,
  createBoard,
  pendingFor,
  post,
  setAccess,
  setQueueParticipation,
  setStatus,
  subscribe,
  touchHandle,
} from "./boards.ts";
import { claim, release, sweepExpired, listClaims } from "./claims.ts";
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

test("TTL takeover redelivers the original post to the next lane, and the rotation continues", () => {
  const r = post(db, "be", "work", "work item"); // fe claims it, never acks
  sweepExpired(db, Date.now() + 31 * 60_000);
  // The original post is re-offered to sim, not left unclaimed and undelivered.
  const rows = db.prepare(`SELECT handle FROM outbox WHERE post_id = ?`).all(r.post.id) as { handle: string }[];
  expect(rows.map((x) => x.handle).sort()).toEqual(["fe", "sim"]);
  expect(listClaims(db).some((c) => c.key === claimKey(r.post.id) && c.holder === "sim")).toBe(true);
  // sim's re-offer is a waking, undelivered push.
  expect(pendingFor(db, "sim", { all: true }).some((i) => i.kind === "push" && i.post.id === r.post.id)).toBe(true);
  // The audit chain: take -> expire -> take (redelivered).
  expect(claimEvents(claimKey(r.post.id)).map((e) => e.event)).toEqual(["take", "expire", "take"]);
  // The redelivery re-woke sim, so the next post rotates to fe.
  const r2 = post(db, "be", "work", "second work item");
  expect(r2.wake).toEqual(["fe"]);
});

test("a declined queue post redelivers the original post to the next lane", () => {
  const r = post(db, "be", "work", "work item"); // fe claims it, declines
  release(db, "fe", claimKey(r.post.id), "not my lane");
  const rows = db.prepare(`SELECT handle FROM outbox WHERE post_id = ?`).all(r.post.id) as { handle: string }[];
  expect(rows.map((x) => x.handle).sort()).toEqual(["fe", "sim"]);
  expect(listClaims(db).some((c) => c.key === claimKey(r.post.id) && c.holder === "sim")).toBe(true);
  // The audit chain: take -> release -> take (redelivered).
  expect(claimEvents(claimKey(r.post.id)).map((e) => e.event)).toEqual(["take", "release", "take"]);
});

test("a redelivered post resets a lane's earlier delivery, so the re-offer reaches it", () => {
  const r = post(db, "be", "work", "work item"); // fe claims
  acknowledge(db, "fe", { kind: "push", post_id: r.post.id });
  sweepExpired(db, Date.now() + 31 * 60_000); // sim declines too
  release(db, "sim", claimKey(r.post.id), "pass");
  // Only two lanes: the post comes back to fe, whose first delivery is reset.
  const pend = pendingFor(db, "fe", { all: true });
  expect(pend.some((i) => i.kind === "push" && i.post.id === r.post.id)).toBe(true);
});

test("a reply by the claim holder acks and releases the claim", () => {
  const r = post(db, "be", "work", "work item"); // fe claims
  const reply = post(db, "fe", "work", "done: landed", r.post.id);
  expect(reply.wake).toEqual(["be"]); // the thread author learns it's handled
  expect(listClaims(db).some((c) => c.key === claimKey(r.post.id))).toBe(false);
  // The audit chain ends in a release (the ack), not an expire.
  expect(claimEvents(claimKey(r.post.id)).map((e) => e.event)).toEqual(["take", "release"]);
  // One take only: the ack releases without redelivering.
  expect(claimEvents(claimKey(r.post.id)).filter((e) => e.event === "take").length).toBe(1);
});

test("a reply by a different lane does not release the holder's claim", () => {
  const r = post(db, "be", "work", "work item"); // fe claims
  post(db, "sim", "work", "chiming in", r.post.id);
  expect(listClaims(db).some((c) => c.key === claimKey(r.post.id) && c.holder === "fe")).toBe(true);
});

test("a resolved @mention is direct addressing and bypasses the rotation", () => {
  const r = post(db, "be", "work", "@sim take this one");
  const rows = db.prepare(`SELECT handle FROM outbox WHERE post_id = ?`).all(r.post.id) as { handle: string }[];
  expect(rows.map((x) => x.handle)).toEqual(["sim"]);
});

test("status text is not a busy flag; only the explicit opt-out skips a lane", () => {
  setStatus(db, "fe", "heads-down on another task");
  const r = post(db, "be", "work", "work item");
  expect(r.wake).toEqual(["fe"]); // status is free text; fe is still eligible
  setQueueParticipation(db, "fe", false);
  const r2 = post(db, "be", "work", "second work item");
  expect(r2.wake).toEqual(["sim"]);
  // The opt-out persists until the lane opts back in.
  expect(db.prepare(`SELECT queue_off FROM handles WHERE name = 'fe'`).get()).toEqual({ queue_off: 1 });
  setQueueParticipation(db, "fe", true);
  const r3 = post(db, "be", "work", "third work item");
  expect(r3.wake).toEqual(["fe"]);
});

test("the rotation prefers live lanes and falls back to offline ones", () => {
  const r = post(db, "be", "work", "work item", null, { online: (h) => h === "sim" });
  expect(r.wake).toEqual(["sim"]); // fe is offline; sim is live
  const r2 = post(db, "be", "work", "second work item", null, { online: (h) => h === "fe" });
  expect(r2.wake).toEqual(["fe"]); // the other lane is live now
  // Nobody live: the fallback still delivers, to one lane in rotation order
  // (same-millisecond posts tie, so only the count and membership are pinned).
  const r3 = post(db, "be", "work", "third work item", null, { online: () => false });
  expect(r3.wake.length).toBe(1);
  expect(["fe", "sim"]).toContain(r3.wake[0]!);
});

test("a read-only viewer is never picked by the rotation", () => {
  touchHandle(db, "~tail");
  subscribe(db, "~tail", "work", "push");
  const r = post(db, "be", "work", "work item");
  expect(r.wake).not.toContain("~tail");
});

test("claim_take refuses the reserved queue: keyspace", () => {
  // Only the queue machinery mints queue: keys - claimQueuePost, against a
  // post that exists on a board the lane can see. A public take would squat
  // a future post's delivery claim: the audit would record a delivery that
  // never happened, and the lane's reply-ack would fail (#192 review).
  expect(() => claim(db, "sim", claimKey(999))).toThrow(/queue:/);
  // The refusal is unconditional, so a key on a board the caller can't see
  // is closed at the same entry point - visibility never even comes into it.
  expect(() => claim(db, "sim", "queue:secret:1")).toThrow(/queue:/);
  // No claim row, no audit row: the take never happened.
  expect(listClaims(db).some((c) => c.key.startsWith("queue:"))).toBe(false);
  expect(db.prepare(`SELECT COUNT(*) AS n FROM claim_events WHERE key LIKE 'queue:%'`).get()).toEqual({ n: 0 });
});

test("a claim row that already holds the key is not logged as the lane's take", () => {
  // The review's race: a squatter holds the key of a post before it's made.
  // The delivery push still goes out, but the audit records no take for the
  // picked lane - the claim (and its reply-ack) belong to the squatter.
  const next = ((db.prepare(`SELECT MAX(id) AS m FROM posts`).get() as { m: number | null }).m ?? 0) + 1;
  db.prepare(
    `INSERT INTO claims (key, holder, note, board, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(claimKey(next), "sim", "squat", "work", Date.now(), Date.now() + 60_000);
  const r = post(db, "be", "work", "work item");
  expect(r.post.id).toBe(next);
  expect(claimEvents(claimKey(next)).filter((e) => e.event === "take")).toEqual([]);
  // The picked lane's push went out (at-least-once), but the claim is the
  // squatter's - so the lane's reply does not ack it.
  expect(db.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE post_id = ?`).get(r.post.id)).toEqual({ n: 1 });
  post(db, "fe", "work", "on it", r.post.id);
  expect((db.prepare(`SELECT holder FROM claims WHERE key = ?`).get(claimKey(next)) as { holder: string }).holder).toBe("sim");
});

test("a decline's redelivery skips a lane that lost access to the board", () => {
  // A subscription row outlives access: fe subscribes while a member, then
  // leaves the team. The rotation must re-check visibility at delivery time,
  // or a manual release fans the private post to a handle that can't see it.
  const members = new Set(["be", "sim", "fe"]);
  setAccess(db, {
    canSee: (h, b) => b.scope === null || members.has(h),
    checkCreate: (h, scope) => (scope === null || members.has(h) ? null : "not a member"),
    resolveMention: (t) => (["be", "sim", "fe"].includes(t) ? t : null),
    announceBoard: null,
  });
  createBoard(db, "be", "eng", "team queue", "team:eng", { kind: "queue" });
  subscribe(db, "sim", "eng", "push");
  subscribe(db, "fe", "eng", "push");
  members.delete("fe");
  const r = post(db, "be", "eng", "team work item"); // sim claims; fe is invisible now
  expect(r.wake).toEqual(["sim"]);
  const key = `queue:eng:${r.post.id}`; // not the work-board helper
  release(db, "sim", key, "pass"); // decline: redelivery would be next
  // The only remaining rotation lane is fe, who can no longer see the board:
  // the re-offer must not reach fe. No lane is left, so the post sits
  // readable on the board (the documented empty-rotation behavior).
  const rows = db.prepare(`SELECT handle FROM outbox WHERE post_id = ?`).all(r.post.id) as { handle: string }[];
  expect(rows.map((x) => x.handle)).toEqual(["sim"]);
  expect(listClaims(db).some((c) => c.key === key)).toBe(false);
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
