import { afterEach, beforeEach, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../src/server/app.ts";
import { MCP_PROTOCOL_VERSIONS } from "../../src/server/mcp.ts";
import { writeAudit } from "../../src/server/audit.ts";
import { WsClient } from "../support/ws_client.ts";

let app: ReturnType<typeof startServer>;
let base: string;
let blobDir: string;
const clients: Client[] = [];
const wsClients: WsClient[] = [];
const publicUrl = "https://grayboard.example.com:443/hosted";
const trustedOrigin = "https://grayboard.example.com";
beforeEach(() => {
  blobDir = mkdtempSync(join(tmpdir(), "gb-http-mcp-"));
  app = startServer({ dbPath: ":memory:", blobDir, httpPort: 0, googleClientId: "dev", googleClientSecret: "", orgDomain: "example.com", publicUrl, messageRetentionDays: 90, auditRetentionDays: 90, devAuth: true, admins: ["alice@example.com"] }, { background: false });
  base = `http://127.0.0.1:${app.server.port}`;
});
afterEach(async () => {
  for (const client of wsClients.splice(0)) client.close();
  await Promise.all(clients.splice(0).map(c => c.close()));
  await app.stop();
  app.db.close();
  rmSync(blobDir, { recursive: true, force: true });
});
async function login(email = "alice@example.com") {
  const res = await fetch(`${base}/api/auth/dev-login`, { method: "POST", body: JSON.stringify({ email }) });
  const token = (await res.json() as { session_token: string }).session_token;
  const user = app.repo.users.findByEmail(email)!;
  for (const name of ["be", "allowed"]) {
    if (!app.repo.identities.findByUserAndName(user.id, name)) app.repo.identities.create(user.id, name);
  }
  return token;
}
async function connect(token: string, identity = "be", version = "2026-07-28", origin?: string) {
  const client = new Client({ name: "http-test", version: "1" }, {
    supportedProtocolVersions: [version],
    versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" },
  });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, "X-Grayboard-Identity": identity, ...(origin === undefined ? {} : { Origin: origin }) } },
  }));
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
  expect(client.getServerCapabilities()).not.toHaveProperty("resources");
  expect(client.getServerCapabilities()).not.toHaveProperty("experimental");
  expect((await client.callTool({ name: "board_create", arguments: { name: "e2e", purpose: "fixtures" } })).isError).not.toBe(true);
  expect(value(await client.callTool({ name: "board_list", arguments: {} }))).toMatchObject([{ name: "e2e" }]);
  expect(value(await client.callTool({ name: "dm_inbox", arguments: {} }))).toEqual({ unanswered: [] });
  expect(app.mcp.activeContexts).toBe(0);
});

for (const version of MCP_PROTOCOL_VERSIONS) test(`${version}: tools-only HTTP requests leave bridge death notices for an owning WS hello`, async () => {
  const token = await login();
  const client = await connect(token, "be", version);
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
  await connect(token, "be", version);
  expect(app.repo.audit.last("bridge.notified", target)).toBeUndefined();

  const owner = new WsClient(base, token, "be");
  wsClients.push(owner);
  const hello = await owner.connect();
  expect(hello.type).toBe("hello_ok");
  expect(hello.notices).toEqual([notice]);
  const notified = app.repo.audit.last("bridge.notified", target);
  expect(notified).toBeDefined();

  const next = new WsClient(base, token, "allowed");
  wsClients.push(next);
  const again = await next.connect();
  expect(again.type).toBe("hello_ok");
  expect(again.notices ?? []).toEqual([]);
  expect(app.repo.audit.last("bridge.notified", target)).toEqual(notified);
});

for (const version of MCP_PROTOCOL_VERSIONS) test(`${version}: configured Origin gates discovery and tools before identity creation`, async () => {
  const token = await login();
  await expect(connect(token, "refused", version, "https://foreign.example.com")).rejects.toThrow();
  expect(app.repo.identities.findByUserAndName(app.repo.users.findByEmail("alice@example.com")!.id, "refused")).toBeUndefined();
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
    expect(app.repo.identities.findByUserAndName(app.repo.users.findByEmail("alice@example.com")!.id, identity)).toBeUndefined();
    expect(app.mcp.activeContexts).toBe(0);
  }
  origin = trustedOrigin;
  identity = "allowed";
  expect(value(await client.callTool({ name: "board_list", arguments: {} }))).toEqual([]);
});

test("all HTTP methods require a valid token and explicit own agent name", async () => {
  const token = await login();
  for (const method of ["POST", "GET", "DELETE", "OPTIONS", "PUT"]) {
    for (const auth of [undefined, "Bearer wrong"]) {
      const res = await fetch(`${base}/mcp`, { method, headers: auth ? { Authorization: auth } : {} });
      expect(res.status).toBe(401);
    }
    for (const identity of [undefined, "human", "HUMAN", "alice@example.com/be", "bad/name"]) {
      const res = await fetch(`${base}/mcp`, { method, headers: { Authorization: `Bearer ${token}`, ...(identity ? { "X-Grayboard-Identity": identity } : {}) } });
      expect(res.status).toBe(400);
    }
  }
  expect(app.repo.identities.findByUserAndName(app.repo.users.findByEmail("alice@example.com")!.id, "human")).toBeUndefined();
  expect(app.mcp.activeContexts).toBe(0);
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
  expect(app.mcp.activeContexts).toBe(0);
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
  expect(app.mcp.activeContexts).toBe(0);
});

test("attachment IDs bind only the caller's uploads and downloads stay access checked", async () => {
  const [alice, bob, carol] = await Promise.all([login(), login("bob@example.com"), login("carol@example.com")]);
  const [a, b, c] = await Promise.all([connect(alice), connect(bob), connect(carol)]);
  const uploaded = await fetch(`${base}/api/attachments?identity=be&filename=note.txt`, {
    method: "POST", headers: { Authorization: `Bearer ${alice}` }, body: "public fixture text",
  });
  expect(uploaded.status).toBe(201);
  const attachment = await uploaded.json() as { id: number };
  expect((await c.callTool({ name: "dm_send", arguments: { to: "bob@example.com/be", body: "stolen", attachment_ids: [attachment.id] } })).isError).toBe(true);
  const sent = value(await a.callTool({ name: "dm_send", arguments: { to: "bob@example.com/be", body: "note", attachment_ids: [attachment.id] } }));
  expect(sent.attachments).toMatchObject([{ id: attachment.id }]);
  const thread = value(await b.callTool({ name: "dm_thread", arguments: { thread: sent.message_id } }));
  expect(thread[0].attachments).toMatchObject([{ id: attachment.id }]);
  for (const [token, status] of [[bob, 200], [carol, 404]] as const) {
    const download = await fetch(`${base}/api/attachments/${attachment.id}?identity=be`, { headers: { Authorization: `Bearer ${token}` } });
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
  expect(app.mcp.activeContexts).toBe(0);
});
