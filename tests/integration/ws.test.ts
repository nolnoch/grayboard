// End-to-end over real WebSockets: an in-memory server with dev auth, and
// clients for two or three users. Covers the distributed board semantics in
// docs/architecture.md §4–5.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createTouchQueue, hashToken, verifySessionToken } from "../../src/server/auth.ts";
import { chmodSync, rmSync } from "node:fs";
import { join } from "node:path";

import pkg from "../../package.json" with { type: "json" };
import type { Config } from "../../src/server/config.ts";
import { ROOT } from "../support/paths.ts";
import { PROTO } from "../../src/shared/protocol.ts";
import { TestServer } from "../support/server.ts";
import { until } from "../support/until.ts";
import type { Any, WsClient, WsClientOptions } from "../support/ws_client.ts";

const SERVER = join(ROOT, "src/server/main.ts");

// Each test's server, with a short probe so heartbeat tests run fast.
const start = (overrides: Partial<Config> = {}) => new TestServer(overrides, { probeMs: 150 });
let srv: TestServer;

// A test that needs other config replaces the server.
const restart = (overrides: Partial<Config> = {}) => {
  srv.stop();
  srv = start(overrides);
};

beforeEach(() => {
  srv = start();
});

afterEach(() => srv.stop());

const login = (email: string) => srv.login(email);
const api = (token: string, method: string, path: string, body?: unknown) => srv.api(token, method, path, body);
const upload = (token: string, identity: string, filename: string, data: Uint8Array | string) => srv.upload(token, identity, filename, data);
const client = (token: string, identity: string, opts?: WsClientOptions) => srv.client(token, identity, opts);

const boardPush = (m: Any) => m.type === "board_push";

async function closeAndSettle(c: WsClient) {
  c.close();
  await Bun.sleep(50);
}

// #284 decision 5 (audit W8): a team can't take another principal's name.
test("team create on another principal's name is a 409, and no team or board is made", async () => {
  const alice = await login("alice@example.com");
  srv.app.db.prepare(`INSERT INTO principals (kind, name, created_at) VALUES ('service', 'ingest', 0)`).run();
  const r = await api(alice, "POST", "/api/teams", { name: "ingest" });
  expect(r.status).toBe(409);
  expect(JSON.stringify(r.body)).toContain("ingest");
  expect(srv.app.db.query(`SELECT COUNT(*) AS n FROM teams WHERE name = 'ingest'`).get()).toEqual({ n: 0 });
  expect(srv.app.db.query(`SELECT COUNT(*) AS n FROM boards WHERE name = 'ingest'`).get()).toEqual({ n: 0 });
});

test("team board: members see it and get pushes; non-members can't see or be mentioned", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const carol = await login("carol@example.com");
  await api(bob, "POST", "/api/identities", { name: "fe" });
  expect((await api(alice, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
  await api(alice, "POST", "/api/teams/eng/add", { email: "carol@example.com" });

  const a = client(alice, "be");
  const b = client(bob, "fe");
  const c = client(carol, "sim");
  for (const x of [a, b, c]) expect((await x.connect()).type).toBe("hello_ok");

  const posted = await a.call("board_post", { board: "eng", body: "@sim @bob/fe secret plan" });
  expect(posted.type).toBe("call_ok");
  expect(posted.result.unresolved).toEqual(["bob/fe"]);

  const pushed = await c.next(boardPush);
  expect(pushed.item).toMatchObject({
    kind: "push",
    reason: "mention",
    post: { board: "eng", author: "alice@example.com/be", body: "@sim @bob/fe secret plan" },
  });
  await b.none(boardPush);

  expect((await b.call("board_list")).result.map((x: any) => x.name)).toEqual([]);
  expect(await b.call("board_read", { board: "eng" })).toMatchObject({
    type: "error",
    message: "no such board #eng; see board_list",
  });
  expect((await c.call("board_list")).result).toMatchObject([{ name: "eng", scope: "team:eng", mode: "digest" }]);
});

test("who: live connections are online; a closed one is offline with last_seen; team board scopes it", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const carol = await login("carol@example.com");
  await api(alice, "POST", "/api/teams", { name: "eng" });
  await api(alice, "POST", "/api/teams/eng/add", { email: "bob@example.com" });

  const a = client(alice, "be");
  const a2 = client(alice, "be-stream");
  const b = client(bob, "fe");
  const c = client(carol, "sim");
  for (const x of [a, a2, b, c]) expect((await x.connect()).type).toBe("hello_ok");

  const online = await c.call("peer_list");
  expect(online.result.you).toBe("carol@example.com/sim");
  expect(online.result.peers.map((p: any) => p.handle)).toEqual([
    "alice@example.com/be",
    "alice@example.com/be-stream",
    "bob@example.com/fe",
    "carol@example.com/sim",
  ]);

  const before = Date.now();
  await closeAndSettle(a2);
  const after = await c.call("peer_list");
  expect(after.result.offline_hidden).toBe(1);
  const all = await c.call("peer_list", { include_offline: true });
  const gone = all.result.peers.find((p: any) => p.handle === "alice@example.com/be-stream");
  expect(gone.online).toBe(false);
  expect(gone.last_seen).toBeGreaterThanOrEqual(before);

  const team = await b.call("peer_list", { board: "eng", include_offline: true });
  expect(team.result.peers.map((p: any) => [p.handle, p.online])).toEqual([
    ["alice@example.com/be", true],
    ["alice@example.com/be-stream", false],
    ["bob@example.com/fe", true],
  ]);
  expect(await c.call("peer_list", { board: "eng" })).toMatchObject({ type: "error", message: "no such board #eng; see board_list" });
});

test("unacked board pushes are resent after reconnect; acked ones aren't", async () => {
  const alice = await login("alice@example.com");
  await api(alice, "POST", "/api/teams", { name: "eng" });
  const a = client(alice, "be");
  const s = client(alice, "sim");
  await a.connect();
  await s.connect();

  await a.call("board_post", { board: "eng", body: "@sim ping" });
  const first = await s.next(boardPush);
  await closeAndSettle(s);

  // A reconnect is the same session: its key.
  const s2 = client(alice, "sim", { key: s.key });
  await s2.connect();
  const again = await s2.next(boardPush);
  expect(again.item.post.id).toBe(first.item.post.id);
  const refs = [{ kind: "push", post_id: again.item.post.id }];
  expect((await s2.request({ type: "board_ack", refs })).type).toBe("ack_ok");
  await closeAndSettle(s2);

  const s3 = client(alice, "sim", { key: s.key });
  await s3.connect();
  await s3.none(boardPush);
});

test("peer_list shows where the client says it runs; a resumed hello keeps the status, a new session clears it", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const watcher = client(bob, "fe");
  await watcher.connect();
  const be = async () => (await watcher.call("peer_list", { include_offline: true })).result.peers.find((p: any) => p.handle === "alice@example.com/be");

  // One session: a resume keeps the status only under the session ID that last bound the name (#211).
  const key = "c1".repeat(32);
  const first = client(alice, "be", { hello: { session_key: key, where: "api worktree stream \n on stream" } });
  await first.connect();
  await first.call("peer_status", { text: "soaking" });
  expect(await be()).toMatchObject({ where: "api worktree stream on stream", status: "soaking" });

  await closeAndSettle(first);
  const resumed = client(alice, "be", { hello: { session_key: key, where: "api worktree stream on main", resume: true } });
  await resumed.connect();
  expect(await be()).toMatchObject({ where: "api worktree stream on main", status: "soaking" });

  // A session that ends frees the alias; the next one starts its own status.
  expect((await resumed.request({ type: "end" })).type).toBe("end_ok");
  await closeAndSettle(resumed);
  await client(alice, "be").connect();
  const fresh = await be();
  expect(fresh.where).toBeUndefined();
  expect(fresh.status).toBeUndefined();
});

