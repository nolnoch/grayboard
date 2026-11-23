// hosted-core's wire (#430) against a real in-process server, for the
// built-in pi client: the inbox listen acknowledgment on the 2026-07-28
// revision, the server's own status and body for a refusal at initialize, and
// a scope refusal classified for a new sign-in.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { abortOf, ConnectRefused, DELIVERY_META, EFFORT_META, InsufficientScope, LAUNCHER_META, LISTEN_CAPACITY, listenCapacity, MODEL_META, NativeWire, SERVER_TEXT_LIMIT, ServerBusy, SUGGESTED_META, Wire, type WireOptions } from "../../adapters/hosted-core/src/wire.ts";
import { GRAYBOARD_DELIVERY_META, GRAYBOARD_EFFORT_META, GRAYBOARD_LAUNCHER_META, GRAYBOARD_MODEL_META, GRAYBOARD_SESSION_META, GRAYBOARD_SUGGESTED_META } from "../../src/shared/session_meta.ts";
import { issueOAuth } from "../helpers/oauth.ts";
import { DEFAULT_MCP_LIMITS } from "../../src/server/config.ts";
import { TestServer } from "../support/server.ts";
import { rows } from "../support/repo_sql.ts";
import { until } from "../support/until.ts";

const CLIENT = "grayboard-pi";
let srv: TestServer;
const wires: { close(): Promise<void> }[] = [];
beforeEach(async () => { srv = await TestServer.open({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 } }); });
afterEach(async () => {
  await Promise.all(wires.splice(0).map(w => w.close().catch(() => {})));
  await srv.stop();
});
const options = (delivery: unknown = { mode: "push", source: "grayboard-pi" }): WireOptions =>
  ({ url: `${srv.base}/mcp`, sessionKey: GRAYBOARD_SESSION_META, client: { name: "grayboard-pi", version: "1.0.0" }, delivery: delivery as WireOptions["delivery"] });
const issue = async (scopes = ["grayboard:tools", "grayboard:delivery"]) => (await issueOAuth(srv.app.repo, srv.app.oauth.resource, "alice@example.com", scopes, Date.now(), CLIENT)).token;
function subscriber(token: string, wireOptions = options(), sessionID = "raw-root") {
  const wire = new Wire(wireOptions, { token: async () => token }, new AbortController().signal, sessionID);
  wires.push(wire);
  return wire;
}

// The wire is vendored to OpenCode V2, which can't import the repo's src/, so
// it keeps its own copy of the key the server reads (#444).
test("the wire's delivery key is the one the server reads", () => {
  expect(DELIVERY_META).toBe(GRAYBOARD_DELIVERY_META);
  expect(LAUNCHER_META).toBe(GRAYBOARD_LAUNCHER_META);
  expect(MODEL_META).toBe(GRAYBOARD_MODEL_META);
  expect(EFFORT_META).toBe(GRAYBOARD_EFFORT_META);
  expect(SUGGESTED_META).toBe(GRAYBOARD_SUGGESTED_META);
});

// Pins that the 2026-07-28 stream isn't held back like the legacy GET (#431).
test("subscriptions/listen acknowledges the leased inbox within 1 s", async () => {
  const wire = subscriber(await issue());
  await wire.connect();
  await wire.call("bind", { name: "be", create: true });
  wire.capability = (await wire.call("delivery_open") as { capability: string }).capability;
  const started = performance.now();
  const subscription = await wire.listen();
  const elapsed = performance.now() - started;
  await subscription.close();
  expect(elapsed).toBeLessThan(1000);
});

// The SDK reports a 400 at initialize only as "Version negotiation failed".
// The server checks the declaration on the native role only.
test("a refusal at initialize surfaces the server's HTTP status and body", async () => {
  const token = await issue();
  const wire = new NativeWire(options({ mode: "shout", source: "grayboard-pi" }), { token: async () => token }, new AbortController().signal, "raw-root");
  wires.push(wire);
  const error = await wire.connect().then(() => undefined, e => e);
  expect(error).toBeInstanceOf(ConnectRefused);
  expect(error.status).toBe(400);
  expect(error.code).toBe("bad_request");
  expect(error.body).toContain("bad_request");
  expect(error.message).toBe(`Server refused the connection (HTTP 400): ${error.body}`);
});

