import { afterEach, beforeEach, expect, test } from "bun:test";
import { auth, Client, StreamableHTTPClientTransport, type OAuthClientProvider, type OAuthDiscoveryState, type StoredOAuthTokens } from "@modelcontextprotocol/client";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../src/server/app.ts";
import { MCP_PROTOCOL_VERSIONS } from "../../src/server/mcp.ts";
import { bindFixture, OPENCODE_CLIENT, withSessionMeta } from "../helpers/hosted.ts";

const issuer = "https://grayboard.example.com:443/hosted";
const resource = "https://grayboard.example.com/hosted/mcp";
const redirectUrl = "http://127.0.0.1:34567/callback";
let app: ReturnType<typeof startServer>, base: string, dir: string;
const clients: Client[] = [];
let exchanges = 0;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gb-oauth-server-"));
  exchanges = 0;
  app = startServer({ dbPath: join(dir, "db.sqlite"), blobDir: join(dir, "blobs"), httpPort: 0,
    googleClientId: "test-upstream", googleClientSecret: "", orgDomain: "example.com", publicUrl: issuer,
    messageRetentionDays: 90, auditRetentionDays: 90, devAuth: false, admins: [],
    oauthClients: [{ clientId: OPENCODE_CLIENT, name: "Native fixture", redirectUris: [redirectUrl], scopes: ["grayboard:tools", "grayboard:delivery"], tokenEndpointAuthMethod: "none", allowRefresh: true }],
  }, { hostname: "127.0.0.1", background: false, oauth: { exchangeGoogle: async input => {
    exchanges++;
    expect(input.redirectUri).toBe(issuer + "/oauth/google/callback");
    expect(input.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(input.nonce.length).toBeGreaterThan(30);
    return { email: "alice@example.com", displayName: "Alice" };
  } } });
  base = `http://127.0.0.1:${app.server.port}`;
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => c.close()));
  await app.stop();
  expect(app.mcp.activeContexts).toBe(app.mcp.activeGetStreams);
  app.db.close();
  rmSync(dir, { recursive: true, force: true });
});
const mapped = (url: string) => {
  const u = new URL(url);
  expect(u.origin).toBe("https://grayboard.example.com");
  return base + u.pathname + u.search;
};
const fetchFn = (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init);
  return fetch(new Request(mapped(req.url), req));
};
class Provider implements OAuthClientProvider {
  redirectUrl = redirectUrl;
  clientMetadata = { client_name: "Native fixture", redirect_uris: [redirectUrl], token_endpoint_auth_method: "none" as const };
  saved?: StoredOAuthTokens;
  verifier = "";
  authorization?: URL;
  discovery?: OAuthDiscoveryState;
  stateValue = randomBytes(32).toString("base64url");
  state() { return this.stateValue; }
  clientInformation() { return { client_id: OPENCODE_CLIENT, issuer }; }
  tokens() { return this.saved; }
  saveTokens(tokens: StoredOAuthTokens) { this.saved = tokens; }
  redirectToAuthorization(url: URL) { this.authorization = url; }
  saveCodeVerifier(verifier: string) { this.verifier = verifier; }
  codeVerifier() { return this.verifier; }
  saveDiscoveryState(discovery: OAuthDiscoveryState) { this.discovery = discovery; }
  discoveryState() { return this.discovery; }
}
class Browser {
  cookies = new Map<string, string>();
  async request(url: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("Cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await fetch(mapped(url), { ...init, headers, redirect: "manual" });
    for (const cookie of res.headers.getSetCookie()) {
      const [key, value] = cookie.split(";")[0]!.split("=");
      this.cookies.set(key!, value!);
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("Path=/hosted/oauth");
    }
    return res;
  }
}

test("AS metadata is mounted on the single production listener with canonical resource and exact issuer", async () => {
  const challenge = await fetch(base + "/hosted/mcp", { headers: { "X-Forwarded-Host": "evil.example.com", "X-Real-IP": "192.0.2.1" } });
  expect(challenge.status).toBe(401);
  expect(challenge.headers.get("WWW-Authenticate")).toContain('resource_metadata="https://grayboard.example.com/.well-known/oauth-protected-resource/hosted/mcp"');
  for (const path of ["/.well-known/oauth-protected-resource/hosted/mcp", "/hosted/.well-known/oauth-protected-resource/hosted/mcp"]) {
    const res = await fetch(base + path);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ resource, authorization_servers: [issuer], scopes_supported: ["grayboard:delivery", "grayboard:tools"] });
  }
  const metadata = await fetch(base + "/.well-known/oauth-authorization-server/hosted");
  expect(await metadata.json()).toMatchObject({ issuer, authorization_endpoint: issuer + "/oauth/authorize", token_endpoint: issuer + "/oauth/token" });
  const old = await fetch(base + "/api/auth/config");
  expect(old.status).toBe(200);
});

