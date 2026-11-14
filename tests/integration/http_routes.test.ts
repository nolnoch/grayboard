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

test("teams are invite-only: owners add and remove; outsiders can't join, add, or see the roster", async () => {
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
  expect((await api(alice, "POST", "/api/teams/eng/add", { email: "bob@example.com", role: "admin" })).status).toBe(400);

  // The creator owns the team and adds; members read the roster with roles.
  expect((await api(alice, "POST", "/api/teams/eng/add", { email: "Bob@Example.com" })).status).toBe(200);
  expect((await api(alice, "POST", "/api/teams/eng/add", { email: "carol@example.com" })).status).toBe(200);
  const members = await api(carol, "GET", "/api/teams/eng/members");
  expect(members.body.map((m: { email: string; role: string }) => [m.email, m.role]).sort()).toEqual([
    ["alice@example.com", "owner"], ["bob@example.com", "member"], ["carol@example.com", "member"],
  ]);
  expect((await api(alice, "POST", "/api/teams/eng/remove", { email: "bob@example.com" })).status).toBe(200);
  expect((await api(alice, "POST", "/api/teams/eng/remove", { email: "bob@example.com" })).status).toBe(404);
  expect((await api(bob, "GET", "/api/whoami")).body.teams).toEqual([]);

  const audit = srv.app.db
    .query("SELECT actor, action, detail FROM access_log WHERE action = 'team.member_removed'")
    .all();
  expect(audit).toEqual([{ actor: "alice@example.com", action: "team.member_removed", detail: '{"member":"bob@example.com"}' }]);
});

// Security audit F-02 (POC2): membership was flat, so any member could add
// anyone or remove anyone, the creator included, then bind the team names
// the removed member lost.
test("a member who isn't an owner can't add, remove or change roles; the creator stays", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  await login("carol@example.com");
  await api(alice, "POST", "/api/teams", { name: "eng" });
  await api(alice, "POST", "/api/teams/eng/add", { email: "bob@example.com" });

  const rm = await api(bob, "POST", "/api/teams/eng/remove", { email: "alice@example.com" });
  expect(rm).toMatchObject({ status: 403, body: { code: "forbidden", message: expect.stringContaining("only an owner of team \"eng\"") } });
  expect((await api(bob, "POST", "/api/teams/eng/add", { email: "carol@example.com" })).status).toBe(403);
  expect((await api(bob, "POST", "/api/teams/eng/add", { email: "bob@example.com", role: "owner" })).status).toBe(403);
  const members = await api(bob, "GET", "/api/teams/eng/members");
  expect(members.body.map((m: { email: string }) => m.email).sort()).toEqual(["alice@example.com", "bob@example.com"]);
  // A member may still leave.
  expect((await api(bob, "POST", "/api/teams/eng/leave")).status).toBe(200);
});

