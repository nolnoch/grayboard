// The server's HTTP routes with an in-memory server and dev auth: teams,
// admin, login, /healthz and the binary's --version. Moved from ws.test.ts
// (#282); none of these opens a session.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import type { Config } from "../../src/server/config.ts";
import { ROOT } from "../support/paths.ts";
import { TestServer } from "../support/server.ts";

const SERVER = join(ROOT, "src/server/main.ts");

let srv: TestServer;

// A test that needs other config replaces the server.
const restart = async (overrides: Partial<Config> = {}) => {
  await srv.stop();
  srv = new TestServer(overrides);
};

beforeEach(() => {
  srv = new TestServer();
});

afterEach(() => srv.stop());

const login = (email: string) => srv.login(email);
const api = (token: string, method: string, path: string, body?: unknown) => srv.api(token, method, path, body);

// #284 decision 5 (audit W8): a team can't take another principal's name.
test("team create on another principal's name is a 409, and no team or board is made", async () => {
  const alice = await login("alice@example.com");
  srv.app.db.prepare(`INSERT INTO principals (kind, name, created_at) VALUES ('service', 'ingest', 0)`).run();
  const r = await api(alice, "POST", "/api/teams", { name: "ingest" });
  expect(r.status).toBe(409);
  expect(JSON.stringify(r.body)).toContain("ingest");
  expect(srv.app.db.query(`SELECT COUNT(*) AS n FROM teams WHERE name = 'ingest'`).get()).toEqual({ n: 0 });
  expect(srv.app.db.query(`SELECT COUNT(*) AS n FROM boards WHERE name = 'ingest'`).get()).toEqual({ n: 0 });
});

test("teams are invite-only: members add and remove; outsiders can't join, add, or see the roster", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const carol = await login("carol@example.com");
  await api(alice, "POST", "/api/teams", { name: "eng" });

  const join = await api(bob, "POST", "/api/teams/eng/join");
  expect(join).toMatchObject({ status: 403, body: { code: "forbidden", message: expect.stringContaining("team add") } });
  // A non-member gets the same answer whether or not the team exists.
  for (const team of ["eng", "nope"]) {
    expect((await api(bob, "POST", `/api/teams/${team}/add`, { email: "bob@example.com" })).status).toBe(404);
    expect((await api(bob, "GET", `/api/teams/${team}/members`)).status).toBe(404);
    expect((await api(bob, "POST", `/api/teams/${team}/remove`, { email: "alice@example.com" })).status).toBe(404);
  }

  const never = await api(alice, "POST", "/api/teams/eng/add", { email: "dave@example.com" });
  expect(never).toMatchObject({ status: 404, body: { message: expect.stringContaining("never signed in") } });

  // Any member can add; the added member can add others and remove.
  expect((await api(alice, "POST", "/api/teams/eng/add", { email: "Bob@Example.com" })).status).toBe(200);
  expect((await api(bob, "POST", "/api/teams/eng/add", { email: "carol@example.com" })).status).toBe(200);
  const members = await api(carol, "GET", "/api/teams/eng/members");
  expect(members.body.map((m: { email: string }) => m.email).sort()).toEqual([
    "alice@example.com", "bob@example.com", "carol@example.com",
  ]);
  expect((await api(carol, "POST", "/api/teams/eng/remove", { email: "bob@example.com" })).status).toBe(200);
  expect((await api(carol, "POST", "/api/teams/eng/remove", { email: "bob@example.com" })).status).toBe(404);
  expect((await api(bob, "GET", "/api/whoami")).body.teams).toEqual([]);

  const audit = srv.app.db
    .query("SELECT actor, action, detail FROM access_log WHERE action = 'team.member_removed'")
    .all();
  expect(audit).toEqual([{ actor: "carol@example.com", action: "team.member_removed", detail: '{"member":"bob@example.com"}' }]);
});

test("admin routes: refused for non-admins and when no admins are configured", async () => {
  const alice = await login("alice@example.com");
  await login("bob@example.com");
  const none = await api(alice, "POST", "/api/admin/disable-user", { email: "bob@example.com" });
  expect(none).toMatchObject({ status: 403, body: { code: "forbidden", message: expect.stringContaining("GRAYBOARD_ADMINS") } });

  await restart({ admins: ["alice@example.com"] });
  const admin = await login("alice@example.com");
  const bob = await login("bob@example.com");
  for (const path of ["/api/admin/disable-user", "/api/admin/enable-user", "/api/admin/revoke-session"]) {
    expect((await api(bob, "POST", path, { email: "alice@example.com" })).status).toBe(403);
  }
  expect((await api(admin, "POST", "/api/admin/disable-user", { email: "bob@example.com" })).status).toBe(200);
  expect((await api(bob, "GET", "/api/whoami")).status).toBe(401);
});

