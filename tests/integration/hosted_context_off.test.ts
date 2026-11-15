// Security audit F-03 (#854): a host without context-only admission (Claude
// Code) starts a turn for every item its lease gives it, so a lease opened with
// `context: false` withholds non-waking items (another user's ungranted DM,
// a deferred thread push, a digest) until a waking one arrives to carry them,
// except on the lease's first pull, which drains the backlog as local mode's
// first drain does. Withheld items stay unreceipted, so nothing is lost.
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { DeliveryEvent } from "../../src/server/application.ts";
import { board, direct } from "../support/events.ts";
import { TestServer } from "../support/server.ts";

const A = "alice@example.com";
const B = "bob@example.com";
let srv: TestServer;

beforeEach(async () => {
  // Inbox polling spends hosted requests.
  srv = new TestServer({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 } });
  await srv.login(A);
  await srv.login(B);
});
afterEach(() => srv.stop());

const dm = (body: string) => direct((m) => m.body === body);
const any = (_: DeliveryEvent) => true;
const ids = (items: { id: string }[]) => items.map((i) => i.id);

test("a lone ungranted DM waits; a waking DM carries it, both in order", async () => {
  const abe = await srv.hosted(A, "be", { context: false });
  // The lease's first pull is done: what follows is withheld unless it wakes.
  await abe.none(any);
  const bfe = await srv.hosted(B, "fe");
  await bfe.call("dm_send", { to: `${A}/be`, body: "from bob" });
  await abe.none(dm("from bob"), 300);
  const aqa = await srv.hosted(A, "qa");
  await aqa.call("dm_send", { to: "be", body: "from alice" });
  const fromBob = await abe.next(dm("from bob"));
  expect(fromBob.actionable).toBe(false);
  const fromAlice = await abe.next(dm("from alice"));
  expect(fromAlice.actionable).toBe(true);
});

test("without context: false the same lone ungranted DM is delivered (the default lease)", async () => {
  const abe = await srv.hosted(A, "be");
  await abe.none(any);
  const bfe = await srv.hosted(B, "fe");
  await bfe.call("dm_send", { to: `${A}/be`, body: "from bob" });
  expect((await abe.next(dm("from bob"))).actionable).toBe(false);
});

test("a lone digest and a lone deferred thread push wait; a waking DM carries them", async () => {
  const abe = await srv.hosted(A, "be", { context: false });
  await abe.call("board_create", { name: "e2e", purpose: "fixtures" });
  await abe.call("board_create", { name: "news", purpose: "digest" });
  await abe.call("board_subscribe", { board: "news", mode: "digest" });
  await abe.call("board_subscribe", { board: "e2e", mode: "quiet" });
  await abe.none(any);
  const aqa = await srv.hosted(A, "qa");
  const afe = await srv.hosted(A, "fe");
  // qa starts a thread, be replies in it, fe replies: qa is woken, be's copy is deferred.
  const root = await aqa.call<{ post_id: number }>("board_post", { board: "e2e", body: "topic" });
  await abe.call("board_post", { board: "e2e", body: "be's take", parent_id: root.post_id });
  const later = await afe.call<{ deferred?: string[] }>("board_post", { board: "e2e", body: "fe's take", parent_id: root.post_id });
  expect(later.deferred).toContain(`${A}/be`);
  await afe.call("board_post", { board: "news", body: "headline" });
  await abe.none(any, 300);
  await aqa.call("dm_send", { to: "be", body: "wake up" });
  const deferred = await abe.next(board((i) => i.kind === "push" && i.post.body === "fe's take"));
  expect(deferred.actionable).toBe(false);
  const digest = await abe.next(board((i) => i.kind === "digest" && i.board === "news"));
  expect(digest.actionable).toBe(false);
  expect((await abe.next(dm("wake up"))).actionable).toBe(true);
});

test("the lease's first pull drains a non-waking backlog; a new lease drains again", async () => {
  const first = await srv.hosted(A, "be", { context: false });
  await first.close();
  const bfe = await srv.hosted(B, "fe");
  await bfe.call("dm_send", { to: `${A}/be`, body: "while away" });
  const second = await srv.hosted(A, "be", { context: false });
  expect((await second.next(dm("while away"))).actionable).toBe(false);
  await bfe.call("dm_send", { to: `${A}/be`, body: "after the drain" });
  await second.none(dm("after the drain"), 300);
  // Unreceipted, so the next lease's first pull has it.
  await second.close();
  const third = await srv.hosted(A, "be", { context: false });
  expect((await third.next(dm("after the drain"))).actionable).toBe(false);
});

