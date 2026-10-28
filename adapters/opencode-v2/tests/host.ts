import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createFixtureHost } from "./effect-host.js";
import { fromPromise } from "@opencode/plugin/promise/adapter";
import { instrument, type NativeInput, type NativeAdmission } from "./effect-instrument.js";
import { Plugin, Provider, Model } from "@opencode/plugin";
import type { Context } from "@opencode/plugin/promise/plugin";
import { startServer } from "../../../src/server/app.ts";
import { DEFAULT_HELLO_LIMIT, DEFAULT_HOSTED_REQUEST_LIMIT, DEFAULT_AUTH_FAIL_LIMIT } from "../../../src/server/rate_limit.ts";
import { DEFAULT_TRUSTED_PROXIES } from "../../../src/server/client_addr.ts";
import { OPENCODE_CLIENT } from "../../../tests/helpers/hosted.ts";
import { sessionContext } from "../../../src/server/hosted.ts";
import { SESSION_ID } from "../../../src/core/session_id.ts";
import { createBoard, post, subscribe } from "../../../src/core/boards.ts";
import { realRace, type AdmissionGate } from "./real-races.ts";
import { observeSubscriberWork } from "./subscriber-work.ts";
import { FailedContinuation } from "./failed-continuation.js";
import { savedClientMetadata } from "./cimd-fixture.js";
import { rootRetrying, rootStatus, SubscriberAdmission } from "./causal.ts";
import { assertStable, barrier, bounded, drainSessions, sessionStates, savedInput } from "./reload-state.ts";