test("team boards: digests coalesce until read; team: is not a DM recipient", async () => {
  const alice = await login("alice@example.com");
  const carol = await login("carol@example.com");
  await api(alice, "POST", "/api/teams", { name: "eng" });
  await api(alice, "POST", "/api/teams/eng/add", { email: "carol@example.com" });
  const a = client(alice, "be");
  const c = client(carol, "sim");
  await a.connect();
  await c.connect();

  expect(await a.request({ type: "send", recipient: "team:eng", body: "standup in 5" })).toMatchObject({
    type: "error",
    code: "bad_request",
  });
  // A digest never wakes a session by itself; it arrives with the next hello.
  await a.call("board_post", { board: "eng", body: "standup in 5" });
  await c.none(boardPush);
  await closeAndSettle(c);
  const c2 = client(carol, "sim", { key: c.key });
  await c2.connect();
  const digest = await c2.next(boardPush);
  expect(digest.item).toMatchObject({ kind: "digest", board: "eng", unread: 1 });

  await a.call("board_post", { board: "eng", body: "make that 10" });
  await c2.none(boardPush); // one digest until carol catches up

  await c2.request({ type: "board_ack", refs: [{ kind: "digest", board: "eng", latest_id: digest.item.latest.id }] });
  const r = await c2.call("board_read", { board: "eng" });
  expect(r.result.posts.map((p: any) => p.body)).toEqual(["standup in 5", "make that 10"]);

  const bob = await login("bob@example.com");
  const b = client(bob, "fe");
  await b.connect();
  expect(await b.call("board_post", { board: "eng", body: "hi" })).toMatchObject({
    type: "error",
    message: "no such board #eng; see board_list",
  });
});

test("leaving a team drops its board and pending pushes", async () => {
  const alice = await login("alice@example.com");
  const carol = await login("carol@example.com");
  await api(alice, "POST", "/api/teams", { name: "eng" });
  await api(alice, "POST", "/api/teams/eng/add", { email: "carol@example.com" });
  const a = client(alice, "be");
  await a.connect();
  // carol is offline when mentioned, then leaves before connecting.
  await api(carol, "POST", "/api/identities", { name: "sim" });
  await a.call("board_post", { board: "eng", body: "@carol@example.com/sim are you there" });
  await api(carol, "POST", "/api/teams/eng/leave");

  const c = client(carol, "sim");
  await c.connect();
  await c.none(boardPush);
  expect((await c.call("board_list")).result).toEqual([]);
});

test("removing a member drops their board and pending pushes", async () => {
  const alice = await login("alice@example.com");
  const carol = await login("carol@example.com");
  await api(alice, "POST", "/api/teams", { name: "eng" });
  await api(alice, "POST", "/api/teams/eng/add", { email: "carol@example.com" });
  const a = client(alice, "be");
  await a.connect();
  await api(carol, "POST", "/api/identities", { name: "sim" });
  await a.call("board_post", { board: "eng", body: "@carol@example.com/sim are you there" });
  expect((await api(alice, "POST", "/api/teams/eng/remove", { email: "carol@example.com" })).status).toBe(200);

  const c = client(carol, "sim");
  await c.connect();
  await c.none(boardPush);
  expect((await c.call("board_list")).result).toEqual([]);
  expect((await api(carol, "GET", "/api/teams/eng/members")).status).toBe(404);
});

test("teams are invite-only: members add and remove; outsiders can't join, add, or see the roster", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const carol = await login("carol@example.com");
  await api(alice, "POST", "/api/teams", { name: "eng" });

  const join = await api(bob, "POST", "/api/teams/eng/join");
  expect(join).toMatchObject({ status: 403, body: { code: "forbidden", message: expect.stringContaining("team add") } });
  // A non-member gets the same answer whether or not the team exists.
  for (const team of ["eng", "nope"]) {
    expect((await api(bob, "POST", `/api/teams/${team}/add`, { email: "bob@example.com" })).status).toBe(404);
    expect((await api(bob, "GET", `/api/teams/${team}/members`)).status).toBe(404);
    expect((await api(bob, "POST", `/api/teams/${team}/remove`, { email: "alice@example.com" })).status).toBe(404);
  }

  const never = await api(alice, "POST", "/api/teams/eng/add", { email: "dave@example.com" });
  expect(never).toMatchObject({ status: 404, body: { message: expect.stringContaining("never signed in") } });

  // Any member can add; the added member can add others and remove.
  expect((await api(alice, "POST", "/api/teams/eng/add", { email: "Bob@Example.com" })).status).toBe(200);
  expect((await api(bob, "POST", "/api/teams/eng/add", { email: "carol@example.com" })).status).toBe(200);
  const members = await api(carol, "GET", "/api/teams/eng/members");
  expect(members.body.map((m: { email: string }) => m.email).sort()).toEqual([
    "alice@example.com", "bob@example.com", "carol@example.com",
  ]);
  expect((await api(carol, "POST", "/api/teams/eng/remove", { email: "bob@example.com" })).status).toBe(200);
  expect((await api(carol, "POST", "/api/teams/eng/remove", { email: "bob@example.com" })).status).toBe(404);
  expect((await api(bob, "GET", "/api/whoami")).body.teams).toEqual([]);

  const audit = srv.app.db
    .query("SELECT actor, action, detail FROM access_log WHERE action = 'team.member_removed'")
    .all();
  expect(audit).toEqual([{ actor: "carol@example.com", action: "team.member_removed", detail: '{"member":"bob@example.com"}' }]);
});

test("admin routes: refused for non-admins and when no admins are configured", async () => {
  const alice = await login("alice@example.com");
  await login("bob@example.com");
  const none = await api(alice, "POST", "/api/admin/disable-user", { email: "bob@example.com" });
  expect(none).toMatchObject({ status: 403, body: { code: "forbidden", message: expect.stringContaining("GRAYBOARD_ADMINS") } });

  restart({ admins: ["alice@example.com"] });
  const admin = await login("alice@example.com");
  const bob = await login("bob@example.com");
  for (const path of ["/api/admin/disable-user", "/api/admin/enable-user", "/api/admin/revoke-session"]) {
    expect((await api(bob, "POST", path, { email: "alice@example.com" })).status).toBe(403);
  }
  expect((await api(admin, "POST", "/api/admin/disable-user", { email: "bob@example.com" })).status).toBe(200);
  expect((await api(bob, "GET", "/api/whoami")).status).toBe(401);
});

test("admin revoke-session signs a user out of every session, ignoring an old CLI's all", async () => {
  restart({ admins: ["root@example.com"] });
  const root = await login("root@example.com");
  for (const all of [false, true, undefined]) {
    const laptop = await login("bob@example.com");
    const desktop = await login("bob@example.com");
    expect((await api(root, "POST", "/api/admin/revoke-session", { email: "bob@example.com", ...(all !== undefined ? { all } : {}) })).status).toBe(200);
    expect((await api(laptop, "GET", "/api/whoami")).status).toBe(401);
    expect((await api(desktop, "GET", "/api/whoami")).status).toBe(401);
  }
});

