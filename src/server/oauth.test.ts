import { DEFAULT_HELLO_LIMIT, DEFAULT_AUTH_FAIL_LIMIT } from "./rate_limit.ts";
import { DEFAULT_TRUSTED_PROXIES } from "./client_addr.ts";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { auth, Client, StreamableHTTPClientTransport, type OAuthClientProvider, type OAuthDiscoveryState, type StoredOAuthTokens } from "@modelcontextprotocol/client";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db.ts";
import { queueFor } from "./store/queue.ts";
import { until } from "../../tests/support/until.ts";
import { createOAuthServer, type OAuthPrincipal } from "./oauth.ts";
import { hashToken, verifySessionToken } from "./auth.ts";
import { OAUTH_TTL } from "./oauth-types.ts";
import type { Config, IdpId } from "./config.ts";
import { BUILTIN_CLIENT_IDS, CLI_CLIENT_ID, LOGIN_SCOPE, OAUTH_SCOPES, OPENCODE_CLIENT, parseOAuthClients, type OAuthClient } from "./oauth-config.ts";
import { GRAYBOARD_SESSION_META } from "../shared/session_meta.ts";
import { issueOAuth } from "../../tests/helpers/oauth.ts";
import { seed } from "../../tests/support/seed.ts";
import { Browser, consentForm, submitConsent } from "../../tests/support/oauth_browser.ts";
import { accessAudits } from "../../tests/support/audit.ts";
import { stubProvider } from "../../tests/support/stub_provider.ts";
import { GOOGLE_ISSUER } from "./idp_google.ts";
import { DomainRefused } from "./idp.ts";
import { REFUSED } from "./oauth.ts";
import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from "jose";
import { stubAuthRead } from "../../tests/support/auth_stub.ts";

const random = () => randomBytes(32).toString("base64url");
// One signing key for every test that mocks Google's JWKS: the default provider's key set (idp_google.ts) is
// module-level and cached across tests, so a second key would be unknown inside jose's refetch cooldown.
let googleKeyPair: Promise<{ jwk: JWK & { kid: string }; privateKey: KeyLike }> | undefined;
const googleKey = () => googleKeyPair ??= generateKeyPair("RS256").then(async ({ publicKey, privateKey }) =>
  ({ jwk: { ...await exportJWK(publicKey), kid: "google-fixture", alg: "RS256", use: "sig" }, privateKey }));
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
    providers: [stubProvider(async input => {
      exchanges++;
      expect(input.nonce).toMatch(/^[\w-]{43}$/);
      expect(input.verifier).toMatch(/^[\w-]{43}$/);
      expect(input.redirectUri).toBe(base + "/oauth/google/callback");
      if (input.code !== "fake-google-code") throw new Error("fake rejection");
      return { email: "you@example.com", displayName: "You", subject: "google-you@example.com" };
    })] });
}
beforeEach(() => {
  clock = Date.now(); exchanges = 0;
  dir = mkdtempSync(join(tmpdir(), "gb-oauth-http-"));
  storage = openDatabase(join(dir, "db.sqlite"), { blobDir: join(dir, "blobs") });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const handled = await service.fetch(req);
    if (handled) return handled;
    if (new URL(req.url).pathname !== "/mcp") return new Response(null, { status: 404 });
    const principal = await service.authenticate(req);
    if (principal instanceof Response) return principal;
    return mcp.fetch(req);
  } });
  base = `http://127.0.0.1:${server.port}`;
  config = { dbPath: join(dir, "db.sqlite"), blobDir: join(dir, "blobs"), httpPort: 0, googleClientId: "fake-upstream", googleClientSecret: "", orgDomain: "example.com", publicUrl: base,
    devAuth: true, admins: [], helloLimit: DEFAULT_HELLO_LIMIT, authFailLimit: DEFAULT_AUTH_FAIL_LIMIT, trustedProxies: DEFAULT_TRUSTED_PROXIES, messageRetentionDays: 90, auditRetentionDays: 90, oauthClients: registrations,
    oauthCimdClients: [OPENCODE_CLIENT, "https://client.example/metadata.json", "https://client.example/client.json"] };
  service = makeService();
  mcp = createMcpHandler(async ({ requestInfo }) => {
    const principal = await service.authenticate(requestInfo!);
    if (principal instanceof Response) throw new Error("unauthenticated");
    const s = new McpServer({ name: "oauth-fixture", version: "1" });
    s.registerTool("whoami", { description: "Fixture live OAuth principal" }, async () => {
      if (!await service.isAuthorized(principal)) throw new Error("unauthenticated");
      return { content: [{ type: "text", text: principal.authed.user_email }] };
    });
    return s;
  }, { legacy: "stateless" });
});
afterEach(async () => {
  await Promise.all(liveClients.splice(0).map(c => c.close()));
  await mcp.close(); service.close(); await server.stop(true); storage.db.close(); rmSync(dir, { recursive: true, force: true });
});
for (const kind of ["multiline", "getter", "proxy"] as const) test(`OAuth limiter sweep safely retries failed end audit: ${kind}`, async () => {
  service.close(); config.oauthLimit = { burst: 1, perSec: 1 };
  const callbacks: (() => void)[] = [], interval = globalThis.setInterval;
  const timers = spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms: number, ...args: unknown[]) => {
    if (ms === 60000) callbacks.push(fn);
    return interval(fn, ms, ...args);
  }) as typeof setInterval);
  try { service = makeService(); } finally { timers.mockRestore(); }
  await storage.repo.write(() => {}); // startup's async revocation writes hold the queue; the tick below runs once they're done
  const request = new Request(base + "/oauth/unknown");
  const key = "PRIVATE-ADDRESS";
  expect((await service.fetch(request, { key }))!.status).toBe(405);
  expect((await service.fetch(request, { key }))!.status).toBe(429);
  clock += 2000;
  let reads = 0;
  const fault = kind === "multiline" ? new Error("Bearer PRIVATE\n at f (/private/refresh-token.ts:1:1)", { cause: "PRIVATE-CODE" }) : kind === "getter" ? Object.defineProperty(new Error(), "message", { get() { reads++; throw new Error("PRIVATE"); } }) : new Proxy({}, { get() { reads++; throw new Error("PRIVATE"); } });
  const write = storage.repo.audit.write;
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    storage.repo.audit.write = () => { throw fault; };
    expect(callbacks.at(-1)!).not.toThrow();
    expect(reads).toBe(0);
    expect(log.mock.calls).toEqual([[`[grayboard] {"operation":"rate_limit.end","category":"failure","level":"error","class":"${kind === "proxy" ? "non-error" : "Error"}"}`]]);
    await storage.repo.write(() => {}); // the tick's async cleanup holds the queue; the retry runs once it's done
    storage.repo.audit.write = write;
    callbacks.at(-1)!(); callbacks.at(-1)!();
    const ended = storage.db.query<{ detail: string }, []>("SELECT detail FROM access_log WHERE action='oauth.rate_limit_ended'").all();
    expect(ended).toHaveLength(1);
    expect(JSON.parse(ended[0]!.detail)).toMatchObject({ refused: 1 });
    expect(log.mock.calls).toHaveLength(1);
  } finally { storage.repo.audit.write = write; log.mockRestore(); }
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
  const original = await principal(tokens, ["grayboard:delivery", "grayboard:tools"]);
  expect(original.clientId).toBe(clientId);
  const refresh = { grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token };
  expect((await post("/oauth/token", { ...refresh, resource: base + "/wrong" })).status).toBe(400);
  const renewed = await post("/oauth/token", refresh); expect(renewed.status).toBe(200);
  const next = await renewed.json() as Tokens;
  expect((await principal(next)).grantId).toBe(original.grantId);
  expect(reads).toBe(1);
  expect((await post("/oauth/revoke", { client_id: clientId, token: next.refresh_token })).status).toBe(200);
  expect(await service.authenticate(new Request(base + "/mcp", { headers: { Authorization: `Bearer ${next.access_token}` } }))).toBeInstanceOf(Response);
});

test("internal grant liveness survives individual access revocation but never authorizes that access", async () => {
  const grant = await issueOAuth(storage.repo, service.resource, "you@example.com", ["grayboard:delivery", "grayboard:tools"], clock);
  const request = new Request(service.resource, { headers: { Authorization: `Bearer ${grant.token}` } });
  const principal = await service.authenticate(request);
  if (principal instanceof Response) throw new Error("expected fixture principal");
  expect(await service.isGrantActive(grant.grantId)).toBe(true);
  await seed(storage.repo, tx => storage.repo.oauth.revokeToken(tx, grant.tokens.accessHash, grant.binding.clientId, clock));
  expect(await service.isGrantActive(grant.grantId)).toBe(true);
  expect(await service.isAuthorized(principal)).toBe(false);
  expect(await service.authenticate(request)).toBeInstanceOf(Response);
  expect(await service.isGrantActive("unknown")).toBe(false);
  const restoreIsGrantActive = stubAuthRead(storage.repo, "isGrantActive", active => () => { throw new Error("storage unavailable"); });
  try { await expect(service.isGrantActive(grant.grantId)).rejects.toThrow("storage unavailable"); }
  finally { restoreIsGrantActive(); }
  await seed(storage.repo, tx => storage.repo.users.setDisabled(tx, grant.authed.user_id, true));
  expect(await service.isGrantActive(grant.grantId)).toBe(false);
  await seed(storage.repo, tx => storage.repo.users.setDisabled(tx, grant.authed.user_id, false));
  expect(await service.isGrantActive(grant.grantId)).toBe(false);
  const next = await issueOAuth(storage.repo, service.resource, "you@example.com", ["grayboard:delivery"], clock);
  clock += OAUTH_TTL.grant;
  expect(await service.isGrantActive(next.grantId)).toBe(false);
  service.close();
  expect(await service.isGrantActive(grant.grantId)).toBe(false);
});

// #807 P3 A7u2: peekAuthorized answers from the auth cache alone. A live token whose user isn't cached under the same
// generation is a miss (the caller checks in full), and nothing is read; a cached user that is disabled or gone refuses.
test("peekAuthorized is a miss on a token hit whose user isn't cached, reads no user, and refuses a disabled or gone one", async () => {
  const grant = await issueOAuth(storage.repo, service.resource, "you@example.com", ["grayboard:tools"], clock);
  const p = await service.authenticate(new Request(service.resource, { headers: { Authorization: `Bearer ${grant.token}` } }));
  if (p instanceof Response) throw new Error("expected fixture principal");
  const query = spyOn(Database.prototype, "query");
  const userReads = () => query.mock.calls.filter(([sql]) => String(sql) === "SELECT * FROM users WHERE id = ?").length;
  try {
    // authenticate filled the token and its user under one generation.
    expect(service.peekAuthorized(p, storage.repo.authPeek()!)).toBe(true);
    // A new generation, then the token alone: its user is a miss.
    await seed(storage.repo, tx => storage.repo.users.setDisabled(tx, grant.authed.user_id, false));
    expect(await storage.repo.oauth.findActiveAccess(storage.repo.read, p.accessHash, service.resource, [], clock)).toBeDefined();
    expect(service.peekAuthorized(p, storage.repo.authPeek()!)).toBeUndefined();
    expect(userReads()).toBe(0);
  } finally { query.mockRestore(); }
  const user = (await storage.repo.users.findById(storage.repo.read, grant.authed.user_id))!;
  const access = (await storage.repo.oauth.findActiveAccess(storage.repo.read, p.accessHash, service.resource, [], clock))!;
  const peek = (u: typeof user | null) => ({ generation: "g", access: () => access, user: () => u });
  expect(service.peekAuthorized(p, peek(user))).toBe(true);
  expect(service.peekAuthorized(p, peek({ ...user, disabled_at: clock }))).toBe(false);
  expect(service.peekAuthorized(p, peek(null))).toBe(false);
});

