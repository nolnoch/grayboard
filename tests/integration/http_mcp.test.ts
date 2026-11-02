import { afterEach, beforeEach, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../src/server/app.ts";
import { MCP_PROTOCOL_VERSIONS } from "../../src/server/mcp.ts";
import { ATTACHMENT_LIMITS_CAPABILITY, DEFAULT_ATTACHMENT_LIMITS } from "../../src/shared/attachments.ts";
import { writeAudit } from "../../src/server/audit.ts";
import { DEFAULT_AUTH_FAIL_LIMIT, DEFAULT_HELLO_LIMIT } from "../../src/server/rate_limit.ts";
import { DEFAULT_TRUSTED_PROXIES } from "../../src/server/client_addr.ts";
import { WsClient } from "../support/ws_client.ts";
import { issueOAuth } from "../helpers/oauth.ts";
import { OPENCODE_CLIENT, OPENCODE_SESSION_META } from "../../src/server/oauth-config.ts";
import { bindFixture, withMeta } from "../helpers/hosted.ts";

let app: ReturnType<typeof startServer>;
let base: string;
let blobDir: string;
let clock: number | undefined;
const clients: Client[] = [];
const wsClients: WsClient[] = [];
const publicUrl = "https://grayboard.example.com:443/hosted";
const trustedOrigin = "https://grayboard.example.com";
beforeEach(() => {
  clock = undefined;
  blobDir = mkdtempSync(join(tmpdir(), "gb-http-mcp-"));
  app = startServer({ dbPath: ":memory:", blobDir, httpPort: 0, googleClientId: "dev", googleClientSecret: "", orgDomain: "example.com", publicUrl, messageRetentionDays: 90, auditRetentionDays: 90, devAuth: true, admins: ["alice@example.com"], helloLimit: DEFAULT_HELLO_LIMIT, authFailLimit: DEFAULT_AUTH_FAIL_LIMIT, trustedProxies: DEFAULT_TRUSTED_PROXIES }, { hostname: "127.0.0.1", background: false, oauth: { now: () => clock ?? Date.now() } });
  base = `http://127.0.0.1:${app.server.port}`;
});
afterEach(async () => {
  for (const client of wsClients.splice(0)) client.close();
  await Promise.all(clients.splice(0).map(c => c.close()));
  await app.stop();
  app.db.close();
  rmSync(blobDir, { recursive: true, force: true });
});
async function login(email = "alice@example.com", scopes = ["grayboard:tools"]) {
  return issueOAuth(app.repo, app.oauth.resource, email, scopes, Date.now(), OPENCODE_CLIENT).token;
}
async function legacyLogin(email = "alice@example.com") {
  const res = await fetch(`${base}/api/auth/dev-login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
  const token = (await res.json() as { session_token: string }).session_token;
  const user = app.repo.users.findByEmail(email)!;
  for (const name of ["be", "allowed"]) {
    if (!app.repo.aliases.find(`${user.email}/${name}`)) app.repo.aliases.create({ scope_kind: "person", scope_ref: user.email, name: name }, user.email);
  }
  return token;
}
async function connect(token: string, identity = "be", version = "2026-07-28", origin?: string, bind = true) {
  const client = new Client({ name: "http-test", version: "1" }, {
    supportedProtocolVersions: [version],
    versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" },
  });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, "X-Grayboard-Identity": identity, ...(origin === undefined ? {} : { Origin: origin }) } },
    fetch: async (input, init) => fetch(await withMeta(new Request(input, init), OPENCODE_SESSION_META, identity)),
  }));
  if (bind) await bindFixture(client, identity);
  return client;
}
function value(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content;
  if (!content || content[0]?.type !== "text") throw new Error("expected text result");
  return JSON.parse(content[0].text);
}

for (const version of MCP_PROTOCOL_VERSIONS) test(`${version}: official discovery/initialize, tools list and typed calls`, async () => {
  const client = await connect(await login(), "be", version);
  expect(client.getNegotiatedProtocolVersion()).toBe(version);
  const tools = await client.listTools();
  expect(tools.tools.map(t => t.name)).toContain("dm_inbox");
  expect(tools.tools.map(t => t.name)).not.toContain("attachment_get");
  const post = tools.tools.find(t => t.name === "board_post")!;
  expect(post.inputSchema.properties).toHaveProperty("attachment_ids");
  expect(post.inputSchema.properties).not.toHaveProperty("attachments");
  expect(client.getServerCapabilities()?.resources).toEqual({ subscribe: true });
  // The attachment caps, and never a channel capability: hosted HTTP has no push.
  expect(client.getServerCapabilities()?.experimental).toEqual({ [ATTACHMENT_LIMITS_CAPABILITY]: DEFAULT_ATTACHMENT_LIMITS });
  expect((await client.callTool({ name: "board_create", arguments: { name: "e2e", purpose: "fixtures" } })).isError).not.toBe(true);
  expect(value(await client.callTool({ name: "board_list", arguments: {} }))).toMatchObject([{ name: "e2e" }]);
  expect(value(await client.callTool({ name: "dm_inbox", arguments: {} }))).toEqual({ unanswered: [] });
  expect(app.mcp.activeContexts).toBe(app.mcp.activeGetStreams);
});

for (const version of MCP_PROTOCOL_VERSIONS) test(`${version}: HTTP delegation uses the live owning launcher without becoming one`, async () => {
  const token = await login();
  const launcher = new WsClient(base, await legacyLogin(), "allowed", { hello: { launcher: true } });
  wsClients.push(launcher);
  expect((await launcher.connect()).type).toBe("hello_ok");
  const client = await connect(token, "be", version);
  expect((await client.listTools()).tools.map(t => t.name)).toContain("delegate");
  const result = value(await client.callTool({ name: "delegate", arguments: { persona: "a researcher", task: "inspect the fixture", to: "AlLoWeD" } }));
  expect(result).toMatchObject({ to: "alice@example.com/allowed", delivered_now: true, pending: true });
  expect(result.note).toContain("settle the thread");
  expect(app.repo.messages.getById(result.message_id)).toMatchObject({ sender: "alice@example.com/be", recipient: "alice@example.com/allowed", pending: 1 });
  expect(JSON.parse(app.repo.audit.last("delegation.requested", "alice@example.com/allowed")!.detail!)).toMatchObject({ via: "explicit", message_id: result.message_id });
  expect((value(await client.callTool({ name: "peer_list", arguments: {} })).peers as { handle: string; launcher?: boolean }[]).find(p => p.handle === "alice@example.com/be")?.launcher).toBeUndefined();
});

for (const version of MCP_PROTOCOL_VERSIONS) test(`${version}: tools-only HTTP requests leave bridge death notices for an owning WS hello`, async () => {
  const token = await login();
  const legacy = await legacyLogin();
  const client = await connect(token, "be", version, undefined, false);
  const target = "alice@example.com/human";
  const at = new Date().toISOString();
  writeAudit(app.repo, "bridge.stopped", null, target, { reason: "fixture fatal", at });
  const notice = `your Slack bridge stopped at ${at} (fixture fatal); linked humans are offline until it reconnects or the server restarts`;

  const tools = await client.listTools();
  expect(tools.tools.length).toBeGreaterThan(0);
  expect(JSON.stringify(tools)).not.toContain(notice);
  expect(app.repo.audit.last("bridge.notified", target)).toBeUndefined();
  expect(value(await client.callTool({ name: "board_list", arguments: {} }))).toEqual([]);
  expect(app.repo.audit.last("bridge.notified", target)).toBeUndefined();
  await connect(token, "be", version, undefined, false);
  expect(app.repo.audit.last("bridge.notified", target)).toBeUndefined();

  const owner = new WsClient(base, legacy, "be");
  wsClients.push(owner);
  const hello = await owner.connect();
  expect(hello.type).toBe("hello_ok");
  expect(hello.notices).toEqual([notice]);
  const notified = app.repo.audit.last("bridge.notified", target);
  expect(notified).toBeDefined();

  const next = new WsClient(base, legacy, "allowed");
  wsClients.push(next);
  const again = await next.connect();
  expect(again.type).toBe("hello_ok");
  expect(again.notices ?? []).toEqual([]);
  expect(app.repo.audit.last("bridge.notified", target)).toEqual(notified);
});

for (const version of MCP_PROTOCOL_VERSIONS) test(`${version}: configured Origin gates discovery and tools before identity creation`, async () => {
  const token = await login();
  await expect(connect(token, "refused", version, "https://foreign.example.com")).rejects.toThrow();
  expect(app.repo.aliases.find("alice@example.com/refused")).toBeUndefined();
  let origin = trustedOrigin;
  let identity = "allowed";
  const client = new Client({ name: "origin-test", version: "1" }, {
    supportedProtocolVersions: [version],
    versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" },
  });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: (input, init) => {
      const req = new Request(input, init);
      req.headers.set("Origin", origin);
      req.headers.set("X-Grayboard-Identity", identity);
      return fetch(req);
    },
  }));
  expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  origin = `${trustedOrigin}:443`;
  expect(value(await client.callTool({ name: "board_list", arguments: {} }))).toEqual([]);
  identity = "refused";
  for (const forbidden of ["https://foreign.example.com", "malformed", "null", "", `${trustedOrigin}/`, `${trustedOrigin} https://foreign.example.com`, `${trustedOrigin},https://foreign.example.com`]) {
    origin = forbidden;
    await expect(client.listTools()).rejects.toThrow();
    await expect(client.callTool({ name: "board_create", arguments: { name: "forbidden", purpose: "must not dispatch" } })).rejects.toThrow();
    for (const method of ["POST", "GET", "DELETE", "OPTIONS", "PUT", "PATCH", "HEAD"]) {
      const res = await fetch(`${base}/mcp`, {
        method, headers: { Origin: forbidden, Authorization: `Bearer ${token}`, "X-Grayboard-Identity": identity, "MCP-Protocol-Version": version },
      });
      expect(res.status).toBe(403);
    }
    expect(app.repo.aliases.find(`alice@example.com/${identity}`)).toBeUndefined();
    expect(app.mcp.activeContexts).toBe(app.mcp.activeGetStreams);
  }
  origin = trustedOrigin;
  identity = "allowed";
  expect(value(await client.callTool({ name: "board_list", arguments: {} }))).toEqual([]);
});

