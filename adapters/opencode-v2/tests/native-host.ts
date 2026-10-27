import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { OpenCode } from "@opencode/sdk";
import { Plugin, Provider, Model } from "@opencode/plugin";
import type { Context } from "@opencode/plugin/promise/plugin";
import { durableCases, DurableFixture } from "./durable-cases.ts";

const root = process.env.GRAYBOARD_GIT_TEST_ROOT!;
assert(root); assert.equal(Bun.version, "1.4.4");
assert.equal((await Bun.file(join(root, "node_modules/@opencode/sdk/package.json")).json()).version, "2.1.4");
const directory = readFileSync(join(root, "installed.txt"), "utf8").trim();
const { observeSubscriberWork } = await import("./subscriber-work.ts");
const subscriberWork = await observeSubscriberWork(directory);
const { default: installed, Grayboard } = await import(pathToFileURL(join(directory, "src/index.ts")).href) as typeof import("../src/index.js");
const issuer = "https://grayboard.example.com", resource = issuer + "/mcp", scope = "grayboard:delivery grayboard:tools";
type State = { name: string | null; ownership: number | null; gen: number; capability?: string };
const sessions = new Map<string, State>(), children = new Map<string, string>();
const calls: { name: string; session: string; args: Record<string, unknown>; subscriber: boolean }[] = [];
let nextOwnership = 0, codes = 0, refreshes = 0, callbackOrigin = "", mode = process.env.GRAYBOARD_NATIVE_MODE ?? "direct", target = "first";
let ctx!: Context;
let modelIssued = false;
const parallelDispatch = new Set<string>(), streams = new Map<string, Set<symbol>>();
const opened: { session: string; name: string; ownership: number }[] = [];
const receipted = new Set<string>();
const durable = mode === "durable" ? new DurableFixture(root) : undefined;
if (durable?.phase === "reload") {
  const saved = await Bun.file(join(root, "service.json")).json();
  for (const [id, value] of saved.sessions) sessions.set(id, value);
  nextOwnership = saved.nextOwnership;
  const replay = await Bun.file(join(root, "durable.json")).json();
  for (const [id, items] of replay.batches) durable.batches.set(id, items.map((item: import("./durable-cases.ts").Batch) => ({ ...item, event: { text: "ALTERED REPLAY MUST NOT REPLACE ORIGINAL" } })));
  durable.holding = false;
}
const instrumented = durable ? Plugin.define({ ...installed, setup(c) {
  return installed.setup({ ...c, session: new Proxy(c.session, { get(session, key) {
    if (key === "synthetic") return (input: Parameters<Context["session"]["synthetic"]>[0]) => durable.synthetic(input, value => session.synthetic(value));
    return Reflect.get(session, key);
  } }) });
} }) : installed;
const state = (id: string) => { if (!sessions.has(id)) sessions.set(id, { name: null, ownership: null, gen: 0 }); return sessions.get(id)!; };
const fetch0 = globalThis.fetch;
const json = (id: unknown, result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
const result = (output: Record<string, unknown>) => ({ resultType: "complete", content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init), url = new URL(req.url);
  if (url.origin === callbackOrigin) return fetch0(req);
  if (url.origin === "https://model.example.com") {
    await req.json(); const done = modelIssued; modelIssued = true;
    const ordinary = mode === "disabled" || target === "ordinary-child";
    const name = mode === "code" ? "execute" : ordinary ? "grayboard_whoami" : "grayboard_bind";
    const names = target === "parallel" && mode !== "code" ? ["parallel-first", "parallel-final"] : [target];
    const tool_calls = names.map((value, index) => {
      const args = mode === "code" ? { code: ordinary ? "return await tools.grayboard.whoami({})" : target === "parallel" ? 'return await Promise.all([tools.grayboard.bind({name:"parallel-first"}),tools.grayboard.bind({name:"parallel-final"})])' : `return await tools.grayboard.bind({name:${JSON.stringify(value)}})` } : ordinary ? {} : { name: value };
      return { index, id: "call_fixture_" + index, type: "function", function: { name, arguments: JSON.stringify(args) } };
    });
    const delta = done || durable ? { content: "done" } : { role: "assistant", tool_calls };
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
  if ((durable?.revoked && req.headers.get("X-Grayboard-Client") === "subscriber") || !["Bearer fixture-access", "Bearer fixture-other-access"].includes(req.headers.get("Authorization") ?? "")) return new Response(null, { status: 401, headers: { "WWW-Authenticate": `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource", scope="${scope}"` } });
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
    const token = Symbol(); if (!streams.has(session)) streams.set(session, new Set());
    const live = streams.get(session)!; live.add(token);
    const stream = new ReadableStream({ start(c) {
      const close = () => { live.delete(token); try { c.close(); } catch {} };
      if (req.signal.aborted) { close(); return; }
      req.signal.addEventListener("abort", close, { once: true });
      c.enqueue(new TextEncoder().encode("data: " + JSON.stringify({ jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged", params: { _meta: { "io.modelcontextprotocol/subscriptionId": b.id }, notifications: b.params.notifications } }) + "\n\n"));
    }, cancel() { live.delete(token); } });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  }
  if (b.method === "resources/read") {
    if (durable && !durable.batches.has(session)) await wait(async () => durable.batches.has(session), Boolean, "durable batch ready");
    const items = durable ? (durable.batches.get(session) ?? []).filter(i => !durable.cursor.has(i.id)) : s.name === "parallel-final" && !receipted.has(session) ? [{ id: "fixture:parallel", actionable: false, event: { text: "Final parallel digest" }, ownership: s.ownership, bind_gen: s.gen, name: s.name }] : [];
    return json(b.id, { resultType: "complete", ttlMs: 0, cacheScope: "private", contents: [{ uri: b.params.uri, mimeType: "application/json", text: JSON.stringify({ items }) }] });
  }
  if (b.method !== "tools/call") return json(b.id, {});
  const name = b.params.name, args = b.params.arguments ?? {}, subscriber = req.headers.get("X-Grayboard-Client") === "subscriber";
  calls.push({ name, session, args, subscriber }); console.log("MCP_CALL", JSON.stringify({ name, session, args, subscriber }));
  if (name === "whoami") {
    if (children.has(session)) return json(b.id, result({ kind: "child", root: children.get(session) }));
    return json(b.id, result({ kind: "root", name: s.name, ownership: s.ownership, candidates: [] }));
  }
  if (name === "bind") {
    if (children.has(session)) return json(b.id, { resultType: "complete", isError: true, content: [{ type: "text", text: "child_session: bind is root-only" }] });
    if (args.name === "parallel-first" || args.name === "parallel-final") {
      parallelDispatch.add(args.name);
      await wait(async () => parallelDispatch.size, n => n === 2, "both native before hooks finished before first completion");
      if (args.name === "parallel-final") {
        await wait(async () => opened, os => os.some(o => o.session === session && o.name === "parallel-first"), "first completion lease before second completion");
        console.log("PARALLEL_OVERLAP_ASSERTED", mode);
      }
    }
    s.name = args.name; s.ownership ??= ++nextOwnership; s.gen++; s.capability = undefined;
    return json(b.id, result({ name: s.name!, ownership: s.ownership, instructions: ["Bound fixture"] }));
  }
  if (name === "session_register") { await Bun.sleep(80); children.set(args.child, session); return json(b.id, result({ registered: true })); }
  if (name === "session_end") { children.delete(session); s.name = null; s.ownership = null; s.capability = undefined; return json(b.id, result({ ended: true })); }
  if (name === "delivery_open") {
    assert(s.name && s.ownership); opened.push({ session, name: s.name, ownership: s.ownership });
    s.capability = String(s.ownership).padStart(40, "a") + String(s.gen).padStart(3, "0");
    return json(b.id, result({ capability: s.capability, ownership: s.ownership, bind_gen: s.gen, expiresAt: Date.now() + 60_000, identity: { user_email: "you@example.com", identity_full: "you@example.com/" + s.name } }));
  }
  if (name.startsWith("delivery_")) {
    if (durable?.invalid.has(session) && name === "delivery_renew") return json(b.id, { resultType: "complete", isError: true, structuredContent: { code: "not_found" }, content: [{ type: "text", text: "no live delivery lease" }] });
    assert.equal(req.headers.get("X-Grayboard-Lease"), s.capability);
    if (durable && name === "delivery_receipt") {
      try { durable.receipt(session, args.ids); } catch {
        if (durable.scenario === "reload" && durable.phase === "admit") await durable.receiptRelease.promise;
        throw new Error("fixture receipt connection disconnected");
      }
      return json(b.id, result({ ok: true }));
    }
    if (name === "delivery_receipt") {
      assert.deepEqual(args.ids, ["fixture:parallel"]);
      receipted.add(session);
    }
    return json(b.id, result({ ok: true }));
  }
  throw new Error("Unexpected fixture tool: " + name);
}) as typeof fetch;
const fixture = Plugin.define({ id: "grayboard.native.fixture", async setup(c) {
  ctx = c;
  await c.mcp.transform(e => e.set("grayboard", { type: "remote", url: resource, codemode: mode === "code", ...(durable?.configAway ? { headers: { "X-Fixture-Drift": "away" } } : {}) }));
  const p = Provider.ID.make("fixture");
  await c.provider.transform(e => e.add({ info: { ...Provider.Info.empty(p), name: "Fixture", activation: "enabled", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: "https://model.example.com/v1" } }, models: [{ ...Model.Info.default(p, Model.ID.make("fixture")), name: "Fixture" }] }));
  await c.session.hook("title", e => { e.result = "Fixture"; });
  if (durable) await c.session.hook("http.request", e => { if (e.kind === "primary") durable.models.push(e.sessionID); });
} });
async function wait<T>(read: () => Promise<T>, predicate: (v: T) => boolean, label: string) {
  for (let i = 0; i < 240; i++) { const v = await read(); if (predicate(v)) return v; await Bun.sleep(50); }
  throw new Error("Wait expired: " + label);
}
let host: Awaited<ReturnType<typeof OpenCode.create>> | undefined;
try {
  host = await OpenCode.create({ plugins: mode === "disabled" ? [fixture] : [fixture, instrumented], database: { path: join(root, "native-host.sqlite") }, models: { fetch: false }, config: { directory: join(root, "native-config"), project: false, claude: false }, fs: { filewatcher: false } });
  const location = { directory: join(root, "project") };
  await host.agent.list({ location });
  const rpc = host.rpc(Grayboard);
  await wait(async () => ctx, Boolean, "fixture setup");
  const native = await wait(async () => (await ctx.mcp.list()).data.find(x => x.name === "grayboard"), x => durable?.phase === "reload" ? !!x?.integrationID : x?.status.status === "needs_auth", "native discovery");
  assert(native?.integrationID);
  const integrationID = native.integrationID;
  if (durable?.phase !== "reload") {
  const method = (await ctx.integration.get({ integrationID })).data?.methods.find(m => m.type === "oauth"); assert(method);
  const attempt = await ctx.integration.oauth.connect({ integrationID, methodID: method.id });
  const auth = new URL(attempt.data.url), returned = new URL(auth.searchParams.get("redirect_uri")!); callbackOrigin = returned.origin;
  assert.equal(auth.searchParams.get("client_id"), "fixture-native-client");
  returned.searchParams.set("code", "fixture-code"); returned.searchParams.set("state", auth.searchParams.get("state")!); returned.searchParams.set("iss", issuer);
  assert.equal((await fetch(returned)).status, 200);
  }
  await wait(() => ctx.integration.connection.active(integrationID), Boolean, "native credential");
  await host.mcp.connect({ server: "grayboard", location });
  await wait(() => ctx.tool.list(), ts => ts.some(t => t.id === "grayboard_bind"), "native tool");
  if (durable) {
    await durableCases(durable, host, ctx, rpc, location, state, subscriberWork);
    assert.equal(codes, durable.phase === "reload" ? 0 : 1); assert.equal(refreshes, 0);
    console.log("DURABLE_NATIVE_AUTH_OK", JSON.stringify({ scenario: durable.scenario, boundary: durable.boundary, phase: durable.phase, codes, refreshes }));
    await Bun.write(join(root, "service.json"), JSON.stringify({ sessions: [...sessions], nextOwnership }));
  } else {
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
    target = name; modelIssued = false;
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
  await invoke(grandchild.id, "ordinary-child");
  const registration = calls.find(c => c.name === "session_register" && c.args.child === grandchild.id);
  assert(registration); assert.equal(registration.session, a.id); assert.deepEqual(registration.args.via, [child.id]); assert.equal(children.get(grandchild.id), a.id);
  assert.equal(children.has(child.id), false, "via ancestry never implicitly registers an intermediate");
  await invoke(child.id, "ordinary-child"); assert.equal(children.get(child.id), a.id);
  await invoke(grandchild.id, "refused-child-control");
  assert.equal(state(grandchild.id).ownership, null, "child bind is refused, not inherited as a successful root bind");
  assert.equal(calls.filter(c => c.name === "delivery_open").length, 2, "Children never receive their own leases");
  await host.session.update({ sessionID: child.id, archived: true });
  await wait(async () => calls, cs => cs.some(c => c.name === "session_end" && c.session === child.id), "child lifecycle");
  assert.equal(state(a.id).name, "first");
  await host.session.remove({ sessionID: a.id });
  await wait(async () => calls, cs => cs.some(c => c.name === "session_end" && c.session === a.id), "root lifecycle");
  const parallel = await host.session.create({ location, title: "Parallel root", permissions: [{ action: "*", resource: "*", effect: "allow" }] });
  await rpc.enroll({ sessionID: parallel.id }, { location });
  await invoke(parallel.id, "parallel");
  await wait(async () => rpc.status({}, { location }), s => s.state === "active" && s.message.includes("parallel-final"), "final parallel binding active");
  await wait(async () => streams.get(parallel.id)?.size, n => n === 1, "exactly one live final stream");
  await wait(async () => receipted.has(parallel.id), Boolean, "final binding durable admission and receipt");
  assert.equal((await host.session.context({ sessionID: parallel.id })).filter((m: { id?: string; type?: string }) => m.type === "synthetic").length, 1);
  assert.deepEqual(opened.filter(o => o.session === parallel.id).map(o => o.name), ["parallel-first", "parallel-final"]);
  assert.equal(new Set(opened.filter(o => o.session === parallel.id).map(o => o.ownership)).size, 1);
  assert.equal(calls.some(c => c.session === parallel.id && c.name === "delivery_release"), false);
  console.log("PARALLEL_FINAL_ACTIVE", JSON.stringify({ mode, opens: opened.filter(o => o.session === parallel.id), liveStreams: streams.get(parallel.id)?.size }));
  await rpc.pause({}, { location }); assert.equal(state(b.id).name, null);
  assert.equal(codes, 1); assert.equal(refreshes, 0);
  console.log("NATIVE_HOST_OK", JSON.stringify({ mode, codes, refreshes, roots: [a.id, b.id], child: child.id, grandchild: grandchild.id, opens: calls.filter(c => c.name === "delivery_open").length }));
  }
  }
} finally { await host?.close(); subscriberWork.restore(); globalThis.fetch = fetch0; }
