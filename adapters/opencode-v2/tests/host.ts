import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { rmSync } from "node:fs";
import { OpenCode } from "@opencode/sdk";
import { Plugin, Provider, Model } from "@opencode/plugin";
import type { Context } from "@opencode/plugin/promise/plugin";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startServer } from "../../../src/server/app.ts";
import { parseOAuthClients } from "../../../src/server/oauth-config.ts";
import { createBoard, post, subscribe } from "../../../src/core/boards.ts";

const installed = process.env.GRAYBOARD_INSTALLED_PACKAGE!;
assert(installed);
assert.equal(Bun.which("grayboard"), null, "No Grayboard CLI may be available to the host fixture");
const { default: installedPlugin, Grayboard } = await import(pathToFileURL(join(installed, "index.js")).href) as typeof import("../src/index.js");
const issuer = "https://grayboard.example.com:443/hosted", resource = "https://grayboard.example.com/hosted/mcp";
const scopes = ["grayboard:delivery", "grayboard:tools"];
for (const name of ["host.sqlite", "grayboard.sqlite"]) for (const suffix of ["", "-wal", "-shm"]) rmSync(join(process.cwd(), name + suffix), { force: true });
let google = 0, email = "you@example.com", modelCalls = 0, lostReceipt = true, failReceipt = false, failAdmission = false, admissionFailures = 0, receiptAttempts = 0, acceptedReceipts = 0, listens = 0, subscriberReads = 0, subscriberUnauthorized = 0, subscriberOffline = false, missingLeases = 0, opens = 0;
let now = Date.now(), callbackOrigin: string | undefined;
const counts = { code: 0, refresh: 0, authorize: 0, blocked: 0, unexpectedNetwork: 0 };
const app = startServer({ dbPath: join(process.cwd(), "grayboard.sqlite"), blobDir: join(process.cwd(), "blobs"), httpPort: 0, googleClientId: "fake-google", googleClientSecret: "fake-secret", orgDomain: "example.com", publicUrl: issuer, messageRetentionDays: 90, auditRetentionDays: 90, devAuth: false, admins: [], oauthClients: parseOAuthClients(JSON.stringify([{ clientId: "opencode-native", name: "Package fixture", redirectUris: ["http://127.0.0.1/callback"], scopes, tokenEndpointAuthMethod: "none", allowRefresh: true }])) }, { hostname: "127.0.0.1", background: false, oauth: { now: () => now, exchangeGoogle: async () => { google++; return { email, displayName: "Fixture" }; } } });
const fake = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  assert.equal(new URL(req.url).pathname, "/v1/chat/completions"); modelCalls++;
  const body = await req.json() as { stream?: boolean };
  if (body.stream) return new Response('data: {"id":"local","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Fixture reply"},"finish_reason":null}]}\n\ndata: {"id":"local","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
  return Response.json({ id: "local", choices: [{ index: 0, message: { role: "assistant", content: "Fixture reply" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
} });
const listener = `http://127.0.0.1:${app.server.port}`, providerURL = `http://127.0.0.1:${fake.port}`, fetch0 = globalThis.fetch;
const nativeTools = new Set<string>();
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init), url = new URL(req.url);
  if (![new URL(issuer).origin, listener, providerURL, callbackOrigin].includes(url.origin)) {
    counts.blocked++;
    if (url.hostname !== "127.0.0.1" || !["1234", "11434", "8000"].includes(url.port)) counts.unexpectedNetwork++;
    throw new Error("Nonfixture network denied");
  }
  const isMcp = url.pathname === "/hosted/mcp";
  const body = isMcp && req.method === "POST" ? await req.clone().json() as { method?: string; params?: { name?: string } } : undefined;
  if (url.pathname === "/hosted/oauth/authorize") counts.authorize++;
  if (url.pathname === "/hosted/oauth/token") {
    const grant = new URLSearchParams(await req.clone().text()).get("grant_type");
    if (grant === "authorization_code") counts.code++; if (grant === "refresh_token") counts.refresh++;
  }
  if (subscriberOffline && req.headers.get("X-Grayboard-Client") === "subscriber") throw new Error("Fixture subscriber network outage");
  if (body?.method === "subscriptions/listen") listens++;
  if (body?.method === "resources/read" && req.headers.get("X-Grayboard-Client") === "subscriber") subscriberReads++;
  if (body?.params?.name === "delivery_open") opens++;
  if (body?.params?.name === "delivery_receipt") {
    receiptAttempts++;
    if (failReceipt) { failReceipt = false; throw new Error("Fixture refused receipt before server commit"); }
  }
  const target = url.origin === new URL(issuer).origin ? new Request(listener + url.pathname + url.search, req) : req;
  const res = await fetch0(target);
  if (res.status === 401 && req.headers.get("X-Grayboard-Client") === "subscriber") subscriberUnauthorized++;
  if (body?.method === "tools/list" && !req.headers.has("X-Grayboard-Client") && res.ok) {
    const text = await res.clone().text();
    for (const name of ["board_create", "dm_send", "delivery_open"]) if (text.includes(`\"name\":\"${name}\"`)) nativeTools.add(name);
  }
  if (body?.params?.name === "delivery_renew" && res.ok && (await res.clone().text()).includes("error: delivery lease or item not found")) missingLeases++;
  if (body?.params?.name === "delivery_receipt" && res.ok) {
    acceptedReceipts++;
    if (lostReceipt) { lostReceipt = false; await res.arrayBuffer(); throw new Error("Fixture dropped receipt response"); }
  }
  return res;
}) as typeof fetch;
let ctx: Context | undefined;
const fixture = Plugin.define({ id: "grayboard.package.fixture", async setup(c) {
  ctx = c;
  await c.mcp.transform(e => e.set("grayboard", { type: "remote", url: resource, headers: { "X-Grayboard-Identity": "be" }, oauth: { client_id: "opencode-native", scope: scopes.join(" ") } }));
  const providerID = Provider.ID.make("fixture");
  await c.provider.transform(e => e.add({ info: { ...Provider.Info.empty(providerID), name: "Fixture", activation: "enabled", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: providerURL + "/v1" } }, models: [{ ...Model.Info.default(providerID, Model.ID.make("fixture")), name: "Fixture" }] }));
  await c.session.hook("title", e => { e.result = "Fixture session"; });
} });
const location = { directory: process.cwd() };
const configuredPlugin = Plugin.define({ id: installedPlugin.id, setup: c => installedPlugin.setup({ ...c, session: { ...c.session, synthetic: async input => {
  if (failAdmission) { failAdmission = false; admissionFailures++; throw new Error("Fixture transient admission failure"); }
  return c.session.synthetic(input);
} } }) });
const createHost = () => OpenCode.create({ plugins: [fixture, configuredPlugin], database: { path: join(process.cwd(), "host.sqlite") }, models: { fetch: false }, config: { directory: join(process.cwd(), "home/config"), project: false, claude: false }, fs: { filewatcher: false } });
let host: Awaited<ReturnType<typeof createHost>> | undefined, nativeClient: Client | undefined;
async function wait<T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeout = 15_000) {
  const end = Date.now() + timeout;
  let value: T;
  do { try { value = await read(); if (predicate(value)) return value; } catch {} await Bun.sleep(25); } while (Date.now() < end);
  throw new Error("Fixture wait expired");
}
class Browser {
  cookies = new Map<string, string>();
  async request(url: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers); headers.set("Cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await fetch(url, { ...init, headers, redirect: "manual" });
    for (const cookie of res.headers.getSetCookie()) { const pair = cookie.split(";")[0]!, i = pair.indexOf("="); this.cookies.set(pair.slice(0, i), pair.slice(i + 1)); }
    return res;
  }
}
async function signIn(integrationID: string) {
  assert(ctx);
  const previous = await ctx.integration.connection.active(integrationID);
  const method = (await ctx.integration.get({ integrationID })).data?.methods.find(m => m.type === "oauth"); assert(method);
  const attempt = await ctx.integration.oauth.connect({ integrationID, methodID: method.id });
  const authorization = new URL(attempt.data.url), callback = new URL(authorization.searchParams.get("redirect_uri")!); callbackOrigin = callback.origin;
  const browser = new Browser(), begin = await browser.request(authorization.href), googleURL = new URL(begin.headers.get("Location")!);
  const returnedGoogle = await browser.request(issuer + "/oauth/google/callback?" + new URLSearchParams({ code: "fake-code", state: googleURL.searchParams.get("state")!, iss: "https://accounts.google.com" }));
  const page = await browser.request(returnedGoogle.headers.get("Location")!), html = await page.text();
  const request = /name="request" value="([^"]+)"/.exec(html)?.[1], csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1]; assert(request && csrf);
  const consent = await browser.request(issuer + "/oauth/consent", { method: "POST", headers: { Origin: new URL(issuer).origin }, body: new URLSearchParams({ request, csrf, decision: "approve" }) });
  const returned = new URL(consent.headers.get("Location")!); assert.equal(returned.searchParams.get("iss"), issuer); assert.equal(returned.searchParams.get("state"), authorization.searchParams.get("state"));
  assert.equal((await fetch(returned, { redirect: "manual" })).status, 200);
  return wait(() => ctx!.integration.connection.active(integrationID), value => Boolean(value && (value.type !== "credential" || previous?.type !== "credential" || value.id !== previous.id)));
}
try {
  host = await createHost(); await host.agent.list({ location });
  await wait(async () => ctx, Boolean); assert(ctx);
  let rpc = host.rpc(Grayboard);
  await wait(() => rpc.status({}, { location }), s => s.state === "unenrolled").catch(async error => {
    const plugins = await ctx!.plugin.list();
    console.log("PLUGIN_LOAD", JSON.stringify(plugins));
    throw error;
  });
  assert.equal(app.mcp.activeLeases, 0);
  const native = await wait(async () => (await ctx!.mcp.list()).data.find(e => e.name === "grayboard"), e => e?.status.status === "needs_auth"); assert(native?.integrationID);
  await signIn(native.integrationID);
  await host.mcp.connect({ server: "grayboard", location });
  assert(nativeTools.has("board_create")); assert(nativeTools.has("dm_send")); assert(!nativeTools.has("delivery_open"));
  const selected = await ctx.integration.connection.active(native.integrationID); assert(selected?.type === "credential");
  const access = async () => { const c = await ctx!.integration.connection.resolve(selected); assert(c?.type === "oauth"); return c.access; };
  nativeClient = new Client({ name: "fixture-native-tools", version: "0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await nativeClient.connect(new StreamableHTTPClientTransport(new URL(resource), { authProvider: { token: access, onUnauthorized: async () => { throw new Error("Native fixture requires host authorization"); } }, requestInit: { redirect: "error", headers: { "X-Grayboard-Identity": "be" } } }));
  assert.notEqual((await nativeClient.callTool({ name: "board_create", arguments: { name: "native-tools", purpose: "Native tools fixture" } })).isError, true);
  const root = await host.session.create({ location, title: "Root" });
  await host.session.switchModel({ sessionID: root.id, model: { providerID: "fixture", id: "fixture" } });
  const child = await host.session.create({ location, parentID: root.id, title: "Child" });
  assert.equal((await rpc.enroll({ sessionID: child.id }, { location })).state, "paused"); assert.equal(app.mcp.activeLeases, 0);
  const archived = await host.session.create({ location, title: "Archived root" });
  await host.session.update({ sessionID: archived.id, archived: true });
  assert.equal((await rpc.enroll({ sessionID: archived.id }, { location })).state, "paused");
  const deleted = await host.session.create({ location, title: "Deleted root" });
  await host.session.remove({ sessionID: deleted.id });
  assert.equal((await rpc.enroll({ sessionID: deleted.id }, { location })).state, "paused");
  assert.equal(app.mcp.activeLeases, 0);
  const board = createBoard(app.db, "you@example.com/be", "fixture", "Fixture board");
  subscribe(app.db, "you@example.com/be", board.name, "digest");
  post(app.db, "you@example.com/sim", board.name, "Background digest");
  assert.notEqual((await rpc.enroll({ sessionID: root.id }, { location })).state, "paused");
  await wait(() => rpc.status({}, { location }), s => s.state === "active");
  await wait(async () => acceptedReceipts, n => n >= 1);
  const enrolled = (await host.session.get({ sessionID: root.id })).metadata?.["grayboard.enrollment"] as { enrollment: { identity: { issuer: string; resource: string }; configuration: { discovery: string } } };
  assert.equal(enrolled.enrollment.identity.issuer, issuer);
  assert.equal(enrolled.enrollment.identity.resource, resource);
  assert.equal(enrolled.enrollment.configuration.discovery, "https://grayboard.example.com/.well-known/oauth-authorization-server/hosted");
  assert.equal(modelCalls, 0); assert.equal(app.mcp.activeLeases, 1); assert(listens >= 1);
  const inbox = await host.session.inbox.list({ sessionID: root.id });
  assert.equal(inbox.length, 1); assert.match(inbox[0]!.id, /^msg_[a-f0-9]{64}$/);
  await wait(() => rpc.status({}, { location }), s => s.state === "active");
  failAdmission = true; failReceipt = true;
  const dm = app.repo.messages.insert("you@example.com/sim", "user", "you@example.com/be", "Actionable message", null, false);
  await wait(async () => app.repo.cursors.directFor("you@example.com/be"), n => n >= dm.id, 20_000);
  await wait(async () => modelCalls, n => n >= 1);
  await host.session.wait({ sessionID: root.id });
  assert.equal(modelCalls, 2, "Deferred digest is evaluated on later wake, not permanently context-only");
  await wait(async () => acceptedReceipts, count => count === 2);
  assert.equal(receiptAttempts, acceptedReceipts + 1);
  assert.equal(admissionFailures, 1);
  assert.equal((await host.session.context({ sessionID: root.id })).filter(m => m.type === "synthetic").length, 2, "Receipt retry must reuse the admitted ID");
  assert.notEqual((await nativeClient.callTool({ name: "dm_send", arguments: { to: "be", body: "Native tools fixture" } })).isError, true);
  await wait(() => host!.session.context({ sessionID: root.id }), context => context.filter(m => m.type === "synthetic").length === 3);
  await host.session.wait({ sessionID: root.id });
  assert.equal(modelCalls, 3);
  const beforeRotation = await access(), beforeOpens = opens, beforeReads = subscriberReads;
  now += 3_601_000;
  await host.mcp.connect({ server: "grayboard", location });
  assert.notEqual(await access(), beforeRotation); assert.equal(counts.refresh, 1);
  await wait(async () => subscriberReads, value => value > beforeReads, 15_000);
  assert.equal(opens, beforeOpens, "Native access rotation must retain the delivery lease");
  await wait(() => rpc.status({}, { location }), s => s.state === "active");
  console.log("PASS native-only normal refresh, same lease; transient admission and receipt failures replay safely");
  await nativeClient.close(); nativeClient = undefined;
  await host.close(); host = undefined; ctx = undefined;
  await wait(async () => app.mcp.activeLeases, count => count === 0, 35_000).catch(error => { console.log("SHUTDOWN_LEASE_COUNT", app.mcp.activeLeases); throw error; });
  host = await createHost(); await host.agent.list({ location });
  const restoredContext: Context | undefined = await wait(async (): Promise<Context | undefined> => ctx, Boolean); assert(restoredContext); ctx = restoredContext;
  rpc = host.rpc(Grayboard);
  await wait(() => rpc.status({}, { location }), s => s.state === "active").catch(async error => { console.log("RESTORE_STATUS", JSON.stringify(await rpc.status({}, { location }))); throw error; });
  assert.equal(app.mcp.activeLeases, 1);
  console.log("PASS valid explicit enrollment restores ownership after runtime close/reopen");
  email = "other@example.com";
  const second = await signIn(native.integrationID); assert(second?.type === "credential" && second.id !== selected.id);
  await wait(() => rpc.status({}, { location }), s => s.state === "paused");
  const pending = app.repo.messages.insert("you@example.com/sim", "user", "you@example.com/be", "Old account pending", null, false);
  await Bun.sleep(250);
  assert(app.repo.cursors.directFor("you@example.com/be") < pending.id);
  assert.equal((await host.session.context({ sessionID: root.id })).filter(m => m.type === "synthetic").length, 3);
  console.log("PASS actual second native account selected; old root delivery paused and pending cursor unchanged");
  const oldRevocation = await fetch(issuer + "/oauth/revoke", { method: "POST", body: new URLSearchParams({ client_id: "opencode-native", token: await access() }) });
  assert.equal(oldRevocation.status, 200);
  await wait(async () => app.mcp.activeLeases, count => count === 0, 35_000);
  assert.notEqual((await rpc.enroll({ sessionID: root.id }, { location })).state, "paused");
  await wait(() => rpc.status({}, { location }), s => s.state === "active");
  const enrollment = (await host.session.get({ sessionID: root.id })).metadata?.["grayboard.enrollment"] as { enrollment: { identity: { user: { email: string } } } };
  assert.equal(enrollment.enrollment.identity.user.email, "other@example.com");
  const opensBeforeExpiry = opens, refreshBeforeExpiry = counts.refresh;
  subscriberOffline = true;
  await wait(async () => app.mcp.activeLeases, count => count === 0, 35_000);
  subscriberOffline = false;
  await wait(() => rpc.status({}, { location }), s => s.state === "active", 20_000);
  assert.equal(opens, opensBeforeExpiry + 1); assert.equal(missingLeases, 1);
  assert.equal(counts.refresh, refreshBeforeExpiry, "Subscriber lease recovery performs no OAuth refresh");
  assert.deepEqual((await host.session.get({ sessionID: root.id })).metadata?.["grayboard.enrollment"], enrollment);
  console.log("PASS actual lease expiry during network outage; same enrolled logical account reacquired without root reenrollment");
  await Bun.sleep(100);
  const readsBeforeDrift = subscriberReads;
  const drift = await ctx.mcp.transform(editor => {
    const existing = editor.get("grayboard"); assert(existing?.type === "remote");
    editor.set("grayboard", { ...existing, headers: { ...existing.headers, "X-Grayboard-Identity": "fe" } });
  });
  await wait(() => rpc.status({}, { location }), s => s.state === "paused", 15_000);
  await drift.dispose();
  await Bun.sleep(250);
  assert.equal((await rpc.status({}, { location })).state, "paused", "Switch-back must not silently reenroll");
  assert.equal(subscriberReads, readsBeforeDrift, "Changed binding must be refused before subscriber fetch");
  await wait(async () => app.mcp.activeLeases, count => count === 0, 35_000);
  assert.notEqual((await rpc.enroll({ sessionID: root.id }, { location })).state, "paused");
  await wait(() => rpc.status({}, { location }), s => s.state === "active");
  const nativeStatus = (await ctx.mcp.list()).data.find(e => e.name === "grayboard")!.status.status;
  const nextAccess = await ctx.integration.connection.resolve(second); assert(nextAccess?.type === "oauth");
  assert.equal((await fetch(issuer + "/oauth/revoke", { method: "POST", body: new URLSearchParams({ client_id: "opencode-native", token: nextAccess.access }) })).status, 200);
  await wait(() => rpc.status({}, { location }), s => s.state === "auth", 15_000);
  assert.equal(subscriberUnauthorized, 1);
  await rpc.enroll({ sessionID: root.id }, { location });
  await Bun.sleep(250);
  assert.equal(subscriberUnauthorized, 1, "Unchanged rejected access must not be retried");
  assert.equal((await ctx.mcp.list()).data.find(e => e.name === "grayboard")!.status.status, nativeStatus);
  await wait(async () => app.mcp.activeLeases, count => count === 0, 35_000);
  console.log("PASS actual account switch, config drift latch/switch-back, lease expiry, one subscriber 401 and no native status mutation");
  await rpc.pause({}, { location }); assert.equal(app.mcp.activeLeases, 0);
  console.log("PASS installed tarball, actual native OAuth, native tools, explicit root, listen ACK, digest idle, actionable wake, durable receipts and cleanup");
  await host.close(); host = undefined; ctx = undefined;
  host = await createHost(); await host.agent.list({ location }); await wait(async () => ctx, Boolean);
  await wait(() => host!.rpc(Grayboard).status({}, { location }), status => status.state === "paused");
  const persisted = await host.session.context({ sessionID: root.id });
  assert.equal(persisted.filter(m => m.type === "synthetic").length, 3);
  assert.equal(app.mcp.activeLeases, 0, "Paused enrollment must not restore ownership");
  console.log("PASS persisted synthetic admissions, paused reload has no owner");
  assert.equal(counts.authorize, 2); assert.equal(counts.code, 2); assert(counts.refresh >= 1, "Native host owns normal refresh, including reconnect of revoked access with a still-valid grant"); assert.equal(google, 2);
  assert.equal(counts.unexpectedNetwork, 0);
  console.log("COUNTS", JSON.stringify({ ...counts, google, modelCalls, listens, receiptAttempts, acceptedReceipts, admissionFailures, subscriberUnauthorized, opens, missingLeases }));
} finally {
  await nativeClient?.close().catch(() => {}); await host?.close(); await app.stop(); fake.stop(true); app.db.close(); globalThis.fetch = fetch0;
  assert.equal(app.mcp.activeContexts, 0); assert.equal(app.mcp.activeLeases, 0);
  console.log("PASS all contexts and leases closed");
}