test("revoking or disabling a user closes their open connections; the heartbeat catches a disable it missed", async () => {
  restart({ admins: ["root@example.com"] });
  const [root, alice] = await Promise.all([login("root@example.com"), login("alice@example.com")]);
  const a = client(alice, "be");
  await a.connect();
  const closed = (c: WsClient) => new Promise<void>((resolve) => c.ws.addEventListener("close", () => resolve()));

  let pass = 0;
  for (const path of ["/api/admin/revoke-session", "/api/admin/disable-user"]) {
    await api(root, "POST", "/api/admin/enable-user", { email: "bob@example.com" });
    const bob = await login("bob@example.com");
    const live = client(bob, "be");
    const tools = client(bob, "fe", { push: false });
    await Promise.all([live.connect(), tools.connect()]);
    const gone = Promise.all([closed(live), closed(tools)]);
    expect((await api(root, "POST", path, { email: "bob@example.com" })).status).toBe(200);
    expect(await live.next((m) => m.type === "error")).toMatchObject({ code: "unauthenticated" });
    await gone;
    expect(audits("auth.connection_closed").filter((r) => JSON.parse(r.detail).why === "user_signed_out")).toHaveLength(2 * ++pass);
  }
  expect((await a.call("board_list")).type).toBe("call_ok");

  // Disabled behind the server's back (no admin route): the next tick closes it.
  await api(root, "POST", "/api/admin/enable-user", { email: "bob@example.com" });
  const late = client(await login("bob@example.com"), "be");
  await late.connect();
  const gone = closed(late);
  srv.app.repo.users.setDisabled(srv.app.repo.users.findByEmail("bob@example.com")!.id, true);
  srv.app.revalidate();
  await gone;
  expect((await a.call("board_list")).type).toBe("call_ok");
});

// #351: a logout revokes one token. Its connections close and their sessions
// end; the same user's other token keeps its own.
test("logout closes only that token's connections and ends only their sessions, audited", async () => {
  const [tokenA, tokenB] = [await login("alice@example.com"), await login("alice@example.com")];
  const a1 = client(tokenA, "be");
  const a2 = client(tokenA, "fe", { push: false });
  const b = client(tokenB, "sim");
  await Promise.all([a1.connect(), a2.connect(), b.connect()]);
  const closed = (c: WsClient) => new Promise<void>((resolve) => c.ws.addEventListener("close", () => resolve()));
  const gone = Promise.all([closed(a1), closed(a2)]);
  const sidA = srv.app.repo.sessions.findByTokenHash(hashToken(tokenA))!.id;

  expect((await api(tokenA, "POST", "/api/auth/logout")).status).toBe(200);
  expect(await a1.next((m) => m.type === "error")).toMatchObject({ code: "unauthenticated" });
  expect(await a2.next((m) => m.type === "error")).toMatchObject({ code: "unauthenticated" });
  await gone;

  expect((await b.call("board_list")).type).toBe("call_ok");
  const ended = (id: string) => srv.app.db.query(`SELECT ended_at FROM ids WHERE id = ?`).get(id) as { ended_at: number | null };
  expect(ended(a1.id).ended_at).not.toBeNull();
  expect(ended(a2.id).ended_at).not.toBeNull();
  expect(ended(b.id).ended_at).toBeNull();
  const closes = audits("auth.connection_closed").map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
  expect(closes.map((r) => r.target).sort()).toEqual([a1.id, a2.id].sort());
  for (const r of closes) expect(r).toMatchObject({ actor: "alice@example.com", detail: { why: "logout" } });
  for (const r of closes) expect(r.detail.token_session).toBe(sidA);
  expect(srv.app.repo.sessions.findById(sidA)!.revoked_at).not.toBeNull();
  expect(audits("id.ended").filter((r) => JSON.parse(r.detail).why === "signed_out").map((r) => r.target).sort()).toEqual([a1.id, a2.id].sort());
});

// A session in its grace has no connection, so only the token it last said
// hello under (ids.token_session) finds it.
test("logout ends the token's sessions in their grace too, and a resume on them is refused", async () => {
  const [tokenA, tokenC] = [await login("alice@example.com"), await login("alice@example.com")];
  const a = client(tokenA, "be");
  await a.connect();
  a.close();
  await until(() => audits("id.detached").length === 1, 2000, "the grace");
  expect((await api(tokenA, "POST", "/api/auth/logout")).status).toBe(200);
  expect(srv.app.db.query(`SELECT ended_at FROM ids WHERE id = ?`).get(a.id)).toEqual({ ended_at: expect.any(Number) });
  expect(audits("id.ended").map((r) => ({ target: r.target, why: JSON.parse(r.detail).why }))).toEqual([{ target: a.id, why: "signed_out" }]);

  const back = client(tokenC, "be", { key: a.key, hello: { resume: true } });
  expect(await back.connect()).toMatchObject({ type: "error", code: "id_collision" });
});

// A socket opened with a token that is revoked before it speaks is in no
// registry, so only the hello can refuse it.
test("a hello on a token revoked since the upgrade is refused, registers nothing, and is audited", async () => {
  const token = await login("alice@example.com");
  const key = "ab".repeat(32);
  const ws = new (WebSocket as any)(`${srv.base.replace("http", "ws")}/ws`, { headers: { Authorization: `Bearer ${token}` } });
  await new Promise((resolve) => (ws.onopen = resolve));
  const frames: Any[] = [];
  ws.onmessage = (e: MessageEvent) => frames.push(JSON.parse(e.data as string));
  const closed = new Promise<void>((resolve) => (ws.onclose = () => resolve()));
  expect((await api(token, "POST", "/api/auth/logout")).status).toBe(200);
  ws.send(JSON.stringify({ type: "hello", req_id: "h", proto: PROTO, session_key: key }));
  await closed;
  expect(frames.find((m) => m.type === "error")).toMatchObject({ req_id: "h", code: "unauthenticated" });
  expect(frames.some((m) => m.type === "hello_ok")).toBe(false);
  expect(srv.app.db.query(`SELECT COUNT(*) AS n FROM ids`).get()).toEqual({ n: 0 });
  const rows = audits("auth.hello_refused").map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ actor: "alice@example.com", detail: { why: "token_revoked" } });
});

test("a hello from a user disabled since the upgrade is refused, registers nothing, and is audited", async () => {
  const token = await login("alice@example.com");
  const ws = new (WebSocket as any)(`${srv.base.replace("http", "ws")}/ws`, { headers: { Authorization: `Bearer ${token}` } });
  await new Promise((resolve) => (ws.onopen = resolve));
  const frames: Any[] = [];
  ws.onmessage = (e: MessageEvent) => frames.push(JSON.parse(e.data as string));
  const closed = new Promise<void>((resolve) => (ws.onclose = () => resolve()));
  srv.app.repo.users.setDisabled(srv.app.repo.users.findByEmail("alice@example.com")!.id, true);
  ws.send(JSON.stringify({ type: "hello", req_id: "h", proto: PROTO, session_key: "cd".repeat(32) }));
  await closed;
  expect(frames.find((m) => m.type === "error")).toMatchObject({ req_id: "h", code: "unauthenticated" });
  expect(srv.app.db.query(`SELECT COUNT(*) AS n FROM ids`).get()).toEqual({ n: 0 });
  expect(audits("auth.hello_refused").map((r) => JSON.parse(r.detail).why)).toEqual(["user_disabled"]);
});

test("a token revoked while its hello probes a silent holder neither takes the session over nor registers", async () => {
  const [tokenA, tokenB] = [await login("alice@example.com"), await login("alice@example.com")];
  const holder = client(tokenB, "be", { pong: false });
  await holder.connect();
  const hello = client(tokenA, "be", { key: holder.key }).connect().catch((e) => e);
  await holder.next((m) => m.type === "ping"); // the probe is under way
  expect((await api(tokenA, "POST", "/api/auth/logout")).status).toBe(200);
  expect(await hello).toMatchObject({ type: "error", code: "unauthenticated" });
  expect(audits("id.superseded")).toEqual([]);
  expect(audits("auth.hello_refused")).toHaveLength(1);
  // The holder is still the session's connection.
  expect(holder.ws.readyState).toBe(1);
});

