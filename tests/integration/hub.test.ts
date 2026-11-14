// The hub (src/server/application.ts) as a hosted session drives it, at
// application level with no socket (#282): holds, revocation closing sessions,
// a reconnect on the session's key, bind notices, tools-only writes_as, and a
// session's ID as an address it reads as. The WSS transport is gone: the
// grace, the probe and supersede of a hello, a hello's token checks, the
// logout close and `end` went with it. Moved from ws.test.ts; tool, board and
// DM semantics are in hosted_tools.test.ts, routes in http_routes.test.ts.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReadResult, WhoResult } from "../../src/core/boards.ts";
import type { SendResult } from "../../src/server/application.ts";
import type { Config } from "../../src/server/config.ts";
import type { Pending } from "../../src/shared/notifications.ts";
import type { AppEvent, AppSession, AppSessionOptions } from "../support/app_session.ts";
import { board, direct } from "../support/events.ts";
import { TestServer } from "../support/server.ts";

const A = "alice@example.com";
const B = "bob@example.com";
const C = "carol@example.com";

// Each test's server; inbox polling spends hosted requests.
const start = (overrides: Partial<Config> = {}) =>
  new TestServer({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 }, ...overrides });
let srv: TestServer;

// A test that needs other config replaces the server.
const restart = async (overrides: Partial<Config> = {}) => {
  await srv.stop();
  srv = start(overrides);
};

// Databases a test restarts its server on, removed once the last server is down.
const dbDirs: string[] = [];
const fileDb = () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-hub-"));
  dbDirs.push(dir);
  return join(dir, "bus.db");
};

beforeEach(() => {
  srv = start();
});

