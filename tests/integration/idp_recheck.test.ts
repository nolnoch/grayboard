// #930 A2: a provider with a directory check (IdentityProvider.status) is asked again about a user whose IdP clock is
// older than GRAYBOARD_IDP_RECHECK_HOURS: blocking on a refresh, in the background on a CLI token's use. On either
// backend (GRAYBOARD_TEST_BACKEND=pg), against a stub provider whose answers each test scripts.
import { afterEach, expect, test } from "bun:test";
import { issueOAuth } from "../helpers/oauth.ts";
import type { IdentityProvider } from "../../src/server/idp.ts";
import { GOOGLE_ISSUER, googleProvider } from "../../src/server/idp_google.ts";
import { exportPKCS8, generateKeyPair } from "jose";
import { oidcProvider } from "../../src/server/idp_oidc.ts";
import { keycloakDirectoryStatus } from "../../src/server/idp_keycloak_directory.ts";
import { oktaDirectoryStatus, parseOktaDirectoryKey } from "../../src/server/idp_okta_directory.ts";
import { createIdpRecheck, TRANSIENT_BACKOFF_MS } from "../../src/server/idp_recheck.ts";
import { accessAudits } from "../support/audit.ts";
import { exec, row } from "../support/repo_sql.ts";
import { TestServer } from "../support/server.ts";
import { until } from "../support/until.ts";

const A = "alice@example.com", B = "bob@example.com", C = "carol@example.com", ROOT = "root@example.com", HOUR = 3_600_000, ISSUER = "https://idp.example";
type Answer = "active" | "inactive" | Error | Promise<"active" | "inactive">;
let srv: TestServer, clock: number, calls: string[], answer: (subject: string) => Answer;

const stub: IdentityProvider = {
  id: "stub", label: "Stub", issuer: ISSUER, callbackParams: ["code", "state"],
  async authorizeUrl() { return "https://idp.example/authorize"; },
  async exchange() { throw new Error("no sign-in in this test"); },
  async status(subject) {
    calls.push(subject);
    const a = answer(subject);
    if (a instanceof Error) throw a;
    return a;
  },
};

async function open(recheck = { recheckHours: 24, maxStaleHours: 72, disableLimit: 5 }) {
  clock = Date.now(); calls = []; answer = () => "active";
  srv = await TestServer.open({ idpRecheck: recheck, admins: [ROOT] }, { now: () => clock, oauth: { now: () => clock, providers: [stub] } });
  await srv.app.ready;
}
afterEach(() => srv.stop());

