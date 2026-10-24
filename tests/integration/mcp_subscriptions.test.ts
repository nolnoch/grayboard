import { afterEach, beforeEach, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../src/server/app.ts";
import { MCP_PROTOCOL_VERSIONS } from "../../src/server/mcp.ts";
import { issueOAuth } from "../helpers/oauth.ts";
import { hashToken } from "../../src/server/auth.ts";
import { OAUTH_TTL } from "../../src/server/oauth-types.ts";
import { randomBytes } from "node:crypto";

let app: ReturnType<typeof startServer>, dir: string, base: string, clock: number;
const clients: Client[] = [];
beforeEach(() => {
  clock = Date.now();
  dir = mkdtempSync(join(tmpdir(), "gb-mcp-streams-"));
  app = startServer({ dbPath: ":memory:", blobDir: dir, httpPort: 0, googleClientId: "dev", googleClientSecret: "", orgDomain: "example.com", publicUrl: "https://grayboard.example.com", messageRetentionDays: 90, auditRetentionDays: 90, devAuth: true, admins: [] }, { background: false, oauth: { now: () => clock } });
  base = `http://127.0.0.1:${app.server.port}`;
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => c.close()));
  await app.stop();
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
  app.db.close(); rmSync(dir, { recursive: true, force: true });
});
const issue = (email = "alice@example.com") => issueOAuth(app.repo, app.oauth.resource, email, ["grayboard:tools", "grayboard:delivery"], clock);
async function until(predicate: () => boolean) {
  const end = Date.now() + 1800;
  while (!predicate() && Date.now() < end) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}
async function connect(token: string, version: string, role?: string, identity = "be") {
  const headers = new Headers({ Authorization: `Bearer ${token}`, "X-Grayboard-Identity": identity });
  if (role) headers.set("X-Grayboard-Client", role);
  const hints: string[] = [], getHeaders: Headers[] = [];
  let getGate: Promise<void> | undefined;
  let callSignal: AbortSignal | undefined;
  const client = new Client({ name: "stream-test", version: "1" }, { supportedProtocolVersions: [version], versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" } });
  client.setNotificationHandler("notifications/resources/updated", n => { hints.push(n.params.uri); });
  clients.push(client);
  const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
    async fetch(input, init) {
      const signal = callSignal && typeof init?.body === "string" && JSON.parse(init.body).method === "tools/call" ? callSignal : undefined;
      const request = new Request(input, { ...init, ...(signal ? { signal } : {}) });
      headers.forEach((v, k) => request.headers.set(k, v));
      if (request.method === "GET") { getHeaders.push(new Headers(request.headers)); await getGate; }
      return fetch(request);
    },
    reconnectionOptions: { initialReconnectionDelay: 30, maxReconnectionDelay: 30, reconnectionDelayGrowFactor: 1, maxRetries: 1 },
  });
  await client.connect(transport);
  return { client, transport, headers, hints, getHeaders,
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
  const grant = issue();
  const first = await connect(grant.token, version);
  const second = await connect(grant.token, version);
  await call(first, "board_create", { name: "e2e", purpose: "fixtures" });
  expect(first.client.getServerCapabilities()?.resources).toEqual({ subscribe: true });
  const stopFirst = await watch(first, boardUri), stopSecond = await watch(second, boardUri);
  await call(first, "board_post", { board: "e2e", body: "fanout" });
  await until(() => first.hints.length === 1 && second.hints.length === 1);
  expect(first.hints).toEqual([boardUri]); expect(second.hints).toEqual([boardUri]);
  expect(app.mcp.activeLeases).toBe(0);
  expect(app.repo.cursors.directFor("alice@example.com/be")).toBe(0);
  const observer = await connect(issue("bob@example.com").token, version);
  const peers = await call(observer, "peer_list", { include_offline: true });
  expect(peers.peers.find((peer: { handle: string }) => peer.handle === "alice@example.com/be").online).toBe(false);
  await stopFirst(); await stopSecond();
  const snapshot = await first.client.readResource({ uri: boardUri });
  expect(JSON.stringify(snapshot)).toContain("fanout");
});