// The wait for another hello's probe is an await too: a token revoked during
// it must not go on to probe the new holder and collide as if it were live.
test("a token revoked while its hello waits on another hello's probe is refused, not collided", async () => {
  const [tokenA, tokenB] = [await login("alice@example.com"), await login("alice@example.com")];
  const holder = client(tokenB, "be", { pong: false });
  await holder.connect();
  const first = client(tokenB, "be", { key: holder.key }).connect(); // probes the silent holder (150 ms)
  await holder.next((m) => m.type === "ping");
  // A beat for the second hello to reach the server and wait on the probe, as the sleeps above do.
  await Bun.sleep(30);
  const second = client(tokenA, "be", { key: holder.key }).connect();
  await Bun.sleep(30);
  expect((await api(tokenA, "POST", "/api/auth/logout")).status).toBe(200);
  expect(await second).toMatchObject({ type: "error", code: "unauthenticated" });
  expect((await first).type).toBe("hello_ok");
  expect(audits("id.collision")).toEqual([]);
});

test("the heartbeat closes a revoked token's connections when no route said so, leaving the user's other token", async () => {
  const [tokenA, tokenB] = [await login("alice@example.com"), await login("alice@example.com")];
  const a = client(tokenA, "be");
  const b = client(tokenB, "fe");
  await Promise.all([a.connect(), b.connect()]);
  const gone = new Promise<void>((resolve) => a.ws.addEventListener("close", () => resolve()));
  srv.app.repo.sessions.revoke(srv.app.repo.sessions.findByTokenHash(hashToken(tokenA))!.id);
  srv.app.revalidate();
  await gone;
  expect(audits("auth.connection_closed").map((r) => JSON.parse(r.detail).why)).toEqual(["token_revoked"]);
  expect((await b.call("board_list")).type).toBe("call_ok");
});

test("an admin can manage a team they're not in, e.g. after its last member left", async () => {
  restart({ admins: ["root@example.com"] });
  const root = await login("root@example.com");
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  await api(alice, "POST", "/api/teams", { name: "eng" });
  await api(alice, "POST", "/api/teams/eng/leave");
  expect((await api(bob, "POST", "/api/teams/eng/add", { email: "bob@example.com" })).status).toBe(404);

  expect((await api(root, "GET", "/api/teams/eng/members")).body).toEqual([]);
  expect((await api(root, "POST", "/api/teams/eng/add", { email: "bob@example.com" })).status).toBe(200);
  expect((await api(root, "GET", "/api/teams/nope/members")).status).toBe(404);
  expect((await api(bob, "GET", "/api/whoami")).body.teams).toEqual(["eng"]);
  // Managing doesn't make the admin a member.
  expect((await api(root, "GET", "/api/whoami")).body.teams).toEqual([]);
  expect((await api(root, "POST", "/api/teams/eng/remove", { email: "bob@example.com" })).status).toBe(200);

  const audit = srv.app.db
    .query("SELECT actor, action, detail FROM access_log WHERE action LIKE 'team.member_%' AND actor = 'root@example.com'")
    .all();
  expect(audit).toEqual([
    { actor: "root@example.com", action: "team.member_added", detail: '{"member":"bob@example.com","as_admin":true}' },
    { actor: "root@example.com", action: "team.member_removed", detail: '{"member":"bob@example.com","as_admin":true}' },
  ]);
});

test("org boards are open to everyone; bare @name prefers the author's own identity", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const a = client(alice, "be");
  const as = client(alice, "sim");
  const bs = client(bob, "sim");
  for (const x of [a, as, bs]) await x.connect();

  expect((await a.call("board_create", { name: "general", purpose: "Everyone" })).type).toBe("call_ok");
  await a.call("board_post", { board: "general", body: "@sim run the fixtures" });
  expect((await as.next(boardPush)).item.reason).toBe("mention");
  await bs.none(boardPush);

  const r = await bs.call("board_read", { board: "general" });
  expect(r.result.posts).toHaveLength(1);
  expect(await bs.call("board_create", { name: "x", purpose: "y", team: "eng" })).toMatchObject({
    type: "error",
    message: 'no such team "eng"',
  });
});

test("claims are org-wide and atomic across users", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const a = client(alice, "be");
  const b = client(bob, "be");
  await a.connect();
  await b.connect();
  expect((await a.call("claim_take", { key: "ticket:ENG-1", note: "on it" })).result.ok).toBe(true);
  expect((await b.call("claim_take", { key: "ticket:ENG-1" })).result).toMatchObject({
    ok: false,
    held_by: "alice@example.com/be",
    note: "on it",
  });
  expect((await b.call("claim_list")).result.map((c: any) => c.key)).toEqual(["ticket:ENG-1"]);
});

test("an alias a live session holds refuses another session's bind", async () => {
  const alice = await login("alice@example.com");
  const first = client(alice, "be");
  await first.connect();
  const second = client(alice, "be");
  expect(await second.connect()).toMatchObject({ type: "error", code: "alias_held", holder: `the session ${first.id}` });
  // The first connection still works.
  expect((await first.call("board_list")).type).toBe("call_ok");
});

test("a connection that doesn't answer the probe is replaced, audited id.superseded with both places", async () => {
  const alice = await login("alice@example.com");
  const stale = client(alice, "be", { pong: false, hello: { where: "old box" } });
  await stale.connect();
  // A place is cleaned once, before any audit carries it (audit S6).
  const fresh = client(alice, "be", { key: stale.key, hello: { where: "  new\n box " } });
  expect((await fresh.connect()).type).toBe("hello_ok");
  expect(await stale.next((m) => m.type === "error")).toMatchObject({ code: "superseded" });
  const rows = srv.app.db.prepare(`SELECT actor, target, detail FROM access_log WHERE action = 'id.superseded'`).all() as { actor: string; target: string; detail: string }[];
  expect(rows.map((r) => ({ ...r, detail: JSON.parse(r.detail) }))).toEqual([
    { actor: "alice@example.com", target: stale.id, detail: { old_place: "old box", place: "new box" } },
  ]);
});

// Audit S2 (#345): a hello awaits the probe; a second hello on the same
// connection meanwhile is refused and closes it, and the first never
// supersedes the holder from a closed socket.
test("a second hello while the first is probing is refused and closes the connection", async () => {
  const alice = await login("alice@example.com");
  const dead = client(alice, "be", { pong: false });
  await dead.connect();
  const twice = client(alice, "be", { key: dead.key });
  const first = twice.connect(); // probes the dead holder (150 ms)
  await until(() => twice.ws.readyState === 1);
  twice.ws.send(JSON.stringify({ type: "hello", req_id: "h2", proto: PROTO, session_key: dead.key }));
  expect(await twice.next((m) => m.req_id === "h2")).toMatchObject({ type: "error", code: "bad_request", message: "a hello is already in flight on this connection" });
  await expect(first).rejects.toThrow("socket closed");
  await dead.none((m: Any) => m.type === "error", 300);
});

// Audit S1 (#345): a re-attach is the session its row registered: a
// tools-only hello on a push session's key, or a push hello on a tools-only
// session's, is id_collision, refused before the probe, so it never
// supersedes the holder.
test("a re-attach whose writes_as differs from the session's row is id_collision and supersedes nothing", async () => {
  const alice = await login("alice@example.com");
  const holder = client(alice, "be", { pong: false });
  await holder.connect();
  const sidecar = client(alice, "be", { key: holder.key, push: false });
  expect(await sidecar.connect()).toMatchObject({
    type: "error", code: "id_collision", message: expect.stringContaining(`registered writing as its own addresses, and this hello writes as "alice@example.com/be"`),
  });
  await holder.none((m: Any) => m.type === "error", 300);

  const writer = client(alice, "fe", { push: false });
  await writer.connect();
  writer.close();
  const pushed = client(alice, "fe", { key: writer.key });
  expect(await pushed.connect()).toMatchObject({ type: "error", code: "id_collision", message: expect.stringContaining(`registered writing as "alice@example.com/fe"`) });
  const audited = srv.app.db.prepare(`SELECT target FROM access_log WHERE action = 'id.collision' ORDER BY id`).all();
  expect(audited).toEqual([{ target: holder.id }, { target: writer.id }]);
});

