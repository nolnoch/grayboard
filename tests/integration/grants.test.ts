// The per-grant list and revoke (#930): a user lists and revokes their own OAuth grants and CLI tokens one at a time,
// an org admin another user's; revoking one leaves the rest serving.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../support/cli.ts";
import { cleanEnv } from "../support/env.ts";
import { issueOAuth, rotateOAuth } from "../helpers/oauth.ts";
import { hostedServer, upstreamLeg } from "../support/hosted_oauth.ts";
import { Browser, consentForm, submitConsent } from "../support/oauth_browser.ts";
import { drained, rows } from "../support/repo_sql.ts";
import { TestServer } from "../support/server.ts";

const A = "alice@example.com", B = "bob@example.com", ROOT = "root@example.com";
let srv: TestServer;

beforeEach(async () => {
  srv = await TestServer.open({ admins: [ROOT] });
});
afterEach(() => srv.stop());

const api = (token: string, method: string, path: string, body?: unknown) => srv.api(token, method, path, body);
const issue = (email: string, clientId: string, grantId?: string) => issueOAuth(srv.app.repo, srv.app.oauth.resource, email, ["grayboard:tools"], Date.now(), clientId, grantId);
const audits = async (action: string) => {
  await drained(srv);
  return (await rows<{ actor: string; target: string | null; detail: string }>(srv, `SELECT actor, target, detail FROM access_log WHERE action = ? ORDER BY id`, action))
    .map(r => ({ actor: r.actor, target: r.target, detail: JSON.parse(r.detail) as unknown }));
};

test("a user lists their grants and CLI tokens, and revoking one grant leaves the other refreshing", async () => {
  const alice = await login(A), aliceLaptop = await login(A);
  const pi = await issue(A, "grayboard-pi"), omp = await issue(A, "grayboard-omp");
  await issue(B, "grayboard-pi");
  const listed = await api(alice, "GET", "/api/grants");
  expect(listed.status).toBe(200);
  const grants = listed.body.grants as { id: string; kind: string; client_id?: string; current?: boolean }[];
  expect(grants.filter(g => g.kind === "oauth").map(g => [g.id, g.client_id]).sort()).toEqual([[omp.grantId, "grayboard-omp"], [pi.grantId, "grayboard-pi"]].sort());
  const cli = grants.filter(g => g.kind === "cli");
  expect(cli).toHaveLength(2);
  // The caller's own token is marked current; the other isn't.
  expect(cli.filter(g => g.current).length).toBe(1);
  expect(grants.every(g => !("scopes" in g) && !("resource" in g))).toBe(true);

  expect(await api(alice, "POST", "/api/grants/revoke", { id: pi.grantId })).toEqual({ status: 200, body: { ok: true, id: pi.grantId } });
  expect((await rotateOAuth(srv.app.repo, pi, pi.refreshToken)).status).not.toBe("ok");
  expect((await rotateOAuth(srv.app.repo, omp, omp.refreshToken)).status).toBe("ok");
  expect((await api(alice, "GET", "/api/grants")).body.grants.map((g: { id: string }) => g.id)).not.toContain(pi.grantId);
  expect((await api(alice, "POST", "/api/grants/revoke", { id: pi.grantId })).status).toBe(404);

  // A CLI token: revoking the other one signs that device out and leaves this one signed in.
  const other = cli.find(g => !g.current)!;
  expect((await api(alice, "POST", "/api/grants/revoke", { id: other.id })).status).toBe(200);
  const [first, second] = await Promise.all([api(alice, "GET", "/api/whoami"), api(aliceLaptop, "GET", "/api/whoami")]);
  expect([first.status, second.status].sort()).toEqual([200, 401]);
  expect((await api(alice, "POST", "/api/grants/revoke", { id: other.id })).status).toBe(404);

  expect(await audits("auth.grant_revoked")).toEqual([{ actor: A, target: A, detail: { grant_id: pi.grantId, client_id: "grayboard-pi" } }]);
  expect(await audits("auth.session_revoked")).toEqual([{ actor: A, target: A, detail: { token_session: Number(other.id.slice(4)) } }]);
});

test("a user can't revoke another user's grant or token: 404, and nothing changes", async () => {
  const alice = await login(A), bob = await login(B);
  const bobs = await issue(B, "grayboard-pi");
  const bobCli = ((await api(bob, "GET", "/api/grants")).body.grants as { id: string; kind: string }[]).find(g => g.kind === "cli")!;
  for (const id of [bobs.grantId, bobCli.id, "cli:999999", "nope"]) {
    expect((await api(alice, "POST", "/api/grants/revoke", { id })).status).toBe(404);
  }
  for (const body of [{}, { id: "" }, { id: 5 }, { id: "x".repeat(201) }]) {
    expect((await api(alice, "POST", "/api/grants/revoke", body)).status).toBe(400);
  }
  expect((await rotateOAuth(srv.app.repo, bobs, bobs.refreshToken)).status).toBe("ok");
  expect((await api(bob, "GET", "/api/whoami")).status).toBe(200);
  expect(await audits("auth.grant_revoked")).toEqual([]);
});

