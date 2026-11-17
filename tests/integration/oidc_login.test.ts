// Okta sign-in through the AS (#928 criterion 1, D7, D10): a hosted server (in process, dev auth on) whose provider
// list holds the real generic OIDC provider, built with allowLoopbackHttp and aimed at startFakeOidc(). Injection
// replaces only how the provider is built, not what it does: discovery, the token request, userinfo and ID-token
// verification all run over HTTP. With two providers the chooser appears, each link reaches its IdP, choosing again
// replaces the upstream state, and a code on another provider's callback path is refused before any token request.
// Criterion 4 runs here end to end, both ways round: an email one IdP's account holds never signs in from the other
// until an admin runs unlink-idp.
import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import type { IdentityProvider } from "../../src/server/idp.ts";
import { oidcProvider } from "../../src/server/idp_oidc.ts";
import { REFUSED } from "../../src/server/oauth.ts";
import { accessAudits } from "../support/audit.ts";
import { startFakeOidc, type FakeOidc } from "../support/fake_oidc.ts";
import { HostedSession } from "../support/hosted_session.ts";
import { chooserLinks, hostedServer, upstreamLeg, type HostedServer } from "../support/hosted_oauth.ts";
import { Browser, consentForm, submitConsent } from "../support/oauth_browser.ts";
import { stubProvider } from "../support/stub_provider.ts";

const CLIENT_ID = "okta-client", CLIENT_SECRET = "okta-private", EMAIL = "you@example.com";
const CLIENT = "grayboard-pi", SCOPE = "grayboard:delivery grayboard:tools";

let fake: FakeOidc | undefined, srv: HostedServer | undefined;
const sessions: HostedSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
  await srv?.stop();
  fake?.stop();
  srv = fake = undefined;
});

// Okta as a server builds it (defaultProviders), but for loopback http.
const okta = (f: FakeOidc): IdentityProvider => oidcProvider({ id: "okta", label: "Okta", issuer: f.issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, allowedDomains: ["example.com"], allowLoopbackHttp: true });
let googleExchanges = 0;
const google = () => stubProvider(async () => { googleExchanges++; return { email: EMAIL, displayName: "You", subject: "google-you" }; });

// Okta's code flow: the ID token carries no email claims; userinfo does.
async function start(providers: (f: FakeOidc) => IdentityProvider[], admins: string[] = []): Promise<{ fake: FakeOidc; srv: HostedServer }> {
  googleExchanges = 0;
  fake = await startFakeOidc({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, user: { sub: "okta-you", email: EMAIL, email_verified: true, name: "You" }, claimsInUserinfoOnly: true });
  srv = hostedServer({ admins }, EMAIL, providers(fake));
  return { fake, srv };
}

