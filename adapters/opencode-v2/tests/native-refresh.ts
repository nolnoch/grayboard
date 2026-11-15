// #661 on a real OpenCode host (pinned 2.1.4, which refreshes a native token
// only after a request draws a 401): an idle root whose token expires pauses
// past the rotation grace, the plugin's reconnect makes OpenCode refresh, and
// delivery resumes on its own, under the same ownership, without drift, and in
// this location only. A native call in flight holds the reconnect until it
// completes. Run by tests/native-refresh.sh.
import assert from "node:assert/strict";
import { join } from "node:path";
import { createFixtureHost } from "./effect-host.js";
import { fromPromise } from "@opencode/plugin/promise/adapter";
import { Plugin, Provider, Model } from "@opencode/plugin";
import type { Context } from "@opencode/plugin/promise/plugin";
import installed, { Grayboard } from "../src/index.js";

const root = process.env.GRAYBOARD_REFRESH_TEST_ROOT!; assert(root); assert.equal(Bun.version, "1.4.4");
for (const name of ["sdk", "core", "plugin"]) assert.equal((await Bun.file(join(import.meta.dir, `../node_modules/@opencode/${name}/package.json`)).json()).version, "2.1.4");
const log = (tag: string, data: unknown) => console.log(tag, JSON.stringify(data));
// Access token lifetimes in seconds, by issue: the first expires while the root
// is idle, the first refresh's while a native call is held, the last never.
const TTLS = [3, 8], LAST_TTL = 600;
// The user's own timeouts on the entry, which the reconnect must keep.
const USER_TIMEOUT = { startup: 20_000, catalog: 45_000 };

