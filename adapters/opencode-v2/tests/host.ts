import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { OpenCode } from "@opencode/sdk";
import { Plugin, Provider, Model } from "@opencode/plugin";
import type { Context } from "@opencode/plugin/promise/plugin";
import { startServer } from "../../../src/server/app.ts";
import { OPENCODE_CLIENT } from "../../../tests/helpers/hosted.ts";
import { sessionContext } from "../../../src/server/hosted.ts";
import { createBoard, post, subscribe } from "../../../src/core/boards.ts";

const root = process.env.GRAYBOARD_GIT_TEST_ROOT!;
assert(root); assert.equal(Bun.version, "1.4.4");
assert.equal((await Bun.file(join(root, "node_modules/@opencode/sdk/package.json")).json()).version, "2.1.4");
assert.equal(Bun.which("grayboard"), null);
const installed = readFileSync(join(root, "installed.txt"), "utf8").trim();
const { default: plugin, Grayboard } = await import(pathToFileURL(join(installed, "src/index.ts")).href) as typeof import("../src/index.js");
const issuer = "https://grayboard.example.com/hosted", resource = issuer + "/mcp";
let email = "you@example.com", google = 0, cimd = 0, codes = 0, refreshes = 0, callbackOrigin = "", modelCalls = 0;
const config = { dbPath: join(root, "grayboard.sqlite"), blobDir: join(root, "blobs"), httpPort: 0, googleClientId: "fake-google", googleClientSecret: "fixture-secret", orgDomain: "example.com", publicUrl: issuer, messageRetentionDays: 90, auditRetentionDays: 90, devAuth: false, admins: [], oauthClients: [] };
const start = () => startServer(config, { hostname: "127.0.0.1", background: false, oauth: { exchangeGoogle: async () => { google++; return { email, displayName: "Fixture" }; }, ...(process.env.GRAYBOARD_TEST_CIMD_LIVE === "1" ? {} : { cimd: { resolve: async host => { assert.equal(host, "opencode.ai"); return [{ address: "93.184.216.34", family: 4 }]; }, read: async url => { assert.equal(url.href, OPENCODE_CLIENT); cimd++; return JSON.stringify({ client_id: OPENCODE_CLIENT, client_name: "OpenCode", token_endpoint_auth_method: "none", redirect_uris: ["http://127.0.0.1/callback"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }); } } }) } });
let app = start();
let ctx!: Context, target: { tool: string; args: Record<string, unknown> } | undefined, issued = false;
let dropReceipt = false, receiptAttempts = 0, held = false, release: (() => void) | undefined, entered: (() => void) | undefined;
const admissions: Parameters<Context["session"]["synthetic"]>[0][] = [];
const calls: { name: string; session: string; subscriber: boolean; args: Record<string, unknown>; cap: string | null }[] = [];
const opens: { capability: string; ownership: number; bind_gen: number }[] = [];
const fetch0 = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init), url = new URL(req.url);
  if (url.origin === callbackOrigin) return fetch0(req);
  if (url.origin === "https://model.example.com") {
    modelCalls++; await req.json();
    const call = target && !issued; issued = true;
    const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: "fixture_call", type: "function", function: { name: "grayboard_" + target!.tool, arguments: JSON.stringify(target!.args) } }] } : { content: "Fixture reply" };
    return new Response("data: " + JSON.stringify({ id: "local", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] }) + "\n\ndata: " + JSON.stringify({ id: "local", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) + "\n\ndata: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  }
  assert.equal(url.origin, new URL(issuer).origin, "Only fixture HTTPS endpoints and native OAuth callback allowed");
  assert(!url.pathname.endsWith("/register"), "CIMD must not use DCR");
  if (url.pathname.endsWith("/oauth/token")) { const form = new URLSearchParams(await req.clone().text()); if (form.get("grant_type") === "authorization_code") codes++; else refreshes++; assert.equal(form.get("client_id"), OPENCODE_CLIENT); }
  const b = req.method === "POST" && url.pathname.endsWith("/mcp") ? await req.clone().json() as any : undefined;
  if (b?.method === "tools/call") {
    const session = b.params?._meta?.["ai.opencode/sessionID"]; assert.equal(typeof session, "string");
    calls.push({ name: b.params.name, session, subscriber: req.headers.get("X-Grayboard-Client") === "subscriber", args: b.params.arguments ?? {}, cap: req.headers.get("X-Grayboard-Lease") });
    assert(!req.headers.has("X-Grayboard-Identity"));
    console.log("SUBCALL", b.params.name, session);
    if (b.params.name === "delivery_receipt") { receiptAttempts++; if (dropReceipt) throw new Error("Receipt transport deliberately lost before commit"); }
  }
  const res = await fetch0(new Request(`http://127.0.0.1:${app.server.port}` + url.pathname + url.search, req));
  if (b?.method === "tools/call" && req.headers.get("X-Grayboard-Client") === "subscriber") { const text = await res.clone().text(); if (text.includes('"isError":true')) console.log("SUBSCRIBER_ERROR", b.params.name, text); }
  if (b?.params?.name === "delivery_open" && res.ok) {
    const body = await res.clone().text();
    const match = body.startsWith("data:") ? JSON.parse(body.slice(5)) : JSON.parse(body);
    if (!match.result?.isError) { const value = JSON.parse(match.result.content[0].text); opens.push(value); }
  }
  if (process.env.GRAYBOARD_TEST_CHALLENGE_DIAGNOSTIC === "1" && res.status === 401 && url.pathname.endsWith("/mcp")) {
    const headers = new Headers(res.headers); headers.set("WWW-Authenticate", headers.get("WWW-Authenticate")!.replace('scope="grayboard:tools"', 'scope="grayboard:delivery grayboard:tools"'));
    return new Response(res.body, { status: res.status, headers });
  }
  return res;
}) as typeof fetch;
const fixture = Plugin.define({ id: "grayboard.real.fixture", async setup(c) {
  ctx = c;
  await c.mcp.transform(e => e.set("grayboard", { type: "remote", url: resource, codemode: false }));
  const p = Provider.ID.make("fixture");
  await c.provider.transform(e => e.add({ info: { ...Provider.Info.empty(p), name: "Fixture", activation: "enabled", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: "https://model.example.com/v1" } }, models: [{ ...Model.Info.default(p, Model.ID.make("fixture")), name: "Fixture" }] }));
  await c.session.hook("title", e => { e.result = "Fixture"; });
} });
const instrumented = Plugin.define({ ...plugin, setup(c) { return plugin.setup({ ...c, session: new Proxy(c.session, { get(s, k) {
  if (k === "synthetic") return async (input: Parameters<Context["session"]["synthetic"]>[0]) => { admissions.push(structuredClone(input)); if (held) { entered?.(); await new Promise<void>(r => { release = r; }); } return s.synthetic(input); };
  return Reflect.get(s, k);
} }) }); } });
const createHost = () => OpenCode.create({ plugins: [fixture, instrumented], database: { path: join(root, "host.sqlite") }, models: { fetch: false }, config: { directory: join(root, "real-home/config"), project: false, claude: false }, fs: { filewatcher: false } });
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
  const registration = calls.find(c => c.name === "session_register" && c.args.child === grandchild.id); assert.deepEqual(registration?.args.via, [child.id]);
  await invoke(grandchild.id, "bind", { name: "child-control", create: true }); assert.equal(row(grandchild.id)?.name, null); assert.equal(app.mcp.activeLeases, 2);
  await host.session.update({ sessionID: grandchild.id, archived: true });
  await wait(() => row(grandchild.id), r => !r, "raw child self-close"); assert.equal(row(a.id)?.name, "be");
  console.log("REAL_CHILD_META_AND_SELF_CLOSE_OK");
  const ownership = row(a.id)!.ownership_id;
  for (const name of ["r1", "r2", "r3", "r4"]) { const before = opens.length; await invoke(a.id, "bind", { name, create: true }); await wait(() => opens.length, n => n === before + 1, "one rebind lease " + name); assert.equal(row(a.id)!.ownership_id, ownership); assert.equal(app.mcp.activeLeases, 2); }
  assert.equal(row(a.id)!.bind_gen, 5);
  console.log("REAL_FOUR_REBINDS_OK", { ownership, opens: opens.length, streams: app.mcp.activeInboxListeners });
  await rpc.pause({}, { location }); assert.equal(app.mcp.activeLeases, 0); assert.equal(row(a.id), null);
  await rpc.enroll({ sessionID: a.id }, { location });
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
  const original = admissions.at(-1)!; assert((await host.session.context({ sessionID: a.id })).some(m => m.id === original.id));
  console.log("REAL_DURABLE_RECEIPT_NOT_ACK_OK", { cursor: dm.id, receiptAttempts });
  dropReceipt = true; const receiptsBeforeLoss = receiptAttempts;
  const lost = app.repo.messages.insert("you@example.com/sim", "user", "you@example.com/r4", "Replay after host reload", null, false); app.application.wake(["you@example.com/r4"]);
  await wait(() => admissions, xs => xs.some(x => x.text.includes("Replay after host reload")), "lost receipt durable admission");
  await wait(() => receiptAttempts, n => n > receiptsBeforeLoss, "lost receipt attempted after real durable admission");
  await wait(() => rpc.status({}, { location }), s => s.state === "retrying", "lost receipt retry boundary before host reload");
  await host.close(); host = undefined; dropReceipt = false;
  assert(app.repo.cursors.directFor("you@example.com/r4") < lost.id);
  host = await createHost(); await host.agent.list({ location }); rpc = host.rpc(Grayboard);
  await wait(() => app.repo.cursors.directFor("you@example.com/r4"), n => n === lost.id, "restored lease replay receipt");
  await host.session.wait({ sessionID: a.id });
  const replay = admissions.filter(x => x.text.includes("Replay after host reload")); assert(replay.length >= 2); assert.equal(new Set(replay.map(x => x.id)).size, 1);
  assert.equal((await host.session.context({ sessionID: a.id })).filter(m => m.id === replay[0]!.id).length, 1);
  console.log("REAL_HOST_RELOAD_STABLE_ID_OK", { replay: replay.length, cursor: lost.id });
  if (process.env.GRAYBOARD_TEST_SKIP_RESTART === "1") assert.equal(process.env.GRAYBOARD_TEST_CHALLENGE_DIAGNOSTIC, "1", "Skipping a required gate is diagnostic only");
  else {
  const timelyOwnership = row(a.id)!.ownership_id;
  await host.close(); host = undefined; await app.stop(); app = start();
  host = await createHost(); await host.agent.list({ location }); rpc = host.rpc(Grayboard);
  await wait(() => app.mcp.activeLeases, n => n === 1, "server restart before sticky deadline"); assert.equal(row(a.id)!.ownership_id, timelyOwnership);
  await host.close(); host = undefined; await app.stop(); await Bun.sleep(31_000); app = start();
  host = await createHost(); await host.agent.list({ location }); rpc = host.rpc(Grayboard);
  await wait(() => app.mcp.activeLeases, n => n === 1, "server restart after sticky expiry"); assert.notEqual(row(a.id)!.ownership_id, timelyOwnership);
  console.log("REAL_SERVER_RESTART_DEADLINES_OK", { before: timelyOwnership, after: row(a.id)!.ownership_id });
  }
  await rpc.pause({}, { location }); await rpc.enroll({ sessionID: a.id, name: "does-not-exist" }, { location }); assert.equal(app.mcp.activeLeases, 0); assert.equal(row(a.id)?.name ?? null, null);
  assert.equal(app.repo.identities.listForUser(app.repo.users.findByEmail("you@example.com")!.id).some(i => i.name === "does-not-exist"), false);
  await rpc.enroll({ sessionID: a.id, name: "r4" }, { location }); await wait(() => app.mcp.activeLeases, n => n === 1, "explicit reapproval existing name");
  const drift = await ctx.mcp.transform(e => { const old = e.get("grayboard"); assert(old?.type === "remote"); e.set("grayboard", { ...old, headers: { "X-Fixture-Drift": "away" } }); }); await ctx.mcp.reload();
  await wait(() => rpc.status({}, { location }), s => s.state === "paused", "real config drift"); await drift.dispose(); await ctx.mcp.reload(); assert.equal((await rpc.status({}, { location })).state, "paused");
  console.log("REAL_CONFIG_AWAY_BACK_LATCH_OK");
  await rpc.enroll({ sessionID: a.id }, { location }); await wait(() => app.mcp.activeLeases, n => n === 1, "reenroll after observed drift");
  held = true; const staleEntered = new Promise<void>(r => { entered = r; });
  const stale = app.repo.messages.insert("you@example.com/sim", "user", "you@example.com/r4", "Old issued batch across native rebind", null, false); app.application.wake(["you@example.com/r4"]);
  await staleEntered; const oldAdmission = admissions.at(-1)!, staleReceipts = receiptAttempts;
  const grant = await ctx.integration.connection.resolve(selected); assert(grant?.type === "oauth");
  const principal = app.oauth.authenticate(new Request(resource, { headers: { Authorization: "Bearer " + grant.access } })); assert(!(principal instanceof Response));
  await app.mcp.sessions.bind(principal, sessionContext(principal, { "ai.opencode/sessionID": a.id }), { name: "final", create: true });
  held = false; release?.();
  await wait(() => rpc.status({}, { location }), s => s.state === "paused", "out-of-band real service rebind observed after old host admission");
  assert.equal(receiptAttempts, staleReceipts); assert(app.repo.cursors.directFor("you@example.com/r4") < stale.id); assert.equal(oldAdmission.sessionID, a.id);
  assert((await host.session.context({ sessionID: a.id })).some(m => m.id === oldAdmission.id) || (await host.session.inbox.list({ sessionID: a.id })).some(m => m.id === oldAdmission.id));
  console.log("REAL_OLD_BATCH_REBIND_STALE_RECEIPT_SUPPRESSED_OK");
  await rpc.enroll({ sessionID: a.id }, { location }); await wait(() => app.mcp.activeLeases, n => n === 1, "explicit approval of successor real binding");
  const revokeFixtureGrant = (grantID: string) => {
    const token = app.db.prepare("SELECT hash FROM oauth_tokens WHERE grant_id = ? AND kind = 'refresh' LIMIT 1").get(grantID) as { hash: string }; assert(token);
    app.repo.oauth.revokeToken(token.hash, OPENCODE_CLIENT, Date.now());
  };
  const g1 = row(a.id)!.grant_id, second = await signIn(native.integrationID); assert(second?.type === "credential");
  await wait(() => rpc.status({}, { location }), s => s.state === "paused", "native new grant latches receiving approval"); await host.mcp.connect({ server: "grayboard", location });
  await invoke(a.id, "peer_list", {}); assert.equal(row(a.id)!.grant_id, g1, "Ordinary G2 tools cannot attach ownership");
  await invoke(a.id, "bind", { name: "final" }); assert.notEqual(row(a.id)!.grant_id, g1, "Only owning G2 success attaches grant");
  await rpc.enroll({ sessionID: a.id }, { location }); await wait(() => app.mcp.activeLeases, n => n === 1, "G2 attached lease");
  revokeFixtureGrant(g1);
  assert.equal(row(a.id)?.name, "final", "Revoking old G1 does not release G2 owner");
  revokeFixtureGrant(row(a.id)!.grant_id);
  await wait(() => app.mcp.activeLeases, n => n === 0, "G2 revoke ends actual lease"); assert.equal(row(a.id), null);
  await wait(() => rpc.status({}, { location }), s => s.state === "auth" || s.state === "paused", "revoked token fail closed");
  console.log("REAL_G1_G2_ATTACH_REVOKE_OK");
  email = "other@example.com"; await signIn(native.integrationID); await host.mcp.connect({ server: "grayboard", location });
  assert.equal((await rpc.status({}, { location })).state, "paused", "A new native account never retargets old approval");
  const oldPending = app.repo.messages.insert("you@example.com/sim", "user", "you@example.com/final", "Old account must not retarget", null, false);
  await rpc.enroll({ sessionID: a.id, name: "final", create: true }, { location }); await wait(() => app.mcp.activeLeases, n => n === 1, "explicit new account approval");
  const lastOpen = await host.session.get({ sessionID: a.id }); assert(lastOpen.metadata);
  const pendingBeforeDisable = admissions.length; app.repo.users.setDisabled(app.repo.users.findByEmail(email)!.id, true);
  await wait(() => app.mcp.activeLeases, n => n === 0, "actual user disable ends ownership"); assert.equal(row(a.id), null);
  assert(app.repo.cursors.directFor("you@example.com/final") < oldPending.id); assert.equal(admissions.length, pendingBeforeDisable);
  console.log("REAL_ACCOUNT_DRIFT_AND_DISABLE_OK");
  assert.equal(codes, 3); assert.equal(google, 3); assert.equal(process.env.GRAYBOARD_TEST_CIMD_LIVE === "1" ? cimd === 0 : cimd >= 1, true); assert.equal(refreshes, 0);
  console.log(process.env.GRAYBOARD_TEST_CHALLENGE_DIAGNOSTIC === "1" ? "DIAGNOSTIC_ONLY_CHALLENGE_WIDENED" : "REAL_BACKEND_HOST_OK", { codes, refreshes, cimd, modelCalls, opens: opens.length, receiptAttempts });
} finally { release?.(); await host?.close(); await app.stop(); globalThis.fetch = fetch0; }