// A PKCE authorization request from a built-in client with a loopback redirect.
function authorization(issuer: string) {
  const verifier = randomBytes(32).toString("base64url"), state = randomBytes(16).toString("base64url");
  const redirectUri = "http://127.0.0.1:49152/callback";
  const url = `${issuer}/oauth/authorize?` + new URLSearchParams({ response_type: "code", client_id: CLIENT, redirect_uri: redirectUri, scope: SCOPE, state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
  return { url, verifier, state, redirectUri };
}
type Authorization = ReturnType<typeof authorization>;

// The AS callback's answer: "consent", or the error_description it sent back to the client.
function outcome(res: Response, issuer: string, a: Authorization): string {
  expect(res.status).toBe(303);
  const to = new URL(res.headers.get("Location")!);
  if (to.href.startsWith(issuer + "/oauth/consent?")) return "consent";
  expect(to.origin + to.pathname).toBe(a.redirectUri);
  expect([to.searchParams.get("error"), to.searchParams.get("state"), to.searchParams.has("code")]).toEqual(["access_denied", a.state, false]);
  return to.searchParams.get("error_description") ?? "";
}

// One fresh browser (no session) through authorize and the upstream leg: the callback's outcome.
async function signIn(s: HostedServer, provider?: string): Promise<{ result: string; browser: Browser; callback: Response; a: Authorization }> {
  const browser = new Browser(), a = authorization(s.issuer);
  const callback = await upstreamLeg(browser, s.issuer, await browser.request(a.url), provider);
  return { result: outcome(callback, s.issuer, a), browser, callback, a };
}

// Consent approved, the code redeemed: an access token.
async function token(s: HostedServer, browser: Browser, callback: Response, a: Authorization): Promise<string> {
  const page = await (await browser.request(callback.headers.get("Location")!)).text();
  const decided = await submitConsent(browser, `${s.issuer}/oauth/consent`, consentForm(page));
  expect(decided.status).toBe(303);
  const back = new URL(decided.headers.get("Location")!);
  const res = await fetch(`${s.issuer}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: CLIENT, code: back.searchParams.get("code")!, redirect_uri: a.redirectUri, code_verifier: a.verifier }) });
  expect(res.status).toBe(200);
  return ((await res.json()) as { access_token: string }).access_token;
}

const browsers = (s: HostedServer) => (s.app.db.query("SELECT COUNT(*) AS n FROM oauth_browsers").get() as { n: number }).n;

test("Okta alone: authorize goes straight to the IdP, the real OIDC provider signs the user in, and the token makes a hosted MCP call", async () => {
  const { fake, srv } = await start(f => [okta(f)]);
  const { result, browser, callback, a } = await signIn(srv);
  expect(result).toBe("consent");
  expect(fake.hits).toMatchObject({ discovery: 1, authorize: 1, token: 1, userinfo: 1 });
  expect(fake.tokenRefusals).toEqual([]);
  const access = await token(srv, browser, callback, a);
  const session = new HostedSession(`${srv.base}/mcp`, access, null);
  sessions.push(session);
  expect(JSON.stringify((await session.connect()).whoami)).toContain(EMAIL);
  expect((await srv.app.repo.users.findByEmail(srv.app.repo.read, EMAIL))).toMatchObject({ idp_issuer: fake.issuer, idp_subject: "okta-you" });
  expect(accessAudits(srv.app.db, "oauth.upstream_authenticated").map(r => [r.actor, r.detail])).toEqual([[EMAIL, { client_id: CLIENT, provider: "okta" }]]);
});

test("two providers: the chooser lists each in config order, each link reaches its IdP, and choosing again replaces the upstream state", async () => {
  const { fake, srv } = await start(f => [google(), okta(f)]);
  const browser = new Browser(), a = authorization(srv.issuer);
  const begin = await browser.request(a.url);
  expect(begin.status).toBe(200);
  expect(begin.headers.get("Content-Security-Policy")).toStartWith("default-src 'none'; frame-ancestors 'none'");
  const page = await begin.text();
  expect([...page.matchAll(/>Sign in with ([^<]+)</g)].map(m => m[1])).toEqual(["Google", "Okta"]);
  const links = new Map(chooserLinks(page));
  expect([...links.keys()]).toEqual(["google", "okta"]);
  for (const url of links.values()) expect(url).toStartWith(`${srv.issuer}/oauth/upstream?request=`);

  const toGoogle = await browser.request(links.get("google")!);
  expect(toGoogle.status).toBe(303);
  const atGoogle = new URL(toGoogle.headers.get("Location")!);
  expect([atGoogle.host, atGoogle.searchParams.get("redirect_uri")]).toEqual(["accounts.google.com", `${srv.issuer}/oauth/google/callback`]);
  const toOkta = await browser.request(links.get("okta")!);
  expect(toOkta.status).toBe(303);
  const atOkta = new URL(toOkta.headers.get("Location")!);
  expect([atOkta.href.startsWith(fake.issuer + "/"), atOkta.searchParams.get("redirect_uri"), atOkta.searchParams.get("client_id")]).toEqual([true, `${srv.issuer}/oauth/okta/callback`, CLIENT_ID]);

  // Choosing Okta dropped Google's upstream state: Google's callback with it completes nothing.
  const stale = await browser.request(`${srv.issuer}/oauth/google/callback?` + new URLSearchParams({ code: "upstream-code", state: atGoogle.searchParams.get("state")! }));
  expect(stale.status).toBe(400);
  expect(googleExchanges).toBe(0);
  const idp = await fetch(atOkta, { redirect: "manual" });
  expect(outcome(await browser.request(idp.headers.get("Location")!), srv.issuer, a)).toBe("consent");
  expect((await srv.app.repo.users.findByEmail(srv.app.repo.read, EMAIL))).toMatchObject({ idp_issuer: fake.issuer });

  // The chooser's route needs the flow's binding cookie, and a provider the server lists.
  expect((await new Browser().request(links.get("okta")!)).status).toBe(400);
  const another = new Browser(), b = authorization(srv.issuer);
  const chooser = new Map(chooserLinks(await (await another.request(b.url)).text()));
  expect((await another.request(chooser.get("okta")!.replace("provider=okta", "provider=azure"))).status).toBe(400);
});

test("a code on another provider's callback path is refused before any token request, and its state is spent", async () => {
  const { fake, srv } = await start(f => [google(), okta(f)]);
  // Okta's code and state, delivered to Google's path (without Okta's iss, which Google's iss check would refuse first).
  const browser = new Browser(), a = authorization(srv.issuer);
  const links = new Map(chooserLinks(await (await browser.request(a.url)).text()));
  const idp = await fetch((await browser.request(links.get("okta")!)).headers.get("Location")!, { redirect: "manual" });
  const back = new URL(idp.headers.get("Location")!);
  expect(back.pathname).toBe("/oauth/okta/callback");
  const params = new URLSearchParams({ code: back.searchParams.get("code")!, state: back.searchParams.get("state")! });
  expect((await browser.request(`${srv.issuer}/oauth/google/callback?${params}`)).status).toBe(400);
  expect(googleExchanges).toBe(0);
  expect((await browser.request(back.href)).status).toBe(400);
  expect(fake.hits.token).toBe(0);

  // Google's state on Okta's path: refused the same way, no exchange either side.
  const other = new Browser(), b = authorization(srv.issuer);
  const chooser = new Map(chooserLinks(await (await other.request(b.url)).text()));
  const atGoogle = new URL((await other.request(chooser.get("google")!)).headers.get("Location")!);
  expect((await other.request(`${srv.issuer}/oauth/okta/callback?` + new URLSearchParams({ code: "upstream-code", state: atGoogle.searchParams.get("state")! }))).status).toBe(400);
  expect((await other.request(`${srv.issuer}/oauth/google/callback?` + new URLSearchParams({ code: "upstream-code", state: atGoogle.searchParams.get("state")! }))).status).toBe(400);
  expect([googleExchanges, fake.hits.token]).toEqual([0, 0]);
  expect(browsers(srv)).toBe(0);
});

test("an Okta refusal is audited under oauth.upstream_* with the provider, and its failure log keeps the stage's class", async () => {
  const { fake, srv } = await start(f => [okta(f)]);
  // The person declined at the IdP.
  const browser = new Browser(), a = authorization(srv.issuer);
  const atOkta = new URL((await browser.request(a.url)).headers.get("Location")!);
  const declined = await browser.request(`${srv.issuer}/oauth/okta/callback?` + new URLSearchParams({ error: "access_denied", state: atOkta.searchParams.get("state")! }));
  expect(outcome(declined, srv.issuer, a)).toBe("");
  expect(accessAudits(srv.app.db, "oauth.upstream_denied").map(r => r.detail)).toEqual([{ client_id: CLIENT, provider: "okta" }]);

  // An ID token from another issuer: the provider's OidcIdentityError reaches the log by class only.
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    fake.next({ claims: { iss: "https://elsewhere.example.com" } });
    expect((await signIn(srv)).result).toBe(REFUSED.provider);
    expect(log.mock.calls.flat()).toContain('[grayboard] {"operation":"oauth.exchange","category":"failure","level":"error","class":"OidcIdentityError"}');
  } finally { log.mockRestore(); }
  expect(accessAudits(srv.app.db, "oauth.upstream_failed").map(r => r.detail)).toEqual([{ client_id: CLIENT, provider: "okta" }]);

  // An email outside the allowed domains keeps DomainRefused's handling: oauth.domain_refused, no failure row.
  fake.userinfo({ email: "you@other.example.org" });
  expect((await signIn(srv)).result).toBe(REFUSED.domain);
  expect(accessAudits(srv.app.db, "oauth.domain_refused").map(r => r.detail)).toEqual([{ client_id: CLIENT, provider: "okta" }]);
  expect(accessAudits(srv.app.db, "oauth.upstream_failed")).toHaveLength(1);
  expect(browsers(srv)).toBe(0);
});

test("an IdP whose discovery fails sends the client temporarily_unavailable, not a 500, and logs the stage's class", async () => {
  const { fake: down, srv } = await start(f => [okta(f)]);
  down.stop();
  fake = undefined;
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const browser = new Browser(), a = authorization(srv.issuer);
    const res = await browser.request(a.url);
    expect(res.status).toBe(303);
    const to = new URL(res.headers.get("Location")!);
    expect([to.origin + to.pathname, to.searchParams.get("error"), to.searchParams.get("state"), to.searchParams.get("iss")]).toEqual([a.redirectUri, "temporarily_unavailable", a.state, srv.issuer]);
    expect(log.mock.calls.flat()).toContain('[grayboard] {"operation":"oauth.upstream","category":"failure","level":"error","class":"OidcDiscoveryError"}');
  } finally { log.mockRestore(); }
  expect(accessAudits(srv.app.db, "oauth.upstream_failed").map(r => r.detail)).toEqual([{ client_id: CLIENT, provider: "okta" }]);
});

test("with two providers, a browser that already signed in skips the chooser and goes to consent", async () => {
  const { srv } = await start(f => [google(), okta(f)]);
  const { result, browser } = await signIn(srv, "okta");
  expect(result).toBe("consent");
  const again = await browser.request(authorization(srv.issuer).url);
  expect(again.status).toBe(303);
  expect(again.headers.get("Location")!).toStartWith(`${srv.issuer}/oauth/consent?request=`);
});

// #928 criterion 4, D4: issuer_mismatch both ways round, with the real OIDC provider on the Okta side.
for (const [first, second] of [["google", "okta"], ["okta", "google"]] as const) {
  test(`an email a ${first} account holds is refused from ${second}, with no browser session, until an admin runs unlink-idp`, async () => {
    const { fake, srv } = await start(f => [google(), okta(f)], ["root@example.com"]);
    const issuer = (idp: "google" | "okta") => idp === "okta" ? fake.issuer : "https://accounts.google.com";
    const label = { google: "Google", okta: "Okta" };
    expect((await signIn(srv, first)).result).toBe("consent");
    expect(browsers(srv)).toBe(1);
    expect((await signIn(srv, second)).result).toBe(`${EMAIL} is linked to a ${label[first]} account, not ${label[second]}. If this ${label[second]} account should have it, an admin runs grayboard admin unlink-idp --email ${EMAIL}`);
    expect(browsers(srv)).toBe(1);
    expect(accessAudits(srv.app.db, "auth.subject_refused").map(r => [r.actor, r.detail])).toEqual([
      [EMAIL, { reason: "issuer_mismatch", holding_issuer: issuer(first), provider: second, issuer: issuer(second), client_id: CLIENT }],
    ]);
    expect(accessAudits(srv.app.db, "oauth.upstream_authenticated").map(r => r.detail)).toEqual([{ client_id: CLIENT, provider: first }]);

    const root = await srv.login("root@example.com");
    expect((await srv.api(root, "POST", "/api/admin/unlink-idp", { email: EMAIL })).status).toBe(200);
    expect((await signIn(srv, second)).result).toBe("consent");
    expect((await srv.app.repo.users.findByEmail(srv.app.repo.read, EMAIL))).toMatchObject({ idp_issuer: issuer(second), idp_subject: `${second}-you` });
    expect(browsers(srv)).toBe(2);
  });
}