const issuer = "https://grayboard.example.com", resource = issuer + "/mcp", scope = "grayboard:delivery grayboard:tools";
// Server-side token table: access -> expiry (server clock).
const valid = new Map<string, number>();
let issued = 0, codes = 0, refreshes = 0, callbackOrigin = "";
const refreshedAt: number[] = [];
const ttl = (n: number) => TTLS[n - 1] ?? LAST_TTL;
const mint = () => { const t = "fixture-access-" + ++issued; valid.set(t, Date.now() + ttl(issued) * 1000); return t; };
type State = { held: string[]; ownership: number | null; gen: number; capability?: string };
const sessions = new Map<string, State>();
const state = (id: string) => { if (!sessions.has(id)) sessions.set(id, { held: [], ownership: null, gen: 0 }); return sessions.get(id)!; };
const requests: { method: string; token: string; ok: boolean; subscriber: boolean; at: number }[] = [];
let nextOwnership = 0, target = "first", tool = "grayboard_bind", modelIssued = false;
let hold: { entered: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | undefined;
const fetch0 = globalThis.fetch;
const json = (id: unknown, result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
const result = (output: Record<string, unknown>) => ({ resultType: "complete", content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init), url = new URL(req.url);
  if (url.origin === callbackOrigin) return fetch0(req);
  if (url.origin === "https://model.example.com") {
    await req.json(); const done = modelIssued; modelIssued = true;
    const args = tool === "grayboard_bind" ? { name: target } : {};
    const delta = done ? { content: "done" } : { role: "assistant", tool_calls: [{ index: 0, id: "call_" + Math.random().toString(36).slice(2), type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] };
    return new Response("data: " + JSON.stringify({ id: "local", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] }) + "\n\ndata: " + JSON.stringify({ id: "local", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: done ? "stop" : "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) + "\n\ndata: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  }
  if (url.origin !== issuer) throw new Error("Nonfixture network denied: " + url.origin);
  if (url.pathname.includes(".well-known/oauth-protected-resource")) return Response.json({ resource, authorization_servers: [issuer], scopes_supported: scope.split(" ") });
  if (url.pathname.includes(".well-known/")) return Response.json({ issuer, authorization_endpoint: issuer + "/authorize", token_endpoint: issuer + "/token", registration_endpoint: issuer + "/register", response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], scopes_supported: scope.split(" ") });
  if (url.pathname === "/register") return Response.json({ ...(await req.json() as object), client_id: "fixture-native-client", token_endpoint_auth_method: "none" }, { status: 201 });
  if (url.pathname === "/token") {
    const form = new URLSearchParams(await req.text());
    if (form.get("grant_type") === "refresh_token") { refreshes++; refreshedAt.push(Date.now()); log("TOKEN_REFRESH", { n: refreshes }); }
    else codes++;
    const access = mint();
    return Response.json({ access_token: access, token_type: "Bearer", expires_in: ttl(issued), refresh_token: "fixture-refresh", scope });
  }
  assert.equal(url.pathname, "/mcp");
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
  const subscriber = req.headers.get("X-Grayboard-Client") === "subscriber";
  const ok = (valid.get(token) ?? 0) > Date.now();
  const peek = req.method === "POST" ? await req.clone().json().catch(() => ({})) as any : {};
  requests.push({ method: req.method + ":" + (peek.method ?? ""), token, ok, subscriber, at: Date.now() });
  if (!ok) return new Response(null, { status: 401, headers: { "WWW-Authenticate": `Bearer error="invalid_token", resource_metadata="${issuer}/.well-known/oauth-protected-resource", scope="${scope}"` } });
  if (req.method === "GET") return new Response(null, { status: 405 });
  if (req.method === "DELETE") return new Response(null, { status: 200 });
  const b = await req.json() as any;
  if (b.id === undefined) return new Response(null, { status: 202 });
  if (b.method === "server/discover") return json(b.id, { supportedVersions: ["2026-07-28"], capabilities: { tools: {}, resources: {} }, ttlMs: 0, cacheScope: "private" });
  if (b.method === "initialize") return json(b.id, { protocolVersion: b.params.protocolVersion, capabilities: { tools: {}, resources: { subscribe: true } }, serverInfo: { name: "grayboard-fixture", version: "0" } });
  if (b.method === "tools/list") return json(b.id, { tools: [{ name: "bind", description: "Bind a task name", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false } }, { name: "whoami", description: "Read session binding", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] });
  if (b.method === "resources/list") return json(b.id, { resources: [] });
  const session = b.params?._meta?.["ai.opencode/sessionID"];
  if (typeof session !== "string") return json(b.id, {});
  const s = state(session);
  if (b.method === "subscriptions/listen") {
    const stream = new ReadableStream({ start(c) {
      req.signal.addEventListener("abort", () => { try { c.close(); } catch {} }, { once: true });
      // Like the real server's hourly rollover: the stream ends when its access token expires.
      // Unref'd: the last token's 600 s must not keep the process alive.
      setTimeout(() => { log("LISTEN_CLOSED_AT_EXPIRY", { session, token }); try { c.close(); } catch {} }, Math.max(0, valid.get(token)! - Date.now())).unref();
      c.enqueue(new TextEncoder().encode("data: " + JSON.stringify({ jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged", params: { _meta: { "io.modelcontextprotocol/subscriptionId": b.id }, notifications: b.params.notifications } }) + "\n\n"));
    } });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  }
  if (b.method === "resources/read") return json(b.id, { resultType: "complete", ttlMs: 0, cacheScope: "private", contents: [{ uri: b.params.uri, mimeType: "application/json", text: JSON.stringify({ items: [] }) }] });
  if (b.method !== "tools/call") return json(b.id, {});
  const name = b.params.name, args = b.params.arguments ?? {};
  if (name === "whoami") {
    if (hold && !subscriber) { const h = hold; h.entered.resolve(); await h.release.promise; log("WHOAMI_RELEASED", { session, aborted: req.signal.aborted }); }
    return json(b.id, result({ kind: "root", held: s.held.map(h => "you@example.com/" + h), primary: s.held[0] ? "you@example.com/" + s.held[0] : null, ownership: s.ownership, candidates: [] }));
  }
  if (name === "bind") { if (!s.held.includes(args.name)) s.held.push(args.name); s.ownership ??= ++nextOwnership; s.gen++; return json(b.id, result({ name: s.held[0]!, ownership: s.ownership, instructions: ["Bound fixture"] })); }
  if (name === "session_register" || name === "session_end") return json(b.id, result({ ok: true }));
  if (name === "delivery_open") { s.capability = String(s.ownership).padStart(40, "a") + String(s.gen).padStart(3, "0"); return json(b.id, result({ capability: s.capability, ownership: s.ownership, bind_gen: s.gen, expiresAt: Date.now() + 60_000, identity: { user_email: "you@example.com", identity_full: "you@example.com/" + s.held[0] } })); }
  if (name.startsWith("delivery_")) return json(b.id, result({ ok: true }));
  throw new Error("Unexpected fixture tool: " + name);
}) as typeof fetch;

// One fixture plugin context per location (OpenCode instantiates plugins per location).
const ctxs = new Map<string, Context>();
const toolResults: { tool: string; session: string; status: string; at: number }[] = [];
const switched: string[] = [];
const fixture = Plugin.define({ id: "grayboard.native.fixture", async setup(c) {
  ctxs.set(c.location.directory, c);
  // The user's native entry, with their own timeouts.
  await c.mcp.transform(e => { e.set("grayboard", { type: "remote", url: resource, codemode: false, timeout: { ...USER_TIMEOUT } }); });
  const p = Provider.ID.make("fixture");
  await c.provider.transform(e => e.add({ info: { ...Provider.Info.empty(p), name: "Fixture", activation: "enabled", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: "https://model.example.com/v1" } }, models: [{ ...Model.Info.default(p, Model.ID.make("fixture")), name: "Fixture" }] }));
  await c.session.hook("title", e => { e.result = "Fixture"; });
  await c.tool.hook("execute.after", e => { toolResults.push({ tool: e.tool, session: e.sessionID, status: e.status, at: Date.now() }); });
  const ac = new AbortController();
  void (async () => { try { for await (const ev of await c.event.subscribe({ signal: ac.signal }) as AsyncIterable<{ type: string }>) if (ev.type.includes("switched")) { switched.push(ev.type); log("SWITCHED", { type: ev.type, at: Date.now() }); } } catch {} })();
} });
// Every wait has a deadline and names the condition that never held.
async function wait<T>(read: () => Promise<T>, predicate: (v: T) => boolean, label: string, ms = 15_000) {
  const deadline = Date.now() + ms;
  for (;;) { const v = await read(); if (predicate(v)) return v; if (Date.now() > deadline) throw new Error("Wait expired: " + label + " (last: " + JSON.stringify(v) + ")"); await Bun.sleep(50); }
}
const hostLog: { message: string; attributes?: Record<string, unknown> }[] = [];
const dirA = join(root, "project-a"), dirB = join(root, "project-b");
const locA = { directory: dirA }, locB = { directory: dirB };
const connected = (dir: string) => hostLog.filter(l => l.message === "mcp connected" && l.attributes?.server === "grayboard" && l.attributes?.directory === dir).length;
let host: Awaited<ReturnType<typeof createFixtureHost>> | undefined;
try {
  host = await createFixtureHost({ log: { level: "debug", emit: entry => { hostLog.push({ message: entry.message, attributes: entry.attributes as Record<string, unknown> }); } }, plugins: [fromPromise(fixture), installed], database: { path: join(root, "host.sqlite") }, models: { fetch: false }, config: { directory: join(root, "native-config"), project: false, claude: false }, fs: { filewatcher: false } });
  await host.agent.list({ location: locA }); await host.agent.list({ location: locB });
  const rpc = host.rpc(Grayboard);
  const ctxA = (await wait(async () => ctxs.get(dirA), Boolean, "fixture setup A"))!;
  const ctxB = (await wait(async () => ctxs.get(dirB), Boolean, "fixture setup B"))!;
  const native = await wait(async () => (await ctxA.mcp.list()).data.find(x => x.name === "grayboard"), x => x?.status.status === "needs_auth", "native discovery");
  const integrationID = native!.integrationID!;
  const method = (await ctxA.integration.get({ integrationID })).data?.methods.find(m => m.type === "oauth"); assert(method);
  const attempt = await ctxA.integration.oauth.connect({ integrationID, methodID: method.id });
  const auth = new URL(attempt.data.url), returned = new URL(auth.searchParams.get("redirect_uri")!); callbackOrigin = returned.origin;
  returned.searchParams.set("code", "fixture-code"); returned.searchParams.set("state", auth.searchParams.get("state")!); returned.searchParams.set("iss", issuer);
  assert.equal((await fetch(returned)).status, 200);
  await wait(() => ctxA.integration.connection.active(integrationID), Boolean, "native credential");
  await host.mcp.connect({ server: "grayboard", location: locA });
  await wait(async () => (await ctxB.mcp.list()).data.find(x => x.name === "grayboard"), Boolean, "native discovery B");
  await host.mcp.connect({ server: "grayboard", location: locB });
  await wait(() => ctxA.tool.list(), ts => ts.some(t => t.id === "grayboard_bind"), "native tool A");
  await wait(() => ctxB.tool.list(), ts => ts.some(t => t.id === "grayboard_bind"), "native tool B");
  const credential = async () => {
    const c = await ctxA.integration.connection.active(integrationID); assert(c?.type === "credential");
    const v = await ctxA.integration.connection.resolve(c) as { access: string; expires: number; metadata?: Record<string, unknown> };
    return { connectionID: c.id, access: v.access, expires: v.expires, issuer: v.metadata?.issuer, scope: v.metadata?.scope };
  };
  // The entry as OpenCode applies it in A: a transform registered last sees every earlier one's edit.
  const applied = async () => {
    let seen: unknown;
    const observer = await ctxA.mcp.transform(e => { seen = structuredClone(e.get("grayboard")); });
    await observer.dispose();
    return seen as { timeout?: unknown };
  };
  async function invoke(id: string, name: string, which = "grayboard_bind") {
    target = name; tool = which; modelIssued = false;
    await host!.session.switchModel({ sessionID: id, model: { providerID: "fixture", id: "fixture" } });
    await host!.session.prompt({ sessionID: id, text: "Call " + which });
  }
  // The root's status records, as they change.
  const seen: string[] = [];
  const rootA = async () => {
    const s = await rpc.status({}, { location: locA }), r = s.roots.find(x => x.sessionID === a.id);
    const tag = r ? [r.state, r.operation ?? "", r.code ?? ""].join(":") : "none";
    if (seen.at(-1) !== tag) seen.push(tag);
    return r;
  };
  const a = await host.session.create({ location: locA, title: "Root A", permissions: [{ action: "*", resource: "*", effect: "allow" }] });
  await rpc.enroll({ sessionID: a.id }, { location: locA });
  await invoke(a.id, "first"); await host.session.wait({ sessionID: a.id });
  const active = await wait(rootA, r => r?.state === "active", "root A active");
  const ownership = active!.ownership;
  assert(typeof ownership === "number");
  // The sign-in itself switched the credential; nothing after it may.
  const first = await credential(), connA0 = connected(dirA), connB0 = connected(dirB), switched0 = switched.length;
  assert.deepEqual((await applied()).timeout, USER_TIMEOUT);

  // 1. The idle root's token expires; 2.1.4 refreshes nothing on its own. Past the grace the root pauses
  // awaiting the refresh, the plugin reconnects A, the reconnect's 401 refreshes, and delivery resumes.
  await wait(rootA, r => r?.state === "paused" && r.code === "native_access_expired", "root pauses awaiting the refresh", 30_000);
  await wait(rootA, r => r?.state === "active" && refreshes === 1, "delivery resumes after the plugin's reconnect", 30_000);
  const second = await credential();
  log("PHASE1", { seen, refreshes, connectedA: connected(dirA) - connA0, connectedB: connected(dirB) - connB0 });
  assert.equal(refreshes, 1);
  assert.equal(connected(dirA) - connA0, 1, "one reconnect of A");
  assert.notEqual(second.access, first.access);
  assert.equal(second.connectionID, first.connectionID);
  assert.equal(second.issuer, first.issuer); assert.equal(second.scope, first.scope);
  assert((await rootA())?.ownership === ownership, "the same ownership");
  assert.deepEqual((await rootA())?.held, ["you@example.com/first"]);
  // The recovering record is too brief for a 50 ms poll; the unit tests pin it.
  assert.deepEqual(seen.slice(-2), ["paused:subscriber:native_access_expired", "active:delivery:"]);
  assert.equal(switched.length, switched0, "a refresh is no credential switch");
  // Only timeout.catalog moved, by one; the startup timeout is the user's.
  assert.deepEqual((await applied()).timeout, { ...USER_TIMEOUT, catalog: USER_TIMEOUT.catalog + 1 });

  // 2. The refreshed token expires while a native call is in flight: the plugin never reconnects under it.
  hold = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
  const results0 = toolResults.length;
  await invoke(a.id, "", "grayboard_whoami");
  await Promise.race([hold.entered.promise, Bun.sleep(10_000).then(() => { throw new Error("Wait expired: the held whoami reached the server"); })]);
  await wait(rootA, r => r?.state === "paused" && r.code === "native_access_expired", "root pauses on the second expiry", 30_000);
  const connA1 = connected(dirA);
  // Long enough for the recovery's first attempts (1 s, 2 s, 4 s).
  await Bun.sleep(8_000);
  log("PHASE2_HELD", { seen, refreshes, connectedA: connected(dirA) - connA1 });
  assert.equal(connected(dirA), connA1, "no reconnect while the call is in flight");
  assert.equal(refreshes, 1, "no refresh while the call is in flight");
  assert.equal((await rootA())?.state, "paused");
  hold.release.resolve();
  await host.session.wait({ sessionID: a.id });
  const held = toolResults.slice(results0).filter(r => r.tool === "grayboard_whoami");
  assert.deepEqual(held.map(r => r.status), ["completed"], "the held call completed");
  hold = undefined;
  // Released: the next attempt reconnects, the refresh lands, delivery resumes.
  await wait(rootA, r => r?.state === "active" && refreshes === 2, "delivery resumes once the call completed", 45_000);
  assert(refreshedAt[1]! > held[0]!.at, "the refresh came after the held call completed");
  assert.equal(connected(dirA) - connA1, 1);
  assert((await rootA())?.ownership === ownership, "the same ownership");
  // The second reconnect flipped back to exactly the user's timeouts.
  assert.deepEqual((await applied()).timeout, USER_TIMEOUT);
  // Another location is never reconnected.
  assert.equal(connected(dirB), connB0, "B never reconnected");
  assert.equal(switched.length, switched0);
  log("PASS", { seen, refreshes, codes, issued });
} finally { await host?.close(); globalThis.fetch = fetch0; }
