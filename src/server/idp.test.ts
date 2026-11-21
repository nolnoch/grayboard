import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessAudits } from "../../tests/support/audit.ts";
import { scratchDbPath } from "../../tests/support/scratch_db.ts";
import { seed } from "../../tests/support/seed.ts";
import { openDatabase, type Repo } from "./db.ts";
import type { Tx } from "./store/tx.ts";
import type { Config } from "./config.ts";
import { callbackPath, defaultProviders, idpSignIn, type SignInProvider } from "./idp.ts";
import { GOOGLE_ISSUER } from "./idp_google.ts";

const google: SignInProvider = { id: "google", label: "Google", issuer: GOOGLE_ISSUER };
const okta: SignInProvider = { id: "okta", label: "Okta", issuer: "https://example.okta.com" };
const fresh = () => openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
const id = (email: string, subject: string) => ({ email, subject, displayName: null });
// In a queued body, as the OAuth callback runs it (#807 P1b-4f).
const signIn = (repo: Repo, ...a: Parameters<typeof idpSignIn> extends [Repo, Tx, ...infer R] ? R : never) => seed(repo, tx => idpSignIn(repo, tx, ...a));

// Security audit F-13, #928 D4/D9: each refusal says what the admin runs, and audits why, with the provider and issuer.
test("idpSignIn refuses a reassigned or changed email with the admin's fix, and audits each outcome", async () => {
  const { db, repo } = fresh();
  await seed(repo, tx => repo.users.upsertByEmail(tx, "old@example.com", null));
  expect(await signIn(repo, google, id("old@example.com", "s-old"), { ip: "1.2.3.4" })).toMatchObject({ user: { email: "old@example.com" } });
  expect(accessAudits(db, "auth.subject_linked").map(r => [r.actor, r.detail])).toEqual([["old@example.com", { provider: "google", issuer: GOOGLE_ISSUER, ip: "1.2.3.4" }]]);

  const mismatch = await signIn(repo, google, id("old@example.com", "s-hire"), { ip: "1.2.3.4" });
  expect(mismatch).toEqual({ refused: "old@example.com is linked to a different Google account. If this account should have it, an admin runs grayboard admin unlink-idp --email old@example.com" });
  const changed = await signIn(repo, google, id("new@example.com", "s-old"), { ip: "1.2.3.4" });
  expect(changed).toEqual({ refused: expect.stringContaining("belongs to grayboard user old@example.com but now reports new@example.com") });
  expect(accessAudits(db, "auth.subject_refused").map(r => [r.actor, r.detail])).toEqual([
    ["old@example.com", { reason: "subject_mismatch", provider: "google", issuer: GOOGLE_ISSUER, ip: "1.2.3.4" }],
    ["old@example.com", { reason: "email_changed", email: "new@example.com", provider: "google", issuer: GOOGLE_ISSUER, ip: "1.2.3.4" }],
  ]);
});

test("idpSignIn refuses an email another provider holds, naming that provider and the unlink, and audits the holding issuer", async () => {
  const { db, repo } = fresh();
  expect(await signIn(repo, google, id("a@example.com", "s-1"))).toMatchObject({ user: { idp_issuer: GOOGLE_ISSUER } });
  expect(await signIn(repo, okta, id("a@example.com", "o-1"), { client_id: "native" }, [google, okta])).toEqual({
    refused: "a@example.com is linked to a Google account, not Okta. If this Okta account should have it, an admin runs grayboard admin unlink-idp --email a@example.com",
  });
  // A holder the server doesn't list isn't named: the text reaches the OAuth client; the audit keeps the issuer.
  expect(await signIn(repo, okta, id("a@example.com", "o-1"))).toEqual({ refused: expect.stringContaining("linked to another provider's account, not Okta") });
  expect(accessAudits(db, "auth.subject_refused").map(r => [r.actor, r.detail])[0]).toEqual(
    ["a@example.com", { reason: "issuer_mismatch", holding_issuer: GOOGLE_ISSUER, provider: "okta", issuer: okta.issuer, client_id: "native" }]);
  expect((await repo.users.findByEmail(repo.read, "a@example.com"))).toMatchObject({ idp_issuer: GOOGLE_ISSUER, idp_subject: "s-1" });
});

