import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acknowledge,
  activeAnnouncements,
  createBoard,
  declareHuman,
  ensureBoard,
  getBoard,
  humanHandles,
  isHuman,
  listBoards,
  markDelivered,
  mentionTokens,
  openAccess,
  pendingFor,
  post,
  prunePosts,
  read,
  refOf,
  setAccess,
  startSession,
  subscribe,
  touchHandle,
  who,
  type Access,
  setCapability,
} from "./boards.ts";
import { announcementsInstruction, callBoardTool, claimsInstruction, humanInstruction } from "./tools.ts";
import { claim, claimExpiryTimer, listClaims, release, sweepExpired, watch } from "./claims.ts";
import { initCoreSchema } from "./schema.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  initCoreSchema(db);
  for (const h of ["be", "sim", "fe"]) touchHandle(db, h);
  createBoard(db, "be", "#e2e", "End-to-end fixtures and runs");
});

// all: as a session's first drain does, bringing deferred pushes and digests.
const drain = (h: string, all = false) => {
  const items = pendingFor(db, h, { all });
  for (const i of items) markDelivered(db, h, i);
  return items;
};

test("a declared human handle persists across sessions; declaring another moves it", () => {
  expect(humanHandles(db)).toEqual([]);
  expect(humanInstruction(humanHandles(db))).toEqual([]);
  declareHuman(db, "alex");
  expect(isHuman(db, "alex")).toBe(true);
  expect(isHuman(db, "be")).toBe(false);
  expect(humanInstruction(humanHandles(db))[0]).toContain('Humans on this bus: "alex"');
  expect(humanInstruction(humanHandles(db))[1]).toContain("#announce");
  const r = who(db, "be", { include_offline: true }, () => true);
  expect(r.peers.find((p) => p.handle === "alex")?.human).toBe(true);
  expect(r.peers.find((p) => p.handle === "sim")?.human).toBeUndefined();
  startSession(db, "alex", null);
  expect(humanHandles(db)).toEqual(["alex"]);
  declareHuman(db, "sam");
  expect(humanHandles(db)).toEqual(["sam"]);
});

describe("#announce", () => {
  const live = new Set(["be", "sim"]); // fe is offline
  const online = (h: string) => live.has(h);
  beforeEach(() => {
    ensureBoard(db, "announce", "Announcements", null, "grayboard");
    // Subscriptions don't count here: a push subscriber gets nothing extra.
    subscribe(db, "fe", "announce", "push");
    declareHuman(db, "alex");
  });

  test("only a human starts a post; agents are told to reply instead", () => {
    expect(() => post(db, "be", "announce", "everyone stop", null, { online })).toThrow(/only your user starts posts/);
  });

  test("a human's announcement reaches only live sessions, as a mention marked by its board", () => {
    const r = post(db, "alex", "announce", "shutting down in 30 min", null, { online });
    expect(r.wake.sort()).toEqual(["be", "sim"]);
    expect(drain("be")).toMatchObject([{ kind: "push", reason: "mention", post: { board: "announce", author: "alex" } }]);
    expect(drain("fe")).toEqual([]);
  });

  test("an agent's ack reaches only the announcer; the human's reply reaches the thread", () => {
    const root = post(db, "alex", "announce", "stop", null, { online }).post.id;
    drain("be");
    drain("sim");
    expect(post(db, "be", "announce", "be: ack", root).wake).toEqual(["alex"]);
    expect(post(db, "sim", "announce", "sim: ack", root).wake).toEqual(["alex"]);
    expect(post(db, "alex", "announce", "thanks", root).wake.sort()).toEqual(["be", "sim"]);
  });

  test("a TTL keeps an announcement in new sessions' instructions until it expires", () => {
    expect(() => post(db, "be", "e2e", "x", null, { ttl_ms: 60_000 })).toThrow(/TTL/);
    post(db, "alex", "announce", "instant", null, { online });
    const kept = post(db, "alex", "announce", "merge freeze until noon", null, { online, ttl_ms: 60_000 }).post;
    expect(activeAnnouncements(db).map((p) => p.id)).toEqual([kept.id]);
    expect(announcementsInstruction(activeAnnouncements(db))[0]).toContain("merge freeze until noon");
    expect(activeAnnouncements(db, kept.expires_at! + 1)).toEqual([]);
    expect(announcementsInstruction([])).toEqual([]);
  });

  test("a mode without an announce board treats the name as an ordinary board", () => {
    setAccess(db, { ...openAccess(db), announceBoard: null });
    expect(post(db, "be", "announce", "just a board").wake).toEqual(["fe"]);
  });
});

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
  const first = drain("sim", true);
  expect(first).toHaveLength(1);
  expect(first[0]).toMatchObject({ kind: "digest", unread: 2 });

  post(db, "be", "e2e", "three");
  expect(drain("sim", true)).toEqual([]); // suppressed: not caught up yet

  const r = read(db, "sim", "e2e");
  expect(r.posts.map((p) => p.body)).toEqual(["one", "two", "three"]);
  expect(r.unread_remaining).toBe(0);

  post(db, "be", "e2e", "four");
  expect(drain("sim", true)).toMatchObject([{ kind: "digest", unread: 1 }]); // re-armed
});