test("CIMD refuses every issuer-origin redirect before creating a phishing flow", async () => {
  const clientId = "https://client.example/metadata.json";
  for (const path of ["/oauth/callback/complete", "/other", "/oauth/google/callback"]) {
    service.close();
    const redirectUri = base + path;
    service = makeService({ resolve: async () => [{ address: "8.8.8.8", family: 4 }], read: async () => JSON.stringify({ client_id: clientId, client_name: "OpenCode", redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }) });
    const a = authorization(clientId, undefined, redirectUri);
    const response = await fetch(a.url, { redirect: "manual" });
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(storage.db.query("SELECT count(*) AS n FROM oauth_requests").get()).toEqual({ n: 0 });
    expect(exchanges).toBe(0);
  }
});

test("CIMD consent heads with the client host, quotes the self-declared name escaped, escapes it, and permits only its validated callback origin", async () => {
  service.close();
  const clientId = "https://client.example/metadata.json";
  service = makeService({ resolve: async () => [{ address: "8.8.8.8", family: 4 }], read: async () => JSON.stringify({ client_id: clientId, client_name: '<img src=x onerror="alert(1)">', redirect_uris: ["http://127.0.0.1/callback"], token_endpoint_auth_method: "none" }) });
  const a = authorization(clientId);
  const browser = new Browser();
  const consent = await loginConsent(browser, a.url);
  // The verified host heads the page; the document's name is only quoted as its claim (F-16).
  expect(consent.content).toContain("<h1>Authorize client.example</h1>");
  expect(consent.content).toContain("This client calls itself &lt;img");
  expect(consent.content).toContain("&lt;img");
  expect(consent.content).not.toContain("<img");
  const page = await browser.request(base + "/oauth/consent?request=" + consent.request);
  expect(page.headers.get("Referrer-Policy")).toBe("same-origin");
  expect(page.headers.get("Content-Security-Policy")).toBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' http://127.0.0.1:34567");
  expect((await decide(browser, consent, "approve", "null")).status).toBe(403);
  expect((await decide(browser, consent)).status).toBe(303);
});

for (const ending of ["expires", "is swept"] as const) test(`a consent page whose flow ${ending} while its store reads await refuses (#807 P3 A6c)`, async () => {
  service.close();
  const interval = spyOn(globalThis, "setInterval");
  service = makeService();
  const tick = interval.mock.calls[0]![0] as () => void;
  interval.mockRestore();
  const browser = new Browser();
  const consent = await loginConsent(browser, authorization().url);
  const bind = storage.repo.oauth.bindRequestSession;
  const log = spyOn(console, "error").mockImplementation(() => {});
  // Between the binding's read and consent's use of the flow, the flow lapses and, in the second case, the sweep drops
  // it. The tick runs inside consent's transaction, so its cleanup write is refused and logged; production's timer
  // never ticks inside one.
  storage.repo.oauth.bindRequestSession = async (...a) => {
    const out = await bind(...a);
    clock += OAUTH_TTL.request;
    if (ending === "is swept") tick();
    return out;
  };
  try {
    expect((await browser.request(base + "/oauth/consent?request=" + consent.request)).status).toBe(400);
    if (ending === "is swept") await until(() => log.mock.calls.length > 0, 5000, "the refused sweep write is logged");
    expect(log.mock.calls.flat()).toEqual(ending === "is swept" ? ['[grayboard] {"operation":"oauth.sweep","category":"failure","level":"error","class":"Error"}'] : []);
  } finally { storage.repo.oauth.bindRequestSession = bind; log.mockRestore(); }
});

test("an upstream sign-in whose flow lapses while its request row is read refuses, sending nobody upstream (#807 P3 A6c)", async () => {
  service.close();
  service = createOAuthServer(storage.repo, config, { now: () => clock, providers: [stubProvider(async () => { throw new Error("unused"); }), stubProvider(async () => { throw new Error("unused"); }, undefined, { id: "okta", label: "Okta" })] });
  const browser = new Browser();
  const begin = await browser.request(authorization().url);
  expect(begin.status).toBe(200);
  const link = /href="([^"]*\/oauth\/upstream\?[^"]*provider=google[^"]*)"/.exec(await begin.text())![1]!.replaceAll("&amp;", "&");
  const find = storage.repo.oauth.findRequest;
  storage.repo.oauth.findRequest = async (...a) => { const out = await find(...a); clock += OAUTH_TTL.request; return out; };
  try {
    expect((await browser.request(link)).status).toBe(400);
  } finally { storage.repo.oauth.findRequest = find; }
});

test("only listed metadata documents are clients: no fetch, audit, no redirect; de-listing ends refresh (F-16)", async () => {
  const listed = "https://client.example/metadata.json", unlisted = "https://attacker.example/client.json";
  let lookups = 0, reads = 0;
  const cimd = { resolve: async () => { lookups++; return [{ address: "8.8.8.8", family: 4 }]; },
    read: async (url: URL) => { reads++; return JSON.stringify({ client_id: url.href, client_name: "Client", redirect_uris: ["https://attacker.example/cb"], token_endpoint_auth_method: "none" }); } };
  service.close(); service = makeService(cimd);
  // An unlisted document is never fetched, and a bad authorize request never redirects to its callback.
  const u = new URL(authorization(unlisted, undefined, "https://attacker.example/cb").url); u.searchParams.set("response_type", "token");
  const refused = await fetch(u, { redirect: "manual" });
  expect(refused.status).toBe(400); expect(refused.headers.get("Location")).toBeNull();
  expect([lookups, reads]).toEqual([0, 0]);
  expect(accessAudits(storage.db, "oauth.cimd_refused").map(a => a.detail)).toEqual([{ reason: "not_allowed" }]);
  // A listed client signs in; once the operator drops it, refresh is refused while it stays off the list, not retried.
  const issued = await issue(listed, undefined, new Browser(), "https://attacker.example/cb");
  const tokens = await redeem(issued);
  service.close(); config = { ...config, oauthCimdClients: [] }; reads = 0; service = makeService(cimd);
  const refresh = await post("/oauth/token", { grant_type: "refresh_token", client_id: listed, refresh_token: tokens.refresh_token });
  expect(refresh.status).toBe(401); expect(await refresh.json()).toEqual({ error: "invalid_client" }); expect(reads).toBe(0);
  expect((await (await fetch(base + "/.well-known/oauth-authorization-server")).json()).client_id_metadata_document_supported).toBe(false);
  // Unset lists OpenCode's document only.
  service.close(); const { oauthCimdClients: _, ...unset } = config; config = unset; service = makeService(cimd);
  lookups = 0; reads = 0;
  const unsetRefused = await fetch(authorization(listed, undefined, "https://attacker.example/cb").url, { redirect: "manual" });
  expect(unsetRefused.status).toBe(400); expect([lookups, reads]).toEqual([0, 0]);
  expect(accessAudits(storage.db, "oauth.cimd_refused").map(a => a.detail)).toEqual(Array(3).fill({ reason: "not_allowed" })); // unlisted authorize, de-listed refresh, unset default
  expect((await (await fetch(base + "/.well-known/oauth-authorization-server")).json()).client_id_metadata_document_supported).toBe(true);
});

test("each built-in client completes code and refresh on a random loopback port with no operator registration", async () => {
  service.close(); config = { ...config, oauthClients: [] }; service = makeService();
  const metadata = await (await fetch(base + "/.well-known/oauth-authorization-server")).json();
  expect(metadata.grayboard_builtin_clients).toEqual(BUILTIN_CLIENT_IDS);
  const names = ["Grayboard for pi", "Grayboard for omp", "Grayboard for Claude Code"], grants = new Set<string>();
  for (const [i, clientId] of BUILTIN_CLIENT_IDS.entries()) for (const host of ["127.0.0.1", "[::1]"]) {
    const redirectUri = `http://${host}:${randomInt(1024, 65536)}/callback`;
    const issued = await issue(clientId, "grayboard:delivery grayboard:tools", new Browser(), redirectUri);
    // Built-ins are in the server's own client map: headed by name, not host, yet still a local callback.
    expect(issued.consent.content).toContain(`<h1>Authorize ${names[i]}</h1>`);
    expect(issued.consent.content).not.toContain("calls itself");
    expect(issued.consent.content).toContain(`Redirect: ${redirectUri}`);
    expect(issued.consent.content).toContain("Local callback: only approve if you started this client.");
    const tokens = await redeem(issued);
    expect(tokens.scope).toBe("grayboard:delivery grayboard:tools");
    const granted = await principal(tokens, ["grayboard:delivery", "grayboard:tools"]);
    expect([granted.clientId, granted.sourceKey]).toEqual([clientId, GRAYBOARD_SESSION_META]);
    const renewed = await post("/oauth/token", { grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token });
    expect(renewed.status).toBe(200);
    const next = await renewed.json() as Tokens;
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect(await principal(next)).toMatchObject({ grantId: granted.grantId, clientId, sourceKey: GRAYBOARD_SESSION_META });
    grants.add(granted.grantId);
  }
  expect(grants.size).toBe(BUILTIN_CLIENT_IDS.length * 2);
});

test("a built-in client's non-loopback or other-path redirect is refused before a flow is created", async () => {
  for (const clientId of BUILTIN_CLIENT_IDS) {
    for (const redirectUri of ["https://client.example/callback", "http://localhost:45678/callback", "http://127.0.0.1:45678/other", "http://[::1]:45678/callback/", "http://127.0.0.1:45678/callback?x=1", base + "/oauth/callback/complete"]) {
      const response = await fetch(authorization(clientId, undefined, redirectUri).url, { redirect: "manual" });
      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.getSetCookie()).toEqual([]);
    }
  }
  expect(storage.db.query("SELECT count(*) AS n FROM oauth_requests").get()).toEqual({ n: 0 });
  expect(exchanges).toBe(0);
});

test("a provider list that is empty, repeats an ID or has an ID unsafe in a path stops the OAuth server from starting", () => {
  service.close();
  const as = (id: string) => stubProvider({ email: "you@example.com", displayName: "You", subject: "s" }, undefined, { id });
  for (const providers of [[], [as("google"), as("google")], [as("Okta")], [as("a/b")]])
    expect(() => createOAuthServer(storage.repo, config, { providers })).toThrow("identity providers need distinct, path-safe IDs");
  service = makeService();
});

test("an operator client reusing a built-in ID stops the OAuth server from starting", () => {
  service.close();
  for (const clientId of BUILTIN_CLIENT_IDS) {
    expect(() => createOAuthServer(storage.repo, { ...config, oauthClients: [...registrations, { ...registrations[0]!, clientId }] })).toThrow(`OAuth client ID ${clientId} is reserved for a built-in client`);
  }
  service = makeService();
});

