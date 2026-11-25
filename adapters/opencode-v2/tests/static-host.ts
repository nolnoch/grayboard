// #270 step 4 (service-principals.md D3 and criterion 2): a real OpenCode 2.1.4 host, with the installed plugin, against
// a real server, in static service-credential mode. The launcher (this process) creates a service and an `opencode`
// credential through the admin API, mints a run token through `/oauth/token` (client_credentials), and puts the mode,
// the pinned issuer and the token in the environment; the native entry is `oauth: false` with
// `Authorization: Bearer {env:GRAYBOARD_RUN_TOKEN}` in the global config. Two roots of the service enroll with no
// `/grayboard-enroll`, bind, and one's board post reaches the other as a push. Revoking the credential is terminal:
// the roots pause, saying a new run is needed, with no OAuth discovery, no reconnect and no retry. The run token is
// in no file under the run's directory, and in no status the plugin reports.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createFixtureHost } from "./effect-host.js";
import { fromPromise } from "@opencode/plugin/promise/adapter";
import { instrument, type NativeInput } from "./effect-instrument.js";
import { Plugin, Provider, Model } from "@opencode/plugin";
import type { Context } from "@opencode/plugin/promise/plugin";
import { startServer } from "../../../src/server/app.ts";
import { DEFAULT_HELLO_LIMIT, DEFAULT_AUTH_FAIL_LIMIT } from "../../../src/server/rate_limit.ts";
import { DEFAULT_TRUSTED_PROXIES } from "../../../src/server/client_addr.ts";

const codeMode = process.env.GRAYBOARD_TEST_CODEMODE === "1";
const root = process.env.GRAYBOARD_GIT_TEST_ROOT!;
assert(root); assert.equal(Bun.version, "1.4.4");
assert.equal((await Bun.file(join(root, "node_modules/@opencode/sdk/package.json")).json()).version, "2.1.4");
const installed = readFileSync(join(root, "installed.txt"), "utf8").trim();
const { default: plugin, Grayboard } = await import(pathToFileURL(join(installed, "src/index.ts")).href) as typeof import("../src/index.js");
const { NEW_RUN } = await import(pathToFileURL(join(installed, "src/binding.ts")).href) as typeof import("../src/binding.js");
// An issuer with a path, so the protected-resource metadata the plugin checks is the path-suffixed one (RFC 9728).
const issuer = "https://grayboard.example.com/hosted", resource = issuer + "/mcp", ADMIN = "admin@example.com", SERVICE = "ingest";
const lim = { burst: 10000, perSec: 10000 };
mkdirSync(join(root, "server"), { recursive: true });
const config = { store: { kind: "sqlite" as const, path: join(root, "server/grayboard.sqlite") }, blobDir: join(root, "server/blobs"), httpPort: 0, googleClientId: "", googleClientSecret: "", orgDomain: "example.com", publicUrl: issuer, messageRetentionDays: 90, auditRetentionDays: 90, devAuth: true, admins: [ADMIN], oauthClients: [], authFailLimit: DEFAULT_AUTH_FAIL_LIMIT, trustedProxies: DEFAULT_TRUSTED_PROXIES, helloLimit: DEFAULT_HELLO_LIMIT, hostedRequestLimit: lim, hostedSubscriberLimit: lim };
const app = startServer(config, { hostname: "127.0.0.1", background: false });
const local = `http://127.0.0.1:${app.server.port}`;
const fetch0 = globalThis.fetch;