test("the admin routes list and revoke another user's grants; a non-admin gets 403", async () => {
  const root = await login(ROOT), alice = await login(A);
  const pi = await issue(A, "grayboard-pi");
  for (const [method, path, body] of [["GET", `/api/admin/grants?email=${encodeURIComponent(A)}`, undefined], ["POST", "/api/admin/grants/revoke", { email: A, id: pi.grantId }]] as const) {
    expect((await api(alice, method, path, body)).status).toBe(403);
  }
  const listed = await api(root, "GET", `/api/admin/grants?email=${encodeURIComponent("Alice@Example.com")}`);
  expect(listed.status).toBe(200);
  // No current marker: the admin's own token isn't in this list.
  expect((listed.body.grants as { id: string; current?: boolean }[]).some(g => g.current)).toBe(false);
  expect((listed.body.grants as { id: string }[]).map(g => g.id)).toContain(pi.grantId);
  expect((await api(root, "GET", "/api/admin/grants?email=nobody@example.com")).status).toBe(404);
  expect((await api(root, "GET", "/api/admin/grants")).status).toBe(400);
  expect((await api(root, "POST", "/api/admin/grants/revoke", { email: B, id: pi.grantId })).status).toBe(404);
  expect((await api(root, "POST", "/api/admin/grants/revoke", { email: A, id: pi.grantId })).status).toBe(200);
  expect((await rotateOAuth(srv.app.repo, pi, pi.refreshToken)).status).not.toBe("ok");
  const cli = ((await api(root, "GET", `/api/admin/grants?email=${A}`)).body.grants as { id: string; kind: string }[]).find(g => g.kind === "cli")!;
  expect((await api(root, "POST", "/api/admin/grants/revoke", { email: A, id: cli.id })).status).toBe(200);
  expect((await api(alice, "GET", "/api/whoami")).status).toBe(401);
  expect(await audits("auth.grant_revoked")).toEqual([{ actor: ROOT, target: A, detail: { grant_id: pi.grantId, client_id: "grayboard-pi" } }]);
  expect((await audits("auth.session_revoked")).map(a => [a.actor, a.target])).toEqual([[ROOT, A]]);
});

test("a service credential's grant lists as credential and its revoke here is a 409 naming the credential revoke", async () => {
  const root = await login(ROOT);
  expect((await api(root, "POST", "/api/admin/services", { name: "ingest", owners: [ROOT] })).status).toBe(201);
  expect((await api(root, "POST", "/api/admin/services/credentials", { service: "ingest" })).status).toBe(201);
  const grants = (await api(root, "GET", "/api/admin/grants?email=ingest")).body.grants as { id: string; kind: string; client_id: string }[];
  expect(grants).toHaveLength(1);
  expect(grants[0]).toMatchObject({ kind: "credential", client_id: expect.stringMatching(/^svc_/) });
  const r = await api(root, "POST", "/api/admin/grants/revoke", { email: "ingest", id: grants[0]!.id });
  expect(r).toMatchObject({ status: 409, body: { message: expect.stringContaining("admin service credential revoke") } });
  expect((await api(root, "GET", "/api/admin/grants?email=ingest")).body.grants).toHaveLength(1);
});

const login = (email: string) => srv.login(email);

