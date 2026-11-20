import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import {
  acknowledge,
  createBoard,
  declareHuman,
  openAccess,
  getBoard,
  queueLanes,
  queueLaneRowsSql,
  pendingFor,
  post,
  setAccess,
  setQueueParticipation,
  ensureAlias,
  registerId,
  setStatus,
  subscribe,
  touchAlias,
} from "./boards.ts";
import { holdAlias } from "./bindings.ts";
import { claim, logEvent, release, sweepExpired, listClaims, watch } from "./claims.ts";
import { initCoreSchema } from "./schema.ts";
import { CoreError } from "./errors.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  initCoreSchema(db);
  for (const h of ["be", "sim", "fe"]) {
    ensureAlias(db, h, "test");
    touchAlias(db, h);
  }
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

// #220: each lane gets one turn at a post, so two lanes can't pass it back
// and forth forever; with every lane passed, its thread says so.
test("a lane that held a post isn't offered it again; with none left, a reply in its thread says it's unclaimed", () => {
  const r = post(db, "be", "work", "work item"); // fe claims
  const key = claimKey(r.post.id);
  acknowledge(db, "fe", { kind: "push", post_id: r.post.id });
  sweepExpired(db, Date.now() + 31 * 60_000); // fe lapses; sim takes it
  const passed = release(db, "sim", key, "pass");
  // Both lanes held it: nobody holds it now, and fe isn't pushed it again.
  expect(listClaims(db).some((c) => c.key === key)).toBe(false);
  // In write order: the sweep ran at a later clock than the release.
  expect(db.prepare(`SELECT event FROM claim_events WHERE key = ? ORDER BY id`).all(key)).toEqual(
    ["take", "expire", "take", "release"].map((event) => ({ event })),
  );
  expect(pendingFor(db, "fe", { all: true }).some((i) => i.kind === "push" && i.post.id === r.post.id)).toBe(false);
  // The last holder's reply in the thread tells the poster; lanes are counted, not named.
  const replies = db.prepare(`SELECT author, body FROM posts WHERE parent_id = ?`).all(r.post.id);
  expect(replies).toEqual([{ author: "sim", body: `[unclaimed] ${key}: all 2 lanes passed on it, and no other lane is left; it stays here unclaimed` }]);
  expect(passed.wake).toEqual(["be"]);
  // The decline's repeat (#254) still answers from state.
  expect(release(db, "sim", key, "pass").releasedAt).toEqual(expect.any(Number));
});

test("a lapse on a one-lane queue says the post is unclaimed, and cc's the claim's watchers", () => {
  db.prepare(`DELETE FROM subscriptions WHERE handle = 'sim'`).run();
  const r = post(db, "be", "work", "work item"); // fe, the only lane, claims
  const key = claimKey(r.post.id);
  watch(db, "sim", key);
  const swept = sweepExpired(db, Date.now() + 31 * 60_000);
  const replies = db.prepare(`SELECT author, body FROM posts WHERE parent_id = ?`).all(r.post.id);
  expect(replies).toEqual([{ author: "fe", body: `[unclaimed] ${key}: its one lane passed on it, and no other lane is left; it stays here unclaimed cc @sim` }]);
  expect(swept.wake.sort()).toEqual(["be", "sim"]);
  expect(listClaims(db).some((c) => c.key === key)).toBe(false);
});

// #220: a lane that held the post is skipped even when it's the least recently woken.
test("with three lanes, a post skips the lane that held it, however long ago that lane was woken", () => {
  ensureAlias(db, "yak", "test");
  touchAlias(db, "yak");
  subscribe(db, "yak", "work", "push");
  const r = post(db, "be", "work", "work item");
  const key = claimKey(r.post.id);
  const holder = () => listClaims(db).find((c) => c.key === key)?.holder;
  const first = holder()!;
  release(db, first, key, "pass");
  const second = holder()!;
  const third = ["fe", "sim", "yak"].find((h) => h !== first && h !== second)!;
  // The third lane was woken more recently, by another post, than the first lane: rotation alone would pick the first.
  db.prepare(`INSERT INTO claim_events (key, handle, event, board, at) VALUES ('queue:work:999', ?, 'take', 'work', ?)`).run(third, Date.now() + 60_000);
  release(db, second, key, "pass");
  expect(holder()).toBe(third);
  release(db, third, key, "pass");
  expect(holder()).toBeUndefined();
  const replies = db.prepare(`SELECT author, body FROM posts WHERE parent_id = ?`).all(r.post.id);
  expect(replies).toEqual([{ author: third, body: `[unclaimed] ${key}: all 3 lanes passed on it, and no other lane is left; it stays here unclaimed` }]);
});

// #855: the [unclaimed] reply is written by the session whose decline caused it.
test("a decline's [unclaimed] reply is the declining session's, as its user", () => {
  db.prepare(`DELETE FROM subscriptions WHERE handle = 'sim'`).run();
  const r = post(db, "be", "work", "work item"); // fe, the only lane, claims
  release(db, "fe", claimKey(r.post.id), "pass", { session: "id:00000000000fe", via: "id:00000000000fe", user: "u-fe" });
  expect(db.prepare(`SELECT author, author_id, via, author_user FROM posts WHERE parent_id = ?`).all(r.post.id)).toEqual([
    { author: "fe", author_id: "id:00000000000fe", via: "id:00000000000fe", author_user: "u-fe" },
  ]);
});

// #855: a lapse has no caller; the reply is the user of the session that held the lane's name.
test("a lapse's [unclaimed] reply is the user of the lane's session", () => {
  db.prepare(`DELETE FROM subscriptions WHERE handle = 'sim'`).run();
  registerId(db, { id: "id:00000000000fe", principal: "u-fe", launcher: false });
  holdAlias(db, "fe", "id:00000000000fe");
  const r = post(db, "be", "work", "work item"); // fe, the only lane, claims
  sweepExpired(db, Date.now() + 31 * 60_000);
  expect(db.prepare(`SELECT author, author_id, author_user FROM posts WHERE parent_id = ?`).all(r.post.id)).toEqual([
    { author: "fe", author_id: null, author_user: "u-fe" },
  ]);
});