afterEach(async () => {
  await srv.stop();
  for (const dir of dbDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const login = (email: string) => srv.login(email);
const api = (token: string, method: string, path: string, body?: unknown) => srv.api(token, method, path, body);


const closed = (e: AppEvent): e is Extract<AppEvent, { kind: "closed" }> => e.kind === "closed";
const postOf = (item: Pending) => {
  if (item.kind !== "push") throw new Error(`expected a push, got a ${item.kind}`);
  return item.post;
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);


// hosted twin: #451 (a reconnect on the session's key)
test("unacked board pushes are resent after reconnect; acked ones aren't", async () => {
  const alice = await login(A);
  await api(alice, "POST", "/api/teams", { name: "eng" });
  const a = await srv.hosted(A, "be");
  const s = await srv.connected(alice, "sim");

  await a.call("board_post", { board: "eng", body: "@sim ping" });
  const first = await s.next(board());
  s.close();

  // A reconnect is the same session: its key.
  const s2 = await srv.connected(alice, "sim", { key: s.key });
  const again = await s2.next(board());
  expect(postOf(again.item).id).toBe(postOf(first.item).id);
  await s2.boardAck([{ kind: "push", post_id: postOf(again.item).id }]);
  s2.close();

  const s3 = await srv.connected(alice, "sim", { key: s.key });
  await s3.none(board());
});

// A reconnect on the session's key is the same ID: its row, and so its place
// and status, stay; a session with a key of its own is a new ID and starts
// with neither. A session that gave up its name (unbind) frees it for one.
// hosted twin: #451 (a resume on the session's key)
test("peer_list shows where the session runs; a reconnect on its key keeps the status, a new session clears it", async () => {
  const alice = await login(A);
  // The watcher is alice's own: another user's peer_list shows neither (F-12).
  const watcher = await srv.hosted(A, "fe");
  const be = async () => (await watcher.call<WhoResult>("peer_list", { include_offline: true })).peers.find((p) => p.handle === `${A}/be`)!;

  const key = "c1".repeat(32);
  const first = await srv.connected(alice, "be", { key });
  srv.app.application.hostedPlace(first.id, "api worktree stream \n on stream");
  await first.call("peer_status", { text: "soaking" });
  expect(await be()).toMatchObject({ where: "api worktree stream on stream", status: "soaking" });

  first.close();
  const resumed = await srv.connected(alice, "be", { key });
  srv.app.application.hostedPlace(resumed.id, "api worktree stream on main");
  expect(await be()).toMatchObject({ where: "api worktree stream on main", status: "soaking" });

  await resumed.unbind("be");
  resumed.close();
  await srv.connected(alice, "be");
  const fresh = await be();
  expect(fresh.where).toBeUndefined();
  expect(fresh.status).toBeUndefined();
});

// hosted twin: #451 (a digest arrives with a reconnect on the key; board_ack)
test("team boards: digests coalesce until read; team: is not a DM recipient", async () => {
  const alice = await login(A);
  const carol = await login(C);
  await api(alice, "POST", "/api/teams", { name: "eng" });
  await api(alice, "POST", "/api/teams/eng/add", { email: C });
  const a = await srv.hosted(A, "be");
  const c = await srv.connected(carol, "sim");

  await expect(a.call("dm_send", { to: "team:eng", body: "standup in 5" })).rejects.toMatchObject({
    message: "team:eng isn't a person; to reach a team, board_post to its board #eng",
  });
  // A digest never wakes a session by itself; it arrives with the next hello.
  await a.call("board_post", { board: "eng", body: "standup in 5" });
  await c.none(board());
  c.close();
  const c2 = await srv.connected(carol, "sim", { key: c.key });
  const digest = await c2.next(board());
  expect(digest.item).toMatchObject({ kind: "digest", board: "eng", unread: 1 });

  await a.call("board_post", { board: "eng", body: "make that 10" });
  await c2.none(board()); // one digest until carol catches up

  if (digest.item.kind !== "digest") throw new Error(`expected a digest, got a ${digest.item.kind}`);
  await c2.boardAck([{ kind: "digest", board: "eng", latest_id: digest.item.latest.id }]);
  const r = await c2.call<ReadResult>("board_read", { board: "eng" });
  expect(r.posts.map((p) => p.body)).toEqual(["standup in 5", "make that 10"]);

  await login(B);
  const b = await srv.hosted(B, "fe");
  await expect(b.call("board_post", { board: "eng", body: "hi" })).rejects.toMatchObject({
    message: "no such board #eng; see board_list",
  });
});

test("revoking or disabling a user closes their open connections; a disable the routes missed is caught", async () => {
  await restart({ admins: ["root@example.com"] });
  const [root, alice] = await Promise.all([login("root@example.com"), login(A)]);
  const a = await srv.connected(alice, "be");

  // A closed session keeps its holds, so each round binds names of its own.
  let round = 0;
  for (const path of ["/api/admin/revoke-session", "/api/admin/disable-user"]) {
    round++;
    await api(root, "POST", "/api/admin/enable-user", { email: B });
    const bob = await login(B);
    const live = srv.appSession(bob, `be${round}`);
    const tools = srv.appSession(bob, `fe${round}`, { push: false });
    await Promise.all([live.connect(), tools.connect()]);
    expect((await api(root, "POST", path, { email: B })).status).toBe(200);
    expect(await live.next(closed)).toMatchObject({ code: "unauthenticated" });
    await tools.next(closed);
  }
  await a.call("board_list");

  // Disabled behind the server's back (no admin route): the next tick closes it.
  await api(root, "POST", "/api/admin/enable-user", { email: B });
  const late = await srv.connected(await login(B), "be3");
  srv.app.repo.users.setDisabled(srv.app.repo.users.findByEmail(B)!.id, true);
  srv.app.revalidate();
  await late.next(closed);
  await a.call("board_list");
});

test("an alias a live session holds refuses another session's bind", async () => {
  const alice = await login(A);
  const first = await srv.connected(alice, "be");
  const second = srv.appSession(alice, "be");
  await expect(second.connect()).rejects.toMatchObject({ code: "alias_held", extra: { holder: `the session ${first.id}` } });
  // The first connection still works.
  await first.call("board_list");
  // A closed session keeps its hold: nothing ends a session now, so the hold
  // stays until the session unbinds or the server's restart ends it.
  first.close();
  await expect(srv.appSession(alice, "be").connect()).rejects.toMatchObject({ code: "alias_held", extra: { holder: `the session ${first.id}` } });
});

// An AppSession: hosted bind and initialize carry no notices today. A bind's
// notices cover the session's whole address set; the first session's hold is
// released with unbind (a closed session keeps it), and claims stay with the
// alias for its next holder.
test("a bind's notices carry active claims and DMs undelivered after a day", async () => {
  const alice = await login(A);
  const bob = await login(B);
  const b = await srv.connected(bob, "fe");
  b.close();
  const a = srv.appSession(alice, "be");
  expect((await a.connect()).bind!.notices).toBeUndefined();
  await a.call("claim_take", { key: "ticket:ENG-2", note: "on it" });
  const old = await a.send(`${B}/fe`, "stale");
  await a.send(`${B}/fe`, "fresh");
  srv.app.db.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(Date.now() - 2 * 86_400_000, old.message_id);
  await a.unbind("be");
  a.close();

  const notices = (await srv.appSession(alice, "be").connect()).bind!.notices!;
  expect(notices).toHaveLength(2);
  expect(notices[0]).toContain(`${B}/fe: 1 since message_id ${old.message_id} (last seen`);
  expect(notices[1]).toMatch(/Yours: ticket:ENG-2 \(until \d{4}-\d\d-\d\dT\d\d:\d\dZ: on it\)\./);
  expect((await srv.appSession(alice, "sim").connect()).bind!.notices![0]).toContain("Others': ticket:ENG-2.");
});
// Audit W2 (#345): deleting an identity would drop its holds under a live
// holder, and a second session could then bind it: refused while in use. A
// session ends only by a restart now (a closed one keeps its hold), so the
// holder releases with unbind and the tools-only session by the restart.
test("an identity a session holds or writes as can't be deleted until those sessions end", async () => {
  const dbPath = fileDb();
  await restart({ dbPath: dbPath });
  let alice = await login(A);
  const a = await srv.connected(alice, "be");
  const sidecar = await srv.connected(alice, "be", { push: false });
  expect(await api(alice, "DELETE", "/api/identities/be")).toEqual({ status: 409, body: { code: "alias_held", message: expect.stringContaining("is in use by the session") } });
  await a.unbind("be");
  expect(await api(alice, "DELETE", "/api/identities/be")).toEqual({ status: 409, body: { code: "alias_held", message: expect.stringContaining(sidecar.id) } });
  await restart({ dbPath: dbPath });
  alice = await login(A);
  expect(await api(alice, "DELETE", "/api/identities/be")).toEqual({ status: 200, body: { ok: true } });
});

// hosted twin: #451 (tools-only writes_as)
test("a tools-only connection works beside the live owner without taking its pushes", async () => {
  const alice = await login(A);
  const owner = await srv.connected(alice, "be");
  const tools = await srv.connected(alice, "be", { push: false });
  const b = await srv.hosted(B, "fe");

  const sent = await b.call<SendResult>("dm_send", { to: `${A}/be`, body: "hi" });
  expect(sent.delivered_now).toBe(true);
  expect((await owner.next(direct())).message.body).toBe("hi");
  await b.call("board_create", { name: "e2e", purpose: "x" });
  await tools.call("board_list");
  await tools.none((e) => e.kind === "direct" || e.kind === "board");

  tools.close();
  const peers = (await b.call<WhoResult>("peer_list")).peers;
  expect(peers.find((p) => p.handle === `${A}/be`)?.online).toBe(true);
});

// Audits W1, W4 (#345): after a bind, the session still reads as its ID:
// it replies in a thread it received as the ID. Another user's session's ID
// never joins the set: bob acting as his own alias can't read the file DM'd
// to alice's ID. A session the server ended (here by a restart, the only
// thing that ends one now) is not acted as over HTTP, even by its own user
// (S11): `/api/claims/call` takes the check the `?as=` attachment routes
// took before they went (#475). An unbound session no longer acts as its ID
// at all (#229), so the session is bound from the start.
// hosted twin: #451 (a hosted session that reads as its ID)
test("a bound session replies to a thread it received as its ID; once ended, nothing acts as it", async () => {
  const dbPath = fileDb();
  await restart({ dbPath: dbPath });
  let alice = await login(A);
  const a = await srv.connected(alice, "be");
  const b = await srv.hosted(B, "fe");
  const up = await b.upload("shot.png", PNG);
  const sent = await b.call<SendResult>("dm_send", { to: a.id, body: "for your ID", attachment_ids: [up] });

  await a.send(`${B}/fe`, "got it", { parent_id: sent.message_id });
  const ops = await srv.hosted(B, "ops");
  expect((await ops.attachmentRaw("GET", `/${up}`)).status).toBe(404);
  const take = { tool: "claim_take", args: { key: "ticket:ENG-142" } };
  expect((await api(alice, "POST", "/api/claims/call", { as: a.id, ...take })).status).toBe(200);

  // The restart ends the session the WSS transport can no longer reattach.
  await restart({ dbPath: dbPath });
  alice = await login(A);
  const gone = await api(alice, "POST", "/api/claims/call", { as: a.id, ...take });
  expect(gone).toEqual({ status: 403, body: { code: "forbidden", message: expect.stringContaining(`${a.id} ended at`) } });
});