test("a token without the tools scope is a scope refusal, never a refresh", async () => {
  let refreshes = 0;
  const wire = new NativeWire(options(), { token: async () => issue(["grayboard:delivery"]), onUnauthorized: async () => { refreshes++; } }, new AbortController().signal, "raw-root");
  wires.push(wire);
  const error = await wire.connect().then(() => wire.callTool("whoami", {}, "raw-root")).then(() => undefined, e => e);
  expect(error).toBeInstanceOf(InsufficientScope);
  expect(refreshes).toBe(0);
});

// OpenCode's native client starts a root's ownership with no plugin `_meta`; the plugin's subscriber wire declares
// the launcher on a later request, and that turns the ownership's flag on (#520).
test("a root's later subscriber request declares the launcher its native first request didn't", async () => {
  const token = await issue();
  const native = new NativeWire(options(), { token: async () => token }, new AbortController().signal, "raw-root");
  wires.push(native);
  await native.connect();
  await native.callTool("bind", { name: "lead", create: true }, "raw-root");
  const launcher = async () => (await rows<{ launcher: number }>(srv, "SELECT launcher FROM ids WHERE principal = ? AND ended_at IS NULL", "alice@example.com")).map(r => r.launcher);
  expect(await launcher()).toEqual([0]);
  const wire = subscriber(token, { ...options(), launcher: true });
  await wire.connect();
  await wire.call("whoami");
  expect(await launcher()).toEqual([1]);
});

// The facts provider is read per request for the session the request names (#364): the native wire, shared across
// sessions, sends each call's own session's facts; a change reaches the server on the next request; a provider that
// throws or answers nothing sends no keys, which never clears what the server holds.
test("each request carries its session's current model and effort, and a provider that fails sends none (#364)", async () => {
  const token = await issue();
  const facts = new Map<string, { model?: string | null; effort?: string | null }>([["raw-a", { model: "anthropic/claude-opus-5-5", effort: "high" }], ["raw-b", { model: "openai/gpt-6" }]]);
  let broken = false;
  const native = new NativeWire({ ...options(), facts: id => { if (broken) throw new Error("gone"); return facts.get(id); } }, { token: async () => token }, new AbortController().signal);
  wires.push(native);
  await native.connect();
  await native.callTool("bind", { name: "a", create: true }, "raw-a");
  await native.callTool("bind", { name: "b", create: true }, "raw-b");
  // peer_list's own request carries raw-a's facts too, so the check reads them as the latest request left them.
  const row = async (name: string) => {
    const result = await native.callTool("peer_list", { include_offline: true }, "raw-a");
    const { peers } = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as { peers: Array<{ handle: string; model?: string | null; effort?: string | null }> };
    const peer = peers.find(p => p.handle === `alice@example.com/${name}`); if (!peer) throw new Error(JSON.stringify(peers));
    return { model: peer.model ?? null, effort: peer.effort ?? null };
  };
  expect(await row("a")).toEqual({ model: "anthropic/claude-opus-5-5", effort: "high" });
  expect(await row("b")).toEqual({ model: "openai/gpt-6", effort: null });
  facts.set("raw-a", { model: "anthropic/claude-sonnet-5-5", effort: "" });
  await native.callTool("whoami", {}, "raw-a");
  expect(await row("a")).toEqual({ model: "anthropic/claude-sonnet-5-5", effort: "high" });
  broken = true;
  await native.callTool("whoami", {}, "raw-a");
  expect(await row("a")).toEqual({ model: "anthropic/claude-sonnet-5-5", effort: "high" });
  // The subscriber wire, bound to one session, sends that session's facts.
  broken = false;
  facts.set("raw-b", { model: "openai/gpt-6", effort: "low" });
  const wire = new Wire({ ...options(), facts: id => facts.get(id) }, { token: async () => token }, new AbortController().signal, "raw-b");
  wires.push(wire);
  await wire.connect();
  await wire.call("whoami");
  expect(await row("b")).toEqual({ model: "openai/gpt-6", effort: "low" });
  // A provider's null is "none": it clears the server's (#558), on either wire; absent keeps it.
  facts.set("raw-b", { model: "openai/gpt-6", effort: null });
  await wire.call("whoami");
  expect(await row("b")).toEqual({ model: "openai/gpt-6", effort: null });
  facts.set("raw-a", { model: null });
  await native.callTool("whoami", {}, "raw-a");
  expect(await row("a")).toEqual({ model: null, effort: "high" });
});

