// #414: a brokered client registered by the operator with `sessionSource` gets the full
// hosted surface through the generic `_meta` key; every other client stays read-only.
// #429: the built-in clients map the generic key with no operator registration, and a
// generic-key client's delivery declaration selects its instruction text.
// Tokens come from real OAuth issuance (authorize, upstream sign-in, consent, token
// endpoint) against a server configured with those clients.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { startServer } from "../../src/server/app.ts";
import { MCP_PROTOCOL_VERSIONS } from "../../src/server/mcp.ts";
import { BUILTIN_CLIENT_IDS, OPENCODE_CLIENT, OPENCODE_SESSION_META, type OAuthClient } from "../../src/server/oauth-config.ts";
import { GRAYBOARD_DELIVERY_META, GRAYBOARD_SESSION_META } from "../../src/shared/session_meta.ts";
import { DEFAULT_AUTH_FAIL_LIMIT, DEFAULT_HELLO_LIMIT } from "../../src/server/rate_limit.ts";
import { DEFAULT_TRUSTED_PROXIES } from "../../src/server/client_addr.ts";
import { reprDigest } from "../../src/shared/attachments.ts";
import { sha256Hex } from "../../src/shared/hash.ts";
import { withMeta } from "../helpers/hosted.ts";

const issuer = "https://grayboard.example.com:443/hosted";
const resource = "https://grayboard.example.com/hosted/mcp";
const redirectUrl = "http://127.0.0.1:34567/callback";
const BROKER = "brokered-agents", BROKER_TWO = "brokered-agents-two", CIMD_CLIENT = "https://client.example/client.json";
const SCOPES = "grayboard:delivery grayboard:tools";
const operator = (clientId: string, sessionSource: boolean): OAuthClient => ({
  clientId, name: `Brokered ${clientId}`, redirectUris: [redirectUrl], scopes: ["grayboard:tools", "grayboard:delivery"], tokenEndpointAuthMethod: "none", ...(sessionSource ? { sessionSource: true } : {}),
});
const bytes = new TextEncoder().encode("brokered report\n");
type Conn = { client: Client; headers: Headers };

let app: ReturnType<typeof startServer>, dir: string, base: string;
const clients: Client[] = [];
// Every refusal and bind text the server returned, for the no-plugin/OpenCode wording check.
const served: string[] = [];
function start(oauthClients: OAuthClient[]) {
  app = startServer({ dbPath: join(dir, "db.sqlite"), blobDir: join(dir, "blobs"), httpPort: 0, googleClientId: "test-upstream", googleClientSecret: "", orgDomain: "example.com", publicUrl: issuer,
    messageRetentionDays: 90, auditRetentionDays: 90, devAuth: false, admins: [], helloLimit: DEFAULT_HELLO_LIMIT, authFailLimit: DEFAULT_AUTH_FAIL_LIMIT, trustedProxies: DEFAULT_TRUSTED_PROXIES,
    hostedRequestLimit: { burst: 10_000, perSec: 10_000 }, oauthClients,
  }, { hostname: "127.0.0.1", background: false, oauth: {
    exchangeGoogle: async () => ({ email: "alice@example.com", displayName: "Alice" }),
    cimd: {
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      read: async url => JSON.stringify({ client_id: url.href, client_name: url.href === OPENCODE_CLIENT ? "OpenCode" : "Metadata client", redirect_uris: [redirectUrl], token_endpoint_auth_method: "none" }),
    },
  } });
  base = `http://127.0.0.1:${app.server.port}`;
}
async function stop() {
  await Promise.all(clients.splice(0).map(c => c.close()));
  await app.stop();
  expect(app.mcp.activeLeases).toBe(0);
  app.db.close();
}
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "gb-generic-source-")); served.length = 0; });
afterEach(async () => {
  await stop();
  rmSync(dir, { recursive: true, force: true });
  // A client's own key may name OpenCode; nothing else the server says may.
  expect(served.map(t => t.replaceAll(OPENCODE_SESSION_META, "")).filter(t => /plugin|opencode/i.test(t))).toEqual([]);
});