for (const version of MCP_PROTOCOL_VERSIONS) test(`${version}: inbox hints are lease-epoch bound and never receipt pending`, async () => {
  const grant = issue();
  const native = await connect(grant.token, version);
  const subscriber = await connect(grant.token, version, "subscriber");
  if (version !== "2026-07-28") await until(() => app.mcp.activeGetStreams === 2);
  const lease = await call(subscriber, "delivery_open");
  subscriber.headers.set("X-Grayboard-Lease", lease.capability);
  if (version !== "2026-07-28") {
    expect(await pending(subscriber)).toEqual([]);
    const resume = subscriber.pauseGets();
    try {
      // The first current POST registers successfully without upgrading the old GET.
      expect(await subscriber.client.subscribeResource({ uri: "grayboard://inbox" })).toEqual({});
      await until(() => subscriber.getHeaders.length === 2);
      expect(subscriber.getHeaders[0]!.has("X-Grayboard-Lease")).toBe(false);
      expect(subscriber.getHeaders[1]!.get("X-Grayboard-Lease")).toBe(lease.capability);
      expect(app.mcp.activeGetStreams).toBe(1);
      expect(app.mcp.activeInboxListeners).toBe(0);
      await call(native, "dm_send", { to: "be", body: "before fresh GET", pending: true });
      expect(await pending(subscriber)).toHaveLength(1);
      expect(subscriber.hints).toEqual([]);
      expect(app.repo.cursors.directFor("alice@example.com/be")).toBe(0);
    } finally { resume(); }
    await until(() => app.mcp.activeInboxListeners === 1);
  } else await watch(subscriber, "grayboard://inbox");
  const sent = await call(native, "dm_send", { to: "be", body: "durable", pending: true });
  await until(() => subscriber.hints.length > 0);
  const batch = await pending(subscriber);
  expect(batch).toHaveLength(version === "2026-07-28" ? 1 : 2);
  expect(batch.at(-1).id).toBe(`direct:${sent.message_id}`);
  expect(await pending(subscriber)).toEqual(batch);
  expect(app.repo.cursors.directFor("alice@example.com/be")).toBe(0);
  const oldHints = subscriber.hints.length;
  await call(subscriber, "delivery_release");
  await until(() => app.mcp.activeInboxListeners === 0);
  const replacement = await call(subscriber, "delivery_open");
  expect(replacement.capability).not.toBe(lease.capability);
  subscriber.headers.set("X-Grayboard-Lease", replacement.capability);
  expect(await pending(subscriber)).toEqual(batch);
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
  const grant = issue();
  const connection = await connect(grant.token, version);
  await call(connection, "board_create", { name: "e2e", purpose: "fixtures" });
  await watch(connection, boardUri);
  await until(() => app.mcp.activeWatches === 1);
  if (action === "access") app.repo.oauth.revokeToken(grant.tokens.accessHash, grant.binding.clientId, clock);
  if (action === "expiry") clock += OAUTH_TTL.access;
  if (action === "grant") app.repo.oauth.revokeToken(hashToken(grant.refreshToken), grant.binding.clientId, clock);
  if (action === "disable") app.repo.users.setDisabled(grant.authed.user_id, true);
  if (action === "admin") app.repo.sessions.revokeAllForUser(grant.authed.user_id);
  await until(() => version === "2026-07-28" ? app.mcp.activeListens === 0 : app.mcp.activeGetStreams === 0);
  await expect(connection.client.readResource({ uri: boardUri })).rejects.toThrow();
});

for (const version of MCP_PROTOCOL_VERSIONS) test(`${version}: inbox listen requires the current user, grant, identity and capability`, async () => {
  const grant = issue(), owner = await connect(grant.token, version, "subscriber");
  const lease = await call(owner, "delivery_open");
  const others = [
    await connect(grant.token, version, "subscriber", "fe"),
    await connect(issue("bob@example.com").token, version, "subscriber"),
    await connect(issue().token, version, "subscriber"),
  ];
  for (const other of others) {
    other.headers.set("X-Grayboard-Lease", lease.capability);
    await expect(watch(other, "grayboard://inbox")).rejects.toThrow();
  }
  owner.headers.set("X-Grayboard-Lease", "x".repeat(43));
  await expect(watch(owner, "grayboard://inbox")).rejects.toThrow();
  expect(app.mcp.activeInboxListeners).toBe(0);
  expect(app.mcp.activeLeases).toBe(1);
  expect(app.repo.cursors.directFor("alice@example.com/be")).toBe(0);
});