test("a hello arriving while another probes the holder waits for it, so only one wins", async () => {
  const [alice, bob] = await Promise.all([login("alice@example.com"), login("bob@example.com")]);
  const dead = client(alice, "be", { pong: false });
  await dead.connect();
  const n1 = client(alice, "be", { key: dead.key });
  const first = n1.connect(); // probes the dead holder (150 ms)
  await Bun.sleep(40);
  dead.close(); // the holder goes away mid-probe
  await Bun.sleep(40);
  const n2 = client(alice, "be", { key: dead.key });
  const [r1, r2] = await Promise.all([first, n2.connect()]);
  expect(r1.type).toBe("hello_ok");
  expect(r2).toMatchObject({ type: "error", code: "id_collision" });

  const b = client(bob, "fe");
  await b.connect();
  expect(await b.request({ type: "send", recipient: "alice@example.com/be", body: "who?" })).toMatchObject({ delivered_now: true });
  expect((await n1.next((m) => m.type === "push")).message.body).toBe("who?");
});

test("direct messages still deliver live", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const a = client(alice, "be");
  const b = client(bob, "fe");
  await a.connect();
  await b.connect();
  const sent = await a.request({ type: "send", recipient: "bob@example.com/fe", body: "hi" });
  expect(sent).toMatchObject({ type: "send_ok", delivered_now: true });
  expect((await b.next((m) => m.type === "push")).message.body).toBe("hi");
});

test("a handler that throws answers the call with an internal error and keeps the socket", async () => {
  const alice = await login("alice@example.com");
  const be = client(alice, "be");
  const fe = client(alice, "fe");
  await Promise.all([be.connect(), fe.connect()]);
  await be.request({ type: "send", recipient: "fe", body: "hi" });
  const id = (await fe.next((m) => m.type === "push")).message.id;
  // A read-point table gone from under the live server makes the ack's cursor write fail.
  srv.app.db.exec(`ALTER TABLE mailbox_cursors RENAME TO mailbox_cursors_gone`);
  expect(await fe.request({ type: "ack", message_ids: [id] })).toMatchObject({ type: "error", code: "internal" });
  expect((await fe.call("board_list")).type).toBe("call_ok");
});