// #928 D6/D10: the gap no integration test covers, Config to providers. Tests inject providers; a server builds them
// here, so each provider's config must reach the right provider, in GRAYBOARD_IDPS's order.
const OKTA_ISSUER = "https://example.okta.com/oauth2/default";
const base = { googleClientId: "desktop-client", googleClientSecret: "desktop-secret", orgDomain: "example.com",
  okta: { issuer: OKTA_ISSUER, clientId: "okta-client", clientSecret: "okta-private", allowedDomains: ["example.com"] } } as unknown as Config;
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test("defaultProviders is Google alone by default, on the MCP pair when set, else the primary", async () => {
  const input = { redirectUri: "https://grayboard.example.com/oauth/google/callback", state: "s", nonce: "n", challenge: "c" };
  for (const [config, clientId] of [[{ ...base, okta: undefined }, "desktop-client"], [{ ...base, okta: undefined, mcpGoogle: { clientId: "web-client", clientSecret: "web-secret" } }, "web-client"]] as const) {
    const providers = defaultProviders(config as Config);
    expect(providers.map(p => [p.id, p.label, p.issuer, callbackPath(p)])).toEqual([["google", "Google", GOOGLE_ISSUER, "/oauth/google/callback"]]);
    const url = new URL(await providers[0]!.authorizeUrl(input));
    expect([url.host, url.searchParams.get("client_id"), url.searchParams.get("hd")]).toEqual(["accounts.google.com", clientId, "example.com"]);
  }
});

// #930 A2b: Google has a directory status check exactly when the server has a directory key (Okta's, #1563, likewise with its service app).
test("defaultProviders gives Google a status check only with GRAYBOARD_GOOGLE_DIRECTORY_KEY or _SERVICE_ACCOUNT", () => {
  const directory = { kind: "key" as const, clientEmail: "sa@p.iam.gserviceaccount.com", privateKey: "unused until the first check" };
  expect(defaultProviders({ ...base, okta: undefined } as Config)[0]!.status).toBeUndefined();
  const providers = defaultProviders({ ...base, idps: ["okta", "google"], googleDirectory: directory });
  expect(providers.map(p => [p.id, typeof p.status])).toEqual([["okta", "undefined"], ["google", "function"]]);
});

// #1555: oidc has a status check exactly when the server has Keycloak's directory pair.
test("defaultProviders gives oidc a status check only with Keycloak's directory configuration", () => {
  const oidc = { issuer: "https://sso.example.com/realms/eng", clientId: "grayboard", allowedDomains: ["example.com"], label: "SSO" };
  expect(defaultProviders({ ...base, idps: ["oidc"], oidc } as Config)[0]!.status).toBeUndefined();
  const keycloakDirectory = { baseUrl: "https://sso.example.com", realm: "eng", clientId: "c", clientSecret: "s" };
  const providers = defaultProviders({ ...base, idps: ["oidc", "okta"], oidc, keycloakDirectory } as Config);
  expect(providers.map(p => [p.id, p.issuer, typeof p.status])).toEqual([["oidc", oidc.issuer, "function"], ["okta", OKTA_ISSUER, "undefined"]]);
});

// #1563: okta has a status check exactly when the server has Okta's directory pair.
test("defaultProviders gives okta a status check only with Okta's directory configuration", () => {
  const oktaDirectory = { orgUrl: "https://example.okta.com", clientId: "0oa1", privateKey: "unused until the first check", alg: "RS256" };
  const providers = defaultProviders({ ...base, idps: ["okta", "google"], oktaDirectory } as Config);
  expect(providers.map(p => [p.id, p.issuer, typeof p.status])).toEqual([["okta", OKTA_ISSUER, "function"], ["google", expect.any(String), "undefined"]]);
});