test("all HTTP methods authenticate; identity headers never bind an uncontextualized client", async () => {
  const token = await login();
  for (const method of ["POST", "GET", "DELETE", "OPTIONS", "PUT"]) {
    for (const auth of [undefined, "Bearer wrong"]) {
      const res = await fetch(`${base}/mcp`, { method, headers: auth ? { Authorization: auth } : {} });
      expect(res.status).toBe(401);
    }
  }
  for (const identity of [undefined, "human", "HUMAN", "alice@example.com/be", "bad/name"]) {
    const client = new Client({ name: "unbound-test", version: "1" });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}`, ...(identity ? { "X-Grayboard-Identity": identity } : {}) } },
    }));
    expect(value(await client.callTool({ name: "board_list", arguments: {} }))).toEqual([]);
    expect(value(await client.callTool({ name: "whoami", arguments: {} })).primary).toBeNull();
    expect((await client.callTool({ name: "board_create", arguments: { name: "blocked", purpose: "no context" } })).isError).toBe(true);
    expect((await client.callTool({ name: "bind", arguments: { name: "be", create: true } })).isError).toBe(true);
  }
  expect(app.repo.aliases.find("alice@example.com/human")).toBeUndefined();
  expect(app.mcp.activeContexts).toBe(app.mcp.activeGetStreams);
});

test("concurrent requests are principal isolated; inbox reads never acknowledge delivery", async () => {
  const [alice, bob] = await Promise.all([login(), login("bob@example.com")]);
  const [a, b] = await Promise.all([connect(alice), connect(bob)]);
  const sent = value(await a.callTool({ name: "dm_send", arguments: { to: "bob@example.com/be", body: "private", pending: true } }));
  expect(sent.delivered_now).toBe(false);
  const histories = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).callTool({ name: "peer_list", arguments: { include_offline: true } })));
  histories.forEach((r, i) => expect(value(r).you).toBe(`${i % 2 ? "alice" : "bob"}@example.com/be`));
  expect(value(await b.callTool({ name: "dm_inbox", arguments: {} })).unanswered).toHaveLength(1);
  expect(app.repo.cursors.directFor("bob@example.com/be")).toBe(0);
  expect(value(await a.callTool({ name: "dm_inbox", arguments: {} })).unanswered).toHaveLength(0);
  expect(value(await a.callTool({ name: "dm_inbox", arguments: {} })).promised).toHaveLength(1);
  const c = await connect(await login("carol@example.com"));
  expect((await c.callTool({ name: "dm_thread", arguments: { thread: sent.message_id } })).isError).toBe(true);
  expect((await c.callTool({ name: "dm_ack", arguments: { message_id: sent.message_id } })).isError).toBe(true);
  expect(value(await b.callTool({ name: "dm_ack", arguments: { message_id: [sent.message_id, 999999] } }))).toMatchObject({ acked: [sent.message_id], not_found: [999999] });
  expect(value(await b.callTool({ name: "dm_inbox", arguments: {} })).unanswered).toHaveLength(0);
  expect(app.repo.cursors.directFor("bob@example.com/be")).toBe(0);
  expect((await a.callTool({ name: "dm_retract", arguments: { message_id: sent.message_id } })).isError).not.toBe(true);
  expect(value(await b.callTool({ name: "dm_history", arguments: {} }))).toEqual([]);
  expect(app.mcp.activeContexts).toBe(app.mcp.activeGetStreams);
});

test("invalid schemas and local paths fail without mutation; application errors stay tool errors", async () => {
  const client = await connect(await login());
  const invalid = [
    { name: "board_create", arguments: { name: "e2e", purpose: 7 } },
    { name: "board_create", arguments: { name: "e2e", purpose: "test", human: true } },
    { name: "dm_send", arguments: { to: "be", body: "bad", attachments: ["/etc/hosts"] } },
    { name: "dm_send", arguments: { to: "be", body: "bad", attachment_ids: ["/etc/hosts"] } },
    { name: "dm_send", arguments: { to: "be", body: "bad", parent_id: 1.5 } },
  ];
  for (const call of invalid) {
    try { expect((await client.callTool(call)).isError).toBe(true); } catch (e) { expect(String(e)).toMatch(/invalid|validation|schema|argument/i); }
  }
  expect(value(await client.callTool({ name: "board_list", arguments: {} }))).toEqual([]);
  expect(value(await client.callTool({ name: "dm_history", arguments: {} }))).toEqual([]);
  const refused = await client.callTool({ name: "board_read", arguments: { board: "hidden" } });
  expect(refused.isError).toBe(true);
  expect(JSON.stringify(refused)).toContain("no such board");
  expect(app.mcp.activeContexts).toBe(app.mcp.activeGetStreams);
});

test("attachment IDs bind only the caller's uploads and downloads stay access checked", async () => {
  const [alice, bob, carol] = await Promise.all([login(), login("bob@example.com"), login("carol@example.com")]);
  const [a, b, c] = await Promise.all([connect(alice), connect(bob), connect(carol)]);
  const uploaded = await fetch(`${base}/api/attachments?as=be&filename=note.txt`, {
    method: "POST", headers: { Authorization: `Bearer ${await legacyLogin()}` }, body: "public fixture text",
  });
  expect(uploaded.status).toBe(201);
  const attachment = await uploaded.json() as { id: number };
  expect((await c.callTool({ name: "dm_send", arguments: { to: "bob@example.com/be", body: "stolen", attachment_ids: [attachment.id] } })).isError).toBe(true);
  const sent = value(await a.callTool({ name: "dm_send", arguments: { to: "bob@example.com/be", body: "note", attachment_ids: [attachment.id] } }));
  expect(sent.attachments).toMatchObject([{ id: attachment.id }]);
  const thread = value(await b.callTool({ name: "dm_thread", arguments: { thread: sent.message_id } }));
  expect(thread[0].attachments).toMatchObject([{ id: attachment.id }]);
  for (const [token, status] of [[await legacyLogin("bob@example.com"), 200], [await legacyLogin("carol@example.com"), 404]] as const) {
    const download = await fetch(`${base}/api/attachments/${attachment.id}?as=be`, { headers: { Authorization: `Bearer ${token}` } });
    expect(download.status).toBe(status);
    if (status === 200) expect(await download.text()).toBe("public fixture text");
  }
  expect((await a.callTool({ name: "dm_send", arguments: { to: "bob@example.com/be", body: "reuse", attachment_ids: [attachment.id] } })).isError).toBe(true);
});

test("revocation is checked on subsequent calls, including legacy", async () => {
  for (const version of ["2026-07-28", "2025-11-25"]) {
    const token = await login("bob@example.com");
    const c = await connect(token, "be", version);
    app.repo.sessions.revokeAllForUser(app.repo.users.findByEmail("bob@example.com")!.id);
    await expect(c.listTools()).rejects.toThrow();
  }
  expect(app.mcp.activeContexts).toBe(app.mcp.activeGetStreams);
});

test("OAuth challenges and actual scope precede identity validation on every method", async () => {
  const legacy = await legacyLogin();
  const delivery = await login("alice@example.com", ["grayboard:delivery"]);
  const expired = issueOAuth(app.repo, app.oauth.resource, "alice@example.com", ["grayboard:tools"], Date.now() - 3_600_001).token;
  for (const method of ["POST", "GET", "DELETE", "OPTIONS", "PUT", "PATCH", "HEAD"]) {
    for (const [token, status, error] of [[legacy, 401, "invalid_token"], [expired, 401, "invalid_token"], [delivery, 403, "insufficient_scope"], ["wrong", 401, "invalid_token"]] as const) {
      const response = await fetch(`${base}/mcp`, { method, headers: { Authorization: `Bearer ${token}`, "X-Grayboard-Identity": "unselected" } });
      expect(response.status).toBe(status);
      expect(response.headers.get("WWW-Authenticate")).toBe(`Bearer resource_metadata="${app.oauth.resourceMetadata}", scope="${status === 401 ? "grayboard:delivery grayboard:tools" : "grayboard:tools"}", error="${error}"`);
    }
  }
  expect(app.repo.aliases.find("alice@example.com/unselected")).toBeUndefined();
  expect(app.mcp.activeContexts).toBe(app.mcp.activeGetStreams);
});

test("combined shared native grant remains non-owning with read-only resources", async () => {
  const client = await connect(await login("alice@example.com", ["grayboard:tools", "grayboard:delivery"]));
  expect((await client.listTools()).tools.map(t => t.name)).toContain("board_list");
  expect(client.getServerCapabilities()?.resources).toEqual({ subscribe: true });
  expect(client.getServerCapabilities()?.experimental).toEqual({ [ATTACHMENT_LIMITS_CAPABILITY]: DEFAULT_ATTACHMENT_LIMITS });
  expect(value(await client.callTool({ name: "board_list", arguments: {} }))).toEqual([]);
});

test("live access, family, disable and admin revocation never reuse a cached principal", async () => {
  for (const action of ["access", "family", "disable", "admin"] as const) {
    const issued = issueOAuth(app.repo, app.oauth.resource, `${action}@example.com`, ["grayboard:tools"], Date.now(), OPENCODE_CLIENT);
    const client = await connect(issued.token);
    switch (action) {
      case "access": app.repo.oauth.revokeToken(issued.tokens.accessHash, issued.binding.clientId, Date.now()); break;
      case "family": app.repo.oauth.revokeToken(issued.tokens.refreshHash, issued.binding.clientId, Date.now()); break;
      case "disable": app.repo.users.setDisabled(issued.authed.user_id, true); app.repo.users.setDisabled(issued.authed.user_id, false); break;
      case "admin": app.repo.sessions.revokeAllForUser(issued.authed.user_id); break;
    }
    await expect(client.callTool({ name: "board_create", arguments: { name: "blocked", purpose: "revoked" } })).rejects.toThrow();
    expect(app.mcp.activeContexts).toBe(app.mcp.activeGetStreams);
  }
});

test("old session remains accepted on retained API and WS but not new MCP", async () => {
  const token = await legacyLogin();
  const headers = { Authorization: `Bearer ${token}` };
  const api = await fetch(`${base}/api/auth/config`, { headers });
  expect(api.status).toBe(200);
  const owned = await fetch(`${base}/api/identities`, { headers });
  expect(owned.status).toBe(200);
  const refused = await fetch(`${base}/mcp`, { headers: { ...headers, "X-Grayboard-Identity": "be" } });
  expect(refused.status).toBe(401);
  const ws = new WebSocket(base.replace("http:", "ws:"), { headers });
  const closed = new Promise<void>(resolve => { ws.onclose = () => resolve(); });
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("WS failed")); });
  expect(ws.readyState).toBe(WebSocket.OPEN);
  ws.close();
  await closed;
});

test("connected clients cannot dispatch after their actual access deadline", async () => {
  const client = await connect(await login());
  clock = Date.now() + 3_600_001;
  await expect(client.callTool({ name: "board_create", arguments: { name: "expired", purpose: "blocked" } })).rejects.toThrow();
  expect(app.db.query("SELECT name FROM boards WHERE name = 'expired'").get()).toBeNull();
  expect(app.mcp.activeContexts).toBe(app.mcp.activeGetStreams);
});

test("shutdown closes MCP before OAuth and refuses subsequent authentication", async () => {
  const token = await login();
  await connect(token);
  const original = app.oauth.close;
  let closed = false;
  app.oauth.close = () => {
    expect(app.mcp.activeContexts).toBe(app.mcp.activeGetStreams);
    closed = true;
    original();
  };
  await app.stop();
  expect(closed).toBe(true);
  expect((await app.mcp.fetch(new Request(base + "/mcp"))).status).toBe(503);
  const auth = app.oauth.authenticate(new Request(base + "/mcp", { headers: { Authorization: `Bearer ${token}` } }));
  expect(auth).toBeInstanceOf(Response);
  expect((auth as Response).status).toBe(401);
  app.oauth.close = original;
});

for (const version of MCP_PROTOCOL_VERSIONS) for (const failure of ["expiry", "revoke", "storage"] as const) test(`${version}: streamed body preserves factory ${failure} refusal`, async () => {
  const issued = issueOAuth(app.repo, app.oauth.resource);
  const original = app.oauth.authenticate;
  let boundary!: () => void;
  const authenticated = new Promise<void>(resolve => { boundary = resolve; });
  let checks = 0;
  app.oauth.authenticate = (...args) => {
    if (args[0].headers.get("Authorization") !== `Bearer ${issued.token}`) return original(...args);
    if (++checks === 2 && failure === "storage") throw new Error("SELECT secret FROM /private/oauth.sqlite");
    const result = original(...args);
    if (checks === 1) { expect(result).not.toBeInstanceOf(Response); boundary(); }
    return result;
  };
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; c.enqueue(encoder.encode("{")); } });
  const json = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "board_create", arguments: { name: "blocked", purpose: "must not mutate" }, ...(version === "2026-07-28" ? { _meta: { "io.modelcontextprotocol/protocolVersion": version, "io.modelcontextprotocol/clientInfo": { name: "barrier", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } : {}) } });
  try {
    const pending = fetch(base + "/mcp", { method: "POST", headers: { Authorization: `Bearer ${issued.token}`, "X-Grayboard-Identity": "unselected", "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": version, ...(version === "2026-07-28" ? { "Mcp-Method": "tools/call", "Mcp-Name": "board_create" } : {}) }, body });
    await authenticated;
    if (failure === "expiry") clock = Date.now() + 3_600_001;
    if (failure === "revoke") app.repo.oauth.revokeToken(issued.tokens.accessHash, issued.binding.clientId, Date.now());
    const valid = failure === "revoke" ? await connect(await login("bob@example.com")) : undefined;
    controller.enqueue(encoder.encode(json.slice(1))); controller.close();
    const [response, validResult] = await Promise.all([pending, valid?.callTool({ name: "board_list", arguments: {} })]);
    if (valid) expect(validResult?.isError).not.toBe(true);
    expect(response.status).toBe(failure === "storage" ? 500 : 401);
    if (failure === "storage") {
      expect(response.headers.has("WWW-Authenticate")).toBe(false);
      expect(await response.text()).not.toMatch(/SELECT|secret|private|sqlite/);
    } else {
      expect(response.headers.get("WWW-Authenticate")).toBe(`Bearer resource_metadata="${app.oauth.resourceMetadata}", scope="grayboard:delivery grayboard:tools", error="invalid_token"`);
      await response.arrayBuffer();
    }
    expect(checks).toBe(2);
    expect(app.repo.aliases.find(`${issued.authed.user_email}/unselected`)).toBeUndefined();
    expect(app.db.query("SELECT name FROM boards WHERE name = 'blocked'").get()).toBeNull();
    expect(app.mcp.activeContexts).toBe(app.mcp.activeGetStreams);
  } finally { app.oauth.authenticate = original; }
});

test("production MCP storage errors are generic 500s, not invalid-token guesses", async () => {
  const token = await login();
  const original = app.repo.oauth.findActiveAccess;
  app.repo.oauth.findActiveAccess = () => { throw new Error("SELECT secret FROM /private/oauth.sqlite"); };
  try {
    const response = await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${token}`, "X-Grayboard-Identity": "unselected" } });
    expect(response.status).toBe(500);
    expect(response.headers.has("WWW-Authenticate")).toBe(false);
    expect(await response.json()).toEqual({ code: "internal", message: "internal error" });
  } finally { app.repo.oauth.findActiveAccess = original; }
  expect(app.repo.aliases.find("alice@example.com/unselected")).toBeUndefined();
  expect(app.mcp.activeContexts).toBe(app.mcp.activeGetStreams);
});
