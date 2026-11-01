import { DEFAULT_HELLO_LIMIT, DEFAULT_AUTH_FAIL_LIMIT } from "../../src/server/rate_limit.ts";
import { DEFAULT_TRUSTED_PROXIES } from "../../src/server/client_addr.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { startServer } from "../../src/server/app.ts";
import { MCP_PROTOCOL_VERSIONS } from "../../src/server/mcp.ts";
import { issueOAuth } from "../helpers/oauth.ts";
import { OPENCODE_CLIENT, OPENCODE_SESSION_META } from "../../src/server/oauth-config.ts";
import { bindFixture, withMeta } from "../helpers/hosted.ts";
import { hashToken } from "../../src/server/auth.ts";
import { PROTO } from "../../src/shared/protocol.ts";
import { ATTACHMENT_LIMITS_CAPABILITY, DEFAULT_ATTACHMENT_LIMITS } from "../../src/shared/attachments.ts";
import { OAUTH_TTL } from "../../src/server/oauth-types.ts";

let app: ReturnType<typeof startServer>;
let base: string, dir: string, clock: number;
const clients: Client[] = [];
const publicUrl = "https://grayboard.example.com:443/hosted";
beforeEach(() => {
  clock = Date.now();
  dir = mkdtempSync(join(tmpdir(), "gb-mcp-resources-"));
  app = startServer({ dbPath: ":memory:", blobDir: dir, httpPort: 0, googleClientId: "dev", googleClientSecret: "", orgDomain: "example.com", publicUrl, messageRetentionDays: 90, auditRetentionDays: 90, devAuth: true, admins: [], helloLimit: DEFAULT_HELLO_LIMIT, authFailLimit: DEFAULT_AUTH_FAIL_LIMIT, trustedProxies: DEFAULT_TRUSTED_PROXIES }, { hostname: "127.0.0.1", background: false, helloLimit: { burst: 1000, perSec: 1000 }, oauth: { now: () => clock } });
  base = `http://127.0.0.1:${app.server.port}`;
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => c.close()));
  await app.stop();
  expect(app.mcp.activeGetStreams).toBe(0);
  expect(app.mcp.activeContexts).toBe(app.mcp.activeGetStreams);
  expect(app.mcp.activeResourceContexts).toBe(app.mcp.activeGetStreams);
  expect(app.mcp.activeLeases).toBe(0);
  app.db.close();
  rmSync(dir, { recursive: true, force: true });
});
const issue = (email = "alice@example.com", scopes = ["grayboard:tools", "grayboard:delivery"]) => issueOAuth(app.repo, app.oauth.resource, email, scopes, clock, OPENCODE_CLIENT);
async function connect(token: string, version = "2026-07-28", role?: string, identity = "be") {
  const headers = new Headers({ Authorization: `Bearer ${token}`, "X-Grayboard-Identity": identity });
  if (role !== undefined) headers.set("X-Grayboard-Client", role);
  const client = new Client({ name: "resource-test", version: "1" }, {
    supportedProtocolVersions: [version], versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" },
  });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
    fetch: async (input, init) => {
      const request = await withMeta(new Request(input, init), OPENCODE_SESSION_META, identity);
      headers.forEach((value, key) => request.headers.set(key, value));
      return fetch(request);
    },
  }));
  await bindFixture(client, identity);
  return { client, headers };
}
function value(result: Awaited<ReturnType<Client["callTool"]>>) {
  if (result.isError) throw new Error(JSON.stringify(result));
  const first = result.content?.[0];
  if (first?.type !== "text") throw new Error("expected JSON tool content");
  return JSON.parse(first.text);
}
async function read(client: Client, uri: string) {
  const result = await client.readResource({ uri });
  if (client.getNegotiatedProtocolVersion() === "2026-07-28") expect(result).toMatchObject({ ttlMs: 0, cacheScope: "private" });
  const first = result.contents[0];
  if (!first || !("text" in first)) throw new Error("expected JSON resource content");
  expect(first.mimeType).toBe("application/json");
  return JSON.parse(first.text);
}
const call = (client: Client, name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
async function open(client: Client, headers: Headers) {
  const lease = value(await call(client, "delivery_open"));
  headers.set("X-Grayboard-Lease", lease.capability);
  return lease;
}

for (const version of MCP_PROTOCOL_VERSIONS) test(`${version}: native and subscriber catalogs, reads and explicit control on one grant`, async () => {
  const grant = issue();
  const native = await connect(grant.token, version);
  expect(native.client.getServerCapabilities()?.resources).toEqual({ subscribe: true });
  expect(native.client.getServerCapabilities()?.tools?.listChanged).toBe(false);
  expect(native.client.getServerCapabilities()?.experimental).toEqual({ [ATTACHMENT_LIMITS_CAPABILITY]: DEFAULT_ATTACHMENT_LIMITS });
  expect((await native.client.listTools()).tools.some(t => t.name.startsWith("delivery_"))).toBe(false);
  await expect(call(native.client, "delivery_open")).rejects.toThrow("not found");
  expect((await native.client.listResourceTemplates()).resourceTemplates).toEqual([]);
  const who = value(await call(native.client, "whoami"));
  expect(who).toMatchObject({ primary: "alice@example.com/be" });
  const identity = { identity_full: "alice@example.com/be" };
  await expect(read(native.client, "grayboard://identity")).rejects.toThrow();
  value(await call(native.client, "board_create", { name: "e2e", purpose: "fixtures" }));
  for (let i = 0; i < 23; i++) value(await call(native.client, "board_post", { board: "e2e", body: `post ${i}` }));
  const listed = await native.client.listResources();
  expect(listed.resources.map(r => r.uri)).toEqual(["grayboard://boards/e2e"]);
  if (version === "2026-07-28") expect(listed).toMatchObject({ ttlMs: 0, cacheScope: "private" });
  const snapshot = await read(native.client, "grayboard://boards/e2e");
  expect(snapshot.posts).toHaveLength(20);
  expect(snapshot.posts[0].body).toBe("post 3");
  expect(snapshot.next_before_id).toBe(snapshot.posts[0].id);
  const older = await read(native.client, `grayboard://boards/e2e?limit=100&before_id=${snapshot.next_before_id}`);
  expect(older.posts.map((p: { body: string }) => p.body)).toEqual(["post 0", "post 1", "post 2"]);
  expect(older.next_before_id).toBeNull();
  await expect(read(native.client, "grayboard://inbox")).rejects.toThrow();
  expect(app.mcp.activeLeases).toBe(0);
  const sub = await connect(grant.token, version, "subscriber");
  expect((await sub.client.listResources()).resources.map(r => r.uri)).toEqual(["grayboard://inbox"]);
  expect(value(await call(sub.client, "whoami"))).toEqual(who);
  expect((await sub.client.listTools()).tools.map(t => t.name)).toEqual(["whoami", "bind", "unbind", "session_register", "session_end", "delivery_open", "delivery_renew", "delivery_receipt", "delivery_release"]);
  await expect(call(sub.client, "dm_send", { to: "be", body: "not exposed" })).rejects.toThrow("not found");
  await expect(read(sub.client, "grayboard://boards/e2e")).rejects.toThrow();
  await expect(read(sub.client, "grayboard://inbox")).rejects.toThrow();
  expect(app.mcp.activeLeases).toBe(0);
  const lease = await open(sub.client, sub.headers);
  expect(lease.identity.identity_full).toBe(identity.identity_full);
  expect(app.mcp.activeLeases).toBe(1);
  const sent = value(await call(native.client, "dm_send", { to: "be", body: "durable", pending: true }));
  expect(sent.delivered_now).toBe(true);
  const pending = await read(sub.client, "grayboard://inbox");
  expect(pending).toMatchObject({ items: [{ id: `direct:${sent.message_id}`, actionable: true, event: { kind: "direct", message: { body: "durable" } } }] });
  expect(await read(sub.client, "grayboard://inbox")).toEqual(pending);
  expect(app.repo.cursors.directFor(identity.identity_full)).toBe(0);
  value(await call(sub.client, "delivery_renew"));
  value(await call(sub.client, "delivery_receipt", { ids: pending.items.map((i: { id: string }) => i.id) }));
  value(await call(sub.client, "delivery_receipt", { ids: pending.items.map((i: { id: string }) => i.id) }));
  expect(await read(sub.client, "grayboard://inbox")).toEqual({ items: [] });
  expect(app.repo.cursors.directFor(identity.identity_full)).toBe(sent.message_id);
  expect(app.db.query("SELECT * FROM dm_acks WHERE message_id=?").all(sent.message_id)).toEqual([]);
  value(await call(sub.client, "delivery_release"));
  expect(app.mcp.activeLeases).toBe(0);
  expect((await call(sub.client, "delivery_renew")).isError).toBe(true);
  expect(app.mcp.activeContexts).toBe(app.mcp.activeGetStreams);
  expect(app.mcp.activeResourceContexts).toBe(app.mcp.activeGetStreams);
});

for (const version of MCP_PROTOCOL_VERSIONS) test(`${version}: lease header binds identity, user, grant and role on every read/control`, async () => {
  const grant = issue();
  const subscriber = await connect(grant.token, version, "subscriber");
  const lease = await open(subscriber.client, subscriber.headers);
  const otherGrant = issue();
  const candidates = [
    await connect(grant.token, version, "subscriber", "fe"),
    await connect(issue("bob@example.com").token, version, "subscriber"),
    await connect(otherGrant.token, version, "subscriber"),
    await connect(grant.token, version),
  ];
  for (const { client, headers } of candidates) {
    headers.set("X-Grayboard-Lease", lease.capability);
    await expect(read(client, "grayboard://inbox")).rejects.toThrow();
    for (const name of ["delivery_renew", "delivery_release", "delivery_receipt"]) {
      const refused = await call(client, name, name === "delivery_receipt" ? { ids: [] } : {}).then(r => r.isError, () => true);
      expect(refused).toBe(true);
    }
  }
  subscriber.headers.set("X-Grayboard-Lease", "x".repeat(43));
  await expect(read(subscriber.client, "grayboard://inbox")).rejects.toThrow();
  subscriber.headers.set("X-Grayboard-Lease", lease.capability);
  expect(value(await call(subscriber.client, "delivery_renew")).capability).toBe(lease.capability);
  expect(app.mcp.activeLeases).toBe(1);
});

for (const version of MCP_PROTOCOL_VERSIONS) test(`${version}: role scopes and strict schema/URI validation do not confer ownership`, async () => {
  const tools = issue("alice@example.com", ["grayboard:tools"]);
  const delivery = issue("alice@example.com", ["grayboard:delivery"]);
  await expect(connect(tools.token, version, "subscriber")).rejects.toThrow();
  await expect(connect(delivery.token, version)).rejects.toThrow();
  for (const role of ["native", "Subscriber", "subscriber, subscriber", ""]) {
    const res = await fetch(base + "/mcp", { headers: { Authorization: `Bearer ${tools.token}`, "X-Grayboard-Identity": "be", "X-Grayboard-Client": role } });
    expect(res.status).toBe(400);
    await res.arrayBuffer();
  }
  for (const [role, token, required] of [["subscriber", tools.token, "grayboard:delivery"], [undefined, delivery.token, "grayboard:tools"]] as const) {
    const res = await fetch(base + "/mcp", { headers: { Authorization: `Bearer ${token}`, "X-Grayboard-Identity": "be", ...(role ? { "X-Grayboard-Client": role } : {}) } });
    expect(res.status).toBe(403);
    expect(res.headers.get("WWW-Authenticate")).toContain(`scope="${required}"`);
    await res.arrayBuffer();
  }
  const native = await connect(tools.token, version);
  value(await call(native.client, "board_create", { name: "e2e", purpose: "fixtures" }));
  for (const suffix of ["%652e", "e2e/", "e2e#x", "e2e?", "e2e?limit=0", "e2e?limit=101", "e2e?limit=01", "e2e?limit=1&limit=2", "e2e?unknown=1", "e2e?limit=1?ignored=1", "e2e?before_id=2&limit=1", "e2e?before_id=9007199254740992"]) {
    await expect(read(native.client, `grayboard://boards/${suffix}`)).rejects.toThrow();
  }
  const sub = await connect(delivery.token, version, "subscriber");
  for (const args of [{ capability: "x" }, { path: "/private/file" }]) expect((await call(sub.client, "delivery_open", args)).isError).toBe(true);
  expect(app.mcp.activeLeases).toBe(0);
  await open(sub.client, sub.headers);
  for (const args of [{ ids: ["x", "x"] }, { ids: Array.from({ length: 101 }, (_, i) => String(i)) }, { ids: [], capability: "x" }]) {
    expect((await call(sub.client, "delivery_receipt", args)).isError).toBe(true);
  }
  if (version === "2026-07-28") {
    await expect(sub.client.subscribeResource({ uri: "grayboard://inbox" })).rejects.toThrow();
    const subscription = await sub.client.listen({ resourceSubscriptions: ["grayboard://inbox"] });
    expect(subscription.honoredFilter).toEqual({ resourceSubscriptions: ["grayboard://inbox"] });
    await subscription.close();
  } else {
    expect(await sub.client.subscribeResource({ uri: "grayboard://inbox" })).toEqual({});
  }
});

test("board catalog pages are visible/bounded; private reads recheck membership without attention or ownership", async () => {
  const grant = issue();
  const alice = grant.authed.user_id;
  const bob = issue("bob@example.com");
  const team = app.repo.teams.create("private", alice);
  app.repo.teams.addMember(team.id, alice);
  const native = await connect(grant.token);
  const other = await connect(bob.token);
  for (let i = 0; i < 102; i++) value(await call(native.client, "board_create", { name: `page${String(i).padStart(3, "0")}`, purpose: "pagination" }));
  const first = await other.client.request({ method: "resources/list", params: {} });
  expect(first.resources).toHaveLength(100);
  expect(first.nextCursor).toBe("page099");
  expect(first.resources.some(r => r.uri.includes("private"))).toBe(false);
  const second = await other.client.listResources({ cursor: first.nextCursor });
  expect(second.resources.map(r => r.uri)).toEqual(["grayboard://boards/page100", "grayboard://boards/page101"]);
  expect(second.nextCursor).toBeUndefined();
  await expect(read(other.client, "grayboard://boards/private")).rejects.toThrow("resource not found");
  await expect(read(other.client, "grayboard://boards/absent")).rejects.toThrow("resource not found");
  const before = app.db.query("SELECT * FROM subscriptions WHERE handle=?").all("alice@example.com/be");
  const peers = value(await call(other.client, "peer_list", { include_offline: true }));
  expect(peers.peers.find((p: { handle: string }) => p.handle === "alice@example.com/be")).toMatchObject({ online: false });
  expect(await read(native.client, "grayboard://boards/private")).toHaveProperty("posts");
  expect(app.db.query("SELECT * FROM subscriptions WHERE handle=?").all("alice@example.com/be")).toEqual(before);
  app.repo.teams.removeMember(team.id, alice);
  await expect(read(native.client, "grayboard://boards/private")).rejects.toThrow("resource not found");
  expect((await native.client.listResources({ cursor: "page101" })).resources).toEqual([]);
  expect(app.mcp.activeLeases).toBe(0);
});

test("issued contiguous DM prefix receipts survive lost responses, but not out-of-order or unissued IDs", async () => {
  const grant = issue();
  const native = await connect(grant.token);
  const sub = await connect(grant.token, "2026-07-28", "subscriber");
  await open(sub.client, sub.headers);
  const one = value(await call(native.client, "dm_send", { to: "be", body: "one" })).message_id;
  const two = value(await call(native.client, "dm_send", { to: "be", body: "two" })).message_id;
  expect((await call(sub.client, "delivery_receipt", { ids: [`direct:${one}`] })).isError).toBe(true);
  await read(sub.client, "grayboard://inbox");
  expect((await call(sub.client, "delivery_receipt", { ids: [`direct:${two}`] })).isError).toBe(true);
  expect(app.repo.cursors.directFor("alice@example.com/be")).toBe(0);
  value(await call(sub.client, "delivery_receipt", { ids: [`direct:${one}`] }));
  value(await call(sub.client, "delivery_receipt", { ids: [`direct:${one}`, `direct:${two}`] }));
  expect(app.repo.cursors.directFor("alice@example.com/be")).toBe(two);
});

test("wire board receipts bind the issued snapshot and reject removed private-board membership", async () => {
  const alice = issue();
  const bob = issue("bob@example.com");
  const team = app.repo.teams.create("private", alice.authed.user_id);
  app.repo.teams.addMember(team.id, alice.authed.user_id);
  app.repo.teams.addMember(team.id, bob.authed.user_id);
  const sender = await connect(alice.token);
  const reader = await connect(bob.token);
  const sub = await connect(bob.token, "2026-07-28", "subscriber");
  await open(sub.client, sub.headers);
  value(await call(sender.client, "board_create", { name: "e2e", purpose: "fixtures" }));
  expect((await call(reader.client, "board_subscribe", { board: "e2e", mode: "digest" })).isError).not.toBe(true);
  value(await call(sender.client, "board_post", { board: "e2e", body: "one" }));
  const issued = (await read(sub.client, "grayboard://inbox")).items[0];
  expect(issued).toMatchObject({ actionable: false, event: { kind: "board", item: { kind: "digest", unread: 1 } } });
  const latest = value(await call(sender.client, "board_post", { board: "e2e", body: "two" }));
  value(await call(sub.client, "delivery_receipt", { ids: [issued.id] }));
  value(await call(sub.client, "delivery_receipt", { ids: [issued.id] }));
  const state = app.db.query<{ cursor: number; notified_id: number }, []>("SELECT cursor, notified_id FROM subscriptions WHERE board='e2e' AND handle='bob@example.com/be'").get()!;
  expect(state.cursor).toBe(0);
  expect(state.notified_id).toBe(issued.event.item.latest.id);
  expect(state.notified_id).toBeLessThan(latest.post_id);
  value(await call(sender.client, "board_post", { board: "private", body: "@bob@example.com/be private" }));
  const privateItem = (await read(sub.client, "grayboard://inbox")).items.find((i: { event: { kind: string; item?: { kind: string; post?: { board: string } } } }) => i.event.kind === "board" && i.event.item?.kind === "push" && i.event.item.post?.board === "private");
  expect(privateItem).toMatchObject({ actionable: true, event: { kind: "board", item: { kind: "push" } } });
  app.repo.teams.removeMember(team.id, bob.authed.user_id);
  expect((await call(sub.client, "delivery_receipt", { ids: [privateItem.id] })).isError).toBe(true);
  expect((await read(sub.client, "grayboard://inbox")).items.map((i: { id: string }) => i.id)).not.toContain(privateItem.id);
});

test("fresh access of the same grant continues a lease; revoked access and replacement grant cannot", async () => {
  const grant = issue();
  const sub = await connect(grant.token, "2026-07-28", "subscriber");
  const lease = await open(sub.client, sub.headers);
  const token = randomBytes(32).toString("base64url");
  const rotated = app.repo.oauth.rotateRefresh({ clientId: grant.binding.clientId, resource: grant.binding.resource, scopes: grant.binding.scopes, refreshHash: hashToken(grant.refreshToken), tokens: {
    ...grant.tokens, accessHash: hashToken(token), refreshHash: hashToken(randomBytes(32).toString("base64url")), accessExpiresAt: clock + OAUTH_TTL.access, refreshExpiresAt: clock + OAUTH_TTL.refresh,
  } }, clock);
  expect(rotated.status).toBe("ok");
  app.repo.oauth.revokeToken(grant.tokens.accessHash, grant.binding.clientId, clock);
  await expect(read(sub.client, "grayboard://inbox")).rejects.toThrow();
  sub.headers.set("Authorization", `Bearer ${token}`);
  expect(value(await call(sub.client, "delivery_renew")).capability).toBe(lease.capability);
  expect(value(await call(sub.client, "whoami"))).toMatchObject({ primary: "alice@example.com/be" });
  sub.headers.set("Authorization", `Bearer ${issue().token}`);
  expect((await call(sub.client, "delivery_release")).isError).toBe(true);
  sub.headers.set("Authorization", `Bearer ${token}`);
  value(await call(sub.client, "delivery_release"));
});

for (const action of ["access", "expiry", "grant", "disable", "admin"] as const) test(`${action}: fresh HTTP authorization gates resources and control`, async () => {
  const grant = issue();
  const sub = await connect(grant.token, "2026-07-28", "subscriber");
  await open(sub.client, sub.headers);
  if (action === "access") app.repo.oauth.revokeToken(grant.tokens.accessHash, grant.binding.clientId, clock);
  if (action === "expiry") clock += OAUTH_TTL.access;
  if (action === "grant") app.repo.oauth.revokeToken(hashToken(grant.refreshToken), grant.binding.clientId, clock);
  if (action === "disable") app.repo.users.setDisabled(grant.authed.user_id, true);
  if (action === "admin") app.repo.sessions.revokeAllForUser(grant.authed.user_id);
  await expect(sub.client.listResources()).rejects.toThrow();
  await expect(call(sub.client, "whoami")).rejects.toThrow();
  await expect(call(sub.client, "delivery_renew")).rejects.toThrow();
  expect(app.mcp.activeContexts).toBe(app.mcp.activeGetStreams);
});

test("explicit open conflicts with an existing live WS-style owner; native and subscriber reads do not", async () => {
  const grant = issue();
  const login = await fetch(base + "/api/auth/dev-login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "alice@example.com" }) });
  const { session_token } = await login.json() as { session_token: string };
  const ws = new WebSocket(base.replace("http:", "ws:"), { headers: { Authorization: `Bearer ${session_token}` } });
  const closed = new Promise<void>(resolve => { ws.onclose = () => resolve(); });
  const ready = new Promise<void>((resolve, reject) => {
    ws.onerror = () => reject(new Error("WS failed"));
    // #284: the hello is the session (proto 2, a session key); the name comes by bind.
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", req_id: "open", proto: PROTO, session_key: randomBytes(32).toString("hex") }));
    ws.onmessage = event => {
      const message = JSON.parse(String(event.data));
      if (message.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
      if (message.type === "hello_ok") ws.send(JSON.stringify({ type: "bind", req_id: "bind", alias: "be" }));
      if (message.type === "bind_ok") resolve();
      if (message.type === "end_ok") ended();
      if (message.type === "error") reject(new Error(JSON.stringify(message)));
    };
  });
  let ended!: () => void;
  const endOk = new Promise<void>(resolve => { ended = resolve; });
  await ready;
  const native = await connect(grant.token);
  const sub = await connect(grant.token, "2026-07-28", "subscriber");
  expect(value(await call(native.client, "whoami"))).toHaveProperty("unbound", true);
  expect(value(await call(sub.client, "whoami"))).toHaveProperty("unbound", true);
  expect(app.mcp.activeLeases).toBe(0);
  expect((await call(sub.client, "delivery_open")).isError).toBe(true);
  expect(app.mcp.activeLeases).toBe(0);
  // A closed WSS session holds its aliases through its grace (#284 S4); a clean exit ends it at once.
  ws.send(JSON.stringify({ type: "end", req_id: "end" }));
  await endOk;
  ws.close();
  await closed;
  expect((await call(sub.client, "bind", { name: "be" })).isError).not.toBe(true);
  await open(sub.client, sub.headers);
  expect(app.mcp.activeLeases).toBe(1);
});
