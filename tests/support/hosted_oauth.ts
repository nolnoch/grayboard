// A server whose public URL is the address it listens on, so a hosted
// extension's Login (discovery, authorize, token, refresh) runs against it
// unchanged; a scripted browser through its real consent page (only the
// upstream Google exchange is stubbed); and a grant store seeded with a
// grant the server issued.
import { expect } from "bun:test";
import { Login } from "../../adapters/hosted-core/src/login.ts";
import { writeJsonAtomic } from "../../adapters/hosted-core/src/storage.ts";
import type { Config } from "../../src/server/config.ts";
import { issueOAuth } from "../helpers/oauth.ts";
import { Browser, consentForm, submitConsent } from "./oauth_browser.ts";
import { TestServer } from "./server.ts";

const SCOPES = ["grayboard:delivery", "grayboard:tools"];

// A port nothing listens on: the server's public URL must name its port before it starts.
function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

export type HostedServer = TestServer & { issuer: string; resource: string };

// `email` is who the stubbed upstream sign-in says the browser is.
export function hostedServer(overrides: Partial<Config> = {}, email = "alice@example.com"): HostedServer {
  const port = freePort();
  const issuer = `http://127.0.0.1:${port}`;
  const srv = new TestServer({ httpPort: port, publicUrl: issuer, hostedRequestLimit: { burst: 10_000, perSec: 10_000 }, oauthClients: [], ...overrides },
    { hostname: "127.0.0.1", oauth: { exchangeGoogle: async () => ({ email, displayName: email.split("@")[0]! }) } });
  return Object.assign(srv, { issuer, resource: srv.app.oauth.resource });
}

// Walks authorize → (stubbed upstream) → consent → the client's loopback
// callback, and returns the callback page's text.
export async function browse(issuer: string, authorizeUrl: string, harness: string, decision: "approve" | "deny" = "approve"): Promise<string> {
  const browser = new Browser(), request = browser.request.bind(browser);
  const begin = await request(authorizeUrl);
  expect(begin.status).toBe(303);
  const google = new URL(begin.headers.get("Location")!);
  expect(google.host).toBe("accounts.google.com");
  const callback = await request(`${issuer}/oauth/google/callback?` + new URLSearchParams({ code: "upstream-code", state: google.searchParams.get("state")!, iss: "https://accounts.google.com" }));
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
  const issued = issueOAuth(srv.app.repo, srv.resource, email, SCOPES, Date.now(), clientId);
  const login = new Login({ resource: srv.resource, clientId, stateDir, harness: "test", loginAction: "log in", present: () => {}, notify: () => {}, diagnostic: () => {} });
  await writeJsonAtomic(login.path, { version: 1, resource: srv.resource, clientId, epoch: "seeded", issuer: srv.issuer, scope: SCOPES.join(" "),
    access: issued.token, accessExpiresAt: Date.now() + expiresIn, refresh: issued.refreshToken });
  return issued;
}