test("the first start with built-in clients revokes the grants and codes an operator client left under their IDs, once", async () => {
  const scope = "grayboard:delivery grayboard:tools";
  // A database from before #429: an operator client named grayboard-pi left a grant and an
  // unredeemed code, and no cutover is recorded.
  const old = await redeem(await issue("grayboard-pi", scope)), oldPrincipal = await principal(old);
  const pending = await issue("grayboard-pi", scope);
  const unrelated = await principal(await redeem(await issue()));
  await seed(storage.repo, () => storage.db.run("DELETE FROM server_state WHERE key = 'builtin_clients'"));
  const audit = () => storage.db.query<{ actor: string; target: string; detail: string }, []>("SELECT actor, target, detail FROM access_log WHERE action = 'oauth.builtin_client_grant_revoked'").all();
  const log = spyOn(console, "error").mockImplementation(() => {});
  const revokedLines = () => log.mock.calls.filter(([line]) => String(line).includes("issued under a built-in client ID"));
  try {
    service.close();
    // A refused config changes nothing: the cutover runs only once the clients parse.
    expect(() => createOAuthServer(storage.repo, { ...config, oauthClients: [{ ...registrations[0]!, clientId: "grayboard-pi" }] })).toThrow("reserved for a built-in client");
    expect([await storage.repo.oauth.isGrantActive(storage.repo.read, oldPrincipal.grantId, clock), audit().length]).toEqual([true, 0]);
    service = makeService(); await service.ready;
    expect(revokedLines().map(([line]) => line)).toEqual([expect.stringContaining("revoked 1 OAuth grant(s)")]);
    expect(audit()).toEqual([{ actor: "you@example.com", target: oldPrincipal.grantId, detail: JSON.stringify({ client_id: "grayboard-pi" }) }]);
    expect(await service.isAuthorized(oldPrincipal)).toBe(false);
    expect((await post("/oauth/token", { grant_type: "refresh_token", client_id: "grayboard-pi", refresh_token: old.refresh_token })).status).toBe(400);
    expect((await post("/oauth/token", tokenParams(pending))).status).toBe(400);
    expect(await service.isAuthorized(unrelated)).toBe(true);
    // From then on a grant under a built-in ID is the built-in's: later starts keep it.
    const fresh = await redeem(await issue("grayboard-omp", scope));
    for (let i = 0; i < 2; i++) { service.close(); service = makeService(); await service.ready; }
    expect([revokedLines().length, audit().length]).toEqual([1, 1]);
    expect(await service.isAuthorized(await principal(fresh))).toBe(true);
    expect((await post("/oauth/token", { grant_type: "refresh_token", client_id: "grayboard-omp", refresh_token: fresh.refresh_token })).status).toBe(200);
  } finally { log.mockRestore(); }
});

test("preregistered clients retain the explicit manual callback flow", async () => {
  service.close();
  const redirectUri = base + "/oauth/callback/complete";
  config = { ...config, oauthClients: [...registrations, { ...registrations[0]!, clientId: "manual", redirectUris: [redirectUri] }] };
  service = makeService();
  const a = await issue("manual", "grayboard:tools", new Browser(), redirectUri);
  const page = await a.browser.request(redirectUri + "?" + new URLSearchParams({ code: a.code, state: a.state, iss: base }));
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("Return to your client");
  expect((await redeem(a)).access_token).toMatch(/^[\w-]{43}$/);
});

test("CIMD outage during refresh or revocation returns retryable 503 without burning credentials", async () => {
  service.close();
  const clientId = "https://client.example/metadata.json";
  let outage = false;
  service = makeService({ resolve: async () => [{ address: "8.8.8.8", family: 4 }], read: async () => {
    if (outage) throw new Error("upstream unavailable");
    return JSON.stringify({client_id:clientId,client_name:"Client",redirect_uris:["http://127.0.0.1/callback"],token_endpoint_auth_method:"none"});
  } });
  const issued = await issue(clientId);
  const tokens = await redeem(issued);
  const grant = (await principal(tokens)).grantId;
  clock += 300_001; outage = true;
  for (const [path, params] of [["/oauth/token", {grant_type:"refresh_token",refresh_token:tokens.refresh_token}], ["/oauth/revoke", {token:tokens.refresh_token}]] as const) {
    const result = await post(path, {client_id:clientId,...params});
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({error:"temporarily_unavailable"});
    expect(await service.isGrantActive(grant)).toBe(true);
  }
  clock += 30_001; outage = false;
  const refreshed = await post("/oauth/token", {client_id:clientId,grant_type:"refresh_token",refresh_token:tokens.refresh_token});
  expect(refreshed.status).toBe(200);
  expect((await principal(await refreshed.json() as Tokens)).grantId).toBe(grant);
});

function authorization(clientId = "native", verifier = random(), redirectUri = "http://127.0.0.1:34567/callback", scope = "grayboard:tools") {
  const state = random();
  const url = base + "/oauth/authorize?" + new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", resource: service.resource,
    scope, state, code_challenge: s256(verifier), code_challenge_method: "S256" });
  return { url, verifier, state, clientId, redirectUri, scope };
}
// The provider callback's answer: "consent" when the sign-in goes on to consent, else the refusal's error_description
// ("" for none). A refusal after the callback binds the request returns to the client (RFC 6749 §4.1.2.1, #928) with
// access_denied, the client's state and the issuer.
function callbackOutcome(res: Response, a: { state: string; redirectUri: string }): string {
  expect(res.status).toBe(303);
  const to = new URL(res.headers.get("location")!);
  if (to.href.startsWith(base + "/oauth/consent?")) return "consent";
  expect(to.origin + to.pathname).toBe(a.redirectUri);
  expect([to.searchParams.get("error"), to.searchParams.get("state"), to.searchParams.get("iss"), to.searchParams.has("code")]).toEqual(["access_denied", a.state, base, false]);
  return to.searchParams.get("error_description") ?? "";
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
  return { ...consentForm(content), content };
}
async function decide(browser: Browser, data: { request: string; csrf: string }, decision = "approve", origin = base) {
  return submitConsent(browser, base + "/oauth/consent", data, decision, origin);
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
async function principal(tokens: Tokens, required?: string[]) {
  const p = await service.authenticate(new Request(base + "/mcp", { headers: { Authorization: `Bearer ${tokens.access_token}` } }), required);
  expect(p).not.toBeInstanceOf(Response); return p as OAuthPrincipal;
}

test("OAuth event trail records decisions, grant, strict replay warnings and revocation without credentials", async () => {
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect((await fetch(base + "/oauth/authorize?client_id=PRIVATE-QUERY")).status).toBe(400);
    const denied = new Browser();
    await decide(denied, await loginConsent(denied, authorization().url), "deny");
    const code = await issue();
    const first = await redeem(code);
    expect((await post("/oauth/token", tokenParams(code))).status).toBe(400);
    const other = await issue();
    const tokens = await redeem(other);
    const refresh = { grant_type: "refresh_token", client_id: "native", refresh_token: tokens.refresh_token };
    expect((await post("/oauth/token", refresh)).status).toBe(200);
    expect((await post("/oauth/token", refresh)).status).toBe(400);
    const third = await redeem(await issue());
    expect((await post("/oauth/revoke", { client_id: "native", token: third.refresh_token })).status).toBe(200);
    const rows = storage.db.query<{ action: string; actor: string | null; detail: string }, []>("SELECT action,actor,detail FROM access_log WHERE action LIKE 'oauth.%'").all();
    const actions = rows.map(r => r.action);
    for (const action of ["request_refused", "authorize", "upstream_authenticated", "consent_denied", "consent_approved", "grant_issued", "code_replay_revoked", "refreshed", "refresh_replay_revoked", "revoked", "revoke_requested"]) expect(actions).toContain("oauth." + action);
    // #928 D9: the upstream rows name their provider.
    expect(rows.filter(r => r.action === "oauth.upstream_authenticated").map(r => [r.actor, JSON.parse(r.detail)])).toContainEqual(["you@example.com", { client_id: "native", provider: "google" }]);
    for (const row of rows.filter(r => /grant_issued|replay_revoked|refreshed|^oauth.revoked$/.test(r.action))) {
      expect(row.actor).toBe("you@example.com");
      expect(JSON.parse(row.detail).client_id).toBe("native");
      if (row.action.includes("replay")) expect(JSON.parse(row.detail).level).toBe("warning");
    }
    expect(warning).toHaveBeenCalledTimes(2);
    const serialized = JSON.stringify(rows) + JSON.stringify(warning.mock.calls);
    for (const value of ["PRIVATE-QUERY", code.code, code.verifier, first.access_token, first.refresh_token, tokens.refresh_token]) expect(serialized).not.toContain(value);
    clock += OAUTH_TTL.grant + 1;
    await seed(storage.repo, tx => storage.repo.oauth.cleanup(tx, clock));
    expect(storage.db.query("SELECT count(*) AS n FROM oauth_grants").get()).toEqual({ n: 0 });
    expect(storage.db.query("SELECT actor FROM access_log WHERE action = 'oauth.grant_issued' LIMIT 1").get()).toEqual({ actor: "you@example.com" });
  } finally { warning.mockRestore(); }
});

test("OAuth sweep and upstream diagnostics never inspect exception strings, stacks or causes", async () => {
  service.close();
  const interval = spyOn(globalThis, "setInterval");
  service = makeService();
  const tick = interval.mock.calls[0]![0] as () => void;
  interval.mockRestore();
  await storage.repo.write(() => {}); // as above: the tick runs on an idle queue, as it does 60s after startup
  const cleanup = storage.repo.oauth.cleanup;
  const forged = new Error("Bearer PRIVATE\n    at f (/private/refresh-token.ts:1:1)", { cause: "AUTHORIZATION-CODE" });
  const log = spyOn(console, "error").mockImplementation(() => {});
  storage.repo.oauth.cleanup = async () => { throw forged; };
  try {
    tick();
    await until(() => log.mock.calls.length > 0, 5000, "the sweep's cleanup failure is logged");
    expect(log.mock.calls.flat()).toEqual(['[grayboard] {"operation":"oauth.sweep","category":"failure","level":"error","class":"Error"}']);
  } finally { storage.repo.oauth.cleanup = cleanup; }
  try {
    service.close();
    service = createOAuthServer(storage.repo, config, { now: () => clock, providers: [stubProvider(async () => { throw forged; })] });
    const browser = new Browser(), a = authorization();
    const begin = await browser.request(a.url);
    const state = new URL(begin.headers.get("location")!).searchParams.get("state")!;
    expect(callbackOutcome(await browser.request(base + "/oauth/google/callback?" + new URLSearchParams({ state, code: "PRIVATE-CODE" })), a)).toBe(REFUSED.provider);
    expect(log.mock.calls.flat()).toEqual([
      '[grayboard] {"operation":"oauth.sweep","category":"failure","level":"error","class":"Error"}',
      '[grayboard] {"operation":"oauth.exchange","category":"failure","level":"error","class":"Error"}',
    ]);
    const trail = JSON.stringify(storage.db.query("SELECT * FROM access_log WHERE action LIKE 'oauth.%'").all());
    expect(accessAudits(storage.db, "oauth.upstream_failed").map(r => r.detail)).toEqual([{ client_id: "native", provider: "google" }]);
    for (const secret of ["PRIVATE", "refresh-token.ts", "AUTHORIZATION-CODE"]) expect(trail + JSON.stringify(log.mock.calls)).not.toContain(secret);
  } finally { log.mockRestore(); }
});

// #933: a listed client's document unavailable or invalid writes its CIMD row with the refusal's one decision, so
// 1,000 token posts write at most the token_refusal burst; an unavailable post spends its address as a refusal.
test("token posts naming a listed client whose document is down or invalid write at most the refusal burst of CIMD rows", async () => {
  service.close(); config.oauthGlobalLimit = { burst: 5, perSec: 0.001 }; config.oauthLimit = { burst: 3, perSec: 0.001 };
  const post = (key: string) => service.fetch(new Request(base + "/oauth/token", { method: "POST",
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: "https://client.example/client.json", refresh_token: random() }) }), { key }).then(r => r!.status);
  service = makeService({ resolve: async () => [{ address: "8.8.8.8", family: 4 }], read: async () => { throw new Error("upstream down"); } });
  for (let i = 0; i < 1000; i++) expect(await post(`down-${i}`)).toBe(503);
  expect(accessAudits(storage.db, "oauth.cimd_failed").map(a => a.detail)).toEqual(Array(5).fill({ category: "unavailable" }));
  // Charged as a refusal: one address retrying is refused by its own bucket.
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push(await post("retrying"));
  expect(statuses).toEqual([503, 503, 503, 429]);

  service.close(); clock += 10_000_000;
  service = makeService({ resolve: async () => [{ address: "8.8.8.8", family: 4 }], read: async () => "not a metadata document" });
  for (let i = 0; i < 1000; i++) expect(await post(`invalid-${i}`)).toBe(401);
  expect(accessAudits(storage.db, "oauth.cimd_refused").map(a => a.detail)).toEqual(Array(5).fill(null));
  expect(storage.db.query("SELECT 1 FROM access_log WHERE action = 'oauth.request_refused'").all()).toHaveLength(5);
});

