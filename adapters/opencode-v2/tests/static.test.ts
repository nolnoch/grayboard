// Static service-credential mode (#270 D3, service-principals.md D8 step 4): the security properties an auditor checks,
// each a test that fails if it breaks. The controller's auto-enroll cases are in controller.test.ts ("static mode").
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Binding, NEW_RUN, type StaticMode } from "../src/binding.js";
import { pluginOptions, RUN_TOKEN, staticMode, STATIC_AUTH, STATIC_ISSUER, STATIC_PRINCIPAL } from "../src/lifecycle.js";
import { AccessExpired, Refusal } from "../src/core/model.js";
import { fixture } from "./native-fixture.js";

const ISSUER = "https://grayboard.example.com", RESOURCE = `${ISSUER}/mcp`, TOKEN = "run-token-CANARY-0123456789abcdef";
const ON = { [STATIC_AUTH]: "static", [STATIC_ISSUER]: ISSUER };
const dirs: string[] = [];
const empty = () => { const d = mkdtempSync(join(tmpdir(), "gb-static-")); dirs.push(d); return d; };
const fetch0 = globalThis.fetch;
afterEach(() => { globalThis.fetch = fetch0; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// The server's protected-resource metadata, and every request the plugin made (none may carry the run token).
function server(metadata: unknown = { resource: RESOURCE, authorization_servers: [ISSUER], scopes_supported: ["grayboard:tools", "grayboard:delivery"] }) {
  const seen: { url: string; redirect?: string; authorization: string | null }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push({ url: request.url, redirect: init?.redirect, authorization: request.headers.get("Authorization") });
    if (request.url === `${ISSUER}/.well-known/oauth-protected-resource/mcp`) return Response.json(metadata);
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return seen;
}
// A static entry: `oauth: false` and the run token OpenCode substituted from the launcher's environment.
// `oauth` builds the OAuth mode's binding over the same entry.
function entry(mode: StaticMode | "oauth" = { issuer: ISSUER }) {
  const f = fixture();
  f.config.oauth = false;
  f.config.headers.Authorization = `Bearer ${TOKEN}`;
  let drifts = 0;
  const binding = new Binding(f.ctx, "grayboard", () => { drifts++; }, undefined, mode === "oauth" ? undefined : mode);
  return { f, binding, get drifts() { return drifts; } };
}
const error = (p: Promise<unknown>) => p.then(() => { throw new Error("expected a refusal"); }, (e: unknown) => e);

test("the mode is the launcher's environment only: plugin options from any config layer never turn it on or set its pin", () => {
  const cwd = empty();
  const project = { static: { issuer: ISSUER }, auth: "static", [STATIC_AUTH]: "static", [STATIC_ISSUER]: ISSUER, issuer: ISSUER };
  expect(pluginOptions(project, {}, cwd)).not.toHaveProperty("static");
  expect(pluginOptions({ issuer: "https://elsewhere.example.com" }, ON, cwd).static).toEqual({ issuer: ISSUER });
  expect(staticMode({}, cwd)).toBeUndefined();
  expect(staticMode({ [STATIC_AUTH]: "" }, cwd)).toBeUndefined();
  expect(staticMode(ON, cwd)).toEqual({ issuer: ISSUER });
  // The launcher may name its service (#270 audit F3), from the environment only, like the mode and the pin.
  expect(staticMode({ ...ON, [STATIC_PRINCIPAL]: "ingest" }, cwd)).toEqual({ issuer: ISSUER, principal: "ingest" });
  expect(staticMode({ ...ON, [STATIC_PRINCIPAL]: "" }, cwd)).toEqual({ issuer: ISSUER });
  for (const bad of ["in gest", "ingest/w-1"]) expect(staticMode({ ...ON, [STATIC_PRINCIPAL]: bad }, cwd)).toEqual({ refused: expect.any(String) });
  expect(pluginOptions({ principal: "other" }, ON, cwd).static).toEqual({ issuer: ISSUER });
});

test("the variables are hosted core's names, and the pre-#1300 GRAYBOARD_OPENCODE_* names are not aliases", () => {
  const cwd = empty();
  expect([STATIC_AUTH, STATIC_ISSUER, STATIC_PRINCIPAL]).toEqual(["GRAYBOARD_AUTH", "GRAYBOARD_ISSUER", "GRAYBOARD_PRINCIPAL"]);
  expect(staticMode({ GRAYBOARD_AUTH: "static", GRAYBOARD_ISSUER: ISSUER, GRAYBOARD_PRINCIPAL: "ingest" }, cwd)).toEqual({ issuer: ISSUER, principal: "ingest" });
  const old = { GRAYBOARD_OPENCODE_AUTH: "static", GRAYBOARD_OPENCODE_ISSUER: ISSUER, GRAYBOARD_OPENCODE_PRINCIPAL: "ingest" };
  expect(staticMode(old, cwd)).toBeUndefined();
  expect(pluginOptions({}, old, cwd)).not.toHaveProperty("static");
  // An old name beside the new ones changes nothing: no fallback, no override.
  expect(staticMode({ ...old, GRAYBOARD_AUTH: "static", GRAYBOARD_ISSUER: ISSUER }, cwd)).toEqual({ issuer: ISSUER });
});

test("a repository's dotenv file naming any of the variables refuses the mode (Bun loads it into the environment)", () => {
  for (const [file, text] of [[".env", `${STATIC_AUTH}=static\n`], [".env.local", `export ${STATIC_ISSUER}=${ISSUER}\n`], [".env.production", `  ${STATIC_AUTH} = static`], [".env", `${STATIC_PRINCIPAL}=other\n`], [".env", `${RUN_TOKEN}=${TOKEN}\n`], [".env", `${STATIC_AUTH}: static\n`], [".env.local", `export ${STATIC_ISSUER}: ${ISSUER}\n`]]) {
    const cwd = empty();
    writeFileSync(join(cwd, file), text);
    expect(staticMode(ON, cwd)).toEqual({ refused: expect.stringContaining(file) });
  }
  const cwd = empty();
  writeFileSync(join(cwd, ".env"), "UNRELATED=1\n");
  expect(staticMode(ON, cwd)).toEqual({ issuer: ISSUER });
});

// Hosted core's rule and text (adapters/hosted-core/src/static.ts), so one launcher mistake reads the same in every
// harness (#1313): a run token without the mode is a refused static mode, never OAuth beside the launcher's entry.
const NO_MODE = "GRAYBOARD_RUN_TOKEN is set without GRAYBOARD_AUTH=static";
test("a run token without GRAYBOARD_AUTH=static is hosted core's refusal, whatever the entry's shape, and sends nothing", async () => {
  const cwd = empty();
  expect(RUN_TOKEN).toBe("GRAYBOARD_RUN_TOKEN");
  for (const env of [{ [RUN_TOKEN]: TOKEN }, { [RUN_TOKEN]: TOKEN, [STATIC_AUTH]: "" }, { [RUN_TOKEN]: TOKEN, [STATIC_ISSUER]: ISSUER, [STATIC_PRINCIPAL]: "ingest" }]) {
    expect(staticMode(env, cwd)).toEqual({ refused: NO_MODE });
    expect(pluginOptions({}, env, cwd).static).toEqual({ refused: NO_MODE });
  }
  // An empty token is no token: OAuth mode, as before.
  expect(staticMode({ [RUN_TOKEN]: "" }, cwd)).toBeUndefined();
  // A dotenv file that set the token is named instead (Bun put it in the environment).
  writeFileSync(join(cwd, ".env"), `${RUN_TOKEN}=${TOKEN}\n`);
  expect(staticMode({ [RUN_TOKEN]: TOKEN }, cwd)).toEqual({ refused: expect.stringContaining(".env in the working directory sets its variables") });
  // The launcher's static entry, and an ordinary OAuth entry in a shell with a stray token: both surface the refusal
  // itself, not an entry-shape message, and neither fetches anything nor reads OpenCode's grant.
  const mode = staticMode({ [RUN_TOKEN]: TOKEN }, empty());
  for (const oauth of [false, true]) {
    const seen = server(), s = entry(mode);
    if (oauth) { delete s.f.config.oauth; delete s.f.config.headers.Authorization; }
    expect(await error(s.binding.capture("R"))).toMatchObject({ code: "identity", message: NO_MODE });
    expect(await error(s.binding.configuration())).toMatchObject({ code: "identity", message: NO_MODE });
    expect(seen).toEqual([]);
    expect(s.f.resolutions).toBe(0);
  }
});

test("static mode without a valid pinned issuer is refused, never OAuth, and no request or token read happens (a non-canonical one too, #1321)", async () => {
  const cwd = empty();
  for (const env of [{ [STATIC_AUTH]: "static" }, { [STATIC_AUTH]: "static", [STATIC_ISSUER]: "" }, { [STATIC_AUTH]: "static", [STATIC_ISSUER]: "http://grayboard.example.com" }, { [STATIC_AUTH]: "static", [STATIC_ISSUER]: "https://u:p@grayboard.example.com" }, { [STATIC_AUTH]: "static", [STATIC_ISSUER]: "not a url" }, ...[` ${ISSUER}`, `${ISSUER}/?`, `${ISSUER}/#`, "https://grayboard.%65xample.com", "https:\\\\grayboard.example.com", `${ISSUER}/${"a".repeat(2048)}`].map(issuer => ({ [STATIC_AUTH]: "static", [STATIC_ISSUER]: issuer })), { [STATIC_AUTH]: "oauth", [STATIC_ISSUER]: ISSUER }, { [STATIC_AUTH]: "STATIC", [STATIC_ISSUER]: ISSUER }]) {
    const mode = staticMode(env, cwd);
    expect(mode).toEqual({ refused: expect.any(String) });
    const seen = server(), s = entry(mode);
    const refusal = await error(s.binding.capture("R"));
    expect(refusal).toBeInstanceOf(Refusal);
    expect((refusal as Refusal).code).toBe("identity");
    expect(seen).toEqual([]);
    expect(s.f.resolutions).toBe(0);
  }
});

test("an issuer mismatch is refused: another origin, metadata naming another issuer or resource, or a redirect", async () => {
  const other = entry(); other.f.config.url = "https://elsewhere.example.com/mcp";
  const seen = server();
  expect(await error(other.binding.capture("R"))).toMatchObject({ code: "identity", message: "Native issuer does not match the pinned issuer" });
  expect(seen).toEqual([]);
  for (const metadata of [{ resource: RESOURCE, authorization_servers: ["https://elsewhere.example.com"] }, { resource: `${ISSUER}/other`, authorization_servers: [ISSUER] }, { resource: RESOURCE }, "not json"]) {
    const seen = server(metadata), s = entry();
    expect(await error(s.binding.capture("R"))).toMatchObject({ code: "identity" });
    expect(seen.map(r => r.url)).toEqual([`${ISSUER}/.well-known/oauth-protected-resource/mcp`]);
  }
  // The metadata fetch refuses redirects, and never carries the run token.
  const fetched = server(), s = entry();
  await s.binding.capture("R");
  expect(fetched).toEqual([{ url: `${ISSUER}/.well-known/oauth-protected-resource/mcp`, redirect: "error", authorization: null }]);
});

test("only the exact static shape binds: oauth false, one Bearer Authorization header, no other authority header", async () => {
  const mutations: ((c: ReturnType<typeof fixture>["config"]) => void)[] = [
    c => { delete c.oauth; },
    c => { c.oauth = { client_id: "x" }; },
    c => { delete c.headers.Authorization; },
    c => { c.headers.Authorization = `Basic ${TOKEN}`; },
    c => { c.headers.Authorization = "Bearer "; },
    c => { c.headers.authorization = `Bearer ${TOKEN}`; },
    c => { c.headers["X-Grayboard-Identity"] = "fe"; },
    c => { c.headers["X-Grayboard-Lease"] = "x"; },
    c => { c.headers["X-Grayboard-Client"] = "x"; },
    c => { c.url = "http://grayboard.example.com/mcp"; },
    c => { c.url = `${RESOURCE}?token=1`; },
  ];
  for (const mutate of mutations) {
    server(); const s = entry(); mutate(s.f.config);
    expect(await error(s.binding.capture("R"))).toMatchObject({ code: "binding" });
  }
  // The OAuth mode still refuses this shape: static authority only exists in static mode.
  server(); const oauth = entry("oauth");
  expect(await error(oauth.binding.capture("R"))).toBeInstanceOf(Refusal);
});

test("the enrollment pins the issuer and a digest of the run token: a new token drifts the root", async () => {
  server(); const s = entry();
  const e = await s.binding.capture("R");
  expect(e).toMatchObject({ configuration: { type: "remote", url: RESOURCE, issuer: ISSUER }, integrationID: "static", connectionID: "static" });
  expect(await s.binding.token(e)).toBe(TOKEN);
  s.f.config.headers.Authorization = "Bearer run-token-NEXT-0123456789abcdef";
  expect(await error(s.binding.token(e))).toMatchObject({ code: "binding" });
  expect(s.drifts).toBe(1);
  expect(s.f.resolutions).toBe(0);
});

test("a 401 is terminal for the run: no retry, no host refresh, no reload, no native OAuth, and the token stays refused", async () => {
  server(); const s = entry();
  const e = await s.binding.capture("R");
  const token = await s.binding.token(e);
  // `login_required`: the Controller pauses on it with no retry and no refresh; only `expired` waits for a host refresh.
  const terminal = { code: "auth", reason: "login_required", message: `Signed out of grayboard in OpenCode; ${NEW_RUN}` };
  const refusal = await error(s.binding.unauthorized(e, token));
  expect(refusal).toBeInstanceOf(AccessExpired);
  expect(refusal).toMatchObject(terminal);
  expect(await error(s.binding.token(e))).toMatchObject(terminal);
  expect(await s.binding.refresh(e)).toBe(false);
  // Even an empty token (a 401 before any token was read) refuses rather than returning for a retry.
  expect(await error(s.binding.unauthorized(e, ""))).toMatchObject(terminal);
  expect(s.f.reloads).toBe(0);
  expect(s.f.resolutions).toBe(0);
});

test("the run token never lands in plugin storage, the enrollment, or any refusal text", async () => {
  server(); const s = entry();
  const e = await s.binding.capture("R");
  const texts: string[] = [JSON.stringify(e)];
  await s.binding.token(e);
  for (const p of [s.binding.unauthorized(e, TOKEN), s.binding.token(e)]) texts.push(String(((await error(p)) as Error).message));
  // A refused mode and a malformed entry name neither the token nor the header.
  texts.push(String(((await error(entry({ refused: "x" }).binding.capture("R"))) as Error).message));
  const bad = entry(); bad.f.config.headers["X-Grayboard-Identity"] = "fe";
  texts.push(String(((await error(bad.binding.capture("R"))) as Error).message));
  texts.push(JSON.stringify([...s.f.storage.entries()]));
  for (const text of texts) expect(text).not.toContain(TOKEN);
  expect([...s.f.storage.keys()]).toEqual(["rejectedAccess:static:static"]);
});