// Security audit F-02 (TOCTOU): the ownership check runs after the body is
// read, so an owner demoted while their request body is still arriving
// can't finish the add on the stale check.
test("an owner demoted while their add's body streams in is refused", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  await login("carol@example.com");
  await api(alice, "POST", "/api/teams", { name: "eng" });
  await api(alice, "POST", "/api/teams/eng/add", { email: "bob@example.com", role: "owner" });

  const body = JSON.stringify({ email: "carol@example.com" });
  let push!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start: (c) => { push = c; } });
  const pending = fetch(`${srv.base}/api/teams/eng/add`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bob}`, "Content-Type": "application/json" },
    body: stream,
  });
  push.enqueue(new TextEncoder().encode(body.slice(0, 5)));
  expect((await api(alice, "POST", "/api/teams/eng/add", { email: "bob@example.com", role: "member" })).status).toBe(200);
  push.enqueue(new TextEncoder().encode(body.slice(5)));
  push.close();
  expect((await pending).status).toBe(403);
  const members = (await api(alice, "GET", "/api/teams/eng/members")).body.map((m: { email: string }) => m.email).sort();
  expect(members).toEqual(["alice@example.com", "bob@example.com"]);
});

test("owners promote and demote; the last owner can't leave, be removed or demoted while others remain", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  await api(alice, "POST", "/api/teams", { name: "eng" });
  await api(alice, "POST", "/api/teams/eng/add", { email: "bob@example.com" });

  const leave = await api(alice, "POST", "/api/teams/eng/leave");
  expect(leave).toMatchObject({ status: 409, body: { message: expect.stringContaining("--role owner") } });
  expect((await api(alice, "POST", "/api/teams/eng/remove", { email: "alice@example.com" })).status).toBe(409);
  expect((await api(alice, "POST", "/api/teams/eng/add", { email: "alice@example.com", role: "member" })).status).toBe(409);

  // Re-adding an existing member without a role changes nothing.
  expect((await api(alice, "POST", "/api/teams/eng/add", { email: "bob@example.com" })).status).toBe(200);
  expect((await api(bob, "POST", "/api/teams/eng/add", { email: "bob@example.com", role: "owner" })).status).toBe(403);
  // Promoted, bob owns too, and the creator stays an owner.
  expect((await api(alice, "POST", "/api/teams/eng/add", { email: "bob@example.com", role: "owner" })).status).toBe(200);
  const roles = async () => (await api(alice, "GET", "/api/teams/eng/members")).body.map((m: { email: string; role: string }) => [m.email, m.role]).sort();
  expect(await roles()).toEqual([["alice@example.com", "owner"], ["bob@example.com", "owner"]]);
  // Bob demotes alice, then alice can't manage.
  expect((await api(bob, "POST", "/api/teams/eng/add", { email: "alice@example.com", role: "member" })).status).toBe(200);
  expect(await roles()).toEqual([["alice@example.com", "member"], ["bob@example.com", "owner"]]);
  expect((await api(alice, "POST", "/api/teams/eng/remove", { email: "bob@example.com" })).status).toBe(403);
  expect((await api(bob, "POST", "/api/teams/eng/remove", { email: "alice@example.com" })).status).toBe(200);
  // A sole owner who is the sole member may leave.
  expect((await api(bob, "POST", "/api/teams/eng/leave")).status).toBe(200);

  const changes = srv.app.db.query("SELECT actor, detail FROM access_log WHERE action = 'team.role_changed' ORDER BY rowid").all();
  expect(changes).toEqual([
    { actor: "alice@example.com", detail: '{"member":"bob@example.com","role":"owner","from":"member"}' },
    { actor: "bob@example.com", detail: '{"member":"alice@example.com","role":"member","from":"owner"}' },
  ]);
});

// Rows written before roles existed carry no role: the creator reads as the
// owner and keeps it when another is promoted; anyone else is a member, and
// a team whose creator already left is the admins' to manage.
test("a team from before roles: its creator owns it, per row", async () => {
  await restart({ admins: ["root@example.com"] });
  const root = await login("root@example.com");
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const carol = await login("carol@example.com");
  for (const name of ["eng", "ops"]) {
    await api(alice, "POST", "/api/teams", { name });
    await api(alice, "POST", `/api/teams/${name}/add`, { email: "bob@example.com" });
  }
  srv.app.db.run("UPDATE team_members SET role = NULL");

  expect((await api(bob, "POST", "/api/teams/eng/add", { email: "carol@example.com" })).status).toBe(403);
  expect((await api(alice, "POST", "/api/teams/eng/add", { email: "bob@example.com", role: "owner" })).status).toBe(200);
  const roles = (await api(alice, "GET", "/api/teams/eng/members")).body.map((m: { email: string; role: string }) => [m.email, m.role]).sort();
  expect(roles).toEqual([["alice@example.com", "owner"], ["bob@example.com", "owner"]]);

  // ops: the creator left before roles; nobody owns it, so bob can't manage
  // it, and leaving isn't guarded; an admin can.
  srv.app.db.run("DELETE FROM team_members WHERE team_id = (SELECT id FROM teams WHERE name = 'ops') AND user_id = (SELECT id FROM users WHERE email = 'alice@example.com')");
  expect((await api(bob, "POST", "/api/teams/ops/add", { email: "carol@example.com" })).status).toBe(403);
  expect((await api(root, "POST", "/api/teams/ops/add", { email: "carol@example.com", role: "owner" })).status).toBe(200);
  expect((await api(carol, "POST", "/api/teams/ops/remove", { email: "bob@example.com" })).status).toBe(200);
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
    { actor: "root@example.com", action: "team.member_added", detail: '{"member":"bob@example.com","role":"member","as_admin":true}' },
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
