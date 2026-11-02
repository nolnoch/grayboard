// The hub (src/server/application.ts) as a connection drives it, at
// application level with no socket (#282): holds, the grace, the probe and
// supersede, revocation closing sessions, resume and replay, hello notices,
// and what hosted MCP can't do yet (#451: resume on a key, `end`, tools-only
// writes_as, an unbound session acting as its ID). A peer that only calls
// tools is a hosted MCP session. Moved from ws.test.ts; tool, board and DM
// semantics are in hosted_tools.test.ts, routes in http_routes.test.ts.
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ReadResult, WhoResult } from "../../src/core/boards.ts";
import type { SendResult } from "../../src/server/application.ts";
import { hashToken } from "../../src/server/auth.ts";
import type { Config } from "../../src/server/config.ts";
import type { Pending } from "../../src/shared/notifications.ts";
import type { AppEvent, AppSession, AppSessionOptions } from "../support/app_session.ts";
import { board, direct } from "../support/events.ts";
import { TestServer } from "../support/server.ts";

const A = "alice@example.com";
const B = "bob@example.com";
const C = "carol@example.com";

// Each test's server, with a short probe so probe tests run fast; inbox
// polling spends hosted requests.
const start = (overrides: Partial<Config> = {}) =>
  new TestServer({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 }, ...overrides }, { probeMs: 150 });
let srv: TestServer;

// A test that needs other config replaces the server.
const restart = async (overrides: Partial<Config> = {}) => {
  await srv.stop();
  srv = start(overrides);
};

beforeEach(() => {
  srv = start();
});

afterEach(() => srv.stop());

const login = (email: string) => srv.login(email);
const api = (token: string, method: string, path: string, body?: unknown) => srv.api(token, method, path, body);
const upload = (token: string, identity: string, filename: string, data: Uint8Array | string) => srv.upload(token, identity, filename, data);

async function connect(token: string, identity: string | null, opts?: AppSessionOptions): Promise<AppSession> {
  const s = srv.appSession(token, identity, opts);
  await s.connect();
  return s;
}

const closed = (e: AppEvent): e is Extract<AppEvent, { kind: "closed" }> => e.kind === "closed";
const postOf = (item: Pending) => {
  if (item.kind !== "push") throw new Error(`expected a push, got a ${item.kind}`);
  return item.post;
};

// A holder's probe that answers only when the test says, and says when it
// began: a client that doesn't pong, with the probe's timeout in the test's
// hands instead of a clock's.
function heldProbe() {
  const started = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<boolean>();
  return {
    probe: () => (started.resolve(), answer.promise),
    started: started.promise,
    answer: answer.resolve,
  };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);

const download = (token: string, identity: string, id: number) =>
  fetch(`${srv.base}/api/attachments/${id}?as=${identity}`, { headers: { Authorization: `Bearer ${token}` } });

const audits = (action: string) =>
  (srv.app.db.prepare(`SELECT actor, target, detail FROM access_log WHERE action = ? ORDER BY at`).all(action) as { actor: string; target: string; detail: string }[]);

// hosted twin: #451 (a reconnect on the session's key)
test("unacked board pushes are resent after reconnect; acked ones aren't", async () => {
  const alice = await login(A);
  await api(alice, "POST", "/api/teams", { name: "eng" });
  const a = await srv.hosted(A, "be");
  const s = await connect(alice, "sim");

  await a.call("board_post", { board: "eng", body: "@sim ping" });
  const first = await s.next(board());
  s.close();

  // A reconnect is the same session: its key.
  const s2 = await connect(alice, "sim", { key: s.key });
  const again = await s2.next(board());
  expect(postOf(again.item).id).toBe(postOf(first.item).id);
  await s2.boardAck([{ kind: "push", post_id: postOf(again.item).id }]);
  s2.close();

  const s3 = await connect(alice, "sim", { key: s.key });
  await s3.none(board());
});