// The launcher's half, on the server's own port: an admin, the service, its OpenCode credential and a run token.
const admin = ((await (await fetch0(`${local}/api/auth/dev-login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: ADMIN }) })).json()) as { session_token: string }).session_token;
const api = async (path: string, body: unknown) => { const r = await fetch0(local + path, { method: "POST", headers: { Authorization: `Bearer ${admin}` }, body: JSON.stringify(body) }); const value = await r.json(); assert(r.ok, `${path}: ${r.status} ${JSON.stringify(value)}`); return value as Record<string, any>; };
await api("/api/admin/services", { name: SERVICE, owners: [ADMIN] });
const credential = await api("/api/admin/services/credentials", { service: SERVICE, source: "opencode" });
const minted = await fetch0(`${local}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${btoa(`${credential.client_id}:${credential.client_secret}`)}` }, body: new URLSearchParams({ grant_type: "client_credentials" }) });
const runToken = ((await minted.json()) as { access_token: string }).access_token;
assert.equal(minted.status, 200); assert(runToken);
const digest = (s: string | null) => s ? createHash("sha256").update(s).digest("hex") : null;
// What the launcher sets, and the entry it writes: the token only through `{env:…}`, never in the file.
process.env.GRAYBOARD_RUN_TOKEN = runToken;
process.env.GRAYBOARD_AUTH = "static";
process.env.GRAYBOARD_ISSUER = issuer;
process.env.GRAYBOARD_PRINCIPAL = SERVICE;
mkdirSync(join(root, "static-home/config"), { recursive: true }); mkdirSync(join(root, "project"), { recursive: true });
writeFileSync(join(root, "static-home/config/opencode.json"), JSON.stringify({ mcp: { servers: { grayboard: { type: "remote", url: resource, oauth: false, codemode: codeMode, headers: { Authorization: "Bearer {env:GRAYBOARD_RUN_TOKEN}" } } } } }));

// Every request to the issuer's origin, as sent: OpenCode's native calls and the plugin's own.
type Seen = { path: string; method: string; auth: string | null; client: string | null; mcp?: string; tool?: string; session?: unknown; status?: number };
const seen: Seen[] = [];
let target: { tool: string; args: Record<string, unknown>; nonce: string } | undefined, issued = false, invokes = 0, ctx!: Context;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init), url = new URL(req.url);
  if (url.origin === "https://model.example.com") {
    const body = await req.text(), call = !!target && !issued && body.includes(target.nonce); if (call) issued = true;
    const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: "fixture_call", type: "function", function: { name: codeMode ? "execute" : "grayboard_" + target!.tool, arguments: JSON.stringify(codeMode ? { code: `return await tools.grayboard.${target!.tool}(${JSON.stringify(target!.args)})` } : target!.args) } }] } : { content: "Fixture reply" };
    return new Response("data: " + JSON.stringify({ id: "local", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] }) + "\n\ndata: " + JSON.stringify({ id: "local", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) + "\n\ndata: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  }
  assert.equal(url.origin, new URL(issuer).origin, "only the fixture model and the issuer's origin are reachable: " + url.origin);
  const b = req.method === "POST" && url.pathname.endsWith("/mcp") ? await req.clone().json() as any : undefined;
  const entry: Seen = { path: url.pathname, method: req.method, auth: digest(req.headers.get("Authorization")), client: req.headers.get("X-Grayboard-Client"), ...(b ? { mcp: b.method, tool: b.params?.name, session: b.params?._meta?.["ai.opencode/sessionID"] } : {}) };
  seen.push(entry);
  const res = await fetch0(new Request(local + url.pathname + url.search, req));
  entry.status = res.status;
  return res;
}) as typeof fetch;

const admissions: NativeInput[] = [];
const fixture = Plugin.define({ id: "grayboard.static.fixture", async setup(c) {
  ctx = c;
  const p = Provider.ID.make("fixture");
  await c.provider.transform(e => e.add({ info: { ...Provider.Info.empty(p), name: "Fixture", activation: "enabled", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: "https://model.example.com/v1" } }, models: [{ ...Model.Info.default(p, Model.ID.make("fixture")), name: "Fixture" }] }));
  await c.session.hook("title", e => { e.result = "Fixture"; });
} });
// A plugin option names another issuer, as a repository's config could: static mode reads its pin from the
// environment only, so this changes nothing.
const instrumented = instrument(plugin, async (input, forward) => { admissions.push(structuredClone(input)); return forward(input); }, () => ({ issuer: "https://elsewhere.example.com" }));
const host = await createFixtureHost({ plugins: [fromPromise(fixture), instrumented], database: { path: join(root, "host.sqlite") }, models: { fetch: false }, config: { directory: join(root, "static-home/config"), project: false, claude: false }, fs: { filewatcher: false } });
const location = { directory: join(root, "project") };
const status = () => host.rpc(Grayboard).status({}, { location });
async function wait<T>(read: () => Promise<T> | T, predicate: (v: T) => boolean, label: string, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  do { const v = await read(); if (predicate(v)) return v; await Bun.sleep(50); } while (Date.now() < deadline);
  console.log("STATUS", JSON.stringify(await status()));
  throw new Error("Wait expired: " + label);
}
async function invoke(sessionID: string, tool: string, args: Record<string, unknown>) {
  const nonce = `fixture-invoke-${++invokes}`;
  target = { tool, args, nonce }; issued = false;
  await host.session.switchModel({ sessionID, model: { providerID: "fixture", id: "fixture" } });
  await host.session.prompt({ sessionID, text: `Invoke ${tool} ${nonce}` }); await host.session.wait({ sessionID }); target = undefined;
}
const rootOf = async (id: string) => (await status()).roots.find(r => r.sessionID === id);
const makeRoot = (title: string) => host.session.create({ location, title, permissions: [{ action: "*", resource: "*", effect: "allow" }] });
// The run's files: everything under its directory but the server's own (the server stores digests, checked by
// the root suite) and the symlinked dependencies.
function files(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (path === join(root, "server") || name === "node_modules" || name === "tool-bin") continue;
    const s = statSync(path, { throwIfNoEntry: false });
    if (s?.isDirectory()) files(path, out); else if (s?.isFile()) out.push(path);
  }
  return out;
}
try {
  await host.agent.list({ location }); await wait(() => ctx, Boolean, "fixture setup");
  // R1: the entry connects from the environment's header alone; OpenCode has no integration and no OAuth for it.
  const entry = await wait(async () => (await ctx.mcp.list()).data.find(x => x.name === "grayboard"), x => !!x && x.status.status !== "pending", "native entry");
  assert.equal(entry?.status.status, "connected", JSON.stringify(entry)); assert(!entry?.integrationID);
  await host.mcp.connect({ server: "grayboard", location });
  await wait(() => ctx.tool.list(), ts => ts.some(t => t.id === "grayboard_bind"), "native tools");

  // Two roots of the service enroll on creation, with no enroll command: the issuer is pinned and whoami says service.
  const sender = await makeRoot("Static sender"), receiver = await makeRoot("Static receiver");
  for (const r of [sender, receiver]) await wait(() => rootOf(r.id), x => x?.state === "unbound", "auto-enroll " + r.id);
  // The enrolling whoami carried no session key, so it opened no hosted session (principle 7: the launcher's OpenCode
  // is the worker; enrolling starts nothing).
  const whoami = seen.filter(s => s.tool === "whoami" && s.client === null);
  assert.equal(whoami.length, 2, JSON.stringify(whoami)); assert(whoami.every(s => s.session === undefined && s.auth === digest(`Bearer ${runToken}`)));
  await invoke(sender.id, "bind", { name: "w-1", create: true });
  await invoke(receiver.id, "bind", { name: "w-2", create: true });
  for (const r of [sender, receiver]) await wait(() => rootOf(r.id), x => x?.state === "active", "active " + r.id);
  // R1, on the real path: every native tool call carried the run token and the session's `ai.opencode/sessionID`.
  const native = seen.filter(s => s.mcp === "tools/call" && s.client === null && s.tool !== "whoami");
  assert(native.length >= 2);
  for (const call of native) { assert.equal(call.auth, digest(`Bearer ${runToken}`)); assert([sender.id, receiver.id].some(id => id === call.session), JSON.stringify(call)); }
  const harness = app.db.query("SELECT DISTINCT harness FROM ids WHERE principal = ?").all(SERVICE) as { harness: string }[];
  assert.deepEqual(harness, [{ harness: "opencode" }]);

  // The receiver's board; the sender's post reaches it as a push, admitted into the receiver's session.
  await invoke(receiver.id, "board_create", { name: "static-runs", purpose: "Static mode push proof" });
  const body = "Static run finished " + Date.now();
  await invoke(sender.id, "board_post", { board: "static-runs", body });
  await wait(() => admissions.some(a => a.sessionID === receiver.id && a.text.includes(body)), Boolean, "push admitted to the receiver");
  const posted = app.db.query("SELECT author FROM posts WHERE body = ?").get(body) as { author: string } | null;
  assert.deepEqual(posted, { author: `${SERVICE}/w-1` });
  console.log("STATIC_PUSH_OK", JSON.stringify({ codeMode, roots: 2, author: posted.author }));

  // Revoking the credential ends its sessions; the next request with the run token is a 401, terminal for the run.
  const before = seen.length;
  await api("/api/admin/services/credentials/revoke", { client_id: credential.client_id });
  for (const r of [sender, receiver]) await wait(() => rootOf(r.id), x => x?.state === "paused", "paused after revoke " + r.id);
  for (const r of [sender, receiver]) assert.match((await rootOf(r.id))!.message, new RegExp(NEW_RUN));
  // A native call after the revoke is OpenCode's own 401; it starts nothing in the plugin either.
  const subscriber = () => seen.slice(before).filter(s => s.client === "subscriber").length;
  const settled = subscriber();
  await invoke(sender.id, "whoami", {});
  assert.equal(subscriber(), settled, "no subscriber retry after the terminal 401");
  const after = seen.slice(before);
  assert(after.some(s => s.status === 401), "the revoked token drew a 401");
  assert(!after.some(s => /oauth-authorization-server|openid-configuration|\/authorize|\/oauth\/(token|register)/.test(s.path)), "no OAuth discovery or token request: " + JSON.stringify(after.map(s => s.path)));
  assert.notEqual((await ctx.mcp.list()).data.find(x => x.name === "grayboard")?.status.status, "needs_auth");
  console.log("STATIC_TERMINAL_OK", JSON.stringify({ requestsAfterRevoke: after.length, unauthorized: after.filter(s => s.status === 401).length }));

  // The run token is in no file the run wrote (the plugin's storage, session metadata, logs) and no status.
  const leaked = files(root).filter(path => readFileSync(path).includes(runToken));
  assert.deepEqual(leaked, [], "run token written to " + leaked.join(", "));
  assert(!JSON.stringify(await status()).includes(runToken));
  console.log("STATIC_HYGIENE_OK", JSON.stringify({ scanned: files(root).length }));
} finally { await host.close(); await app.stop(); globalThis.fetch = fetch0; }
