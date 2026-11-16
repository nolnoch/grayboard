// The OIDC provider (#928 D2) over real HTTP against the loopback fake issuer (D10). Each refusal is its own test.
import { afterEach, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { startFakeOidc, type FakeOidc, type FakeOidcOptions, type OidcUser } from "../../tests/support/fake_oidc.ts";
import { until } from "../../tests/support/until.ts";
import { DomainRefused, type IdentityProvider } from "./idp.ts";
import { oidcProvider, type OidcProviderOptions } from "./idp_oidc.ts";

// Characters form-encoding changes: a space, `+`, `:`, `%`, `/`, `=` and a non-ASCII one.
const CLIENT_ID = "fake client+id:1";
const CLIENT_SECRET = "s3cr3t/+=:% é";
const REDIRECT = "https://grayboard.example.com/oauth/okta/callback";
const USER: OidcUser = { sub: "00u1abcdEFGH", email: "You@Example.com", email_verified: true, name: "You" };

const fakes: FakeOidc[] = [];
afterEach(() => { while (fakes.length) fakes.pop()!.stop(); });

async function fake(options: Partial<FakeOidcOptions> = {}): Promise<FakeOidc> {
  const f = await startFakeOidc({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, user: USER, ...options });
  fakes.push(f);
  return f;
}
const provider = (f: FakeOidc, options: Partial<OidcProviderOptions> = {}) => oidcProvider({
  id: "okta", label: "Okta", issuer: f.issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, allowedDomains: ["example.com"], allowLoopbackHttp: true, ...options,
});
const random = () => randomBytes(32).toString("base64url");

// The AS's half of a sign-in: an authorize URL, the browser's trip through the IdP, the exchange.
async function signIn(p: IdentityProvider, f: FakeOidc) {
  const nonce = random(), verifier = random(), state = random();
  const url = await p.authorizeUrl({ redirectUri: REDIRECT, state, nonce, challenge: createHash("sha256").update(verifier).digest("base64url") });
  const back = await f.authorize(url);
  expect(back.get("state")).toBe(state);
  expect(back.get("iss")).toBe(p.issuer);
  return p.exchange({ code: back.get("code")!, verifier, redirectUri: REDIRECT, nonce });
}
const now = () => Math.floor(Date.now() / 1000);

// Success paths.

test("claims in the ID token: the identity, its email lowercased, the issuer the configured constant", async () => {
  const f = await fake();
  const p = provider(f);
  expect(p.issuer).toBe(f.issuer);
  expect(await signIn(p, f)).toEqual({ issuer: f.issuer, subject: USER.sub, email: "you@example.com", displayName: "You" });
  expect(f.hits.userinfo).toBe(0);
});

test("claims only from userinfo (Okta's code flow): read with the access token", async () => {
  const f = await fake({ claimsInUserinfoOnly: true });
  expect(await signIn(provider(f), f)).toEqual({ issuer: f.issuer, subject: USER.sub, email: "you@example.com", displayName: "You" });
  expect(f.hits.userinfo).toBe(1);
});

test("an ID token with email but no email_verified takes both from userinfo, never one from each", async () => {
  const f = await fake();
  f.next({ claims: { email: "someone-else@example.com", email_verified: undefined } });
  expect((await signIn(provider(f), f)).email).toBe("you@example.com");
  expect(f.hits.userinfo).toBe(1);
});

test("the authorize URL carries the code flow, PKCE S256, the nonce and the OIDC scope", async () => {
  const f = await fake();
  const url = new URL(await provider(f).authorizeUrl({ redirectUri: REDIRECT, state: "s", nonce: "n", challenge: "c" }));
  expect(url.origin + url.pathname).toBe(`${f.issuer}/authorize`);
  expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: "code", scope: "openid email profile",
    state: "s", nonce: "n", code_challenge: "c", code_challenge_method: "S256" });
});

// The token request: client_secret_basic with each half form-encoded (RFC 6749 §2.3.1).