const codeMode = process.env.GRAYBOARD_TEST_CODEMODE === "1";
const root = process.env.GRAYBOARD_GIT_TEST_ROOT!;
assert(root); assert.equal(Bun.version, "1.4.4");
assert.equal((await Bun.file(join(root, "node_modules/@opencode/sdk/package.json")).json()).version, "2.1.4");
assert.equal(Bun.which("grayboard"), null);
const installed = readFileSync(join(root, "installed.txt"), "utf8").trim();
const { default: plugin, Grayboard } = await import(pathToFileURL(join(installed, "src/index.ts")).href) as typeof import("../src/index.js");
const subscriberWork = await observeSubscriberWork(installed);
const issuer = "https://grayboard.example.com/hosted", resource = issuer + "/mcp";
let email = "you@example.com", google = 0, cimd = 0, codes = 0, refreshes = 0, callbackOrigin = "", modelCalls = 0;
const config = { dbPath: join(root, "grayboard.sqlite"), blobDir: join(root, "blobs"), httpPort: 0, googleClientId: "fake-google", googleClientSecret: "fixture-secret", orgDomain: "example.com", publicUrl: issuer, messageRetentionDays: 90, auditRetentionDays: 90, devAuth: false, admins: [], oauthClients: [], authFailLimit: DEFAULT_AUTH_FAIL_LIMIT, trustedProxies: DEFAULT_TRUSTED_PROXIES, helloLimit: DEFAULT_HELLO_LIMIT, hostedRequestLimit: process.env.GRAYBOARD_TEST_REAL_RACE?.startsWith("admission") ? DEFAULT_HOSTED_REQUEST_LIMIT : { burst: 10000, perSec: 10000 } };
const admissionCase = process.env.GRAYBOARD_TEST_REAL_RACE?.startsWith("admission");
let admissionNow: number | undefined;
let admissionGate: SubscriberAdmission | undefined;
const start = () => startServer(config, { hostname: "127.0.0.1", background: false, ...(admissionCase ? { now: () => admissionNow ?? Date.now() } : {}), oauth: { exchangeGoogle: async () => { google++; return { email, displayName: "Fixture" }; }, ...(process.env.GRAYBOARD_TEST_CIMD_LIVE === "1" ? {} : { cimd: { resolve: async host => { assert.equal(host, "opencode.ai"); return [{ address: "93.184.216.34", family: 4 }]; }, read: async url => { assert.equal(url.href, OPENCODE_CLIENT); cimd++; return savedClientMetadata(url); } } }) } });
let app = start();
let ctx!: Context, target: { tool: string; args: Record<string, unknown> } | undefined, issued = false;
let dropReceipt = false, receiptAttempts = 0, held = false, release: (() => void) | undefined, entered: (() => void) | undefined, subscriberOutage = false;
const admissions: NativeInput[] = [];
const admitted: typeof admissions = [];
const suspendedModel = { target: "", entered: barrier(), released: barrier() };
let pendingAdmissions = 0;
const raceGate: AdmissionGate = { holding: false, boundary: process.env.GRAYBOARD_TEST_RACE_BOUNDARY === "after" ? "after" : "before", inputs: [], accepted: [], models: [], entered() {}, released: Promise.resolve() };
const calls: { name: string; session: string; subscriber: boolean; args: Record<string, unknown>; cap: string | null; accessHash: string }[] = [];
const opens: { capability: string; ownership: number; bind_gen: number }[] = [];
const nativeCompleted: string[] = [], wrappers: string[] = [];
let subscriberThrottles = 0;
const expiryContinuation = new FailedContinuation();
const fetch0 = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init), url = new URL(req.url);
  if (url.origin === callbackOrigin) return fetch0(req);
  if (url.origin === "https://model.example.com") {
    modelCalls++; await req.json();
    const call = target && !issued; issued = true;
    const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: "fixture_call", type: "function", function: { name: codeMode ? "execute" : "grayboard_" + target!.tool, arguments: JSON.stringify(codeMode ? { code: `return await tools.grayboard.${target!.tool}(${JSON.stringify(target!.args)})` } : target!.args) } }] } : { content: "Fixture reply" };
    return new Response("data: " + JSON.stringify({ id: "local", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] }) + "\n\ndata: " + JSON.stringify({ id: "local", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) + "\n\ndata: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  }
  assert.equal(url.origin, new URL(issuer).origin, "Only fixture HTTPS endpoints and native OAuth callback allowed");
  assert(!url.pathname.endsWith("/register"), "CIMD must not use DCR");
  if (url.pathname.endsWith("/oauth/token")) { const form = new URLSearchParams(await req.clone().text()); if (form.get("grant_type") === "authorization_code") codes++; else refreshes++; assert.equal(form.get("client_id"), OPENCODE_CLIENT); }
  const b = req.method === "POST" && url.pathname.endsWith("/mcp") ? await req.clone().json() as any : undefined;
  if (subscriberOutage && req.headers.get("X-Grayboard-Client") === "subscriber") {
    const fail = async () => { throw new Error("Real backend subscriber network deliberately unavailable"); };
    if (b?.method === "tools/call" && b.params?.name === "delivery_renew") return expiryContinuation.observe(fail);
    return fail();
  }
  if (b?.method === "tools/call") {
    const session = b.params?._meta?.["ai.opencode/sessionID"]; assert.equal(typeof session, "string");
    calls.push({ name: b.params.name, session, subscriber: req.headers.get("X-Grayboard-Client") === "subscriber", args: b.params.arguments ?? {}, cap: req.headers.get("X-Grayboard-Lease"), accessHash: new Bun.CryptoHasher("sha256").update(req.headers.get("Authorization") ?? "").digest("hex") });
    assert(!req.headers.has("X-Grayboard-Identity"));
    console.log("SUBCALL", b.params.name, session);
    if (b.params.name === "delivery_receipt") { receiptAttempts++; if (dropReceipt) throw new Error("Receipt transport deliberately lost before commit"); }
  }
  const forward = () => fetch0(new Request(`http://127.0.0.1:${app.server.port}` + url.pathname + url.search, req));
  const res = admissionGate ? await admissionGate.forward(req, b, forward) : await forward();
  if (res.status === 429 && req.headers.get("X-Grayboard-Client") === "subscriber") subscriberThrottles++;
  if (b?.method === "tools/call" && req.headers.get("X-Grayboard-Client") === "subscriber") { const text = await res.clone().text(); if (text.includes('"isError":true')) console.log("SUBSCRIBER_ERROR", b.params.name, text); }
  if (b?.params?.name === "delivery_open" && res.ok) {
    const body = await res.clone().text();
    const match = body.startsWith("data:") ? JSON.parse(body.slice(5)) : JSON.parse(body);
    if (!match.result?.isError) { const value = JSON.parse(match.result.content[0].text); opens.push(value); }
  }
  return res;
}) as typeof fetch;
const fixture = Plugin.define({ id: "grayboard.real.fixture", async setup(c) {
  ctx = c;
  await c.mcp.transform(e => e.set("grayboard", { type: "remote", url: resource, codemode: codeMode }));
  const p = Provider.ID.make("fixture");
  await c.provider.transform(e => e.add({ info: { ...Provider.Info.empty(p), name: "Fixture", activation: "enabled", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: "https://model.example.com/v1" } }, models: [{ ...Model.Info.default(p, Model.ID.make("fixture")), name: "Fixture" }] }));
  await c.session.hook("title", e => { e.result = "Fixture"; });
  await c.session.hook("http.request", async e => {
    if (e.kind !== "primary") return;
    raceGate.models.push(e.sessionID);
    if (e.sessionID === suspendedModel.target) { suspendedModel.entered.release(); await suspendedModel.released.promise; }
  });
  await c.tool.hook("execute.after", e => { if (e.status === "completed") { if (e.tool === "grayboard_bind") nativeCompleted.push(e.sessionID); if (e.tool === "execute") wrappers.push(e.sessionID); } });
} });
const instrumented = instrument(plugin, async (input, forward) => {
    admissions.push(structuredClone(input)); raceGate.inputs.push(structuredClone(input));
    if (held) { entered?.(); await new Promise<void>(r => { release = r; }); }
    if (raceGate.holding && raceGate.boundary === "before") { raceGate.entered(); await raceGate.released; }
    pendingAdmissions++;
    let value: NativeAdmission;
    try { value = await forward(input); admitted.push(structuredClone(input)); raceGate.accepted.push(value); }
    finally { pendingAdmissions--; }
    if (raceGate.holding && raceGate.boundary === "after") { raceGate.entered(); await raceGate.released; }
    if (process.env.GRAYBOARD_TEST_REAL_RACE === "expiry") expiryContinuation.returned();
    return value;
});
const createHost = () => createFixtureHost({ plugins: [fromPromise(fixture), instrumented], database: { path: join(root, "host.sqlite") }, models: { fetch: false }, config: { directory: join(root, "real-home/config"), project: false, claude: false }, fs: { filewatcher: false } });
let host: Awaited<ReturnType<typeof createHost>> | undefined;
const location = { directory: join(root, "project") };
async function wait<T>(read: () => Promise<T> | T, predicate: (v: T) => boolean, label: string, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  do { const v = await read(); if (predicate(v)) return v; await Bun.sleep(50); } while (Date.now() < deadline);
  console.log("STATUS", host ? await host.rpc(Grayboard).status({}, { location }) : "closed");
  throw new Error("Wait expired: " + label);
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
  const previous = await ctx.integration.connection.active(integrationID);
  const method = (await ctx.integration.get({ integrationID })).data?.methods.find(m => m.type === "oauth"); assert(method);
  const attempt = await ctx.integration.oauth.connect({ integrationID, methodID: method.id });
  const auth = new URL(attempt.data.url); assert.equal(auth.searchParams.get("client_id"), OPENCODE_CLIENT);
  callbackOrigin = new URL(auth.searchParams.get("redirect_uri")!).origin;
  const browser = new Browser(), begin = await browser.request(auth.href), googleURL = new URL(begin.headers.get("Location")!);
  const googleReturn = await browser.request(issuer + "/oauth/google/callback?" + new URLSearchParams({ code: "fixture-code", state: googleURL.searchParams.get("state")!, iss: "https://accounts.google.com" }));
  const page = await browser.request(googleReturn.headers.get("Location")!), html = await page.text();
  const request = /name="request" value="([^"]+)"/.exec(html)?.[1], csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1]; assert(request && csrf);
  const consent = await browser.request(issuer + "/oauth/consent", { method: "POST", headers: { Origin: new URL(issuer).origin }, body: new URLSearchParams({ request, csrf, decision: "approve" }) });
  assert.equal((await fetch(consent.headers.get("Location")!)).status, 200);
  return wait(() => ctx.integration.connection.active(integrationID), c => !!c && (c.type !== "credential" || previous?.type !== "credential" || c.id !== previous.id), "native OAuth selection");
}
async function invoke(sessionID: string, tool: string, args: Record<string, unknown>) {
  target = { tool, args }; issued = false;
  await host!.session.switchModel({ sessionID, model: { providerID: "fixture", id: "fixture" } });
  await host!.session.prompt({ sessionID, text: "Invoke " + tool }); await host!.session.wait({ sessionID }); target = undefined;
}
function row(raw: string) { return app.db.prepare("SELECT * FROM hosted_sessions WHERE source_session_id = ?").get(raw) as { session_id: string; root_session_id: string | null; ownership_id: number; bind_gen: number; name: string | null; grant_id: string; lease_deadline: number | null } | null; }
const makeRoot = (title: string) => host!.session.create({ location, title, permissions: [{ action: "*", resource: "*", effect: "allow" }] });
try {
  host = await createHost(); await host.agent.list({ location }); await wait(() => ctx, Boolean, "fixture setup");
  const native = await wait(async () => (await ctx.mcp.list()).data.find(x => x.name === "grayboard"), x => x?.status.status === "needs_auth", "native discovery"); assert(native?.integrationID);
  const selected = await signIn(native.integrationID); assert(selected?.type === "credential");
  await host.mcp.connect({ server: "grayboard", location });
  console.log("CIMD_TRANSPORT", process.env.GRAYBOARD_TEST_CIMD_LIVE === "1" ? "production DNS and pinned node:https; no resolver/read seam" : "injected DNS/read fixture; production parser and OAuth");
  const projected = await ctx.integration.connection.resolve(selected); if (projected?.type === "oauth") console.log("NATIVE_GRANT_METADATA", JSON.stringify({ issuer: projected.metadata?.issuer, scope: projected.metadata?.scope, serverUrl: projected.metadata?.serverUrl, clientID: (projected.metadata?.client as { client_id?: string })?.client_id }));
  await wait(() => ctx.tool.list(), ts => ts.some(t => t.id === "grayboard_bind"), "native tools");
  let rpc = host.rpc(Grayboard);
  if (process.env.GRAYBOARD_TEST_REAL_RACE?.startsWith("admission")) {
    const s = await makeRoot("Default admission recovery");
    await rpc.enroll({ sessionID: s.id, name: "admission", create: true }, { location });
    await wait(() => app.mcp.activeLeases, n => n === 1, "default-limit initial lease");
    const grant = await ctx.integration.connection.resolve(selected); assert(grant?.type === "oauth");
    const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
    const drain = new Client({ name: "default-admission-test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    let last: Response | undefined;
    admissionNow = Date.now();
    const gate = admissionGate = new SubscriberAdmission(s.id, () => admissionNow!);
    const message = app.repo.messages.insert("you@example.com/sim", "user", "you@example.com/admission", "Actionable delivery recovers after actual HTTP429", null, false); app.application.wake(["you@example.com/admission"]);
    try {
      await bounded(gate.entered.promise, 20_000, "Exact-root subscriber request held before actual backend admission");
      await drain.connect(new StreamableHTTPClientTransport(new URL(resource), { requestInit: { headers: { Authorization: "Bearer " + grant.access } }, fetch: async (input, init) => { const response = await fetch(input, init); last = response.clone(); return response; } }));
      let refused = false;
      for (let id = 0; id < DEFAULT_HOSTED_REQUEST_LIMIT.burst * 2; id++) {
        const raw = "refused-admission-" + id;
        try { await drain.callTool({ name: "whoami", arguments: {}, _meta: { "ai.opencode/sessionID": raw } }); }
        catch { assert.equal(last?.status, 429, "Official modern client receives typed admission refusal"); }
        const response = last!;
        if (response.status !== 429) { assert(response.ok); continue; }
        const body = await response.json() as { id: number; error: { data: { code: string; retry_after_ms: number } } };
        assert.equal(typeof body.id, "number"); assert.equal(body.error.data.code, "rate_limited"); assert(body.error.data.retry_after_ms > 0);
        assert.equal(response.headers.get("Retry-After"), String(Math.ceil(body.error.data.retry_after_ms / 1000)));
        assert.equal(row(raw), null, "Refused admission creates no hosted source row"); refused = true; break;
      }
      assert(refused, "Unmodified production default burst is enforced");
      gate.releaseInitial();
      await bounded(gate.retryEntered.promise, 20_000, "Actual selected-root HTTP429 followed by the held original retry");
      console.log("REAL_SUBSCRIBER_ADMISSION_REFUSAL", gate.requireRefused());
      assert(subscriberThrottles > 0);
      if (process.env.GRAYBOARD_TEST_REAL_RACE === "admission-account") {
        const retiredSubscriber = subscriberWork.current(s.id);
        email = "other@example.com"; await signIn(native.integrationID);
        await wait(() => rpc.status({}, { location }), status => rootStatus(status, s.id)?.state === "paused", "account transition aborts admission retry");
        await bounded(retiredSubscriber, 12_000, "Account drift must retire the actual admission-retry subscriber");
        await drainSessions(join(root, "host.sqlite"), sessionID => host!.session.wait({ sessionID }));
        assert.equal(gate.retryForwarded, false, "Aborted original continuation never reaches backend admission");
        assert.equal(admissions.length, 0); assert.equal(app.repo.cursors.directFor("you@example.com/admission"), 0);
        console.log("REAL_DEFAULT_ADMISSION_ACCOUNT_GUARD_OK", { subscriberThrottles, admissions: admissions.length });
      } else {
        gate.requireRefused();
        admissionNow += DEFAULT_HOSTED_REQUEST_LIMIT.burst / DEFAULT_HOSTED_REQUEST_LIMIT.perSec * 1000;
        gate.releaseRecovery();
        await wait(() => app.repo.cursors.directFor("you@example.com/admission"), n => n === message.id, "actual plugin recovers shared default admission", 30_000);
        assert(subscriberThrottles > 0); assert(admissions.length >= 1); assert.equal(new Set(admissions.map(input => input.id)).size, 1); assert(admissions.every(input => input.sessionID === s.id));
        await host.session.wait({ sessionID: s.id });
        console.log("REAL_DEFAULT_ADMISSION_RECOVERY_OK", { subscriberThrottles, cursor: message.id, admissions: admissions.length });
      }
    } finally { gate.close(); await drain.close(); }
  } else if (process.env.GRAYBOARD_TEST_REAL_RACE === "native-refresh") {
    const s = await makeRoot("Native host owns refresh");
    await rpc.enroll({ sessionID: s.id, name: "refresh", create: true }, { location });
    await wait(() => app.mcp.activeLeases, n => n === 1, "native refresh initial lease");
    const before = await ctx.integration.connection.resolve(selected); assert(before?.type === "oauth");
    const principal = app.oauth.authenticate(new Request(resource, { headers: { Authorization: "Bearer " + before.access } })); assert(!(principal instanceof Response));
    app.repo.oauth.revokeToken(principal.accessHash, OPENCODE_CLIENT, Date.now());
    await invoke(s.id, "whoami", {});
    await wait(() => refreshes, n => n === 1, "native MCP refresh after revoked access");
    const current = await ctx.integration.connection.resolve(selected); assert(current?.type === "oauth"); assert.notEqual(current.access, before.access);
    assert(app.oauth.authenticate(new Request(resource, { headers: { Authorization: "Bearer " + before.access } })) instanceof Response);
    const renewed = app.oauth.authenticate(new Request(resource, { headers: { Authorization: "Bearer " + current.access } })); assert(!(renewed instanceof Response)); assert.equal(renewed.grantId, principal.grantId);
    await rpc.enroll({ sessionID: s.id }, { location }); await wait(() => app.mcp.activeLeases, n => n === 1, "same current native grant reopens receiving");
    const message = app.repo.messages.insert("you@example.com/sim", "user", "you@example.com/refresh", "Fresh native access after native-owned refresh", null, false); app.application.wake(["you@example.com/refresh"]);
    await wait(() => app.repo.cursors.directFor("you@example.com/refresh"), n => n === message.id, "subscriber uses only fresh projected native access");
    assert.equal(refreshes, 1); assert.equal(codes, 1);
    console.log("REAL_NATIVE_OWNED_REFRESH_OK", { codes, refreshes, cursor: message.id, grantUnchanged: true });
  } else if (process.env.GRAYBOARD_TEST_REAL_RACE === "digest-reload") {
    const digest = await makeRoot("Separate process idle digest"), action = await makeRoot("Separate process delivered action");
    await host.session.switchModel({ sessionID: digest.id, model: { providerID: "fixture", id: "fixture" } });
    await host.session.switchModel({ sessionID: action.id, model: { providerID: "fixture", id: "fixture" } });
    await rpc.enroll({ sessionID: digest.id, name: "digest", create: true }, { location });
    await rpc.enroll({ sessionID: action.id, name: "action", create: true }, { location });
    await wait(() => app.mcp.activeLeases, n => n === 2, "digest and action real leases");
    const board = createBoard(app.db, "you@example.com/digest", "reload", "Reload digest"); subscribe(app.db, "you@example.com/digest", board.name, "digest");
    dropReceipt = true; const receipts = receiptAttempts;
    post(app.db, "you@example.com/sim", board.name, "Process reload immutable digest"); app.application.boardsChanged([board.name]);
    const lost = app.repo.messages.insert("you@example.com/sim", "user", "you@example.com/action", "Process reload immutable action", null, false); app.application.wake(["you@example.com/action"]);
    await wait(() => receiptAttempts, n => n >= receipts + 2, "both receipts lost after real acceptance");
    await host.session.wait({ sessionID: action.id });
    assert(!raceGate.models.includes(digest.id)); assert(raceGate.models.includes(action.id));
    assert.equal((await host.session.inbox.list({ sessionID: digest.id })).length, 1);
    assert.equal(app.repo.cursors.directFor("you@example.com/action"), 0);
    const digestInput = admissions.find(i => i.sessionID === digest.id)!, input = admissions.find(i => i.sessionID === action.id)!;
    assert(input && digestInput);
    const boardCursor = () => app.db.prepare("SELECT cursor, notified_id FROM subscriptions WHERE board = ? AND handle = ?").get(board.name, "you@example.com/digest") as { cursor: number; notified_id: number };
    const oldBoard = boardCursor();
    await host.close(); host = undefined; dropReceipt = false;
    await Bun.write(join(root, "real-reload.json"), JSON.stringify({ pid: process.pid, input, digestInput, location }));
    const worker = Bun.spawn([process.execPath, join(import.meta.dir, "real-reload.ts")], { env: { ...process.env, GRAYBOARD_REAL_BACKEND_PORT: String(app.server.port) }, stdout: "inherit", stderr: "inherit" });
    assert.equal(await worker.exited, 0);
    assert.equal(app.repo.cursors.directFor("you@example.com/action"), lost.id);
    assert(boardCursor().notified_id > oldBoard.notified_id, "Actual board digest notification cursor advanced only after replayed durable acceptance");
    console.log("REAL_PROCESS_DIGEST_ACTION_RELOAD_OK", { actionCursor: lost.id, boardBefore: oldBoard, boardAfter: boardCursor() });
    console.log("REAL_BACKEND_RELOAD_OK");
  } else if (process.env.GRAYBOARD_TEST_CRASH_BOUNDARY) {
    const boundary = process.env.GRAYBOARD_TEST_CRASH_BOUNDARY; assert(["before", "after"].includes(boundary));
    const crashedRoot = await makeRoot("Actual process crash root");
    await rpc.enroll({ sessionID: crashedRoot.id, name: "crash", create: true }, { location });
    await wait(() => app.mcp.activeLeases, n => n === 1, "crash root lease");
    await host.session.switchModel({ sessionID: crashedRoot.id, model: { providerID: "fixture", id: "fixture" } });
    await host.close(); host = undefined;
    await Bun.write(join(root, "real-reload.json"), JSON.stringify({ pid: process.pid, sessionID: crashedRoot.id, location }));
    const crashWorker = Bun.spawn([process.execPath, join(import.meta.dir, "real-reload.ts")], { env: { ...process.env, GRAYBOARD_REAL_BACKEND_PORT: String(app.server.port), GRAYBOARD_REAL_WORKER_MODE: "hold-" + boundary }, stdout: "inherit", stderr: "inherit" });
    try {
      await wait(() => Bun.file(join(root, "real-worker-ready.json")).exists(), Boolean, "separate process host ready");
      const lost = app.repo.messages.insert("you@example.com/sim", "user", "you@example.com/crash", "Crash at actual " + boundary + " admission", null, false); app.application.wake(["you@example.com/crash"]);
      await wait(() => Bun.file(join(root, "real-worker-held.json")).exists(), Boolean, "actual admission crash boundary");
      const saved = await Bun.file(join(root, "real-worker-held.json")).json();
      savedInput(saved.input); assert.equal(saved.input.sessionID, crashedRoot.id, "Held handoff preserves the exact crash root");
      assert.equal(saved.input.resume, true); assert.equal(saved.pid, crashWorker.pid);
      assert.equal(app.repo.cursors.directFor("you@example.com/crash"), 0, "Held actual host write has not receipted real item");
      crashWorker.kill("SIGKILL"); await crashWorker.exited;
      assert.equal(saved.models.length, boundary === "before" ? 0 : 1, "Historical wake belongs only to already committed actionable root");
      await Bun.write(join(root, "real-reload.json"), JSON.stringify({ pid: process.pid, input: saved.input, location, uncommitted: boundary === "before" }));
      const recovery = Bun.spawn([process.execPath, join(import.meta.dir, "real-reload.ts")], { env: { ...process.env, GRAYBOARD_REAL_BACKEND_PORT: String(app.server.port), GRAYBOARD_REAL_WORKER_MODE: "replay" }, stdout: "inherit", stderr: "inherit" });
      assert.equal(await recovery.exited, 0, "Actual OS-process recovery after kill passes");
      assert.equal(app.repo.cursors.directFor("you@example.com/crash"), lost.id);
      const result = await Bun.file(join(root, "real-reload-result.json")).json();
      console.log("REAL_PROCESS_CRASH_RECOVERY_OK", JSON.stringify({ boundary, original: saved.input, historicalModels: saved.models, recoveryModels: result.models, cursor: lost.id }));
      console.log("REAL_BACKEND_CRASH_OK");
    } finally { crashWorker.kill("SIGKILL"); await crashWorker.exited; }
  } else if (process.env.GRAYBOARD_TEST_REAL_RACE) {
    await realRace({ scenario: process.env.GRAYBOARD_TEST_REAL_RACE, gate: raceGate, host, ctx, app, location, subscriberWork, expiryContinuation,
      enroll: (sessionID, name) => rpc.enroll({ sessionID, name, create: true }, { location }),
      pause: () => rpc.pause({}, { location }), status: () => rpc.status({}, { location }),
      account: async () => { email = "other@example.com"; await signIn(native.integrationID!); },
      outage: value => { subscriberOutage = value; }, receipts: () => receiptAttempts });
    console.log("REAL_BACKEND_RACE_OK");
  } else {
  const a = await makeRoot("Root A"), b = await makeRoot("Root B");
  const approval = await rpc.enroll({ sessionID: a.id }, { location }); console.log("APPROVAL", approval); assert.equal(approval.state, "unbound"); assert.equal(app.mcp.activeLeases, 0); assert.equal(row(a.id)?.name ?? null, null);
  await invoke(a.id, "bind", { name: "be", create: true });
  await wait(() => rpc.status({}, { location }), s => s.state === "active", "native bind completion opens real lease");
  await invoke(b.id, "bind", { name: "fe", create: true }); assert.equal(app.mcp.activeLeases, 1, "Binding before approval is not receiving approval");
  await rpc.enroll({ sessionID: b.id }, { location });
  await wait(() => app.mcp.activeLeases, n => n === 2, "two root leases");
  assert.notEqual(row(a.id)?.ownership_id, row(b.id)?.ownership_id);
  await invoke(a.id, "dm_send", { to: "fe", body: "Native sender isolation A" });
  await wait(() => app.repo.cursors.directFor("you@example.com/fe"), n => n > 0, "real receipt cursor B");
  await invoke(b.id, "dm_send", { to: "be", body: "Native sender isolation B" });
  await wait(() => app.repo.cursors.directFor("you@example.com/be"), n => n > 0, "real receipt cursor A");
  const sent = app.db.prepare("SELECT sender, recipient FROM messages WHERE body LIKE 'Native sender isolation%'").all();
  assert.deepEqual(sent, [{ sender: "you@example.com/be", recipient: "you@example.com/fe" }, { sender: "you@example.com/fe", recipient: "you@example.com/be" }]);
  console.log("REAL_ROOT_ISOLATION_OK", { opens: opens.length, cimd, codes });
  const child = await host.session.create({ location, parentID: a.id, permissions: [{ action: "*", resource: "*", effect: "allow" }] });
  const grandchild = await host.session.create({ location, parentID: child.id, permissions: [{ action: "*", resource: "*", effect: "allow" }] });
  await invoke(grandchild.id, "dm_send", { to: "fe", body: "Nested child inherits A" });
  assert.equal(row(grandchild.id)?.root_session_id, row(a.id)?.session_id); assert.equal(row(child.id), null, "via ancestry is not registration authority");
  assert.match(row(a.id)!.session_id, SESSION_ID); assert.match(row(grandchild.id)!.session_id, SESSION_ID);
  assert.equal((app.db.prepare("SELECT sender_id FROM messages WHERE body = ?").get("Nested child inherits A") as { sender_id: string }).sender_id, row(grandchild.id)!.session_id);
  const registration = calls.find(c => c.name === "session_register" && c.args.child === grandchild.id); assert.deepEqual(registration?.args.via, [child.id]);
  await invoke(grandchild.id, "bind", { name: "child-control", create: true }); assert.equal(row(grandchild.id)?.name, null); assert.equal(app.mcp.activeLeases, 2);
  const attachmentGrant = await ctx.integration.connection.resolve(selected); assert(attachmentGrant?.type === "oauth");
  const attachment = (method: string, path: string, raw?: string) => fetch(resource + "/attachments" + path, { method, headers: { Authorization: "Bearer " + attachmentGrant.access, ...(raw ? { "X-Grayboard-Session": encodeURIComponent(raw) } : {}), ...(method === "POST" ? { "Content-Length": String(new TextEncoder().encode("Native child attachment fixture").length) } : {}) }, ...(method === "POST" ? { body: "Native child attachment fixture" } : {}) });
  assert.equal((await attachment("POST", "?filename=fixture.txt")).status, 403);
  assert.equal((await attachment("POST", "?filename=fixture.txt", child.id)).status, 403, "via is not attachment mapping authority");
  assert.equal((await attachment("POST", "?filename=fixture.txt&identity=fe", grandchild.id)).status, 403);
  const upload = await attachment("POST", "?filename=fixture.txt", grandchild.id); assert.equal(upload.status, 201);
  const file = await upload.json() as { id: number };
  assert.equal((app.db.prepare("SELECT uploader FROM attachments WHERE id = ?").get(file.id) as { uploader: string }).uploader, "you@example.com/be");
  const download = await attachment("GET", "/" + file.id, grandchild.id); assert.equal(download.status, 200); assert.equal(await download.text(), "Native child attachment fixture");
  assert((await attachment("DELETE", "/" + file.id, grandchild.id)).ok);
  console.log("REAL_NATIVE_GRANT_CHILD_ATTACHMENTS_OK", { id: file.id, mappedRoot: row(a.id)?.session_id });
  await host.session.update({ sessionID: grandchild.id, archived: true });
  await wait(() => row(grandchild.id), r => !r, "raw child self-close"); assert.equal(row(a.id)?.name, "be");
  assert.equal((await attachment("POST", "?filename=ended.txt", grandchild.id)).status, 403, "Ended child cannot reuse attachment mapping");
  await invoke(child.id, "whoami", {}); assert.equal(row(child.id)?.root_session_id, row(a.id)?.session_id);
  assert(nativeCompleted.includes(a.id));
  if (codeMode) { assert(wrappers.includes(a.id)); assert(wrappers.includes(grandchild.id)); }
  console.log("REAL_CHILD_META_AND_SELF_CLOSE_OK", { codeMode, rootNativeBindCompleted: nativeCompleted.includes(a.id), outerExecute: wrappers.length });
  await invoke(a.id, "claim_take", { key: "ticket:ENG-142", note: "Native root claim" });
  const claimHolder = () => (app.db.prepare("SELECT holder FROM claims WHERE key = ?").get("ticket:ENG-142") as { holder: string } | null)?.holder;
  assert.equal(claimHolder(), "you@example.com/be");
  const ownership = row(a.id)!.ownership_id;
  for (const name of ["r1", "r2", "r3", "r4"]) { const before = opens.length; await invoke(a.id, "bind", { name, create: true }); await wait(() => opens.length, n => n === before + 1, "one rebind lease " + name); assert.equal(row(a.id)!.ownership_id, ownership); assert.equal(app.mcp.activeLeases, 2); }
  assert.equal(row(a.id)!.bind_gen, 5); assert.equal(claimHolder(), "you@example.com/r4");
  assert.equal(row(child.id)?.root_session_id, row(a.id)?.session_id, "Registered child survives native rebind ownership generations");
  await invoke(b.id, "bind", { name: "be" });
  await invoke(b.id, "claim_release", { key: "ticket:ENG-142" }); assert.equal(claimHolder(), "you@example.com/r4", "Successor owner of the old mailbox cannot release moved claim");
  await invoke(a.id, "claim_release", { key: "ticket:ENG-142" }); assert.equal(claimHolder(), undefined);
  assert.equal(new Set(calls.map(c => c.accessHash)).size, 1, "Native and subscriber share exactly the current single native access token");
  assert(calls.some(c => c.subscriber)); assert(calls.some(c => !c.subscriber));
  console.log("REAL_NATIVE_CLAIM_MOVEMENT_AND_FOREIGN_REFUSAL_OK");
  console.log("REAL_FOUR_REBINDS_OK", { ownership, opens: opens.length, streams: app.mcp.activeInboxListeners });
  await rpc.pause({}, { location }); assert.equal(app.mcp.activeLeases, 0); assert.equal(row(a.id), null); assert.equal(row(child.id), null, "Explicit root pause ends registered descendants");
  await rpc.enroll({ sessionID: a.id }, { location });
  const assertBPaused = async () => {
    assert.equal(rootStatus(await rpc.status({}, { location }), b.id)?.state, "paused", "B remains deliberately paused");
    const session = await host!.session.get({ sessionID: b.id });
    assert.equal((session.metadata?.["grayboard.enrollment"] as { enabled?: unknown } | undefined)?.enabled, false, "B approval remains disabled");
  };
  await wait(() => app.mcp.activeLeases, n => n === 1, "pause resume remembered name");
  assert(calls.some(c => c.name === "bind" && c.session === a.id && c.subscriber && c.args.name === "r4" && c.args.create === false));
  const board = createBoard(app.db, "you@example.com/r4", "fixture", "Fixture board"); subscribe(app.db, "you@example.com/r4", board.name, "digest");
  const beforeDigest = modelCalls; post(app.db, "you@example.com/sim", board.name, "Idle digest"); app.application.boardsChanged([board.name]);
  await wait(() => host!.session.inbox.list({ sessionID: a.id }), xs => xs.length >= 1, "digest durable idle admission"); assert.equal(modelCalls, beforeDigest);
  held = true; const enteredPromise = new Promise<void>(r => { entered = r; });
  const dm = app.repo.messages.insert("you@example.com/sim", "user", "you@example.com/r4", "Held real durable admission", null, false); app.application.wake(["you@example.com/r4"]);
  await enteredPromise;
  assert(app.repo.cursors.directFor("you@example.com/r4") < dm.id, "No real cursor movement before actual host durable admission");
  assert(admissions.at(-1)?.sessionID === a.id); held = false; release?.();
  await wait(() => app.repo.cursors.directFor("you@example.com/r4"), n => n === dm.id, "receipt after durable host acceptance");
  await host.session.wait({ sessionID: a.id });
  const original = admissions.at(-1)!; assert((await host.session.context({ sessionID: a.id })).some((m: { id?: string }) => m.id === original.id));
  console.log("REAL_DURABLE_RECEIPT_NOT_ACK_OK", { cursor: dm.id, receiptAttempts });
  dropReceipt = true; const receiptsBeforeLoss = receiptAttempts;
  const lost = app.repo.messages.insert("you@example.com/sim", "user", "you@example.com/r4", "Replay after host reload", null, false); app.application.wake(["you@example.com/r4"]);
  await wait(() => admissions, xs => xs.some(x => x.text.includes("Replay after host reload")), "lost receipt durable admission");
  await wait(() => receiptAttempts, n => n > receiptsBeforeLoss, "lost receipt attempted after real durable admission");
  await wait(() => rpc.status({}, { location }), s => rootRetrying(s, a.id), "lost receipt retry boundary before host reload"); await assertBPaused();
  const lostInput = admissions.find(x => x.text.includes("Replay after host reload"))!;
  await wait(() => admitted.some(x => x.id === lostInput.id), Boolean, "actual lost-receipt admission returned");
  const cursorBeforeReload = app.repo.cursors.directFor("you@example.com/r4");
  const settledSessions = await drainSessions(join(root, "host.sqlite"), sessionID => host!.session.wait({ sessionID }));
  assert(settledSessions.includes(lostInput.sessionID), "Actual target participates in the complete owned-session drain");
  // No remaining controlled producer: tools, admission holds and race drivers are all idle.
  assert.equal(target, undefined); assert.equal(held, false); assert.equal(raceGate.holding, false); assert.equal(pendingAdmissions, 0);
  assertStable(join(root, "host.sqlite"), lostInput);
  assert(sessionStates(join(root, "host.sqlite")).every(s => s.time_suspended === null));
  assert.equal(app.repo.cursors.directFor("you@example.com/r4"), cursorBeforeReload);
  assert.equal(dropReceipt, true); assert(rootRetrying(await rpc.status({}, { location }), a.id)); await assertBPaused();
  assert.equal(pendingAdmissions, 0); assert(sessionStates(join(root, "host.sqlite")).every(s => s.time_suspended === null));
  assertStable(join(root, "host.sqlite"), lostInput);
  assert.deepEqual(admitted.find(input => input.id === lostInput.id), lostInput, "Exact stable envelope survives actual admission");
  await host.close(); host = undefined; dropReceipt = false;
  assert.equal(app.repo.cursors.directFor("you@example.com/r4"), cursorBeforeReload);
  assert(app.repo.cursors.directFor("you@example.com/r4") < lost.id);
  await Bun.write(join(root, "real-reload.json"), JSON.stringify({ pid: process.pid, input: lostInput, location, settled: true, settledSessions }));
  const reloadProcess = Bun.spawn([process.execPath, join(import.meta.dir, "real-reload.ts")], { env: { ...process.env, GRAYBOARD_REAL_BACKEND_PORT: String(app.server.port) }, stdout: "inherit", stderr: "inherit" });
  assert.equal(await reloadProcess.exited, 0, "Separate installed-host reload process passes");
  const childReload = await Bun.file(join(root, "real-reload-result.json")).json();
  assert.notEqual(childReload.pid, process.pid);
  assert.equal(app.repo.cursors.directFor("you@example.com/r4"), lost.id, "Child process receipt moved actual backend cursor");
  host = await createHost(); await host.agent.list({ location }); rpc = host.rpc(Grayboard);
  await wait(() => app.repo.cursors.directFor("you@example.com/r4"), n => n === lost.id, "restored lease replay receipt");
  await host.session.wait({ sessionID: a.id });
  const replay = [...admissions, ...childReload.inputs as NativeInput[]].filter(x => x.text.includes("Replay after host reload")); assert(replay.length >= 2); assert.equal(new Set(replay.map(x => x.id)).size, 1);
  assert.equal((await host.session.context({ sessionID: a.id })).filter((m: { id?: string; type?: string }) => m.id === replay[0]!.id).length, 1);
  console.log("REAL_HOST_RELOAD_STABLE_ID_OK", { replay: replay.length, cursor: lost.id });

  // Separate regression: unfinished SDK execution resumes before duplicate forwarding.
  await drainSessions(join(root, "host.sqlite"), sessionID => host!.session.wait({ sessionID }));
  suspendedModel.target = a.id; dropReceipt = true; const suspendedReceipts = receiptAttempts;
  const suspendedDM = app.repo.messages.insert("you@example.com/sim", "user", "you@example.com/r4", "Suspended SDK execution across reload", null, false);
  app.application.wake(["you@example.com/r4"]);
  await bounded(suspendedModel.entered.promise, 20_000, "Target model reached owned suspension barrier");
  await wait(() => admitted.find(x => x.text.includes("Suspended SDK execution across reload")), Boolean, "suspended input admission returned");
  await wait(() => receiptAttempts, n => n > suspendedReceipts, "suspended lost receipt attempted");
  await wait(() => rpc.status({}, { location }), s => rootRetrying(s, a.id), "suspended lost receipt retrying"); await assertBPaused();
  const suspendedInput = admitted.find(x => x.text.includes("Suspended SDK execution across reload"))!;
  await drainSessions(join(root, "host.sqlite"), sessionID => host!.session.wait({ sessionID }), a.id);
  assertStable(join(root, "host.sqlite"), suspendedInput);
  assert(sessionStates(join(root, "host.sqlite")).some(s => s.id === a.id && s.time_suspended !== null), "Target must actually be suspended before close");
  assert.equal(dropReceipt, true); assert.equal(pendingAdmissions, 0);
  const suspendedCursor = app.repo.cursors.directFor("you@example.com/r4"); assert(suspendedCursor < suspendedDM.id);
  await host.close(); host = undefined; suspendedModel.released.release(); suspendedModel.target = ""; dropReceipt = false;
  assertStable(join(root, "host.sqlite"), suspendedInput);
  assert(sessionStates(join(root, "host.sqlite")).some(s => s.id === a.id && s.time_suspended !== null));
  assert.equal(app.repo.cursors.directFor("you@example.com/r4"), suspendedCursor);
  await Bun.write(join(root, "real-suspended.json"), JSON.stringify({ pid: process.pid, input: suspendedInput, location }));
  const suspendedReload = Bun.spawn([process.execPath, join(import.meta.dir, "real-reload.ts")], { env: { ...process.env, GRAYBOARD_REAL_BACKEND_PORT: String(app.server.port), GRAYBOARD_REAL_WORKER_MODE: "suspended-resume" }, stdout: "inherit", stderr: "inherit" });
  assert.equal(await suspendedReload.exited, 0, "Separate suspended SDK resume regression passes");
  const suspendedResult = await Bun.file(join(root, "real-suspended-result.json")).json();
  assert.deepEqual(suspendedResult.models, [a.id]);
  assert.equal(app.repo.cursors.directFor("you@example.com/r4"), suspendedDM.id);
  console.log("REAL_SUSPENDED_RESUME_BEFORE_REPLAY_OK");
  host = await createHost(); await host.agent.list({ location }); rpc = host.rpc(Grayboard);
  await drainSessions(join(root, "host.sqlite"), sessionID => host!.session.wait({ sessionID }));
  const timelyOwnership = row(a.id)!.ownership_id;
  await host.close(); host = undefined; await app.stop(); app = start();
  host = await createHost(); await host.agent.list({ location }); rpc = host.rpc(Grayboard);
  await wait(() => app.mcp.activeLeases, n => n === 1, "server restart before sticky deadline"); assert.equal(row(a.id)!.ownership_id, timelyOwnership);
  await host.close(); host = undefined; await app.stop(); await Bun.sleep(31_000); app = start();
  host = await createHost(); await host.agent.list({ location }); rpc = host.rpc(Grayboard);
  await wait(() => app.mcp.activeLeases, n => n === 1, "server restart after sticky expiry"); assert.notEqual(row(a.id)!.ownership_id, timelyOwnership);
  console.log("REAL_SERVER_RESTART_DEADLINES_OK", { before: timelyOwnership, after: row(a.id)!.ownership_id });
  await rpc.pause({}, { location }); await rpc.enroll({ sessionID: a.id, name: "does-not-exist" }, { location }); assert.equal(app.mcp.activeLeases, 0); assert.equal(row(a.id)?.name ?? null, null);
  assert.equal(app.repo.aliases.listForScope("person", "you@example.com").some(i => i.name === "does-not-exist"), false);
  await rpc.enroll({ sessionID: a.id, name: "r4" }, { location }); await wait(() => app.mcp.activeLeases, n => n === 1, "explicit reapproval existing name");
  const drift = await ctx.mcp.transform(e => { const old = e.get("grayboard"); assert(old?.type === "remote"); e.set("grayboard", { ...old, headers: { "X-Fixture-Drift": "away" } }); }); await ctx.mcp.reload();
  await wait(() => rpc.status({}, { location }), s => rootStatus(s, a.id)?.state === "paused", "real config drift"); await drift.dispose(); await ctx.mcp.reload(); assert.equal(rootStatus(await rpc.status({}, { location }), a.id)?.state, "paused");
  console.log("REAL_CONFIG_AWAY_BACK_LATCH_OK");
  await rpc.enroll({ sessionID: a.id }, { location }); await wait(() => app.mcp.activeLeases, n => n === 1, "reenroll after observed drift");
  held = true; const staleEntered = new Promise<void>(r => { entered = r; });
  const stale = app.repo.messages.insert("you@example.com/sim", "user", "you@example.com/r4", "Old issued batch across native rebind", null, false); app.application.wake(["you@example.com/r4"]);
  await staleEntered; const oldAdmission = admissions.at(-1)!, staleReceipts = receiptAttempts;
  const grant = await ctx.integration.connection.resolve(selected); assert(grant?.type === "oauth");
  const principal = app.oauth.authenticate(new Request(resource, { headers: { Authorization: "Bearer " + grant.access } })); assert(!(principal instanceof Response));
  await app.mcp.sessions.bind(principal, sessionContext(principal, { "ai.opencode/sessionID": a.id }), { name: "final", create: true });
  held = false; release?.();
  await wait(() => rpc.status({}, { location }), s => rootStatus(s, a.id)?.state === "paused", "out-of-band real service rebind observed after old host admission");
  assert.equal(receiptAttempts, staleReceipts); assert(app.repo.cursors.directFor("you@example.com/r4") < stale.id); assert.equal(oldAdmission.sessionID, a.id);
  assert((await host.session.context({ sessionID: a.id })).some((m: { id?: string }) => m.id === oldAdmission.id) || (await host.session.inbox.list({ sessionID: a.id })).some((m: { id?: string }) => m.id === oldAdmission.id));
  console.log("REAL_OLD_BATCH_REBIND_STALE_RECEIPT_SUPPRESSED_OK");
  await rpc.enroll({ sessionID: a.id }, { location }); await wait(() => app.mcp.activeLeases, n => n === 1, "explicit approval of successor real binding");
  const revokeFixtureGrant = (grantID: string) => {
    const token = app.db.prepare("SELECT hash FROM oauth_tokens WHERE grant_id = ? AND kind = 'refresh' LIMIT 1").get(grantID) as { hash: string }; assert(token);
    app.repo.oauth.revokeToken(token.hash, OPENCODE_CLIENT, Date.now());
  };
  const g1 = row(a.id)!.grant_id, second = await signIn(native.integrationID); assert(second?.type === "credential");
  await wait(() => rpc.status({}, { location }), s => rootStatus(s, a.id)?.state === "paused", "native new grant latches receiving approval"); await host.mcp.connect({ server: "grayboard", location });
  await invoke(a.id, "peer_list", {}); assert.equal(row(a.id)!.grant_id, g1, "Ordinary G2 tools cannot attach ownership");
  await invoke(a.id, "bind", { name: "final" }); assert.notEqual(row(a.id)!.grant_id, g1, "Only owning G2 success attaches grant");
  await rpc.enroll({ sessionID: a.id }, { location }); await wait(() => app.mcp.activeLeases, n => n === 1, "G2 attached lease");
  revokeFixtureGrant(g1);
  assert.equal(row(a.id)?.name, "final", "Revoking old G1 does not release G2 owner");
  revokeFixtureGrant(row(a.id)!.grant_id);
  await wait(() => app.mcp.activeLeases, n => n === 0, "G2 revoke ends actual lease"); assert.equal(row(a.id), null);
  await wait(() => rpc.status({}, { location }), s => ["auth", "paused"].includes(rootStatus(s, a.id)?.state ?? ""), "revoked token fail closed");
  console.log("REAL_G1_G2_ATTACH_REVOKE_OK");
  email = "other@example.com"; await signIn(native.integrationID); await host.mcp.connect({ server: "grayboard", location });
  assert.equal(rootStatus(await rpc.status({}, { location }), a.id)?.state, "paused", "A new native account never retargets old approval");
  const oldPending = app.repo.messages.insert("you@example.com/sim", "user", "you@example.com/final", "Old account must not retarget", null, false);
  await rpc.enroll({ sessionID: a.id, name: "final", create: true }, { location }); await wait(() => app.mcp.activeLeases, n => n === 1, "explicit new account approval");
  const lastOpen = await host.session.get({ sessionID: a.id }); assert(lastOpen.metadata);
  const pendingBeforeDisable = admissions.length; app.repo.users.setDisabled(app.repo.users.findByEmail(email)!.id, true);
  await wait(() => app.mcp.activeLeases, n => n === 0, "actual user disable ends ownership"); assert.equal(row(a.id), null);
  assert(app.repo.cursors.directFor("you@example.com/final") < oldPending.id); assert.equal(admissions.length, pendingBeforeDisable);
  console.log("REAL_ACCOUNT_DRIFT_AND_DISABLE_OK");
  assert(!calls.some(c => c.name === "dm_ack"), "Delivery receipts are never dm_ack");
  assert.equal(codes, 3); assert.equal(google, 3); assert.equal(process.env.GRAYBOARD_TEST_CIMD_LIVE === "1" ? cimd === 0 : cimd >= 1, true); assert.equal(refreshes, 0);
  console.log("REAL_BACKEND_HOST_OK", { codes, refreshes, cimd, modelCalls, opens: opens.length, receiptAttempts });
  }
} finally { suspendedModel.released.release(); release?.(); raceGate.holding = false; await host?.close(); subscriberWork.restore(); await app.stop(); globalThis.fetch = fetch0; }
