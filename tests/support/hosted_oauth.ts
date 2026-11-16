// A server whose public URL is the address it listens on, so a hosted
// extension's Login (discovery, authorize, token, refresh) runs against it
// unchanged; a scripted browser through its real consent page and upstream
// leg (a stubbed Google's exchange, or a real IdP's authorize endpoint
// followed); and a grant store seeded with a grant the server issued.
import { expect } from "bun:test";
import { Login } from "../../adapters/hosted-core/src/login.ts";
import { writeJsonAtomic } from "../../adapters/hosted-core/src/storage.ts";
import type { Config } from "../../src/server/config.ts";
import type { IdentityProvider } from "../../src/server/idp.ts";
import { issueOAuth } from "../helpers/oauth.ts";
import { Browser, consentForm, submitConsent } from "./oauth_browser.ts";
import { TestServer } from "./server.ts";
import { stubProvider } from "./stub_provider.ts";

const SCOPES = ["grayboard:delivery", "grayboard:tools"];

// A port nothing listens on: the server's public URL must name its port before it starts.
export function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

export type HostedServer = TestServer & { issuer: string; resource: string };

// `email` is who the stubbed upstream sign-in says the browser is; `providers` replaces that stub (#928: a real OIDC
// provider aimed at startFakeOidc(), or several, for the chooser).
export function hostedServer(overrides: Partial<Config> = {}, email = "alice@example.com", providers?: IdentityProvider[]): HostedServer {
  const port = freePort();
  const issuer = `http://127.0.0.1:${port}`;
  const srv = new TestServer({ httpPort: port, publicUrl: issuer, hostedRequestLimit: { burst: 10_000, perSec: 10_000 }, oauthClients: [], ...overrides },
    { hostname: "127.0.0.1", oauth: { providers: providers ?? [stubProvider(async () => ({ email, displayName: email.split("@")[0]!, subject: "google-" + email }))] } });
  return Object.assign(srv, { issuer, resource: srv.app.oauth.resource });
}

// The chooser page's links, provider ID to URL, in page order (#928 D7).
export function chooserLinks(page: string): [string, string][] {
  return [...page.matchAll(/href="([^"]+)"/g)].map(m => {
    const url = m[1]!.replace(/&amp;/g, "&");
    return [new URL(url).searchParams.get("provider") ?? "", url];
  });
}

// Takes /oauth/authorize's answer through the upstream leg and returns the AS callback's answer: through the chooser
// when it answered one (`provider` picks the link), then a stubbed Google (its callback called directly, as Google
// would redirect) or a real IdP (its authorize endpoint followed, as a browser would).
export async function upstreamLeg(browser: Browser, issuer: string, begin: Response, provider?: string): Promise<Response> {
  let upstream = begin;
  if (begin.status === 200) {
    const page = await begin.text();
    const link = chooserLinks(page).find(([id]) => id === provider)?.[1];
    if (!link) throw new Error(`the chooser has no link for ${provider}: ${page}`);
    upstream = await browser.request(link);
  }
  expect(upstream.status).toBe(303);
  const location = new URL(upstream.headers.get("Location")!);
  if (location.host === "accounts.google.com")
    return browser.request(`${issuer}/oauth/google/callback?` + new URLSearchParams({ code: "upstream-code", state: location.searchParams.get("state")!, iss: "https://accounts.google.com" }));
  const idp = await fetch(location, { redirect: "manual" });
  expect(idp.status).toBe(302);
  return browser.request(idp.headers.get("Location")!);
}

// Walks authorize → (the upstream leg) → consent → the client's loopback
// callback, and returns the callback page's text.
export async function browse(issuer: string, authorizeUrl: string, harness: string, decision: "approve" | "deny" = "approve", provider?: string): Promise<string> {
  const browser = new Browser(), request = browser.request.bind(browser);
  const callback = await upstreamLeg(browser, issuer, await request(authorizeUrl), provider);
  expect(callback.status).toBe(303);
  const page = await (await request(callback.headers.get("Location")!)).text();
  expect(page).toContain(`Authorize Grayboard for ${harness}`);
  const decided = await submitConsent(browser, `${issuer}/oauth/consent`, consentForm(page), decision);
  expect(decided.status).toBe(303);
  const loopback = decided.headers.get("Location")!;
  expect(loopback).toStartWith("http://127.0.0.1:");
  return (await fetch(loopback)).text();
}

// Writes `stateDir`'s grant store for `clientId` with a grant the server
// issued to `email`, as a finished login would. `expiresIn` < 0 makes the
// next token() refresh.
export async function seedGrant(srv: HostedServer, stateDir: string, clientId: string, email = "alice@example.com", expiresIn = 3_600_000) {
  const issued = await issueOAuth(srv.app.repo, srv.resource, email, SCOPES, Date.now(), clientId);
  const login = new Login({ resource: srv.resource, clientId, stateDir, harness: "test", loginAction: "log in", present: () => {}, notify: () => {}, diagnostic: () => {} });
  await writeJsonAtomic(login.path, { version: 1, resource: srv.resource, clientId, epoch: "seeded", issuer: srv.issuer, scope: SCOPES.join(" "),
    access: issued.token, accessExpiresAt: Date.now() + expiresIn, refresh: issued.refreshToken });
  return issued;
}
