// Sign-in end to end: a server with Google and Entra both pointed at a local
// fake IdP, driven through /api/auth/exchange as the CLI drives it after the
// browser step. Covers README §Sign-in providers and src/server/accounts.ts.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";

import { startServer } from "../../src/server/app.ts";
import type { Config } from "../../src/server/config.ts";
import { FakeIdp } from "./fake_idp.ts";

const TID = "11111111-2222-3333-4444-555555555555";
const ENTRA_ISS = `https://login.microsoftonline.com/${TID}/v2.0`;

let idp: FakeIdp;
let app: ReturnType<typeof startServer>;
let base: string;

beforeAll(async () => { idp = await FakeIdp.start(); });
afterAll(() => idp.stop());

const config = (overrides: Partial<Config> = {}): Config => ({
  dbPath: ":memory:",
  httpPort: 0,
  google: {
    clientId: "gid", clientSecret: "gsecret", orgDomain: "example.com",
    allowedEmails: ["pat@gmail.com", "sam@example.org"], endpoints: idp.endpoints,
  },
  entra: { clientId: "eid", clientSecret: "esecret", tenantIds: [TID], endpoints: idp.endpoints },
  publicUrl: "http://localhost",
  messageRetentionDays: 90,
  auditRetentionDays: 90,
  devAuth: false,
  admins: ["admin@example.com"],
  ...overrides,
});

beforeEach(() => {
  app = startServer(config(), { background: false });
  base = `http://localhost:${app.server.port}`;
  idp.tokenCalls.length = 0;
});
afterEach(() => app.stop());

const googleClaims = (over: Record<string, unknown> = {}) => ({
  iss: "https://accounts.google.com", aud: "gid", sub: "g-alice", email: "alice@example.com", email_verified: true, hd: "example.com", name: "Alice", ...over,
});
const entraClaims = (over: Record<string, unknown> = {}) => ({
  iss: ENTRA_ISS, aud: "eid", ver: "2.0", tid: TID, oid: "oid-alice", acct: 0, email: "alice@example.com", xms_edov: true, name: "Alice", ...over,
});

async function exchange(provider: string | undefined, code: string): Promise<Response> {
  return fetch(`${base}/api/auth/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(provider ? { provider } : {}), code, code_verifier: "verifier", redirect_uri: "http://127.0.0.1:5555/cb" }),
  });
}

async function signIn(provider: "google" | "entra", claims: Record<string, unknown>): Promise<{ session_token: string; user_email: string }> {
  const r = await exchange(provider, await idp.issue(claims));
  expect(r.status).toBe(200);
  return r.json() as Promise<{ session_token: string; user_email: string }>;
}

function auditRows(action: string): { actor: string | null; target: string | null; detail: Record<string, unknown> }[] {
  return app.db.query<{ actor: string | null; target: string | null; detail: string }, [string]>(
    "SELECT actor, target, detail FROM access_log WHERE action = ? ORDER BY id",
  ).all(action).map(r => ({ ...r, detail: JSON.parse(r.detail) }));
}

test("auth config lists both providers, their authorize URLs, and the legacy Google keys", async () => {
  const cfg = await (await fetch(`${base}/api/auth/config`)).json();
  expect(cfg).toEqual({
    providers: ["google", "entra"],
    dev_auth: false,
    google_client_id: "gid",
    // No hd hint, nor org_domain (old CLIs send it as hd): the allowlist's
    // personal accounts must show in the chooser.
    google: { client_id: "gid", authorize_url: idp.endpoints.authorize },
    entra: { client_id: "eid", authorize_url: idp.endpoints.authorize },
  });
});

test("Google sends the hd hint only without an allowlist; a dev server offers no provider", async () => {
  app.stop();
  app = startServer(config({ entra: undefined, google: { clientId: "gid", clientSecret: "s", orgDomain: "example.com", allowedEmails: [], endpoints: idp.endpoints } }), { background: false });
  let cfg = await (await fetch(`http://localhost:${app.server.port}/api/auth/config`)).json();
  expect(cfg.providers).toEqual(["google"]);
  expect(cfg.google.hd).toBe("example.com");
  expect(cfg.org_domain).toBe("example.com");
  expect(cfg.entra).toBeUndefined();
  app.stop();
  app = startServer(config({ google: undefined, entra: undefined, devAuth: true }), { background: false });
  cfg = await (await fetch(`http://localhost:${app.server.port}/api/auth/config`)).json();
  expect(cfg).toEqual({ providers: [], dev_auth: true });
});

