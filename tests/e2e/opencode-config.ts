import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { OpenCode } from "@opencode/sdk";
import { Plugin, Provider, Model } from "@opencode/plugin";
import type { Context } from "@opencode/plugin/promise/plugin";
import { setupOpenCode } from "../../src/cli/opencode-setup.ts";
import { startServer } from "../../src/server/app.ts";
import { OPENCODE_CLIENT } from "../helpers/hosted.ts";
import { createBoard, post, subscribe } from "../../src/core/boards.ts";

const root = process.env.GRAYBOARD_GIT_TEST_ROOT!;
assert(root); assert.equal(Bun.version, "1.4.4");
assert.equal(Bun.which("grayboard"), null);
assert.equal((await Bun.file(join(root, "node_modules/@opencode/sdk/package.json")).json()).version, "2.1.4");
const installed = readFileSync(join(root, "installed.txt"), "utf8").trim();
const { Grayboard } = await import(pathToFileURL(join(installed, "src/index.ts")).href) as typeof import("../../adapters/opencode-v2/src/index.ts");
const issuer = "https://grayboard.example.com/hosted", resource = issuer + "/mcp";
const directory = join(root, "config-home/config");
mkdirSync(directory, { recursive: true });
const configPath = join(directory, "opencode.jsonc");
const sentinel = '  // unrelated bytes retained\n  "instructions" : [],';
writeFileSync(configPath, '{\n' + sentinel + '\n}\n');
const revision = process.env.GRAYBOARD_PUBLIC_REVISION;
const options = { url: resource, config: configPath, ...(revision ? { revision } : { plugin: installed }) };
assert.equal(setupOpenCode(options, "").changed, true);
const generated = readFileSync(configPath, "utf8");
assert(generated.includes(sentinel));
assert(!/"(?:oauth|headers|options|client_id|scope|name)"/.test(generated));
assert.equal(setupOpenCode(options, "").changed, false);
assert.equal(readFileSync(configPath, "utf8"), generated);
let google = 0, cimd = 0, receipts = 0, models = 0, callbackOrigin = "";
const app = startServer({ dbPath: join(root, "config.sqlite"), blobDir: join(root, "config-blobs"), httpPort: 0, googleClientId: "fixture", googleClientSecret: "fixture-secret", orgDomain: "example.com", publicUrl: issuer, messageRetentionDays: 90, auditRetentionDays: 90, devAuth: false, admins: [], oauthClients: [] }, { hostname: "127.0.0.1", background: false, oauth: { exchangeGoogle: async () => { google++; return { email: "you@example.com", displayName: "Fixture" }; }, cimd: { resolve: async host => { assert.equal(host, "opencode.ai"); return [{ address: "93.184.216.34", family: 4 }]; }, read: async url => { assert.equal(url.href, OPENCODE_CLIENT); cimd++; return JSON.stringify({ client_id: OPENCODE_CLIENT, client_name: "OpenCode", token_endpoint_auth_method: "none", redirect_uris: ["http://127.0.0.1/callback"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }); } } } });
const fetch0 = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init), url = new URL(req.url);
  if (url.origin === callbackOrigin) return fetch0(req);
  if (url.origin === "https://model.example.com") { models++; throw new Error("An idle digest must not call a model"); }
  assert.equal(url.origin, new URL(issuer).origin);
  assert(!req.headers.has("X-Grayboard-Identity"));
  if (url.pathname.endsWith("/oauth/token")) assert.equal(new URLSearchParams(await req.clone().text()).get("client_id"), OPENCODE_CLIENT);
  const body = req.method === "POST" && url.pathname.endsWith("/mcp") ? await req.clone().json() as any : undefined;
  const response = await fetch0(new Request(`http://127.0.0.1:${app.server.port}` + url.pathname + url.search, req));
  if (body?.params?.name === "delivery_receipt" && response.ok) receipts++;
  return response;
}) as typeof fetch;
let ctx!: Context;
const fixture = Plugin.define({ id: "grayboard.config.fixture", async setup(c) {
  ctx = c;
  const p = Provider.ID.make("fixture");
  await c.provider.transform(e => e.add({ info: { ...Provider.Info.empty(p), name: "Fixture", activation: "enabled", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: "https://model.example.com/v1" } }, models: [{ ...Model.Info.default(p, Model.ID.make("fixture")), name: "Fixture" }] }));
  await c.session.hook("title", e => { e.result = "Config fixture"; });
} });
async function wait<T>(read: () => Promise<T> | T, predicate: (v: T) => boolean) {
  const deadline = Date.now() + 180_000;
  do { const value = await read(); if (predicate(value)) return value; await Bun.sleep(50); } while (Date.now() < deadline);
  throw new Error("Config host wait expired");
}
const location = { directory: join(root, "project") };
let host: Awaited<ReturnType<typeof OpenCode.create>> | undefined;
try {
  // Only provider/title capture is injected; both Grayboard and native MCP load from JSONC.
  host = await OpenCode.create({ plugins: [fixture], database: { path: join(root, "config-host.sqlite") }, models: { fetch: false }, config: { directory, project: false, claude: false }, fs: { filewatcher: false } });
  await host.agent.list({ location });
  await wait(() => ctx, Boolean);
  const rpc = host.rpc(Grayboard);
  await wait(() => rpc.status({}, { location }), s => s.state === "unenrolled");
  const loaded = (await host.plugin.list({ location })).data.find(p => p.id === "grayboard");
  assert.equal(loaded?.state.status, "active"); assert(loaded?.features.server && loaded.features.tui);
  if (revision) {
    assert.equal(loaded.features.rpc, true);
    assert.equal(loaded.source.type, "package");
    if (loaded.source.type === "package") assert.equal(loaded.source.target, `github:nolnoch/grayboard#${revision}::path:adapters/opencode-v2`);
    const locate = (path: string): string | undefined => {
      const candidate = join(path, "node_modules/grayboard-opencode");
      if (existsSync(join(candidate, "package.json"))) return candidate;
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== "node_modules") { const found = locate(join(path, entry.name)); if (found) return found; }
      }
    };
    const publicInstalled = locate(join(root, "config-home/cache")); assert(publicInstalled);
    assert.equal(existsSync(join(publicInstalled, "dist")), false);
    writeFileSync(join(root, "config-installed.txt"), publicInstalled);
  }
  const native = await wait(async () => (await ctx.mcp.list()).data.find(x => x.name === "grayboard"), x => x?.status.status === "needs_auth"); assert(native?.integrationID);
  const method = (await ctx.integration.get({ integrationID: native.integrationID })).data?.methods.find(m => m.type === "oauth"); assert(method);
  const attempt = await ctx.integration.oauth.connect({ integrationID: native.integrationID, methodID: method.id });
  const auth = new URL(attempt.data.url); assert.equal(auth.searchParams.get("client_id"), OPENCODE_CLIENT);
  callbackOrigin = new URL(auth.searchParams.get("redirect_uri")!).origin;
  const cookies = new Map<string, string>();
  const browser = async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers); headers.set("Cookie", [...cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const response = await fetch(url, { ...init, headers, redirect: "manual" });
    for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(";")[0]!, i = pair.indexOf("="); cookies.set(pair.slice(0, i), pair.slice(i + 1)); }
    return response;
  };
  const begin = await browser(auth.href), googleURL = new URL(begin.headers.get("Location")!);
  const returned = await browser(issuer + "/oauth/google/callback?" + new URLSearchParams({ code: "fixture-code", state: googleURL.searchParams.get("state")!, iss: "https://accounts.google.com" }));
  const html = await (await browser(returned.headers.get("Location")!)).text();
  const request = /name="request" value="([^"]+)"/.exec(html)?.[1], csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1]; assert(request && csrf);
  const consent = await browser(issuer + "/oauth/consent", { method: "POST", headers: { Origin: new URL(issuer).origin }, body: new URLSearchParams({ request, csrf, decision: "approve" }) });
  assert.equal((await fetch(consent.headers.get("Location")!)).status, 200);
  await wait(() => ctx.integration.connection.active(native.integrationID!), Boolean);
  await host.mcp.connect({ server: "grayboard", location });
  await wait(() => ctx.tool.list(), ts => ts.some(t => t.id === "grayboard_bind") && ts.some(t => t.id === "grayboard_dm_send") && !ts.some(t => t.id === "grayboard_delivery_open"));
  const session = await host.session.create({ location, title: "Explicit receiving root" });
  await host.session.switchModel({ sessionID: session.id, model: { providerID: "fixture", id: "fixture" } });
  assert.equal(app.mcp.activeLeases, 0);
  await rpc.enroll({ sessionID: session.id }, { location });
  assert.equal(app.mcp.activeLeases, 0, "Approval alone cannot bind or create a mailbox");
  assert.equal((app.db.prepare("SELECT count(*) AS n FROM handles WHERE name = ?").get("you@example.com/be") as { n: number }).n, 0);
  await rpc.enroll({ sessionID: session.id, name: "be", create: true }, { location });
  await wait(() => app.mcp.activeLeases, n => n === 1);
  const board = createBoard(app.db, "you@example.com/be", "config-fixture", "Config fixture");
  subscribe(app.db, "you@example.com/be", board.name, "digest");
  post(app.db, "you@example.com/sim", board.name, "Nonactionable digest");
  await wait(() => receipts, n => n >= 1);
  assert.equal((await host.session.inbox.list({ sessionID: session.id })).length, 1);
  assert.equal(models, 0); assert.equal(google, 1); assert(cimd >= 1);
  await rpc.pause({}, { location });
  await wait(() => app.mcp.activeLeases, n => n === 0);
  assert.equal(readFileSync(configPath, "utf8"), generated);
  console.log("HELPER_CONFIG_HOST_OK", JSON.stringify({ source: revision ? `github:nolnoch/grayboard#${revision}::path:adapters/opencode-v2` : "installed local Git fixture (not public)", google, cimd, receipts, models }));
} finally {
  await host?.close(); await app.stop(); app.db.close(); globalThis.fetch = fetch0;
}
