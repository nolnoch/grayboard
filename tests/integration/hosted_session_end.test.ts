import { afterEach, beforeEach, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_ID } from "../../src/core/session_id.ts";
import { startServer } from "../../src/server/app.ts";
import { DEFAULT_HELLO_LIMIT, DEFAULT_AUTH_FAIL_LIMIT } from "../../src/server/rate_limit.ts";
import { DEFAULT_TRUSTED_PROXIES } from "../../src/server/client_addr.ts";
import { MCP_PROTOCOL_VERSIONS } from "../../src/server/mcp.ts";
import { sessionContext } from "../../src/server/hosted.ts";
import { issueOAuth } from "../helpers/oauth.ts";
import { OPENCODE_CLIENT, OPENCODE_SESSION_META } from "../../src/server/oauth-config.ts";
import { withMeta } from "../helpers/hosted.ts";

let app: ReturnType<typeof startServer>, dir: string, base: string;
const clients: Client[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gb-hosted-end-"));
  app = startServer({ dbPath: ":memory:", blobDir: dir, httpPort: 0, googleClientId: "dev", googleClientSecret: "", orgDomain: "example.com", publicUrl: "http://localhost", messageRetentionDays: 90, auditRetentionDays: 90, devAuth: true, admins: [], helloLimit: DEFAULT_HELLO_LIMIT, authFailLimit: DEFAULT_AUTH_FAIL_LIMIT, trustedProxies: DEFAULT_TRUSTED_PROXIES }, { hostname: "127.0.0.1", background: false });
  base = `http://127.0.0.1:${app.server.port}`;
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  await app.stop();
  expect(app.mcp.activeContexts).toBe(0);
  app.db.close();
  rmSync(dir, { recursive: true, force: true });
});
function issue(email = "alice@example.com") {
  return issueOAuth(app.repo, app.oauth.resource, email, ["grayboard:tools", "grayboard:delivery"], Date.now(), OPENCODE_CLIENT);
}
async function connect(version: string, token: string, source: string) {
  const client = new Client({ name: "session-end-test", version: "1" }, { supportedProtocolVersions: [version], versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" } });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, "X-Grayboard-Client": "subscriber" } },
    fetch: async (input, init) => fetch(await withMeta(new Request(input, init), OPENCODE_SESSION_META, source)),
  }));
  return client;
}
async function value(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).not.toBe(true);
  const first = result.content?.[0];
  if (first?.type !== "text") throw new Error("expected tool text");
  return JSON.parse(first.text);
}
async function bind(client: Client, name: string) {
  expect((await client.callTool({ name: "bind", arguments: { name, create: true } })).isError).not.toBe(true);
}

for (const version of MCP_PROTOCOL_VERSIONS) test(`${version}: root ends actual registered child IDs without ending siblings or foreign ownership`, async () => {
  const grant = issue(), foreignGrant = issue("bob@example.com");
  const root = await connect(version, grant.token, "root");
  await bind(root, "be");
  const first = await value(root, "session_register", { child: "first" });
  const sibling = await value(root, "session_register", { child: "sibling" });
  expect(first.child).toMatch(SESSION_ID);
  expect(first.root).toMatch(SESSION_ID);
  expect(sibling.root).toBe(first.root);
  const otherRoot = await connect(version, grant.token, "other-root");
  await bind(otherRoot, "other");
  const other = await value(otherRoot, "session_register", { child: "other-child" });
  const foreignRoot = await connect(version, foreignGrant.token, "foreign-root");
  await bind(foreignRoot, "be");
  const foreign = await value(foreignRoot, "session_register", { child: "foreign-child" });
  for (const id of [other.root, other.child, foreign.root, foreign.child]) {
    expect((await root.callTool({ name: "session_end", arguments: { session: id } })).isError).toBe(true);
    expect(app.repo.hosted.get(id)).toBeDefined();
  }
  const child = await connect(version, grant.token, "first");
  for (const id of [first.root, sibling.child]) {
    expect((await child.callTool({ name: "session_end", arguments: { session: id } })).isError).toBe(true);
  }
  expect(await value(root, "session_end", { session: first.child })).toEqual({ ended: true });
  expect(app.repo.hosted.get(first.child)).toBeUndefined();
  expect(app.repo.hosted.get(first.root)?.name).toBe("be");
  expect(app.repo.hosted.get(sibling.child)?.root_session_id).toBe(first.root);
  const siblingClient = await connect(version, grant.token, "sibling");
  expect(await value(siblingClient, "session_end")).toEqual({ ended: true });
  expect(app.repo.hosted.get(sibling.child)).toBeUndefined();
  expect(app.repo.hosted.get(first.root)?.name).toBe("be");
  expect(await value(root, "session_end")).toEqual({ ended: true });
  expect(app.repo.hosted.get(first.root)).toBeUndefined();
  expect(app.repo.hosted.get(other.root)).toBeDefined();
  expect(app.repo.hosted.get(foreign.root)).toBeDefined();
});

for (const version of MCP_PROTOCOL_VERSIONS) test(`${version}: selective child end frees the existing child capacity`, async () => {
  const grant = issue();
  const root = await connect(version, grant.token, "capacity-root");
  await bind(root, "be");
  const first = await value(root, "session_register", { child: "first" });
  const principal = app.oauth.authenticate(new Request(`${base}/mcp`, { headers: { Authorization: `Bearer ${grant.token}` } }));
  if (principal instanceof Response) throw new Error("fixture authorization failed");
  const context = sessionContext(principal, { "ai.opencode/sessionID": "capacity-root" });
  for (let i = 1; i < 128; i++) await app.mcp.sessions.register(principal, context, `child-${i}`);
  const count = () => app.repo.hosted.all().filter(row => row.root_session_id === first.root).length;
  expect(count()).toBe(128);
  expect((await root.callTool({ name: "session_register", arguments: { child: "replacement" } })).isError).toBe(true);
  expect(await value(root, "session_end", { session: first.child })).toEqual({ ended: true });
  expect(count()).toBe(127);
  const replacement = await value(root, "session_register", { child: "replacement" });
  expect(replacement.child).toMatch(SESSION_ID);
  expect(count()).toBe(128);
  expect(app.repo.hosted.get(first.root)?.name).toBe("be");
});