test("a Google sign-in redeems the code with the server's secret and returns a working session", async () => {
  const code = await idp.issue(googleClaims());
  const r = await exchange("google", code);
  expect(r.status).toBe(200);
  const { session_token, user_email } = await r.json() as { session_token: string; user_email: string };
  expect(user_email).toBe("alice@example.com");
  expect(idp.tokenCalls).toEqual([{
    client_id: "gid", client_secret: "gsecret", code,
    code_verifier: "verifier", redirect_uri: "http://127.0.0.1:5555/cb", grant_type: "authorization_code",
  }]);
  const who = await fetch(`${base}/api/whoami`, { headers: { Authorization: `Bearer ${session_token}` } });
  expect((await who.json()).email).toBe("alice@example.com");
  expect(auditRows("auth.login").map(r => r.detail.provider)).toEqual(["google"]);
});

test("an exchange with no provider is Google, as CLIs before 1.10 send it", async () => {
  const r = await exchange(undefined, await idp.issue(googleClaims()));
  expect(r.status).toBe(200);
});

test("an Entra sign-in with a verified email joins the Google user of that address", async () => {
  await signIn("google", googleClaims());
  const { user_email } = await signIn("entra", entraClaims());
  expect(user_email).toBe("alice@example.com");
  const links = app.repo.links.forUser(app.repo.users.findByEmail("alice@example.com")!.id);
  expect(links.map(l => [l.provider, l.subject])).toEqual([["entra", `${TID}:oid-alice`], ["google", "g-alice"]]);
});

test("an allowlisted address Google doesn't own can't take over a user who signs in with Entra", async () => {
  await signIn("entra", entraClaims({ oid: "oid-sam", email: "sam@example.org" }));
  const r = await exchange("google", await idp.issue(googleClaims({ sub: "g-sam", email: "sam@example.org", hd: undefined })));
  expect(r.status).toBe(403);
  expect((await r.json()).message).toMatch(/doesn't own sam@example.org's domain/);
  const [refused] = auditRows("auth.refused");
  expect(refused!.target).toBe("sam@example.org");
  expect(refused!.detail.provider).toBe("google");
});

test("guests, unverified Entra email and other tenants are refused and audited", async () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [entraClaims({ acct: 1 }), /guest accounts/],
    [entraClaims({ xms_edov: false }), /hasn't verified/],
    [entraClaims({ iss: "https://login.microsoftonline.com/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/v2.0" }), /ID token rejected.*iss/],
  ];
  for (const [claims, msg] of cases) {
    const r = await exchange("entra", await idp.issue(claims));
    expect(r.status).toBe(403);
    expect((await r.json()).message).toMatch(msg);
  }
  expect(auditRows("auth.refused").length).toBe(3);
  expect(app.repo.users.findByEmail("alice@example.com")).toBeUndefined();
});

test("a token for another provider's client, or signed by an unknown key, is refused", async () => {
  let r = await exchange("entra", await idp.issue(googleClaims()));
  expect(r.status).toBe(403);
  r = await exchange("google", await idp.issue(googleClaims(), { forged: true }));
  expect(r.status).toBe(403);
  expect((await r.json()).message).toMatch(/signature verification failed/);
});

test("an IdP failure is a 502, audited, not a refusal", async () => {
  idp.failToken = 1;
  const r = await exchange("google", await idp.issue(googleClaims()));
  expect(r.status).toBe(502);
  const body = await r.json();
  expect(body.code).toBe("idp_error");
  expect(body.message).toMatch(/token exchange failed \(503\)/);
  expect(auditRows("auth.refused")[0]!.detail.reason).toMatch(/503/);
});

test("an unknown provider is a 400", async () => {
  const r = await exchange("okta", "code");
  expect(r.status).toBe(400);
});

test("admin unlink clears links so the next sign-in binds afresh", async () => {
  const admin = await signIn("google", googleClaims({ sub: "g-admin", email: "admin@example.com", name: "Admin" }));
  const sam = await signIn("google", googleClaims({ sub: "g-sam", email: "sam@example.org", hd: undefined }));
  // Sam's Google account is recreated: a non-authoritative address won't re-link by itself.
  let r = await exchange("google", await idp.issue(googleClaims({ sub: "g-sam-2", email: "sam@example.org", hd: undefined })));
  expect(r.status).toBe(403);

  const unlink = (token: string, body: object) => fetch(`${base}/api/admin/unlink`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  expect((await unlink(sam.session_token, { email: "sam@example.org" })).status).toBe(403);
  expect((await unlink(admin.session_token, { email: "sam@example.org", provider: "okta" })).status).toBe(400);
  expect((await unlink(admin.session_token, { email: "nobody@example.org" })).status).toBe(404);
  r = await unlink(admin.session_token, { email: "sam@example.org", provider: "google" });
  expect(await r.json()).toEqual({ ok: true, removed: 1 });
  expect(auditRows("auth.unlinked")).toEqual([{ actor: "admin@example.com", target: "sam@example.org", detail: { provider: "google", removed: 1 } }]);

  r = await exchange("google", await idp.issue(googleClaims({ sub: "g-sam-2", email: "sam@example.org", hd: undefined })));
  expect(r.status).toBe(200);
});
