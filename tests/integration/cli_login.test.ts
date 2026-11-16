// `grayboard login` end to end through the server's authorization server
// (#928 D8): the real CLI against a real server, its browser a fake xdg-open
// that hands the authorize URL to a scripted browser walking the real consent
// page (only the upstream Google exchange is stubbed), ending with a
// credentials file in the same format as before and a working whoami.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessAudits } from "../support/audit.ts";
import { runCli } from "../support/cli.ts";
import { browse, hostedServer, type HostedServer } from "../support/hosted_oauth.ts";
import { Browser } from "../support/oauth_browser.ts";
import { until } from "../support/until.ts";

const EMAIL = "alice@example.com";
let srv: HostedServer, dir: string, env: Record<string, string>, opened: string;

beforeEach(() => {
  srv = hostedServer({}, EMAIL);
  dir = mkdtempSync(join(tmpdir(), "gb-cli-login-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  opened = join(dir, "opened");
  // The CLI's browser (`open` on macOS, `xdg-open` elsewhere): records the URL it was asked to open.
  for (const name of ["open", "xdg-open"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s' "$1" > '${opened}.tmp' && mv '${opened}.tmp' '${opened}'\n`);
    chmodSync(join(bin, name), 0o755);
  }
  env = { PATH: `${bin}:${process.env.PATH}`, HOME: join(dir, "home"), GRAYBOARD_CREDENTIALS: join(dir, "credentials"), NO_COLOR: "1" };
});
afterEach(async () => {
  await srv.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("grayboard login signs in through the AS as grayboard-cli and stores a working API token", async () => {
  const login = runCli(["login", "--server", srv.issuer], { env, timeoutMs: 30_000 });
  await until(() => existsSync(opened), 20_000, "the CLI to open the authorize URL");
  const url = new URL(readFileSync(opened, "utf8"));
  expect(url.origin + url.pathname).toBe(`${srv.issuer}/oauth/authorize`);
  expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: "grayboard-cli", scope: "grayboard:login", response_type: "code", code_challenge_method: "S256" });
  expect(url.searchParams.has("resource")).toBe(false);
  expect(new URL(url.searchParams.get("redirect_uri")!).hostname).toBe("127.0.0.1");
  expect(await browse(srv.issuer, url.href, "the CLI")).toContain("Signed in to grayboard");
  const result = await login;
  expect(result.err).toBe("");
  expect(result.code).toBe(0);
  expect(result.out).toContain(`Logged in as ${EMAIL}`);

  const file = env.GRAYBOARD_CREDENTIALS!;
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const creds = JSON.parse(readFileSync(file, "utf8"));
  expect(Object.keys(creds).sort()).toEqual(["server", "session_token", "user_email"]);
  expect(creds).toMatchObject({ server: srv.issuer, user_email: EMAIL });
  expect(creds.session_token).toStartWith("gbrd_v1_");
  const issued = accessAudits(srv.app.db, "oauth.session_issued");
  expect(issued).toEqual([expect.objectContaining({ actor: EMAIL, detail: expect.objectContaining({ client_id: "grayboard-cli" }) })]);
  expect(srv.app.db.query("SELECT label FROM sessions WHERE id = ?").get(issued[0]!.detail.token_session as number)).toEqual({ label: expect.stringMatching(/\S/) });

  const whoami = await runCli(["whoami"], { env });
  expect(whoami.code).toBe(0);
  expect(whoami.out).toContain(EMAIL);
});

test("a denied consent fails the login and writes no credentials", async () => {
  const login = runCli(["login", "--server", srv.issuer], { env, timeoutMs: 30_000 });
  await until(() => existsSync(opened), 20_000, "the CLI to open the authorize URL");
  expect(await browse(srv.issuer, readFileSync(opened, "utf8"), "the CLI", "deny")).toContain("did not complete");
  const result = await login;
  expect(result.code).toBe(1);
  expect(result.err).toContain("sign-in was denied");
  expect(existsSync(env.GRAYBOARD_CREDENTIALS!)).toBe(false);
  expect(srv.app.db.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
});

// A refusal after the upstream sign-in returns to the CLI's loopback (#928): the CLI exits at once, printing the
// server's reason, rather than waiting out its five minutes; the browser tab only says the sign-in didn't complete.
test("a refusal at the provider callback reaches the CLI, which exits promptly with the reason", async () => {
  await srv.app.repo.write(() => srv.app.repo.users.upsertByEmail(EMAIL, null));
  await srv.app.repo.write(() => srv.app.db.run("UPDATE users SET disabled_at = ? WHERE email = ?", [Date.now(), EMAIL]));
  const started = Date.now();
  const login = runCli(["login", "--server", srv.issuer], { env, timeoutMs: 30_000 });
  await until(() => existsSync(opened), 20_000, "the CLI to open the authorize URL");
  const browser = new Browser();
  const begin = await browser.request(readFileSync(opened, "utf8"));
  const google = new URL(begin.headers.get("Location")!);
  const callback = await browser.request(`${srv.issuer}/oauth/google/callback?` + new URLSearchParams({ code: "upstream-code", state: google.searchParams.get("state")!, iss: "https://accounts.google.com" }));
  expect(callback.status).toBe(303);
  const loopback = new URL(callback.headers.get("Location")!);
  expect([loopback.hostname, loopback.searchParams.get("error")]).toEqual(["127.0.0.1", "access_denied"]);
  expect(await (await fetch(loopback)).text()).toContain("did not complete");
  const result = await login;
  expect(result.code).toBe(1);
  expect(result.err).toContain("sign-in was refused: this account is disabled on this server");
  expect(Date.now() - started).toBeLessThan(25_000);
  expect(accessAudits(srv.app.db, "oauth.user_refused")).toEqual([expect.objectContaining({ actor: EMAIL, detail: { client_id: "grayboard-cli" } })]);
  expect(existsSync(env.GRAYBOARD_CREDENTIALS!)).toBe(false);
});
