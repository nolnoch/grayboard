import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { TestServer } from "../support/server.ts";
import { seed } from "../support/seed.ts";
import { MCP_PROTOCOL_VERSIONS } from "../../src/server/mcp.ts";
import { issueOAuth, type IssuedOAuth } from "../helpers/oauth.ts";
import { OPENCODE_CLIENT, OPENCODE_SESSION_META } from "../../src/server/oauth-config.ts";
import { bindFixture, withMeta } from "../helpers/hosted.ts";
import { hashToken } from "../../src/server/auth.ts";
import { OAUTH_TTL } from "../../src/server/oauth-types.ts";
import { randomBytes } from "node:crypto";
import { sessionContext } from "../../src/server/hosted.ts";
import { stubAuthRead } from "../support/auth_stub.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let srv: TestServer, app: TestServer["app"], base: string, clock: number;
const clients: Client[] = [];
beforeEach(async () => {
  clock = Date.now();
  srv = await TestServer.open({ publicUrl: "https://grayboard.example.com" }, { hostname: "127.0.0.1", oauth: { now: () => clock } });
  app = srv.app;
  base = `http://127.0.0.1:${app.server.port}`;
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => c.close()));
  await srv.stop();
  expect(app.mcp.activeContexts).toBe(0);
  expect(app.mcp.activeResourceContexts).toBe(0);
  expect(app.mcp.activeStreams).toBe(0);
  expect(app.mcp.activeListens).toBe(0);
  expect(app.mcp.activeGetStreams).toBe(0);
  expect(app.mcp.activeLegacySessions).toBe(0);
  expect(app.mcp.activeLeases).toBe(0);
  expect(app.mcp.activePosts).toBe(0);
  expect(app.mcp.activeWatches).toBe(0);
  expect(app.mcp.activeBusListeners).toBe(0);
});
const issue = (email = "alice@example.com") => issueOAuth(app.repo, app.oauth.resource, email, ["grayboard:tools", "grayboard:delivery"], clock, OPENCODE_CLIENT);
async function until(predicate: () => boolean) {
  const end = Date.now() + 1800;
  while (!predicate() && Date.now() < end) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}
