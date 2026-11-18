// Service principals, step 2 (#270 D1, D8 step 2): the service rows, their owners, the admin routes and CLI, and the
// sites that hardcoded "a user is a person". A service session here gets its token from the test-only issuance
// (tests/helpers/oauth.ts); the credential grant that issues one for real is a later step.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessAudits } from "../support/audit.ts";
import { runCli } from "../support/cli.ts";
import { cleanEnv } from "../support/env.ts";
import { hostedPause } from "../support/hosted-pause.ts";
import { hostedRowCount } from "../support/hosted_rows.ts";
import { HostedToolError } from "../support/hosted_session.ts";
import { ROOT as REPO_ROOT } from "../support/paths.ts";
import { seed } from "../support/seed.ts";
import { ServerProcess, TestServer } from "../support/server.ts";

const A = "alice@example.com", B = "bob@example.com", ROOT = "root@example.com", SVC = "ingest";

let srv: TestServer;
beforeEach(() => { srv = new TestServer({ admins: [ROOT], hostedRequestLimit: { burst: 10_000, perSec: 10_000 } }); });
afterEach(() => srv.stop());

const api = (token: string, method: string, path: string, body?: unknown) => srv.api(token, method, path, body);
const create = (token: string, name: string, owners: unknown) => api(token, "POST", "/api/admin/services", { name, owners });
const serviceRows = () => srv.app.db.query("SELECT p.name, p.kind, u.email FROM principals p LEFT JOIN users u ON u.id = p.user_id WHERE p.kind = 'service' ORDER BY p.id").all();
const ownerRows = () => srv.app.db.query("SELECT h.name AS holder, s.name AS service FROM role_bindings b JOIN principals h ON h.id = b.principal_id JOIN principals s ON s.id = b.scope_id WHERE b.role = 'service_owner' ORDER BY b.id").all();
const refusedText = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { if (e instanceof HostedToolError) return e.message; throw e; }
  throw new Error("the call wasn't refused");
};

// A service, created by the bootstrap admin with alice as its owner.
async function service(name = SVC, owners = [A]) {
  const root = await srv.login(ROOT);
  for (const o of owners) await srv.login(o);
  const r = await create(root, name, owners);
  expect(r.status).toBe(201);
  return root;
}

