import { afterEach, beforeEach, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../src/server/app.ts";
import { MCP_PROTOCOL_VERSIONS } from "../../src/server/mcp.ts";
import { reprDigest, sha256Hex } from "../../src/shared/attachments.ts";
import { issueOAuth } from "../helpers/oauth.ts";
import { bindFixture, OPENCODE_CLIENT, withSessionMeta } from "../helpers/hosted.ts";

let app: ReturnType<typeof startServer>;
let base: string;
let dir: string;
const clients: Client[] = [];
const publicUrl = "https://grayboard.example.com:443/hosted";
const bytes = new TextEncoder().encode("private report\n");
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gb-http-oauth-attachments-"));
  app = startServer({ dbPath: ":memory:", blobDir: dir, httpPort: 0, googleClientId: "dev", googleClientSecret: "", orgDomain: "example.com", publicUrl, messageRetentionDays: 90, auditRetentionDays: 90, devAuth: true, admins: ["alice@example.com"] }, { hostname: "127.0.0.1", background: false });
  base = `http://127.0.0.1:${app.server.port}`;
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => c.close()));
  await app.stop(); app.db.close();
  rmSync(dir, { recursive: true, force: true });
});
function issue(email = "alice@example.com", scopes = ["grayboard:tools"]) { return issueOAuth(app.repo, app.oauth.resource, email, scopes, Date.now(), OPENCODE_CLIENT); }
async function connect(token: string, version: string) {
  const client = new Client({ name: "attachment-test", version: "1" }, { supportedProtocolVersions: [version], versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" } });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/hosted/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, "X-Grayboard-Identity": "be" } },
    fetch: async (input, init) => fetch(await withSessionMeta(new Request(input, init), "attachment-root")),
  }));
  await bindFixture(client, "be");
  return client;
}
function value(result: Awaited<ReturnType<Client["callTool"]>>) {
  if (result.content?.[0]?.type !== "text") throw new Error("expected text result");
  return JSON.parse(result.content[0].text);
}
async function attachment(token: string, method = "POST", id?: number, alias = false) {
  const path = `${alias ? "/mcp" : "/hosted/mcp"}/attachments${id === undefined ? "" : `/${id}`}?identity=be${method === "POST" ? "&filename=report.txt" : ""}`;
  return fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(method === "POST" ? { "Content-Length": String(bytes.length) } : {}) }, ...(method === "POST" ? { body: bytes } : {}) });
}

for (const version of MCP_PROTOCOL_VERSIONS) test(`${version}: standard grant uploads, MCP binds, participant downloads, own unsent releases`, async () => {
  const alice = issue(), bob = issue("bob@example.com"), outsider = issue("outsider@example.com");
  const [a, b] = await Promise.all([connect(alice.token, version), connect(bob.token, version)]);
  app.repo.identities.create(outsider.authed.user_id, "be");
  const info = value(await a.callTool({ name: "whoami", arguments: {} }));
  expect(info.name).toBe("be");
  const upload = await attachment(alice.token);
  expect(upload.status).toBe(201);
  expect(upload.headers.get("Cache-Control")).toBe("private, no-store");
  const descriptor = await upload.json() as { id: number; sha256: string };
  expect(descriptor).toMatchObject({ filename: "report.txt", type: "text/plain", size: bytes.length, sha256: sha256Hex(bytes) });
  const downloadUrl = new URL(`${app.oauth.resource}/attachments/${descriptor.id}`);
  downloadUrl.searchParams.set("identity", info.name);
  expect(downloadUrl.href).not.toContain(alice.token);
  expect((await attachment(bob.token, "GET", descriptor.id)).status).toBe(404);
  const sent = await a.callTool({ name: "dm_send", arguments: { to: "bob@example.com/be", body: "file", attachment_ids: [descriptor.id] } });
  expect(sent.isError).not.toBe(true);
  const inbox = value(await b.callTool({ name: "dm_inbox", arguments: {} }));
  expect(JSON.stringify(inbox)).toContain(descriptor.sha256);
  const download = await attachment(bob.token, "GET", descriptor.id, true);
  expect(download.status).toBe(200);
  expect(download.headers.get("Repr-Digest")).toBe(reprDigest(descriptor.sha256));
  expect(download.headers.get("Content-Disposition")).toContain("report.txt");
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
  expect((await attachment(outsider.token, "GET", descriptor.id)).status).toBe(404);
  expect((await attachment(alice.token, "DELETE", descriptor.id)).status).toBe(404);
  const unused = await attachment(alice.token, "POST", undefined, true);
  const unusedId = (await unused.json() as { id: number }).id;
  const refused = await a.callTool({ name: "dm_send", arguments: { to: "missing@example.com/be", body: "file", attachment_ids: [unusedId] } });
  expect(refused.isError).toBe(true);
  expect((await attachment(bob.token, "DELETE", unusedId)).status).toBe(404);
  expect((await attachment(alice.token, "DELETE", unusedId)).status).toBe(200);
  expect((await attachment(alice.token, "DELETE", unusedId)).status).toBe(404);
});