const mapped = (url: string) => { const u = new URL(url); return base + u.pathname + u.search; };
class Browser {
  cookies = new Map<string, string>();
  async request(url: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("Cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await fetch(mapped(url), { ...init, headers, redirect: "manual" });
    for (const cookie of res.headers.getSetCookie()) {
      const [key, value] = cookie.split(";")[0]!.split("=");
      this.cookies.set(key!, value!);
    }
    return res;
  }
}
// The full authorization code flow with PKCE S256 a native client runs; only the upstream
// identity provider is stubbed (`exchangeGoogle`).
async function grant(clientId: string): Promise<string> {
  const verifier = randomBytes(32).toString("base64url"), state = randomBytes(16).toString("base64url"), browser = new Browser();
  const begin = await browser.request(`${issuer}/oauth/authorize?` + new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUrl, scope: SCOPES, resource, state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }));
  expect(begin.status).toBe(303);
  const google = new URL(begin.headers.get("Location")!);
  const callback = await browser.request(`${issuer}/oauth/google/callback?` + new URLSearchParams({ code: "upstream-code", state: google.searchParams.get("state")!, iss: "https://accounts.google.com" }));
  expect(callback.status).toBe(303);
  const page = await (await browser.request(callback.headers.get("Location")!)).text();
  const request = /name="request" value="([^"]+)"/.exec(page)![1]!, csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!;
  const approved = await browser.request(`${issuer}/oauth/consent`, { method: "POST", headers: { Origin: "https://grayboard.example.com" }, body: new URLSearchParams({ request, csrf, decision: "approve" }) });
  expect(approved.status).toBe(303);
  const returned = new URL(approved.headers.get("Location")!);
  expect(returned.searchParams.get("state")).toBe(state);
  const token = await fetch(mapped(`${issuer}/oauth/token`), { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code: returned.searchParams.get("code")!, code_verifier: verifier, redirect_uri: redirectUrl, resource }) });
  expect(token.status).toBe(200);
  const issued = await token.json() as { access_token: string; scope: string };
  expect(issued.scope).toBe(SCOPES);
  return issued.access_token;
}
async function connect(token: string, meta: [key: string, value: unknown][], opts: { role?: "subscriber"; version?: string } = {}): Promise<Conn> {
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  if (opts.role) headers.set("X-Grayboard-Client", opts.role);
  const version = opts.version ?? MCP_PROTOCOL_VERSIONS[0]!;
  const client = new Client({ name: "brokered-client", version: "1" }, { supportedProtocolVersions: [version], versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" } });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/hosted/mcp`), {
    fetch: async (input, init) => {
      let request = new Request(input, init);
      for (const [key, raw] of meta) request = await withMeta(request, key, raw);
      headers.forEach((value, name) => request.headers.set(name, value));
      return fetch(request);
    },
  }));
  return { client, headers };
}
async function call(c: Conn, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  const result: CallToolResult = await c.client.callTool({ name, arguments: args });
  if (result.isError || name === "bind") served.push(textOf(result));
  return result;
}
function textOf(result: CallToolResult): string {
  const first = result.content[0];
  if (first?.type !== "text") throw new Error(`expected a text result: ${JSON.stringify(result)}`);
  return first.text;
}
function json(result: CallToolResult) {
  if (result.isError) throw new Error(JSON.stringify(result));
  return JSON.parse(textOf(result));
}
// Native tools answer `error: <message>`, native bind a JSON body, the subscriber role a structured code.
function refused(result: CallToolResult): unknown {
  expect(result.isError).toBe(true);
  if (result.structuredContent && "code" in result.structuredContent) return result.structuredContent.code;
  const text = textOf(result);
  return text.startsWith("error: ") ? /^error: (\w+)/.exec(text)?.[1] : JSON.parse(text).code;
}
async function bind(c: Conn, name: string) {
  const bound = await call(c, "bind", { name, create: true });
  expect(bound.isError).not.toBe(true);
  expect(bound.structuredContent).toMatchObject({ name });
}
async function readResource(c: Conn, uri: string) {
  const first = (await c.client.readResource({ uri })).contents[0];
  if (!first || !("text" in first)) throw new Error("expected JSON resource content");
  return JSON.parse(first.text);
}
const attachment = (token: string, raw: string, id?: number) => fetch(`${base}/hosted/mcp/attachments${id === undefined ? "?filename=report.txt" : `/${id}`}`, {
  method: id === undefined ? "POST" : "GET",
  headers: { Authorization: `Bearer ${token}`, "X-Grayboard-Session": encodeURIComponent(raw), ...(id === undefined ? { "Content-Length": String(bytes.length) } : {}) },
  ...(id === undefined ? { body: bytes } : {}),
});
const hostedAudit = () => app.db.query<{ action: string; detail: string }, []>("SELECT action, detail FROM access_log WHERE action LIKE 'hosted.%'").all();