test("a lease replaced within one ownership (a bind) doesn't drain withheld items again", async () => {
  const abe = await srv.hosted(A, "be", { context: false });
  await abe.none(any);
  const bfe = await srv.hosted(B, "fe");
  await bfe.call("dm_send", { to: `${A}/be`, body: "from bob" });
  await abe.none(dm("from bob"), 300);
  // The bind bumps bind_gen: the lease closes and a new one opens under the same ownership.
  await abe.bind("qa");
  await abe.none(dm("from bob"), 300);
  const own = await srv.hosted(A, "fe");
  await own.call("dm_send", { to: "be", body: "wake" });
  expect((await abe.next(dm("from bob"))).actionable).toBe(false);
});

test("a team alias revoked by another user doesn't replay withheld items as a drain", async () => {
  expect((await srv.api(await srv.login(B), "POST", "/api/teams", { name: "eng" })).status).toBe(201);
  expect((await srv.api(await srv.login(B), "POST", "/api/teams/eng/add", { email: A })).status).toBe(200);
  const abe = await srv.hosted(A, "be", { context: false });
  await abe.bind("eng/x");
  await abe.none(any);
  const bfe = await srv.hosted(B, "fe");
  await bfe.call("dm_send", { to: `${A}/be`, body: "before revoke" });
  await abe.none(dm("before revoke"), 300);
  // Bob's removal revokes eng/x: bind_gen moves and the lease closes; the session opens a new one.
  expect((await srv.api(await srv.login(B), "POST", "/api/teams/eng/remove", { email: A })).status).toBe(200);
  await abe.bind("be");
  await abe.none(dm("before revoke"), 300);
});

test("the first drain ends at its receipt: an unreceipted first pull is offered again", async () => {
  const first = await srv.hosted(A, "be", { context: false });
  await first.close();
  const bfe = await srv.hosted(B, "fe");
  await bfe.call("dm_send", { to: `${A}/be`, body: "backlog" });
  const abe = await srv.hosted(A, "be", { context: false, receipt: "manual" });
  const offered = await abe.inbox();
  expect(ids(offered)).toHaveLength(1);
  // Lost before admission: the next pull offers it again.
  expect(ids(await abe.inbox())).toEqual(ids(offered));
  await abe.receipt(ids(offered));
  await bfe.call("dm_send", { to: `${A}/be`, body: "after receipt" });
  expect(await abe.inbox()).toEqual([]);
});

test("a withheld item stays unreceipted: the direct cursor doesn't move", async () => {
  const abe = await srv.hosted(A, "be", { context: false, receipt: "manual" });
  expect(await abe.inbox()).toEqual([]);
  const bfe = await srv.hosted(B, "fe");
  await bfe.call("dm_send", { to: `${A}/be`, body: "held" });
  expect(await abe.inbox()).toEqual([]);
  expect(srv.app.repo.cursors.directFor(`${A}/be`)).toBe(0);
});

test("a full page with none waking goes out: holding it back would starve the item behind it", async () => {
  const abe = await srv.hosted(A, "be", { context: false, receipt: "manual" });
  expect(await abe.inbox()).toEqual([]);
  const bfe = await srv.hosted(B, "fe");
  for (let i = 0; i < 99; i++) await bfe.call("dm_send", { to: `${A}/be`, body: `spam ${i}` });
  expect(await abe.inbox()).toEqual([]);
  await bfe.call("dm_send", { to: `${A}/be`, body: "spam 99" });
  const page = await abe.inbox();
  expect(page).toHaveLength(100);
  expect(page.every((i) => !i.actionable)).toBe(true);
  expect(ids(page)[0]).toMatch(/^direct:/);
});

test("the server's delivery_open lists the context argument (the plugin's feature check)", async () => {
  const abe = await srv.hosted(A, "be");
  expect(await abe.subscriber.takes("delivery_open", "context")).toBe(true);
  expect(await abe.subscriber.takes("delivery_open", "nonesuch")).toBe(false);
  expect(await abe.subscriber.takes("nonesuch", "context")).toBe(false);
});