test("CIMD, domain and unexpected OAuth failures retain safe audit categories", async () => {
  service.close();
  service = makeService({ resolve: async () => [{ address: "8.8.8.8", family: 4 }], read: async () => { throw new Error("Bearer PRIVATE\n at f (/private/refresh-token.ts:1:1)"); } });
  expect((await fetch(authorization("https://client.example/client.json").url)).status).toBe(503);
  expect(storage.db.query("SELECT action FROM access_log WHERE action = 'oauth.cimd_failed'").get()).toEqual({ action: "oauth.cimd_failed" });
  service.close();
  // The provider checks the domain inside its exchange (#928 D1; idp_google.test.ts); its refusal is audited as one.
  service = createOAuthServer(storage.repo, config, { now: () => clock, providers: [stubProvider(async () => { throw new DomainRefused("account must be from @example.com"); })] });
  const browser = new Browser(), a = authorization();
  const first = await browser.request(a.url);
  const state = new URL(first.headers.get("location")!).searchParams.get("state")!;
  expect(callbackOutcome(await browser.request(base + "/oauth/google/callback?" + new URLSearchParams({ state, code: "PRIVATE-CODE" })), a)).toBe(REFUSED.domain);
  expect(storage.db.query("SELECT action FROM access_log WHERE action = 'oauth.domain_refused'").get()).toEqual({ action: "oauth.domain_refused" });
  const log = spyOn(console, "error").mockImplementation(() => {});
  const create = storage.repo.oauth.createRequest;
  storage.repo.oauth.createRequest = () => { throw new Error("Bearer PRIVATE", { cause: "PRIVATE-CODE" }); };
  try {
    expect((await fetch(authorization().url)).status).toBe(500);
    expect(log.mock.calls.flat()).toEqual(['[grayboard] {"operation":"oauth.request","category":"failure","level":"error","class":"Error"}']);
    const trail = JSON.stringify(storage.db.query("SELECT * FROM access_log WHERE action LIKE 'oauth.%'").all());
    expect(trail).toContain("oauth.request_failed");
    expect(trail).not.toContain("PRIVATE"); expect(trail).not.toContain("refresh-token.ts");
  } finally { storage.repo.oauth.createRequest = create; log.mockRestore(); }
});

// #928: a disabled user's refusal at the callback reaches the client with its reason, is audited, and opens no
// browser session.
test("a disabled user is refused at the callback back to the client, and audited", async () => {
  const signIn = async () => {
    const browser = new Browser(), a = authorization();
    const begin = await browser.request(a.url);
    const state = new URL(begin.headers.get("location")!).searchParams.get("state")!;
    return callbackOutcome(await browser.request(base + "/oauth/google/callback?" + new URLSearchParams({ state, code: "fake-google-code" })), a);
  };
  expect(await signIn()).toBe("consent");
  const user = (await storage.repo.users.findByEmail(storage.repo.read, "you@example.com"))!;
  await seed(storage.repo, () => storage.db.run("UPDATE users SET disabled_at = ? WHERE id = ?", [clock, user.id]));
  expect(await signIn()).toBe(REFUSED.disabled);
  expect(accessAudits(storage.db, "oauth.user_refused")).toEqual([expect.objectContaining({ actor: "you@example.com", detail: { client_id: "native" } })]);
  expect(storage.db.query("SELECT COUNT(*) AS n FROM oauth_browsers").get()).toEqual({ n: 1 });
});

// Security audit F-13: an email Google hands to a new account doesn't bring the old account's user with it.
test("a Google account presenting a linked user's email is refused at the callback and audited", async () => {
  const signIn = async (subject: string) => {
    service.close();
    service = createOAuthServer(storage.repo, config, { now: () => clock, providers: [stubProvider(async () => ({ email: "you@example.com", displayName: "You", subject }))] });
    const browser = new Browser(), a = authorization();
    const first = await browser.request(a.url);
    const state = new URL(first.headers.get("location")!).searchParams.get("state")!;
    return callbackOutcome(await browser.request(base + "/oauth/google/callback?" + new URLSearchParams({ state, code: "code" })), a);
  };
  expect(await signIn("google-first")).toBe("consent");
  expect(await signIn("google-second")).toBe("you@example.com is linked to a different Google account. If this account should have it, an admin runs grayboard admin unlink-idp --email you@example.com");
  expect(storage.db.query("SELECT action, actor, detail FROM access_log WHERE action LIKE 'auth.subject_%'").all()).toEqual([
    { action: "auth.subject_refused", actor: "you@example.com", detail: JSON.stringify({ reason: "subject_mismatch", provider: "google", issuer: GOOGLE_ISSUER, client_id: "native" }) },
  ]);
  expect(storage.db.query("SELECT COUNT(*) AS n FROM oauth_browsers").get()).toEqual({ n: 1 });
  expect((await storage.repo.users.findByEmail(storage.repo.read, "you@example.com"))!.idp_subject).toBe("google-first");
});

// #928 D4: an email one IdP's account holds never signs in from another IdP, either way round, until an admin
// unlinks it; the AS keys the user by the provider's issuer.
for (const [first, second] of [["google", "okta"], ["okta", "google"]] as const) {
  test(`an email a ${first} account holds is refused from ${second} at the callback, audited, and taken after unlink-idp`, async () => {
    const okta = { id: "okta", issuer: "https://example.okta.com", label: "Okta" };
    const signIn = async (idp: "google" | "okta") => {
      service.close();
      service = createOAuthServer(storage.repo, config, { now: () => clock, providers: [stubProvider(async () => ({ email: "you@example.com", displayName: "You", subject: idp + "-you" }), undefined, idp === "okta" ? okta : {})] });
      const browser = new Browser(), a = authorization();
      const first = await browser.request(a.url);
      const state = new URL(first.headers.get("location")!).searchParams.get("state")!;
      return callbackOutcome(await browser.request(base + `/oauth/${idp}/callback?` + new URLSearchParams({ state, code: "code" })), a);
    };
    const issuer = (idp: "google" | "okta") => idp === "okta" ? okta.issuer : GOOGLE_ISSUER;
    expect(await signIn(first)).toBe("consent");
    expect((await storage.repo.users.findByEmail(storage.repo.read, "you@example.com"))).toMatchObject({ idp_issuer: issuer(first), idp_subject: first + "-you" });
    // The CLI prints this. This server lists only the second provider, so the holder goes unnamed (its issuer may be an
    // org's own host); the text names the person's email, the provider and the admin's remedy, nothing else.
    const label = second === "okta" ? "Okta" : "Google";
    expect(await signIn(second)).toBe(`you@example.com is linked to another provider's account, not ${label}. If this ${label} account should have it, an admin runs grayboard admin unlink-idp --email you@example.com`);
    expect(storage.db.query("SELECT COUNT(*) AS n FROM oauth_browsers").get()).toEqual({ n: 1 });
    expect(accessAudits(storage.db, "auth.subject_refused").map(r => [r.actor, r.detail])).toEqual([
      ["you@example.com", { reason: "issuer_mismatch", holding_issuer: issuer(first), provider: second, issuer: issuer(second), client_id: "native" }],
    ]);
    await storage.repo.write(async tx => storage.repo.users.clearSubject(tx, (await storage.repo.users.findByEmail(tx, "you@example.com"))!.id));
    expect(await signIn(second)).toBe("consent");
    expect((await storage.repo.users.findByEmail(storage.repo.read, "you@example.com"))).toMatchObject({ idp_issuer: issuer(second), idp_subject: second + "-you" });
    expect(storage.db.query("SELECT COUNT(*) AS n FROM oauth_browsers").get()).toEqual({ n: 2 });
  });
}

test("direct config dev auth rejects any provider secret (either Google pair, Okta), including an override with an empty primary", () => {
  const okta = { idps: ["google", "okta"] as IdpId[], okta: { issuer: "https://example.okta.com", clientId: "okta-client", clientSecret: "okta-private", allowedDomains: ["example.com"] } };
  for (const credentials of [{ googleClientSecret: "primary-private" }, { mcpGoogle: { clientId: "web-client", clientSecret: "web-private" } }, okta]) {
    expect(() => createOAuthServer(storage.repo, { ...config, ...credentials })).toThrow("dev auth must not coexist with an identity provider's client secret");
  }
});