async function connect(token: string, version: string, role?: string, identity = "be") {
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  const principal = await app.oauth.authenticate(new Request(base + "/mcp", { headers }));
  if (principal instanceof Response) throw new Error("fixture authentication failed");
  const routing = sessionContext(principal, { "ai.opencode/sessionID": identity });
  const current = await app.mcp.sessions.whoami(principal, routing);
  if (!current.held.length) await app.mcp.sessions.bind(principal, routing, { name: identity, create: true });
  if (role) headers.set("X-Grayboard-Client", role);
  const hints: string[] = [], getHeaders: Headers[] = [];
  let getGate: Promise<void> | undefined;
  let callSignal: AbortSignal | undefined;
  let cancelled!: () => void;
  const cancellationSent = new Promise<void>(resolve => { cancelled = resolve; });
  const client = new Client({ name: "stream-test", version: "1" }, { supportedProtocolVersions: [version], versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" } });
  client.setNotificationHandler("notifications/resources/updated", n => { hints.push(n.params.uri); });
  clients.push(client);
  const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
    async fetch(input, init) {
      const signal = callSignal && typeof init?.body === "string" && JSON.parse(init.body).method === "tools/call" ? callSignal : undefined;
      const request = new Request(input, { ...init, ...(signal ? { signal } : {}) });
      headers.forEach((v, k) => request.headers.set(k, v));
      if (request.method === "GET") { getHeaders.push(new Headers(request.headers)); await getGate; }
      const response = await fetch(await withMeta(request, OPENCODE_SESSION_META, identity));
      if (typeof init?.body === "string" && JSON.parse(init.body).method === "notifications/cancelled") cancelled();
      return response;
    },
    reconnectionOptions: { initialReconnectionDelay: 30, maxReconnectionDelay: 30, reconnectionDelayGrowFactor: 1, maxRetries: 1 },
  });
  await client.connect(transport);
  await bindFixture(client, identity);
  return { client, transport, headers, hints, getHeaders, cancellationSent,
    pauseGets() {
      let release!: () => void;
      getGate = new Promise<void>(resolve => { release = resolve; });
      return () => { getGate = undefined; release(); };
    },
    setCallSignal(signal: AbortSignal) { callSignal = signal; },
  };
}
type Connection = Awaited<ReturnType<typeof connect>>;
function value(result: Awaited<ReturnType<Client["callTool"]>>) {
  if (result.isError) throw new Error(JSON.stringify(result));
  const first = result.content?.[0];
  if (first?.type !== "text") throw new Error("expected text");
  return JSON.parse(first.text);
}
const call = async (c: Connection, name: string, args: Record<string, unknown> = {}) => value(await c.client.callTool({ name, arguments: args }));
async function pending(c: Connection) {
  const result = await c.client.readResource({ uri: "grayboard://inbox" });
  return JSON.parse((result.contents[0] as { text: string }).text).items;
}
async function watch(c: Connection, uri: string) {
  if (c.client.getNegotiatedProtocolVersion() === "2026-07-28") {
    const subscription = await c.client.listen({ resourceSubscriptions: [uri] });
    expect(subscription.honoredFilter.resourceSubscriptions).toEqual([uri]);
    return () => subscription.close();
  }
  await until(() => app.mcp.activeGetStreams > 0);
  await c.client.subscribeResource({ uri });
  return async () => { await c.client.unsubscribeResource({ uri }); };
}
const boardUri = "grayboard://boards/e2e";
for (const version of MCP_PROTOCOL_VERSIONS) test(`${version}: independent native watchers fan out without consumption; unsubscribe and reconcile`, async () => {
  const grant = await issue();
  const first = await connect(grant.token, version);
  const second = await connect(grant.token, version);
  await call(first, "board_create", { name: "e2e", purpose: "fixtures" });
  expect(first.client.getServerCapabilities()?.resources).toEqual({ subscribe: true });
  const stopFirst = await watch(first, boardUri), stopSecond = await watch(second, boardUri);
  await call(first, "board_post", { board: "e2e", body: "fanout" });
  await until(() => first.hints.length === 1 && second.hints.length === 1);
  expect(first.hints).toEqual([boardUri]); expect(second.hints).toEqual([boardUri]);
  expect(app.mcp.activeLeases).toBe(0);
  expect(await app.repo.cursors.directFor(app.repo.read, "alice@example.com/be")).toBe(0);
  const observer = await connect((await issue("bob@example.com")).token, version);
  const peers = await call(observer, "peer_list", { include_offline: true });
  expect(peers.peers.find((peer: { handle: string }) => peer.handle === "alice@example.com/be").online).toBe(false);
  await stopFirst(); await stopSecond();
  const snapshot = await first.client.readResource({ uri: boardUri });
  expect(JSON.stringify(snapshot)).toContain("fanout");
});

for (const version of MCP_PROTOCOL_VERSIONS) test(`${version}: inbox hints are lease-epoch bound and never receipt pending`, async () => {
  const grant = await issue();
  const native = await connect(grant.token, version);
  const subscriber = await connect(grant.token, version, "subscriber");
  if (version !== "2026-07-28") await until(() => app.mcp.activeGetStreams === 2);
  const lease = await call(subscriber, "delivery_open");
  subscriber.headers.set("X-Grayboard-Lease", lease.capability);
  if (version !== "2026-07-28") {
    expect(await pending(subscriber)).toEqual([]);
    // The GET opened before the lease watches nothing, so the current POST re-authorizes it in place
    // (#431): it watches the inbox under the POST's lease without the client reopening it.
    expect(await subscriber.client.subscribeResource({ uri: "grayboard://inbox" })).toEqual({});
    expect(app.mcp.activeGetStreams).toBe(2);
    expect(app.mcp.activeInboxListeners).toBe(1);
    expect(subscriber.getHeaders).toHaveLength(1);
    expect(subscriber.getHeaders[0]!.has("X-Grayboard-Lease")).toBe(false);
  } else await watch(subscriber, "grayboard://inbox");
  const sent = await call(native, "dm_send", { to: "be", body: "durable", pending: true });
  await until(() => subscriber.hints.length > 0);
  const batch = await pending(subscriber);
  expect(batch).toHaveLength(1);
  expect(batch.at(-1).id).toBe(`direct:${sent.message_id}`);
  expect(await pending(subscriber)).toEqual(batch);
  expect(await app.repo.cursors.directFor(app.repo.read, "alice@example.com/be")).toBe(0);
  const oldHints = subscriber.hints.length;
  await call(subscriber, "delivery_release");
  await until(() => app.mcp.activeInboxListeners === 0);
  await bindFixture(subscriber.client, "be");
  const replacement = await call(subscriber, "delivery_open");
  expect(replacement.capability).not.toBe(lease.capability);
  subscriber.headers.set("X-Grayboard-Lease", replacement.capability);
  expect((await pending(subscriber)).map((item: { id: string }) => item.id)).toEqual(batch.map((item: { id: string }) => item.id));
  await call(native, "dm_send", { to: "be", body: "new epoch", pending: true });
  const replacementBatch = await pending(subscriber);
  expect(replacementBatch).toHaveLength(batch.length + 1);
  expect(subscriber.hints).toHaveLength(oldHints);
  const ids = replacementBatch.map((item: { id: string }) => item.id);
  await call(subscriber, "delivery_receipt", { ids });
  await call(subscriber, "delivery_receipt", { ids });
  expect(await pending(subscriber)).toEqual([]);
});