// hosted twin: #451 (a resume on the session's key; end)
test("peer_list shows where the client says it runs; a resumed hello keeps the status, a new session clears it", async () => {
  const alice = await login(A);
  const watcher = await srv.hosted(B, "fe");
  const be = async () => (await watcher.call<WhoResult>("peer_list", { include_offline: true })).peers.find((p) => p.handle === `${A}/be`)!;

  // One session: a resume keeps the status only under the session ID that last bound the name (#211).
  const key = "c1".repeat(32);
  const first = await connect(alice, "be", { key, hello: { where: "api worktree stream \n on stream" } });
  await first.call("peer_status", { text: "soaking" });
  expect(await be()).toMatchObject({ where: "api worktree stream on stream", status: "soaking" });

  first.close();
  const resumed = await connect(alice, "be", { key, hello: { where: "api worktree stream on main", resume: true } });
  expect(await be()).toMatchObject({ where: "api worktree stream on main", status: "soaking" });

  // A session that ends frees the alias; the next one starts its own status.
  await resumed.end();
  resumed.close();
  await connect(alice, "be");
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
  const c = await connect(carol, "sim");

  await expect(a.call("dm_send", { to: "team:eng", body: "standup in 5" })).rejects.toMatchObject({
    message: "team:eng isn't a person; to reach a team, board_post to its board #eng",
  });
  // A digest never wakes a session by itself; it arrives with the next hello.
  await a.call("board_post", { board: "eng", body: "standup in 5" });
  await c.none(board());
  c.close();
  const c2 = await connect(carol, "sim", { key: c.key });
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

test("revoking or disabling a user closes their open connections; the heartbeat catches a disable it missed", async () => {
  await restart({ admins: ["root@example.com"] });
  const [root, alice] = await Promise.all([login("root@example.com"), login(A)]);
  const a = await connect(alice, "be");

  let pass = 0;
  for (const path of ["/api/admin/revoke-session", "/api/admin/disable-user"]) {
    await api(root, "POST", "/api/admin/enable-user", { email: B });
    const bob = await login(B);
    const live = srv.appSession(bob, "be");
    const tools = srv.appSession(bob, "fe", { push: false });
    await Promise.all([live.connect(), tools.connect()]);
    expect((await api(root, "POST", path, { email: B })).status).toBe(200);
    expect(await live.next(closed)).toMatchObject({ code: "unauthenticated" });
    await tools.next(closed);
    expect(audits("auth.connection_closed").filter((r) => JSON.parse(r.detail).why === "user_signed_out")).toHaveLength(2 * ++pass);
  }
  await a.call("board_list");

  // Disabled behind the server's back (no admin route): the next tick closes it.
  await api(root, "POST", "/api/admin/enable-user", { email: B });
  const late = await connect(await login(B), "be");
  srv.app.repo.users.setDisabled(srv.app.repo.users.findByEmail(B)!.id, true);
  srv.app.revalidate();
  await late.next(closed);
  await a.call("board_list");
});

// #351: a logout revokes one token. Its connections close and their sessions
// end; the same user's other token keeps its own.
test("logout closes only that token's connections and ends only their sessions, audited", async () => {
  const [tokenA, tokenB] = [await login(A), await login(A)];
  const a1 = srv.appSession(tokenA, "be");
  const a2 = srv.appSession(tokenA, "fe", { push: false });
  const b = srv.appSession(tokenB, "sim");
  await Promise.all([a1.connect(), a2.connect(), b.connect()]);
  const sidA = srv.app.repo.sessions.findByTokenHash(hashToken(tokenA))!.id;

  expect((await api(tokenA, "POST", "/api/auth/logout")).status).toBe(200);
  expect(await a1.next(closed)).toMatchObject({ code: "unauthenticated" });
  expect(await a2.next(closed)).toMatchObject({ code: "unauthenticated" });

  await b.call("board_list");
  const ended = (id: string) => srv.app.db.query(`SELECT ended_at FROM ids WHERE id = ?`).get(id) as { ended_at: number | null };
  expect(ended(a1.id).ended_at).not.toBeNull();
  expect(ended(a2.id).ended_at).not.toBeNull();
  expect(ended(b.id).ended_at).toBeNull();
  const closes = audits("auth.connection_closed").map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
  expect(closes.map((r) => r.target).sort()).toEqual([a1.id, a2.id].sort());
  for (const r of closes) expect(r).toMatchObject({ actor: A, detail: { why: "logout" } });
  for (const r of closes) expect(r.detail.token_session).toBe(sidA);
  expect(srv.app.repo.sessions.findById(sidA)!.revoked_at).not.toBeNull();
  expect(audits("id.ended").filter((r) => JSON.parse(r.detail).why === "signed_out").map((r) => r.target).sort()).toEqual([a1.id, a2.id].sort());
});

// A session in its grace has no connection, so only the token it last said
// hello under (ids.token_session) finds it.
test("logout ends the token's sessions in their grace too, and a resume on them is refused", async () => {
  const [tokenA, tokenC] = [await login(A), await login(A)];
  const a = await connect(tokenA, "be");
  a.close();
  expect(audits("id.detached")).toHaveLength(1);
  expect((await api(tokenA, "POST", "/api/auth/logout")).status).toBe(200);
  expect(srv.app.db.query(`SELECT ended_at FROM ids WHERE id = ?`).get(a.id)).toEqual({ ended_at: expect.any(Number) });
  expect(audits("id.ended").map((r) => ({ target: r.target, why: JSON.parse(r.detail).why }))).toEqual([{ target: a.id, why: "signed_out" }]);

  const back = srv.appSession(tokenC, "be", { key: a.key, hello: { resume: true } });
  await expect(back.connect()).rejects.toMatchObject({ code: "id_collision" });
});

// A session signed in with a token that is revoked before its hello (the
// WSS upgrade checked the token; appSession resolves it the same way) is in
// no registry, so only the hello can refuse it. ws.test.ts keeps the raw
// socket's half until #282 PR 2.
test("a hello on a token revoked since the upgrade is refused, registers nothing, and is audited", async () => {
  const token = await login(A);
  const s = srv.appSession(token, null, { key: "ab".repeat(32) });
  expect((await api(token, "POST", "/api/auth/logout")).status).toBe(200);
  await expect(s.connect()).rejects.toMatchObject({ code: "unauthenticated" });
  expect(srv.app.db.query(`SELECT COUNT(*) AS n FROM ids`).get()).toEqual({ n: 0 });
  const rows = audits("auth.hello_refused").map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ actor: A, detail: { why: "token_revoked" } });
});

