// A hosted session's model and effort over real HTTP (#364): the `_meta` keys a client sends on its requests become the
// session's latest facts, which peer_list shows and match:{model} filters on; a legacy GET, which routes by its creating
// POST's `_meta`, never reverts them; a malformed fact is refused with its own message.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../src/server/app.ts";
import { MCP_PROTOCOL_VERSIONS } from "../../src/server/mcp.ts";
import { DEFAULT_AUTH_FAIL_LIMIT, DEFAULT_HELLO_LIMIT } from "../../src/server/rate_limit.ts";
import { DEFAULT_TRUSTED_PROXIES } from "../../src/server/client_addr.ts";
import { issueOAuth } from "../helpers/oauth.ts";
import { GRAYBOARD_EFFORT_META, GRAYBOARD_MODEL_META, GRAYBOARD_SESSION_META } from "../../src/shared/session_meta.ts";

const A = "alice@example.com";
let app: ReturnType<typeof startServer>;
let base: string;
let blobDir: string;
const clients: Client[] = [];
beforeEach(() => {
  blobDir = mkdtempSync(join(tmpdir(), "gb-facts-"));
  app = startServer({ dbPath: ":memory:", blobDir, httpPort: 0, googleClientId: "dev", googleClientSecret: "", orgDomain: "example.com", publicUrl: "https://grayboard.example.com:443/hosted", messageRetentionDays: 90, auditRetentionDays: 90, devAuth: true, admins: [A], helloLimit: DEFAULT_HELLO_LIMIT, authFailLimit: DEFAULT_AUTH_FAIL_LIMIT, trustedProxies: DEFAULT_TRUSTED_PROXIES }, { hostname: "127.0.0.1", background: false });
  base = `http://127.0.0.1:${app.server.port}`;
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => c.close().catch(() => {})));
  await app.stop();
  app.db.close();
  rmSync(blobDir, { recursive: true, force: true });
});

const token = () => issueOAuth(app.repo, app.oauth.resource, A, ["grayboard:tools", "grayboard:delivery"], Date.now(), "grayboard-pi").token;

// A client whose every POST carries the session key and the current facts, as hosted-core's wire sends them.
async function connect(version: string, raw: string, facts: { model?: unknown; effort?: unknown }) {
  const tok = token();
  const inject = async (request: Request): Promise<Request> => {
    if (request.method !== "POST") return request;
    const body = await request.clone().json() as { params?: Record<string, unknown> };
    const meta = { ...(body.params?._meta as Record<string, unknown> | undefined), [GRAYBOARD_SESSION_META]: raw,
      ...(facts.model === undefined ? {} : { [GRAYBOARD_MODEL_META]: facts.model }), ...(facts.effort === undefined ? {} : { [GRAYBOARD_EFFORT_META]: facts.effort }) };
    return new Request(request, { body: JSON.stringify({ ...body, params: { ...body.params, _meta: meta } }) });
  };
  const client = new Client({ name: "facts", version: "1" }, { supportedProtocolVersions: [version], versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" } });
  clients.push(client);
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tok}` } }, fetch: async (i, init) => fetch(await inject(new Request(i, init))) });
  await client.connect(transport);
  return { client, transport, tok };
}
const json = <T>(r: unknown): T => JSON.parse((r as { content: Array<{ text: string }> }).content[0]!.text) as T;
type Peers = { peers: Array<{ handle: string; model?: string | null; effort?: string | null }> };

test("a hosted session's model and effort show in peer_list and match:{model}, and a change mid-session moves them (#364)", async () => {
  const facts: { model?: unknown; effort?: unknown } = { model: "claude-opus-5-5", effort: "high" };
  const { client } = await connect("2026-07-28", "facts-peer", facts);
  await client.callTool({ name: "bind", arguments: { name: "be", create: true } });
  const listed = json<Peers>(await client.callTool({ name: "peer_list", arguments: { match: { model: "claude-opus-5-5" } } }));
  expect(listed.peers).toMatchObject([{ handle: `${A}/be`, model: "claude-opus-5-5", effort: "high" }]);
  facts.model = "claude-sonnet-5-5";
  expect(json<Peers>(await client.callTool({ name: "peer_list", arguments: { match: { model: "claude-opus-5-5" } } })).peers).toEqual([]);
  expect(json<Peers>(await client.callTool({ name: "peer_list", arguments: { match: { model: "claude-sonnet-5-5" } } })).peers).toMatchObject([{ handle: `${A}/be`, effort: "high" }]);
});

for (const version of MCP_PROTOCOL_VERSIONS.filter(v => v !== "2026-07-28")) test(`${version}: a legacy GET, routed by its creating POST's _meta, doesn't revert the latest model (#364)`, async () => {
  const facts: { model?: unknown } = { model: "first" };
  const { client, transport, tok } = await connect(version, "facts-legacy", facts);
  await client.callTool({ name: "whoami", arguments: {} });
  facts.model = "latest";
  await client.callTool({ name: "whoami", arguments: {} });
  const model = () => (app.db.prepare("SELECT model FROM ids WHERE model IS NOT NULL").get() as { model: string }).model;
  expect(model()).toBe("latest");
  const ac = new AbortController();
  // The response's headers come after the GET's select, which is where the replayed _meta is read.
  const get = await fetch(`${base}/mcp`, { method: "GET", signal: ac.signal, headers: { Authorization: `Bearer ${tok}`, Accept: "text/event-stream", "Mcp-Session-Id": transport.sessionId!, "MCP-Protocol-Version": version } });
  expect(get.status).toBe(200);
  ac.abort();
  expect(model()).toBe("latest");
});

test("a model that isn't a string is refused with a message naming the key (#364)", async () => {
  const res = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: {}, _meta: { [GRAYBOARD_SESSION_META]: "facts-bad", [GRAYBOARD_MODEL_META]: 5 } } }) });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ code: "bad_request", message: `_meta["${GRAYBOARD_MODEL_META}"] must be a string` });
});