for (const version of MCP_PROTOCOL_VERSIONS) for (const action of ["access", "expiry", "grant", "disable", "admin"] as const) test(`${version}: ${action} retires active streams without a hint`, async () => {
  const grant = await issue();
  const connection = await connect(grant.token, version);
  await call(connection, "board_create", { name: "e2e", purpose: "fixtures" });
  await watch(connection, boardUri);
  await until(() => app.mcp.activeWatches === 1);
  if (action === "access") await seed(app.repo, tx => app.repo.oauth.revokeToken(tx, grant.tokens.accessHash, grant.binding.clientId, clock));
  if (action === "expiry") clock += OAUTH_TTL.access;
  if (action === "grant") await seed(app.repo, tx => app.repo.oauth.revokeToken(tx, hashToken(grant.refreshToken), grant.binding.clientId, clock));
  if (action === "disable") await seed(app.repo, tx => app.repo.users.setDisabled(tx, grant.authed.user_id, true));
  if (action === "admin") await seed(app.repo, tx => app.repo.sessions.revokeAllForUser(tx, grant.authed.user_id));
  await until(() => version === "2026-07-28" ? app.mcp.activeListens === 0 : app.mcp.activeGetStreams === 0);
  await expect(connection.client.readResource({ uri: boardUri })).rejects.toThrow();
});

for (const version of MCP_PROTOCOL_VERSIONS) test(`${version}: inbox listen requires the current user, grant, identity and capability`, async () => {
  const grant = await issue(), owner = await connect(grant.token, version, "subscriber");
  const lease = await call(owner, "delivery_open");
  const others = [
    await connect(grant.token, version, "subscriber", "fe"),
    await connect((await issue("bob@example.com")).token, version, "subscriber"),
    await connect((await issue()).token, version, "subscriber"),
  ];
  for (const other of others) {
    other.headers.set("X-Grayboard-Lease", lease.capability);
    await expect(watch(other, "grayboard://inbox")).rejects.toThrow();
  }
  owner.headers.set("X-Grayboard-Lease", "x".repeat(43));
  await expect(watch(owner, "grayboard://inbox")).rejects.toThrow();
  expect(app.mcp.activeInboxListeners).toBe(0);
  expect(app.mcp.activeLeases).toBe(1);
  expect(await app.repo.cursors.directFor(app.repo.read, "alice@example.com/be")).toBe(0);
});

for (const version of MCP_PROTOCOL_VERSIONS) test(`${version}: malformed/read-only/private resources cannot be watched`, async () => {
  const c = await connect((await issue()).token, version);
  for (const uri of ["grayboard://identity", "grayboard://inbox", "grayboard://boards/missing", "grayboard://boards/e2e?limit=20", "grayboard://boards/%65%32e"]) {
    await expect(watch(c, uri)).rejects.toThrow();
  }
  expect(app.mcp.activeListens).toBe(0);
  expect(app.mcp.activeLeases).toBe(0);
});