for (const version of MCP_PROTOCOL_VERSIONS) test(`${version}: an opted-in operator client sending only the generic key binds, registers, delivers and transfers attachments`, async () => {
  start([operator(BROKER, true)]);
  const token = await grant(BROKER);
  // Characters that need encodeURIComponent on the byte routes' header.
  const root = "run 42/agent ✓", meta: [string, string][] = [[GRAYBOARD_SESSION_META, root]];
  const native = await connect(token, meta, { version });
  await bind(native, "broker-run");
  expect(json(await call(native, "whoami"))).toMatchObject({ primary: "alice@example.com/broker-run" });

  const sub = await connect(token, meta, { version, role: "subscriber" });
  const registered = json(await call(sub, "session_register", { child: "run 42/subagent" }));
  expect(registered).toMatchObject({ message: "registered" });
  const child = await connect(token, [[GRAYBOARD_SESSION_META, "run 42/subagent"]], { version });
  expect(json(await call(child, "whoami"))).toMatchObject({ primary: "alice@example.com/broker-run", child: true, root: registered.root });

  const lease = json(await call(sub, "delivery_open"));
  expect(lease.identity.identity_full).toBe("alice@example.com/broker-run");
  sub.headers.set("X-Grayboard-Lease", lease.capability);
  const peer = await connect(token, [[GRAYBOARD_SESSION_META, "run 43/agent"]], { version });
  await bind(peer, "broker-peer");
  const sent = json(await call(peer, "dm_send", { to: "broker-run", body: "brokered hello" }));
  const inbox = await readResource(sub, "grayboard://inbox");
  expect(inbox.items).toMatchObject([{ id: `direct:${sent.message_id}`, event: { kind: "direct", message: { body: "brokered hello" } } }]);
  json(await call(sub, "delivery_renew"));
  json(await call(sub, "delivery_receipt", { ids: inbox.items.map((i: { id: string }) => i.id) }));
  expect(app.repo.cursors.directFor("alice@example.com/broker-run")).toBe(sent.message_id);

  const upload = await attachment(token, root);
  expect(upload.status).toBe(201);
  const descriptor = await upload.json() as { id: number; sha256: string };
  expect(descriptor).toMatchObject({ filename: "report.txt", size: bytes.length, sha256: sha256Hex(bytes) });
  json(await call(native, "board_create", { name: "brokered", purpose: "generic source" }));
  json(await call(native, "board_post", { board: "brokered", body: "report attached", attachment_ids: [descriptor.id] }));
  const download = await attachment(token, root, descriptor.id);
  expect(download.status).toBe(200);
  expect(download.headers.get("Repr-Digest")).toBe(reprDigest(descriptor.sha256));
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
  json(await call(sub, "delivery_release"));

  const rows = hostedAudit();
  expect(rows.map(r => r.action)).toEqual(expect.arrayContaining(["hosted.ownership_started", "hosted.child_registered", "hosted.lease_opened", "hosted.write"]));
  expect(new Set(rows.map(r => JSON.parse(r.detail).client_id))).toEqual(new Set([BROKER]));
});