test("a hello from a user disabled since the upgrade is refused, registers nothing, and is audited", async () => {
  const token = await login(A);
  const s = srv.appSession(token, null, { key: "cd".repeat(32) });
  srv.app.repo.users.setDisabled(srv.app.repo.users.findByEmail(A)!.id, true);
  await expect(s.connect()).rejects.toMatchObject({ code: "unauthenticated" });
  expect(srv.app.db.query(`SELECT COUNT(*) AS n FROM ids`).get()).toEqual({ n: 0 });
  expect(audits("auth.hello_refused").map((r) => JSON.parse(r.detail).why)).toEqual(["user_disabled"]);
});

test("a token revoked while its hello probes a silent holder neither takes the session over nor registers", async () => {
  const [tokenA, tokenB] = [await login(A), await login(A)];
  const silent = heldProbe();
  const holder = await connect(tokenB, "be", { probe: silent.probe });
  const hello = srv.appSession(tokenA, "be", { key: holder.key }).connect().catch((e) => e);
  await silent.started; // the probe is under way
  expect((await api(tokenA, "POST", "/api/auth/logout")).status).toBe(200);
  silent.answer(false);
  expect(await hello).toMatchObject({ code: "unauthenticated" });
  expect(audits("id.superseded")).toEqual([]);
  expect(audits("auth.hello_refused")).toHaveLength(1);
  // The holder is still the session's connection.
  expect(holder.events.filter(closed)).toEqual([]);
  await holder.call("board_list");
});

// The wait for another hello's probe is an await too: a token revoked during
// it must not go on to probe the new holder and collide as if it were live.
test("a token revoked while its hello waits on another hello's probe is refused, not collided", async () => {
  const [tokenA, tokenB] = [await login(A), await login(A)];
  const silent = heldProbe();
  const holder = await connect(tokenB, "be", { probe: silent.probe });
  const first = srv.appSession(tokenB, "be", { key: holder.key }).connect(); // probes the silent holder
  await silent.started;
  // application.hello awaits nothing before the probe's wait, so the second
  // hello is waiting on the first's probe once its connect() is called.
  const second = srv.appSession(tokenA, "be", { key: holder.key }).connect().catch((e) => e);
  expect((await api(tokenA, "POST", "/api/auth/logout")).status).toBe(200);
  silent.answer(false);
  expect(await second).toMatchObject({ code: "unauthenticated" });
  expect(await first).toMatchObject({ id: holder.id });
  expect(audits("id.collision")).toEqual([]);
});

test("the heartbeat closes a revoked token's connections when no route said so, leaving the user's other token", async () => {
  const [tokenA, tokenB] = [await login(A), await login(A)];
  const a = srv.appSession(tokenA, "be");
  const b = srv.appSession(tokenB, "fe");
  await Promise.all([a.connect(), b.connect()]);
  srv.app.repo.sessions.revoke(srv.app.repo.sessions.findByTokenHash(hashToken(tokenA))!.id);
  srv.app.revalidate();
  await a.next(closed);
  expect(audits("auth.connection_closed").map((r) => JSON.parse(r.detail).why)).toEqual(["token_revoked"]);
  await b.call("board_list");
});

