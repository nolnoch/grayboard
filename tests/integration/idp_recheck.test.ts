// #930 A2: a provider with a directory check (IdentityProvider.status) is asked again about a user whose IdP clock is
// older than GRAYBOARD_IDP_RECHECK_HOURS: blocking on a refresh, in the background on a CLI token's use. On either
// backend (GRAYBOARD_TEST_BACKEND=pg), against a stub provider whose answers each test scripts.
import { afterEach, expect, test } from "bun:test";
import { issueOAuth } from "../helpers/oauth.ts";
import type { IdentityProvider } from "../../src/server/idp.ts";
import { accessAudits } from "../support/audit.ts";
import { exec, row } from "../support/repo_sql.ts";
import { TestServer } from "../support/server.ts";
import { until } from "../support/until.ts";

const A = "alice@example.com", B = "bob@example.com", C = "carol@example.com", HOUR = 3_600_000, ISSUER = "https://idp.example";
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
  srv = await TestServer.open({ idpRecheck: recheck }, { now: () => clock, oauth: { now: () => clock, providers: [stub] } });
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
  const g2 = await grant();
  await vouched(A, 73);
  const unavailable = await refresh(g2.refreshToken);
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toEqual({ error: "temporarily_unavailable" });
  expect((await user(A))!.disabled_at).toBeNull();
  expect((await accessAudits(srv, "auth.idp_check_failed")).map(a => a.detail.error_class)).toEqual(["Error", "Error"]);
  // The IdP back: the same token rotates.
  answer = () => "active";
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

test("past the stale bound a CLI token waits for the check and is refused while the IdP is down", async () => {
  await open();
  const cli = await srv.login(A);
  await vouched(A, 73);
  answer = () => new Error("down");
  expect((await srv.api(cli, "GET", "/api/whoami")).status).toBe(401);
  expect(calls).toEqual(["s-alice"]);
  expect((await user(A))!.disabled_at).toBeNull();
  // The IdP back: once the auth gate's minute-long refusal cache lapses, the same token works, and the answer
  // restamps the clock.
  answer = () => "active";
  clock += 61_000;
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