test("the token request form-encodes the client ID and secret before base64, and the fake refuses them sent raw", async () => {
  const f = await fake();
  await signIn(provider(f), f);
  // "fake client+id:1" and "s3cr3t/+=:% é", form-encoded by hand.
  const encoded = "fake+client%2Bid%3A1:s3cr3t%2F%2B%3D%3A%25+%C3%A9";
  expect(f.tokenAuthorizations).toEqual([`Basic ${Buffer.from(encoded).toString("base64")}`]);
  expect(f.tokenRefusals).toEqual([]);
  // The same request with the pair un-encoded: the fake's decoding refuses it, so a provider that skipped encoding fails.
  const raw = await fetch(`${f.issuer}/token`, { method: "POST", headers: { Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
    "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=authorization_code&code=x" });
  expect(raw.status).toBe(401);
  expect(f.tokenRefusals.at(-1)).toMatch(/client credentials/);
});

// Refusals: each its own test.

test("refuses an ID token signed by another key", async () => {
  const f = await fake();
  f.next({ foreignKey: true });
  await expect(signIn(provider(f), f)).rejects.toThrow(/signature/);
});

test("refuses an ID token from another issuer", async () => {
  const f = await fake();
  f.next({ claims: { iss: "https://evil.example" } });
  await expect(signIn(provider(f), f)).rejects.toThrow(/iss/);
});

test("refuses an ID token for another audience", async () => {
  const f = await fake();
  f.next({ claims: { aud: "another-client" } });
  await expect(signIn(provider(f), f)).rejects.toThrow(/aud/);
});

test("refuses an ID token whose azp is another client (Google's azp rules)", async () => {
  const f = await fake();
  const p = provider(f);
  f.next({ claims: { azp: "another-client" } });
  await expect(signIn(p, f)).rejects.toThrow(/azp/);
  f.next({ claims: { aud: [CLIENT_ID, "another-client"], azp: "another-client" } });
  await expect(signIn(p, f)).rejects.toThrow(/azp/);
  f.next({ claims: { aud: [CLIENT_ID, "another-client"] } });
  await expect(signIn(p, f)).rejects.toThrow(/azp/);
});

test("refuses an expired ID token, past the 60 s tolerance", async () => {
  const f = await fake();
  f.next({ claims: { iat: now() - 300, exp: now() - 61 } });
  await expect(signIn(provider(f), f)).rejects.toThrow(/exp/);
});

test("accepts an ID token expired 30 s ago, inside the 60 s tolerance", async () => {
  const f = await fake();
  f.next({ claims: { iat: now() - 120, exp: now() - 30 } });
  expect((await signIn(provider(f), f)).subject).toBe(USER.sub);
});

test("refuses an ID token issued over 10 minutes ago", async () => {
  const f = await fake();
  f.next({ claims: { iat: now() - 700, exp: now() + 300 } });
  await expect(signIn(provider(f), f)).rejects.toThrow(/iat/);
});

test("refuses an ID token without exp", async () => {
  const f = await fake();
  f.next({ claims: { exp: undefined } });
  await expect(signIn(provider(f), f)).rejects.toThrow(/exp/);
});

test("refuses a wrong nonce", async () => {
  const f = await fake();
  f.next({ claims: { nonce: "another-nonce" } });
  await expect(signIn(provider(f), f)).rejects.toThrow(/nonce/);
});

test("refuses a missing nonce", async () => {
  const f = await fake();
  f.next({ claims: { nonce: undefined } });
  await expect(signIn(provider(f), f)).rejects.toThrow(/nonce/);
});

test("refuses an HS256 ID token keyed by the client secret", async () => {
  const f = await fake();
  f.next({ alg: "HS256" });
  await expect(signIn(provider(f), f)).rejects.toThrow(/alg/);
});

test("refuses an unsigned (alg: none) ID token", async () => {
  const f = await fake();
  f.next({ alg: "none" });
  await expect(signIn(provider(f), f)).rejects.toThrow();
  expect(f.tokenRefusals).toEqual([]);
});

test("refuses a sub over 255 characters", async () => {
  const f = await fake();
  f.next({ claims: { sub: "x".repeat(256) } });
  await expect(signIn(provider(f), f)).rejects.toThrow(/sub/);
});

test("refuses email_verified false in the ID token", async () => {
  const f = await fake();
  f.next({ claims: { email_verified: false } });
  await expect(signIn(provider(f), f)).rejects.toThrow(/not verified/);
  expect(f.hits.userinfo).toBe(0);
});

test("refuses email_verified missing from both the ID token and userinfo", async () => {
  const f = await fake({ claimsInUserinfoOnly: true, user: { ...USER, email_verified: undefined } });
  await expect(signIn(provider(f), f)).rejects.toThrow(/not verified/);
  expect(f.hits.userinfo).toBe(1);
});

test("refuses email_verified other than exactly true (the string \"true\")", async () => {
  const f = await fake({ claimsInUserinfoOnly: true, user: { ...USER, email_verified: "true" } });
  await expect(signIn(provider(f), f)).rejects.toThrow(/not verified/);
});

test("refuses an email whose domain is off the list, as a DomainRefused", async () => {
  const f = await fake({ user: { ...USER, email: "you@elsewhere.example" } });
  await expect(signIn(provider(f), f)).rejects.toBeInstanceOf(DomainRefused);
  const sub = await fake({ user: { ...USER, email: "you@sub.example.com" } });
  await expect(signIn(provider(sub), sub)).rejects.toBeInstanceOf(DomainRefused);
});

test("refuses userinfo naming another sub", async () => {
  const f = await fake({ claimsInUserinfoOnly: true });
  f.userinfo({ sub: "00uSOMEONEELSE" });
  await expect(signIn(provider(f), f)).rejects.toThrow(/another subject/);
});

test("refuses discovery naming another issuer", async () => {
  const f = await fake();
  f.discovery({ issuer: `${f.issuer}/` });
  await expect(signIn(provider(f), f)).rejects.toThrow(/another issuer/);
  expect(f.hits.authorize).toBe(0);
});

test("refuses a non-https issuer without allowLoopbackHttp, fetching nothing", async () => {
  const f = await fake();
  await expect(signIn(provider(f, { allowLoopbackHttp: false }), f)).rejects.toThrow(/must be https/);
  expect(f.hits.discovery).toBe(0);
});

test("refuses discovery naming a non-https endpoint that isn't loopback, even under allowLoopbackHttp", async () => {
  const f = await fake();
  f.discovery({ token_endpoint: "http://idp.example/token" });
  await expect(signIn(provider(f), f)).rejects.toThrow(/token_endpoint must be https/);
  expect(f.hits.authorize).toBe(0);
});

test("refuses discovery without S256", async () => {
  const f = await fake();
  f.discovery({ code_challenge_methods_supported: ["plain"] });
  await expect(signIn(provider(f), f)).rejects.toThrow(/S256/);
});

test("refuses discovery offering only symmetric or unsigned ID token algorithms", async () => {
  const f = await fake();
  f.discovery({ id_token_signing_alg_values_supported: ["HS256", "none"] });
  await expect(signIn(provider(f), f)).rejects.toThrow(/no asymmetric/);
});

test("refuses an ID token signed with an algorithm discovery doesn't offer", async () => {
  const f = await fake();
  f.discovery({ id_token_signing_alg_values_supported: ["ES256"] });
  await expect(signIn(provider(f), f)).rejects.toThrow(/alg/);
});

test("a code is redeemed once, and the PKCE verifier is checked", async () => {
  const f = await fake();
  const p = provider(f);
  const nonce = random(), verifier = random();
  const back = await f.authorize(await p.authorizeUrl({ redirectUri: REDIRECT, state: "s", nonce, challenge: createHash("sha256").update(verifier).digest("base64url") }));
  await expect(p.exchange({ code: back.get("code")!, verifier: random(), redirectUri: REDIRECT, nonce })).rejects.toThrow(/invalid_grant/);
  await expect(p.exchange({ code: back.get("code")!, verifier, redirectUri: REDIRECT, nonce })).rejects.toThrow(/invalid_grant/);
  expect(f.tokenRefusals).toEqual(["PKCE verifier", "unknown or used code"]);
});

// Discovery: lazy, cached, a failure retried after 30 s, concurrent first uses coalesced.

test("discovery is lazy: constructing the provider fetches nothing", async () => {
  const f = await fake();
  provider(f);
  // A request after construction: one the provider had started would have reached the fake first.
  await (await fetch(`${f.issuer}/nothing`)).text();
  expect(f.hits).toEqual({ discovery: 0, jwks: 0, authorize: 0, token: 0, userinfo: 0 });
});

test("discovery is cached an hour: two sign-ins fetch it once", async () => {
  const f = await fake();
  let clock = 1_000_000;
  const p = provider(f, { now: () => clock });
  await signIn(p, f);
  await signIn(p, f);
  expect(f.hits.discovery).toBe(1);
  clock += 3_600_000 - 1;
  await p.authorizeUrl({ redirectUri: REDIRECT, state: "s", nonce: "n", challenge: "c" });
  expect(f.hits.discovery).toBe(1);
  clock += 1;
  await p.authorizeUrl({ redirectUri: REDIRECT, state: "s", nonce: "n", challenge: "c" });
  expect(f.hits.discovery).toBe(2);
});

test("a discovery failure is retried only after 30 s", async () => {
  const f = await fake();
  let clock = 1_000_000;
  const p = provider(f, { now: () => clock });
  f.discovery("fail");
  await expect(signIn(p, f)).rejects.toThrow(/HTTP 500/);
  expect(f.hits.discovery).toBe(1);
  f.discovery(null);
  clock += 29_999;
  await expect(signIn(p, f)).rejects.toThrow(/HTTP 500/);
  expect(f.hits.discovery).toBe(1);
  clock += 1;
  expect((await signIn(p, f)).subject).toBe(USER.sub);
  expect(f.hits.discovery).toBe(2);
});

test("concurrent first uses share one discovery fetch", async () => {
  const f = await fake();
  const p = provider(f);
  const input = { redirectUri: REDIRECT, state: "s", nonce: "n", challenge: "c" };
  await Promise.all([p.authorizeUrl(input), p.authorizeUrl(input), p.authorizeUrl(input)]);
  expect(f.hits.discovery).toBe(1);
});

// JWKS: rotation through jose's cooldown, and the overall verification deadline.

test("with cooldownDuration 0, a rotated key is accepted after one refetch", async () => {
  const f = await fake();
  const p = provider(f, { cooldownDuration: 0 });
  await signIn(p, f);
  expect(f.hits.jwks).toBe(1);
  await f.rotateKeys();
  expect((await signIn(p, f)).subject).toBe(USER.sub);
  expect(f.hits.jwks).toBe(2);
});

test("with the default cooldown, a key rotated inside it is refused", async () => {
  const f = await fake();
  const p = provider(f);
  await signIn(p, f);
  await f.rotateKeys();
  await expect(signIn(p, f)).rejects.toThrow(/no applicable key/i);
  expect(f.hits.jwks).toBe(1);
});

test("a stalled JWKS body fails that sign-in at the deadline, and a later one completes once it settles", async () => {
  const f = await fake();
  const p = provider(f, { verifyDeadlineMs: 200 });
  const release = f.stallJwks();
  const started = Date.now();
  await expect(signIn(p, f)).rejects.toThrow(/exceeded 200 ms/);
  expect(Date.now() - started).toBeLessThan(5000);
  expect(f.hits.jwks).toBe(1);
  release();
  await until(async () => (await signIn(p, f).catch(() => undefined))?.subject === USER.sub, 5000, "a sign-in after the stalled JWKS body settles");
});