for (const version of MCP_PROTOCOL_VERSIONS) test(`${version}: malformed/read-only/private resources cannot be watched`, async () => {
  const c = await connect(issue().token, version);
  for (const uri of ["grayboard://identity", "grayboard://inbox", "grayboard://boards/missing", "grayboard://boards/e2e?limit=20", "grayboard://boards/%65%32e"]) {
    await expect(watch(c, uri)).rejects.toThrow();
  }
  expect(app.mcp.activeListens).toBe(0);
  expect(app.mcp.activeLeases).toBe(0);
});

for (const version of MCP_PROTOCOL_VERSIONS) for (const kind of ["http", "sdk"] as const) test(`${version}: ${kind} cancellation during lease acquisition cannot leave an owner`, async () => {
  const grant = issue(), c = await connect(grant.token, version, "subscriber");
  const abort = new AbortController();
  if (kind === "http") c.setCallSignal(abort.signal);
  const login = await fetch(base + "/api/auth/dev-login", { method: "POST", body: JSON.stringify({ email: "alice@example.com" }) });
  const { session_token } = await login.json() as { session_token: string };
  const ws = new WebSocket(base.replace("http:", "ws:"), { headers: { Authorization: `Bearer ${session_token}` } });
  let probed!: () => void;
  const probing = new Promise<void>(resolve => { probed = resolve; });
  const closed = new Promise<void>(resolve => { ws.onclose = () => resolve(); });
  const ready = new Promise<void>((resolve, reject) => {
    ws.onerror = () => reject(new Error("WS failed"));
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", req_id: "open", identity: "be" }));
    ws.onmessage = event => {
      const message = JSON.parse(String(event.data));
      if (message.type === "hello_ok") resolve();
      if (message.type === "ping") probed();
    };
  });
  try {
    await ready;
    const pending = c.client.callTool({ name: "delivery_open", arguments: {} }, kind === "sdk" ? { signal: abort.signal, timeout: 350 } : {}).catch(error => error);
    await probing;
    expect(app.mcp.activeLeases).toBe(1);
    abort.abort();
    ws.close(); await closed;
    // The retained owner's existing probe expires after two seconds, allowing selection
    // to finish after cancellation rather than fabricating a synchronous application.
    await Bun.sleep(2100);
    await until(() => app.mcp.activeLeases === 0);
    // Close only after the ownership assertion: client teardown cannot mask
    // failure to observe the original HTTP signal in the pending SDK callback.
    if (kind === "http") await c.client.close();
    await pending;
    const replacement = await connect(grant.token, version, "subscriber");
    await call(replacement, "delivery_open");
  } finally { ws.close(); }
});

function refresh(grant: ReturnType<typeof issueOAuth>, priorRefresh = grant.refreshToken) {
  const token = randomBytes(32).toString("base64url"), refreshToken = randomBytes(32).toString("base64url"), now = Date.now();
  expect(app.repo.oauth.rotateRefresh({ clientId: grant.binding.clientId, resource: grant.binding.resource, scopes: grant.binding.scopes, refreshHash: hashToken(priorRefresh), tokens: {
    ...grant.tokens, accessHash: hashToken(token), refreshHash: hashToken(refreshToken), accessExpiresAt: now + OAUTH_TTL.access, refreshExpiresAt: now + OAUTH_TTL.refresh,
  } }, now).status).toBe("ok");
  return { token, refreshToken };
}