test("default Google exchange consistently selects the Web override or primary fallback and verifies its audience", async () => {
  const { jwk, privateKey } = await googleKey();
  const originalFetch = globalThis.fetch;
  try {
    for (const mode of ["fallback", "override", "wrong-audience", "trusted-fixture"] as const) {
      service.close();
      const mcpGoogle = mode === "fallback" ? undefined : { clientId: "web-client", clientSecret: "web-private" };
      const cfg = { ...config, publicUrl: "https://grayboard.example.com:443/hosted", devAuth: false, googleClientId: "desktop-client", googleClientSecret: "desktop-private", mcpGoogle };
      let nonce = "", tokenCalls = 0, fixtureCalls = 0;
      const selected = mcpGoogle ?? { clientId: cfg.googleClientId, clientSecret: cfg.googleClientSecret };
      service = createOAuthServer(storage.repo, cfg, mode === "trusted-fixture" ? { providers: [stubProvider(async input => {
        fixtureCalls++;
        expect(input.redirectUri).toBe(cfg.publicUrl + "/oauth/google/callback");
        expect(input.nonce).toBe(nonce);
        // The real path's ID token below carries sub "fixture-user"; the modes share one database.
        return { email: "you@example.com", displayName: "You", subject: "fixture-user" };
      }, { clientId: selected.clientId, orgDomain: cfg.orgDomain })] } : {});
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
      expect(callback.status).toBe(303);
      expect(tokenCalls).toBe(mode === "trusted-fixture" ? 0 : 1);
      expect(fixtureCalls).toBe(mode === "trusted-fixture" ? 1 : 0);
      if (mode !== "wrong-audience") {
        const consent = await direct(callback.headers.get("Location")!);
        expect(consent.status).toBe(200);
        expect(await consent.text()).toContain("you@example.com");
      } else {
        const refused = new URL(callback.headers.get("Location")!);
        expect([refused.origin + refused.pathname, refused.searchParams.get("error"), refused.searchParams.get("error_description")]).toEqual([a.redirectUri, "access_denied", REFUSED.provider]);
        expect(refused.href + await callback.text()).not.toContain("private");
      }
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
  const auth = (await service.authenticate(new Request(base + "/mcp"), ["grayboard:delivery"])) as Response;
  expect(auth.status).toBe(401); expect(auth.headers.get("WWW-Authenticate")).toContain('scope="grayboard:delivery grayboard:tools"');
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
  const tokens = await redeem(a); const p = await principal(tokens);
  expect(p.authed.session_id).toBe(0); expect(tokens.expires_in).toBe(3600); expect(tokens.token_type).toBe("Bearer");
  const b = await issue("subscriber", "grayboard:delivery", browser);
  expect([...browser.jar]).toEqual(oldCookies); // persisted browser login, but fresh explicit consent
  expect(exchanges).toBe(1);
  const t2 = await redeem(b); const p2 = await principal(t2, ["grayboard:delivery"]);
  expect(p.grantId).not.toBe(p2.grantId); expect(p.authed.user_id).toBe(p2.authed.user_id);
  const wrongScope = (await service.authenticate(new Request(base + "/mcp", { headers: { Authorization: `Bearer ${t2.access_token}` } }))) as Response;
  expect(wrongScope.status).toBe(403); expect(wrongScope.headers.get("WWW-Authenticate")).toContain("insufficient_scope");
  expect((await post("/oauth/revoke", { client_id: "subscriber", token: tokens.access_token })).status).toBe(200);
  expect(await service.isAuthorized(p)).toBe(true);
  expect((await post("/oauth/revoke", { client_id: "native", token: tokens.access_token })).status).toBe(200);
  expect(await service.isAuthorized(p)).toBe(false); expect(await service.isAuthorized(p2)).toBe(true);
  const refreshed = await post("/oauth/token", { client_id: "native", grant_type: "refresh_token", refresh_token: tokens.refresh_token, resource: service.resource });
  expect(refreshed.status).toBe(200);
  const t3 = await refreshed.json() as Tokens; expect((await principal(t3)).grantId).toBe(p.grantId);
  expect((await post("/oauth/revoke", { client_id: "native", token: t3.refresh_token })).status).toBe(200);
  expect(await service.isAuthorized(await principal(t2, ["grayboard:delivery"]))).toBe(true);
});

test("all code bindings checked before consume/replay, downscoping refresh retains original permission, strict replay kills winner", async () => {
  const a = await issue("subscriber", "grayboard:delivery grayboard:tools");
  const invalidBindings: Record<string, string>[] = [{ client_id: "native" }, { code_verifier: random() }, { resource: base + "/elsewhere" }, { redirect_uri: "http://127.0.0.1:34568/callback" }, { scope: "grayboard:tools" }, { scope: "offline_access" }, { code: random() }];
  for (const patch of invalidBindings) expect((await post("/oauth/token", { ...tokenParams(a), ...patch })).status).toBe(400);
  const tokens = await redeem(a), original = await principal(tokens);
  expect((await post("/oauth/token", { ...tokenParams(a), code_verifier: random() })).status).toBe(400);
  expect(await service.isAuthorized(original)).toBe(true);
  const refresh = { client_id: "subscriber", grant_type: "refresh_token", refresh_token: tokens.refresh_token, resource: service.resource };
  expect((await post("/oauth/token", { ...refresh, scope: "offline_access" })).status).toBe(400);
  const r = await post("/oauth/token", { ...refresh, scope: "grayboard:tools" }); expect(r.status).toBe(200);
  const narrow = await r.json() as Tokens; expect(narrow.scope).toBe("grayboard:tools"); expect((await principal(narrow)).grantId).toBe(original.grantId);
  expect(((await service.authenticate(new Request(base + "/mcp", { headers: { Authorization: `Bearer ${narrow.access_token}` } }), ["grayboard:delivery"])) as Response).status).toBe(403);
  const r2 = await post("/oauth/token", { ...refresh, refresh_token: narrow.refresh_token }); expect(r2.status).toBe(200);
  const full = await r2.json() as Tokens; expect(full.scope).toBe("grayboard:delivery grayboard:tools");
  expect((await post("/oauth/token", { ...refresh, client_id: "native" })).status).toBe(400);
  expect(await service.isAuthorized(await principal(full))).toBe(true);
  expect((await post("/oauth/token", refresh)).status).toBe(400);
  expect(await service.isAuthorized(original)).toBe(false);
  expect(((await service.authenticate(new Request(base + "/mcp", { headers: { Authorization: `Bearer ${full.access_token}` } }))) as Response).status).toBe(401);
  const b = await issue(); const t = await redeem(b); const pb = await principal(t);
  expect((await post("/oauth/token", tokenParams(b))).status).toBe(400); expect(await service.isAuthorized(pb)).toBe(false);
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
  const data = consentForm(content);
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
  service.close();
  service = makeService({ resolve: async () => [{ address: "8.8.8.8", family: 4 }], read: async () => "invalid metadata" });
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
  for (const method of ["GET", "POST", "DELETE"]) expect(((await service.authenticate(new Request(base + "/mcp?access_token=" + tokens.access_token, { method, headers: { Authorization: `Bearer ${tokens.access_token}` } }))) as Response).status).toBe(401);
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
  const p = await principal(full);
  expect((await post("/oauth/revoke?url_extension=ignored&empty=", { client_id: "subscriber", token: full.refresh_token, token_type_hint: "", extension: "ignored", client_secret: "" })).status).toBe(200);
  expect(await service.isAuthorized(p)).toBe(false);
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

test("a Google callback carrying a parameter outside the allowlist is refused before exchange", async () => {
  const browser = new Browser(), begin = await browser.request(authorization().url), google = new URL(begin.headers.get("Location")!);
  const callback = base + "/oauth/google/callback?" + new URLSearchParams({ state: google.searchParams.get("state")!, code: "fake-google-code" });
  expect((await browser.request(callback + "&injected=1")).status).toBe(400);
  expect(exchanges).toBe(0);
});

test("the default Google provider's authorize redirect carries hd=<orgDomain> from config", async () => {
  service.close();
  service = createOAuthServer(storage.repo, { ...config, orgDomain: "corp.example" }, { now: () => clock });
  const begin = await new Browser().request(authorization().url);
  expect(begin.status).toBe(303);
  const google = new URL(begin.headers.get("Location")!);
  expect(google.origin + google.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  expect(google.searchParams.get("hd")).toBe("corp.example");
});

// The real googleProvider: it must hand the AS's nonce to the token check, or a replayed ID token would pass.
test("the default Google provider refuses an ID token whose nonce isn't the flow's", async () => {
  const { jwk, privateKey } = await googleKey();
  const originalFetch = globalThis.fetch;
  let tokenNonce: (flowNonce: string) => string = n => n, flowNonce = "";
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.url === "https://www.googleapis.com/oauth2/v3/certs") return Response.json({ keys: [jwk] });
    if (req.url !== "https://oauth2.googleapis.com/token") return originalFetch(input, init);
    const id_token = await new SignJWT({ hd: "example.com", email: "you@example.com", email_verified: true, nonce: tokenNonce(flowNonce) })
      .setProtectedHeader({ alg: "RS256", kid: jwk.kid }).setIssuer("https://accounts.google.com").setSubject("nonce-user")
      .setAudience(config.googleClientId).setIssuedAt().setExpirationTime("5m").sign(privateKey);
    return Response.json({ id_token });
  }, { preconnect: originalFetch.preconnect });
  try {
    service.close();
    service = createOAuthServer(storage.repo, config, { now: () => clock });
    const signIn = async () => {
      const browser = new Browser(), a = authorization(), begin = await browser.request(a.url), google = new URL(begin.headers.get("Location")!);
      flowNonce = google.searchParams.get("nonce")!;
      return callbackOutcome(await browser.request(base + "/oauth/google/callback?" + new URLSearchParams({ state: google.searchParams.get("state")!, code: "mock-google-code", iss: "https://accounts.google.com" })), a);
    };
    tokenNonce = () => random();
    expect(await signIn()).toBe(REFUSED.provider);
    expect(accessAudits(storage.db, "oauth.upstream_failed").map(r => r.detail)).toEqual([{ client_id: "native", provider: "google" }]);
    tokenNonce = n => n;
    expect(await signIn()).toBe("consent");
  } finally { globalThis.fetch = originalFetch; }
});

test("fixed registered loopback ports allow another authorization port but code redemption binds the actual URI", async () => {
  service.close(); config = { ...config, oauthClients: registrations.map(c => c.clientId === "native" ? { ...c, redirectUris: ["http://127.0.0.1:8080/callback", "http://[::1]:8080/callback"] } : c) }; service = makeService();
  for (const redirectUri of ["http://127.0.0.1:45678/callback", "http://[::1]:45678/callback", "http://127.0.0.1:80/callback", "http://[::1]:80/callback"]) {
    const a = await issue("native", "grayboard:tools", undefined, redirectUri);
    for (const wrong of [redirectUri.replace(/:\d+\//, ":8080/"), redirectUri.replace(/:\d+\//, ":45679/")]) expect((await post("/oauth/token", { ...tokenParams(a), redirect_uri: wrong })).status).toBe(400);
    const tokens = await redeem(a); expect((await principal(tokens)).clientId).toBe("native");
  }
});

test("live disable/admin revoke, expiry, and database failures are not credential errors or false success", async () => {
  const a = await issue(), tokens = await redeem(a), p = await principal(tokens);
  clock += OAUTH_TTL.access;
  expect(await service.isAuthorized(p)).toBe(false);
  const refreshed = await post("/oauth/token", { client_id: "native", grant_type: "refresh_token", refresh_token: tokens.refresh_token, resource: service.resource });
  const next = await refreshed.json() as Tokens; const np = await principal(next);
  await seed(storage.repo, tx => storage.repo.users.setDisabled(tx, np.authed.user_id, true));
  await seed(storage.repo, tx => storage.repo.users.setDisabled(tx, np.authed.user_id, false));
  expect(await service.isAuthorized(np)).toBe(false);
  const b = await issue(), t2 = await redeem(b), p2 = await principal(t2);
  await seed(storage.repo, tx => storage.repo.sessions.revokeAllForUser(tx, p2.authed.user_id)); expect(await service.isAuthorized(p2)).toBe(false);
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
  const a = await issue(), tokens = await redeem(a), p = await principal(tokens);
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
  const last = await principal(current); clock += 1000; expect(await service.isAuthorized(last)).toBe(false);
  expect((await post("/oauth/token", { client_id: "native", grant_type: "refresh_token", refresh_token: current.refresh_token, resource: service.resource })).status).toBe(400);
  const b = await issue(), t = await redeem(b), pb = await principal(t); clock += OAUTH_TTL.code;
  expect((await post("/oauth/token", tokenParams(b))).status).toBe(400); expect(await service.isAuthorized(pb)).toBe(false);
});

test("HTTP concurrent code/refresh consumes have one winner and committed strict replay revocation", async () => {
  const a = await issue();
  const codes = await Promise.all([post("/oauth/token", tokenParams(a)), post("/oauth/token", tokenParams(a))]);
  expect(codes.map(r => r.status).sort()).toEqual([200, 400]);
  const winner = await codes.find(r => r.status === 200)!.json() as Tokens;
  expect(((await service.authenticate(new Request(base + "/mcp", { headers: { Authorization: `Bearer ${winner.access_token}` } }))) as Response).status).toBe(401);
  const b = await issue(), tokens = await redeem(b);
  const p = { grant_type: "refresh_token", client_id: "native", refresh_token: tokens.refresh_token, resource: service.resource };
  const refreshes = await Promise.all([post("/oauth/token", p), post("/oauth/token", p)]);
  expect(refreshes.map(r => r.status).sort()).toEqual([200, 400]);
  const refreshed = await refreshes.find(r => r.status === 200)!.json() as Tokens;
  expect(((await service.authenticate(new Request(base + "/mcp", { headers: { Authorization: `Bearer ${refreshed.access_token}` } }))) as Response).status).toBe(401);
});

test("OAuth global rate bounds distinct callers and audits once per refusal streak", async () => {
  service.close(); config.oauthGlobalLimit = { burst: 2, perSec: 1 };
  service = makeService();
  const request = new Request(base + "/oauth/unknown?access_token=private-value");
  expect((await service.fetch(request, { key: "first" }))!.status).toBe(400);
  expect((await service.fetch(request, { key: "second" }))!.status).toBe(400);
  for (const key of ["third", "fourth"]) {
    const response = (await service.fetch(request, { key }))!;
    expect(response.status).toBe(429); expect(response.headers.get("retry-after")).toBe("1");
  }
  const audit = () => storage.db.query<{ action: string; detail: string }, []>("SELECT action, detail FROM access_log WHERE action LIKE 'oauth.rate%'").all();
  expect(audit()).toHaveLength(1); expect(audit()[0]!.detail).toContain('"scope":"global"');
  expect(JSON.stringify(audit())).not.toContain("private-value");
  clock += 2000;
  expect((await service.fetch(request, { key: "third" }))!.status).toBe(400);
  expect(audit().filter(row => row.action === "oauth.rate_limit_ended")).toHaveLength(1);
});

test("one address refused by its own limit can't drain the global OAuth bucket", async () => {
  service.close(); config.oauthGlobalLimit = { burst: 5, perSec: 1 }; config.oauthLimit = { burst: 2, perSec: 1 };
  service = makeService();
  const request = new Request(base + "/oauth/unknown");
  for (let i = 0; i < 2; i++) expect((await service.fetch(request, { key: "noisy" }))!.status).not.toBe(429);
  for (let i = 0; i < 50; i++) expect((await service.fetch(request, { key: "noisy" }))!.status).toBe(429);
  expect((await service.fetch(request, { key: "quiet" }))!.status).not.toBe(429);
  const scopes = storage.db.query<{ detail: string }, []>("SELECT detail FROM access_log WHERE action = 'oauth.rate_limited'").all().map(r => JSON.parse(r.detail).scope);
  expect(scopes).toEqual(["address"]);
});

// The token routes are charged only for a refused request that carries grant
// material (#283): a cross-site form post reaches them, and must not lock an
// office NAT out of token refresh.
const tokenPost = (path: string, params: Record<string, string>, headers: Record<string, string> = {}) =>
  service.fetch(new Request(base + path, { method: "POST", body: new URLSearchParams(params), headers }), { key: "office" }).then(r => r!.status);
const refusedRows = () => storage.db.query("SELECT 1 FROM access_log WHERE action = 'oauth.request_refused'").all().length;

test("token posts without grant material or from a foreign origin cost nothing; only refused grants spend the token bucket", async () => {
  const code = await issue(), spent = await issue();
  await redeem(spent);
  service.close(); config.oauthLimit = { burst: 2, perSec: 1 };
  service = makeService();
  for (let i = 0; i < 20; i++) {
    expect(await tokenPost("/oauth/token", { grant_type: "authorization_code", client_id: "native" })).toBe(400);
    expect(await tokenPost("/oauth/revoke", { client_id: "native", token_type_hint: "refresh_token" })).toBe(400);
    expect(await tokenPost("/oauth/token", tokenParams(code), { Origin: "https://foreign.example" })).toBe(403);
    expect(await tokenPost("/oauth/token?access_token=x", tokenParams(code))).toBe(400);
  }
  expect(refusedRows()).toBe(0);
  expect(await tokenPost("/oauth/token", tokenParams(code))).toBe(200);
  expect(await tokenPost("/oauth/token", tokenParams(spent))).toBe(400);
  expect(await tokenPost("/oauth/token", tokenParams(spent))).toBe(400);
  expect(refusedRows()).toBe(2);
  expect(await tokenPost("/oauth/token", tokenParams(spent))).toBe(429);
  expect(await tokenPost("/oauth/revoke", { client_id: "native", token: random() })).toBe(429);
  const scopes = storage.db.query<{ detail: string }, []>("SELECT detail FROM access_log WHERE action = 'oauth.rate_limited'").all().map(r => JSON.parse(r.detail).scope);
  expect(scopes).toEqual(["token_address"]);
  expect((await service.fetch(new Request(authorization().url), { key: "office" }))!.status).toBe(303);
});

test("a drained browser-route bucket doesn't block token refresh from the same address", async () => {
  const tokens = await redeem(await issue());
  service.close(); config.oauthLimit = { burst: 2, perSec: 1 };
  service = makeService();
  const browse = () => service.fetch(new Request(base + "/oauth/unknown"), { key: "office" }).then(r => r!.status);
  for (let i = 0; i < 2; i++) expect(await browse()).toBe(405);
  expect(await browse()).toBe(429);
  expect((await service.fetch(new Request(authorization().url), { key: "office" }))!.status).toBe(429);
  expect(await tokenPost("/oauth/token", { grant_type: "refresh_token", client_id: "native", refresh_token: tokens.refresh_token, resource: service.resource })).toBe(200);
});

// F-18 (#931): refused refreshes spread over a few addresses must not drain
// the org-wide bucket, and a drained global bucket must not block refresh.
test("a refused-refresh flood across addresses leaves the global bucket and every other address's refresh and sign-in alone", async () => {
  const tokens = await redeem(await issue()), second = await redeem(await issue());
  service.close(); config.oauthGlobalLimit = { burst: 5, perSec: 0.001 }; config.oauthLimit = { burst: 3, perSec: 0.001 };
  service = makeService();
  const refresh = (key: string, token: string) => service.fetch(new Request(base + "/oauth/token", { method: "POST",
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: "native", refresh_token: token, resource: service.resource }) }), { key }).then(r => r!.status);
  for (let a = 0; a < 20; a++) {
    for (let i = 0; i < 3; i++) expect(await refresh(`flood-${a}`, random())).toBe(400);
    expect(await refresh(`flood-${a}`, random())).toBe(429);
  }
  const scopes = () => storage.db.query<{ detail: string }, []>("SELECT detail FROM access_log WHERE action = 'oauth.rate_limited'").all().map(r => JSON.parse(r.detail).scope);
  expect(scopes()).toContain("token_address");
  expect(scopes()).not.toContain("global");
  // The org-wide bound that's left is on the refusal rows: at most the burst,
  // even past the address limiter's 10,000-key cap, where addresses go uncharged.
  for (let a = 0; a < 10_100; a++) expect(await refresh(`spread-${a}`, random())).toBe(400);
  const rows = (action: string) => storage.db.query(`SELECT 1 FROM access_log WHERE action = '${action}'`).all().length;
  expect(rows("oauth.request_refused")).toBe(5);
  // Past the cap a new address is neither charged nor refused.
  for (let i = 0; i < 70; i++) expect(await refresh("spread-10099", random())).toBe(400);
  // An unlisted client's two rows share one decision, made after every await:
  // a concurrent batch writes at most the refilled burst of each.
  clock += 10_000_000;
  const unlisted = (key: string) => service.fetch(new Request(base + "/oauth/token", { method: "POST",
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: "https://unlisted.example/client.json", refresh_token: random() }) }), { key }).then(r => r!.status);
  expect(await Promise.all(Array.from({ length: 20 }, (_, i) => unlisted(`unlisted-${i % 3}`)))).toEqual(Array(20).fill(401));
  expect(accessAudits(storage.db, "oauth.cimd_refused").map(a => a.detail)).toEqual(Array(5).fill({ reason: "not_allowed" }));
  expect(rows("oauth.request_refused")).toBe(10);
  expect(await refresh("office", tokens.refresh_token)).toBe(200);
  expect((await service.fetch(new Request(authorization().url), { key: "office" }))!.status).toBe(303);
  // The other direction: browser routes from several addresses drain the
  // global bucket; a refresh still goes through.
  for (let a = 0; a < 5; a++) await service.fetch(new Request(base + "/oauth/unknown"), { key: `browse-${a}` });
  expect((await service.fetch(new Request(base + "/oauth/unknown"), { key: "browse-x" }))!.status).toBe(429);
  expect(scopes()).toContain("global");
  expect(await refresh("office", second.refresh_token)).toBe(200);
});

// #274: an IPv6 caller's /48 is a second bucket beside its /64, SITE_LIMIT_FACTOR
// times the size, so a prefix rotating its /64s can't outrun the address
// limit or fill the key cap; IPv4 (site null) keys by address alone.
test("OAuth address buckets have a /48 sibling: rotating /64s drain it, other /48s and IPv4 are untouched", async () => {
  const tokens = await redeem(await issue());
  service.close(); config.oauthGlobalLimit = { burst: 1000, perSec: 0.001 }; config.oauthLimit = { burst: 2, perSec: 0.001 };
  service = makeService();
  const browse = (key: string, site: string | null) => service.fetch(new Request(base + "/oauth/unknown"), { key, site }).then(r => r!.status);
  // The /48 holds 2 x 4 = 8: four /64s spend it, the fifth is refused.
  for (let n = 0; n < 4; n++) for (let i = 0; i < 2; i++) expect(await browse(`2001:db8:1:${n}::/64`, "2001:db8:1::/48")).toBe(405);
  expect(await browse("2001:db8:1:9::/64", "2001:db8:1::/48")).toBe(429);
  expect(await browse("2001:db8:2:9::/64", "2001:db8:2::/48")).toBe(405);
  expect(await browse("192.0.2.1", null)).toBe(405);
  const limited = () => storage.db.query<{ target: string; detail: string }, []>("SELECT target, detail FROM access_log WHERE action = 'oauth.rate_limited'").all().map(r => [r.target, JSON.parse(r.detail).scope]);
  expect(limited()).toEqual([["2001:db8:1::/48", "site"]]);
  // A /64 refused by its own bucket doesn't spend its /48.
  for (let i = 0; i < 2; i++) expect(await browse("2001:db8:3:0::/64", "2001:db8:3::/48")).toBe(405);
  for (let i = 0; i < 20; i++) expect(await browse("2001:db8:3:0::/64", "2001:db8:3::/48")).toBe(429);
  for (let n = 1; n < 4; n++) for (let i = 0; i < 2; i++) expect(await browse(`2001:db8:3:${n}::/64`, "2001:db8:3::/48")).toBe(405);
  // Token posts: only refused grants spend, the token buckets and their own /48.
  const refresh = (key: string, site: string, token: string) => service.fetch(new Request(base + "/oauth/token", { method: "POST",
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: "native", refresh_token: token, resource: service.resource }) }), { key, site }).then(r => r!.status);
  for (let n = 0; n < 4; n++) for (let i = 0; i < 2; i++) expect(await refresh(`2001:db8:1:${n}::/64`, "2001:db8:1::/48", random())).toBe(400);
  expect(await refresh("2001:db8:1:9::/64", "2001:db8:1::/48", random())).toBe(429);
  expect(limited().map(([, scope]) => scope)).toContain("token_site");
  expect(await refresh("2001:db8:2:9::/64", "2001:db8:2::/48", tokens.refresh_token)).toBe(200);
});