// Security audit F-14: the server's GRAYBOARD_CLI_TOKEN_IDLE_DAYS reaches the token check.
test("a CLI token idle past cliTokenIdleDays is refused; a fresh sign-in works", async () => {
  await restart({ cliTokenIdleDays: 1 });
  const bob = await login("bob@example.com");
  expect((await api(bob, "GET", "/api/whoami")).status).toBe(200);
  srv.app.db.run(`UPDATE sessions SET last_used_at = ?`, [Date.now() - 2 * 86_400_000]);
  expect((await api(bob, "GET", "/api/whoami")).status).toBe(401);
  expect((await api(await login("bob@example.com"), "GET", "/api/whoami")).status).toBe(200);
});

// Security audit F-14: disable revokes the user's CLI tokens, so enable
// doesn't revive them, and a disabled user can't sign in for a new one.
test("disable-user revokes CLI tokens for good; a disabled user gets no new token", async () => {
  await restart({ admins: ["root@example.com"] });
  const root = await login("root@example.com");
  const bob = await login("bob@example.com");
  expect((await api(root, "POST", "/api/admin/disable-user", { email: "bob@example.com" })).status).toBe(200);
  const live = () => srv.app.db.query(
    `SELECT COUNT(*) AS n FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = 'bob@example.com' AND s.revoked_at IS NULL`).get();
  expect(live()).toEqual({ n: 0 });

  const refused = await fetch(`${srv.base}/api/auth/dev-login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "bob@example.com" }),
  });
  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({ code: "forbidden", message: expect.stringContaining("disabled") });
  expect(live()).toEqual({ n: 0 });
  expect(srv.app.db.query(`SELECT actor, json_extract(detail, '$.dev') AS dev FROM access_log WHERE action = 'auth.user_refused'`).all())
    .toEqual([{ actor: "bob@example.com", dev: 1 }]);

  expect((await api(root, "POST", "/api/admin/enable-user", { email: "bob@example.com" })).status).toBe(200);
  expect((await api(bob, "GET", "/api/whoami")).status).toBe(401);
  const again = await login("bob@example.com");
  expect((await api(again, "GET", "/api/whoami")).status).toBe(200);
});

test("admin revoke-session signs a user out of every session, ignoring an old CLI's all", async () => {
  await restart({ admins: ["root@example.com"] });
  const root = await login("root@example.com");
  for (const all of [false, true, undefined]) {
    const laptop = await login("bob@example.com");
    const desktop = await login("bob@example.com");
    expect((await api(root, "POST", "/api/admin/revoke-session", { email: "bob@example.com", ...(all !== undefined ? { all } : {}) })).status).toBe(200);
    expect((await api(laptop, "GET", "/api/whoami")).status).toBe(401);
    expect((await api(desktop, "GET", "/api/whoami")).status).toBe(401);
  }
});

test("an admin can manage a team they're not in, e.g. after its last member left", async () => {
  await restart({ admins: ["root@example.com"] });
  const root = await login("root@example.com");
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  await api(alice, "POST", "/api/teams", { name: "eng" });
  await api(alice, "POST", "/api/teams/eng/leave");
  expect((await api(bob, "POST", "/api/teams/eng/add", { email: "bob@example.com" })).status).toBe(404);

  expect((await api(root, "GET", "/api/teams/eng/members")).body).toEqual([]);
  expect((await api(root, "POST", "/api/teams/eng/add", { email: "bob@example.com" })).status).toBe(200);
  expect((await api(root, "GET", "/api/teams/nope/members")).status).toBe(404);
  expect((await api(bob, "GET", "/api/whoami")).body.teams).toEqual(["eng"]);
  // Managing doesn't make the admin a member.
  expect((await api(root, "GET", "/api/whoami")).body.teams).toEqual([]);
  expect((await api(root, "POST", "/api/teams/eng/remove", { email: "bob@example.com" })).status).toBe(200);

  const audit = srv.app.db
    .query("SELECT actor, action, detail FROM access_log WHERE action LIKE 'team.member_%' AND actor = 'root@example.com'")
    .all();
  expect(audit).toEqual([
    { actor: "root@example.com", action: "team.member_added", detail: '{"member":"bob@example.com","as_admin":true}' },
    { actor: "root@example.com", action: "team.member_removed", detail: '{"member":"bob@example.com","as_admin":true}' },
  ]);
});

test("login refuses an email no direct address can carry", async () => {
  const r = await fetch(`${srv.base}/api/auth/dev-login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "o'brien@example.com" }) });
  expect(r.status).toBe(400);
});

test("the server reports its version: /healthz and --version", async () => {
  const r = await fetch(`${srv.base}/healthz`);
  expect(await r.json()).toEqual({ ok: true, version: pkg.version });
  // --version answers before the config is loaded, so it needs no server env.
  const p = Bun.spawnSync([process.execPath, SERVER, "--version"], { env: { PATH: process.env.PATH ?? "" } });
  expect(p.exitCode).toBe(0);
  expect(p.stdout.toString().trim()).toBe(pkg.version);
});
