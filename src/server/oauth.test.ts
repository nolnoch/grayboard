import { afterEach, beforeEach, expect, test } from "bun:test";
import { auth, Client, StreamableHTTPClientTransport, type OAuthClientProvider, type OAuthDiscoveryState, type StoredOAuthTokens } from "@modelcontextprotocol/client";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db.ts";
import { createOAuthServer, type OAuthPrincipal } from "./oauth.ts";
import { hashToken } from "./auth.ts";
import { OAUTH_TTL } from "./oauth-types.ts";
import type { Config } from "./config.ts";
import type { OAuthClient } from "./oauth-config.ts";
import { issueOAuth } from "../../tests/helpers/oauth.ts";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const random = () => randomBytes(32).toString("base64url");
const s256 = (s: string) => createHash("sha256").update(s).digest("base64url");
let dir: string, storage: ReturnType<typeof openDatabase>, service: ReturnType<typeof createOAuthServer>, server: ReturnType<typeof Bun.serve>;
let config: Config, base: string, clock: number, exchanges: number;
let mcp: ReturnType<typeof createMcpHandler>;
const liveClients: Client[] = [];
const registrations: OAuthClient[] = [
  { clientId: "native", name: "Native <client>", redirectUris: ["http://127.0.0.1/callback"], scopes: ["grayboard:tools"], tokenEndpointAuthMethod: "none", allowRefresh: true },
  { clientId: "subscriber", name: "Subscriber", redirectUris: ["http://127.0.0.1/callback"], scopes: ["grayboard:delivery", "grayboard:tools"], tokenEndpointAuthMethod: "none", allowRefresh: true },
  { clientId: "confidential:client", name: "Web", redirectUris: ["https://client.example/callback"], scopes: ["grayboard:tools"], tokenEndpointAuthMethod: "client_secret_basic", clientSecretHash: hashToken("secret:with+spaces "), allowRefresh: true },
];
function makeService(cimd?: import("./oauth-cimd.ts").CimdOptions) {
  return createOAuthServer(storage.repo, config, { now: () => clock, cimd,
    // Explicit fake upstream identity only; all downstream browser/code/token work is real HTTP + SQLite.
    exchangeGoogle: async input => {
      exchanges++;
      expect(input.nonce).toMatch(/^[\w-]{43}$/);
      expect(input.verifier).toMatch(/^[\w-]{43}$/);
      expect(input.redirectUri).toBe(base + "/oauth/google/callback");
      if (input.code !== "fake-google-code") throw new Error("fake rejection");
      return { email: "you@example.com", displayName: "You" };
    } });
}
beforeEach(() => {
  clock = Date.now(); exchanges = 0;
  dir = mkdtempSync(join(tmpdir(), "gb-oauth-http-"));
  storage = openDatabase(join(dir, "db.sqlite"), { blobDir: join(dir, "blobs") });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const handled = await service.fetch(req);
    if (handled) return handled;
    if (new URL(req.url).pathname !== "/mcp") return new Response(null, { status: 404 });
    const principal = service.authenticate(req);
    if (principal instanceof Response) return principal;
    return mcp.fetch(req);
  } });
  base = `http://127.0.0.1:${server.port}`;
  config = { dbPath: join(dir, "db.sqlite"), blobDir: join(dir, "blobs"), httpPort: 0, googleClientId: "fake-upstream", googleClientSecret: "", orgDomain: "example.com", publicUrl: base,
    devAuth: true, admins: [], messageRetentionDays: 90, auditRetentionDays: 90, oauthClients: registrations };
  service = makeService();
  mcp = createMcpHandler(({ requestInfo }) => {
    const principal = service.authenticate(requestInfo!);
    if (principal instanceof Response) throw new Error("unauthenticated");
    const s = new McpServer({ name: "oauth-fixture", version: "1" });
    s.registerTool("whoami", { description: "Fixture live OAuth principal" }, () => {
      if (!service.isAuthorized(principal)) throw new Error("unauthenticated");
      return { content: [{ type: "text", text: principal.authed.user_email }] };
    });
    return s;
  }, { legacy: "stateless" });
});
afterEach(async () => {
  await Promise.all(liveClients.splice(0).map(c => c.close()));
  await mcp.close(); service.close(); await server.stop(true); storage.db.close(); rmSync(dir, { recursive: true, force: true });
});
test("CIMD automatic registration uses one native grant and omitted resource stays bound through exchange/refresh/revocation", async () => {
  service.close(); config = { ...config, oauthClients: [] };
  const clientId = "https://opencode.ai/oauth/opencode/client.json";
  let reads = 0;
  service = makeService({ resolve: async () => [{ address: "93.184.216.34", family: 4 }], read: async () => { reads++; return JSON.stringify({ client_id: clientId, client_name: "OpenCode", redirect_uris: ["http://127.0.0.1/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] }); } });
  const metadata = await (await fetch(base + "/.well-known/oauth-authorization-server")).json();
  expect(metadata.client_id_metadata_document_supported).toBe(true);
  expect(metadata.registration_endpoint).toBeUndefined();
  const a = authorization(clientId, undefined, undefined, "grayboard:delivery grayboard:tools");
  const url = new URL(a.url); url.searchParams.delete("resource");
  const browser = new Browser();
  const consent = await loginConsent(browser, url.href);
  const approved = await decide(browser, consent);
  const callback = new URL(approved.headers.get("location")!);
  const params = { grant_type: "authorization_code", client_id: clientId, code: callback.searchParams.get("code")!, code_verifier: a.verifier, redirect_uri: a.redirectUri };
  expect((await post("/oauth/token", { ...params, resource: base + "/wrong" })).status).toBe(400);
  const exchanged = await post("/oauth/token", params); expect(exchanged.status).toBe(200);
  const tokens = await exchanged.json() as Tokens;
  expect(tokens.scope).toBe("grayboard:delivery grayboard:tools");
  const original = principal(tokens, ["grayboard:delivery", "grayboard:tools"]);
  expect(original.clientId).toBe(clientId);
  const refresh = { grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token };
  expect((await post("/oauth/token", { ...refresh, resource: base + "/wrong" })).status).toBe(400);
  const renewed = await post("/oauth/token", refresh); expect(renewed.status).toBe(200);
  const next = await renewed.json() as Tokens;
  expect(principal(next).grantId).toBe(original.grantId);
  expect(reads).toBe(1);
  expect((await post("/oauth/revoke", { client_id: clientId, token: next.refresh_token })).status).toBe(200);
  expect(service.authenticate(new Request(base + "/mcp", { headers: { Authorization: `Bearer ${next.access_token}` } }))).toBeInstanceOf(Response);
});

test("internal grant liveness survives individual access revocation but never authorizes that access", () => {
  const grant = issueOAuth(storage.repo, service.resource, "you@example.com", ["grayboard:delivery", "grayboard:tools"], clock);
  const request = new Request(service.resource, { headers: { Authorization: `Bearer ${grant.token}` } });
  const principal = service.authenticate(request);
  if (principal instanceof Response) throw new Error("expected fixture principal");
  expect(service.isGrantActive(grant.grantId)).toBe(true);
  storage.repo.oauth.revokeToken(grant.tokens.accessHash, grant.binding.clientId, clock);
  expect(service.isGrantActive(grant.grantId)).toBe(true);
  expect(service.isAuthorized(principal)).toBe(false);
  expect(service.authenticate(request)).toBeInstanceOf(Response);
  expect(service.isGrantActive("unknown")).toBe(false);
  const active = storage.repo.oauth.isGrantActive;
  storage.repo.oauth.isGrantActive = () => { throw new Error("storage unavailable"); };
  try { expect(() => service.isGrantActive(grant.grantId)).toThrow("storage unavailable"); }
  finally { storage.repo.oauth.isGrantActive = active; }
  storage.repo.users.setDisabled(grant.authed.user_id, true);
  expect(service.isGrantActive(grant.grantId)).toBe(false);
  storage.repo.users.setDisabled(grant.authed.user_id, false);
  expect(service.isGrantActive(grant.grantId)).toBe(false);
  const next = issueOAuth(storage.repo, service.resource, "you@example.com", ["grayboard:delivery"], clock);
  clock += OAUTH_TTL.grant;
  expect(service.isGrantActive(next.grantId)).toBe(false);
  service.close();
  expect(service.isGrantActive(grant.grantId)).toBe(false);
});

class Browser {
  jar = new Map<string, string>();
  get cookie() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "); }
  async request(url: string, init: RequestInit = {}) {
    const h = new Headers(init.headers);
    if (this.cookie) h.set("Cookie", this.cookie);
    const response = await fetch(url, { ...init, headers: h, redirect: "manual" });
    for (const value of response.headers.getSetCookie()) { const pair = value.split(";")[0]!; const i = pair.indexOf("="); this.jar.set(pair.slice(0, i), pair.slice(i + 1)); }
    return response;
  }
}
function authorization(clientId = "native", verifier = random(), redirectUri = "http://127.0.0.1:34567/callback", scope = "grayboard:tools") {
  const state = random();
  const url = base + "/oauth/authorize?" + new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", resource: service.resource,
    scope, state, code_challenge: s256(verifier), code_challenge_method: "S256" });
  return { url, verifier, state, clientId, redirectUri, scope };
}
async function loginConsent(browser: Browser, url: string) {
  const begin = await browser.request(url);
  expect(begin.status).toBe(303);
  let next = new URL(begin.headers.get("location")!);
  if (next.hostname === "accounts.google.com") {
    expect(next.searchParams.get("code_challenge_method")).toBe("S256");
    const callback = await browser.request(base + "/oauth/google/callback?" + new URLSearchParams({ state: next.searchParams.get("state")!, code: "fake-google-code" }));
    expect(callback.status).toBe(303);
    next = new URL(callback.headers.get("location")!);
  }
  const page = await browser.request(next.href);
  expect(page.status).toBe(200);
  const content = await page.text();
  return { request: /name="request" value="([^"]+)"/.exec(content)![1]!, csrf: /name="csrf" value="([^"]+)"/.exec(content)![1]!, content };
}
async function decide(browser: Browser, data: { request: string; csrf: string }, decision = "approve", origin = base) {
  return browser.request(base + "/oauth/consent", { method: "POST", headers: { Origin: origin }, body: new URLSearchParams({ request: data.request, csrf: data.csrf, decision }) });
}
async function issue(clientId = "native", scope = "grayboard:tools", browser = new Browser(), redirectUri?: string) {
  const a = authorization(clientId, undefined, redirectUri, scope);
  const consent = await loginConsent(browser, a.url);
  const response = await decide(browser, consent);
  expect(response.status).toBe(303);
  const callback = new URL(response.headers.get("location")!);
  expect(callback.searchParams.get("state")).toBe(a.state);
  expect(callback.searchParams.get("iss")).toBe(base);
  return { ...a, code: callback.searchParams.get("code")!, browser, consent };
}
function tokenParams(a: Awaited<ReturnType<typeof issue>>) {
  return { grant_type: "authorization_code", client_id: a.clientId, code: a.code, code_verifier: a.verifier, redirect_uri: a.redirectUri, resource: service.resource };
}
async function post(path: string, params: Record<string, string>, headers?: HeadersInit) {
  return fetch(base + path, { method: "POST", body: new URLSearchParams(params), headers });
}
type Tokens = { access_token: string; refresh_token: string; scope: string; expires_in: number; token_type: string };
async function redeem(a: Awaited<ReturnType<typeof issue>>) {
  const r = await post("/oauth/token", tokenParams(a)); expect(r.status).toBe(200); return await r.json() as Tokens;
}
function principal(tokens: Tokens, required?: string[]) {
  const p = service.authenticate(new Request(base + "/mcp", { headers: { Authorization: `Bearer ${tokens.access_token}` } }), required);
  expect(p).not.toBeInstanceOf(Response); return p as OAuthPrincipal;
}

test("direct config dev auth rejects either Google secret, including an override with an empty primary", () => {
  for (const credentials of [{ googleClientSecret: "primary-private" }, { mcpGoogle: { clientId: "web-client", clientSecret: "web-private" } }]) {
    expect(() => createOAuthServer(storage.repo, { ...config, ...credentials })).toThrow("dev auth must not coexist with a Google client secret");
  }
});

test("default Google exchange consistently selects the Web override or primary fallback and verifies its audience", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "mcp-web-config-fixture", alg: "RS256", use: "sig" };
  const originalFetch = globalThis.fetch;
  try {
    for (const mode of ["fallback", "override", "wrong-audience", "trusted-fixture"] as const) {
      service.close();
      const mcpGoogle = mode === "fallback" ? undefined : { clientId: "web-client", clientSecret: "web-private" };
      const cfg = { ...config, publicUrl: "https://grayboard.example.com:443/hosted", devAuth: false, googleClientId: "desktop-client", googleClientSecret: "desktop-private", mcpGoogle };
      let nonce = "", tokenCalls = 0, fixtureCalls = 0;
      const selected = mcpGoogle ?? { clientId: cfg.googleClientId, clientSecret: cfg.googleClientSecret };
      service = createOAuthServer(storage.repo, cfg, mode === "trusted-fixture" ? { exchangeGoogle: async input => {
        fixtureCalls++;
        expect(input.redirectUri).toBe(cfg.publicUrl + "/oauth/google/callback");
        expect(input.nonce).toBe(nonce);
        return { email: "you@example.com", displayName: "You" };
      } } : {});
      globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
        const req = new Request(input, init);
        if (req.url === "https://www.googleapis.com/oauth2/v3/certs") return Response.json({ keys: [jwk] });
        if (req.url !== "https://oauth2.googleapis.com/token") throw new Error("unexpected mocked network request");
        tokenCalls++;
        expect(req.method).toBe("POST");
        const body = new URLSearchParams(await req.text());
        expect(body.get("client_id")).toBe(selected.clientId);
        expect(body.get("client_secret")).toBe(selected.clientSecret);
        expect(body.get("redirect_uri")).toBe(cfg.publicUrl + "/oauth/google/callback");
        expect(body.get("code_verifier")).toMatch(/^[\w-]{43}$/);
        expect(body.get("code")).toBe("mock-google-code");
        const id_token = await new SignJWT({ hd: "example.com", email: "you@example.com", email_verified: true, nonce })
          .setProtectedHeader({ alg: "RS256", kid: jwk.kid }).setIssuer("https://accounts.google.com").setSubject("fixture-user")
          .setAudience(mode === "wrong-audience" ? cfg.googleClientId : selected.clientId).setIssuedAt().setExpirationTime("5m").sign(privateKey);
        return Response.json({ id_token });
      }, { preconnect: originalFetch.preconnect });
      let cookies = "";
      const direct = async (url: string, init: RequestInit = {}) => {
        const response = (await service.fetch(new Request(url, { ...init, headers: { Cookie: cookies, ...init.headers } })))!;
        if (response.headers.getSetCookie().length) cookies += response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ") + "; ";
        return response;
      };
      const a = authorization();
      const begin = await direct(cfg.publicUrl + "/oauth/authorize" + new URL(a.url).search);
      expect(begin.status).toBe(303);
      const upstream = new URL(begin.headers.get("Location")!);
      expect(upstream.searchParams.get("client_id")).toBe(selected.clientId);
      expect(upstream.searchParams.get("client_id")).not.toBe(a.clientId);
      expect(upstream.searchParams.get("redirect_uri")).toBe(cfg.publicUrl + "/oauth/google/callback");
      nonce = upstream.searchParams.get("nonce")!;
      expect(nonce).toMatch(/^[\w-]{43}$/);
      const callback = await direct(cfg.publicUrl + "/oauth/google/callback?" + new URLSearchParams({ state: upstream.searchParams.get("state")!, code: "mock-google-code", iss: "https://accounts.google.com" }));
      expect(callback.status).toBe(mode === "wrong-audience" ? 403 : 303);
      expect(tokenCalls).toBe(mode === "trusted-fixture" ? 0 : 1);
      expect(fixtureCalls).toBe(mode === "trusted-fixture" ? 1 : 0);
      if (mode !== "wrong-audience") {
        const consent = await direct(callback.headers.get("Location")!);
        expect(consent.status).toBe(200);
        expect(await consent.text()).toContain("you@example.com");
      } else expect(await callback.text()).not.toContain("private");
      const metadata = await direct("https://grayboard.example.com/.well-known/oauth-authorization-server/hosted");
      const text = await metadata.text();
      expect(text).not.toContain("web-private"); expect(text).not.toContain("desktop-private");
      expect(text).not.toContain("web-client"); expect(text).not.toContain("desktop-client");
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("real HTTP metadata uses configured canonical issuer including prefix/default port, never Host/Forwarded", async () => {
  service.close();
  service = createOAuthServer(storage.repo, { ...config, publicUrl: "https://grayboard.example.com:443/hosted", devAuth: false });
  const prm = await fetch(base + "/.well-known/oauth-protected-resource/hosted/mcp", { headers: { Host: "attacker.example", Forwarded: "host=attacker.example" } });
  expect(await prm.json()).toMatchObject({ resource: "https://grayboard.example.com/hosted/mcp", authorization_servers: ["https://grayboard.example.com:443/hosted"], scopes_supported: ["grayboard:delivery", "grayboard:tools"] });
  const metadata = await (await fetch(base + "/.well-known/oauth-authorization-server/hosted")).json() as Record<string, unknown>;
  expect(metadata).toMatchObject({ issuer: "https://grayboard.example.com:443/hosted", authorization_endpoint: "https://grayboard.example.com:443/hosted/oauth/authorize", authorization_response_iss_parameter_supported: true, token_endpoint_auth_methods_supported: ["none", "client_secret_basic"] });
  expect(metadata.registration_endpoint).toBeUndefined(); expect(metadata.jwks_uri).toBeUndefined();
  expect((await fetch(base + "/.well-known/openid-configuration")).status).toBe(404);
  const auth = service.authenticate(new Request(base + "/mcp"), ["grayboard:delivery"]) as Response;
  expect(auth.status).toBe(401); expect(auth.headers.get("WWW-Authenticate")).toContain('scope="grayboard:delivery"');
  expect(auth.headers.get("WWW-Authenticate")).not.toContain("offline_access");
  const dev = createOAuthServer(storage.repo, { ...config, publicUrl: "http://127.0.0.1:80/hosted" });
  expect(dev.issuer).toBe("http://127.0.0.1:80/hosted"); expect(dev.resource).toBe("http://127.0.0.1/hosted/mcp"); dev.close();
});

test("explicit consent and code survive service/database restart; distinct grants same user and live access revocation", async () => {
  const browser = new Browser();
  const a = await issue("native", "grayboard:tools", browser);
  expect(a.consent.content).toContain("Native &lt;client&gt;"); expect(a.consent.content).toContain("you@example.com");
  expect(a.consent.content).toContain(service.resource);
  expect((await decide(browser, a.consent)).status).toBe(400);
  const oldCookies = [...browser.jar];
  service.close(); storage.db.close();
  storage = openDatabase(config.dbPath, { blobDir: config.blobDir }); service = makeService();
  const tokens = await redeem(a); const p = principal(tokens);
  expect(p.authed.session_id).toBe(0); expect(tokens.expires_in).toBe(3600); expect(tokens.token_type).toBe("Bearer");
  const b = await issue("subscriber", "grayboard:delivery", browser);
  expect([...browser.jar]).toEqual(oldCookies); // persisted browser login, but fresh explicit consent
  expect(exchanges).toBe(1);
  const t2 = await redeem(b); const p2 = principal(t2, ["grayboard:delivery"]);
  expect(p.grantId).not.toBe(p2.grantId); expect(p.authed.user_id).toBe(p2.authed.user_id);
  const wrongScope = service.authenticate(new Request(base + "/mcp", { headers: { Authorization: `Bearer ${t2.access_token}` } })) as Response;
  expect(wrongScope.status).toBe(403); expect(wrongScope.headers.get("WWW-Authenticate")).toContain("insufficient_scope");
  expect((await post("/oauth/revoke", { client_id: "subscriber", token: tokens.access_token })).status).toBe(200);
  expect(service.isAuthorized(p)).toBe(true);
  expect((await post("/oauth/revoke", { client_id: "native", token: tokens.access_token })).status).toBe(200);
  expect(service.isAuthorized(p)).toBe(false); expect(service.isAuthorized(p2)).toBe(true);
  const refreshed = await post("/oauth/token", { client_id: "native", grant_type: "refresh_token", refresh_token: tokens.refresh_token, resource: service.resource });
  expect(refreshed.status).toBe(200);
  const t3 = await refreshed.json() as Tokens; expect(principal(t3).grantId).toBe(p.grantId);
  expect((await post("/oauth/revoke", { client_id: "native", token: t3.refresh_token })).status).toBe(200);
  expect(service.isAuthorized(principal(t2, ["grayboard:delivery"]))).toBe(true);
});

test("all code bindings checked before consume/replay, downscoping refresh retains original permission, strict replay kills winner", async () => {
  const a = await issue("subscriber", "grayboard:delivery grayboard:tools");
  const invalidBindings: Record<string, string>[] = [{ client_id: "native" }, { code_verifier: random() }, { resource: base + "/elsewhere" }, { redirect_uri: "http://127.0.0.1:34568/callback" }, { scope: "grayboard:tools" }, { scope: "offline_access" }, { code: random() }];
  for (const patch of invalidBindings) expect((await post("/oauth/token", { ...tokenParams(a), ...patch })).status).toBe(400);
  const tokens = await redeem(a), original = principal(tokens);
  expect((await post("/oauth/token", { ...tokenParams(a), code_verifier: random() })).status).toBe(400);
  expect(service.isAuthorized(original)).toBe(true);
  const refresh = { client_id: "subscriber", grant_type: "refresh_token", refresh_token: tokens.refresh_token, resource: service.resource };
  expect((await post("/oauth/token", { ...refresh, scope: "offline_access" })).status).toBe(400);
  const r = await post("/oauth/token", { ...refresh, scope: "grayboard:tools" }); expect(r.status).toBe(200);
  const narrow = await r.json() as Tokens; expect(narrow.scope).toBe("grayboard:tools"); expect(principal(narrow).grantId).toBe(original.grantId);
  expect((service.authenticate(new Request(base + "/mcp", { headers: { Authorization: `Bearer ${narrow.access_token}` } }), ["grayboard:delivery"]) as Response).status).toBe(403);
  const r2 = await post("/oauth/token", { ...refresh, refresh_token: narrow.refresh_token }); expect(r2.status).toBe(200);
  const full = await r2.json() as Tokens; expect(full.scope).toBe("grayboard:delivery grayboard:tools");
  expect((await post("/oauth/token", { ...refresh, client_id: "native" })).status).toBe(400);
  expect(service.isAuthorized(principal(full))).toBe(true);
  expect((await post("/oauth/token", refresh)).status).toBe(400);
  expect(service.isAuthorized(original)).toBe(false);
  expect((service.authenticate(new Request(base + "/mcp", { headers: { Authorization: `Bearer ${full.access_token}` } })) as Response).status).toBe(401);
  const b = await issue(); const t = await redeem(b); const pb = principal(t);
  expect((await post("/oauth/token", tokenParams(b))).status).toBe(400); expect(service.isAuthorized(pb)).toBe(false);
});

test("confidential Basic form decoding, mandatory PKCE, no mixed/post/query secrets", async () => {
  const a = await issue("confidential:client", "grayboard:tools", undefined, "https://client.example/callback");
  const params = tokenParams(a); delete (params as Partial<typeof params>).client_id;
  const encode = (s: string) => new URLSearchParams({ v: s }).toString().slice(2);
  const basic = "Basic " + Buffer.from(encode(a.clientId) + ":" + encode("secret:with+spaces ")).toString("base64");
  expect((await post("/oauth/token", params)).status).toBe(401);
  expect((await post("/oauth/token", { ...params, client_id: a.clientId }, { Authorization: basic })).status).toBe(401);
  expect((await post("/oauth/token", { ...params, client_secret: "secret:with+spaces " })).status).toBe(401);
  expect((await post("/oauth/token", params, { Authorization: "Basic " + Buffer.from("confidential%3Aclient:wrong").toString("base64") })).status).toBe(401);
  expect((await post("/oauth/token", { ...params, code_verifier: random() }, { Authorization: basic })).status).toBe(400);
  const r = await post("/oauth/token", { ...params, client_id: "", client_secret: "" }, { Authorization: basic }); expect(r.status).toBe(200);
  const tokens = await r.json() as Tokens;
  expect((await post("/oauth/revoke", { token: tokens.refresh_token }, { Authorization: basic })).status).toBe(200);
});

test("browser state, cookies, Origin, one-use CSRF, denial and restart invalidation", async () => {
  const browser = new Browser(), a = authorization();
  const begin = await browser.request(a.url); const google = new URL(begin.headers.get("location")!);
  const callback = base + "/oauth/google/callback?" + new URLSearchParams({ code: "fake-google-code", state: google.searchParams.get("state")! });
  expect((await fetch(callback, { redirect: "manual" })).status).toBe(400); expect(exchanges).toBe(0);
  expect((await browser.request(callback.replace(google.searchParams.get("state")!, random()))).status).toBe(400); expect(exchanges).toBe(0);
  const login = await browser.request(callback); expect(login.status).toBe(303);
  expect((await browser.request(callback)).status).toBe(400); expect(exchanges).toBe(1);
  const page = await browser.request(login.headers.get("location")!); const content = await page.text();
  const data = { request: /name="request" value="([^"]+)"/.exec(content)![1]!, csrf: /name="csrf" value="([^"]+)"/.exec(content)![1]! };
  expect(page.headers.get("Cache-Control")).toBe("no-store"); expect(page.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  expect((await decide(browser, data, "approve", "https://evil.example")).status).toBe(403);
  expect((await browser.request(base + "/oauth/consent", { method: "POST", body: new URLSearchParams({ ...data, decision: "approve" }) })).status).toBe(403);
  expect((await decide(browser, { ...data, csrf: random() })).status).toBe(400);
  expect((await decide(new Browser(), data)).status).toBe(400);
  expect((await browser.request(base + "/oauth/consent?request=" + data.request + "&decision=approve")).status).toBe(400);
  const denied = await decide(browser, data, "deny"); const deniedURL = new URL(denied.headers.get("location")!);
  expect(deniedURL.searchParams.get("error")).toBe("access_denied"); expect(deniedURL.searchParams.get("iss")).toBe(base); expect(deniedURL.searchParams.get("state")).toBe(a.state);
  expect((await decide(browser, data)).status).toBe(400);
  const next = await loginConsent(browser, authorization().url); service.close(); service = makeService();
  expect((await decide(browser, next)).status).toBe(400);
});

test("trusted authorization errors redirect with state/issuer; untrusted or ambiguous requests remain local", async () => {
  const a = authorization();
  a.state = "opaque + &=/ state";
  const original = new URL(a.url); original.searchParams.set("state", a.state); a.url = original.href;
  for (const [key, value, error] of [["resource", base + "/other", "invalid_target"], ["resource", "", "invalid_request"], ["scope", "grayboard:delivery", "invalid_scope"], ["scope", "offline_access", "invalid_scope"], ["scope", "", "invalid_scope"], ["code_challenge_method", "plain", "invalid_request"], ["code_challenge_method", "", "invalid_request"], ["code_challenge", "A", "invalid_request"], ["code_challenge", "", "invalid_request"], ["response_type", "token", "unsupported_response_type"], ["response_type", "", "invalid_request"]]) {
    const u = new URL(a.url); u.searchParams.set(key!, value!);
    const response = await fetch(u, { redirect: "manual" }); expect(response.status).toBe(303);
    const callback = new URL(response.headers.get("Location")!);
    expect(callback.origin + callback.pathname).toBe(a.redirectUri); expect(callback.searchParams.get("error")).toBe(error!);
    expect(callback.searchParams.get("state")).toBe(a.state); expect(callback.searchParams.get("iss")).toBe(base);
    expect([...callback.searchParams.keys()].sort()).toEqual(["error", "iss", "state"]);
  }
  for (const key of ["response_type", "code_challenge_method", "code_challenge", "scope"]) {
    const u = new URL(a.url); u.searchParams.delete(key);
    const response = await fetch(u, { redirect: "manual" }); expect(response.status).toBe(303);
    const callback = new URL(response.headers.get("Location")!);
    expect(callback.searchParams.get("error")).toBe(key === "scope" ? "invalid_scope" : "invalid_request");
    expect(callback.searchParams.get("state")).toBe(a.state); expect(callback.searchParams.get("iss")).toBe(base);
  }
  for (const key of ["client_id", "redirect_uri", "state"]) {
    for (const value of [null, "", ...(key === "client_id" ? ["https://unknown.example/client.json"] : key === "redirect_uri" ? ["https://evil.example/cb"] : [])]) {
      const u = new URL(a.url); value === null ? u.searchParams.delete(key) : u.searchParams.set(key, value);
      const r = await fetch(u, { redirect: "manual" }); expect(r.status).toBe(400); expect(r.headers.get("Location")).toBeNull();
    }
  }
  for (const suffix of ["&client_id=native", "&redirect_uri=" + encodeURIComponent(a.redirectUri), "&state=ambiguous", "&resource=" + encodeURIComponent(service.resource), "&x=%zz", "&x=%ff", "&x=%00", "&x=first&x=second", "&x=" + "x".repeat(9000)]) {
    const r = await fetch(a.url + suffix, { redirect: "manual" }); expect(r.status).toBe(400); expect(r.headers.get("Location")).toBeNull();
  }
  const code = await issue();
  const body = new URLSearchParams(tokenParams(code)).toString();
  expect((await fetch(base + "/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body + "&code=other" })).status).toBe(400);
  expect((await post("/oauth/token", tokenParams(code), { Origin: "https://foreign.example" })).status).toBe(403);
  expect((await post("/oauth/token?client_secret=raw", tokenParams(code))).status).toBe(400);
  expect((await fetch(base + "/oauth/token", { method: "POST", body: "x".repeat(17000), headers: { "Content-Type": "application/x-www-form-urlencoded" } })).status).toBe(400);
  const tokens = await redeem(code);
  for (const method of ["GET", "POST", "DELETE"]) expect((service.authenticate(new Request(base + "/mcp?access_token=" + tokens.access_token, { method, headers: { Authorization: `Bearer ${tokens.access_token}` } })) as Response).status).toBe(401);
});

test("authorization database failure remains local server_error, not a redirect error", async () => {
  storage.db.exec("CREATE TRIGGER reject_authorization BEFORE INSERT ON oauth_requests BEGIN SELECT RAISE(ABORT, 'injected secret'); END");
  const response = await fetch(authorization().url, { redirect: "manual" });
  expect(response.status).toBe(500); expect(response.headers.get("Location")).toBeNull(); expect(await response.json()).toEqual({ error: "server_error" });
  storage.db.exec("DROP TRIGGER reject_authorization");
});

test("bounded OAuth extensions are ignored, empty optional scope is omitted, and credentials remain strict", async () => {
  const browser = new Browser(), a = authorization("subscriber", undefined, undefined, "grayboard:delivery grayboard:tools");
  a.url += "&extension=not-a-binding&empty_extension=&audience=https%3A%2F%2Fevil.example&client_secret=&access_token=";
  const consent = await loginConsent(browser, a.url);
  expect((await browser.request(base + "/oauth/consent", { method: "POST", headers: { Origin: base }, body: new URLSearchParams({ request: consent.request, csrf: consent.csrf, decision: "approve", extension: "not-private" }) })).status).toBe(400);
  const stored = JSON.stringify(storage.db.query("SELECT data FROM oauth_requests").all());
  expect(stored).not.toContain("not-a-binding"); expect(stored).not.toContain("evil.example");
  const approved = await decide(browser, consent), callback = new URL(approved.headers.get("Location")!);
  expect(callback.searchParams.has("extension")).toBe(false); expect(callback.searchParams.get("state")).toBe(a.state);
  const code = { ...a, code: callback.searchParams.get("code")!, consent, browser };
  const body = new URLSearchParams(tokenParams(code)).toString();
  for (const suffix of ["&extension=%zz", "&extension=%ff", "&extension=%00", "&extension=x&extension=", "&extension=" + "x".repeat(4097), "&scope=&scope="]) {
    const r = await fetch(base + "/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body + suffix }); expect(r.status).toBe(400);
  }
  for (const query of ["extension=%ff", "extension=first&extension=", "extension=&extension=", "resource=" + encodeURIComponent(service.resource), "client_id=subscriber", "client_secret=nonempty"]) {
    expect((await post("/oauth/token?" + query, tokenParams(code))).status).toBe(400);
  }
  expect((await post("/oauth/token?extension=", { ...tokenParams(code), extension: "" })).status).toBe(400);
  for (const key of ["client_id", "code", "code_verifier", "redirect_uri", "resource", "grant_type"]) {
    const r = await post("/oauth/token", { ...tokenParams(code), [key]: "" }); expect(r.status).not.toBe(200);
  }
  for (const key of ["access_token", "client_secret"]) {
    const r = await post("/oauth/token", { ...tokenParams(code), [key]: "nonempty-credential" }); expect(r.status).not.toBe(200);
    const u = new URL(authorization().url); u.searchParams.set(key, "nonempty-credential");
    const response = await fetch(u, { redirect: "manual" }); expect(response.status).toBe(400); expect(response.headers.get("Location")).toBeNull();
  }
  const r = await post("/oauth/token?url_extension=ignored&empty_query=", { ...tokenParams(code), scope: "", extension: "not-a-binding", empty_extension: "", audience: "https://evil.example", client_secret: "", access_token: "" });
  expect(r.status).toBe(200); const tokens = await r.json() as Tokens; expect(tokens.scope).toBe("grayboard:delivery grayboard:tools");
  const refresh = { client_id: "subscriber", grant_type: "refresh_token", resource: service.resource, refresh_token: tokens.refresh_token, extension: "ignored" };
  const narrow = await post("/oauth/token?client_secret=&access_token=", { ...refresh, scope: "grayboard:tools" }); expect(narrow.status).toBe(200);
  const narrowed = await narrow.json() as Tokens;
  const restored = await post("/oauth/token", { ...refresh, refresh_token: narrowed.refresh_token, scope: "" }); expect(restored.status).toBe(200);
  const full = await restored.json() as Tokens; expect(full.scope).toBe("grayboard:delivery grayboard:tools");
  const p = principal(full);
  expect((await post("/oauth/revoke?url_extension=ignored&empty=", { client_id: "subscriber", token: full.refresh_token, token_type_hint: "", extension: "ignored", client_secret: "" })).status).toBe(200);
  expect(service.isAuthorized(p)).toBe(false);
  expect((await post("/oauth/revoke", { client_id: "subscriber", token: random(), extension: "ignored" })).status).toBe(200);
});

test("Google callback issuer hardening rejects mismatches before exchange or state consumption", async () => {
  const browser = new Browser(), a = authorization();
  const begin = await browser.request(a.url), google = new URL(begin.headers.get("Location")!);
  const callback = base + "/oauth/google/callback?" + new URLSearchParams({ state: google.searchParams.get("state")!, code: "fake-google-code" });
  for (const issuer of ["", "accounts.google.com", "https://accounts.google.com/", "https://evil.example"]) {
    expect((await browser.request(callback + "&iss=" + encodeURIComponent(issuer))).status).toBe(400); expect(exchanges).toBe(0);
  }
  expect((await browser.request(callback + "&iss=https%3A%2F%2Faccounts.google.com")).status).toBe(303);
  expect(exchanges).toBe(1);
});

test("fixed registered loopback ports allow another authorization port but code redemption binds the actual URI", async () => {
  service.close(); config = { ...config, oauthClients: registrations.map(c => c.clientId === "native" ? { ...c, redirectUris: ["http://127.0.0.1:8080/callback", "http://[::1]:8080/callback"] } : c) }; service = makeService();
  for (const redirectUri of ["http://127.0.0.1:45678/callback", "http://[::1]:45678/callback", "http://127.0.0.1:80/callback", "http://[::1]:80/callback"]) {
    const a = await issue("native", "grayboard:tools", undefined, redirectUri);
    for (const wrong of [redirectUri.replace(/:\d+\//, ":8080/"), redirectUri.replace(/:\d+\//, ":45679/")]) expect((await post("/oauth/token", { ...tokenParams(a), redirect_uri: wrong })).status).toBe(400);
    const tokens = await redeem(a); expect(principal(tokens).clientId).toBe("native");
  }
});

test("live disable/admin revoke, expiry, and database failures are not credential errors or false success", async () => {
  const a = await issue(), tokens = await redeem(a), p = principal(tokens);
  clock += OAUTH_TTL.access;
  expect(service.isAuthorized(p)).toBe(false);
  const refreshed = await post("/oauth/token", { client_id: "native", grant_type: "refresh_token", refresh_token: tokens.refresh_token, resource: service.resource });
  const next = await refreshed.json() as Tokens; const np = principal(next);
  storage.repo.users.setDisabled(np.authed.user_id, true); storage.repo.users.setDisabled(np.authed.user_id, false);
  expect(service.isAuthorized(np)).toBe(false);
  const b = await issue(), t2 = await redeem(b), p2 = principal(t2);
  storage.repo.sessions.revokeAllForUser(p2.authed.user_id); expect(service.isAuthorized(p2)).toBe(false);
  const c = await issue(), t3 = await redeem(c);
  storage.db.exec("CREATE TRIGGER reject_revoke BEFORE UPDATE ON oauth_grants BEGIN SELECT RAISE(ABORT, 'injected'); END");
  const failed = await post("/oauth/revoke", { client_id: "native", token: t3.refresh_token });
  expect(failed.status).toBe(500); expect(await failed.json()).toEqual({ error: "server_error" });
  storage.db.exec("DROP TRIGGER reject_revoke");
  for (const token of [t3.refresh_token, t3.refresh_token, random()]) expect((await post("/oauth/revoke", { client_id: "native", token })).status).toBe(200);
  const d = await issue(); storage.db.exec("CREATE TRIGGER reject_token BEFORE INSERT ON oauth_tokens BEGIN SELECT RAISE(ABORT, 'injected'); END");
  const failure = await post("/oauth/token", tokenParams(d)); expect(failure.status).toBe(500); expect(await failure.json()).toEqual({ error: "server_error" });
  storage.db.exec("DROP TRIGGER reject_token"); expect((await post("/oauth/token", tokenParams(d))).status).toBe(200);
});

test("hash-only browser/code/token persistence and HTTP expiry clamps use actual absolute grant deadline", async () => {
  const a = await issue(), tokens = await redeem(a), p = principal(tokens);
  const persisted = () => JSON.stringify(["oauth_requests", "oauth_browsers", "oauth_codes", "oauth_grants", "oauth_tokens"].map(table => storage.db.query(`SELECT * FROM ${table}`).all()));
  const records = persisted();
  for (const raw of [a.code, a.state, a.verifier, a.consent.csrf, ...a.browser.jar.values(), tokens.access_token, tokens.refresh_token]) expect(records).not.toContain(raw);
  let current = tokens;
  for (let i = 0; i < 3; i++) {
    clock += 29 * 24 * 60 * 60_000;
    const r = await post("/oauth/token", { client_id: "native", grant_type: "refresh_token", refresh_token: current.refresh_token, resource: service.resource });
    expect(r.status).toBe(200); current = await r.json() as Tokens;
  }
  clock = Number(storage.db.query<{ expires_at: number }, [string]>("SELECT expires_at FROM oauth_grants WHERE id = ?").get(p.grantId)!.expires_at) - 1000;
  const r = await post("/oauth/token", { client_id: "native", grant_type: "refresh_token", refresh_token: current.refresh_token, resource: service.resource });
  expect(r.status).toBe(200); current = await r.json() as Tokens; expect(current.expires_in).toBe(1);
  const last = principal(current); clock += 1000; expect(service.isAuthorized(last)).toBe(false);
  expect((await post("/oauth/token", { client_id: "native", grant_type: "refresh_token", refresh_token: current.refresh_token, resource: service.resource })).status).toBe(400);
  const b = await issue(), t = await redeem(b), pb = principal(t); clock += OAUTH_TTL.code;
  expect((await post("/oauth/token", tokenParams(b))).status).toBe(400); expect(service.isAuthorized(pb)).toBe(false);
});

test("HTTP concurrent code/refresh consumes have one winner and committed strict replay revocation", async () => {
  const a = await issue();
  const codes = await Promise.all([post("/oauth/token", tokenParams(a)), post("/oauth/token", tokenParams(a))]);
  expect(codes.map(r => r.status).sort()).toEqual([200, 400]);
  const winner = await codes.find(r => r.status === 200)!.json() as Tokens;
  expect((service.authenticate(new Request(base + "/mcp", { headers: { Authorization: `Bearer ${winner.access_token}` } })) as Response).status).toBe(401);
  const b = await issue(), tokens = await redeem(b);
  const p = { grant_type: "refresh_token", client_id: "native", refresh_token: tokens.refresh_token, resource: service.resource };
  const refreshes = await Promise.all([post("/oauth/token", p), post("/oauth/token", p)]);
  expect(refreshes.map(r => r.status).sort()).toEqual([200, 400]);
  const refreshed = await refreshes.find(r => r.status === 200)!.json() as Tokens;
  expect((service.authenticate(new Request(base + "/mcp", { headers: { Authorization: `Bearer ${refreshed.access_token}` } })) as Response).status).toBe(401);
});

test("expired upstream/consent/code never mints; browser pending capacity and trusted address rate limits bounded", async () => {
  const browser = new Browser(); const a = authorization();
  const r = await browser.request(a.url), google = new URL(r.headers.get("location")!);
  clock += OAUTH_TTL.request;
  expect((await browser.request(base + "/oauth/google/callback?" + new URLSearchParams({ state: google.searchParams.get("state")!, code: "fake-google-code" }))).status).toBe(400);
  expect(exchanges).toBe(0);
  const data = await loginConsent(browser, authorization().url); clock += OAUTH_TTL.request;
  expect((await decide(browser, data)).status).toBe(400);
  const code = await issue(); clock += OAUTH_TTL.code;
  expect((await post("/oauth/token", tokenParams(code))).status).toBe(400);
  const pending = new Browser();
  for (let i = 0; i < 10; i++) expect((await pending.request(authorization().url)).status).toBe(303);
  expect((await pending.request(authorization().url)).status).toBe(429);
  const request = new Request(base + "/oauth/unknown", { headers: { "X-Real-IP": "attacker", Forwarded: "for=attacker" } });
  for (let i = 0; i < 60; i++) expect((await service.fetch(request, { remoteAddress: "socket-peer" }))!.status).toBe(405);
  expect((await service.fetch(request, { remoteAddress: "socket-peer" }))!.status).toBe(429);
  clock += 60_000;
  expect((await service.fetch(request, { remoteAddress: "socket-peer" }))!.status).toBe(405);
});

test("remote registered callback is escaped display-only with no assets or token redemption; production cookies are secure", async () => {
  service.close();
  const publicUrl = "https://grayboard.example.com:443/hosted";
  service = createOAuthServer(storage.repo, { ...config, publicUrl, devAuth: false });
  const p = new URLSearchParams({ client_id: "native", redirect_uri: "http://127.0.0.1:34567/callback", response_type: "code", resource: service.resource,
    scope: "grayboard:tools", state: random(), code_challenge: s256(random()), code_challenge_method: "S256" });
  const start = await fetch(base + "/hosted/oauth/authorize?" + p, { redirect: "manual" });
  expect(start.status).toBe(303);
  const cookie = start.headers.get("Set-Cookie")!;
  for (const part of ["__Secure-gb_oauth_binding=", "HttpOnly", "SameSite=Lax", "Secure", "Path=/hosted/oauth"]) expect(cookie).toContain(part);
  const callback = await fetch(base + "/hosted/oauth/callback/complete?" + new URLSearchParams({ code: "<script>alert(1)</script>", state: random(), iss: publicUrl }));
  expect(callback.status).toBe(200); expect(callback.headers.get("Cache-Control")).toBe("no-store");
  expect(callback.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(callback.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
  const body = await callback.text(); expect(body).not.toContain("<script>"); expect(body).not.toContain("access_token"); expect(body).not.toContain("<form");
  expect((await fetch(base + "/oauth/callback/complete?" + new URLSearchParams({ code: random(), state: random(), iss: "https://evil.example" }))).status).toBe(400);
  expect(storage.db.query("SELECT * FROM oauth_tokens").all()).toHaveLength(0);
  expect(() => createOAuthServer(storage.repo, { ...config, devAuth: false })).toThrow();
  expect(() => createOAuthServer(storage.repo, { ...config, googleClientSecret: "real-secret" })).toThrow();
});

class Provider implements OAuthClientProvider {
  redirectUrl = "http://127.0.0.1:34567/callback";
  clientMetadata = { client_name: "Native", redirect_uris: [this.redirectUrl], token_endpoint_auth_method: "none" as const };
  saved?: StoredOAuthTokens; verifier = ""; authorization?: URL; discovery?: OAuthDiscoveryState;
  stateValue = random();
  state() { return this.stateValue; }
  clientInformation() { return { client_id: "subscriber", issuer: base }; }
  tokens() { return this.saved; }
  saveTokens(t: StoredOAuthTokens) { this.saved = t; }
  redirectToAuthorization(url: URL) { this.authorization = url; }
  saveCodeVerifier(v: string) { this.verifier = v; }
  codeVerifier() { return this.verifier; }
  saveDiscoveryState(d: OAuthDiscoveryState) { this.discovery = d; }
  discoveryState() { return this.discovery; }
}
test("official SDK binds one canonical default-port resource while preserving exact configured issuer and iss", async () => {
  const publicUrl = "https://grayboard.example.com:443/hosted";
  service.close();
  service = createOAuthServer(storage.repo, { ...config, publicUrl, devAuth: false }, { now: () => clock, exchangeGoogle: async input => {
    expect(input.redirectUri).toBe(publicUrl + "/oauth/google/callback"); return { email: "you@example.com", displayName: "You" };
  } });
  expect(service.resource).toBe("https://grayboard.example.com/hosted/mcp"); expect(service.issuer).toBe(publicUrl);
  const mapURL = (url: string) => { const u = new URL(url); expect(u.origin).toBe("https://grayboard.example.com"); return base + u.pathname + u.search; };
  const fetchFn = (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init); return fetch(new Request(mapURL(req.url), req));
  };
  class PrefixProvider extends Provider { override clientInformation() { return { client_id: "subscriber", issuer: publicUrl }; } }
  const provider = new PrefixProvider();
  expect(await auth(provider, { serverUrl: service.resource, fetchFn })).toBe("REDIRECT");
  expect(provider.authorization!.searchParams.get("resource")).toBe(service.resource);
  const alternate = new URL(provider.authorization!.href); alternate.searchParams.set("resource", publicUrl + "/mcp");
  const invalidAudience = await fetch(mapURL(alternate.href), { redirect: "manual" });
  const audienceError = new URL(invalidAudience.headers.get("Location")!);
  expect(audienceError.searchParams.get("error")).toBe("invalid_target"); expect(audienceError.searchParams.get("iss")).toBe(publicUrl);
  const browser = new Browser(), begin = await browser.request(mapURL(provider.authorization!.href));
  const google = new URL(begin.headers.get("Location")!);
  const callback = await browser.request(mapURL(publicUrl + "/oauth/google/callback?" + new URLSearchParams({ code: "fake-google-code", state: google.searchParams.get("state")!, iss: "https://accounts.google.com" })));
  expect(callback.status).toBe(303);
  const page = await browser.request(mapURL(callback.headers.get("Location")!)), content = await page.text();
  const data = { request: /name="request" value="([^"]+)"/.exec(content)![1]!, csrf: /name="csrf" value="([^"]+)"/.exec(content)![1]! };
  const approved = await browser.request(base + "/hosted/oauth/consent", { method: "POST", headers: { Origin: "https://grayboard.example.com" }, body: new URLSearchParams({ ...data, decision: "approve" }) });
  const returned = new URL(approved.headers.get("Location")!);
  expect(returned.searchParams.get("iss")).toBe(publicUrl); expect(returned.searchParams.get("state")).toBe(provider.stateValue);
  const wrongResource = await post("/oauth/token", { grant_type: "authorization_code", client_id: "subscriber", code: returned.searchParams.get("code")!, code_verifier: provider.verifier, redirect_uri: provider.redirectUrl, resource: publicUrl + "/mcp" });
  expect(wrongResource.status).toBe(400);
  await expect(auth(provider, { serverUrl: service.resource, fetchFn, authorizationCode: returned.searchParams.get("code")!, iss: new URL(publicUrl).href })).rejects.toThrow();
  expect(await auth(provider, { serverUrl: service.resource, fetchFn, authorizationCode: returned.searchParams.get("code")!, iss: publicUrl })).toBe("AUTHORIZED");
  expect(provider.saved!.issuer).toBe(publicUrl); expect(principal(provider.saved as Tokens).clientId).toBe("subscriber");
});

for (const version of ["2026-07-28", "2025-11-25"]) test(`${version} official SDK preregistered PRM/discovery/S256/iss/code/refresh and real MCP fixture`, async () => {
  const provider = new Provider();
  expect(await auth(provider, { serverUrl: service.resource })).toBe("REDIRECT");
  expect(provider.authorization!.searchParams.get("resource")).toBe(service.resource);
  expect(provider.authorization!.searchParams.get("scope")).toBe("grayboard:delivery grayboard:tools");
  const browser = new Browser(); const data = await loginConsent(browser, provider.authorization!.href);
  const response = await decide(browser, data); const callback = new URL(response.headers.get("location")!);
  expect(callback.searchParams.get("state")).toBe(provider.stateValue);
  await expect(auth(provider, { serverUrl: service.resource, authorizationCode: callback.searchParams.get("code")!, iss: base + "/wrong" })).rejects.toThrow();
  await expect(auth(provider, { serverUrl: service.resource, authorizationCode: callback.searchParams.get("code")! })).rejects.toThrow();
  expect(await auth(provider, { serverUrl: service.resource, authorizationCode: callback.searchParams.get("code")!, iss: callback.searchParams.get("iss")! })).toBe("AUTHORIZED");
  const before = provider.saved!;
  expect(await auth(provider, { serverUrl: service.resource })).toBe("AUTHORIZED");
  expect(provider.saved!.refresh_token).not.toBe(before.refresh_token);
  const client = new Client({ name: "oauth-fixture-client", version: "1" }, { supportedProtocolVersions: [version], versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" } });
  liveClients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(service.resource), { authProvider: provider }));
  expect((await client.listTools()).tools.map(t => t.name)).toEqual(["whoami"]);
  expect((await client.callTool({ name: "whoami", arguments: {} })).content).toEqual([{ type: "text", text: "you@example.com" }]);
  expect((await post("/oauth/revoke", { client_id: "native", token: provider.saved!.refresh_token! })).status).toBe(200);
});