// The suggested name rides every request of the session it names (#522): the subscriber wire's first request fixes the
// ownership's, so a native request that never names a suggestion still sees it offered; a provider that throws sends none.
test("a wire's suggested name reaches the server and is offered first while unbound (#522)", async () => {
  const token = await issue();
  const native = new NativeWire({ ...options(), suggested: id => { if (id === "raw-x") throw new Error("gone"); return id === "raw-s" ? "repo-name" : undefined; } }, { token: async () => token }, new AbortController().signal);
  wires.push(native);
  await native.connect();
  const candidates = async (raw: string) => (JSON.parse(((await native.callTool("whoami", {}, raw)).content as Array<{ text: string }>)[0]!.text) as { candidates?: Array<Record<string, unknown> & { name: string; suggested?: true }> }).candidates ?? [];
  // A name that has never existed says so in the structure, not only the instruction text (#1640): bind needs create.
  expect((await candidates("raw-s"))[0]).toEqual({ name: "repo-name", queued: 0, claims: 0, where: null, suggested: true, fresh: true, create: true });
  expect((await candidates("raw-x")).some(c => c.suggested)).toBe(false);
  const wire = new Wire({ ...options(), suggested: () => "from-subscriber" }, { token: async () => token }, new AbortController().signal, "raw-w");
  wires.push(wire);
  await wire.connect();
  await wire.call("whoami");
  const plain = new NativeWire(options(), { token: async () => token }, new AbortController().signal);
  wires.push(plain);
  await plain.connect();
  expect((JSON.parse(((await plain.callTool("whoami", {}, "raw-w")).content as Array<{ text: string }>)[0]!.text) as { candidates: Array<{ name: string }> }).candidates[0]).toMatchObject({ name: "from-subscriber", suggested: true });
});

// A proxy's error page reaches the agent only capped (#276): at connect (the refusal capture) and on a later
// call (the SDK puts a failed POST's whole body in its message).
test("server-supplied error text is capped at connect and on a call", async () => {
  const page = `<html>${"x".repeat(100_000)}</html>`;
  let failCalls = false;
  const proxy = Bun.serve({ port: 0, async fetch(req) {
    const body = req.method === "POST" ? await req.text() : undefined;
    if (failCalls && body?.includes('"tools/call"')) return new Response(page, { status: 500, headers: { "Content-Type": "text/html" } });
    const url = new URL(req.url);
    const upstream = await fetch(`${srv.base}${url.pathname}${url.search}`, { method: req.method, headers: req.headers, body });
    return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
  } });
  try {
    const token = await issue();
    const proxied = { ...options(), url: `http://127.0.0.1:${proxy.port}/mcp` };
    const wire = new NativeWire(proxied, { token: async () => token }, new AbortController().signal, "raw-root");
    wires.push(wire);
    await wire.connect();
    failCalls = true;
    const error = await wire.callTool("whoami", {}, "raw-root").then(() => undefined, e => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("more characters cut");
    expect(error.message.length).toBeLessThan(SERVER_TEXT_LIMIT + 100);
    const refusal = new ConnectRefused(500, page);
    expect(refusal.message.length).toBeLessThan(SERVER_TEXT_LIMIT + 100);
    expect(refusal.message).toContain("more characters cut");
  } finally { proxy.stop(true); }
});

// #1309: a start's stop aborts its wire's signal; the SDK restates an aborted call as a RequestTimeout carrying only
// the reason's text, so the Controller's abortOf must still read it as that stop. Pins the restatement on the real SDK.
test.each(["whoami", "bind"] as const)("an aborted %s on a real wire is its stop's abort (#1309)", async name => {
  const token = await issue(), stop = new AbortController();
  const wire = new Wire(options(), { token: async () => token }, AbortSignal.any([AbortSignal.timeout(10_000), stop.signal]), "raw-root");
  wires.push(wire);
  await wire.connect();
  const pending = wire.call(name, name === "bind" ? { name: "be", create: true } : {}).then(() => undefined, e => e);
  stop.abort();
  const error = await pending;
  expect(error).toBeDefined();
  expect(abortOf(error, stop.signal)).toBe(true);
  expect(abortOf(error, new AbortController().signal)).toBe(false);
});

// #1394: the Controller retries a swap's listen only on the listen cap's refusal, which it recognizes by the server's
// plain-text body as the SDK raises it. Pins both ends: a second listen past the per-user cap, through the real wire
// and SDK, is exactly what listenCapacity matches, and the first listen's slot is held until it closes.
test("a listen past the per-user listen cap is the refusal listenCapacity matches", async () => {
  await srv.stop();
  srv = await TestServer.open({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 }, mcpLimits: { ...DEFAULT_MCP_LIMITS, listen: { global: 128, perUser: 1 } } });
  const token = await issue();
  const open = async (sessionID: string, name: string) => {
    const wire = subscriber(token, options(), sessionID);
    await wire.connect();
    await wire.call("bind", { name, create: true });
    wire.capability = (await wire.call("delivery_open") as { capability: string }).capability;
    return wire;
  };
  const first = await open("raw-root", "be"), second = await open("raw-root-2", "fe");
  const held = await first.listen();
  const refused = await second.listen().then(() => undefined, e => e);
  expect(listenCapacity(refused)).toBe(true);
  // The Rust SDK matches the same body (`delivery.rs` `relisten`); cargo isn't in this suite, so its constant is pinned here.
  expect(await Bun.file(new URL("../../sdk/rust/grayboard/src/delivery.rs", import.meta.url)).text()).toContain(`const LISTEN_CAPACITY: &str = "${LISTEN_CAPACITY}";`);
  await held.close();
  await until(async () => {
    const subscription = await second.listen().catch(() => undefined);
    await subscription?.close();
    return subscription;
  }, 5000, "the freed slot admits the second listen");
});