test("the CLI lists and revokes, its own and (--user) another user's", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-grants-cli-"));
  try {
    const creds = async (email: string) => {
      const path = join(dir, `${email}.credentials`);
      writeFileSync(path, JSON.stringify({ session_token: await login(email), server: srv.base, user_email: email }), { mode: 0o600 });
      return path;
    };
    const as: Record<string, string> = { [A]: await creds(A), [ROOT]: await creds(ROOT) };
    const cli = (email: string, ...args: string[]) => runCli(args, { cwd: dir, env: cleanEnv({ GRAYBOARD_CREDENTIALS: as[email]! }) });
    const pi = await issue(A, "grayboard-pi");
    const text = await cli(A, "grants", "list");
    expect(text.code, text.err).toBe(0);
    expect(text.out).toContain(`${pi.grantId}  grayboard-pi  created `);
    expect(text.out).toContain("(this CLI)");
    const listed = await cli(ROOT, "--json", "grants", "list", "--user", A);
    expect(listed.code, listed.err).toBe(0);
    expect(JSON.parse(listed.out).grants.map((g: { kind: string }) => g.kind).sort()).toEqual(["cli", "oauth"]);
    const own = await cli(A, "--json", "grants", "revoke", pi.grantId);
    expect(own.code, own.err).toBe(0);
    expect(JSON.parse(own.out)).toEqual({ ok: true, id: pi.grantId });
    const cliId = (JSON.parse(listed.out).grants as { id: string; kind: string }[]).find(g => g.kind === "cli")!.id;
    expect((await cli(ROOT, "grants", "revoke", cliId, "--user", A)).code).toBe(0);
    const after = await cli(A, "grants", "list");
    expect(after.code).toBe(1);
    const refused = await cli(ROOT, "grants", "revoke", "nope", "--user", A);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("no live grant nope");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// #1583: a grant issued before ids stopped starting with '-' revokes from the CLI as listed, bare or after `--`, its
// own and (--user) another user's; -h and -V prefixes would otherwise print help or the version and exit 0. A
// genuinely unknown flag is still refused.
test("the CLI revokes a grant whose id starts with '-', and still refuses an unknown flag", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-grants-dash-"));
  try {
    const creds = async (email: string) => {
      const path = join(dir, `${email}.credentials`);
      writeFileSync(path, JSON.stringify({ session_token: await login(email), server: srv.base, user_email: email }), { mode: 0o600 });
      return path;
    };
    const as: Record<string, string> = { [A]: await creds(A), [ROOT]: await creds(ROOT) };
    const cli = (email: string, ...args: string[]) => runCli(args, { cwd: dir, env: cleanEnv({ GRAYBOARD_CREDENTIALS: as[email]! }) });
    const root = await login(ROOT);
    const dashId = (prefix: string) => (prefix + "x".repeat(43)).slice(0, 43);
    const live = async () => ((await api(root, "GET", `/api/admin/grants?email=${encodeURIComponent(A)}`)).body.grants as { id: string }[]).map(g => g.id);
    // [id, global options, arguments before the id, arguments after it]
    const cases: [string, string[], string[], string[]][] = [
      [dashId("-nPDrs"), [], [], []], [dashId("-h"), [], [], []], [dashId("-V"), ["--json"], [], []], [dashId("--"), [], [], []],
      [dashId("-k"), [], ["--"], []], [dashId("-u"), [], ["--user", A, "--"], []], [dashId("-q"), [], [], ["--user", A]],
    ];
    for (const [id, global, before, after] of cases) {
      await issue(A, "grayboard-pi", id);
      expect(await live()).toContain(id);
      const r = await cli([...before, ...after].includes("--user") ? ROOT : A, ...global, "grants", "revoke", ...before, id, ...after);
      expect(r.code, `${id}: ${r.out} ${r.err}`).toBe(0);
      if (global.includes("--json")) expect(JSON.parse(r.out)).toEqual({ ok: true, id });
      expect(await live()).not.toContain(id);
    }

    const unknown = await cli(A, "grants", "revoke", "--bogus");
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("unknown option '--bogus'");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// #1552: a live AS browser session consents without the IdP, so a revoke that left it would let the lost device
// mint a replacement grant. A per-grant revoke ends the user's browser sessions: the next authorize goes upstream.
test("after a per-grant revoke, the same browser's next authorize goes to the IdP, not straight to consent", async () => {
  const hs = await hostedServer({}, A);
  try {
    const browser = new Browser();
    const authorize = () => {
      const verifier = randomBytes(32).toString("base64url");
      const redirectUri = "http://127.0.0.1:49152/callback";
      const url = `${hs.issuer}/oauth/authorize?` + new URLSearchParams({ response_type: "code", client_id: "grayboard-pi", redirect_uri: redirectUri,
        scope: "grayboard:delivery grayboard:tools", state: randomBytes(16).toString("base64url"),
        code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
      return { url, verifier, redirectUri };
    };
    // Signed in upstream once, consented, the code redeemed: one grant.
    const first = authorize();
    const callback = await upstreamLeg(browser, hs.issuer, await browser.request(first.url));
    expect(callback.status).toBe(303);
    const page = await (await browser.request(callback.headers.get("Location")!)).text();
    const decided = await submitConsent(browser, `${hs.issuer}/oauth/consent`, consentForm(page));
    const code = new URL(decided.headers.get("Location")!).searchParams.get("code")!;
    const redeemed = await fetch(`${hs.issuer}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: "grayboard-pi", code, redirect_uri: first.redirectUri, code_verifier: first.verifier }) });
    expect(redeemed.status).toBe(200);
    const next = async () => new URL((await browser.request(authorize().url)).headers.get("Location")!);
    // The browser session alone reaches consent.
    expect((await next()).pathname).toBe("/oauth/consent");

    const token = await hs.login(A);
    const [grant] = ((await hs.api(token, "GET", "/api/grants")).body.grants as { id: string; kind: string }[]).filter(g => g.kind === "oauth");
    expect((await hs.api(token, "POST", "/api/grants/revoke", { id: grant!.id })).status).toBe(200);
    expect((await next()).host).toBe("accounts.google.com");
  } finally {
    await hs.stop();
  }
});
