// #930: with no directory check, a person's grants and CLI tokens stop working GRAYBOARD_IDP_REAUTH_DAYS after the IdP
// last vouched for them, on either backend (GRAYBOARD_TEST_BACKEND=pg). A refused refresh spends nothing, so the client's
// token works again once a sign-in restarts the clock; a row with neither issuer nor clock reads as not due.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { issueOAuth } from "../helpers/oauth.ts";
import { REFUSED_TOKEN_TTL_MS } from "../../src/server/auth_gate.ts";
import { exec } from "../support/repo_sql.ts";
import { TestServer } from "../support/server.ts";

const A = "alice@example.com", DAY = 86_400_000;
let srv: TestServer, clock: number;

beforeEach(async () => {
  clock = Date.now();
  srv = await TestServer.open({}, { now: () => clock, oauth: { now: () => clock } });
  await srv.app.ready;
});
afterEach(() => srv.stop());

const refresh = (token: string) => fetch(`${srv.base}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "refresh_token", client_id: "grayboard-pi", refresh_token: token, resource: srv.app.oauth.resource }) });
const vouched = (at: number | null, issuer: string | null = "https://idp.example") =>
  exec(srv, "UPDATE users SET idp_issuer = ?, idp_subject = ?, idp_checked_at = ? WHERE email = ?", issuer, issuer ? "s-alice" : null, at, A);

test("past the window a refresh is invalid_grant and leaves the token unspent; a CLI token is refused; a sign-in restores both", async () => {
  const cli = await srv.login(A);
  const issued = await issueOAuth(srv.app.repo, srv.app.oauth.resource, A, ["grayboard:tools"], clock, "grayboard-pi");
  // Vouched for 10 days before the grant, so the window ends while the refresh token (30 days) still lives.
  await vouched(clock - 10 * DAY);
  clock += 20 * DAY + 1;
  const refused = await refresh(issued.refreshToken);
  expect(refused.status).toBe(400);
  expect(await refused.json()).toEqual({ error: "invalid_grant" });
  expect((await srv.api(cli, "GET", "/api/whoami")).status).toBe(401);
  // What a fresh sign-in does to the user (the stores' signIn, contract-tested): the clock restarts. Past the auth
  // gate's memory of the refused token, which otherwise answers for it.
  clock += REFUSED_TOKEN_TTL_MS + 1;
  await vouched(clock);
  expect((await refresh(issued.refreshToken)).status).toBe(200);
  expect((await srv.api(cli, "GET", "/api/whoami")).status).toBe(200);
});

test("a linked row with no clock (one a release without the column linked) is due; one with neither issuer nor clock is not", async () => {
  const cli = await srv.login(A);
  await vouched(null);
  expect((await srv.api(cli, "GET", "/api/whoami")).status).toBe(401);
  await vouched(null, null);
  clock += REFUSED_TOKEN_TTL_MS + 1;
  expect((await srv.api(cli, "GET", "/api/whoami")).status).toBe(200);
});