test("posting does not mark others' unread posts as read", () => {
  subscribe(db, "sim", "e2e", "digest");
  post(db, "be", "e2e", "one");
  post(db, "be", "e2e", "two");
  post(db, "sim", "e2e", "reply without reading");
  expect(listBoards(db, "sim")[0]!.unread).toBe(2);
  expect(drain("sim", true)).toMatchObject([{ kind: "digest", unread: 2 }]);
  expect(read(db, "sim", "e2e").posts.map((p) => p.body)).toEqual(["one", "two"]);
});

test("a mention doesn't also count toward the mentioned subscriber's digest", () => {
  subscribe(db, "sim", "e2e", "digest");
  post(db, "be", "e2e", "@sim look at this");
  expect(drain("sim")).toMatchObject([{ kind: "push", reason: "mention" }]);
  expect(listBoards(db, "sim")[0]!.unread).toBe(0);
  post(db, "be", "e2e", "unrelated");
  expect(drain("sim", true)).toMatchObject([{ kind: "digest", unread: 1, latest: { body: "unrelated" } }]);
  expect(read(db, "sim", "e2e").posts.map((p) => p.body)).toEqual(["unrelated"]);
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

test("a reply wakes the post's author and the thread's starter; other participants wait", () => {
  const root = post(db, "sim", "e2e", "question").post;
  const mid = post(db, "fe", "e2e", "me too", root.id).post;
  subscribe(db, "be", "e2e", "off"); // be created the board, so it's push-subscribed
  post(db, "be", "e2e", "noted", mid.id);
  drain("be");
  drain("sim");
  drain("fe");
  const reply = post(db, "sim", "e2e", "answer", mid.id);
  expect(reply.wake).toEqual(["fe"]);
  expect(reply.deferred).toEqual(["be"]);
  expect(drain("fe")).toMatchObject([{ kind: "push", reason: "thread" }]);
  // The deferred push never wakes be alone, but rides along with one that does.
  expect(drain("be")).toEqual([]);
  post(db, "fe", "e2e", "@be ping");
  const items = drain("be");
  expect(items.map((i) => i.kind === "push" && [i.post.body, i.deferred ?? false])).toEqual([
    ["answer", true],
    ["@be ping", false],
  ]);
  expect(drain("be")).toEqual([]);
  expect(read(db, "fe", "e2e", { thread: reply.post.id }).posts).toHaveLength(4);
});

test("a deferred push shows as unread, and reading the board delivers it", () => {
  const root = post(db, "sim", "e2e", "question").post;
  const mid = post(db, "fe", "e2e", "me too", root.id).post;
  subscribe(db, "be", "e2e", "quiet"); // from push: be created the board
  post(db, "be", "e2e", "noted", root.id);
  drain("sim");
  drain("fe");
  expect(post(db, "fe", "e2e", "answer", mid.id).deferred).toEqual(["be"]);
  expect(listBoards(db, "be")[0]!.unread).toBe(1);
  expect(read(db, "be", "e2e").posts.map((p) => p.body)).toEqual(["answer"]);
  // Delivered by the read; the earlier pushes (be was push-subscribed) it didn't show still come.
  expect(drain("be", true).map((i) => i.kind === "push" && i.post.body)).toEqual(["question", "me too"]);
});

test("digest subscribers aren't woken; the notice rides with the next wake", () => {
  subscribe(db, "sim", "e2e", "digest");
  expect(post(db, "be", "e2e", "one").wake).not.toContain("sim");
  expect(drain("sim")).toEqual([]);
  post(db, "be", "e2e", "@sim look");
  expect(drain("sim").map((i) => i.kind)).toEqual(["push", "digest"]);
});

test("your user's reply in a thread wakes every participant", () => {
  declareHuman(db, "alex");
  const root = post(db, "sim", "e2e", "question").post;
  const mid = post(db, "fe", "e2e", "me too", root.id).post;
  post(db, "be", "e2e", "same", mid.id);
  expect(post(db, "alex", "e2e", "decision: ship it", mid.id).wake.sort()).toEqual(["be", "fe", "sim"]);
});

test("a muted thread stops pushing replies, but @mentions still land", () => {
  const root = post(db, "sim", "e2e", "question").post;
  const mine = post(db, "fe", "e2e", "one-off flag", root.id).post;
  subscribe(db, "sim", "e2e", "push");
  drain("be");
  drain("sim");
  // Any post in the thread names it; be is the board's push-mode creator.
  for (const h of ["fe", "be"]) callBoardTool(db, h, "board_subscribe", { board: "e2e", mode: "off", thread: mine.id });
  expect(post(db, "sim", "e2e", "routine", mine.id).wake).toEqual([]);
  expect(drain("fe")).toEqual([]);
  expect(post(db, "sim", "e2e", "@fe one for you", root.id).wake).toEqual(["fe"]);
  expect(drain("fe")).toMatchObject([{ kind: "push", reason: "mention" }]);
  // Posting again doesn't unmute; mode push does.
  post(db, "fe", "e2e", "still here", root.id);
  expect(post(db, "sim", "e2e", "routine 2", root.id).wake).toEqual([]);
  callBoardTool(db, "fe", "board_subscribe", { board: "e2e", mode: "push", thread: root.id });
  expect(post(db, "sim", "e2e", "routine 3", root.id).deferred).toEqual(["fe"]);
  // The board's own mode is untouched, and other threads still push.
  expect(listBoards(db, "be").find((b) => b.name === "e2e")?.mode).toBe("push");
  expect(post(db, "sim", "e2e", "new topic").wake).toEqual(["be"]);
});

test("a thread mute rejects digest/quiet and posts on other boards", () => {
  createBoard(db, "be", "other", "Elsewhere");
  const p = post(db, "be", "other", "x").post;
  expect(() => callBoardTool(db, "fe", "board_subscribe", { board: "e2e", mode: "quiet", thread: p.id })).toThrow(/"off".*"push"/);
  expect(() => callBoardTool(db, "fe", "board_subscribe", { board: "e2e", mode: "off", thread: p.id })).toThrow(/not a post on #e2e/);
});

test("reading delivers only the pushes it returns", () => {
  subscribe(db, "fe", "e2e", "digest");
  post(db, "be", "e2e", "one");
  const mention = post(db, "be", "e2e", "@fe look").post;
  const root = post(db, "sim", "e2e", "question").post;
  post(db, "be", "e2e", "two");
  // The unread read skips the pending mention; it must still push.
  expect(read(db, "fe", "e2e").posts.map((p) => p.body)).toEqual(["one", "question", "two"]);
  expect(pendingFor(db, "fe").map((i) => i.kind === "push" && i.post.id)).toEqual([mention.id]);
  // Reading another thread doesn't deliver it either.
  read(db, "fe", "e2e", { thread: root.id });
  expect(pendingFor(db, "fe").map((i) => i.kind === "push" && i.post.id)).toEqual([mention.id]);
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

test("claim_events keeps each claim's history after the row is gone", () => {
  claim(db, "be", "ticket:ENG-142", { note: "signature work", board: "e2e" });
  claim(db, "sim", "ticket:ENG-142", { note: "me too" });
  claim(db, "be", "ticket:ENG-142", { note: "step 2" });
  release(db, "be", "ticket:ENG-142", "merged");
  claim(db, "fe", "dev:env");
  db.prepare(`UPDATE claims SET expires_at = 1`).run();
  sweepExpired(db);

  const rows = db.prepare(`SELECT key, handle, event, note, board, held_by FROM claim_events ORDER BY id`).all();
  expect(rows).toEqual([
    { key: "ticket:ENG-142", handle: "be", event: "take", note: "signature work", board: "e2e", held_by: null },
    { key: "ticket:ENG-142", handle: "sim", event: "refused", note: "me too", board: null, held_by: "be" },
    { key: "ticket:ENG-142", handle: "be", event: "renew", note: "step 2", board: "e2e", held_by: null },
    { key: "ticket:ENG-142", handle: "be", event: "release", note: "merged", board: "e2e", held_by: null },
    { key: "dev:env", handle: "fe", event: "take", note: null, board: null, held_by: null },
    { key: "dev:env", handle: "fe", event: "expire", note: null, board: null, held_by: null },
  ]);
  expect(listClaims(db)).toEqual([]);
});

test("claims take a stop time or a multi-day ttl, but not both", () => {
  const until = new Date(Date.now() + 36 * 3600_000).toISOString();
  const a = claim(db, "be", "soak:24h", { until });
  expect(a.ok && a.claim.expires_at).toBe(Date.parse(until));
  const b = claim(db, "be", "soak:3d", { ttl_minutes: 3 * 24 * 60 });
  expect(b.ok && b.claim.expires_at - Date.now()).toBeGreaterThan(71 * 3600_000);

  expect(() => claim(db, "be", "x", { ttl_minutes: 60, until })).toThrow(/not both/);
  expect(() => claim(db, "be", "x", { until: "tomorrow-ish" })).toThrow(/ISO 8601/);
  expect(() => claim(db, "be", "x", { until: new Date(Date.now() - 1000).toISOString() })).toThrow(/future/);
  expect(() => claim(db, "be", "x", { ttl_minutes: 8 * 24 * 60 })).toThrow(/ttl_minutes/);
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

test("a lapsed claim is announced on its board once, by the first sweep or takeover", () => {
  subscribe(db, "sim", "e2e", "push");
  claim(db, "be", "dev:freeze", { board: "e2e" });
  claim(db, "be", "quiet:one");
  db.prepare(`UPDATE claims SET expires_at = 1`).run();
  expect(sweepExpired(db).wake).toEqual(["sim"]);
  expect(sweepExpired(db).wake).toEqual([]);
  expect(listClaims(db)).toEqual([]);
  const bodies = () => read(db, "sim", "e2e", { before_id: 999 }).posts.map((p) => p.body);
  expect(bodies().at(-1)).toBe("[expired] dev:freeze: not released by be; check with them before relying on it");

  claim(db, "be", "dev:freeze", { board: "e2e" });
  db.prepare(`UPDATE claims SET expires_at = 1`).run();
  const taken = claim(db, "fe", "dev:freeze");
  expect(taken.ok && taken.wake).toContain("sim");
  expect(bodies().slice(-1)).toEqual(["[expired] dev:freeze: not released by be; check with them before relying on it"]);
});

test("a claim's watchers are mentioned on its release or expiry, in any mode, once", () => {
  subscribe(db, "sim", "e2e", "quiet"); // fe has no subscription at all
  claim(db, "be", "dev:env", { board: "e2e" });
  drain("sim");
  expect(watch(db, "sim", "dev:env")).toMatch(/watching dev:env/);
  watch(db, "fe", "dev:env");
  expect(() => watch(db, "be", "dev:env")).toThrow(/you hold/);
  expect(() => watch(db, "sim", "nope")).toThrow(/no active claim/);
  claim(db, "be", "boardless");
  expect(() => watch(db, "sim", "boardless")).toThrow(/renew it with board=/);

  expect(release(db, "be", "dev:env", "done, reset complete").wake.sort()).toEqual(["fe", "sim"]);
  expect(drain("sim")).toMatchObject([{ kind: "push", reason: "mention", post: { body: "[release] dev:env — done, reset complete cc @sim @fe" } }]);
  expect(drain("fe")).toMatchObject([{ kind: "push", reason: "mention" }]);

  // Watches end with the claim; a later one on the key starts without them.
  claim(db, "be", "dev:env", { board: "e2e" });
  release(db, "be", "dev:env");
  expect(drain("sim")).toEqual([]);

  claim(db, "be", "dev:env", { board: "e2e" });
  watch(db, "sim", "dev:env");
  watch(db, "fe", "dev:env");
  watch(db, "fe", "dev:env", true);
  db.prepare(`UPDATE claims SET expires_at = 1`).run();
  expect(sweepExpired(db).wake).toEqual(["sim"]);
  expect(drain("sim")[0]).toMatchObject({ reason: "mention", post: { body: expect.stringMatching(/^\[expired\] dev:env: .* cc @sim$/) } });
  expect(db.prepare(`SELECT COUNT(*) AS n FROM claim_watches`).get()).toEqual({ n: 0 });
});

test("a renewal keeps a long claim's expiry and pushes a changed note to watchers", () => {
  subscribe(db, "sim", "e2e", "quiet"); // fe has no subscription at all
  const until = new Date(Date.now() + 3 * 24 * 3600_000).toISOString();
  claim(db, "be", "rollout", { until, note: "step 1", board: "e2e" });
  watch(db, "fe", "rollout");
  drain("sim");

  const r = claim(db, "be", "rollout", { note: "step 2: canary up" });
  expect(r.ok && r.claim.expires_at).toBe(Date.parse(until));
  expect(r.wake).toEqual(["fe"]);
  expect(drain("fe")).toMatchObject([{ reason: "mention", post: { body: "[update] rollout — step 2: canary up cc @fe" } }]);
  expect(drain("sim")).toEqual([]);

  // The same note again is a plain renewal: silent. Watchers stay for the end.
  expect(claim(db, "be", "rollout", { note: "step 2: canary up" }).wake).toEqual([]);
  expect(release(db, "be", "rollout").wake).toContain("fe");

  // An explicit ttl still sets the expiry, shorter or not.
  claim(db, "be", "short", { until });
  const s = claim(db, "be", "short", { ttl_minutes: 10 });
  expect(s.ok && s.claim.expires_at - Date.now()).toBeLessThan(11 * 60_000);
});

test("the expiry timer fires at the next lapse without anyone asking", async () => {
  subscribe(db, "sim", "e2e", "push");
  const woken: string[][] = [];
  const timer = claimExpiryTimer(db, (h) => woken.push(h));
  claim(db, "be", "soon", { board: "e2e", ttl_minutes: 0.001 });
  timer.arm();
  await Bun.sleep(150);
  timer.stop();
  expect(woken).toEqual([["sim"]]);
  expect(listClaims(db)).toEqual([]);
});

test("the session-start claims list puts the session's own first and stays bounded", () => {
  const at = Date.parse("2026-10-21T21:00:00Z");
  const c = (key: string, holder: string, note: string | null = null) =>
    ({ key, holder, note, board: null, acquired_at: 0, expires_at: at });
  expect(claimsInstruction([], "be")).toEqual([]);

  const [few] = claimsInstruction([c("a", "fe", "theirs"), c("b", "be", "mine")], "be");
  expect(few).toBe(
    "Active claims when this session started. Yours: b (until 2026-10-21T21:00Z: mine). Others': a. Respect them; claim_list shows holders and the current state.",
  );

  // Worst case: long notes on the session's own, and far too many others.
  const many = [
    ...Array.from({ length: 50 }, (_, i) => c(`ticket:ENG-${1000 + i}`, "be-throughput")),
    ...Array.from({ length: 3 }, (_, i) => c(`ticket:ENG-${i}`, "be", "x".repeat(400))),
  ];
  const [big] = claimsInstruction(many, "be");
  expect(big!.length).toBeLessThan(1400);
  expect(big).not.toContain("be-throughput");
  expect(big).toStartWith("Active claims when this session started. Yours: ticket:ENG-0 ");
  expect(big).toContain(`(until 2026-10-21T21:00Z: ${"x".repeat(150)}…)`);
  expect(big).toContain("Others': ticket:ENG-1000, ticket:ENG-1001,");
  expect(big).toMatch(/ \d+ more\. Respect them/);
  const listed = (big!.match(/ticket:ENG-\d+/g) ?? []).length;
  expect(Number(big!.match(/(\d+) more/)![1]) + listed).toBe(53);
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

test("mention tokens cover bare, local/name, and full addresses, not emails", () => {
  expect(mentionTokens("@be and @wade/sim, cc @a.b@example.com/fe. mail x@y.com @end.")).toEqual([
    "be",
    "wade/sim",
    "a.b@example.com/fe",
    "end",
  ]);
});

test("mentions inside inline code or fenced blocks don't count", () => {
  expect(mentionTokens("see `@be` and `` `@fe` `` but ping @sim\n```\n@ghost\n```")).toEqual(["sim"]);
});

test("unresolved mentions are reported to the poster", () => {
  const r = post(db, "be", "e2e", "@fe and @ghost");
  expect(r.wake).toEqual(["fe"]);
  expect(r.unresolved).toEqual(["ghost"]);
});

test("local mode refuses scoped boards", () => {
  expect(() => createBoard(db, "be", "secret", "x", "team:eng")).toThrow(/distributed/);
});

test("prune keeps replies whose parent is pruned, and clears the outbox", () => {
  const root = post(db, "sim", "e2e", "old root").post;
  db.prepare(`UPDATE posts SET created_at = 0 WHERE id = ?`).run(root.id);
  const reply = post(db, "fe", "e2e", "@be newer reply", root.id).post;
  prunePosts(db, 1);
  expect(pendingFor(db, "be").map((i) => i.kind === "push" && i.post.id)).toEqual([reply.id]);
  expect(read(db, "be", "e2e", { before_id: 999 }).posts.map((p) => p.id)).toEqual([reply.id]);
});

test("prune drops claim history older than the cutoff", () => {
  claim(db, "be", "old");
  db.prepare(`UPDATE claim_events SET at = 0`).run();
  claim(db, "be", "new");
  prunePosts(db, 1);
  expect(db.prepare(`SELECT key FROM claim_events`).all()).toEqual([{ key: "new" }]);
});

// ── access policy (the distributed server installs one like this) ────────────

describe("who", () => {
  const online = (h: string) => h === "sim";

  test("lists online handles; offline ones are counted, or listed on request", () => {
    expect(who(db, "be", {}, online)).toEqual({
      you: "be",
      peers: [
        { handle: "be", online: true, last_seen: expect.any(Number), self: true },
        { handle: "sim", online: true, last_seen: expect.any(Number) },
      ],
      offline_hidden: 1,
    });
    const all = who(db, "be", { include_offline: true }, online);
    expect(all.peers.map((p) => [p.handle, p.online])).toEqual([["be", true], ["fe", false], ["sim", true]]);
    expect(all.offline_hidden).toBeUndefined();
  });

  test("a session's harness capability is surfaced and cleared on restart (#245)", () => {
    setCapability(db, "sim", "pi", "native");
    const withCap = who(db, "be", {}, online).peers.find((p) => p.handle === "sim");
    expect(withCap).toMatchObject({ harness: "pi", comms: "native" });
    // A peer with no reported capability shows none (the field is absent).
    const be = who(db, "sim", { include_offline: true }, online).peers.find((p) => p.handle === "be");
    expect("harness" in be!).toBe(false);
    expect("comms" in be!).toBe(false);
    // The facts describe the live session: a session start clears them.
    startSession(db, "sim", null);
    const after = who(db, "be", {}, online).peers.find((p) => p.handle === "sim");
    expect("harness" in after!).toBe(false);
    expect("comms" in after!).toBe(false);
  });

  test("board scope: subscribers with their mode", () => {
    subscribe(db, "fe", "e2e", "quiet");
    expect(who(db, "sim", { board: "#e2e", include_offline: true }, online).peers).toEqual([
      { handle: "be", online: false, last_seen: expect.any(Number), mode: "push" },
      { handle: "fe", online: false, last_seen: expect.any(Number), mode: "quiet" },
    ]);
    expect(() => who(db, "be", { board: "nope" }, online)).toThrow(/no such board/);
  });

  test("tail viewers (~ handles) aren't peers", () => {
    subscribe(db, "~tail-1", "e2e", "push");
    db.prepare(`INSERT INTO handles (name, first_seen, last_seen) VALUES ('~tail-1', 0, 0)`).run();
    const any = () => true;
    expect(who(db, "be", { board: "e2e" }, any).peers.map((p) => p.handle)).toEqual(["be"]);
    expect(who(db, "be", {}, any).peers.map((p) => p.handle)).toEqual(["be", "fe", "sim"]);
  });

  test("a post wakes tail viewers but doesn't report them as notified", () => {
    subscribe(db, "~tail-1", "e2e", "push");
    const out = callBoardTool(db, "fe", "board_post", { board: "e2e", body: "hi" });
    expect(out.wake).toContain("~tail-1");
    expect((out.result as { notified: string[] }).notified).not.toContain("~tail-1");
  });

  test("the tool needs the mode's liveness check", () => {
    expect(() => callBoardTool(db, "be", "peer_list", {})).toThrow(/isn't available/);
    expect(callBoardTool(db, "be", "peer_list", { include_offline: true }, { online }).result).toMatchObject({ you: "be" });
    expect(() => callBoardTool(db, "be", "peer_list", { include_offline: "yes" }, { online })).toThrow(/boolean/);
  });
});

describe("with a scoped access policy", () => {
  const members = new Set(["be", "sim"]); // members of team:eng; fe is not
  const policy: Access = {
    canSee: (h, b) => b.scope === null || members.has(h),
    checkCreate: (h, scope) => (scope === null || members.has(h) ? null : "not a member"),
    resolveMention: (t) => (["be", "sim", "fe"].includes(t) ? t : null),
    announceBoard: null,
  };
  beforeEach(() => {
    setAccess(db, policy);
    createBoard(db, "be", "eng", "Team eng", "team:eng");
  });

  test("non-members can't see, read, post, or subscribe", () => {
    expect(listBoards(db, "fe").map((b) => b.name)).toEqual(["e2e"]);
    expect(listBoards(db, "sim").map((b) => b.name)).toEqual(["e2e", "eng"]);
    expect(() => read(db, "fe", "eng")).toThrow(/no such board/);
    expect(() => post(db, "fe", "eng", "hi")).toThrow(/no such board/);
    expect(() => subscribe(db, "fe", "eng", "push")).toThrow(/no such board/);
    expect(() => createBoard(db, "fe", "eng2", "x", "team:eng")).toThrow(/not a member/);
  });

  test("mentioning a non-member doesn't leak the post", () => {
    const r = post(db, "be", "eng", "@fe @sim secret plan");
    expect(r.wake).toEqual(["sim"]);
    expect(r.unresolved).toEqual(["fe"]);
    expect(pendingFor(db, "fe")).toEqual([]);
  });

  test("losing access drops queued pushes and digests", () => {
    subscribe(db, "sim", "eng", "digest");
    post(db, "be", "eng", "@sim one");
    post(db, "be", "eng", "two");
    members.delete("sim");
    try {
      expect(pendingFor(db, "sim")).toEqual([]);
      members.add("sim");
      // The push was acknowledged while hidden; only the digest remains.
      expect(pendingFor(db, "sim", { all: true }).map((i) => i.kind)).toEqual(["digest"]);
    } finally {
      members.add("sim");
    }
  });

  test("who on a team board: non-members can't see it, members don't see outsiders", () => {
    subscribe(db, "sim", "eng", "digest");
    expect(() => who(db, "fe", { board: "eng" }, () => true)).toThrow(/no such board/);
    members.delete("sim");
    try {
      expect(who(db, "be", { board: "eng" }, () => true).peers.map((p) => p.handle)).toEqual(["be"]);
    } finally {
      members.add("sim");
    }
  });

  test("claims hide a board the viewer can't see", () => {
    claim(db, "be", "ticket:ENG-1", { board: "eng" });
    expect(listClaims(db, "ticket:", "fe")[0]!.board).toBeNull();
    expect(listClaims(db, "ticket:", "sim")[0]!.board).toBe("eng");
    expect(() => claim(db, "fe", "ticket:ENG-2", { board: "eng" })).toThrow(/no such board/);
  });
});

test("acknowledge by ref matches markDelivered", () => {
  subscribe(db, "sim", "e2e", "digest");
  post(db, "be", "e2e", "@sim hello");
  post(db, "be", "e2e", "and something else");
  const items = pendingFor(db, "sim");
  expect(items.map((i) => i.kind).sort()).toEqual(["digest", "push"]);
  for (const i of items) acknowledge(db, "sim", JSON.parse(JSON.stringify(refOf(i))));
  expect(pendingFor(db, "sim")).toEqual([]);
  expect(getBoard(db, "e2e")!.scope).toBeNull();
});

test("board_create exposes kind, and a queue board created through the tool routes posts", () => {
  // The feature is unreachable unless the tool surface carries kind (#192
  // review): a queue board only a unit test can create lands nothing.
  const b = callBoardTool(db, "be", "board_create", { name: "lanes", purpose: "work rotation", kind: "queue" })
    .result as { kind: string };
  expect(b.kind).toBe("queue");
  expect(getBoard(db, "lanes")!.kind).toBe("queue");
  callBoardTool(db, "sim", "board_subscribe", { board: "lanes", mode: "push" });
  const r = callBoardTool(db, "be", "board_post", { board: "lanes", body: "item" }).result as { notified: string[] };
  expect(r.notified).toEqual(["sim"]);
  // An unknown kind is refused, and the default stays broadcast.
  expect(() => callBoardTool(db, "be", "board_create", { name: "bad", purpose: "x", kind: "fifo" })).toThrow(/kind/);
  callBoardTool(db, "be", "board_create", { name: "plain", purpose: "default kind" });
  expect(getBoard(db, "plain")!.kind).toBe("broadcast");
});

test("peer_status queue param is the explicit rotation opt-out; status text never is", () => {
  callBoardTool(db, "be", "board_create", { name: "lanes", purpose: "work rotation", kind: "queue" });
  callBoardTool(db, "sim", "board_subscribe", { board: "lanes", mode: "push" });
  callBoardTool(db, "fe", "board_subscribe", { board: "lanes", mode: "push" });
  callBoardTool(db, "fe", "peer_status", { text: "heads-down", queue: "off" });
  expect(who(db, "be", {}, () => true).peers.find((p) => p.handle === "fe")?.queue_off).toBe(true);
  const r = callBoardTool(db, "be", "board_post", { board: "lanes", body: "item" }).result as { notified: string[] };
  expect(r.notified).toEqual(["sim"]);
  callBoardTool(db, "fe", "peer_status", { text: "", queue: "on" });
  expect(who(db, "be", {}, () => true).peers.find((p) => p.handle === "fe")?.queue_off).toBeUndefined();
  expect(() => callBoardTool(db, "fe", "peer_status", { text: "", queue: "busy" })).toThrow(/queue/);
});