for (const version of MCP_PROTOCOL_VERSIONS) test(`${version}: real SDK OAuth code/S256/state/iss and tools through production app`, async () => {
  const provider = new Provider();
  expect(await auth(provider, { serverUrl: resource, fetchFn })).toBe("REDIRECT");
  expect(provider.authorization!.searchParams.get("resource")).toBe(resource);
  expect(provider.authorization!.searchParams.get("code_challenge_method")).toBe("S256");
  expect(provider.authorization!.searchParams.get("state")).toBe(provider.stateValue);
  expect(provider.authorization!.searchParams.get("scope")).toBe("grayboard:delivery grayboard:tools");
  const browser = new Browser();
  const begin = await browser.request(provider.authorization!.href);
  expect(begin.status).toBe(303);
  const google = new URL(begin.headers.get("Location")!);
  expect(google.origin).toBe("https://accounts.google.com");
  const callback = await browser.request(issuer + "/oauth/google/callback?" + new URLSearchParams({ code: "test-google-code", state: google.searchParams.get("state")!, iss: "https://accounts.google.com" }));
  expect(callback.status).toBe(303);
  const page = await browser.request(callback.headers.get("Location")!);
  expect(page.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  expect(page.headers.get("Cache-Control")).toContain("no-store");
  const html = await page.text();
  const request = /name="request" value="([^"]+)"/.exec(html)![1]!;
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
  const approved = await browser.request(issuer + "/oauth/consent", { method: "POST", headers: { Origin: "https://grayboard.example.com" }, body: new URLSearchParams({ request, csrf, decision: "approve" }) });
  expect(approved.status).toBe(303);
  const returned = new URL(approved.headers.get("Location")!);
  expect(returned.searchParams.get("state")).toBe(provider.stateValue);
  expect(returned.searchParams.get("iss")).toBe(issuer);
  await expect(auth(provider, { serverUrl: resource, fetchFn, authorizationCode: returned.searchParams.get("code")!, iss: new URL(issuer).href })).rejects.toThrow();
  expect(await auth(provider, { serverUrl: resource, fetchFn, authorizationCode: returned.searchParams.get("code")!, iss: issuer })).toBe("AUTHORIZED");
  expect(provider.saved!.refresh_token).toBeTruthy();
  const client = new Client({ name: "production-oauth-fixture", version: "1" }, { supportedProtocolVersions: [version], versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" } });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(resource), {
    authProvider: provider,
    fetch: async (input, init) => fetchFn(await withSessionMeta(new Request(input, init), "oauth-root")),
  }));
  await bindFixture(client, "be");
  expect(client.getNegotiatedProtocolVersion()).toBe(version);
  expect((await client.listTools()).tools.map(t => t.name)).toContain("board_create");
  expect(client.getServerCapabilities()?.resources).toEqual({ subscribe: true });
  const result = await client.callTool({ name: "peer_list", arguments: {} });
  expect(result.isError).not.toBe(true);
  expect(JSON.stringify(result)).toContain("alice@example.com/be");
  expect(exchanges).toBe(1);
  expect(app.mcp.activeContexts).toBe(app.mcp.activeGetStreams);
});