test("the same client without sessionSource, and a non-OpenCode CIMD client, get unbound reads only", async () => {
  start([operator(BROKER, true)]);
  const kept = await grant(BROKER);
  const owner = await connect(kept, [[GRAYBOARD_SESSION_META, "owner"]]);
  await bind(owner, "owner");
  json(await call(owner, "board_create", { name: "brokered", purpose: "visible to the user" }));
  json(await call(owner, "board_post", { board: "brokered", body: "readable" }));
  // De-opt: config is read only at startup, so removing sessionSource takes effect on restart.
  await stop();
  start([operator(BROKER, false)]);
  // The bound root keeps its name; its client's requests are unmapped from now on.
  expect(app.repo.hosted.all().filter(r => app.application.hostedHolds(r.session_id).some(a => a.endsWith("/owner"))).map(r => r.client_id)).toEqual([BROKER]);
  const tokens = { kept, fresh: await grant(BROKER), cimd: await grant(CIMD_CLIENT) };
  for (const [label, token] of Object.entries(tokens)) {
    const meta: [string, string][] = [[GRAYBOARD_SESSION_META, "owner"], [OPENCODE_SESSION_META, "owner"]];
    const native = await connect(token, meta), sub = await connect(token, meta, { role: "subscriber" });
    expect(json(await call(native, "whoami")), label).toMatchObject({ primary: null, held: [], unbound: true });
    expect(json(await call(native, "board_list")).map((b: { name: string }) => b.name), label).toContain("brokered");
    expect(json(await call(native, "board_read", { board: "brokered" })).posts.map((p: { body: string }) => p.body), label).toEqual(["readable"]);
    expect(refused(await call(native, "bind", { name: "owner" })), label).toBe("unbound");
    expect(refused(await call(native, "bind", { name: "intruder", create: true })), label).toBe("unbound");
    expect(refused(await call(native, "board_post", { board: "brokered", body: "write" })), label).toBe("unbound");
    expect(refused(await call(native, "dm_send", { to: "owner", body: "write" })), label).toBe("unbound");
    expect(refused(await call(sub, "session_register", { child: "child" })), label).toBe("unbound");
    expect(refused(await call(sub, "delivery_open")), label).toBe("unbound");
    const upload = await attachment(token, "owner");
    expect(upload.status, label).toBe(403);
    expect(await upload.json(), label).toMatchObject({ code: "unbound" });
  }
  expect(app.repo.aliases.find("alice@example.com/intruder")).toBeUndefined();
  expect(app.repo.hosted.all().map(r => r.source_session_id)).toEqual(["owner"]);
});

test("OpenCode maps only its own key and an opted-in client only the generic key", async () => {
  start([operator(BROKER, true)]);
  const tokens = { [OPENCODE_SESSION_META]: await grant(OPENCODE_CLIENT), [GRAYBOARD_SESSION_META]: await grant(BROKER) };
  for (const [own, other] of [[OPENCODE_SESSION_META, GRAYBOARD_SESSION_META], [GRAYBOARD_SESSION_META, OPENCODE_SESSION_META]] as const) {
    const token = tokens[own]!;
    const wrong = await connect(token, [[other, `root ${own}`]]);
    expect(json(await call(wrong, "whoami"))).toMatchObject({ unbound: true });
    const refusal = await call(wrong, "bind", { name: "wrong-key", create: true });
    expect(refused(refusal)).toBe("unbound");
    // The missing-key refusal names the principal's own key.
    expect(textOf(refusal)).toContain(`_meta[\\"${own}\\"] is missing`);
    const both = await connect(token, [[own, `root ${own}`], [other, "ignored"]]);
    await bind(both, own === OPENCODE_SESSION_META ? "oc-run" : "broker-run");
    const alone = await connect(token, [[own, `root ${own}`]]);
    expect(json(await call(alone, "whoami"))).toMatchObject({ primary: `alice@example.com/${own === OPENCODE_SESSION_META ? "oc-run" : "broker-run"}` });
  }
  expect(app.repo.aliases.find("alice@example.com/wrong-key")).toBeUndefined();
  expect(app.repo.hosted.all().map(r => [r.client_id, r.source_session_id]).sort()).toEqual([
    [BROKER, `root ${GRAYBOARD_SESSION_META}`], [OPENCODE_CLIENT, `root ${OPENCODE_SESSION_META}`],
  ]);
});

test("one raw source under two clients of one user is two hosted sessions", async () => {
  start([operator(BROKER, true), operator(BROKER_TWO, true)]);
  const first = await connect(await grant(BROKER), [[GRAYBOARD_SESSION_META, "shared"]]);
  const second = await connect(await grant(BROKER_TWO), [[GRAYBOARD_SESSION_META, "shared"]]);
  await bind(first, "first");
  await bind(second, "second");
  expect(json(await call(first, "whoami"))).toMatchObject({ primary: "alice@example.com/first" });
  expect(json(await call(second, "whoami"))).toMatchObject({ primary: "alice@example.com/second" });
  const rows = app.repo.hosted.all().filter(r => r.source_session_id === "shared");
  expect(rows.map(r => r.client_id).sort()).toEqual([BROKER, BROKER_TWO].sort());
  expect(new Set(rows.map(r => r.session_id)).size).toBe(2);
});