test("an alias a live session holds refuses another session's bind", async () => {
  const alice = await login(A);
  const first = await connect(alice, "be");
  const second = srv.appSession(alice, "be");
  await expect(second.connect()).rejects.toMatchObject({ code: "alias_held", extra: { holder: `the session ${first.id}` } });
  // The first connection still works.
  await first.call("board_list");
});

test("a connection that doesn't answer the probe is replaced, audited id.superseded with both places", async () => {
  const alice = await login(A);
  const stale = await connect(alice, "be", { probe: "silent", hello: { where: "old box" } });
  // A place is cleaned once, before any audit carries it (audit S6).
  await connect(alice, "be", { key: stale.key, hello: { where: "  new\n box " } });
  expect(await stale.next(closed)).toMatchObject({ code: "superseded" });
  const rows = srv.app.db.prepare(`SELECT actor, target, detail FROM access_log WHERE action = 'id.superseded'`).all() as { actor: string; target: string; detail: string }[];
  expect(rows.map((r) => ({ ...r, detail: JSON.parse(r.detail) }))).toEqual([
    { actor: A, target: stale.id, detail: { old_place: "old box", place: "new box" } },
  ]);
});

// Audit S2 (#345), the hub's half: a hello whose connection closed while it
// awaited the probe is refused and never supersedes the holder. ws.test.ts
// keeps the socket's own guard (a second hello on one connection).
test("a hello whose connection closes during its probe is refused and supersedes nothing", async () => {
  const alice = await login(A);
  const silent = heldProbe();
  const dead = await connect(alice, "be", { probe: silent.probe });
  const closing = srv.appSession(alice, "be", { key: dead.key });
  const first = closing.connect();
  await silent.started;
  closing.close();
  silent.answer(false);
  await expect(first).rejects.toMatchObject({ code: "unauthenticated", message: "session is closed" });
  await dead.none(closed, 300);
  expect(audits("id.superseded")).toEqual([]);
});

// Audit S1 (#345): a re-attach is the session its row registered: a
// tools-only hello on a push session's key, or a push hello on a tools-only
// session's, is id_collision, refused before the probe, so it never
// supersedes the holder.
// hosted twin: #451 (tools-only writes_as)
test("a re-attach whose writes_as differs from the session's row is id_collision and supersedes nothing", async () => {
  const alice = await login(A);
  const holder = await connect(alice, "be", { probe: "silent" });
  const sidecar = srv.appSession(alice, "be", { key: holder.key, push: false });
  await expect(sidecar.connect()).rejects.toMatchObject({
    code: "id_collision", message: expect.stringContaining(`registered writing as its own addresses, and this hello writes as "${A}/be"`),
  });
  await holder.none(closed, 300);

  const writer = await connect(alice, "fe", { push: false });
  writer.close();
  const pushed = srv.appSession(alice, "fe", { key: writer.key });
  await expect(pushed.connect()).rejects.toMatchObject({ code: "id_collision", message: expect.stringContaining(`registered writing as "${A}/fe"`) });
  const audited = srv.app.db.prepare(`SELECT target FROM access_log WHERE action = 'id.collision' ORDER BY id`).all();
  expect(audited).toEqual([{ target: holder.id }, { target: writer.id }]);
});

test("a hello arriving while another probes the holder waits for it, so only one wins", async () => {
  const alice = await login(A);
  await login(B);
  const silent = heldProbe();
  const dead = await connect(alice, "be", { probe: silent.probe });
  const n1 = srv.appSession(alice, "be", { key: dead.key });
  const first = n1.connect(); // probes the dead holder
  await silent.started;
  dead.close(); // the holder goes away mid-probe
  const second = srv.appSession(alice, "be", { key: dead.key }).connect().catch((e) => e);
  silent.answer(false);
  expect(await first).toMatchObject({ id: dead.id });
  expect(await second).toMatchObject({ code: "id_collision" });

  const b = await srv.hosted(B, "fe");
  expect(await b.call<SendResult>("dm_send", { to: `${A}/be`, body: "who?" })).toMatchObject({ delivered_now: true });
  expect((await n1.next(direct())).message.body).toBe("who?");
});

// An AppSession: hosted bind and initialize carry no notices today.
test("hello_ok carries active claims and DMs undelivered after a day", async () => {
  const alice = await login(A);
  const bob = await login(B);
  const b = await connect(bob, "fe");
  b.close();
  const a = srv.appSession(alice, "be");
  expect((await a.connect()).notices).toBeUndefined();
  await a.call("claim_take", { key: "ticket:ENG-2", note: "on it" });
  const old = await a.send(`${B}/fe`, "stale");
  await a.send(`${B}/fe`, "fresh");
  srv.app.db.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(Date.now() - 2 * 86_400_000, old.message_id);
  a.close();

  const notices = (await srv.appSession(alice, "be", { key: a.key }).connect()).notices!;
  expect(notices).toHaveLength(2);
  expect(notices[0]).toContain(`${B}/fe: 1 since message_id ${old.message_id} (last seen`);
  expect(notices[1]).toMatch(/Yours: ticket:ENG-2 \(until \d{4}-\d\d-\d\dT\d\d:\d\dZ: on it\)\./);
  expect((await srv.appSession(alice, "sim").connect()).notices![0]).toContain("Others': ticket:ENG-2.");
});