// #855 audit: a lane alias no session held at delivery takes its user at the lapse, from the session holding it then.
test("a lapse's [unclaimed] reply for a lane alias held only after delivery is the user of its holder at the lapse", () => {
  db.prepare(`DELETE FROM subscriptions WHERE handle = 'sim'`).run();
  const r = post(db, "be", "work", "work item"); // fe, the only lane and held by nobody, claims
  expect(db.prepare(`SELECT holder_user FROM claims WHERE key = ?`).get(claimKey(r.post.id))).toEqual({ holder_user: null });
  registerId(db, { id: "id:00000000000fe", principal: "u-fe", launcher: false });
  holdAlias(db, "fe", "id:00000000000fe");
  sweepExpired(db, Date.now() + 31 * 60_000);
  expect(db.prepare(`SELECT author, author_user FROM posts WHERE parent_id = ?`).all(r.post.id)).toEqual([{ author: "fe", author_user: "u-fe" }]);
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

// #284 S5: a queue post taken by a session's ID is acked by its reply as its
// alias; the ack is logged under the holder, and the poster isn't pushed its
// own reply under either address.
test("a reply by any of the holder's addresses acks the claim as the holder", () => {
  const ID = "id:0123456789abc";
  const r = post(db, "be", "work", "work item"); // fe claims
  db.prepare(`UPDATE claims SET holder = ? WHERE key = ?`).run(ID, claimKey(r.post.id));
  subscribe(db, ID, "work", "push");
  const reply = post(db, "fe", "work", "done", r.post.id, { addresses: ["fe", ID] });
  expect(reply.wake).not.toContain(ID);
  expect(listClaims(db).some((c) => c.key === claimKey(r.post.id))).toBe(false);
  expect(claimEvents(claimKey(r.post.id)).at(-1)).toEqual({ event: "release", handle: ID });
});

test("a holder's reply after its claim lapsed, before the sweep, still acks; the sweep redelivers nothing (#234)", () => {
  const r = post(db, "be", "work", "work item"); // fe claims
  db.prepare(`UPDATE claims SET expires_at = 1 WHERE key = ?`).run(claimKey(r.post.id));
  post(db, "fe", "work", "done: landed", r.post.id);
  expect(listClaims(db).some((c) => c.key === claimKey(r.post.id))).toBe(false);
  expect(sweepExpired(db).wake).toEqual([]);
  const events = db.prepare(`SELECT event, note FROM claim_events WHERE key = ? ORDER BY id`).all(claimKey(r.post.id));
  expect(events).toEqual([
    { event: "take", note: "queue post" },
    { event: "release", note: "ack (late)" },
  ]);
});

test("a reply by a different lane does not release the holder's claim", () => {
  const r = post(db, "be", "work", "work item"); // fe claims
  post(db, "sim", "work", "chiming in", r.post.id);
  expect(listClaims(db).some((c) => c.key === claimKey(r.post.id) && c.holder === "fe")).toBe(true);
});

test("a resolved @mention is direct addressing and bypasses the rotation", () => {
  const r = post(db, "be", "work", "@sim take this one");
  const rows = db.prepare(`SELECT handle, reason FROM outbox WHERE post_id = ?`).all(r.post.id) as { handle: string; reason: string }[];
  expect(rows).toEqual([{ handle: "sim", reason: "mention" }]);
});

// #219: a post addressed to one agent by name is tracked like a rotated one. An agent's post is strict
// (tools.ts passes strictIds); a system post is not.
const said = { strictIds: true };
const takes = (key: string) => claimEvents(key).filter((e) => e.event === "take").map((e) => e.handle);

test("one mentioned lane holds the post: its reply acks it", () => {
  const r = post(db, "be", "work", "@sim take this one", null, said);
  const key = claimKey(r.post.id);
  expect(listClaims(db).filter((c) => c.key === key).map((c) => [c.holder, c.note])).toEqual([["sim", "queue post (mentioned)"]]);
  expect(claimEvents(key)).toEqual([{ event: "take", handle: "sim" }]);
  post(db, "sim", "work", "on it, done", r.post.id, said);
  expect(listClaims(db).some((c) => c.key === key)).toBe(false);
});

test("a mentioned lane's lapse or decline redelivers through the rotation, never back to it", () => {
  const r = post(db, "be", "work", "@sim take this one", null, said);
  const key = claimKey(r.post.id);
  sweepExpired(db, Date.now() + 31 * 60_000);
  expect(listClaims(db).filter((c) => c.key === key).map((c) => c.holder)).toEqual(["fe"]);
  const r2 = post(db, "be", "work", "@fe and this one", null, said);
  release(db, "fe", claimKey(r2.post.id), "pass");
  expect(listClaims(db).filter((c) => c.key === claimKey(r2.post.id)).map((c) => c.holder)).toEqual(["sim"]);
});

test("a sole mentioned lane's lapse ends the post unclaimed, never re-offered to it", () => {
  db.prepare(`DELETE FROM subscriptions WHERE handle = 'fe'`).run();
  const r = post(db, "be", "work", "@sim take this one", null, said);
  const key = claimKey(r.post.id);
  sweepExpired(db, Date.now() + 31 * 60_000);
  expect(takes(key)).toEqual(["sim"]);
  expect(listClaims(db).some((c) => c.key === key)).toBe(false);
  const replies = db.prepare(`SELECT body FROM posts WHERE parent_id = ?`).all(r.post.id) as { body: string }[];
  expect(replies.map((x) => x.body.startsWith("[unclaimed]"))).toEqual([true]);
});

test("a mention of a session's other alias, or its ID, gives that session its one turn (#219 audit)", () => {
  const ID = "id:0123456789abc";
  registerId(db, { id: ID, principal: null, launcher: false });
  for (const a of ["zed", "alpha"]) ensureAlias(db, a, "test");
  holdAlias(db, "zed", ID, 100);
  holdAlias(db, "alpha", ID, 101);
  subscribe(db, "zed", "work", "push");
  db.prepare(`DELETE FROM subscriptions WHERE handle IN ('fe', 'sim')`).run();
  const r = post(db, "be", "work", "@alpha take this", null, said);
  release(db, "alpha", claimKey(r.post.id), "pass");
  expect(takes(claimKey(r.post.id))).toEqual(["alpha"]);
  // Its `[unclaimed]` reply counts one holder, not the holder and its lane.
  const reply = db.prepare(`SELECT body FROM posts WHERE parent_id = ?`).get(r.post.id) as { body: string };
  expect(reply.body).toContain("its one lane passed");
  const r2 = post(db, "be", "work", `@${ID} and this`, null, said);
  sweepExpired(db, Date.now() + 31 * 60_000);
  expect(takes(claimKey(r2.post.id))).toEqual([ID]);
});

test("several mentions, a human's handle or the poster's own address take no claim", () => {
  const several = post(db, "be", "work", "@sim @fe either of you", null, said);
  expect(several.wake.sort()).toEqual(["fe", "sim"]);
  ensureAlias(db, "wade", "test");
  db.prepare(`UPDATE aliases SET human = 1 WHERE address = 'wade'`).run();
  const human = post(db, "be", "work", "@wade a question", null, said);
  expect(human.wake).toEqual(["wade"]);
  const tail = "id:00000000000aa";
  registerId(db, { id: tail, principal: null, launcher: false, viewer: true });
  // An agent's post naming a viewer is refused whole (boards.md §3 Mentions); naming only itself reaches nobody.
  expect(() => post(db, "be", "work", `@${tail} look`, null, said)).toThrow("no session");
  post(db, "be", "work", "@be note to self", null, said);
  expect(db.prepare(`SELECT COUNT(*) AS n FROM claims WHERE key LIKE 'queue:%'`).get()).toEqual({ n: 0 });
});

test("a thread reply naming one lane takes no claim", () => {
  const r = post(db, "be", "work", "work item"); // fe claims by rotation
  post(db, "be", "work", "@sim can you help fe", r.post.id, said);
  expect(listClaims(db).filter((c) => c.key.startsWith("queue:")).map((c) => c.holder)).toEqual(["fe"]);
});

test("a system post's cc of one watcher takes no queue claim", () => {
  claim(db, "be", "ticket:ENG-142", { board: "work" });
  watch(db, "sim", "ticket:ENG-142");
  release(db, "be", "ticket:ENG-142", "done");
  expect(listClaims(db).filter((c) => c.key.startsWith("queue:") && c.holder === "sim")).toEqual([]);
  const notes = db.prepare(`SELECT note FROM claim_events WHERE note = 'queue post (mentioned)'`).all();
  expect(notes).toEqual([]);
});

test("status text is not a busy flag; only the explicit opt-out skips a lane", () => {
  registerId(db, { id: "id:00000000000fe", principal: null, launcher: false });
  holdAlias(db, "fe", "id:00000000000fe");
  setStatus(db, "fe", "heads-down on another task");
  const r = post(db, "be", "work", "work item");
  expect(r.wake).toEqual(["fe"]); // status is free text; fe is still eligible
  setQueueParticipation(db, "fe", false);
  const r2 = post(db, "be", "work", "second work item");
  expect(r2.wake).toEqual(["sim"]);
  // The opt-out persists until the lane opts back in.
  expect(db.prepare(`SELECT queue_off FROM aliases WHERE address = 'fe'`).get()).toEqual({ queue_off: 1 });
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

// #284 S6: an unbound live session is a lane by its ID; once it holds an
// alias the alias is the lane (audit W9: the subscription stays under the
// ID, so the session stays in the rotation), and an ended ID is none.
test("an unbound live ID subscribed to a queue is a lane by its ID, then by the alias it binds; ended, none", () => {
  const ID = "id:0123456789abc";
  registerId(db, { id: ID, principal: null, launcher: false });
  subscribe(db, ID, "work", "push");
  const lanes = () => queueLanes(db, getBoard(db, "work")!, ["be"]).sort();
  expect(lanes()).toEqual(["fe", ID, "sim"].sort());
  expect(post(db, "be", "work", "for the live one", null, { online: (h) => h === ID }).wake).toEqual([ID]);
  ensureAlias(db, "qa", "test");
  holdAlias(db, "qa", ID);
  expect(lanes()).toEqual(["fe", "qa", "sim"]);
  expect(post(db, "be", "work", "for the bound one", null, { online: (h) => h === "qa" }).wake).toEqual(["qa"]);
  setQueueParticipation(db, "qa", false);
  expect(lanes()).toEqual(["fe", "sim"]);
  db.prepare(`DELETE FROM alias_holds WHERE id = ?`).run(ID);
  db.prepare(`UPDATE ids SET ended_at = 1 WHERE id = ?`).run(ID);
  expect(lanes()).toEqual(["fe", "sim"]);
});

// #284 S13: a session's lane is its primary, once, however many aliases it holds.
test("an ID-subscribed queue board counts a two-hold session once, by its primary", () => {
  const ID = "id:0123456789abc";
  registerId(db, { id: ID, principal: null, launcher: false });
  subscribe(db, ID, "work", "push");
  for (const a of ["zed", "alpha"]) ensureAlias(db, a, "test");
  holdAlias(db, "zed", ID, 100);
  holdAlias(db, "alpha", ID, 100);
  expect(queueLanes(db, getBoard(db, "work")!, ["be"]).sort()).toEqual(["fe", "sim", "zed"]);
});

// #284 S5: a session posting as any of its aliases is never its own lane,
// on the first delivery or a decline's redelivery.
test("a session posting as its second alias never claims its own queue post", () => {
  const ID = "id:0123456789abc";
  registerId(db, { id: ID, principal: null, launcher: false });
  subscribe(db, ID, "work", "push");
  for (const a of ["zed", "alpha"]) ensureAlias(db, a, "test");
  holdAlias(db, "zed", ID, 100);
  holdAlias(db, "alpha", ID, 101);
  const as = { addresses: ["alpha", "zed", ID], author_id: ID };
  const posts = [1, 2, 3].map((n) => post(db, "alpha", "work", `item ${n}`, null, as));
  expect(posts.map((r) => r.wake)).toEqual([["be"], ["fe"], ["sim"]]);
  // be declines item 1: zed is the least-recently-woken other lane, but it
  // is the author's session, so fe takes it.
  release(db, "be", claimKey(posts[0]!.post.id), "not my lane");
  expect(listClaims(db).filter((c) => c.holder === "zed")).toEqual([]);
  expect(listClaims(db).find((c) => c.key === claimKey(posts[0]!.post.id))?.holder).toBe("fe");
});

test("a read-only viewer is never picked by the rotation", () => {
  const tail = "id:00000000000a1";
  registerId(db, { id: tail, principal: null, launcher: false, viewer: true });
  subscribe(db, tail, "work", "push");
  const r = post(db, "be", "work", "work item");
  expect(r.wake).not.toContain(tail);
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
    seesAliasMeta: () => true,
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

test("a repeated decline (its answer lost, #254) succeeds without a second release or redelivery", () => {
  for (const h of ["yak", "zed"]) {
    ensureAlias(db, h, "test");
    subscribe(db, h, "work", "push");
  }
  const r = post(db, "be", "work", "work item"); // fe claims it
  release(db, "fe", claimKey(r.post.id), "not my lane"); // redelivered: sim holds it
  const outbox = () => db.prepare(`SELECT handle, delivered_at, wake FROM outbox WHERE post_id = ? ORDER BY handle`).all(r.post.id);
  const before = { outbox: outbox(), events: claimEvents(claimKey(r.post.id)) };
  const again = release(db, "fe", claimKey(r.post.id), "not my lane");
  expect(again).toEqual({ wake: [], boards: [], releasedAt: expect.any(Number) });
  expect(claimEvents(claimKey(r.post.id))).toEqual(before.events);
  expect(outbox()).toEqual(before.outbox);
  expect(listClaims(db).find((c) => c.key === claimKey(r.post.id))?.holder).toBe("sim");
  // Once sim has acted on the key, fe's decline is history, and sim's is the latest.
  release(db, "sim", claimKey(r.post.id), "pass"); // redelivered: yak holds it
  expect(release(db, "sim", claimKey(r.post.id), "pass").releasedAt).toEqual(expect.any(Number));
  // A TTL takeover isn't a release: the lapsed lane's call is refused as before.
  sweepExpired(db, Date.now() + 31 * 60_000); // yak lapses; zed takes it
  expect(() => release(db, "yak", claimKey(r.post.id))).toThrow(/held by zed/);
});

// #221: a lane was woken when it was handed the work, not when the post was
// written. A redelivered old post moves its new holder to the back of the
// rotation, so that lane isn't also handed the next new post.
test("a redelivery of an old post moves its new holder to the back of the rotation", () => {
  ensureAlias(db, "zed", "test");
  touchAlias(db, "zed");
  subscribe(db, "zed", "work", "push");
  const posts = [1, 2, 3].map((n) => post(db, "be", "work", `item ${n}`));
  expect(posts.map((r) => r.wake)).toEqual([["fe"], ["sim"], ["zed"]]);
  // Pin the three deliveries to distinct past times: fe, then sim, then zed.
  posts.forEach((r, i) => {
    const at = (i + 1) * 1000;
    db.prepare(`UPDATE posts SET created_at = ? WHERE id = ?`).run(at, r.post.id);
    db.prepare(`UPDATE claim_events SET at = ? WHERE key = ?`).run(at, claimKey(r.post.id));
  });
  // fe declines item 1; sim, the least recently woken other lane, takes it now.
  release(db, "fe", claimKey(posts[0]!.post.id), "not my lane");
  expect(listClaims(db).find((c) => c.key === claimKey(posts[0]!.post.id))?.holder).toBe("sim");
  // Item 1 was written at 1000, but sim was handed it now: sim goes last.
  expect(queueLanes(db, getBoard(db, "work")!, ["be"])).toEqual(["fe", "zed", "sim"]);
  expect(post(db, "be", "work", "item 4").wake).toEqual(["fe"]);
  expect(post(db, "be", "work", "item 5").wake).toEqual(["zed"]);
});

// #1174: a lane is its session, not the handle it held when it took a post. A session that subscribed unbound and
// took a post as its ID, then bound a name, keeps that take in the rotation and has had its one turn at the post.
describe("a lane's history follows its session across a bind (#1174)", () => {
  const S = "id:0000000001174";
  beforeEach(() => {
    db.prepare(`DELETE FROM subscriptions WHERE handle = 'fe'`).run();
    registerId(db, { id: S, principal: null, launcher: false });
    ensureAlias(db, "qa", "test");
    subscribe(db, S, "work", "push");
  });

  test("a lane that took a post unbound, then bound a name, keeps its place in the rotation", () => {
    // Both never woken: the ID sorts before sim.
    expect(post(db, "be", "work", "item 1").wake).toEqual([S]);
    holdAlias(db, "qa", S);
    // qa is the same session as the ID that took item 1: sim, never woken, is next.
    expect(queueLanes(db, getBoard(db, "work")!, ["be"])).toEqual(["sim", "qa"]);
    expect(post(db, "be", "work", "item 2").wake).toEqual(["sim"]);
  });

  test("a take under another alias the session holds counts for its lane", () => {
    ensureAlias(db, "alpha", "test");
    holdAlias(db, "qa", S, 100);
    holdAlias(db, "alpha", S, 101);
    const r = post(db, "be", "work", "@alpha take this", null, said);
    expect(takes(claimKey(r.post.id))).toEqual(["alpha"]);
    expect(post(db, "be", "work", "item 2").wake).toEqual(["sim"]);
  });

  test("a post it took unbound and declined after binding isn't offered it again, and counts it once", () => {
    const r = post(db, "be", "work", "item 1");
    const key = claimKey(r.post.id);
    holdAlias(db, "qa", S);
    release(db, "qa", key, "pass", { addresses: ["qa", S], session: S });
    expect(listClaims(db).filter((c) => c.key === key).map((c) => c.holder)).toEqual(["sim"]);
    release(db, "sim", key, "pass");
    expect(takes(key)).toEqual([S, "sim"]);
    const replies = db.prepare(`SELECT body FROM posts WHERE parent_id = ?`).all(r.post.id) as { body: string }[];
    expect(replies.map((x) => x.body)).toEqual([`[unclaimed] ${key}: all 2 lanes passed on it, and no other lane is left; it stays here unclaimed`]);
  });

  test("a lane subscribed as a non-primary alias has had its turn when the session took the post as another", () => {
    db.prepare(`DELETE FROM subscriptions WHERE handle = ?`).run(S);
    ensureAlias(db, "qb", "test");
    holdAlias(db, "qa", S, 100);
    holdAlias(db, "qb", S, 101);
    subscribe(db, "qb", "work", "push");
    const r = post(db, "be", "work", "@qa take this", null, said);
    const key = claimKey(r.post.id);
    release(db, "qa", key, "pass", { addresses: ["qa", "qb", S], session: S });
    // Not re-offered to the same session as qb: sim is the only other lane.
    expect(listClaims(db).filter((c) => c.key === key).map((c) => c.holder)).toEqual(["sim"]);
    release(db, "sim", key, "pass");
    expect(takes(key)).toEqual(["qa", "sim"]);
    const replies = db.prepare(`SELECT body FROM posts WHERE parent_id = ?`).all(r.post.id) as { body: string }[];
    expect(replies.map((x) => x.body)).toEqual([`[unclaimed] ${key}: all 2 lanes passed on it, and no other lane is left; it stays here unclaimed`]);
  });

  test("a session that held a post under two addresses counts as one lane in its [unclaimed] reply", () => {
    db.prepare(`DELETE FROM subscriptions WHERE handle IN ('sim', ?)`).run(S);
    ensureAlias(db, "qb", "test");
    holdAlias(db, "qa", S, 100);
    holdAlias(db, "qb", S, 101);
    subscribe(db, "qb", "work", "push");
    const r = post(db, "be", "work", "@qa take this", null, said);
    const key = claimKey(r.post.id);
    // A take as qb the redelivery rule no longer makes (the history of an older build): one session, one lane.
    logEvent(db, "take", "qb", { key, board: "work" }, Date.now());
    release(db, "qa", key, "pass", { addresses: ["qa", "qb", S], session: S });
    const replies = db.prepare(`SELECT body FROM posts WHERE parent_id = ?`).all(r.post.id) as { body: string }[];
    expect(replies.map((x) => x.body)).toEqual([`[unclaimed] ${key}: its one lane passed on it, and no other lane is left; it stays here unclaimed`]);
  });

  test("its one turn as its only lane: declined after binding, the post ends unclaimed with one lane counted", () => {
    db.prepare(`DELETE FROM subscriptions WHERE handle = 'sim'`).run();
    const r = post(db, "be", "work", "item 1");
    const key = claimKey(r.post.id);
    holdAlias(db, "qa", S);
    release(db, "qa", key, "pass", { addresses: ["qa", S], session: S });
    expect(takes(key)).toEqual([S]);
    const replies = db.prepare(`SELECT body FROM posts WHERE parent_id = ?`).all(r.post.id) as { body: string }[];
    expect(replies.map((x) => x.body)).toEqual([`[unclaimed] ${key}: its one lane passed on it, and no other lane is left; it stays here unclaimed`]);
  });
});

// #1174 audit L1: each half of a lane's history (its takes and its deliveries) follows its session on its own. A take
// usually comes with an outbox row under the same handle, so each case here splits them.
describe("each half of a lane's rotation history follows its session (#1174 audit)", () => {
  const S = "id:0000000001174";
  beforeEach(() => {
    db.prepare(`DELETE FROM subscriptions WHERE handle = 'fe'`).run();
    registerId(db, { id: S, principal: null, launcher: false });
    ensureAlias(db, "qa", "test");
    subscribe(db, S, "work", "push");
  });
  const pin = (rs: { post: { id: number } }[]) =>
    rs.forEach((r, i) => {
      const at = (i + 1) * 1000;
      db.prepare(`UPDATE posts SET created_at = ? WHERE id = ?`).run(at, r.post.id);
      db.prepare(`UPDATE claim_events SET at = ? WHERE key = ?`).run(at, claimKey(r.post.id));
    });

  test("a take of an old post's redelivery as its ID, then a bind, puts the lane last (the take, not the post's time)", () => {
    ensureAlias(db, "zed", "test");
    touchAlias(db, "zed");
    subscribe(db, "zed", "work", "push");
    const rs = [1, 2, 3].map((n) => post(db, "be", "work", `item ${n}`));
    expect(rs.map((r) => r.wake)).toEqual([[S], ["sim"], ["zed"]]);
    pin(rs);
    // sim declines item 2 (written at 2000); the session, least recently woken at 1000, takes it now as its ID.
    release(db, "sim", claimKey(rs[1]!.post.id), "pass");
    expect(takes(claimKey(rs[1]!.post.id))).toEqual(["sim", S]);
    holdAlias(db, "qa", S);
    // Its outbox rows say 1000 and 2000; only its take as the ID says now.
    expect(queueLanes(db, getBoard(db, "work")!, ["be"])).toEqual(["sim", "zed", "qa"]);
  });

  test("a delivery to its ID with no take (a thread mention), then a bind, puts the lane last", () => {
    const rs = [1, 2].map((n) => post(db, "be", "work", `item ${n}`));
    expect(rs.map((r) => r.wake)).toEqual([[S], ["sim"]]);
    pin(rs);
    // A thread reply naming the ID delivers to it now and takes no claim.
    const reply = post(db, "be", "work", `@${S} a note on item 1`, rs[0]!.post.id, said);
    expect(reply.wake).toEqual([S]);
    expect(takes(claimKey(rs[0]!.post.id))).toEqual([S]);
    holdAlias(db, "qa", S);
    // Its take as the ID says 1000; only its delivery as the ID says now.
    expect(queueLanes(db, getBoard(db, "work")!, ["be"])).toEqual(["sim", "qa"]);
  });
});

// #1351: a take records its taking session (claim_events.session_id) and follows it while that session is live, across
// a rename or an alias that moved to another session; an old row, or one whose session has ended, maps through who
// holds its handle now (#1174).
describe("a take follows its taking session while it is live (#1351)", () => {
  const A = "id:0000000001351", A2 = "id:0000000002351", B = "id:0000000003351";
  beforeEach(() => {
    db.prepare(`DELETE FROM subscriptions WHERE handle = 'fe'`).run();
    for (const id of [A, A2, B]) registerId(db, { id, principal: null, launcher: false });
    for (const h of ["x", "y", "z"]) ensureAlias(db, h, "test");
  });
  const lanes = () => queueLanes(db, getBoard(db, "work")!, ["be"]);
  const holders = (key: string) => listClaims(db).filter((c) => c.key === key).map((c) => c.holder);
  const replies = (postId: number) => (db.prepare(`SELECT body FROM posts WHERE parent_id = ?`).all(postId) as { body: string }[]).map((r) => r.body);
  const lapse = () => sweepExpired(db, Date.now() + 31 * 60_000);
  // A post's delivery pinned to `at`, its claim dropped so a later lapse touches only the post under test.
  const wokeAt = (postId: number, at: number, keep = false) => {
    db.prepare(`UPDATE posts SET created_at = ? WHERE id = ?`).run(at, postId);
    db.prepare(`UPDATE claim_events SET at = ? WHERE key = ?`).run(at, claimKey(postId));
    if (!keep) db.prepare(`DELETE FROM claims WHERE key = ?`).run(claimKey(postId));
  };
  const unclaimed = (key: string, n: number) =>
    `[unclaimed] ${key}: ${n === 1 ? "its one lane" : `all ${n} lanes`} passed on it, and no other lane is left; it stays here unclaimed`;

  test("records the holding session for a held alias and for a session ID, and null for an alias no session holds", () => {
    holdAlias(db, "x", A);
    const sid = (h: string) => {
      logEvent(db, "take", h, { key: "k:" + h }, 1);
      return (db.prepare(`SELECT session_id FROM claim_events WHERE key = ?`).get("k:" + h) as { session_id: string | null }).session_id;
    };
    expect([sid("x"), sid(B), sid("y")]).toEqual([A, B, null]);
  });

  test("rename: a session that took a post as an alias it then released isn't offered it again, and keeps its place", () => {
    holdAlias(db, "x", A, 100);
    holdAlias(db, "y", A, 101);
    subscribe(db, A, "work", "push"); // its lane is x, its primary
    const first = post(db, "be", "work", "item 0");
    expect(first.wake).toEqual(["sim"]);
    wokeAt(first.post.id, 500);
    const r = post(db, "be", "work", "@x take this", null, said);
    const key = claimKey(r.post.id);
    expect(holders(key)).toEqual(["x"]);
    wokeAt(r.post.id, 1000, true);
    db.prepare(`DELETE FROM alias_holds WHERE address = 'x'`).run(); // its lane is y now
    // Its take as x, at 1000, is still its own: sim, woken at 500, is next.
    expect(lanes()).toEqual(["sim", "y"]);
    lapse();
    expect(holders(key)).toEqual(["sim"]);
    release(db, "sim", key, "pass");
    // Not offered to the session as y: both lanes have had their turn.
    expect(holders(key)).toEqual([]);
    expect(replies(r.post.id)).toEqual([unclaimed(key, 2)]);
  });

  test("rename: the alias a session took a post as and then released isn't offered it again as a lane of its own", () => {
    db.prepare(`DELETE FROM subscriptions WHERE handle = 'sim'`).run();
    holdAlias(db, "x", A, 100);
    holdAlias(db, "y", A, 101);
    subscribe(db, "x", "work", "push");
    subscribe(db, "y", "work", "push");
    const r = post(db, "be", "work", "@x take this", null, said);
    const key = claimKey(r.post.id);
    expect(holders(key)).toEqual(["x"]);
    db.prepare(`DELETE FROM alias_holds WHERE address = 'x'`).run(); // A is live as y; x, unheld, is still a lane
    expect(lanes()).toEqual(["x", "y"]);
    lapse();
    // Neither x (the alias A took it as) nor y (A's other lane) gets it back.
    expect(holders(key)).toEqual([]);
    expect(replies(r.post.id)).toEqual([unclaimed(key, 1)]);
  });

  for (const sub of ["z", "y"]) {
    test(`move: an alias that moved to another live session doesn't take its turn (subscribed as ${sub === "z" ? "its primary" : "a non-primary alias"})`, () => {
      db.prepare(`DELETE FROM subscriptions WHERE handle = 'sim'`).run();
      holdAlias(db, "x", A, 100);
      subscribe(db, A, "work", "push"); // A's lane is x
      holdAlias(db, "z", B, 100);
      holdAlias(db, "y", B, 101);
      subscribe(db, sub, "work", "push");
      const r = post(db, "be", "work", "@x take this", null, said);
      const key = claimKey(r.post.id);
      expect(holders(key)).toEqual(["x"]);
      holdAlias(db, "x", B, 102); // x moves from A to B; A's lane is its ID now
      lapse();
      // A had its turn; B never did, though it holds x now.
      expect(holders(key)).toEqual([sub]);
    });
  }

  test("restart: a successor that rebinds the name has had its ended predecessor's turn and takes its place", () => {
    holdAlias(db, "x", A);
    subscribe(db, A, "work", "push");
    const first = post(db, "be", "work", "item 0");
    expect(first.wake).toEqual(["sim"]);
    wokeAt(first.post.id, 500);
    const r = post(db, "be", "work", "@x take this", null, said);
    const key = claimKey(r.post.id);
    wokeAt(r.post.id, 1000, true);
    // A ends; A2 starts and binds x.
    db.prepare(`UPDATE ids SET ended_at = 2000 WHERE id = ?`).run(A);
    db.prepare(`DELETE FROM alias_holds WHERE id = ?`).run(A);
    db.prepare(`DELETE FROM subscriptions WHERE handle = ?`).run(A);
    holdAlias(db, "x", A2);
    subscribe(db, A2, "work", "push");
    // A's take at 1000 is x's history now: sim, at 500, is next.
    expect(lanes()).toEqual(["sim", "x"]);
    db.prepare(`DELETE FROM subscriptions WHERE handle = 'sim'`).run();
    lapse();
    expect(holders(key)).toEqual([]);
    expect(replies(r.post.id)).toEqual([unclaimed(key, 1)]);
  });

  test("an old row with no session maps through who holds its handle now", () => {
    holdAlias(db, "x", A, 100);
    holdAlias(db, "y", A, 101);
    subscribe(db, A, "work", "push"); // A's lane is x
    const r = post(db, "be", "work", "@sim take this", null, said);
    const key = claimKey(r.post.id);
    const ins = db.prepare(`INSERT INTO claim_events (key, handle, event, board, at) VALUES (?, 'y', 'take', 'work', ?)`);
    ins.run(key, 1);
    // An old take as y on another post, later than sim's: A's lane goes last.
    ins.run("queue:work:999999", Date.now() + 60_000);
    expect(lanes()).toEqual(["sim", "x"]);
    release(db, "sim", key, "pass");
    expect(holders(key)).toEqual([]);
    expect(replies(r.post.id)).toEqual([unclaimed(key, 2)]);
  });

  test("one session's takes under two names count once in its [unclaimed] reply, after it released one", () => {
    db.prepare(`DELETE FROM subscriptions WHERE handle = 'sim'`).run();
    holdAlias(db, "x", A, 100);
    holdAlias(db, "y", A, 101);
    subscribe(db, A, "work", "push");
    const r = post(db, "be", "work", "@x take this", null, said);
    const key = claimKey(r.post.id);
    logEvent(db, "take", "y", { key, board: "work" }, Date.now());
    db.prepare(`DELETE FROM alias_holds WHERE address = 'x'`).run();
    lapse();
    expect(holders(key)).toEqual([]);
    expect(replies(r.post.id)).toEqual([unclaimed(key, 1)]);
  });
});

// #1174 audit H1: queueLaneRows runs inside every queue post's and requeue's write transaction, so its per-lane
// history reads must stay index searches as history grows, with or without ANALYZE stats. Its address-set subqueries
// once knocked the planner onto idx_claim_events_key's GLOB range (with stats) or onto every post on the board,
// probing outbox per post (without), 130x slower at 20k rows.
describe("queueLaneRows' plan stays indexed (#1174 audit)", () => {
  const plan = () =>
    (db.prepare("EXPLAIN QUERY PLAN " + queueLaneRowsSql()).all("work", `["be"]`) as { detail: string }[]).map((r) => r.detail);
  beforeEach(() => {
    createBoard(db, "be", "other", "another queue", null, { kind: "queue" });
    const lanes = 20;
    for (let i = 0; i < lanes; i++) {
      const id = "id:" + String(i).padStart(13, "0");
      ensureAlias(db, "l" + i, "test");
      registerId(db, { id, principal: null, launcher: false });
      holdAlias(db, "l" + i, id);
      subscribe(db, i % 2 ? id : "l" + i, "work", "push");
    }
    const insP = db.prepare(`INSERT INTO posts (board, author, body, created_at) VALUES (?, 'be', 'x', ?)`);
    const insO = db.prepare(`INSERT OR IGNORE INTO outbox (handle, post_id, reason) VALUES (?, ?, 'subscription')`);
    const insE = db.prepare(`INSERT INTO claim_events (key, handle, event, board, at, session_id) VALUES (?, ?, ?, ?, ?, ?)`);
    db.transaction(() => {
      for (let k = 0; k < 3000; k++) {
        const board = k % 3 ? "other" : "work";
        const id = Number(insP.run(board, k).lastInsertRowid);
        insO.run("l" + (k % lanes), id);
        const handle = k % 4 ? "l" + (k % lanes) : "id:" + String(k % lanes).padStart(13, "0");
        // Half the rows carry their taking session (#1351), half are from before it.
        insE.run(`queue:${board}:${id}`, handle, k % 5 ? "take" : "release", board, k, k % 2 ? "id:" + String(k % lanes).padStart(13, "0") : null);
      }
    })();
  });

  for (const analyze of [false, true]) {
    test(`takes by (board, session_id) and (board, handle), outbox by handle then posts by id, ${analyze ? "with" : "without"} ANALYZE`, () => {
      if (analyze) db.run("ANALYZE");
      const p = plan();
      // Names only our own indexes and the query's table aliases, so a SQLite upgrade's rewording ("SEARCH TABLE",
      // COVERING) doesn't fail it: every read of e, o2 and p2 is a search, takes go through (board, handle), posts
      // never through the board range, and outbox drives the join (its search before the posts probe).
      const of = (alias: string) => p.filter((d) => new RegExp(`^(SCAN|SEARCH)( TABLE)? ${alias}\\b`).test(d));
      const es = of("es"), e = of("e"), o2 = of("o2"), p2 = of("p2");
      for (const reads of [es, e, o2, p2]) expect(reads.length).toBeGreaterThan(0);
      for (const d of [...es, ...e, ...o2, ...p2]) expect(d).toStartWith("SEARCH");
      // The session-keyed takes (#1351) by (board, session_id), the address-keyed ones by (board, handle).
      for (const d of es) expect(d).toMatch(/\bidx_claim_events_take_sid\b/);
      for (const d of e) expect(d).toMatch(/\bidx_claim_events_take\b(?!_)/);
      for (const d of p2) expect(d).not.toContain("idx_posts_board_id");
      const first = (alias: string) => p.findIndex((d) => new RegExp(`^SEARCH( TABLE)? ${alias}\\b`).test(d));
      expect(first("o2")).toBeLessThan(first("p2"));
    });
  }
});

// #1175: a declared human isn't a work lane, and a queue post nobody takes still ends visibly when its last holder
// can't write the [unclaimed] reply: its own author writes it, never as a human.
describe("#1175: humans aren't lanes; the [unclaimed] reply falls back to the post's author", () => {
  const replies = (postId: number) => db.prepare(`SELECT author, author_id, author_user, body FROM posts WHERE parent_id = ?`).all(postId);
  const later = () => Date.now() + 31 * 60_000;
  // sim leaves the work board's lanes: fe is the only one.
  const oneLane = () => db.prepare(`DELETE FROM subscriptions WHERE handle = 'sim'`).run();
  // fe, the only lane, loses the scoped board after it took a post there; be and sim still see it.
  const lostBoard = () => {
    const sees = new Set(["be", "sim", "fe"]);
    setAccess(db, { ...openAccess(db), canSee: (h, b) => b.scope === null || sees.has(h), checkCreate: () => null });
    createBoard(db, "be", "eng", "team queue", "team:eng", { kind: "queue" });
    subscribe(db, "fe", "eng", "push");
    return sees;
  };

  test("a push-subscribed human is never a lane, by rotation or by mention", () => {
    declareHuman(db, "sim");
    expect(queueLanes(db, getBoard(db, "work")!, ["be"])).toEqual(["fe"]);
    const r = post(db, "be", "work", "work item"); // fe claims
    release(db, "fe", claimKey(r.post.id), "pass");
    // sim, the human, is never offered it: fe's decline leaves no lane.
    expect(replies(r.post.id)).toEqual([expect.objectContaining({ author: "fe", body: expect.stringContaining("its one lane passed on it") })]);
    // A mention tells the human but claims nothing: no queue claim is a human's.
    const named = post(db, "be", "work", "@sim have a look");
    expect(named.wake).toEqual(["sim"]);
    expect(listClaims(db).filter((c) => c.key.startsWith("queue:"))).toEqual([]);
  });

  test("a last holder that lost the board: the post's author writes the reply, unwoken; its watchers are told", () => {
    const sees = lostBoard();
    registerId(db, { id: "id:0000000000be1", principal: "u-be", launcher: false });
    const r = post(db, "be", "eng", "eng work", null, { author_id: "id:0000000000be1", author_user: "u-be" }); // fe claims
    const key = `queue:eng:${r.post.id}`;
    watch(db, "sim", key);
    sees.delete("fe");
    const swept = sweepExpired(db, later());
    expect(replies(r.post.id)).toEqual([{
      author: "be", author_id: "id:0000000000be1", author_user: "u-be",
      body: `[unclaimed] ${key}: its one lane passed on it, and no other lane is left; it stays here unclaimed cc @sim`,
    }]);
    expect(swept.wake).toEqual(["sim"]);
    // Neither the author nor its writing session is handed its own reply.
    const handed = db.prepare(`SELECT handle FROM outbox WHERE post_id = (SELECT id FROM posts WHERE parent_id = ?)`).all(r.post.id);
    expect(handed).toEqual([{ handle: "sim" }]);
  });

  test("a decline's reply refused for its holder falls back to the author", () => {
    oneLane();
    setAccess(db, { ...openAccess(db), resolveMention: (t, author) => { if (author === "fe") throw new CoreError("fe can't mention"); return t; } });
    const r = post(db, "be", "work", "work item"); // fe claims
    const key = claimKey(r.post.id);
    watch(db, "sim", key);
    expect(release(db, "fe", key, "pass", { session: "id:00000000000fe", user: "u-fe" }).wake).toEqual(["sim"]);
    expect(replies(r.post.id)).toEqual([expect.objectContaining({ author: "be", author_id: null, author_user: null })]);
  });

  test("the author can't see the board either: the post ends quietly", () => {
    const sees = lostBoard();
    const r = post(db, "be", "eng", "eng work"); // fe claims
    sees.delete("fe");
    sees.delete("be");
    expect(sweepExpired(db, later()).wake).toEqual([]);
    expect(replies(r.post.id)).toEqual([]);
  });

  test("a human's post ends quietly when its last holder can't write the reply: no system text bears the human mark", () => {
    declareHuman(db, "be");
    const sees = lostBoard();
    const r = post(db, "be", "eng", "eng work"); // fe claims
    sees.delete("fe");
    expect(sweepExpired(db, later()).wake).toEqual([]);
    expect(replies(r.post.id)).toEqual([]);
  });

  test("a human holding a queue claim (one taken before humans left the lanes) never writes its reply", () => {
    oneLane();
    const r = post(db, "be", "work", "work item"); // fe claims
    declareHuman(db, "fe");
    sweepExpired(db, later());
    expect(replies(r.post.id)).toEqual([expect.objectContaining({ author: "be" })]);
  });

  // #1175 test gap: a decline's reply leaves out the caller's whole address set, a tools-only session's writes-as alias
  // among them, which no session holds, so only ctx.addresses names it.
  test("a decline's reply never reaches the declining caller's other addresses", () => {
    oneLane();
    ensureAlias(db, "fe-w", "test");
    const r = post(db, "be", "work", "work item"); // fe claims
    const key = claimKey(r.post.id);
    watch(db, "fe-w", key);
    const out = release(db, "fe", key, "pass", { addresses: ["fe", "fe-w"] });
    expect(replies(r.post.id)).toEqual([expect.objectContaining({ author: "fe", body: expect.stringMatching(/ cc @fe-w$/) })]);
    expect(out.wake).toEqual(["be"]);
  });

  // #1175 test gap: claimQueuePost's holder_user from an ID lane's own principal.
  test("a lane subscribed as an unbound session's ID records that session's user", () => {
    oneLane();
    db.prepare(`DELETE FROM subscriptions WHERE handle = 'fe'`).run();
    registerId(db, { id: "id:0000000000ln1", principal: "u-lane", launcher: false });
    subscribe(db, "id:0000000000ln1", "work", "push");
    const r = post(db, "be", "work", "work item");
    expect(db.prepare(`SELECT holder, holder_user FROM claims WHERE key = ?`).get(claimKey(r.post.id))).toEqual({ holder: "id:0000000000ln1", holder_user: "u-lane" });
    sweepExpired(db, later());
    expect(replies(r.post.id)).toEqual([expect.objectContaining({ author: "id:0000000000ln1", author_user: "u-lane" })]);
  });
});