// A page on another site can make every visitor's browser GET the browser
// routes as subresources (#404); only a top-level navigation, or a client that
// sends no Sec-Fetch-Mode, spends the address bucket.
test("browser-route GETs that aren't navigations cost nothing and reach no client lookup; navigations still spend and 429", async () => {
  service.close(); config = { ...config, oauthClients: [] }; config.oauthLimit = { burst: 2, perSec: 1 };
  const clientId = "https://opencode.ai/oauth/opencode/client.json";
  let reads = 0;
  service = makeService({ resolve: async () => [{ address: "93.184.216.34", family: 4 }], read: async () => { reads++; return JSON.stringify({ client_id: clientId, client_name: "OpenCode", redirect_uris: ["http://127.0.0.1/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] }); } });
  const url = authorization(clientId).url;
  const get = (target: string, mode?: string) => service.fetch(new Request(target, mode ? { headers: { "Sec-Fetch-Mode": mode } } : {}), { key: "office" }).then(r => r!.status);
  const rows = () => storage.db.query("SELECT 1 FROM access_log").all().length;
  const before = rows();
  for (let i = 0; i < 50; i++) for (const mode of ["no-cors", "cors", "same-origin", "websocket"]) {
    expect(await get(url, mode)).toBe(403);
    expect(await get(base + "/oauth/unknown", mode)).toBe(403);
  }
  expect(reads).toBe(0);
  expect(rows()).toBe(before);
  // The bucket is untouched: two navigations pass, the third is refused.
  expect(await get(url, "navigate")).toBe(303);
  expect(reads).toBe(1);
  expect(await get(url)).toBe(303);
  expect(await get(url, "navigate")).toBe(429);
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
  for (let i = 0; i < 60; i++) expect((await service.fetch(request, { key: "socket-peer" }))!.status).toBe(405);
  expect((await service.fetch(request, { key: "socket-peer" }))!.status).toBe(429);
  clock += 60_000;
  expect((await service.fetch(request, { key: "socket-peer" }))!.status).toBe(405);
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
test("URL-only SDK enrollment honors native challenge and obtains one tools+delivery grant", async () => {
  const provider = new Provider();
  const client = new Client({ name: "url-only", version: "1" }, { supportedProtocolVersions: ["2026-07-28"], versionNegotiation: { mode: { pin: "2026-07-28" } } });
  liveClients.push(client);
  await expect(client.connect(new StreamableHTTPClientTransport(new URL(service.resource), { authProvider: provider }))).rejects.toThrow();
  expect(provider.authorization!.searchParams.get("scope")).toBe("grayboard:delivery grayboard:tools");
  const browser = new Browser(), consent = await loginConsent(browser, provider.authorization!.href);
  const approved = await decide(browser, consent), callback = new URL(approved.headers.get("location")!);
  expect(await auth(provider, { serverUrl: service.resource, authorizationCode: callback.searchParams.get("code")!, iss: callback.searchParams.get("iss")! })).toBe("AUTHORIZED");
  expect((await principal(provider.saved as Tokens, ["grayboard:tools", "grayboard:delivery"])).scopes).toEqual(["grayboard:delivery", "grayboard:tools"]);
  expect(storage.db.query<{ count: number }, []>("SELECT count(*) AS count FROM oauth_grants").get()?.count).toBe(1);
});

test("official SDK binds one canonical default-port resource while preserving exact configured issuer and iss", async () => {
  const publicUrl = "https://grayboard.example.com:443/hosted";
  service.close();
  service = createOAuthServer(storage.repo, { ...config, publicUrl, devAuth: false }, { now: () => clock, providers: [stubProvider(async input => {
    expect(input.redirectUri).toBe(publicUrl + "/oauth/google/callback"); return { email: "you@example.com", displayName: "You", subject: "google-you@example.com" };
  })] });
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
  const data = consentForm(content);
  const approved = await browser.request(base + "/hosted/oauth/consent", { method: "POST", headers: { Origin: "https://grayboard.example.com" }, body: new URLSearchParams({ ...data, decision: "approve" }) });
  const returned = new URL(approved.headers.get("Location")!);
  expect(returned.searchParams.get("iss")).toBe(publicUrl); expect(returned.searchParams.get("state")).toBe(provider.stateValue);
  const wrongResource = await post("/oauth/token", { grant_type: "authorization_code", client_id: "subscriber", code: returned.searchParams.get("code")!, code_verifier: provider.verifier, redirect_uri: provider.redirectUrl, resource: publicUrl + "/mcp" });
  expect(wrongResource.status).toBe(400);
  await expect(auth(provider, { serverUrl: service.resource, fetchFn, authorizationCode: returned.searchParams.get("code")!, iss: new URL(publicUrl).href })).rejects.toThrow();
  expect(await auth(provider, { serverUrl: service.resource, fetchFn, authorizationCode: returned.searchParams.get("code")!, iss: publicUrl })).toBe("AUTHORIZED");
  expect(provider.saved!.issuer).toBe(publicUrl); expect((await principal(provider.saved as Tokens)).clientId).toBe("subscriber");
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

test("#853: a cached authorization ends with the write that ends it, from this connection or another, and a rolled-back write leaves it standing", async () => {
  const { Database } = await import("bun:sqlite");
  const mint = async (email: string) => {
    const { token } = await issueOAuth(storage.repo, service.resource, email, ["grayboard:tools"], clock, "native");
    const p = await service.authenticate(new Request(base + "/mcp", { headers: { Authorization: `Bearer ${token}` } }));
    if (p instanceof Response) throw new Error(`authenticate refused: ${p.status}`);
    return Object.assign(p, { bearer: new Request(base + "/mcp", { headers: { Authorization: `Bearer ${token}` } }) });
  };
  const refused = async (r: Request) => { const a = await service.authenticate(r.clone()); return a instanceof Response && a.status === 401; };
  // The cache sits under repo.oauth.findActiveAccess, so count the join's SQL rather than the method.
  const query = spyOn(Database.prototype, "query");
  try {
    const joins = () => query.mock.calls.filter(([sql]) => String(sql).includes("FROM oauth_tokens t")).length;
    const p = await mint("cached@example.com");
    query.mockClear();
    for (let i = 0; i < 10; i++) expect(await service.isAuthorized(p)).toBe(true);
    expect(joins()).toBe(0); // warm: no token join while nothing has changed
    // A write inside a transaction that rolls back: false within it, true again after.
    await expect(seed(storage.repo, async tx => {
      await storage.repo.sessions.revokeAllForUser(tx, p.authed.user_id);
      expect(await service.isAuthorized(p, tx)).toBe(false);
      throw new Error("roll back");
    })).rejects.toThrow("roll back");
    expect(await service.isAuthorized(p)).toBe(true);
    expect(joins()).toBeGreaterThan(0); // the read inside the transaction bypassed the cache, so the spy sees the join
    // Each committed way the access ends, against a warm entry.
    const ends: [string, (p: OAuthPrincipal) => unknown][] = [
      ["revokeAllForUser", p => seed(storage.repo, tx => storage.repo.sessions.revokeAllForUser(tx, p.authed.user_id))],
      ["disable", p => seed(storage.repo, tx => storage.repo.users.setDisabled(tx, p.authed.user_id, true))],
      ["another connection's grant revoke", p => { const other = new Database(config.dbPath); try { other.run("UPDATE oauth_grants SET revoked_at = ? WHERE id = ?", [clock, p.grantId]); } finally { other.close(); } }],
      ["another connection's token delete", p => { const other = new Database(config.dbPath); try { other.run("DELETE FROM oauth_tokens WHERE hash = ?", [p.accessHash]); } finally { other.close(); } }],
    ];
    for (const [i, [what, end]] of ends.entries()) {
      const q = await mint(`end${i}@example.com`);
      expect(await service.isAuthorized(q)).toBe(true);
      await end(q);
      expect(await service.isAuthorized(q), what).toBe(false);
      expect(await refused(q.bearer), what).toBe(true); // the bearer's own warm entry, not just the principal check
    }
    // Expiry needs no write: the entry's own deadline ends it.
    const e = await mint("expiry@example.com");
    expect(await service.isAuthorized(e)).toBe(true);
    expect(await refused(e.bearer)).toBe(false);
    clock = e.accessExpiry;
    expect(await service.isAuthorized(e)).toBe(false);
    expect(await refused(e.bearer)).toBe(true); // isAuthorized checks the principal's expiry first; authenticate reaches the entry's
  } finally { query.mockRestore(); }
});

test("#881: one authorization reads the auth generation once, and a write between two still ends the second", async () => {
  const { Database } = await import("bun:sqlite");
  // The generation's statements are prepared once, when the database opens: open one under a spy that counts runs.
  let reads = 0;
  const query = Database.prototype.query;
  const spy = spyOn(Database.prototype, "query").mockImplementation(function (this: InstanceType<typeof Database>, sql: string) {
    const statement = query.call(this, sql);
    if (sql === "PRAGMA data_version") { const get = statement.get.bind(statement); statement.get = (...args: never[]) => { reads++; return get(...args); }; }
    return statement;
  } as typeof query);
  const counted = (() => { try { return openDatabase(config.dbPath, { blobDir: config.blobDir }); } finally { spy.mockRestore(); } })();
  const saved = storage;
  storage = counted;
  const counting = makeService();
  storage = saved;
  try {
    const { token } = await issueOAuth(counted.repo, counting.resource, "generation@example.com", ["grayboard:tools"], clock, "native");
    const p = await counting.authenticate(new Request(base + "/mcp", { headers: { Authorization: `Bearer ${token}` } }));
    if (p instanceof Response) throw new Error(`authenticate refused: ${p.status}`);
    expect(await counting.isAuthorized(p)).toBe(true);
    reads = 0;
    expect(await counting.isAuthorized(p)).toBe(true);
    expect(reads).toBe(1); // the token read and the user read share it; before #881, two
    await seed(counted.repo, tx => counted.repo.users.setDisabled(tx, p.authed.user_id, true));
    expect(await counting.isAuthorized(p)).toBe(false);
  } finally { counting.close(); counted.db.close(); }
});

// ── #928 step 3: CLI login through the AS (docs/server-oauth.md §2, CLI login) ──────────────────────────────────

// An authorize URL as `grayboard login` builds it: grayboard-cli's login scope and no resource (open question 4).
function cliAuthorization(clientId = CLI_CLIENT_ID, scope = LOGIN_SCOPE, verifier = random(), redirectUri = "http://127.0.0.1:45123/callback") {
  const state = random();
  const url = base + "/oauth/authorize?" + new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope, state, code_challenge: s256(verifier), code_challenge_method: "S256" });
  return { url, verifier, state, clientId, redirectUri, scope };
}
async function cliCode(browser = new Browser()) {
  const a = cliAuthorization();
  const consent = await loginConsent(browser, a.url);
  const decided = await decide(browser, consent);
  expect(decided.status).toBe(303);
  const callback = new URL(decided.headers.get("location")!);
  expect(callback.searchParams.get("state")).toBe(a.state);
  return { ...a, code: callback.searchParams.get("code")!, consent };
}
const cliTokenParams = (a: Awaited<ReturnType<typeof cliCode>>) => ({ grant_type: "authorization_code", client_id: CLI_CLIENT_ID, code: a.code, code_verifier: a.verifier, redirect_uri: a.redirectUri });
// The authorize refusal a client's redirect carries, or "sign-in" when the request went on to the IdP.
async function authorizeError(url: string): Promise<string | null> {
  const r = await new Browser().request(url);
  expect(r.status).toBe(303);
  const location = new URL(r.headers.get("location")!);
  return location.hostname === "accounts.google.com" ? "sign-in" : location.searchParams.get("error");
}
const touches = { schedule: () => {}, cancelAll: () => {} };

test("R3: no client but grayboard-cli obtains grayboard:login, and it never travels with another scope", async () => {
  expect((OAUTH_SCOPES as readonly string[]).includes(LOGIN_SCOPE)).toBe(false);
  // A built-in, an operator client and a CIMD client each asking for it.
  for (const clientId of [...BUILTIN_CLIENT_IDS, "native", "subscriber"]) expect(await authorizeError(cliAuthorization(clientId).url)).toBe("invalid_scope");
  service.close();
  const cimdId = "https://client.example/metadata.json";
  service = makeService({ resolve: async () => [{ address: "93.184.216.34", family: 4 }], read: async () => JSON.stringify({ client_id: cimdId, client_name: "CIMD", redirect_uris: ["http://127.0.0.1/callback"], token_endpoint_auth_method: "none", scope: LOGIN_SCOPE }) });
  expect(await authorizeError(cliAuthorization(cimdId).url)).toBe("invalid_scope");
  expect(await authorizeError(cliAuthorization(cimdId, "grayboard:tools").url)).toBe("sign-in");
  expect(await authorizeError(cliAuthorization().url)).toBe("sign-in");
  // grayboard-cli mixing it with another scope, or asking for an OAUTH_SCOPES member.
  for (const scope of [`${LOGIN_SCOPE} grayboard:tools`, `grayboard:delivery ${LOGIN_SCOPE}`, "grayboard:tools", "grayboard:delivery grayboard:tools"]) {
    expect(await authorizeError(cliAuthorization(CLI_CLIENT_ID, scope).url)).toBe("invalid_scope");
  }
  // A refresh can't widen a grant to it.
  const a = await issue("subscriber", "grayboard:delivery grayboard:tools");
  const tokens = await redeem(a);
  expect(await (await post("/oauth/token", { grant_type: "refresh_token", client_id: "subscriber", refresh_token: tokens.refresh_token, scope: LOGIN_SCOPE })).json()).toEqual({ error: "invalid_scope" });
  // Nothing advertises it.
  const metadata = await (await fetch(base + "/.well-known/oauth-authorization-server")).json();
  expect(metadata.scopes_supported).not.toContain(LOGIN_SCOPE);
  expect(metadata.grayboard_builtin_clients).not.toContain(CLI_CLIENT_ID);
  // The client ID alone is advertised, so the CLI tells a pre-#928 server apart before opening a browser (#991).
  expect(metadata.grayboard_cli_client).toBe(CLI_CLIENT_ID);
  expect(storage.db.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
});

test("R3: an operator client can't take grayboard-cli's ID", () => {
  const entry = { clientId: CLI_CLIENT_ID, name: "Mine", redirectUris: ["http://127.0.0.1/callback"], scopes: ["grayboard:tools"], tokenEndpointAuthMethod: "none" };
  expect(() => parseOAuthClients(JSON.stringify([entry]))).toThrow(`OAuth client ID ${CLI_CLIENT_ID} is reserved`);
  expect(() => createOAuthServer(storage.repo, { ...config, oauthClients: [entry as OAuthClient] })).toThrow("reserved");
});

test("a login code redeems once for a CLI session token: no refresh, no expiry, valid on the API", async () => {
  const a = await cliCode();
  // The consent page names what's granted, not the resource the code is stored with.
  expect(a.consent.content).toContain("Authorize Grayboard for the CLI");
  expect(a.consent.content).toContain("a grayboard CLI sign-in");
  expect(a.consent.content).not.toContain("Resource:");
  const r = await post("/oauth/token", cliTokenParams(a), { "User-Agent": "grayboard-test" });
  expect(r.status).toBe(200);
  const body = await r.json() as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(["access_token", "scope", "token_type"]);
  expect(body).toMatchObject({ token_type: "Bearer", scope: LOGIN_SCOPE });
  const token = body.access_token as string;
  expect(token).toStartWith("gbrd_v1_");
  const authed = await verifySessionToken(token, storage.repo, touches, 30);
  expect(authed).toMatchObject({ user_email: "you@example.com" });
  expect(await storage.repo.sessions.findById(storage.repo.read, authed!.session_id)).toMatchObject({ label: "grayboard-test", revoked_at: null });
  // Not an OAuth access token.
  expect(await service.authenticate(new Request(base + "/mcp", { headers: { Authorization: `Bearer ${token}` } }))).toBeInstanceOf(Response);
  expect(storage.db.query("SELECT COUNT(*) AS n FROM oauth_grants").get()).toEqual({ n: 0 });
  expect(accessAudits(storage.db, "oauth.session_issued")).toEqual([expect.objectContaining({ actor: "you@example.com", detail: { client_id: CLI_CLIENT_ID, token_session: authed!.session_id } })]);
  // The client has no refresh, and the code's other parameters are bound.
  expect(await (await post("/oauth/token", { grant_type: "refresh_token", client_id: CLI_CLIENT_ID, refresh_token: random() })).json()).toEqual({ error: "invalid_grant" });
});

test("a replayed login code revokes its session and audits oauth.code_replay_revoked", async () => {
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const a = await cliCode();
    const first = await post("/oauth/token", cliTokenParams(a));
    const token = (await first.json() as { access_token: string }).access_token;
    const authed = (await verifySessionToken(token, storage.repo, touches, 30))!;
    expect(authed).not.toBeNull();
    // Kept past its expiry while the session lives, so a late replay is still caught.
    clock += OAUTH_TTL.code + 1;
    await seed(storage.repo, tx => storage.repo.oauth.cleanup(tx, clock));
    const again = await post("/oauth/token", cliTokenParams(a));
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: "invalid_grant" });
    expect(await verifySessionToken(token, storage.repo, touches, 30)).toBeNull();
    expect((await storage.repo.sessions.findById(storage.repo.read, authed.session_id))!.revoked_at).not.toBeNull();
    expect(accessAudits(storage.db, "oauth.code_replay_revoked")).toEqual([expect.objectContaining({ actor: "you@example.com", detail: { client_id: CLI_CLIENT_ID, token_session: authed.session_id, level: "warning" } })]);
    // With its session revoked the spent code goes at the next sweep.
    await seed(storage.repo, tx => storage.repo.oauth.cleanup(tx, clock));
    expect(storage.db.query("SELECT COUNT(*) AS n FROM oauth_codes").get()).toEqual({ n: 0 });
  } finally { warning.mockRestore(); }
});

test("a login code, spent or not, never becomes a grant, and a grant code never a session", async () => {
  const a = await cliCode();
  const binding = { clientId: CLI_CLIENT_ID, resource: service.resource, scopes: [LOGIN_SCOPE], redirectUri: a.redirectUri, codeChallenge: s256(a.verifier), codeHash: hashToken(a.code) };
  const asGrant = () => seed(storage.repo, tx => storage.repo.oauth.redeemCode(tx, { ...binding, grantId: random(), grantExpiresAt: clock + OAUTH_TTL.grant,
    tokens: { clientId: CLI_CLIENT_ID, resource: service.resource, scopes: [LOGIN_SCOPE], accessHash: hashToken(random()), refreshHash: hashToken(random()), accessExpiresAt: clock + OAUTH_TTL.access, refreshExpiresAt: clock + OAUTH_TTL.refresh } }, clock));
  expect((await asGrant()).status).toBe("invalid");
  expect((await post("/oauth/token", cliTokenParams(a))).status).toBe(200);
  expect((await asGrant()).status).toBe("invalid");
  expect(storage.db.query("SELECT COUNT(*) AS n FROM oauth_grants").get()).toEqual({ n: 0 });
  // The reverse: a grant code presented to the login redeemer.
  const g = await issue("native", "grayboard:tools");
  const grantBinding = { clientId: "native", resource: service.resource, scopes: ["grayboard:tools"], redirectUri: g.redirectUri, codeChallenge: s256(g.verifier), codeHash: hashToken(g.code) };
  expect((await seed(storage.repo, tx => storage.repo.oauth.redeemLoginCode(tx, { ...grantBinding, tokenHash: hashToken(random()), label: null }, clock))).status).toBe("invalid");
  expect((await post("/oauth/token", tokenParams(g))).status).toBe(200);
});

test("a login code is refused with a wrong verifier, redirect or client, and for a disabled user, as grant codes are", async () => {
  const a = await cliCode();
  for (const params of [{ code_verifier: random() }, { redirect_uri: "http://127.0.0.1:45124/callback" }, { client_id: "grayboard-pi" }, { code: random() }]) {
    const r = await post("/oauth/token", { ...cliTokenParams(a), ...params });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "invalid_grant" });
  }
  // None of those spent it; a disabled user's still can't redeem it (the row is kept to exercise the check).
  const user = (await storage.repo.users.findByEmail(storage.repo.read, "you@example.com"))!;
  await seed(storage.repo, () => storage.db.run("UPDATE users SET disabled_at = ? WHERE id = ?", [clock, user.id]));
  expect((await post("/oauth/token", cliTokenParams(a))).status).toBe(400);
  await seed(storage.repo, () => storage.db.run("UPDATE users SET disabled_at = NULL WHERE id = ?", [user.id]));
  expect((await post("/oauth/token", cliTokenParams(a))).status).toBe(200);
  expect(storage.db.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 });
  // An expired, unspent login code is refused.
  const late = await cliCode();
  clock += OAUTH_TTL.code + 1;
  expect((await post("/oauth/token", cliTokenParams(late))).status).toBe(400);
});

test("the grayboard-cli cutover revokes earlier grants and pending codes under its ID once per database", async () => {
  service.close();
  await seed(storage.repo, () => storage.db.run("DELETE FROM server_state WHERE key = 'builtin_clients_cli'"));
  const old = await issueOAuth(storage.repo, service.resource, "op@example.com", ["grayboard:tools"], clock, CLI_CLIENT_ID);
  const other = await issueOAuth(storage.repo, service.resource, "op@example.com", ["grayboard:tools"], clock, "native");
  const user = (await storage.repo.users.findByEmail(storage.repo.read, "op@example.com"))!;
  const pending = (clientId: string) => seed(storage.repo, () => storage.db.run("INSERT INTO oauth_codes(hash, user_id, expires_at, data) VALUES (?, ?, ?, ?)",
    [hashToken(random()), user.id, clock + OAUTH_TTL.code, JSON.stringify({ clientId, resource: service.resource, scopes: ["grayboard:tools"], redirectUri: "http://127.0.0.1/callback", codeChallenge: random() })]));
  await pending(CLI_CLIENT_ID); await pending("native");
  const log = spyOn(console, "error").mockImplementation(() => {});
  let logged: string;
  try { service = makeService(); await service.ready; logged = log.mock.calls.flat().join("\n"); } finally { log.mockRestore(); }
  expect(await service.isGrantActive(old.grantId)).toBe(false);
  expect(await service.isGrantActive(other.grantId)).toBe(true);
  const codes = () => storage.db.query<{ client: string }, []>("SELECT json_extract(data, '$.clientId') AS client FROM oauth_codes WHERE grant_id IS NULL").all().map(r => r.client);
  expect(codes()).toEqual(["native"]);
  expect(accessAudits(storage.db, "oauth.builtin_client_grant_revoked").map(r => r.detail)).toEqual([{ client_id: CLI_CLIENT_ID }]);
  expect(logged).toContain(`revoked 1 OAuth grant(s) issued under ${CLI_CLIENT_ID}`);
  // A later open leaves later rows alone, even ones an operator downgrade made.
  service.close();
  const later = await issueOAuth(storage.repo, service.resource, "op@example.com", ["grayboard:tools"], clock, CLI_CLIENT_ID);
  await pending(CLI_CLIENT_ID);
  service = makeService(); await service.ready;
  expect(await service.isGrantActive(later.grantId)).toBe(true);
  expect(codes().sort()).toEqual([CLI_CLIENT_ID, "native"]);
});

// #971: a code, refresh token or consent request that expires while its write waits in the write queue is refused: the
// body judges expiry against the clock it reads at its write, not one read before the wait.
async function expiresWhileQueued(bump: number, act: () => Promise<Response>): Promise<Response> {
  let release: (() => void) | undefined;
  const held = queueFor(storage.db).run(() => new Promise<void>(r => { release = r; }));
  const write = storage.repo.write;
  let entered = false;
  storage.repo.write = ((...args: Parameters<typeof write>) => { entered = true; return write.apply(storage.repo, args); }) as typeof write;
  let response: Promise<Response> | undefined;
  try {
    response = act();
    response.catch(() => {}); // a failed wait below is the test's error, not an unhandled rejection
    await until(() => entered, 5000, "the route reaches its write");
    clock += bump;
  } finally { storage.repo.write = write; release?.(); await held; }
  return response;
}
for (const grant of ["authorization_code", "refresh_token"] as const) test(`#971: ${grant === "authorization_code" ? "a code" : "a refresh token"} that expires while its redemption waits behind another write body is refused`, async () => {
  const a = await issue();
  const params = grant === "authorization_code" ? tokenParams(a)
    : { client_id: "native", grant_type: "refresh_token", refresh_token: (await redeem(a)).refresh_token, resource: service.resource };
  const response = await expiresWhileQueued(grant === "authorization_code" ? OAUTH_TTL.code : OAUTH_TTL.refresh, () => post("/oauth/token", params));
  expect(response.status).toBe(400);
});
test("#971: a consent decision whose request expires while it waits behind another write body is refused", async () => {
  const browser = new Browser();
  const data = await loginConsent(browser, authorization().url);
  expect((await expiresWhileQueued(OAUTH_TTL.request, () => decide(browser, data))).status).toBe(400);
});