test("login refuses an email no direct address can carry", async () => {
  const r = await fetch(`${srv.base}/api/auth/dev-login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "o'brien@example.com" }) });
  expect(r.status).toBe(400);
});

test("a bare DM recipient is your own identity of that name, else the only one with it", async () => {
  const [alice, bob, carol] = await Promise.all(["alice", "bob", "carol"].map((n) => login(`${n}@example.com`)));
  const a = client(alice, "be");
  const a2 = client(alice, "be-stream");
  const b = client(bob, "be-stream");
  const b2 = client(bob, "fe");
  const c = client(carol, "fe");
  await Promise.all([a, a2, b, b2, c].map((x) => x.connect()));

  // alice and bob both have be-stream: alice's bare name means her own.
  expect(await a.request({ type: "send", recipient: "be-stream", body: "mine" })).toMatchObject({ type: "send_ok" });
  expect((await a2.next((m) => m.type === "push")).message.body).toBe("mine");
  // carol has no be: the only be is alice's.
  expect(await c.request({ type: "send", recipient: "be", body: "only one" })).toMatchObject({ type: "send_ok" });
  expect((await a.next((m) => m.type === "push")).message.body).toBe("only one");
  // alice has no fe, and bob and carol each have one: ambiguous.
  const amb = await a.request({ type: "send", recipient: "fe", body: "?" });
  expect(amb).toMatchObject({ type: "error", code: "not_found" });
  expect(amb.message).toContain("bob@example.com/fe, carol@example.com/fe");
  expect(await a.request({ type: "send", recipient: "nobody", body: "?" })).toMatchObject({ type: "error", code: "not_found" });
});

test("dm_history: peer resolves like dm_send's recipient, oldest first, limit clamped; empty bodies refused", async () => {
  const [alice, bob] = await Promise.all([login("alice@example.com"), login("bob@example.com")]);
  const a = client(alice, "be");
  const b = client(bob, "fe");
  await Promise.all([a.connect(), b.connect()]);
  for (const body of ["one", "two", "three"]) await a.request({ type: "send", recipient: "fe", body });
  expect(await a.request({ type: "send", recipient: "fe", body: "  " })).toMatchObject({ type: "error", code: "bad_request" });

  const bodies = async (peer: string, limit?: number) =>
    (await a.request({ type: "history", peer, ...(limit !== undefined ? { limit } : {}) })).messages.map((m: any) => m.body);
  expect(await bodies("fe")).toEqual(["one", "two", "three"]);
  expect(await bodies("Bob@Example.com/FE")).toEqual(["one", "two", "three"]);
  expect(await bodies("fe", 2)).toEqual(["two", "three"]);
  expect(await bodies("fe", 0)).toEqual(["three"]);
  expect(await a.request({ type: "history", peer: "nobody" })).toMatchObject({ type: "error", code: "not_found" });
});

test("senders see what hasn't reached an offline peer", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const b = client(bob, "fe");
  await b.connect();
  await closeAndSettle(b);
  const a = client(alice, "be");
  await a.connect();
  await a.request({ type: "send", recipient: "bob@example.com/fe", body: "one" });
  const sent = await a.request({ type: "send", recipient: "bob@example.com/fe", body: "two" });
  expect(sent).toMatchObject({ delivered_now: false, recipient_last_seen: expect.stringMatching(/ago$/), undelivered_from_you: 2 });
  const delivered = async () =>
    (await a.request({ type: "history", peer: "bob@example.com/fe" })).messages.map((m: any) => m.delivered);
  expect(await delivered()).toEqual([false, false]);

  const b2 = client(bob, "fe", { key: b.key });
  await b2.connect();
  const ids = [(await b2.next((m) => m.type === "push")).message.id, (await b2.next((m) => m.type === "push")).message.id];
  await b2.request({ type: "ack", message_ids: ids });
  expect(await delivered()).toEqual([true, true]);
});

test("dm_retract withdraws a queued message; one the recipient is holding or has acked stays", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const b = client(bob, "fe");
  await b.connect();
  await closeAndSettle(b);
  const a = client(alice, "be");
  await a.connect();
  const fresh = await a.request({ type: "send", recipient: "bob@example.com/fe", body: "fresh" });
  expect(fresh.note).toMatch(/^Recipient offline/);
  srv.app.db.prepare("UPDATE aliases SET last_seen = ? WHERE address = ?").run(Date.now() - 22 * 3_600_000, "bob@example.com/fe");
  const wrong = await a.request({ type: "send", recipient: "bob@example.com/fe", body: "wrong" });
  expect(wrong.note).toMatch(/^Queued: bob@example.com\/fe last seen 22h ago\. .*dm_retract/);

  const other = client(bob, "sim");
  await other.connect();
  expect(await other.request({ type: "dm_retract", message_id: wrong.message_id })).toMatchObject({ type: "error", code: "not_found" });
  expect(await a.request({ type: "dm_retract", message_id: wrong.message_id })).toMatchObject({ type: "ack_ok" });
  expect((await a.request({ type: "history", peer: "bob@example.com/fe" })).messages.map((m: any) => m.body)).toEqual(["fresh"]);

  // Pushed but not acked: the cursor hasn't moved, but bob is live.
  const b2 = client(bob, "fe", { key: b.key });
  await b2.connect();
  expect((await b2.next((m) => m.type === "push")).message.body).toBe("fresh");
  await b2.none((m) => m.type === "push");
  const held = await a.request({ type: "dm_retract", message_id: fresh.message_id });
  expect(held).toMatchObject({ type: "error", message: expect.stringContaining("already reached") });
});

test("hello_ok carries active claims and DMs undelivered after a day", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const b = client(bob, "fe");
  await b.connect();
  await closeAndSettle(b);
  const a = client(alice, "be");
  expect((await a.connect()).notices).toBeUndefined();
  await a.call("claim_take", { key: "ticket:ENG-2", note: "on it" });
  const old = await a.request({ type: "send", recipient: "bob@example.com/fe", body: "stale" });
  await a.request({ type: "send", recipient: "bob@example.com/fe", body: "fresh" });
  srv.app.db.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(Date.now() - 2 * 86_400_000, old.message_id);
  await closeAndSettle(a);

  const notices: string[] = (await client(alice, "be", { key: a.key }).connect()).notices;
  expect(notices).toHaveLength(2);
  expect(notices[0]).toContain(`bob@example.com/fe: 1 since message_id ${old.message_id} (last seen`);
  expect(notices[1]).toMatch(/Yours: ticket:ENG-2 \(until \d{4}-\d\d-\d\dT\d\d:\d\dZ: on it\)\./);
  expect((await client(alice, "sim").connect()).notices[0]).toContain("Others': ticket:ENG-2.");
});

// Audit F2 (#345): bind_ok's notices cover the session's whole address set,
// so a claim taken as the ID before the bind is still listed as its own.
test("bind_ok's notices list the claims the session took as its ID before the bind", async () => {
  const alice = await login("alice@example.com");
  const a = srv.client(alice, null);
  await a.connect();
  await a.call("claim_take", { key: "ticket:ENG-3", note: "as the ID" });
  const b = await a.bind("be");
  expect(b.notices.at(-1)).toMatch(/Yours: ticket:ENG-3 \(until [^)]*: as the ID\)\./);
});

// Audit W2 (#345): deleting an identity would drop its holds under a live
// holder, and a second session could then bind it: refused while in use.
test("an identity a session holds or writes as can't be deleted until those sessions end", async () => {
  const alice = await login("alice@example.com");
  const a = client(alice, "be");
  await a.connect();
  const sidecar = client(alice, "be", { push: false });
  await sidecar.connect();
  expect(await api(alice, "DELETE", "/api/identities/be")).toEqual({ status: 409, body: { code: "alias_held", message: expect.stringContaining("is in use by the session") } });
  expect(await a.request({ type: "end" })).toMatchObject({ type: "end_ok" });
  expect(await api(alice, "DELETE", "/api/identities/be")).toEqual({ status: 409, body: { code: "alias_held", message: expect.stringContaining(sidecar.id) } });
  expect(await sidecar.request({ type: "end" })).toMatchObject({ type: "end_ok" });
  expect(await api(alice, "DELETE", "/api/identities/be")).toEqual({ status: 200, body: { ok: true } });
});

test("dm_inbox: replied and acked messages drop out; only the recipient can ack", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const a = client(alice, "be");
  const b = client(bob, "fe");
  await a.connect();
  await b.connect();
  const q = await b.request({ type: "send", recipient: "alice@example.com/be", body: "question?" });
  const fyi = await b.request({ type: "send", recipient: "alice@example.com/be", body: "FYI" });
  const inbox = async () => (await a.request({ type: "inbox" })).unanswered.map((m: any) => m.id);
  expect(await inbox()).toEqual([q.message_id, fyi.message_id]);

  await a.request({ type: "send", recipient: "bob@example.com/fe", body: "answer", parent_id: q.message_id });
  expect(await b.request({ type: "dm_ack", message_id: fyi.message_id })).toMatchObject({ type: "error", code: "not_found" });
  expect(await a.request({ type: "dm_ack", message_id: fyi.message_id })).toMatchObject({ type: "ack_ok" });
  expect(await inbox()).toEqual([]);
});

test("a pending send is echoed, listed as promised until the sender's next message, and ackable by the sender", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const a = client(alice, "be");
  const b = client(bob, "fe");
  await a.connect();
  await b.connect();
  const p = await a.request({ type: "send", recipient: "bob@example.com/fe", body: "results by noon", pending: true });
  expect(p).toMatchObject({ type: "send_ok", pending: true });
  const plain = await a.request({ type: "send", recipient: "bob@example.com/fe", body: "fyi" });
  expect(plain.pending).toBeUndefined();
  const promises = async () => (await a.request({ type: "inbox", days: 1 })).promised?.map((m: any) => m.id);
  expect(await promises()).toEqual([p.message_id]);
  // History is oldest first; only the pending row says so.
  expect((await a.request({ type: "history", peer: "bob@example.com/fe" })).messages.map((m: any) => m.pending)).toEqual([true, undefined]);

  // Bob's reply doesn't keep it, and his ack (as its recipient) doesn't drop it.
  await b.request({ type: "send", recipient: "alice@example.com/be", body: "thanks", parent_id: p.message_id });
  expect(await b.request({ type: "dm_ack", message_id: p.message_id })).toMatchObject({ type: "ack_ok" });
  expect(await promises()).toEqual([p.message_id]);
  await a.request({ type: "send", recipient: "bob@example.com/fe", body: "done", parent_id: p.message_id });
  expect(await promises()).toBeUndefined();

  const p2 = await a.request({ type: "send", recipient: "bob@example.com/fe", body: "later", pending: true });
  expect(await a.request({ type: "dm_ack", message_id: plain.message_id })).toMatchObject({ type: "error", code: "not_found" });
  expect(await a.request({ type: "dm_ack", message_id: p2.message_id })).toMatchObject({ type: "ack_ok" });
  expect(await promises()).toBeUndefined();
});

test("only a message's sender and recipient can read its thread or reply to it", async () => {
  const [alice, bob, carol] = await Promise.all(["alice", "bob", "carol"].map((n) => login(`${n}@example.com`)));
  const a = client(alice!, "be");
  const b = client(bob!, "fe");
  const c = client(carol!, "sim");
  await Promise.all([a.connect(), b.connect(), c.connect()]);
  const root = await a.request({ type: "send", recipient: "bob@example.com/fe", body: "private" });
  const reply = await b.request({ type: "send", recipient: "alice@example.com/be", body: "re", parent_id: root.message_id });
  expect((await b.request({ type: "thread", message_id: root.message_id })).messages.map((m: any) => m.id)).toEqual([
    root.message_id,
    reply.message_id,
  ]);
  expect(await c.request({ type: "thread", message_id: reply.message_id })).toMatchObject({ type: "error", code: "not_found" });
  expect(await c.request({ type: "send", recipient: "alice@example.com/be", body: "x", parent_id: root.message_id })).toMatchObject({
    type: "error",
    code: "not_found",
  });
  expect(await a.request({ type: "send", recipient: "bob@example.com/fe", body: "x", parent_id: 99999 })).toMatchObject({
    type: "error",
  });
});

test("a tools-only connection works beside the live owner without taking its pushes", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const owner = client(alice, "be");
  await owner.connect();
  const tools = client(alice, "be", { push: false });
  expect(await tools.connect()).toMatchObject({ type: "hello_ok" });
  const b = client(bob, "fe");
  await b.connect();

  const sent = await b.request({ type: "send", recipient: "alice@example.com/be", body: "hi" });
  expect(sent.delivered_now).toBe(true);
  expect((await owner.next((m) => m.type === "push")).message.body).toBe("hi");
  expect((await b.call("board_create", { name: "e2e", purpose: "x" })).type).toBe("call_ok");
  expect((await tools.request({ type: "call", tool: "board_list", args: {} })).type).toBe("call_ok");
  await tools.none((m) => m.type === "push" || m.type === "board_push");

  await closeAndSettle(tools);
  const peers = (await b.call("peer_list")).result.peers;
  expect(peers.find((p: any) => p.handle === "alice@example.com/be")?.online).toBe(true);
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);

const download = (token: string, identity: string, id: number) =>
  fetch(`${srv.base}/api/attachments/${id}?as=${identity}`, { headers: { Authorization: `Bearer ${token}` } });

const audits = (action: string) =>
  (srv.app.db.prepare(`SELECT actor, target, detail FROM access_log WHERE action = ? ORDER BY at`).all(action) as { actor: string; target: string; detail: string }[]);

test("attachments on a DM: uploaded as your identity, bound by the send, pushed and read, fetched by its two parties", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const carol = await login("carol@example.com");
  const a = client(alice, "be");
  const b = client(bob, "fe");
  const c = client(carol, "sim");
  for (const x of [a, b, c]) expect((await x.connect()).type).toBe("hello_ok");

  // An unknown identity is refused as `grayboard claim` refuses one.
  expect(await upload(alice, "nope", "x.png", PNG)).toMatchObject({ status: 404, body: { code: "unknown_identity" } });
  expect((await upload(alice, "human", "x.png", PNG)).status).toBe(403);
  expect((await upload(alice, "be", "x.bin", new Uint8Array([0, 1, 2]))).body.message).toMatch(/not an image/);
  expect((await upload(alice, "be", "x.txt", new Uint8Array(0))).body.message).toBe("file x.txt: empty file");
  // The upload runs the checks an agent's path gets: names, key material, an extension matching the type.
  expect((await upload(alice, "be", ".env", "A=1")).body.message).toMatch(/dotfiles/);
  expect((await upload(alice, "be", "id_rsa", "x")).body.message).toMatch(/key or credentials/);
  expect((await upload(alice, "be", "n.txt", "-----BEGIN RSA PRIVATE KEY-----")).body.message).toMatch(/key material/);

  const up = await upload(alice, "be", "../shot.png", PNG);
  expect(up.status).toBe(201);
  expect(up.body).toEqual({ id: expect.any(Number), filename: "shot.png", type: "image/png", size: PNG.length, sha256: expect.any(String) });
  const info = { id: up.body.id, filename: "shot.png", type: "image/png", size: PNG.length, sha256: up.body.sha256 };
  expect(audits("attachment.uploaded")).toEqual([
    { actor: "alice@example.com", target: `attachment:${up.body.id}`, detail: expect.stringContaining('"identity":"alice@example.com/be"') },
  ]);

  // Only the uploader's identity can send it.
  expect(await c.request({ type: "send", recipient: "bob@example.com/fe", body: "mine now", attachment_ids: [up.body.id] })).toMatchObject({
    type: "error",
    code: "bad_request",
    message: `attachment ${up.body.id} isn't an unsent upload of yours`,
  });
  const sent = await a.request({ type: "send", recipient: "bob@example.com/fe", body: "see shot", attachment_ids: [up.body.id] });
  expect(sent).toMatchObject({ type: "send_ok", delivered_now: true, attachments: [info] });
  expect((await b.next((m) => m.type === "push")).message).toMatchObject({ body: "see shot", attachments: [info] });
  // Once bound, it can't ride a second message.
  expect((await a.request({ type: "send", recipient: "bob@example.com/fe", body: "again", attachment_ids: [up.body.id] })).type).toBe("error");

  expect((await b.request({ type: "thread", message_id: sent.message_id })).messages[0].attachments).toEqual([info]);
  expect((await b.request({ type: "history", peer: "alice@example.com/be" })).messages[0].attachments).toEqual([info]);
  expect((await b.request({ type: "inbox" })).unanswered[0].attachments).toEqual([info]);

  const got = await download(bob, "fe", up.body.id);
  expect(got.status).toBe(200);
  expect(got.headers.get("content-type")).toBe("image/png");
  expect(got.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''shot.png");
  expect(got.headers.get("repr-digest")).toBe(`sha-256=:${createHash("sha256").update(PNG).digest("base64")}:`);
  expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG);
  expect((await download(alice, "be", up.body.id)).status).toBe(200);
  // Not a party: reads as missing, and is logged.
  const refused = await download(carol, "sim", up.body.id);
  expect(refused.status).toBe(404);
  expect(((await refused.json()) as { message: string }).message).toBe(`no attachment ${up.body.id} on a message or post you can read`);
  expect(audits("attachment.download_refused")).toMatchObject([{ actor: "carol@example.com", target: `attachment:${up.body.id}` }]);
  expect(audits("attachment.downloaded").map((r) => r.actor)).toEqual(["bob@example.com", "alice@example.com"]);
});

