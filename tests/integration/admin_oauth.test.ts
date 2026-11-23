// The admin dashboard's sign-in (#1651 D4): grayboard-admin runs the browser flow to /admin/callback, its token lasts
// an hour with no refresh, it reads the GET dashboard routes and nothing else (no other /api route, no admin write,
// no MCP), the gate still authorizes its user on each read, and every /admin response carries the page's CSP.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { hostedServer, upstreamLeg, type HostedServer } from "../support/hosted_oauth.ts";
import { Browser, consentForm, submitConsent } from "../support/oauth_browser.ts";
import { row } from "../support/repo_sql.ts";
import { ADMIN_CLIENT_ID, ADMIN_SCOPE, ADMIN_TOKEN_TTL, OAUTH_SCOPES, parseOAuthClients } from "../../src/server/oauth-config.ts";
import { ADMIN_CSP } from "../../src/server/admin_page.ts";

const ROOT = "root@example.com";
let srv: HostedServer | undefined;
afterEach(async () => { await srv?.stop(); srv = undefined; });

const verifier = () => randomBytes(32).toString("base64url");
const challenge = (v: string) => createHash("sha256").update(v).digest("base64url");
function authorizeUrl(issuer: string, v: string, over: Record<string, string> = {}) {
  return `${issuer}/oauth/authorize?` + new URLSearchParams({ response_type: "code", client_id: ADMIN_CLIENT_ID, redirect_uri: `${issuer}/admin/callback`,
    scope: ADMIN_SCOPE, state: "s1", code_challenge: challenge(v), code_challenge_method: "S256", ...over });
}
// The flow a signed-in browser runs: authorize, the stubbed upstream leg, consent, the redirect to /admin/callback.
async function adminCode(s: HostedServer, v: string): Promise<{ code: string; consent: string }> {
  const browser = new Browser();
  const callback = await upstreamLeg(browser, s.issuer, await browser.request(authorizeUrl(s.issuer, v)));
  const consent = await (await browser.request(callback.headers.get("Location")!)).text();
  const decided = await submitConsent(browser, `${s.issuer}/oauth/consent`, consentForm(consent));
  expect(decided.status).toBe(303);
  const back = new URL(decided.headers.get("Location")!);
  expect(back.origin + back.pathname).toBe(`${s.issuer}/admin/callback`);
  return { code: back.searchParams.get("code")!, consent };
}
const redeem = (s: HostedServer, code: string, v: string) => fetch(`${s.issuer}/oauth/token`, { method: "POST", headers: { Origin: s.issuer, "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", client_id: ADMIN_CLIENT_ID, code, code_verifier: v, redirect_uri: `${s.issuer}/admin/callback` }) });
async function adminToken(s: HostedServer): Promise<{ token: string; body: Record<string, unknown>; consent: string; before: number }> {
  const v = verifier();
  const { code, consent } = await adminCode(s, v);
  const before = Date.now();
  const res = await redeem(s, code, v);
  expect(res.status).toBe(200);
  const body = await res.json() as Record<string, unknown>;
  return { token: body.access_token as string, body, consent, before };
}
const bearer = (s: HostedServer, token: string, method: string, path: string, body?: unknown) => fetch(s.issuer + path, { method,
  headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
// Where an authorize request with these overrides is sent back to, refused: its error, or the status when the server
// answers it itself (a redirect it won't follow).
async function authorizeRefusal(s: HostedServer, over: Record<string, string>): Promise<string> {
  const res = await new Browser().request(authorizeUrl(s.issuer, verifier(), over));
  const location = res.headers.get("Location");
  return location && new URL(location).searchParams.get("error") || String(res.status);
}

describe("grayboard-admin", () => {
  test("an org_admin signs in, gets a one-hour token with no refresh, and reads the dashboard routes", async () => {
    srv = await hostedServer({ admins: [ROOT] }, ROOT);
    const { token, body, consent, before } = await adminToken(srv);
    expect(consent).toContain("Authorize Grayboard admin dashboard");
    expect(consent).toContain("read-only access to this server's admin dashboard");
    expect(body.scope).toBe(ADMIN_SCOPE);
    expect(body.expires_in).toBeLessThanOrEqual(ADMIN_TOKEN_TTL / 1000);
    expect(body.expires_in).toBeGreaterThan(ADMIN_TOKEN_TTL / 1000 - 60);
    expect(body).not.toHaveProperty("refresh_token");
    // The grant lasts as long as its token: no 90-day row per sign-in.
    const grant = await row<{ expires_at: number }>(srv, "SELECT expires_at FROM oauth_grants WHERE revoked_at IS NULL ORDER BY expires_at DESC LIMIT 1");
    expect(Number(grant!.expires_at)).toBeGreaterThanOrEqual(before + ADMIN_TOKEN_TTL);
    expect(Number(grant!.expires_at)).toBeLessThanOrEqual(Date.now() + ADMIN_TOKEN_TTL);
    for (const path of ["/api/admin/users", "/api/admin/claims", "/api/admin/audit"]) expect((await bearer(srv, token, "GET", path)).status).toBe(200);
  });

  test("its token reads nothing else: no other /api route, no admin write or non-dashboard GET, no MCP", async () => {
    srv = await hostedServer({ admins: [ROOT] }, ROOT);
    const { token } = await adminToken(srv);
    expect((await bearer(srv, token, "GET", "/api/whoami")).status).toBe(401);
    expect((await bearer(srv, token, "GET", "/api/admin/roles")).status).toBe(401);
    expect((await bearer(srv, token, "POST", "/api/admin/disable-user", { email: "x@example.com" })).status).toBe(401);
    expect((await bearer(srv, token, "POST", "/api/admin/roles/grant", { role: "org_admin", principal: "x@example.com" })).status).toBe(401);
    const mcp = await fetch(srv.resource, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) });
    expect(mcp.status).toBe(403);
    expect(mcp.headers.get("WWW-Authenticate")).toContain("insufficient_scope");
    // No refresh grant: the token endpoint refuses one for this client whatever it presents.
    const refresh = await fetch(`${srv.issuer}/oauth/token`, { method: "POST", headers: { Origin: srv.issuer, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: ADMIN_CLIENT_ID, refresh_token: verifier() }) });
    expect((await refresh.json() as { error: string }).error).toBe("invalid_grant");
  });

  test("the gate still decides: a signed-in non-admin's token is refused with 403", async () => {
    srv = await hostedServer({ admins: [ROOT] }, "alice@example.com");
    const { token } = await adminToken(srv);
    expect((await bearer(srv, token, "GET", "/api/admin/users")).status).toBe(403);
  });

  test("its scope is its own and alone, and its one redirect is /admin/callback", async () => {
    srv = await hostedServer({ admins: [ROOT] }, ROOT);
    expect(await authorizeRefusal(srv, { scope: "grayboard:tools" })).toBe("invalid_scope");
    expect(await authorizeRefusal(srv, { scope: `${ADMIN_SCOPE} grayboard:tools` })).toBe("invalid_scope");
    expect(await authorizeRefusal(srv, { client_id: "grayboard-pi", redirect_uri: "http://127.0.0.1:4567/callback" })).toBe("invalid_scope");
    expect(await authorizeRefusal(srv, { client_id: "grayboard-cli", redirect_uri: "http://127.0.0.1:4567/callback" })).toBe("invalid_scope");
    expect(await authorizeRefusal(srv, { redirect_uri: `${srv.issuer}/admin/other` })).toBe("400");
    expect(await authorizeRefusal(srv, { redirect_uri: "http://127.0.0.1:4567/admin/callback" })).toBe("400");
    const metadata = await (await fetch(`${srv.issuer}/.well-known/oauth-authorization-server`)).json() as { scopes_supported: string[] };
    expect(metadata.scopes_supported).not.toContain(ADMIN_SCOPE);
    expect((OAUTH_SCOPES as readonly string[]).includes(ADMIN_SCOPE)).toBe(false);
    const entry = { clientId: ADMIN_CLIENT_ID, name: "Mine", redirectUris: ["http://127.0.0.1/callback"], scopes: ["grayboard:tools"], tokenEndpointAuthMethod: "none" };
    expect(() => parseOAuthClients(JSON.stringify([entry]))).toThrow(`OAuth client ID ${ADMIN_CLIENT_ID} is reserved`);
  });
});

describe("/admin", () => {
  test("every response carries the page's CSP: no inline script or eval, no framing", async () => {
    srv = await hostedServer({ admins: [ROOT] }, ROOT);
    expect(ADMIN_CSP).toContain("default-src 'self'");
    expect(ADMIN_CSP).toContain("frame-ancestors 'none'");
    expect(ADMIN_CSP).not.toMatch(/unsafe-inline|unsafe-eval/);
    for (const [method, path, status] of [["GET", "/admin", 200], ["GET", "/admin/", 200], ["GET", "/admin/callback?code=x&state=y", 200], ["GET", "/admin/nothing", 404], ["POST", "/admin", 405]] as const) {
      const res = await fetch(srv.issuer + path, { method });
      expect([path, res.status]).toEqual([path, status]);
      expect(res.headers.get("Content-Security-Policy")).toBe(ADMIN_CSP);
      expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    }
    // A path that only begins with the word is not the page's.
    expect((await fetch(srv.issuer + "/administrator")).headers.get("Content-Security-Policy")).toBeNull();
  });
});