for (const version of MCP_PROTOCOL_VERSIONS) for (const kind of ["http", "sdk"] as const) test(`${version}: ${kind} cancellation during lease acquisition cannot leave an owner`, async () => {
  const grant = await issue(), c = await connect(grant.token, version, "subscriber");
  const abort = new AbortController();
  if (kind === "http") c.setCallSignal(abort.signal);
  const original = app.mcp.delivery.open;
  let selected!: () => void, resume!: () => void;
  const acquired = new Promise<void>(resolve => { selected = resolve; });
  const released = new Promise<void>(resolve => { resume = resolve; });
  app.mcp.delivery.open = async (...args) => {
    const lease = await original(...args);
    selected();
    await released;
    return lease;
  };
  try {
    const pending = c.client.callTool({ name: "delivery_open", arguments: {} }, kind === "sdk" ? { signal: abort.signal, timeout: 350 } : {}).catch(error => error);
    await acquired;
    expect(app.mcp.activeLeases).toBe(1);
    abort.abort();
    if (kind === "http") await until(() => app.mcp.activePosts === 0);
    else {
      await pending;
      if (version === "2026-07-28") await until(() => app.mcp.activePosts === 0);
      else await c.cancellationSent;
    }
    resume();
    await until(() => app.mcp.activeLeases === 0);
    await pending;
    app.mcp.delivery.open = original;
    const replacement = await connect(grant.token, version, "subscriber");
    await call(replacement, "delivery_open");
  } finally { resume(); app.mcp.delivery.open = original; }
});

async function refresh(grant: IssuedOAuth, priorRefresh = grant.refreshToken) {
  const token = randomBytes(32).toString("base64url"), refreshToken = randomBytes(32).toString("base64url"), now = Date.now();
  expect((await seed(app.repo, tx => app.repo.oauth.rotateRefresh(tx, { clientId: grant.binding.clientId, resource: grant.binding.resource, scopes: grant.binding.scopes, refreshHash: hashToken(priorRefresh), tokens: {
    ...grant.tokens, accessHash: hashToken(token), refreshHash: hashToken(refreshToken), accessExpiresAt: now + OAUTH_TTL.access, refreshExpiresAt: now + OAUTH_TTL.refresh,
  } }, now))).status).toBe("ok");
  return { token, refreshToken };
}

for (const version of MCP_PROTOCOL_VERSIONS.slice(1)) test(`${version}: current subscribe succeeds after old GET access revocation and recovers visible registrations`, async () => {
  const grant = await issue(), c = await connect(grant.token, version);
  await call(c, "board_create", { name: "e2e", purpose: "existing registration" });
  await call(c, "board_create", { name: "next", purpose: "current registration" });
  await watch(c, boardUri);
  expect(app.mcp.activeWatches).toBe(1);
  const sid = c.transport.sessionId;
  const rotated = await refresh(grant);
  c.headers.set("Authorization", `Bearer ${rotated.token}`);
  const resume = c.pauseGets();
  try {
    await seed(app.repo, tx => app.repo.oauth.revokeToken(tx, grant.tokens.accessHash, grant.binding.clientId, clock));
    expect(await c.client.subscribeResource({ uri: "grayboard://boards/next" })).toEqual({});
    await until(() => c.getHeaders.length === 2);
    expect(c.getHeaders[0]!.get("Authorization")).toBe(`Bearer ${grant.token}`);
    expect(c.getHeaders[1]!.get("Authorization")).toBe(`Bearer ${rotated.token}`);
    expect(app.mcp.activeGetStreams).toBe(0);
    expect(app.mcp.activeWatches).toBe(0);
    expect(app.mcp.activeLegacySessions).toBe(1);
    expect(await call(c, "whoami")).toMatchObject({ primary: "alice@example.com/be" });
    await call(c, "board_post", { board: "e2e", body: "old registration while disconnected" });
    await call(c, "board_post", { board: "next", body: "current registration while disconnected" });
    expect(c.hints).toEqual([]);
    expect(await app.repo.cursors.directFor(app.repo.read, "alice@example.com/be")).toBe(0);
  } finally { resume(); }
  await until(() => app.mcp.activeWatches === 2);
  expect(c.transport.sessionId).toBe(sid);
  expect(c.hints).toEqual([]);
  expect(JSON.stringify(await c.client.readResource({ uri: "grayboard://boards/next" }))).toContain("while disconnected");
  await call(c, "board_post", { board: "e2e", body: "fresh GET old registration" });
  await call(c, "board_post", { board: "next", body: "fresh GET current registration" });
  await until(() => c.hints.length === 2);
  expect(c.hints.toSorted()).toEqual([boardUri, "grayboard://boards/next"]);
  expect(c.getHeaders).toHaveLength(2);
  expect(app.mcp.activeLeases).toBe(0);
});