describe("create, list, disable, enable: audited (acceptance 1)", () => {
  test("create writes both rows and the owner bindings, audited with the admin and the service", async () => {
    const root = await srv.login(ROOT);
    await srv.login(A); await srv.login(B);
    const r = await create(root, "Ingest", [B, A, A]);
    expect(r).toMatchObject({ status: 201, body: { name: SVC, owners: [A, B] } });
    expect(serviceRows()).toEqual([{ name: SVC, kind: "service", email: SVC }]);
    expect(ownerRows()).toEqual([{ holder: B, service: SVC }, { holder: A, service: SVC }]);
    expect(accessAudits(srv.app.db, "service.created")).toEqual([expect.objectContaining({ actor: ROOT, target: SVC, detail: { owners: [B, A] } })]);
    expect(accessAudits(srv.app.db, "role.granted").map(r => [r.actor, r.target, r.detail.role])).toEqual([[ROOT, B, "service_owner"], [ROOT, A, "service_owner"]]);
    const l = await api(root, "GET", "/api/admin/services");
    expect(l).toMatchObject({ status: 200, body: { services: [{ name: SVC, disabled_at: null, owners: [A, B] }], next: null } });
  });

  test("create is refused with no owner, a team's or a user's name, an email-shaped name, a taken name, or an owner who never signed in", async () => {
    const root = await srv.login(ROOT);
    const alice = await srv.login(A);
    expect((await api(alice, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
    expect(await create(root, SVC, [])).toMatchObject({ status: 400, body: { message: expect.stringContaining("owners required") } });
    expect(await create(root, SVC, undefined)).toMatchObject({ status: 400 });
    expect(await create(root, SVC, [7])).toMatchObject({ status: 400 });
    expect(await create(root, "eng", [A])).toMatchObject({ status: 409, body: { message: expect.stringContaining("belongs to another") } });
    expect(await create(root, A, [A])).toMatchObject({ status: 400, body: { message: expect.stringContaining("invalid service name") } });
    expect(await create(root, "ingest@example.com", [A])).toMatchObject({ status: 400 });
    expect(await create(root, SVC, ["never@example.com"])).toMatchObject({ status: 404 });
    // The refused owner grant rolled the service's rows back with it.
    expect(serviceRows()).toEqual([]);
    expect((await create(root, SVC, [A])).status).toBe(201);
    expect(await create(root, SVC, [A])).toMatchObject({ status: 409 });
    // Another service's name can't be an owner: service_owner's holders are users.
    expect(await create(root, "other", [SVC])).toMatchObject({ status: 400 });
    expect(serviceRows()).toEqual([{ name: SVC, kind: "service", email: SVC }]);
    expect(accessAudits(srv.app.db, "service.created")).toHaveLength(1);
  });

  test("the routes are org_admin's: an owner or another user is refused, with a deny row", async () => {
    await service();
    const alice = await srv.login(A);
    expect((await create(alice, "other", [A])).status).toBe(403);
    expect((await api(alice, "GET", "/api/admin/services")).status).toBe(403);
    expect((await api(alice, "POST", "/api/admin/services/disable", { name: SVC })).status).toBe(403);
    expect(accessAudits(srv.app.db, "authz.decision").filter(r => r.actor === A).map(r => [r.detail.allow, r.detail.route])).toEqual([
      [false, "/api/admin/services"], [false, "/api/admin/services"], [false, "/api/admin/services/disable"],
    ]);
  });

  test("an org admin revoked between the gate and the write creates nothing", async () => {
    const root = await srv.login(ROOT), alice = await srv.login(A);
    expect((await api(root, "POST", "/api/admin/roles/grant", { role: "org_admin", principal: A })).status).toBe(201);
    const res = await hostedPause("http:admin-service-create:before-write",
      () => create(alice, SVC, [A]),
      async () => { expect((await api(root, "POST", "/api/admin/roles/revoke", { role: "org_admin", principal: A })).status).toBe(200); });
    expect(res).toMatchObject({ status: 403, body: { message: expect.stringContaining("no longer holds") } });
    expect(serviceRows()).toEqual([]);
    expect(ownerRows()).toEqual([]);
    expect(accessAudits(srv.app.db, "service.created")).toEqual([]);
  });

  test("list pages by id", async () => {
    const root = await service("s1");
    for (const n of ["s2", "s3"]) expect((await create(root, n, [A])).status).toBe(201);
    const p1 = await api(root, "GET", "/api/admin/services?limit=2");
    expect(p1.body.services.map((s: { name: string }) => s.name)).toEqual(["s1", "s2"]);
    const p2 = await api(root, "GET", `/api/admin/services?limit=2&after=${p1.body.next}`);
    expect(p2.body).toMatchObject({ services: [{ name: "s3" }], next: null });
    expect((await api(root, "GET", "/api/admin/services?after=x")).status).toBe(400);
  });

  test("disable ends the service's sessions in its transaction and is audited; enable revives none of them", async () => {
    const root = await service();
    const s = await srv.hosted(SVC, "w-1");
    expect(hostedRowCount(srv.app.db)).toBe(1);
    expect(await api(root, "POST", "/api/admin/services/disable", { name: SVC })).toMatchObject({ status: 200 });
    expect(hostedRowCount(srv.app.db)).toBe(0);
    await expect(s.call("whoami")).rejects.toThrow();
    // Its grant is gone: the client has nothing left to release.
    await s.drop();
    expect(await api(root, "POST", "/api/admin/services/enable", { name: SVC })).toMatchObject({ status: 200 });
    expect(hostedRowCount(srv.app.db)).toBe(0);
    expect(accessAudits(srv.app.db, "auth.user_disabled")).toEqual([expect.objectContaining({ actor: ROOT, target: SVC, detail: { service: true } })]);
    expect(accessAudits(srv.app.db, "auth.user_enabled")).toEqual([expect.objectContaining({ actor: ROOT, target: SVC, detail: { service: true } })]);
    const l = await api(root, "GET", "/api/admin/services");
    expect(l.body.services[0].disabled_at).toBeNull();
    // A user's email or a team's name is no service to these routes.
    expect(await api(root, "POST", "/api/admin/services/disable", { name: A })).toMatchObject({ status: 404 });
  });

  test("delete-alias deletes a service's unheld name and refuses a held one", async () => {
    const root = await service();
    const s = await srv.hosted(SVC, "w-1");
    await s.bind("w-2");
    const del = (name: string) => api(root, "POST", "/api/admin/services/delete-alias", { service: SVC, name });
    expect(await del("w-2")).toMatchObject({ status: 409 });
    await s.call("unbind", { name: "w-2" });
    expect(await del("w-2")).toMatchObject({ status: 200, body: { deleted: `${SVC}/w-2` } });
    expect(await del("w-2")).toMatchObject({ status: 404 });
    expect(await del("human")).toMatchObject({ status: 400 });
    expect(await api(root, "POST", "/api/admin/services/delete-alias", { service: A, name: "x" })).toMatchObject({ status: 404 });
    expect(accessAudits(srv.app.db, "alias.deleted")).toEqual([expect.objectContaining({ actor: ROOT, target: `${SVC}/w-2`, detail: { service: SVC } })]);
  });
});

describe("owners", () => {
  test("the store refuses to revoke a service's last owner", async () => {
    const root = await service(SVC, [A, B]);
    const revoke = (p: string) => api(root, "POST", "/api/admin/roles/revoke", { role: "service_owner", principal: p, scope: SVC });
    expect((await revoke(A)).status).toBe(200);
    expect(await revoke(B)).toMatchObject({ status: 409, body: { message: expect.stringContaining(`service "${SVC}" must keep an owner`) } });
    expect(ownerRows()).toEqual([{ holder: B, service: SVC }]);
    expect(await api(root, "POST", "/api/admin/roles/grant", { role: "service_owner", principal: A, scope: SVC })).toMatchObject({ status: 201 });
    expect((await revoke(B)).status).toBe(200);
  });

  test("service_owner's scope is a service and its holder a user; a service holds no role", async () => {
    const root = await service();
    const alice = await srv.login(A);
    expect((await api(alice, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
    const grant = (role: string, principal: string, scope?: string) => api(root, "POST", "/api/admin/roles/grant", { role, principal, ...(scope ? { scope } : {}) });
    expect(await grant("service_owner", A, "eng")).toMatchObject({ status: 404, body: { message: 'no service named "eng"' } });
    expect((await grant("service_owner", A)).status).toBe(400);
    expect((await grant("org_admin", SVC)).status).toBe(400);
    expect((await grant("team_owner", SVC, "eng")).status).toBe(400);
    // service_invoke's holders arrive with the invocation step.
    expect((await grant("service_invoke", A, SVC)).status).toBe(400);
    expect(ownerRows()).toEqual([{ holder: A, service: SVC }]);
  });

  test("disable-user names the services it leaves with no enabled owner", async () => {
    const root = await service(SVC, [A, B]);
    expect((await create(root, "solo", [A])).status).toBe(201);
    const d = await api(root, "POST", "/api/admin/disable-user", { email: A });
    expect(d).toMatchObject({ status: 200, body: { ok: true, orphaned_services: ["solo"] } });
    expect(accessAudits(srv.app.db, "auth.user_disabled").at(-1)).toMatchObject({ target: A, detail: { orphaned_services: ["solo"] } });
    const e = await api(root, "POST", "/api/admin/disable-user", { email: B });
    expect(e.body.orphaned_services).toEqual([SVC]);
    // The bindings stay: the owner record outlives the disable.
    expect(ownerRows()).toHaveLength(3);
  });
});

describe("a service is not a user", () => {
  test("the generic admin user routes and team add refuse a service", async () => {
    const root = await service();
    const alice = await srv.login(A);
    for (const route of ["revoke-session", "disable-user", "enable-user", "unlink-idp"]) {
      expect(await api(root, "POST", `/api/admin/${route}`, { email: SVC }), route).toMatchObject({ status: 400, body: { message: expect.stringContaining("is a service") } });
    }
    expect(accessAudits(srv.app.db, "auth.user_disabled")).toEqual([]);
    expect(accessAudits(srv.app.db, "auth.session_revoked")).toEqual([]);
    expect((await api(alice, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
    expect(await api(alice, "POST", "/api/teams/eng/add", { email: SVC })).toMatchObject({ status: 400, body: { message: expect.stringContaining("services don't join teams") } });
    expect(srv.app.db.query("SELECT count(*) AS n FROM team_members").get()).toEqual({ n: 1 });
  });

  test("no sign-in reaches a service row: upsertByEmail and the IdP sign-in refuse it", async () => {
    await service();
    const repo = srv.app.repo;
    await expect(seed(repo, tx => repo.users.upsertByEmail(tx, SVC, null))).rejects.toThrow();
    const r = await seed(repo, tx => repo.users.signIn(tx, "https://accounts.google.com", "sub-1", SVC, null));
    expect(r.status).toBe("service");
    expect(srv.app.db.query("SELECT idp_issuer, idp_subject FROM users WHERE email = ?").get(SVC)).toEqual({ idp_issuer: null, idp_subject: null });
    // The dev sign-in takes an email only, and a service's name is none.
    expect((await fetch(`${srv.base}/api/auth/dev-login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: SVC }) })).status).toBe(400);
  });
});

describe("a service session (D4)", () => {
  test("binds a bare name in its own scope and nowhere else; keeps it across a revalidate", async () => {
    const root = await service();
    const alice = await srv.login(A);
    expect((await api(alice, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
    expect((await create(root, "other", [A])).status).toBe(201);
    const s = await srv.hosted(SVC, null);
    expect(await s.bind("w-1")).toMatchObject({ name: "w-1" });
    expect(await s.call("whoami")).toMatchObject({ principal: SVC, primary: `${SVC}/w-1` });
    expect(srv.app.db.query("SELECT scope_kind, scope_ref, name FROM aliases WHERE scope_ref = ?").all(SVC)).toEqual([{ scope_kind: "service", scope_ref: SVC, name: "w-1" }]);
    for (const name of [`${A}/x`, "eng/x", "other/x"]) {
      expect(await refusedText(s.call("bind", { name, create: true })), name).toContain(`${SVC} is a service; it acts only in its own scope; bind a bare name`);
    }
    expect(await refusedText(s.call("bind", { name: "human", create: true }))).toContain("reserved");
    await srv.app.revalidate();
    expect(await s.call("whoami")).toMatchObject({ primary: `${SVC}/w-1` });
    // It posts as the name.
    await s.call("board_create", { name: "svc-out", purpose: "a service's board" });
    await s.call("board_post", { board: "svc-out", body: "from the service" });
    expect(srv.app.db.query("SELECT author FROM posts WHERE body = 'from the service'").get()).toEqual({ author: `${SVC}/w-1` });
  });

  test("a user, its owner included, can't bind in a service's scope: it reads as a missing service", async () => {
    await service();
    const owner = await srv.hosted(A, null);
    const there = await refusedText(owner.call("bind", { name: `${SVC}/x`, create: true }));
    const missing = await refusedText(owner.call("bind", { name: "nosvc/x", create: true }));
    expect(there).toBe(missing.replaceAll("nosvc", SVC));
    expect(srv.app.db.query("SELECT count(*) AS n FROM aliases WHERE scope_kind = 'service'").get()).toEqual({ n: 0 });
  });

  test("a service's hello carries no human handle; its unbound candidates are its own scope's names", async () => {
    await service();
    const build = spyOn(srv.app.application, "hostedBuild");
    try {
      const first = await srv.hosted(SVC, "w-1");
      await first.close();
      await srv.hosted(SVC, null);
      await srv.hosted(A, null);
      // Each build's info by its principal's kind, the latest last.
      const infos = (kind: string) => build.mock.calls.flatMap((c, i) => (c[0] as { kind: string }).kind === kind ? [(build.mock.results[i]!.value as { info: Record<string, unknown> }).info] : []);
      const svc = infos("service"), user = infos("user");
      expect(svc.length).toBeGreaterThan(0);
      for (const info of svc) expect(info).not.toHaveProperty("human");
      expect(svc.at(-1)!.candidates).toEqual([expect.objectContaining({ name: "w-1" })]);
      expect(user.at(-1)).toHaveProperty("human");
    } finally { build.mockRestore(); }
  });
});

test("the CLI creates, lists, disables and enables a service against a server process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-services-cli-"));
  const server = await ServerProcess.start([process.execPath, join(REPO_ROOT, "src/server/main.ts")], join(dir, "bus.db"), { GRAYBOARD_ADMINS: ROOT });
  try {
    const root = await server.login(ROOT);
    await server.login(A);
    const creds = join(dir, "root.credentials");
    writeFileSync(creds, JSON.stringify({ session_token: root, server: server.base, user_email: ROOT }), { mode: 0o600 });
    const cli = (...args: string[]) => runCli(["--json", "admin", "service", ...args], { cwd: dir, env: cleanEnv({ GRAYBOARD_CREDENTIALS: creds }) });
    const c = await cli("create", SVC, "--owner", A);
    expect(c.code, c.err).toBe(0);
    expect(JSON.parse(c.out)).toMatchObject({ name: SVC, owners: [A] });
    const l = await cli("list");
    expect(l.code, l.err).toBe(0);
    expect(JSON.parse(l.out).services).toEqual([expect.objectContaining({ name: SVC, owners: [A], disabled_at: null })]);
    for (const verb of ["disable", "enable"]) {
      const r = await cli(verb, SVC);
      expect(r.code, r.err).toBe(0);
    }
    const none = await cli("delete-alias", SVC, "w-1");
    expect(none.code).toBe(1);
    expect(none.err).toContain("has no name");
    const dup = await cli("create", SVC, "--owner", A);
    expect(dup.code).toBe(1);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