// #1536: a connect refused by the request cap retries and connects once a slot frees. The plain-text 429 it used to get
// reached the SDK's `server/discover` probe as a legacy server, a causeless ERA_NEGOTIATION_FAILED nothing retried.
test("a connect past the per-user request cap retries the server's rate_limited 429 and connects", async () => {
  await srv.stop();
  srv = await TestServer.open({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 }, mcpLimits: { ...DEFAULT_MCP_LIMITS, post: { global: 256, perUser: 1 } } });
  const token = await issue();
  // Hold the user's one POST slot: the server reserves it once the headers authenticate, and keeps it while the body is unread.
  const url = new URL(srv.base);
  const held = await Bun.connect({ hostname: url.hostname, port: Number(url.port), socket: { data() {} } });
  held.write(`POST /mcp HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{`);
  await until(() => srv.app.mcp.activePosts === 1, 5000, "the held POST takes the user's slot");
  const refused = await fetch(`${srv.base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" });
  expect(refused.status).toBe(429);
  const body = await refused.json() as { jsonrpc: string; id: null; error: { data: { code: string; retry_after_ms: number } } };
  expect(body).toMatchObject({ jsonrpc: "2.0", id: null, error: { data: { code: "rate_limited" } } });
  expect(body.error.data.retry_after_ms).toBeGreaterThanOrEqual(500);
  expect(body.error.data.retry_after_ms).toBeLessThan(1500);
  expect(refused.headers.get("Retry-After")).toMatch(/^[12]$/);
  const wire = subscriber(token);
  const connecting = wire.connect();
  await until(() => wire.admissionRetryAfterMs !== undefined, 5000, "the wire is refused and waits to retry");
  held.end();
  await connecting;
  expect(await wire.call("whoami")).toBeTruthy();
});

// #1536: a cap that stays full fails the connect as ServerBusy, an outage the controller retries, whether the wire's
// eight tries run out or a timeout (the SDK's or the wire's own signal) ends the waits first; never the causeless
// ERA_NEGOTIATION_FAILED the last 429 would read as.
test("a connect the request cap refuses on every try fails as ServerBusy", async () => {
  await srv.stop();
  srv = await TestServer.open({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 }, mcpLimits: { ...DEFAULT_MCP_LIMITS, post: { global: 256, perUser: 1 } } });
  const token = await issue();
  const url = new URL(srv.base);
  const held = await Bun.connect({ hostname: url.hostname, port: Number(url.port), socket: { data() {} } });
  try {
    held.write(`POST /mcp HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{`);
    await until(() => srv.app.mcp.activePosts === 1, 5000, "the held POST takes the user's slot");
    const error = await subscriber(token).connect().then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(ServerBusy);
    expect((error as ServerBusy).retryAfterMs).toBeGreaterThanOrEqual(500);
  } finally { held.end(); }
}, 30_000);