for (const version of MCP_PROTOCOL_VERSIONS.slice(1)) test(`${version}: fresh same-grant requests do not inherit initialize or GET access`, async () => {
  const grant = await issue(), c = await connect(grant.token, version);
  await call(c, "board_create", { name: "e2e", purpose: "fixtures" });
  await watch(c, boardUri);
  const rotated = await refresh(grant);
  c.headers.set("Authorization", `Bearer ${rotated.token}`);
  await seed(app.repo, tx => app.repo.oauth.revokeToken(tx, grant.tokens.accessHash, grant.binding.clientId, Date.now()));
  expect(await call(c, "whoami")).toMatchObject({ primary: "alice@example.com/be" });
  await until(() => app.mcp.activeWatches === 0);
  expect(app.mcp.activeLegacySessions).toBe(1);
  // The protocol session survives; only its old GET access snapshot was retired.
  expect(JSON.stringify(await c.client.readResource({ uri: boardUri }))).toContain("e2e");
  const sid = c.transport.sessionId!;
  for (const change of [
    { Authorization: `Bearer ${(await issue("bob@example.com")).token}` },
    { Authorization: `Bearer ${(await issue()).token}` },
    { "X-Grayboard-Client": "subscriber" },
  ]) {
    const headers = new Headers(c.headers);
    for (const [k, v] of Object.entries(change)) headers.set(k, v);
    headers.set("Mcp-Session-Id", sid); headers.set("Mcp-Protocol-Version", version); headers.set("Accept", "text/event-stream");
    const response = await fetch(base + "/mcp", { method: "GET", headers });
    expect(response.status).toBe(403); await response.body?.cancel();
  }
  const headers = new Headers(c.headers); headers.set("Mcp-Session-Id", sid); headers.set("Mcp-Protocol-Version", version);
  const deleted = await fetch(base + "/mcp", { method: "DELETE", headers });
  expect(deleted.status).toBe(200); await deleted.body?.cancel();
  await until(() => app.mcp.activeLegacySessions === 0);
  const missing = await fetch(base + "/mcp", { method: "DELETE", headers });
  expect(missing.status).toBe(404); await missing.body?.cancel();
});
// #1408: a resource read whose write body waits behind another request's body runs as its own exchange, not the
// releasing holder's. Alice's read is held at `hosted:tool:in-gate` (past its gate's write, before its body's); bob's
// tool call then takes the queue and holds it, alice's body queues behind it, and bob's release starts it. Started in
// bob's context, it judged bob's exchange principal and refused as "resource session is closed or unauthorized".
for (const version of MCP_PROTOCOL_VERSIONS) test(`${version}: a resource read queued behind another request's write body judges its own exchange`, async () => {
  const c = await connect((await issue()).token, version);
  const d = await connect((await issue("bob@example.com")).token, version, undefined, "fe");
  await call(c, "board_create", { name: "e2e", purpose: "fixtures" });
  type Body = (tx: unknown) => unknown;
  const hosted = app.repo.hosted as unknown as Record<"write", (fn: Body, ...rest: unknown[]) => unknown>, write = hosted.write;
  let queued = 0, arm = false, held = false, release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  hosted.write = (fn: Body, ...rest: unknown[]) => {
    queued++;
    const hold = arm && !held;
    if (hold) held = true;
    return write.call(app.repo.hosted, hold ? async (tx: unknown) => { await gate; return fn(tx); } : fn, ...rest);
  };
  const dir = mkdtempSync(join(tmpdir(), "gb-1408-")), go = join(dir, "go"), hits: string[] = [];
  const said = spyOn(console, "error").mockImplementation((...args: unknown[]) => { hits.push(args.join(" ")); });
  process.env.BUS_TEST_PAUSE = "hosted:tool:in-gate";
  process.env.BUS_TEST_PAUSE_FILE = go;
  try {
    const read = c.client.readResource({ uri: boardUri }).then(r => JSON.stringify(r), (error: unknown) => String(error));
    await until(() => hits.some(h => h.includes("test pause hit: hosted:tool:in-gate")));
    delete process.env.BUS_TEST_PAUSE;
    arm = true;
    const bob = call(d, "whoami");
    await until(() => held);
    const before = queued;
    writeFileSync(go, "");
    await until(() => queued > before);
    release();
    await bob;
    expect(await read).toContain("e2e");
  } finally {
    hosted.write = write; release(); writeFileSync(go, "");
    said.mockRestore();
    delete process.env.BUS_TEST_PAUSE; delete process.env.BUS_TEST_PAUSE_FILE;
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const version of MCP_PROTOCOL_VERSIONS) test(`${version}: private membership loss and background storage fault close streams`, async () => {
  const grant = await issue();
  const team = await seed(app.repo, async (tx) => {
    const t = await app.repo.teams.create(tx, "private", grant.authed.user_id);
    await app.repo.teams.addMember(tx, t.id, grant.authed.user_id);
    return t;
  });
  const c = await connect(grant.token, version);
  const other = await connect((await issue("bob@example.com")).token, version);
  await expect(watch(other, "grayboard://boards/private")).rejects.toThrow();
  await watch(c, "grayboard://boards/private");
  await until(() => app.mcp.activeWatches === 1);
  await seed(app.repo, (tx) => app.repo.teams.removeMember(tx, team.id, grant.authed.user_id));
  await until(() => app.mcp.activeWatches === 0);
  expect(c.hints).toEqual([]); expect(other.hints).toEqual([]);
  await call(c, "board_create", { name: "e2e", purpose: "fixtures" });
  await watch(c, boardUri);
  await until(() => app.mcp.activeWatches === 1);
  const restoreFindActiveAccess = stubAuthRead(app.repo, "findActiveAccess", original => () => { throw new Error("SELECT secret FROM private_database"); });
  // A users commit moves the auth generation, so the next tick misses the access cache and reads the stubbed store
  // (phase B) even if a tick stamped the listen before the stub went in (#1152 audit).
  await seed(app.repo, tx => app.repo.users.upsertByEmail(tx, "carol@example.com", null));
  try { await until(() => app.mcp.activeWatches === 0); }
  finally { restoreFindActiveAccess(); }
  expect(app.mcp.activeLeases).toBe(0);
  expect(await app.repo.cursors.directFor(app.repo.read, "alice@example.com/be")).toBe(0);
});

test("modern methods refuse session operations and unsupported catalog hints are not honored", async () => {
  const c = await connect((await issue()).token, "2026-07-28");
  for (const method of ["GET", "DELETE"]) {
    const headers = new Headers(c.headers); headers.set("Mcp-Protocol-Version", "2026-07-28");
    const response = await fetch(base + "/mcp", { method, headers });
    expect(response.status).toBe(405); await response.body?.cancel();
  }
  const sub = await c.client.listen({ toolsListChanged: true, resourcesListChanged: true });
  expect(sub.honoredFilter).toEqual({});
  await sub.close();
});

test("modern cancellation removes isolated listener; re-listen has no automatic replay", async () => {
  const c = await connect((await issue()).token, "2026-07-28");
  await call(c, "board_create", { name: "e2e", purpose: "fixtures" });
  const cancel = new AbortController();
  const sub = await c.client.listen({ resourceSubscriptions: [boardUri] }, { signal: cancel.signal });
  expect(sub.honoredFilter.resourceSubscriptions).toEqual([boardUri]);
  cancel.abort();
  await sub.closed;
  await until(() => app.mcp.activeListens === 0);
  await call(c, "board_post", { board: "e2e", body: "missed hint" });
  const stop = await watch(c, boardUri);
  expect(c.hints).toEqual([]);
  expect(JSON.stringify(await c.client.readResource({ uri: boardUri }))).toContain("missed hint");
  await stop();
});