// Audit F2 (#345): bind_ok's notices cover the session's whole address set,
// so a claim taken as the ID before the bind is still listed as its own.
// hosted twin: #451 (an unbound session acting as its ID)
test("bind_ok's notices list the claims the session took as its ID before the bind", async () => {
  const alice = await login(A);
  const a = await connect(alice, null);
  await a.call("claim_take", { key: "ticket:ENG-3", note: "as the ID" });
  const b = await a.bind("be");
  expect(b.notices!.at(-1)).toMatch(/Yours: ticket:ENG-3 \(until [^)]*: as the ID\)\./);
});

// Audit W2 (#345): deleting an identity would drop its holds under a live
// holder, and a second session could then bind it: refused while in use.
// hosted twin: #451 (end; tools-only writes_as)
test("an identity a session holds or writes as can't be deleted until those sessions end", async () => {
  const alice = await login(A);
  const a = await connect(alice, "be");
  const sidecar = await connect(alice, "be", { push: false });
  expect(await api(alice, "DELETE", "/api/identities/be")).toEqual({ status: 409, body: { code: "alias_held", message: expect.stringContaining("is in use by the session") } });
  await a.end();
  expect(await api(alice, "DELETE", "/api/identities/be")).toEqual({ status: 409, body: { code: "alias_held", message: expect.stringContaining(sidecar.id) } });
  await sidecar.end();
  expect(await api(alice, "DELETE", "/api/identities/be")).toEqual({ status: 200, body: { ok: true } });
});

// hosted twin: #451 (tools-only writes_as)
test("a tools-only connection works beside the live owner without taking its pushes", async () => {
  const alice = await login(A);
  const owner = await connect(alice, "be");
  const tools = await connect(alice, "be", { push: false });
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
// it replies in a thread it received as the ID, and downloads a file DM'd to
// the ID with ?as= its alias. Another user's session's ID never joins the
// set: bob acting as his own alias can't read alice's ID's file.
// Once the session ends, ?as= its ID is refused.
// hosted twin: #451 (an unbound session acting as its ID; end)
test("after a bind, a session replies to a thread and reads a file it received as its ID", async () => {
  const alice = await login(A);
  const bob = await login(B);
  const a = await connect(alice, null);
  const b = await srv.hosted(B, "fe");
  const up = await upload(bob, "fe", "shot.png", PNG);
  const sent = await b.call<SendResult>("dm_send", { to: a.id, body: "for your ID", attachment_ids: [up.body.id] });
  await a.bind("be");

  await a.send(`${B}/fe`, "got it", { parent_id: sent.message_id });
  expect((await download(alice, `${A}/be`, up.body.id)).status).toBe(200);
  expect((await download(alice, a.id, up.body.id)).status).toBe(200);
  await srv.hosted(B, "ops");
  expect((await download(bob, `${B}/ops`, up.body.id)).status).toBe(404);
  // Nothing acts as an ended session, even its own user (S11).
  await a.end();
  const gone = await download(alice, a.id, up.body.id);
  expect({ status: gone.status, body: await gone.json() }).toEqual({ status: 403, body: { code: "forbidden", message: expect.stringContaining(`${a.id} ended at`) } });
});

// Audit A7 (#345): an operation still in flight on a connection that left
// the hub (superseded, revoked) is refused, so it can't act for the
// session's successor: an `end` there would end the live session.
test("a frame on a connection that no longer holds its session is refused and acts on nothing", async () => {
  const alice = await login(A);
  const key = "a".repeat(64);
  const stale = await connect(alice, null, { key, probe: "silent" });
  // Silent to the probe, the stale connection is superseded by its session's restart.
  const live = await connect(alice, "be", { key });
  expect(await stale.next(closed)).toMatchObject({ code: "superseded" });
  await expect(stale.end()).rejects.toMatchObject({ code: "superseded", message: "this connection no longer holds its session" });
  expect(srv.app.db.prepare(`SELECT ended_at FROM ids WHERE id = ?`).get(live.id)).toEqual({ ended_at: null });
  await live.call("board_list");
});