const refresh = (token: string) => fetch(`${srv.base}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "refresh_token", client_id: "grayboard-pi", refresh_token: token, resource: srv.app.oauth.resource }) });
const grant = (email = A) => issueOAuth(srv.app.repo, srv.app.oauth.resource, email, ["grayboard:tools"], clock, "grayboard-pi");
// Links the user to the stub (subject "s-<name>") and sets their IdP clock `hoursAgo` before now.
const vouched = (email: string, hoursAgo: number | null) =>
  exec(srv, "UPDATE users SET idp_issuer = ?, idp_subject = ?, idp_checked_at = ? WHERE email = ?",
    ISSUER, `s-${email.split("@")[0]}`, hoursAgo === null ? null : clock - hoursAgo * HOUR, email);
const user = (email: string) => row<{ disabled_at: number | null; idp_checked_at: number | null }>(srv, "SELECT disabled_at, idp_checked_at FROM users WHERE email = ?", email);
// A user the stub has answered "active" for, so its negatives count from here on.
async function confirm() {
  const c = await grant(C);
  await vouched(C, 25);
  expect((await refresh(c.refreshToken)).status).toBe(200);
}

test("within the interval nothing asks the IdP; past it an active answer restamps the clock and the refresh rotates", async () => {
  await open();
  const g = await grant();
  await vouched(A, 23);
  const first = await refresh(g.refreshToken);
  expect(first.status).toBe(200);
  expect(calls).toEqual([]);
  clock += 2 * HOUR;
  const second = await refresh((await first.json()).refresh_token);
  expect(second.status).toBe(200);
  expect(calls).toEqual(["s-alice"]);
  expect((await user(A))!.idp_checked_at).toBe(clock);
});

test("an inactive answer disables the user: the refresh is invalid_grant, the grant and CLI token die, one audit row", async () => {
  await open();
  await confirm();
  const cli = await srv.login(A);
  const g = await grant();
  await vouched(A, 25);
  answer = () => "inactive";
  const refused = await refresh(g.refreshToken);
  expect(refused.status).toBe(400);
  expect(await refused.json()).toEqual({ error: "invalid_grant" });
  expect((await user(A))!.disabled_at).not.toBeNull();
  expect(await srv.app.repo.oauth.isGrantActive(srv.app.repo.read, g.grantId, clock)).toBe(false);
  expect((await srv.api(cli, "GET", "/api/whoami")).status).toBe(401);
  expect((await accessAudits(srv, "auth.idp_disabled")).map(a => [a.target, a.detail])).toEqual([[A, { provider: "stub", issuer: ISSUER, reason: "inactive" }]]);
});

test("an inactive answer from a provider that never answered active disables nobody", async () => {
  await open();
  const g = await grant();
  await vouched(A, 25);
  answer = () => "inactive";
  expect((await refresh(g.refreshToken)).status).toBe(200);
  expect((await user(A))!.disabled_at).toBeNull();
  expect((await accessAudits(srv, "auth.idp_check_failed")).map(a => a.detail.error_class)).toEqual(["unconfirmed_inactive"]);
});

test("an IdP outage fails open within the stale bound, then answers 503 with the refresh token unspent", async () => {
  await open();
  const g = await grant();
  await vouched(A, 25);
  answer = () => new Error("upstream 502");
  expect((await refresh(g.refreshToken)).status).toBe(200);
  clock += TRANSIENT_BACKOFF_MS;
  const g2 = await grant();
  await vouched(A, 73);
  const unavailable = await refresh(g2.refreshToken);
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toEqual({ error: "temporarily_unavailable" });
  expect((await user(A))!.disabled_at).toBeNull();
  expect((await accessAudits(srv, "auth.idp_check_failed")).map(a => a.detail.error_class)).toEqual(["Error", "Error"]);
  // The IdP back: once the backoff lapses, the same token rotates.
  answer = () => "active";
  clock += TRANSIENT_BACKOFF_MS;
  expect((await refresh(g2.refreshToken)).status).toBe(200);
});

test("a status call that never answers times out as transient, even when the provider ignores the abort", async () => {
  await open();
  const g = await grant();
  await vouched(A, 25);
  answer = () => new Promise(() => {});
  expect((await refresh(g.refreshToken)).status).toBe(200);
  expect((await accessAudits(srv, "auth.idp_check_failed")).map(a => a.detail.error_class)).toEqual(["timeout"]);
}, 15_000);

test("past the disable limit in an hour automatic disables stop, and the check fails open", async () => {
  await open({ recheckHours: 24, maxStaleHours: 72, disableLimit: 1 });
  await confirm();
  const a = await grant(A), b = await grant(B);
  await vouched(A, 25); await vouched(B, 25);
  answer = () => "inactive";
  expect((await refresh(a.refreshToken)).status).toBe(400);
  expect((await refresh(b.refreshToken)).status).toBe(200);
  expect((await user(A))!.disabled_at).not.toBeNull();
  expect((await user(B))!.disabled_at).toBeNull();
  expect((await accessAudits(srv, "auth.idp_recheck_tripped")).map(r => r.detail)).toEqual([{ provider: "stub", limit: 1, level: "error" }]);
  expect((await accessAudits(srv, "auth.idp_check_failed")).map(r => [r.target, r.detail.error_class])).toEqual([[B, "breaker_tripped"]]);
});

test("after a transient answer the user is backed off: no status call and no audit row until it lapses", async () => {
  await open();
  const g = await grant();
  await vouched(A, 25);
  answer = () => new Error("down");
  const first = await refresh(g.refreshToken);
  expect(first.status).toBe(200);
  clock += TRANSIENT_BACKOFF_MS - 1;
  const second = await refresh((await first.json()).refresh_token);
  expect(second.status).toBe(200);
  expect(calls).toEqual(["s-alice"]);
  // Past the stale bound a backed-off user's refresh still answers 503, from the cached transient.
  await vouched(A, 73);
  const g2 = await grant();
  expect((await refresh(g2.refreshToken)).status).toBe(503);
  expect(calls).toEqual(["s-alice"]);
  clock += 1;
  expect((await refresh((await second.json()).refresh_token)).status).toBe(503);
  expect(calls).toEqual(["s-alice", "s-alice"]);
  expect((await accessAudits(srv, "auth.idp_check_failed")).length).toBe(2);
});

test("a sign-in that restamps the clock while the status call runs keeps the user, and the no-op disable isn't counted", async () => {
  await open({ recheckHours: 24, maxStaleHours: 72, disableLimit: 1 });
  await confirm();
  const a = await grant(A), b = await grant(B);
  await vouched(A, 25); await vouched(B, 25);
  answer = subject => subject === "s-alice"
    ? exec(srv, "UPDATE users SET idp_checked_at = ? WHERE email = ?", clock, A).then(() => "inactive" as const)
    : "inactive";
  expect((await refresh(a.refreshToken)).status).toBe(200);
  expect((await user(A))!.disabled_at).toBeNull();
  expect(await accessAudits(srv, "auth.idp_disabled")).toEqual([]);
  // The limit of one is still unspent.
  expect((await refresh(b.refreshToken)).status).toBe(400);
  expect((await user(B))!.disabled_at).not.toBeNull();
  expect(await accessAudits(srv, "auth.idp_recheck_tripped")).toEqual([]);
});

test("a disable calls the disconnect and Slack hooks once it commits, and names the services it orphans", async () => {
  await open();
  const root = await srv.login(ROOT);
  await srv.login(A); await srv.login(C);
  expect((await srv.api(root, "POST", "/api/admin/services", { name: "solo", owners: [A] })).status).toBe(201);
  await vouched(A, 25);
  const disconnected: number[] = [], changed: number[] = [];
  const recheck = createIdpRecheck(srv.app.repo, [stub], { recheckHours: 24, maxStaleHours: 72, disableLimit: 5, reauthDays: 30 }, {
    disconnectUser: id => disconnected.push(id), userChanged: id => { changed.push(id); }, background: () => {},
  }, () => clock);
  const id = (await row<{ id: number }>(srv, "SELECT id FROM users WHERE email = ?", A))!.id;
  const carol = (await row<{ id: number }>(srv, "SELECT id FROM users WHERE email = ?", C))!.id;
  // Carol's active answer confirms the provider.
  await vouched(C, 25);
  expect(await recheck.beforeRefresh(carol)).toBe("ok");
  answer = () => "inactive";
  expect(await recheck.beforeRefresh(id)).toBe("refuse");
  expect(disconnected).toEqual([id]);
  expect(changed).toEqual([id]);
  expect((await accessAudits(srv, "auth.idp_disabled")).map(a => a.detail)).toEqual([{ provider: "stub", issuer: ISSUER, reason: "inactive", orphaned_services: ["solo"] }]);
});

test("a covered user with no clock (a row an older release linked) is checked at once", async () => {
  await open();
  const g = await grant();
  await vouched(A, null);
  expect((await refresh(g.refreshToken)).status).toBe(200);
  expect(calls).toEqual(["s-alice"]);
  expect((await user(A))!.idp_checked_at).toBe(clock);
});

test("concurrent refreshes of one user's grants make one IdP call", async () => {
  await open();
  const g1 = await grant(), g2 = await grant();
  await vouched(A, 25);
  let release!: (a: "active") => void;
  const gate = new Promise<"active">(r => { release = r; });
  answer = () => gate;
  const both = Promise.all([refresh(g1.refreshToken), refresh(g2.refreshToken)]);
  await until(() => calls.length === 1);
  release("active");
  expect((await both).map(r => r.status)).toEqual([200, 200]);
  expect(calls).toEqual(["s-alice"]);
});

test("a replayed refresh token skips the IdP and still revokes its family", async () => {
  await open();
  const g = await grant();
  await vouched(A, 1);
  expect((await refresh(g.refreshToken)).status).toBe(200);
  clock += 100 * HOUR;
  answer = () => new Error("down");
  const replay = await refresh(g.refreshToken);
  expect(replay.status).toBe(400);
  expect(calls).toEqual([]);
  expect(await srv.app.repo.oauth.isGrantActive(srv.app.repo.read, g.grantId, clock)).toBe(false);
});

test("a stale user's CLI token works while the background check runs, which disables them on an inactive answer", async () => {
  await open();
  await confirm();
  const cli = await srv.login(A);
  await vouched(A, 25);
  answer = () => "inactive";
  expect((await srv.api(cli, "GET", "/api/whoami")).status).toBe(200);
  await until(async () => (await user(A))!.disabled_at !== null, 5000, "the background check disabled alice");
  expect((await srv.api(cli, "GET", "/api/whoami")).status).toBe(401);
});

test("past the stale bound a CLI token waits for the check and answers a retryable 503 while the IdP is down", async () => {
  await open();
  const cli = await srv.login(A);
  await vouched(A, 73);
  answer = () => new Error("down");
  const down = await fetch(`${srv.base}/api/whoami`, { headers: { Authorization: `Bearer ${cli}` } });
  expect(down.status).toBe(503);
  expect(down.headers.get("retry-after")).toBe("60");
  expect(await down.json()).toEqual({ code: "temporarily_unavailable", message: "the identity provider is unreachable; retry in a minute" });
  expect(calls).toEqual(["s-alice"]);
  expect((await user(A))!.disabled_at).toBeNull();
  // The IdP back: once the backoff lapses, the same token works, and the answer restamps the clock.
  answer = () => "active";
  clock += TRANSIENT_BACKOFF_MS;
  expect((await srv.api(cli, "GET", "/api/whoami")).status).toBe(200);
  expect(calls).toEqual(["s-alice", "s-alice"]);
  expect((await user(A))!.idp_checked_at).toBe(clock);
});

test("a user the directory covers is off the GRAYBOARD_IDP_REAUTH_DAYS fallback", async () => {
  await open();
  const g = await grant();
  const cli = await srv.login(A);
  // Older than the 30-day fallback; the directory says active.
  await vouched(A, 31 * 24);
  expect((await srv.api(cli, "GET", "/api/whoami")).status).toBe(200);
  expect((await refresh(g.refreshToken)).status).toBe(200);
});

test("an outage within a long stale bound doesn't send a covered user to the fallback inside the rotation", async () => {
  await open({ recheckHours: 24, maxStaleHours: 40 * 24, disableLimit: 5 });
  const g = await grant();
  await vouched(A, 31 * 24);
  answer = () => new Error("down");
  expect((await refresh(g.refreshToken)).status).toBe(200);
});

// #930 A2b: the real Google provider, its directory check pointed at a scripted Google, through the same refresh path.
test("Google's directory check: an active answer confirms it, a suspended one disables; a 404 or a refused key is transient and classed", async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  const key = { kind: "key" as const, clientEmail: "sa@p.iam.gserviceaccount.com", privateKey: await exportPKCS8(pair.privateKey) };
  let tokenStatus = 200;
  const directory: Record<string, { suspended: boolean }> = { "111": { suspended: false }, "222": { suspended: true }, "333": { suspended: false } };
  const fakeGoogle = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.host === "token.test") return tokenStatus === 200 ? Response.json({ access_token: "t", expires_in: 3600 }) : Response.json({ error: "invalid_grant" }, { status: tokenStatus });
    const user = directory[url.pathname.split("/").pop()!];
    return user ? Response.json(user) : new Response("", { status: 404 });
  }) as typeof fetch;
  const google = googleProvider({ clientId: "c", clientSecret: "s", orgDomain: "example.com" }, key,
    { tokenUrl: "https://token.test", apiBase: "https://api.test", fetch: fakeGoogle, now: () => clock });
  clock = Date.now(); calls = [];
  srv = await TestServer.open({ idpRecheck: { recheckHours: 24, maxStaleHours: 72, disableLimit: 5 }, admins: [ROOT] },
    { now: () => clock, oauth: { now: () => clock, providers: [google] } });
  await srv.app.ready;
  const link = (email: string, subject: string, hoursAgo: number) =>
    exec(srv, "UPDATE users SET idp_issuer = ?, idp_subject = ?, idp_checked_at = ? WHERE email = ?", GOOGLE_ISSUER, subject, clock - hoursAgo * HOUR, email);
  const c = await grant(C), a = await grant(A), b = await grant(B);
  await link(C, "111", 25); await link(A, "222", 25); await link(B, "333", 25);
  expect((await refresh(c.refreshToken)).status).toBe(200);
  expect((await user(C))!.idp_checked_at).toBe(clock);
  expect((await refresh(a.refreshToken)).status).toBe(400);
  expect((await user(A))!.disabled_at).not.toBeNull();
  expect((await accessAudits(srv, "auth.idp_disabled")).map(x => x.detail)).toEqual([{ provider: "google", issuer: GOOGLE_ISSUER, reason: "inactive" }]);
  // #1600: a 404 (Bob's subject isn't in the directory) is a failed check even after an active answer confirmed the
  // provider: he keeps working within the stale bound and isn't disabled.
  await link(B, "444", 25);
  const rotated = await refresh(b.refreshToken);
  expect(rotated.status).toBe(200);
  const bNext = ((await rotated.json()) as { refresh_token: string }).refresh_token;
  expect((await user(B))!.disabled_at).toBeNull();
  expect((await accessAudits(srv, "auth.idp_check_failed")).map(x => x.detail.error_class)).toEqual(["google_user_not_found"]);
  // A refused key: Bob is due, the check fails, he keeps working within the stale bound, and the class names the key.
  tokenStatus = 400;
  clock += 2 * HOUR;
  await exec(srv, "UPDATE users SET idp_checked_at = ? WHERE email = ?", clock - 25 * HOUR, B);
  const warn = console.warn;
  console.warn = () => {};
  try { expect((await refresh(bNext)).status).toBe(200); } finally { console.warn = warn; }
  expect((await user(B))!.disabled_at).toBeNull();
  expect((await accessAudits(srv, "auth.idp_check_failed")).map(x => x.detail.error_class)).toEqual(["google_user_not_found", "google_token_refused"]);
});

// #1555: the oidc provider with Keycloak's directory check, pointed at a scripted Keycloak, through the same refresh path.
test("Keycloak's directory check: enabled confirms, disabled or gone disables; a brute-force lockout is transient and classed", async () => {
  const KC = "https://sso.example.com", KC_ISSUER = `${KC}/realms/eng`;
  const users: Record<string, { enabled: boolean; locked?: boolean }> = { "u-c": { enabled: true }, "u-a": { enabled: false }, "u-b": { enabled: false, locked: true } };
  const fakeKeycloak = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === `${KC}/realms/eng/protocol/openid-connect/token`) return Response.json({ access_token: "t", expires_in: 300 });
    const id = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
    if (url.startsWith(`${KC}/admin/realms/eng/attack-detection/brute-force/users/`)) return Response.json({ disabled: users[id]?.locked ?? false });
    if (url.startsWith(`${KC}/admin/realms/eng/users/`))
      return users[id] ? Response.json({ id, enabled: users[id]!.enabled }) : Response.json({ error: "User not found" }, { status: 404 });
    return new Response("", { status: 599 });
  }) as typeof fetch;
  const keycloak: IdentityProvider = {
    ...oidcProvider({ id: "oidc", label: "SSO", issuer: KC_ISSUER, clientId: "grayboard", allowedDomains: ["example.com"] }),
    status: keycloakDirectoryStatus({ baseUrl: KC, realm: "eng", clientId: "grayboard-directory", clientSecret: "s" }, { fetch: fakeKeycloak, now: () => clock }),
  };
  clock = Date.now(); calls = [];
  srv = await TestServer.open({ idpRecheck: { recheckHours: 24, maxStaleHours: 72, disableLimit: 5 }, admins: [ROOT] },
    { now: () => clock, oauth: { now: () => clock, providers: [keycloak] } });
  await srv.app.ready;
  const D = "dave@example.com";
  const link = (email: string, subject: string, hoursAgo: number) =>
    exec(srv, "UPDATE users SET idp_issuer = ?, idp_subject = ?, idp_checked_at = ? WHERE email = ?", KC_ISSUER, subject, clock - hoursAgo * HOUR, email);
  const c = await grant(C), a = await grant(A), b = await grant(B), d = await grant(D);
  await link(C, "u-c", 25); await link(A, "u-a", 25); await link(B, "u-b", 25); await link(D, "u-gone", 25);
  expect((await refresh(c.refreshToken)).status).toBe(200);
  expect((await user(C))!.idp_checked_at).toBe(clock);
  expect((await refresh(a.refreshToken)).status).toBe(400);
  expect((await user(A))!.disabled_at).not.toBeNull();
  expect((await refresh(d.refreshToken)).status).toBe(400);
  expect((await user(D))!.disabled_at).not.toBeNull();
  expect((await accessAudits(srv, "auth.idp_disabled")).map(x => x.detail)).toEqual([
    { provider: "oidc", issuer: KC_ISSUER, reason: "inactive" }, { provider: "oidc", issuer: KC_ISSUER, reason: "inactive" }]);
  // Locked out by brute-force detection: an attack on the account, not an offboarding. Bob keeps working within the
  // stale bound, and the class says why.
  expect((await refresh(b.refreshToken)).status).toBe(200);
  expect((await user(B))!.disabled_at).toBeNull();
  expect((await accessAudits(srv, "auth.idp_check_failed")).map(x => x.detail.error_class)).toEqual(["keycloak_locked_out"]);
});

// #1563: the okta provider with Okta's directory check, pointed at a scripted org (DPoP off, Bearer tokens), through the
// same refresh path.
test("Okta's directory check: ACTIVE confirms, SUSPENDED, DEPROVISIONED or gone disables; STAGED is transient and classed", async () => {
  const ORG = "https://example.okta.com", OKTA_ISSUER = `${ORG}/oauth2/default`;
  const statuses: Record<string, string> = { "00uC": "LOCKED_OUT", "00uA": "SUSPENDED", "00uB": "STAGED", "00uE": "DEPROVISIONED" };
  const fakeOkta = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === `${ORG}/oauth2/v1/token`) return Response.json({ access_token: "t", expires_in: 3600, token_type: "Bearer" });
    const id = url.slice(url.lastIndexOf("/") + 1);
    if (url.startsWith(`${ORG}/api/v1/users/`))
      return statuses[id] ? Response.json({ id, status: statuses[id] }) : Response.json({ errorCode: "E0000007", errorSummary: "Not found" }, { status: 404 });
    return new Response("", { status: 599 });
  }) as typeof fetch;
  const pem = await exportPKCS8((await generateKeyPair("RS256", { extractable: true })).privateKey);
  const okta: IdentityProvider = {
    ...oidcProvider({ id: "okta", label: "Okta", issuer: OKTA_ISSUER, clientId: "grayboard", clientSecret: "s", allowedDomains: ["example.com"] }),
    status: oktaDirectoryStatus({ orgUrl: ORG, clientId: "0oa1checker", ...parseOktaDirectoryKey(pem, undefined) }, { fetch: fakeOkta, now: () => clock }),
  };
  clock = Date.now(); calls = [];
  srv = await TestServer.open({ idpRecheck: { recheckHours: 24, maxStaleHours: 72, disableLimit: 5 }, admins: [ROOT] },
    { now: () => clock, oauth: { now: () => clock, providers: [okta] } });
  await srv.app.ready;
  const D = "dave@example.com", E = "erin@example.com";
  const link = (email: string, subject: string, hoursAgo: number) =>
    exec(srv, "UPDATE users SET idp_issuer = ?, idp_subject = ?, idp_checked_at = ? WHERE email = ?", OKTA_ISSUER, subject, clock - hoursAgo * HOUR, email);
  const c = await grant(C), a = await grant(A), b = await grant(B), d = await grant(D), e = await grant(E);
  await link(C, "00uC", 25); await link(A, "00uA", 25); await link(B, "00uB", 25); await link(D, "00uGone", 25); await link(E, "00uE", 25);
  // A password lockout is active, and the positive arms the guard for the disables below.
  expect((await refresh(c.refreshToken)).status).toBe(200);
  expect((await user(C))!.idp_checked_at).toBe(clock);
  for (const [who, t] of [[A, a], [D, d], [E, e]] as const) {
    expect((await refresh(t.refreshToken)).status).toBe(400);
    expect((await user(who))!.disabled_at).not.toBeNull();
  }
  expect((await accessAudits(srv, "auth.idp_disabled")).map(x => x.detail)).toEqual(Array(3).fill({ provider: "okta", issuer: OKTA_ISSUER, reason: "inactive" }));
  // STAGED is neither answer: Bob keeps working within the stale bound, and the class says why.
  expect((await refresh(b.refreshToken)).status).toBe(200);
  expect((await user(B))!.disabled_at).toBeNull();
  expect((await accessAudits(srv, "auth.idp_check_failed")).map(x => x.detail.error_class)).toEqual(["okta_status_unknown"]);
});