test("attachments: a failed blob read or write is audited; a swept blob is a 404, a fault a bare 500", async () => {
  const { blobDir } = srv.config;
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const a = client(alice, "be");
  const b = client(bob, "fe");
  for (const x of [a, b]) expect((await x.connect()).type).toBe("hello_ok");

  const up = await upload(alice, "be", "shot.png", PNG);
  expect((await a.request({ type: "send", recipient: "bob@example.com/fe", body: "see shot", attachment_ids: [up.body.id] })).type).toBe("send_ok");
  // Swept between the read check and the read.
  rmSync(join(blobDir, up.body.sha256.slice(0, 2), up.body.sha256));
  const gone = await download(bob, "fe", up.body.id);
  expect(gone.status).toBe(404);
  expect(await gone.json()).toEqual({ code: "not_found", message: `attachment ${up.body.id}'s bytes are gone` });
  expect(audits("attachment.download_failed")).toMatchObject([{ actor: "bob@example.com", target: `attachment:${up.body.id}`, detail: expect.stringContaining("are missing") }]);
  expect(audits("attachment.downloaded")).toEqual([]);

  // An unwritable blob directory: the client hears nothing of the path or errno.
  chmodSync(join(blobDir, "tmp"), 0o500);
  try {
    const failed = await upload(alice, "be", "other.png", new Uint8Array([...PNG, 1]));
    expect(failed).toEqual({ status: 500, body: { code: "internal", message: "internal error" } });
  } finally {
    chmodSync(join(blobDir, "tmp"), 0o700);
  }
  expect(audits("attachment.upload_failed")).toMatchObject([{ actor: "alice@example.com", target: null, detail: expect.stringMatching(/"filename":"other.png".*EACCES/) }]);
});