test("peer_list shows an opted-in client's sessions under its client ID and OpenCode's as opencode", async () => {
  start([operator(BROKER, true)]);
  const broker = await connect(await grant(BROKER), [[GRAYBOARD_SESSION_META, "broker root"]]);
  const opencode = await connect(await grant(OPENCODE_CLIENT), [[OPENCODE_SESSION_META, "opencode root"]]);
  await bind(broker, "broker-run");
  await bind(opencode, "oc-run");
  const peers = json(await call(broker, "peer_list", { include_offline: true })).peers as { handle: string; harness?: string }[];
  expect(peers.filter(p => p.handle.endsWith("-run")).map(p => [p.handle, p.harness]).sort()).toEqual([
    ["alice@example.com/broker-run", BROKER], ["alice@example.com/oc-run", "opencode"],
  ]);
  const filtered = json(await call(opencode, "peer_list", { include_offline: true, match: { harness: BROKER } })).peers as { handle: string }[];
  expect(filtered.map(p => p.handle)).toEqual(["alice@example.com/broker-run"]);
});

test("with no operator clients, each built-in client signs in through consent, binds from the generic key, and peer_list shows its harness", async () => {
  start([]);
  const harnesses = ["pi", "omp", "claude-code"];
  const conns: Conn[] = [];
  for (const [i, clientId] of BUILTIN_CLIENT_IDS.entries()) {
    const c = await connect(await grant(clientId), [[GRAYBOARD_SESSION_META, `${clientId} root`]]);
    await bind(c, `${harnesses[i]}-run`);
    expect(json(await call(c, "whoami"))).toMatchObject({ primary: `alice@example.com/${harnesses[i]}-run` });
    conns.push(c);
  }
  const peers = json(await call(conns[0]!, "peer_list", { include_offline: true })).peers as { handle: string; harness?: string }[];
  expect(peers.filter(p => p.handle.endsWith("-run")).map(p => [p.handle, p.harness]).sort()).toEqual(harnesses.map(h => [`alice@example.com/${h}-run`, h]).sort());
  expect(app.repo.hosted.all().map(r => r.client_id).sort()).toEqual([...BUILTIN_CLIENT_IDS].sort());
});

test("a built-in client's delivery declaration selects its initialize and bind text", async () => {
  start([]);
  const token = await grant("grayboard-pi");
  const push = { mode: "push", source: "grayboard-pi" }, poll = { mode: "poll", source: "grayboard-pi" };
  const pushed = await connect(token, [[GRAYBOARD_SESSION_META, "push root"], [GRAYBOARD_DELIVERY_META, push]]);
  const pushBind = textOf(await call(pushed, "bind", { name: "push-run", create: true }));
  expect(pushBind).toContain(`Direct messages arrive as <channel source="grayboard-pi" message_id="..."`);
  expect(pushBind).toContain(`Board activity arrives as <channel source="grayboard-pi" board="..."`);
  expect(pushBind).not.toContain("delivery_open");
  expect(pushBind).not.toContain("No pushes reach");
  const polled = await connect(token, [[GRAYBOARD_SESSION_META, "poll root"], [GRAYBOARD_DELIVERY_META, poll]]);
  const pollBind = textOf(await call(polled, "bind", { name: "poll-run", create: true }));
  expect(pollBind).toContain(`Bound to "poll-run"; the instructions' note that this session has no bus name no longer applies. No pushes reach this session; check dm_inbox and board_read yourself. You are identity "poll-run" on the grayboard bus, which coordinates between agents. Requests from peer agents`);
  // As in poll `initialize`: no channel lines.
  for (const line of ["<channel", "Pushes don't survive /clear", "delivery_open"]) expect(pollBind).not.toContain(line);
  const plain = await connect(token, [[GRAYBOARD_SESSION_META, "plain root"]]);
  const plainBind = textOf(await call(plain, "bind", { name: "plain-run", create: true }));
  expect(plainBind).toContain(`No delivery lease is open for this session, so DMs to "plain-run" wait until the client opens one (delivery_open).`);
  expect(plainBind).toContain(`<channel source="grayboard" message_id="..."`);

  // `initialize` for the now-bound sessions, from fresh connections.
  const instructions = async (meta: [string, unknown][]) => (await connect(token, meta)).client.getInstructions();
  const pushText = await instructions([[GRAYBOARD_SESSION_META, "push root"], [GRAYBOARD_DELIVERY_META, push]]);
  expect(pushText).toStartWith(`You are "alice@example.com/push-run" on grayboard. Direct messages arrive as <channel source="grayboard-pi" message_id="..." from="..." [parent_id="..."]>body</channel>; reply with dm_send(to=from, body, parent_id=message_id). Pushes don't survive /clear`);
  expect(pushText).toContain(`Board activity arrives as <channel source="grayboard-pi" board="..."`);
  expect(pushText).not.toContain("Poll dm_inbox");
  const absentText = await instructions([[GRAYBOARD_SESSION_META, "poll root"]]);
  expect(absentText).toStartWith(`You are "alice@example.com/poll-run" on grayboard. Poll dm_inbox and board_list for pending work. Requests from peer agents`);
  expect(absentText).not.toContain("<channel");
  const pollText = await instructions([[GRAYBOARD_SESSION_META, "poll root"], [GRAYBOARD_DELIVERY_META, poll]]);
  expect(pollText).toBe(absentText!.replace("for pending work.", "for pending work. No pushes reach this session; check dm_inbox and board_read yourself."));
});