for (const version of MCP_PROTOCOL_VERSIONS.slice(1)) test(`${version}: current subscribe succeeds after old GET access revocation and recovers visible registrations`, async () => {
  const grant = issue(), c = await connect(grant.token, version);
  await call(c, "board_create", { name: "e2e", purpose: "existing registration" });
  await call(c, "board_create", { name: "next", purpose: "current registration" });
  await watch(c, boardUri);
  expect(app.mcp.activeWatches).toBe(1);
  const sid = c.transport.sessionId;
  const rotated = refresh(grant);
  c.headers.set("Authorization", `Bearer ${rotated.token}`);
  const resume = c.pauseGets();
  try {
    app.repo.oauth.revokeToken(grant.tokens.accessHash, grant.binding.clientId, clock);
    expect(await c.client.subscribeResource({ uri: "grayboard://boards/next" })).toEqual({});
    await until(() => c.getHeaders.length === 2);
    expect(c.getHeaders[0]!.get("Authorization")).toBe(`Bearer ${grant.token}`);
    expect(c.getHeaders[1]!.get("Authorization")).toBe(`Bearer ${rotated.token}`);
    expect(app.mcp.activeGetStreams).toBe(0);
    expect(app.mcp.activeWatches).toBe(0);
    expect(app.mcp.activeLegacySessions).toBe(1);
    expect(JSON.stringify(await c.client.readResource({ uri: "grayboard://identity" }))).toContain("alice@example.com/be");
    await call(c, "board_post", { board: "e2e", body: "old registration while disconnected" });
    await call(c, "board_post", { board: "next", body: "current registration while disconnected" });
    expect(c.hints).toEqual([]);
    expect(app.repo.cursors.directFor("alice@example.com/be")).toBe(0);
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
  const grant = issue(), c = await connect(grant.token, version);
  await call(c, "board_create", { name: "e2e", purpose: "fixtures" });
  await watch(c, boardUri);
  const rotated = refresh(grant);
  c.headers.set("Authorization", `Bearer ${rotated.token}`);
  app.repo.oauth.revokeToken(grant.tokens.accessHash, grant.binding.clientId, Date.now());
  expect(JSON.stringify(await c.client.readResource({ uri: "grayboard://identity" }))).toContain("alice@example.com/be");
  await until(() => app.mcp.activeWatches === 0);
  expect(app.mcp.activeLegacySessions).toBe(1);
  // The protocol session survives; only its old GET access snapshot was retired.
  expect(JSON.stringify(await c.client.readResource({ uri: boardUri }))).toContain("e2e");
  const sid = c.transport.sessionId!;
  for (const change of [
    { Authorization: `Bearer ${issue("bob@example.com").token}` },
    { Authorization: `Bearer ${issue().token}` },
    { "X-Grayboard-Identity": "fe" },
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

for (const version of MCP_PROTOCOL_VERSIONS) test(`${version}: private membership loss and background storage fault close streams`, async () => {
  const grant = issue();
  const team = app.repo.teams.create("private", grant.authed.user_id);
  app.repo.teams.addMember(team.id, grant.authed.user_id);
  const c = await connect(grant.token, version);
  const other = await connect(issue("bob@example.com").token, version);
  await expect(watch(other, "grayboard://boards/private")).rejects.toThrow();
  await watch(c, "grayboard://boards/private");
  await until(() => app.mcp.activeWatches === 1);
  app.repo.teams.removeMember(team.id, grant.authed.user_id);
  await until(() => app.mcp.activeWatches === 0);
  expect(c.hints).toEqual([]); expect(other.hints).toEqual([]);
  await call(c, "board_create", { name: "e2e", purpose: "fixtures" });
  await watch(c, boardUri);
  await until(() => app.mcp.activeWatches === 1);
  const original = app.repo.oauth.findActiveAccess;
  app.repo.oauth.findActiveAccess = () => { throw new Error("SELECT secret FROM private_database"); };
  try { await until(() => app.mcp.activeWatches === 0); }
  finally { app.repo.oauth.findActiveAccess = original; }
  expect(app.mcp.activeLeases).toBe(0);
  expect(app.repo.cursors.directFor("alice@example.com/be")).toBe(0);
});

test("modern methods refuse session operations and unsupported catalog hints are not honored", async () => {
  const c = await connect(issue().token, "2026-07-28");
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
  const c = await connect(issue().token, "2026-07-28");
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
