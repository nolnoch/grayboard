import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { OpenCode } from "@opencode/sdk";
import { Plugin, Provider, Model } from "@opencode/plugin";
import type { Context } from "@opencode/plugin/promise/plugin";

const root = process.env.GRAYBOARD_GIT_TEST_ROOT!;
assert(root); assert.equal(Bun.version, "1.4.4");
assert.equal((await Bun.file(join(root, "node_modules/@opencode/sdk/package.json")).json()).version, "2.1.4");
const directory = readFileSync(join(root, "installed.txt"), "utf8").trim();
const { default: installed, Grayboard } = await import(pathToFileURL(join(directory, "src/index.ts")).href) as typeof import("../src/index.js");
const issuer = "https://grayboard.example.com", resource = issuer + "/mcp", scope = "grayboard:delivery grayboard:tools";
type State = { name: string | null; ownership: number | null; gen: number; capability?: string };
const sessions = new Map<string, State>(), children = new Map<string, string>();
const calls: { name: string; session: string; args: Record<string, unknown>; subscriber: boolean }[] = [];
let nextOwnership = 0, codes = 0, refreshes = 0, callbackOrigin = "", mode = process.env.GRAYBOARD_NATIVE_MODE ?? "direct", target = "first";
let ctx!: Context;
const state = (id: string) => { if (!sessions.has(id)) sessions.set(id, { name: null, ownership: null, gen: 0 }); return sessions.get(id)!; };
const fetch0 = globalThis.fetch;
const json = (id: unknown, result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
const result = (output: Record<string, unknown>) => ({ resultType: "complete", content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init), url = new URL(req.url);
  if (url.origin === callbackOrigin) return fetch0(req);
  if (url.origin === "https://model.example.com") {
    const b = await req.json() as any, done = b.messages.some((m: any) => m.role === "tool");
    const name = mode === "disabled" ? "grayboard_whoami" : mode === "code" ? "execute" : "grayboard_bind";
    const args = mode === "disabled" ? {} : mode === "code" ? { code: `return await tools.grayboard.bind({name:${JSON.stringify(target)}})` } : { name: target };
    const delta = done ? { content: "done" } : { role: "assistant", tool_calls: [{ index: 0, id: "call_fixture", type: "function", function: { name, arguments: JSON.stringify(args) } }] };
    return new Response("data: " + JSON.stringify({ id: "local", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] }) + "\n\ndata: " + JSON.stringify({ id: "local", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: done ? "stop" : "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) + "\n\ndata: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  }
  if (url.origin !== issuer) throw new Error("Nonfixture network denied: " + url.origin);
  if (url.pathname.includes(".well-known/oauth-protected-resource")) return Response.json({ resource, authorization_servers: [issuer], scopes_supported: scope.split(" ") });
  if (url.pathname.includes(".well-known/")) return Response.json({ issuer, authorization_endpoint: issuer + "/authorize", token_endpoint: issuer + "/token", registration_endpoint: issuer + "/register", response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], scopes_supported: scope.split(" ") });
  if (url.pathname === "/register") return Response.json({ ...(await req.json() as object), client_id: "fixture-native-client", token_endpoint_auth_method: "none" }, { status: 201 });
  if (url.pathname === "/token") {
    const form = new URLSearchParams(await req.text());
    if (form.get("grant_type") === "refresh_token") { refreshes++; throw new Error("Unexpected refresh"); }
    codes++; return Response.json({ access_token: "fixture-access", token_type: "Bearer", expires_in: 3600, refresh_token: "fixture-refresh", scope });
  }
  assert.equal(url.pathname, "/mcp");
  if (req.headers.get("Authorization") !== "Bearer fixture-access") return new Response(null, { status: 401, headers: { "WWW-Authenticate": `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource", scope="${scope}"` } });
  if (req.method === "GET") return new Response(null, { status: 405 });
  if (req.method === "DELETE") return new Response(null, { status: 200 });
  const b = await req.json() as any;
  if (b.id === undefined) return new Response(null, { status: 202 });
  if (b.method === "server/discover") return json(b.id, { supportedVersions: ["2026-07-28"], capabilities: { tools: {}, resources: {} }, ttlMs: 0, cacheScope: "private" });
  if (b.method === "initialize") return json(b.id, { protocolVersion: b.params.protocolVersion, capabilities: { tools: {}, resources: { subscribe: true } }, serverInfo: { name: "grayboard-fixture", version: "0" } });
  if (b.method === "tools/list") return json(b.id, { tools: [{ name: "bind", description: "Bind a task name", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false } }, { name: "whoami", description: "Read session binding", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] });
  if (b.method === "resources/list") return json(b.id, { resources: [] });
  const session = b.params?._meta?.["ai.opencode/sessionID"];
  assert.equal(typeof session, "string", "All subscriber/native operations carry host session attribution");
  const s = state(session);
  console.log("SUBSCRIBER_REQUEST", JSON.stringify({ method: b.method, session }));
  if (b.method === "subscriptions/listen") {
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: " + JSON.stringify({ jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged", params: { _meta: { "io.modelcontextprotocol/subscriptionId": b.id }, notifications: b.params.notifications } }) + "\n\n")); } });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  }
  if (b.method === "resources/read") return json(b.id, { resultType: "complete", ttlMs: 0, cacheScope: "private", contents: [{ uri: b.params.uri, mimeType: "application/json", text: '{"items":[]}' }] });
  if (b.method !== "tools/call") return json(b.id, {});
  const name = b.params.name, args = b.params.arguments ?? {}, subscriber = req.headers.get("X-Grayboard-Client") === "subscriber";
  calls.push({ name, session, args, subscriber }); console.log("MCP_CALL", JSON.stringify({ name, session, args, subscriber }));
  if (name === "whoami") return json(b.id, result({ kind: "root", name: s.name, ownership: s.ownership, candidates: [] }));
  if (name === "bind") {
    if (children.has(session)) { assert(sessions.has(children.get(session)!)); return json(b.id, result({ name: state(children.get(session)!).name!, ownership: state(children.get(session)!).ownership!, instructions: "Inherited root binding" })); }
    s.name = args.name; s.ownership ??= ++nextOwnership; s.gen++; s.capability = undefined;
    return json(b.id, result({ name: s.name!, ownership: s.ownership, instructions: "Bound fixture" }));
  }
  if (name === "session_register") { await Bun.sleep(80); for (const id of [...(args.via ?? []), args.child]) children.set(id, session); return json(b.id, result({ registered: true })); }
  if (name === "session_end") { children.delete(session); s.name = null; s.ownership = null; s.capability = undefined; return json(b.id, result({ ended: true })); }
  if (name === "delivery_open") {
    assert(s.name && s.ownership); s.capability = String(s.ownership).padStart(43, "a");
    return json(b.id, result({ capability: s.capability, ownership: s.ownership, bind_gen: s.gen, expiresAt: Date.now() + 60_000, identity: { user: { id: 1, email: "you@example.com" }, identity: s.name, identity_full: "you@example.com/" + s.name, issuer, resource } }));
  }
  if (name.startsWith("delivery_")) { assert.equal(req.headers.get("X-Grayboard-Lease"), s.capability); return json(b.id, result({ ok: true })); }
  throw new Error("Unexpected fixture tool: " + name);
}) as typeof fetch;
const fixture = Plugin.define({ id: "grayboard.native.fixture", async setup(c) {
  ctx = c;
  await c.mcp.transform(e => e.set("grayboard", { type: "remote", url: resource, codemode: mode === "code" }));
  const p = Provider.ID.make("fixture");
  await c.provider.transform(e => e.add({ info: { ...Provider.Info.empty(p), name: "Fixture", activation: "enabled", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: "https://model.example.com/v1" } }, models: [{ ...Model.Info.default(p, Model.ID.make("fixture")), name: "Fixture" }] }));
  await c.session.hook("title", e => { e.result = "Fixture"; });
} });
async function wait<T>(read: () => Promise<T>, predicate: (v: T) => boolean, label: string) {
  for (let i = 0; i < 240; i++) { const v = await read(); if (predicate(v)) return v; await Bun.sleep(50); }
  throw new Error("Wait expired: " + label);
}
let host: Awaited<ReturnType<typeof OpenCode.create>> | undefined;
try {
  host = await OpenCode.create({ plugins: mode === "disabled" ? [fixture] : [fixture, installed], database: { path: join(root, "native-host.sqlite") }, models: { fetch: false }, config: { directory: join(root, "native-config"), project: false, claude: false }, fs: { filewatcher: false } });
  const location = { directory: join(root, "project") };
  await host.agent.list({ location });
  const rpc = host.rpc(Grayboard);
  await wait(async () => ctx, Boolean, "fixture setup");
  const native = await wait(async () => (await ctx.mcp.list()).data.find(x => x.name === "grayboard"), x => x?.status.status === "needs_auth", "native discovery");
  assert(native?.integrationID);
  const integrationID = native.integrationID;
  const method = (await ctx.integration.get({ integrationID })).data?.methods.find(m => m.type === "oauth"); assert(method);
  const attempt = await ctx.integration.oauth.connect({ integrationID, methodID: method.id });
  const auth = new URL(attempt.data.url), returned = new URL(auth.searchParams.get("redirect_uri")!); callbackOrigin = returned.origin;
  assert.equal(auth.searchParams.get("client_id"), "fixture-native-client");
  returned.searchParams.set("code", "fixture-code"); returned.searchParams.set("state", auth.searchParams.get("state")!); returned.searchParams.set("iss", issuer);
  assert.equal((await fetch(returned)).status, 200);
  await wait(() => ctx.integration.connection.active(integrationID), Boolean, "native credential");
  await host.mcp.connect({ server: "grayboard", location });
  await wait(() => ctx.tool.list(), ts => ts.some(t => t.id === "grayboard_bind"), "native tool");
  const a = await host.session.create({ location, title: "Root A", permissions: [{ action: "*", resource: "*", effect: "allow" }] });
  if (mode === "disabled") {
    await host.session.switchModel({ sessionID: a.id, model: { providerID: "fixture", id: "fixture" } });
    await host.session.prompt({ sessionID: a.id, text: "Read my native binding" }); await host.session.wait({ sessionID: a.id });
    assert(calls.some(c => c.name === "whoami" && c.session === a.id && !c.subscriber));
    assert.equal(state(a.id).name, null); assert.equal(state(a.id).ownership, null);
    assert.equal(calls.some(c => c.subscriber), false);
    console.log("NATIVE_DISABLED_HOST_OK", JSON.stringify({ codes, refreshes, root: a.id }));
  } else {
  const approved = await rpc.enroll({ sessionID: a.id }, { location });
  console.log("APPROVAL_STATUS", JSON.stringify(approved));
  assert.equal(approved.state, "unbound");
  assert.equal(calls.filter(c => c.name === "delivery_open").length, 0, "Approval alone never opens a lease");
  assert.equal(calls.filter(c => c.name === "bind").length, 0, "Approval alone never binds");
  async function invoke(id: string, name: string) {
    target = name;
    await host!.session.switchModel({ sessionID: id, model: { providerID: "fixture", id: "fixture" } });
    await host!.session.prompt({ sessionID: id, text: "Bind " + name }); await host!.session.wait({ sessionID: id });
  }
  await invoke(a.id, "first");
  await wait(async () => rpc.status({}, { location }), s => { if (s.state !== "active") console.log("WAIT_STATUS", JSON.stringify(s)); return s.state === "active"; }, "native bind -> lease");
  assert.equal(calls.filter(c => c.name === "delivery_open" && c.session === a.id).length, 1);
  const b = await host.session.create({ location, title: "Root B", permissions: [{ action: "*", resource: "*", effect: "allow" }] });
  await rpc.enroll({ sessionID: b.id }, { location }); await invoke(b.id, "second");
  await wait(async () => calls, cs => cs.some(c => c.name === "delivery_open" && c.session === b.id), "root B lease");
  assert.equal(state(a.id).name, "first"); assert.equal(state(b.id).name, "second"); assert.notEqual(state(a.id).ownership, state(b.id).ownership);
  const child = await host.session.create({ location, parentID: a.id, permissions: [{ action: "*", resource: "*", effect: "allow" }] });
  const grandchild = await host.session.create({ location, parentID: child.id, permissions: [{ action: "*", resource: "*", effect: "allow" }] });
  await invoke(grandchild.id, "ignored-child-name");
  const registration = calls.find(c => c.name === "session_register" && c.args.child === grandchild.id);
  assert(registration); assert.equal(registration.session, a.id); assert.deepEqual(registration.args.via, [child.id]); assert.equal(children.get(grandchild.id), a.id);
  assert.equal(calls.filter(c => c.name === "delivery_open").length, 2, "Children never receive their own leases");
  await host.session.update({ sessionID: child.id, archived: true });
  await wait(async () => calls, cs => cs.some(c => c.name === "session_end" && c.session === child.id), "child lifecycle");
  assert.equal(state(a.id).name, "first");
  await host.session.remove({ sessionID: a.id });
  await wait(async () => calls, cs => cs.some(c => c.name === "session_end" && c.session === a.id), "root lifecycle");
  await rpc.pause({}, { location }); assert.equal(state(b.id).name, null);
  assert.equal(codes, 1); assert.equal(refreshes, 0);
  console.log("NATIVE_HOST_OK", JSON.stringify({ mode, codes, refreshes, roots: [a.id, b.id], child: child.id, grandchild: grandchild.id, opens: calls.filter(c => c.name === "delivery_open").length }));
  }
} finally { await host?.close(); globalThis.fetch = fetch0; }