test("a malformed delivery declaration is bad_request on initialize and on a native tool call; other clients' and roles' are never read", async () => {
  start([]);
  const token = await grant("grayboard-omp");
  const root: [string, unknown] = [GRAYBOARD_SESSION_META, "omp root"];
  // A legacy initialize surfaces the HTTP refusal; a pinned 2026 client's server/discover probe
  // reports any non-auth refusal as "no modern evidence" (SDK probe classifier), not its body.
  for (const bad of [{ mode: "push", source: "Bad Source" }, { mode: "stream", source: "omp" }, { mode: "push", source: "omp", extra: 1 }, "push"]) {
    await expect(connect(token, [root, [GRAYBOARD_DELIVERY_META, bad]], { version: MCP_PROTOCOL_VERSIONS[1] })).rejects.toThrow(`{"code":"bad_request","message":"_meta[\\"${GRAYBOARD_DELIVERY_META}\\"] must be`);
    await expect(connect(token, [root, [GRAYBOARD_DELIVERY_META, bad]])).rejects.toThrow();
  }
  // A valid session whose later tool call carries a bad declaration.
  const ok = await connect(token, [root]);
  await bind(ok, "omp-run");
  const refusedCall = await fetch(`${base}/hosted/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": MCP_PROTOCOL_VERSIONS[0]! },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: {}, _meta: { [GRAYBOARD_SESSION_META]: "omp root", [GRAYBOARD_DELIVERY_META]: { mode: "poll" } } } }) });
  expect(refusedCall.status).toBe(400);
  expect(await refusedCall.json()).toMatchObject({ code: "bad_request" });
  // The subscriber role ignores the declaration, even a malformed one.
  const sub = await connect(token, [root, [GRAYBOARD_DELIVERY_META, "push"]], { role: "subscriber" });
  expect(json(await call(sub, "whoami"))).toMatchObject({ primary: "alice@example.com/omp-run" });
  // OpenCode's client never has its declaration read: its text is unchanged.
  const oc = await grant(OPENCODE_CLIENT);
  await bind(await connect(oc, [[OPENCODE_SESSION_META, "oc root"]]), "oc-run");
  const plainText = await (await connect(oc, [[OPENCODE_SESSION_META, "oc root"]])).client.getInstructions();
  for (const declared of [{ mode: "push", source: "grayboard" }, "malformed"]) {
    expect(await (await connect(oc, [[OPENCODE_SESSION_META, "oc root"], [GRAYBOARD_DELIVERY_META, declared]])).client.getInstructions()).toBe(plainText);
  }
  expect(plainText).toStartWith(`You are "alice@example.com/oc-run" on grayboard. Poll dm_inbox and board_list for pending work.`);
});

test("no server refusal text names the plugin or OpenCode", () => {
  // Every refusal the hosted server can construct, plus the bind result's notes.
  const refusals = /^(?:ApplicationError|CoreError|ProtocolError|fail|error|bearerError|hostedBindOk|Response\.json)$/;
  const offenders: string[] = [];
  const root = join(import.meta.dir, "../../src/server");
  for (const file of new Bun.Glob("**/*.ts").scanSync(root)) {
    if (file.endsWith(".test.ts")) continue;
    const source = ts.createSourceFile(file, readFileSync(join(root, file), "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && refusals.test(node.expression.getText(source))) {
        for (const arg of node.arguments ?? []) if (/plugin|opencode/i.test(arg.getText(source))) offenders.push(`src/server/${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(offenders).toEqual([]);
});