test("private board visibility is checked again after reading the blob", async () => {
  const alice = issue(), bob = issue("bob@example.com");
  const [a, b] = await Promise.all([connect(alice.token, "2026-07-28"), connect(bob.token, "2026-07-28")]);
  const team = app.repo.teams.create("private", alice.authed.user_id);
  app.repo.teams.addMember(team.id, alice.authed.user_id);
  app.repo.teams.addMember(team.id, bob.authed.user_id);
  const { ensureTeamBoard, onTeamJoined, onTeamLeft } = await import("../../src/server/teams.ts");
  ensureTeamBoard(app.db, team, "alice@example.com");
  onTeamJoined(app.db, app.repo, team, alice.authed.user_id, "alice@example.com");
  onTeamJoined(app.db, app.repo, team, bob.authed.user_id, "bob@example.com");
  const id = (await (await attachment(alice.token)).json() as { id: number }).id;
  expect((await a.callTool({ name: "board_post", arguments: { board: "private", body: "team file", attachment_ids: [id] } })).isError).not.toBe(true);
  expect((await b.readResource({ uri: "grayboard://boards/private" })).contents.length).toBe(1);
  let enter!: () => void, resume!: () => void;
  const entered = new Promise<void>(r => { enter = r; }), resumed = new Promise<void>(r => { resume = r; });
  const get = app.repo.blobs.get.bind(app.repo.blobs);
  app.repo.blobs.get = async hash => { const data = await get(hash); enter(); await resumed; return data; };
  const reading = attachment(bob.token, "GET", id);
  await Promise.race([entered, reading.then(response => { throw new Error(`blob read was bypassed: ${response.status}`); })]);
  app.repo.teams.removeMember(team.id, bob.authed.user_id);
  onTeamLeft(app.db, app.repo, team, bob.authed.user_id, "bob@example.com");
  resume();
  const response = await reading;
  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain("private report");
});

test("old API remains session-only and OAuth cannot become admin or WS credentials", async () => {
  const alice = issue();
  app.repo.identities.create(alice.authed.user_id, "be");
  const login = await fetch(`${base}/api/auth/dev-login`, { method: "POST", body: JSON.stringify({ email: "alice@example.com" }) });
  const legacy = (await login.json() as { session_token: string }).session_token;
  const oldUpload = await fetch(`${base}/api/attachments?identity=be&filename=report.txt`, { method: "POST", headers: { Authorization: `Bearer ${legacy}`, "Content-Length": String(bytes.length) }, body: bytes });
  expect(oldUpload.status).toBe(201);
  const id = (await oldUpload.json() as { id: number }).id;
  expect((await fetch(`${base}/api/attachments/${id}?identity=be`, { headers: { Authorization: `Bearer ${legacy}` } })).status).toBe(200);
  expect((await attachment(legacy, "GET", id)).status).toBe(401);
  for (const path of ["/api/attachments/1?identity=be", "/api/identities", "/api/admin/users", "/api/teams"]) {
    const response = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${alice.token}` } });
    expect(response.status).toBe(401);
    await response.arrayBuffer();
  }
  const ws = await fetch(`${base}/`, { headers: { Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13", Authorization: `Bearer ${alice.token}` } });
  expect(ws.status).toBe(401);
  expect((await attachment(issue("alice@example.com", ["grayboard:delivery"]).token)).status).toBe(403);
  expect((await attachment(issue("alice@example.com", ["grayboard:delivery", "grayboard:tools"]).token)).status).toBe(201);
});
