// stop() waits out a request already in flight before it closes the store (#218): an /api route paused between two
// reads (testPause "http:team-members:between") resumes on an open store and answers, rather than throwing "Database
// has closed" into the error handler. A request that never settles is bounded by the drain deadline, whose error
// names it.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestServer } from "../support/server.ts";
import { until } from "../support/until.ts";
import { exec, row } from "../support/repo_sql.ts";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { issueOAuth } from "../helpers/oauth.ts";
import { OPENCODE_CLIENT, OPENCODE_SESSION_META } from "../../src/server/oauth-config.ts";
import { bindFixture, withMeta } from "../helpers/hosted.ts";
import { sessionContext } from "../../src/server/hosted.ts";

const A = "alice@example.com";
const POINT = "http:team-members:between";

let dir: string;
let release: string;
let logs: string[];
let log: ReturnType<typeof spyOn>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gb-stop-quiesce-"));
  release = join(dir, "release");
  logs = [];
  log = spyOn(console, "error").mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
});
// A test that failed while it held a pause releases it here, and waits for the held work to leave the pause before its
// dir goes: abandoned, that work would fail into the next test's logs and fail it too.
afterEach(async () => {
  writeFileSync(release, "release");
  const count = (what: string) => logs.filter(l => l.startsWith(`[grayboard] test pause ${what}:`)).length;
  try {
    await until(() => count("released") >= count("hit"), 5000, "the held work left its pause");
  } finally {
    delete process.env.BUS_TEST_PAUSE; delete process.env.BUS_TEST_PAUSE_FILE;
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Opens a server with a team, then starts a roster read held at POINT. Returns the server, the read, and a flag that
// turns true once the store's close is called.
async function heldRead(opts: { stopDrainMs?: number } = {}) {
  const srv = await TestServer.open({}, opts);
  const token = await srv.login(A);
  expect((await srv.api(token, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
  const closed = { at: 0 };
  const close = srv.app.repo.close.bind(srv.app.repo);
  spyOn(srv.app.repo, "close").mockImplementation(() => { closed.at ||= performance.now(); return close(); });
  process.env.BUS_TEST_PAUSE = POINT; process.env.BUS_TEST_PAUSE_FILE = release;
  const read = srv.api(token, "GET", "/api/teams/eng/members").then(res => ({ res, at: performance.now() }), (error: unknown) => ({ error, at: performance.now() }));
  await until(() => logs.includes(`[grayboard] test pause hit: ${POINT}`), 5000, "the roster read reached its pause");
  return { srv, read, closed };
}

test("stop() waits for a request in flight before it closes the store", async () => {
  const { srv, read, closed } = await heldRead();
  let stoppedAt = 0;
  const stopping = srv.app.stop().then(() => { stoppedAt = performance.now(); });
  void stopping.catch(() => {});
  // Either stop says it waits for the request, or (without the drain) it has gone on to close the store.
  await until(() => closed.at || logs.some(l => l.startsWith("[grayboard] stopping: waiting for 1 request")), 5000, "stop waits or closes the store");
  expect(closed.at).toBe(0);
  expect(logs.find(l => l.startsWith("[grayboard] stopping: waiting for 1 request"))).toContain("GET /api/teams/eng/members");
  writeFileSync(release, "release");
  await stopping;
  // The connection was closed under it, so the client may see no answer; the server must not have failed it.
  await read;
  expect(closed.at).toBeGreaterThan(0);
  expect(closed.at).toBeLessThanOrEqual(stoppedAt);
  expect(logs.filter(l => l.includes("request failed") || /closed/i.test(l) && !l.includes("stopping"))).toEqual([]);
  await srv.stop();
});

test("stop()'s drain deadline names the request that never finished, and the store still closes", async () => {
  const { srv, closed } = await heldRead({ stopDrainMs: 50 });
  await expect(srv.app.stop()).rejects.toThrow(/stop: 1 request never finished within 50 ms: GET \/api\/teams\/eng\/members/);
  // main.ts redacts a failed stop's error, so the drain says what it waited for on its own.
  expect(logs).toContain("[grayboard] stop: 1 request never finished within 50 ms: GET /api/teams/eng/members");
  expect(closed.at).toBeGreaterThan(0);
  writeFileSync(release, "release");
  await srv.stop().catch(() => {});
});

// #1489: stop() waits out a background pass already running as it does a request: a revalidate pass paused between
// its users reads and its alias recheck (a queued write), and the retention pass paused between two prunes. Without
// the wait the store closes under them and the pass resumes onto it ("Database has closed").
async function closeSpy(srv: TestServer) {
  const closed = { at: 0 };
  const close = srv.app.repo.close.bind(srv.app.repo);
  spyOn(srv.app.repo, "close").mockImplementation(() => { closed.at ||= performance.now(); return close(); });
  return closed;
}
function hold(point: string) {
  process.env.BUS_TEST_PAUSE = point; process.env.BUS_TEST_PAUSE_FILE = release;
}

test("stop() waits for a revalidate pass already running before it closes the store", async () => {
  const srv = await TestServer.open();
  const closed = await closeSpy(srv);
  hold("revalidate:between");
  const pass = srv.app.revalidate().then(() => undefined, (error: unknown) => error);
  await until(() => logs.includes("[grayboard] test pause hit: revalidate:between"), 5000, "the revalidate pass reached its pause");
  const stopping = srv.app.stop();
  void stopping.catch(() => {});
  await until(() => closed.at || logs.some(l => l.startsWith("[grayboard] stopping: waiting for") && l.includes("revalidate pass")), 5000, "stop waits or closes the store");
  expect(closed.at).toBe(0);
  writeFileSync(release, "release");
  await stopping;
  // It finished on the open store: its alias recheck's write committed rather than failing on a closed one.
  expect(await pass).toBeUndefined();
  expect(closed.at).toBeGreaterThan(0);
  // A pass asked for once stop has begun doesn't start (it would fail on the closed store, logged).
  await srv.app.revalidate();
  expect(logs.filter(l => /closed|failed/i.test(l) && !l.includes("stopping"))).toEqual([]);
  await srv.stop();
});

test("stop() waits for the retention pass already running, skips its remaining steps, then closes the store", async () => {
  hold("retention:between");
  const srv = await TestServer.open({}, { background: true, retentionFirstDelayMs: 0 });
  const closed = await closeSpy(srv);
  await until(() => logs.includes("[grayboard] test pause hit: retention:between"), 5000, "the retention pass reached its pause");
  // An audit row long past retention, written once the pass is past its messages step: the audit step, still to come,
  // would prune it.
  await exec(srv, "INSERT INTO access_log (at, actor, action, target, detail) VALUES (?, NULL, ?, NULL, NULL)", 1, "test.expired");
  const stopping = srv.app.stop();
  void stopping.catch(() => {});
  await until(() => closed.at || logs.some(l => l.startsWith("[grayboard] stopping: waiting for") && l.includes("retention pass")), 5000, "stop waits or closes the store");
  expect(closed.at).toBe(0);
  writeFileSync(release, "release");
  await stopping;
  expect(closed.at).toBeGreaterThan(0);
  expect(logs.filter(l => /closed|failed/i.test(l) && !l.includes("stopping"))).toEqual([]);
  // The pass skipped its remaining steps: the row is still there.
  await srv.stop({ keep: true });
  const reopened = await TestServer.open({}, { reuse: srv });
  try {
    expect(await row(reopened, "SELECT action FROM access_log WHERE action = ?", "test.expired")).toEqual({ action: "test.expired" });
  } finally { await reopened.stop(); }
});

test("stop()'s drain deadline names the background pass that never finished, and the store still closes", async () => {
  hold("retention:between");
  const srv = await TestServer.open({}, { background: true, retentionFirstDelayMs: 0, stopDrainMs: 50 });
  const closed = await closeSpy(srv);
  await until(() => logs.includes("[grayboard] test pause hit: retention:between"), 5000, "the retention pass reached its pause");
  await expect(srv.app.stop()).rejects.toThrow(/stop: 1 background pass never finished within 50 ms: retention pass/);
  expect(logs).toContain("[grayboard] stop: 1 background pass never finished within 50 ms: retention pass");
  expect(closed.at).toBeGreaterThan(0);
  writeFileSync(release, "release");
  // Released before the test's dir goes, or the pass would see its pause abandoned.
  await until(() => logs.includes("[grayboard] test pause released: retention:between"), 5000, "the retention pass left its pause");
  await srv.stop().catch(() => {});
});

// A write nobody awaits (a request's post, the OAuth sweep's cleanup, a Slack row) can still sit in the write queue
// once the requests and passes are done: stop() closes the store only once a write queued behind it has run. Queued
// here while stop() drains a request, so after hosted MCP's closing heartbeat, which would otherwise wait it out.
test("stop() waits for writes queued and not awaited before it closes the store", async () => {
  const { srv, read, closed } = await heldRead();
  const stopping = srv.app.stop();
  void stopping.catch(() => {});
  await until(() => logs.some(l => l.startsWith("[grayboard] stopping: waiting for 1 request")), 5000, "stop drains the request");
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const held = srv.app.repo.write(() => gate);
  let posted = false;
  srv.app.repo.post(tx => srv.app.repo.users.findById(tx, 1).then(() => { posted = true; }), undefined, "test post");
  // The write stop queues behind them, once the request is done.
  let queued = false;
  const write = srv.app.repo.write.bind(srv.app.repo);
  spyOn(srv.app.repo, "write").mockImplementation(((...args: unknown[]) => { queued = true; return (write as (...a: unknown[]) => unknown)(...args); }) as typeof write);
  writeFileSync(release, "release");
  await read;
  await until(() => closed.at || queued, 5000, "stop queues its write or closes the store");
  expect(closed.at).toBe(0);
  finish();
  await held;
  await stopping;
  expect(posted).toBe(true);
  expect(closed.at).toBeGreaterThan(0);
  expect(logs.filter(l => /closed|failed/i.test(l) && !l.includes("stopping"))).toEqual([]);
  await srv.stop();
});

// #1493: the work a commit or a pass starts and nobody awaits is background work stop() waits for as it does a pass:
// a claim expiry sweep's board change and wake, the same fan-out an HTTP route or the retention pass starts, and the
// wake and blob sweep after a session's end. Each is held at a testPause point inside it; without the wait the store
// closes under it and its reads resume onto it. Once stop has begun, none starts.
const pauseHits = (point: string) => logs.filter(l => l === `[grayboard] test pause hit: ${point}`).length;

// stop() while `point` holds background work named `name`: it waits, names it, and closes the store only after.
async function stopAround(srv: TestServer, closed: { at: number }, point: string, name: string, meanwhile?: () => void) {
  await until(() => pauseHits(point) > 0, 5000, `the ${name} reached its pause`);
  const stopping = srv.app.stop();
  void stopping.catch(() => {});
  await until(() => closed.at || logs.some(l => l.startsWith("[grayboard] stopping: waiting for")), 5000, "stop waits or closes the store");
  expect(closed.at).toBe(0);
  expect(logs.find(l => l.startsWith("[grayboard] stopping: waiting for"))).toContain(name);
  meanwhile?.();
  writeFileSync(release, "release");
  await stopping;
  expect(closed.at).toBeGreaterThan(0);
  expect(logs.filter(l => /closed|failed/i.test(l) && !l.includes("stopping"))).toEqual([]);
}

for (const { point, name } of [
  { point: "board-change:observers-read", name: "claim expiry board change" },
  // Held inside the subscriber's drain, before its read: the wake's tracked promise is its drains'.
  { point: "server:drain-boards:before-read", name: "claim expiry wake" },
]) {
  const boards = name.endsWith("board change");
  test(`stop() waits for a claim expiry sweep's ${name.slice("claim expiry ".length)}${boards ? ", and starts no other once stopping" : ""}`, async () => {
    const srv = await TestServer.open();
    const token = await srv.login(A);
    const be = await srv.connected(token, "be");
    await be.call("board_create", { name: "lobby", purpose: "general" });
    await be.call("claim_take", { key: "soon", board: "lobby", ttl_minutes: 60 });
    // A push subscriber, so the lapse's post wakes someone.
    const qa = await srv.connected(token, "qa");
    await qa.call("board_subscribe", { board: "lobby", mode: "push" });
    await be.call("claim_list");
    const closed = await closeSpy(srv);
    hold(point);
    await exec(srv, "UPDATE claims SET expires_at = ? WHERE key = 'soon'", Date.now() + 200);
    // A call re-arms the timer at the new expiry; it changes no board and wakes nobody.
    await be.call("claim_list");
    // A board change asked for once stop has begun is skipped, so it never reaches the same pause.
    await stopAround(srv, closed, point, name, boards ? () => srv.app.application.boardsChanged(["lobby"]) : undefined);
    // The drain reads once per address of the subscriber's (its alias and its ID), each read held at the pause.
    if (boards) expect(pauseHits(point)).toBe(1);
    await srv.stop();
  });
}

for (const { point, name, start } of [
  { point: "board-change:observers-read", name: "board change", start: (srv: TestServer) => srv.app.application.boardsChanged(["lobby"]) },
  { point: "background:wake", name: "wake", start: (srv: TestServer) => srv.app.application.wake([]) },
]) {
  test(`stop() waits for a ${name} fan-out a route or the retention pass started`, async () => {
    const srv = await TestServer.open();
    const closed = await closeSpy(srv);
    hold(point);
    start(srv);
    await stopAround(srv, closed, point, name);
    await srv.stop();
  });
}

for (const { point, name } of [
  { point: "blobs:listed", name: "blob sweep" },
  { point: "background:session end wake", name: "session end wake" },
]) {
  test(`stop() waits for the ${name} after a restart ends a leftover session`, async () => {
    let srv = await TestServer.open();
    await srv.connected(await srv.login(A), "be");
    hold(point);
    // The restart ends the session the first run left: its wake and blob sweep follow the end's commit.
    srv = await srv.restart();
    const closed = await closeSpy(srv);
    await stopAround(srv, closed, point, name);
    await srv.stop();
  });
}

// #1496: the effects a request's own transaction schedules for after its commit (a post's or a call's board change and
// wakes, the blob sweep after a retract or a replay that released uploads) are background work stop() waits for as it
// does a pass's, and skips once stopping. Each is held at a testPause point inside it.
for (const { point, name } of [
  { point: "board-change:observers-read", name: "post board change" },
  // Held inside the drain of the subscriber the post wakes, before its read.
  { point: "server:drain-boards:before-read", name: "post wake" },
]) {
  const boards = name.endsWith("board change");
  test(`stop() waits for the ${name} a board_post's commit starts${boards ? ", and starts no other once stopping" : ""}`, async () => {
    const srv = await TestServer.open();
    const token = await srv.login(A);
    const be = await srv.connected(token, "be");
    await be.call("board_create", { name: "lobby", purpose: "general" });
    const qa = await srv.connected(token, "qa");
    await qa.call("board_subscribe", { board: "lobby", mode: "push" });
    const closed = await closeSpy(srv);
    hold(point);
    await be.call("board_post", { board: "lobby", body: "first" });
    // A post that commits once stop has begun: its effect is skipped, so it never reaches the same pause.
    let late: Promise<unknown> = Promise.resolve();
    await stopAround(srv, closed, point, name, () => { late = be.call("board_post", { board: "lobby", body: "second" }); });
    await late;
    // The drain reads once per address of the subscriber's, each read held at the pause.
    if (boards) expect(pauseHits(point)).toBe(1);
    await srv.stop();
  });
}

for (const { point, name } of [
  { point: "board-change:observers-read", name: "call board change" },
  { point: "server:drain-boards:before-read", name: "call wake" },
]) {
  test(`stop() waits for the ${name} a board tool call's commit starts`, async () => {
    const srv = await TestServer.open();
    const token = await srv.login(A);
    const be = await srv.connected(token, "be");
    await be.call("board_create", { name: "lobby", purpose: "general" });
    const qa = await srv.connected(token, "qa");
    await qa.call("board_subscribe", { board: "lobby", mode: "push" });
    const closed = await closeSpy(srv);
    hold(point);
    // A claim take announces on the board: a board change, and a wake for its subscriber.
    await be.call("claim_take", { key: "work", board: "lobby", ttl_minutes: 60 });
    await stopAround(srv, closed, point, name);
    await srv.stop();
  });
}

test("stop() waits for the blob sweep a dm_retract's commit starts", async () => {
  const srv = await TestServer.open({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 } });
  const B = "bob@example.com";
  const fe = await srv.hosted(B, "fe");
  await fe.close();
  const be = await srv.hosted(A, "be");
  const first = await be.call<{ message_id: number }>("dm_send", { to: `${B}/fe`, body: "first" });
  const closed = await closeSpy(srv);
  hold("blobs:listed");
  await be.call("dm_retract", { message_id: first.message_id });
  // Closed first: stop() shuts the HTTP listener, and a hosted session's own requests would then fail.
  await be.close();
  await stopAround(srv, closed, "blobs:listed", "blob sweep");
  await srv.stop();
});

test("stop() waits for the blob sweep a replayed board_post's commit starts", async () => {
  const srv = await TestServer.open({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 } });
  const be = await srv.hosted(A, "be");
  await be.call("board_create", { name: "lobby", purpose: "general" });
  const one = await be.upload("a.txt", "same bytes");
  await be.call("board_post", { board: "lobby", body: "with a file", attachment_ids: [one] });
  // The retry uploaded its file afresh: the replay releases it, and the sweep follows the commit.
  const two = await be.upload("a.txt", "same bytes");
  const closed = await closeSpy(srv);
  hold("blobs:listed");
  const retry = await be.call<{ replayed?: unknown }>("board_post", { board: "lobby", body: "with a file", attachment_ids: [two] });
  expect(retry.replayed).toBeDefined();
  await be.close();
  await stopAround(srv, closed, "blobs:listed", "blob sweep");
  await srv.stop();
});

// #1506: a native hosted session's board watch runs a live check on each change to the board, after the change's commit
// and unawaited by it: background work "resource watch check" stop() waits for, under its drain deadline, as it does a
// pass's. Held at "resources:live:checked", between the check's token read and its board read.
async function heldWatchCheck(opts: { stopDrainMs?: number } = {}) {
  const srv = await TestServer.open({ publicUrl: "https://grayboard.example.com" }, { hostname: "127.0.0.1", ...opts });
  const base = `http://127.0.0.1:${srv.app.server.port}`;
  const { token } = await issueOAuth(srv.app.repo, srv.app.oauth.resource, A, ["grayboard:tools", "grayboard:delivery"], Date.now(), OPENCODE_CLIENT);
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  const principal = await srv.app.oauth.authenticate(new Request(base + "/mcp", { headers }));
  if (principal instanceof Response) throw new Error("fixture authentication failed");
  await srv.app.mcp.sessions.bind(principal, sessionContext(principal, { "ai.opencode/sessionID": "be" }), { name: "be", create: true });
  const version = "2026-07-28";
  const client = new Client({ name: "stop-quiesce", version: "1" }, { supportedProtocolVersions: [version], versionNegotiation: { mode: { pin: version } } });
  const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
    async fetch(input, init) {
      const request = new Request(input, init);
      headers.forEach((v, k) => request.headers.set(k, v));
      return fetch(await withMeta(request, OPENCODE_SESSION_META, "be"));
    },
    reconnectionOptions: { initialReconnectionDelay: 30, maxReconnectionDelay: 30, reconnectionDelayGrowFactor: 1, maxRetries: 1 },
  });
  await client.connect(transport);
  await bindFixture(client, "be");
  const post = (body: string) => client.callTool({ name: "board_post", arguments: { board: "lobby", body } });
  expect((await client.callTool({ name: "board_create", arguments: { name: "lobby", purpose: "general" } })).isError).toBeFalsy();
  const subscription = await client.listen({ resourceSubscriptions: ["grayboard://boards/lobby"] });
  expect(srv.app.mcp.activeWatches).toBe(1);
  const closed = await closeSpy(srv);
  hold("resources:live:checked");
  expect((await post("change")).isError).toBeFalsy();
  await until(() => pauseHits("resources:live:checked") > 0, 5000, "the watch's check reached its pause");
  // Closed before the stop: stop() shuts the HTTP listener, and the client's own requests would then fail.
  await subscription.close().catch(() => {});
  await client.close().catch(() => {});
  return { srv, closed };
}

test("stop() waits for a resource watch's check before it closes the store", async () => {
  const { srv, closed } = await heldWatchCheck();
  await stopAround(srv, closed, "resources:live:checked", "resource watch check");
  await srv.stop();
});

test("stop()'s drain deadline names a resource watch check that never finished, and the store still closes", async () => {
  const { srv, closed } = await heldWatchCheck({ stopDrainMs: 50 });
  await expect(srv.app.stop()).rejects.toThrow(/stop: 1 background pass never finished within 50 ms: resource watch check/);
  expect(logs).toContain("[grayboard] stop: 1 background pass never finished within 50 ms: resource watch check");
  expect(closed.at).toBeGreaterThan(0);
  writeFileSync(release, "release");
  await until(() => logs.includes("[grayboard] test pause released: resources:live:checked"), 5000, "the watch's check left its pause");
  await srv.stop().catch(() => {});
});