test("defaultProviders builds Okta from Config in the listed order, fetching nothing until first use, with its own client", async () => {
  const fetched: string[] = [];
  let tokenAuthorization: string | null = null;
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    fetched.push(req.url);
    if (req.url === OKTA_ISSUER + "/.well-known/openid-configuration") return Response.json({ issuer: OKTA_ISSUER,
      authorization_endpoint: OKTA_ISSUER + "/v1/authorize", token_endpoint: OKTA_ISSUER + "/v1/token", jwks_uri: OKTA_ISSUER + "/v1/keys",
      userinfo_endpoint: OKTA_ISSUER + "/v1/userinfo", code_challenge_methods_supported: ["S256"], id_token_signing_alg_values_supported: ["RS256"] });
    if (req.url === OKTA_ISSUER + "/v1/token") { tokenAuthorization = req.headers.get("authorization"); return Response.json({ error: "invalid_grant" }, { status: 400 }); }
    throw new Error("unexpected request " + req.url);
  }, { preconnect: realFetch.preconnect });

  const providers = defaultProviders({ ...base, idps: ["okta", "google"] });
  expect(providers.map(p => [p.id, p.label, p.issuer, callbackPath(p)])).toEqual([
    ["okta", "Okta", OKTA_ISSUER, "/oauth/okta/callback"], ["google", "Google", GOOGLE_ISSUER, "/oauth/google/callback"]]);
  expect(fetched).toEqual([]);
  const okta = providers[0]!;
  const url = new URL(await okta.authorizeUrl({ redirectUri: "https://grayboard.example.com/oauth/okta/callback", state: "s", nonce: "n", challenge: "c" }));
  expect(url.origin + url.pathname).toBe(OKTA_ISSUER + "/v1/authorize");
  expect(url.searchParams.get("client_id")).toBe("okta-client");
  await expect(okta.exchange({ code: "c", verifier: "v", redirectUri: "https://grayboard.example.com/oauth/okta/callback", nonce: "n" })).rejects.toThrow("token");
  expect(tokenAuthorization!).toBe("Basic " + Buffer.from("okta-client:okta-private").toString("base64"));
  expect(defaultProviders({ ...base, idps: ["google", "okta"] }).map(p => p.id)).toEqual(["google", "okta"]);
  expect(defaultProviders({ ...base, idps: ["okta"] }).map(p => p.id)).toEqual(["okta"]);
});

// #1418: oidc from Config is the generic provider under its label and callback; with no secret, a public client.
test("defaultProviders builds oidc from Config, a public client when it has no secret", async () => {
  const ISSUER = "https://sso.example.com/realms/eng";
  let token: { authorization: string | null; form: URLSearchParams } | undefined;
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.url === ISSUER + "/.well-known/openid-configuration") return Response.json({ issuer: ISSUER,
      authorization_endpoint: ISSUER + "/auth", token_endpoint: ISSUER + "/token", jwks_uri: ISSUER + "/certs",
      code_challenge_methods_supported: ["S256"], id_token_signing_alg_values_supported: ["RS256"] });
    if (req.url === ISSUER + "/token") { token = { authorization: req.headers.get("authorization"), form: new URLSearchParams(await req.text()) }; return Response.json({ error: "invalid_grant" }, { status: 400 }); }
    throw new Error("unexpected request " + req.url);
  }, { preconnect: realFetch.preconnect });

  const config = { ...base, okta: undefined, idps: ["oidc", "google"], oidc: { issuer: ISSUER, clientId: "grayboard", allowedDomains: ["example.com"], label: "Example SSO" } } as unknown as Config;
  const providers = defaultProviders(config);
  expect(providers.map(p => [p.id, p.label, p.issuer, callbackPath(p)])).toEqual([
    ["oidc", "Example SSO", ISSUER, "/oauth/oidc/callback"], ["google", "Google", GOOGLE_ISSUER, "/oauth/google/callback"]]);
  await expect(providers[0]!.exchange({ code: "c", verifier: "v", redirectUri: "https://grayboard.example.com/oauth/oidc/callback", nonce: "n" })).rejects.toThrow("token");
  expect(token!.authorization).toBeNull();
  expect([token!.form.get("client_id"), token!.form.get("code_verifier")]).toEqual(["grayboard", "v"]);
});