test("attachments on a team board post follow the board; a retracted DM takes its files; uploads are capped", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const carol = await login("carol@example.com");
  await api(alice, "POST", "/api/teams", { name: "eng" });
  await api(alice, "POST", "/api/teams/eng/add", { email: "carol@example.com" });
  await api(bob, "POST", "/api/identities", { name: "fe" });
  const a = client(alice, "be");
  const c = client(carol, "sim");
  for (const x of [a, c]) expect((await x.connect()).type).toBe("hello_ok");

  const up = await upload(alice, "be", "plan.md", "# plan");
  expect(up.body.type).toBe("text/markdown");
  // A client can't name paths for the server to read.
  expect(await a.call("board_post", { board: "eng", body: "x", attachments: ["/etc/hosts"] })).toMatchObject({ type: "error" });
  const posted = await a.call("board_post", { board: "eng", body: "@sim plan attached", attachment_ids: [up.body.id] });
  const info = { id: up.body.id, filename: "plan.md", type: "text/markdown", size: 6, sha256: up.body.sha256 };
  expect(posted.result.attachments).toEqual([info]);
  expect((await c.next(boardPush)).item.post.attachments).toEqual([info]);
  expect((await download(carol, "sim", up.body.id)).status).toBe(200);
  expect((await download(bob, "fe", up.body.id)).status).toBe(404);

  // bob/fe is offline, so the DM stays retractable.
  const note = await upload(alice, "be", "note.txt", "retract me");
  const queued = await a.request({ type: "send", recipient: "bob@example.com/fe", body: "oops", attachment_ids: [note.body.id] });
  expect(queued.delivered_now).toBe(false);
  expect((await a.request({ type: "dm_retract", message_id: queued.message_id })).type).toBe("ack_ok");
  expect((await download(alice, "be", note.body.id)).status).toBe(404);
  expect(srv.app.db.prepare(`SELECT COUNT(*) AS n FROM attachment_blobs WHERE sha256 = ?`).get(note.body.sha256)).toEqual({ n: 0 });

  const big = new Uint8Array(10 * 1024 * 1024).fill(0x61);
  expect((await upload(alice, "be", "big.txt", new Uint8Array(big.length + 1).fill(0x61))).status).toBe(413);
  // 50MB of unsent uploads per user, across their identities.
  for (let i = 0; i < 5; i++) {
    big[0] = 0x62 + i;
    expect((await upload(alice, "be", `big${i}.txt`, big)).status).toBe(201);
  }
  const over = await upload(alice, "be", "one-more.txt", "x");
  expect(over.status).toBe(413);
  expect(over.body.message).toMatch(/unsent uploads would exceed 50MB/);
  expect((await upload(carol, "sim", "theirs.txt", "x")).status).toBe(201);
});

test("a server's own attachment limits: sent in hello_ok, enforced per file, per message and on unsent uploads", async () => {
  restart({ attachmentLimits: { file: 100, total: 150 } });
  const alice = await login("alice@example.com");
  const a = client(alice, "be");
  expect((await a.connect()).attachment_limits).toEqual({ file: 100, total: 150 });

  expect((await upload(alice, "be", "big.txt", "x".repeat(101))).body.message).toBe("file big.txt: 101B exceeds the 100B limit per file");
  expect((await upload(alice, "be", "page.html", "<script>")).body.filename).toBe("page.html.txt");
  const one = await upload(alice, "be", "a.txt", "a".repeat(80));
  const two = await upload(alice, "be", "b.txt", "b".repeat(80));
  expect(await a.request({ type: "send", recipient: "be", body: "both", attachment_ids: [one.body.id, two.body.id] })).toMatchObject({
    type: "error",
    message: "attachments exceed 150B in all",
  });
  // Unsent uploads are capped at twice the per-message total.
  await upload(alice, "be", "c.txt", "c".repeat(80));
  expect((await upload(alice, "be", "d.txt", "d".repeat(80))).body.message).toMatch(/unsent uploads would exceed 300B/);
});

test("a user's stored attachments are capped, sent or not; an upload needs a length; refusals are audited", async () => {
  restart({ attachmentLimits: { file: 100, total: 150 }, attachmentUserQuota: 200 });
  const alice = await login("alice@example.com");
  const a = client(alice, "be");
  await a.connect();
  for (const n of ["a", "b"]) {
    const up = await upload(alice, "be", `${n}.txt`, n.repeat(90));
    expect(await a.request({ type: "send", recipient: "be", body: n, attachment_ids: [up.body.id] })).toMatchObject({ type: "send_ok" });
  }
  const over = await upload(alice, "be", "c.txt", "c".repeat(30));
  expect(over).toMatchObject({ status: 413, body: { message: "your stored attachments would exceed 200B; they're freed as their messages and posts age out" } });
  expect((await upload(alice, "be", "d.txt", "d".repeat(20))).status).toBe(201);

  // A streamed body declares no length.
  const streamed = await fetch(`${srv.base}/api/attachments?as=be&filename=e.txt`, {
    method: "POST",
    headers: { Authorization: `Bearer ${alice}` },
    body: new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode("e")), c.close()) }),
  });
  expect(streamed.status).toBe(411);

  expect(audits("attachment.upload_refused").map((r) => ({ actor: r.actor, ...JSON.parse(r.detail) }))).toEqual([
    { actor: "alice@example.com", identity: "alice@example.com/be", filename: "c.txt", size: 30, reason: over.body.message },
  ]);
});

test("the server reports its version: /healthz and --version", async () => {
  const r = await fetch(`${srv.base}/healthz`);
  expect(await r.json()).toEqual({ ok: true, version: pkg.version });
  // --version answers before the config is loaded, so it needs no server env.
  const p = Bun.spawnSync([process.execPath, SERVER, "--version"], { env: { PATH: process.env.PATH ?? "" } });
  expect(p.exitCode).toBe(0);
  expect(p.stdout.toString().trim()).toBe(pkg.version);
});

// Audits W1, W4 (#345): after a bind, the session still reads as its ID:
// it replies in a thread it received as the ID, and downloads a file DM'd to
// the ID with ?as= its alias. Another user's session's ID never joins the
// set: bob acting as his own alias can't read alice's ID's file.
// Once the session ends, ?as= its ID is refused.
test("after a bind, a session replies to a thread and reads a file it received as its ID", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const a = srv.client(alice, null);
  await a.connect();
  const b = client(bob, "fe");
  await b.connect();
  const up = await upload(bob, "fe", "shot.png", PNG);
  const sent = await b.request({ type: "send", recipient: a.id, body: "for your ID", attachment_ids: [up.body.id] });
  expect(sent.type).toBe("send_ok");
  expect((await a.bind("be")).type).toBe("bind_ok");

  expect(await a.request({ type: "send", recipient: "bob@example.com/fe", body: "got it", parent_id: sent.message_id })).toMatchObject({ type: "send_ok" });
  expect((await download(alice, "alice@example.com/be", up.body.id)).status).toBe(200);
  expect((await download(alice, a.id, up.body.id)).status).toBe(200);
  const other = client(bob, "ops");
  await other.connect();
  expect((await download(bob, "bob@example.com/ops", up.body.id)).status).toBe(404);
  // Nothing acts as an ended session, even its own user (S11).
  expect(await a.request({ type: "end" })).toMatchObject({ type: "end_ok" });
  const gone = await download(alice, a.id, up.body.id);
  expect({ status: gone.status, body: await gone.json() }).toEqual({ status: 403, body: { code: "forbidden", message: expect.stringContaining(`${a.id} ended at`) } });
});

// Audit A7 (#345): a frame still in flight on a connection that left the hub
// (superseded, revoked) is refused, so it can't act for the session's
// successor: an `end` there would end the live session.
test("a frame on a connection that no longer holds its session is refused and acts on nothing", async () => {
  const alice = await login("alice@example.com");
  // #284 port: the WSS adapter keeps the application session on ws.data,
  // so the stale connection is a real one the live client supersedes.
  const out: Any[] = [];
  let closed = false;
  const stale = {
    data: { authed: verifySessionToken(alice, srv.app.repo, createTouchQueue())!, ready: false },
    readyState: 1,
    send: (d: string) => out.push(JSON.parse(d)),
    close: () => { closed = true; },
  };
  const key = "a".repeat(64);
  srv.app.handlers.message(stale as any, JSON.stringify({ type: "hello", req_id: "h", proto: PROTO, session_key: key }));
  await until(() => out.find(m => m.req_id === "h"));
  // Silent to the probe, the stale connection is superseded by its session's restart.
  const live = client(alice, "be", { key });
  await live.connect();
  expect(closed).toBe(true);
  out.length = 0;
  srv.app.handlers.message(stale as any, JSON.stringify({ type: "end", req_id: "e" }));
  expect(out).toEqual([{ type: "error", req_id: "e", code: "superseded", message: "this connection no longer holds its session" }]);
  expect(srv.app.db.prepare(`SELECT ended_at FROM ids WHERE id = ?`).get(live.id)).toEqual({ ended_at: null });
  expect((await live.call("board_list")).type).toBe("call_ok");
});
