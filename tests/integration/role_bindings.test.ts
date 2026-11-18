// Runtime role bindings (#927): org_admin granted and revoked at runtime, the GRAYBOARD_ADMINS list as bootstrap,
// team ownership as team_owner bindings, every change and every role-based decision audited by binding id.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/server/config.ts";
import { grantRole } from "../../src/server/roles.ts";
import { accessAudits } from "../support/audit.ts";
import { runCli } from "../support/cli.ts";
import { cleanEnv } from "../support/env.ts";
import { hostedPause } from "../support/hosted-pause.ts";
import { ROOT as REPO_ROOT } from "../support/paths.ts";
import { seed } from "../support/seed.ts";
import { ServerProcess, TestServer } from "../support/server.ts";

const A = "alice@example.com", B = "bob@example.com", C = "carol@example.com", ROOT = "root@example.com";

let srv: TestServer;
const restart = async (overrides: Partial<Config> = {}) => {
  await srv.stop();
  srv = new TestServer(overrides);
};
beforeEach(() => { srv = new TestServer({ admins: [ROOT] }); });
afterEach(() => srv.stop());

const api = (token: string, method: string, path: string, body?: unknown) => srv.api(token, method, path, body);
const grant = (token: string, role: string, principal: string, scope?: string) => api(token, "POST", "/api/admin/roles/grant", { role, principal, ...(scope ? { scope } : {}) });
const revoke = (token: string, role: string, principal: string, scope?: string) => api(token, "POST", "/api/admin/roles/revoke", { role, principal, ...(scope ? { scope } : {}) });
const bindings = () => srv.app.db.query("SELECT id, role, principal_id, scope_id, granted_by FROM role_bindings ORDER BY id").all() as { id: number; role: string; principal_id: number; scope_id: number | null; granted_by: number | null }[];
const principalId = (name: string) => (srv.app.db.query("SELECT id FROM principals WHERE name = ?").get(name) as { id: number }).id;
const decisions = (actor: string) => accessAudits(srv.app.db, "authz.decision").filter(r => r.actor === actor).map(r => r.detail);

describe("acceptance 1: granted at runtime, revoked with no restart", () => {
  test("a bootstrap admin grants org_admin; the holder's admin route allows by its binding; a revoke refuses the next request", async () => {
    const [root, alice] = [await srv.login(ROOT), await srv.login(A)];
    expect((await api(alice, "POST", "/api/admin/enable-user", { email: A })).status).toBe(403);
    const g = await grant(root, "org_admin", A);
    expect(g.status).toBe(201);
    expect(g.body.binding).toMatchObject({ principal: A, role: "org_admin", scope: null, granter: ROOT });
    const id = g.body.binding.id as number;

    expect((await api(alice, "POST", "/api/admin/enable-user", { email: A })).status).toBe(200);
    expect(decisions(A).at(-1)).toMatchObject({ verb: "admin", allow: true, rule: "role.org_admin", binding: id, role: "org_admin", scope: null, route: "/api/admin/enable-user" });

    expect((await revoke(root, "org_admin", A)).status).toBe(200);
    expect((await api(alice, "POST", "/api/admin/enable-user", { email: A })).status).toBe(403);
    expect(decisions(A).at(-1)).toMatchObject({ verb: "admin", allow: false, rule: "role.org_admin", role: "org_admin", scope: null });
  });

  // An operator's psql: the row deleted on another connection is the next decision's answer. A cache, even one the
  // store's own revoke would invalidate, fails here.
  test("a binding deleted on another connection refuses the next request", async () => {
    const [root, alice] = [await srv.login(ROOT), await srv.login(A)];
    expect((await grant(root, "org_admin", A)).status).toBe(201);
    expect((await api(alice, "POST", "/api/admin/enable-user", { email: A })).status).toBe(200);
    const other = new Database(srv.config.dbPath);
    try {
      other.exec("PRAGMA busy_timeout = 5000");
      other.run("DELETE FROM role_bindings");
    } finally { other.close(); }
    expect((await api(alice, "POST", "/api/admin/enable-user", { email: A })).status).toBe(403);
  });

  test("the CLI grants, lists and revokes against a server process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gb-roles-cli-"));
    const server = await ServerProcess.start([process.execPath, join(REPO_ROOT, "src/server/main.ts")], join(dir, "bus.db"), { GRAYBOARD_ADMINS: ROOT });
    try {
      const [root, alice] = [await server.login(ROOT), await server.login(A)];
      // A credentials file per signed-in user (mode 0600), as `grayboard login` writes it.
      const creds = (token: string, email: string) => {
        const path = join(dir, `${email}.credentials`);
        writeFileSync(path, JSON.stringify({ session_token: token, server: server.base, user_email: email }), { mode: 0o600 });
        return path;
      };
      const as = { [root]: creds(root, ROOT), [alice]: creds(alice, A) };
      const cli = (token: string, ...args: string[]) => runCli(["--json", "admin", "role", ...args], { cwd: dir, env: cleanEnv({ GRAYBOARD_CREDENTIALS: as[token]! }) });
      const g = await cli(root, "grant", "org_admin", A);
      expect(g.code, g.err).toBe(0);
      expect(JSON.parse(g.out)).toMatchObject({ created: true, binding: { principal: A, role: "org_admin" } });
      const l = await cli(alice, "list", "--role", "org_admin");
      expect(l.code, l.err).toBe(0);
      expect(JSON.parse(l.out).bindings.map((b: { principal: string; source: string }) => [b.principal, b.source])).toEqual([[ROOT, "bootstrap"], [A, "binding"]]);
      const r = await cli(alice, "revoke", "org_admin", A);
      expect(r.code, r.err).toBe(0);
      expect(JSON.parse(r.out)).toMatchObject({ revoked: { principal: A, role: "org_admin" } });
      const after = await cli(alice, "list");
      expect(after.code).toBe(1);
      expect(after.err).toContain("not an org admin");
    } finally {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("acceptance 2: GRAYBOARD_ADMINS is the bootstrap", () => {
  test("with no bindings a bootstrap admin is allowed by admin.env, written nowhere, listed, and can't be revoked", async () => {
    const root = await srv.login(ROOT);
    expect((await api(root, "POST", "/api/admin/enable-user", { email: ROOT })).status).toBe(200);
    expect(decisions(ROOT).at(-1)).toMatchObject({ verb: "admin", allow: true, rule: "admin.env" });
    expect(bindings()).toEqual([]);
    const l = await api(root, "GET", "/api/admin/roles");
    expect(l).toMatchObject({ status: 200, body: { bindings: [{ id: null, principal: ROOT, role: "org_admin", scope: null, source: "bootstrap" }], next: null } });
    const r = await revoke(root, "org_admin", ROOT);
    expect(r).toMatchObject({ status: 409, body: { message: expect.stringContaining("GRAYBOARD_ADMINS") } });
    // An email that never signed in is still a bootstrap admin: listed, and its revoke refused the same way.
    await restart({ admins: [ROOT, "later@example.com"] });
    const root2 = await srv.login(ROOT);
    expect((await api(root2, "GET", "/api/admin/roles")).body.bindings.map((b: { principal: string }) => b.principal)).toEqual([ROOT, "later@example.com"]);
    expect((await revoke(root2, "org_admin", "later@example.com")).status).toBe(409);
    expect(bindings()).toEqual([]);
  });

  test("a bootstrap admin who also holds a binding is decided by admin.env; revoking the binding says the env remains", async () => {
    const root = await srv.login(ROOT);
    expect((await grant(root, "org_admin", ROOT)).status).toBe(201);
    expect((await api(root, "POST", "/api/admin/enable-user", { email: ROOT })).status).toBe(200);
    expect(decisions(ROOT).at(-1)).toMatchObject({ rule: "admin.env" });
    expect(decisions(ROOT).at(-1)!.binding).toBeUndefined();
    const r = await revoke(root, "org_admin", ROOT);
    expect(r).toMatchObject({ status: 200, body: { revoked: { principal: ROOT }, note: expect.stringContaining("GRAYBOARD_ADMINS") } });
  });

  test("revoking the last org_admin binding on a server with no bootstrap admin says so", async () => {
    await restart({ admins: [] });
    const alice = await srv.login(A);
    await seed(srv.app.repo, () => srv.app.db.run("INSERT INTO role_bindings (principal_id, role, scope_id, granted_by, granted_at) SELECT id, 'org_admin', NULL, NULL, 0 FROM principals WHERE name = ?", [A]));
    const r = await revoke(alice, "org_admin", A);
    expect(r).toMatchObject({ status: 200, body: { warning: expect.stringContaining("no org admin remains") } });
    expect((await api(alice, "GET", "/api/admin/roles")).status).toBe(403);
  });
});

describe("acceptance 3: audit rows name the binding", () => {
  test("grant and revoke rows carry the binding; a repeated grant writes none; a role-based allow carries its binding", async () => {
    const [root, alice] = [await srv.login(ROOT), await srv.login(A)];
    const g = await grant(root, "org_admin", A);
    const id = g.body.binding.id as number;
    const again = await grant(root, "org_admin", A);
    expect(again).toMatchObject({ status: 200, body: { created: false, binding: { id } } });
    const granted = accessAudits(srv.app.db, "role.granted");
    expect(granted).toHaveLength(1);
    expect(granted[0]).toMatchObject({ actor: ROOT, target: A, detail: { binding: id, role: "org_admin", principal: A, principal_id: principalId(A), scope: null, scope_id: null, granted_by: principalId(ROOT) } });

    expect((await api(alice, "POST", "/api/admin/enable-user", { email: A })).status).toBe(200);
    expect(decisions(A).at(-1)).toMatchObject({ rule: "role.org_admin", binding: id });

    expect((await revoke(alice, "org_admin", A)).status).toBe(200);
    const revoked = accessAudits(srv.app.db, "role.revoked");
    expect(revoked).toHaveLength(1);
    expect(revoked[0]).toMatchObject({ actor: A, target: A, detail: { binding: id, role: "org_admin", principal: A, principal_id: principalId(A), scope: null, granted_by: principalId(ROOT), granter: ROOT, granted_at: expect.any(Number) } });
  });

  test("a deny names the role and scope looked for", async () => {
    const [alice, bob] = [await srv.login(A), await srv.login(B)];
    expect((await api(alice, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
    expect((await api(alice, "POST", "/api/teams/eng/add", { email: B })).status).toBe(200);
    expect((await api(bob, "POST", "/api/teams/eng/add", { email: B, role: "owner" })).status).toBe(403);
    expect(decisions(B).at(-1)).toMatchObject({ verb: "team.manage", allow: false, rule: "role.team_owner", role: "team_owner", scope: "eng" });
    expect((await api(bob, "GET", "/api/admin/roles")).status).toBe(403);
    expect(decisions(B).at(-1)).toMatchObject({ verb: "admin", allow: false, rule: "role.org_admin", role: "org_admin", scope: null });
    // The owner's allow carries the creator's binding.
    expect(decisions(A).at(-1)).toMatchObject({ verb: "team.manage", allow: true, rule: "role.team_owner", binding: bindings()[0]!.id, role: "team_owner", scope: "eng" });
  });

  test("an admin's roster read of a team they aren't in is an allow row, and their team changes carry as_admin by env or by binding", async () => {
    const [root, alice, bob, carol] = [await srv.login(ROOT), await srv.login(A), await srv.login(B), await srv.login(C)];
    expect((await api(alice, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
    expect((await grant(root, "org_admin", B)).status).toBe(201);
    expect((await api(root, "GET", "/api/teams/eng/members")).status).toBe(200);
    expect((await api(bob, "GET", "/api/teams/eng/members")).status).toBe(200);
    expect((await api(alice, "GET", "/api/teams/eng/members")).status).toBe(200);
    const reads = accessAudits(srv.app.db, "authz.decision").filter(r => r.detail.verb === "team.read").map(r => [r.actor, r.detail.rule]);
    // A member's read writes nothing.
    expect(reads).toEqual([[ROOT, "admin.env"], [B, "role.org_admin"]]);

    expect((await api(root, "POST", "/api/teams/eng/add", { email: C })).status).toBe(200);
    expect((await api(bob, "POST", "/api/teams/eng/remove", { email: C })).status).toBe(200);
    const changes = srv.app.db.query("SELECT actor, action, detail FROM access_log WHERE action IN ('team.member_added', 'team.member_removed') AND actor != ?").all(A) as { actor: string; action: string; detail: string }[];
    expect(changes.map(c => [c.actor, c.action, JSON.parse(c.detail).as_admin])).toEqual([[ROOT, "team.member_added", true], [B, "team.member_removed", true]]);
    expect(carol).toBeTruthy();
  });
});

describe("acceptance 4: team_owner on that team only", () => {
  test("an owner manages their team, is refused on a team they're only in, and reads not found on one they aren't in", async () => {
    const [alice, bob, carol] = [await srv.login(A), await srv.login(B), await srv.login(C)];
    // Creating a team gives its creator a binding, and the creator then manages it.
    expect((await api(alice, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
    expect(accessAudits(srv.app.db, "role.granted")).toMatchObject([{ actor: A, target: A, detail: { role: "team_owner", scope: "eng", granted_by: principalId(A) } }]);
    expect((await api(alice, "POST", "/api/teams/eng/add", { email: B })).status).toBe(200);
    expect(decisions(A).at(-1)).toMatchObject({ allow: true, rule: "role.team_owner" });
    expect((await api(bob, "POST", "/api/teams", { name: "ops" })).status).toBe(201);
    expect((await api(bob, "POST", "/api/teams/ops/add", { email: A })).status).toBe(200);
    expect((await api(carol, "POST", "/api/teams", { name: "qa" })).status).toBe(201);

    expect((await api(alice, "POST", "/api/teams/ops/add", { email: C })).status).toBe(403);
    expect((await api(alice, "POST", "/api/teams/qa/add", { email: B })).status).toBe(404);
  });

  test("a grant to a non-member is refused; owners appoint owners with themselves as granter", async () => {
    const [root, alice, bob] = [await srv.login(ROOT), await srv.login(A), await srv.login(B)];
    expect((await api(alice, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
    const outsider = await grant(root, "team_owner", B, "eng");
    expect(outsider).toMatchObject({ status: 409, body: { message: expect.stringContaining("grayboard team add eng bob@example.com") } });
    expect((await api(alice, "POST", "/api/teams/eng/add", { email: B, role: "owner" })).status).toBe(200);
    const bob_ = bindings().find(b => b.principal_id === principalId(B))!;
    expect(bob_).toMatchObject({ role: "team_owner", scope_id: principalId("eng"), granted_by: principalId(A) });
    // The admin route's grant of a held binding answers it, unchanged.
    expect(await grant(root, "team_owner", B, "eng")).toMatchObject({ status: 200, body: { created: false, binding: { id: bob_.id } } });
    expect(bob).toBeTruthy();
  });

  test("removing a member and a member leaving revoke their binding with its row; the last owner is guarded against both writers", async () => {
    const [root, alice, bob, carol] = [await srv.login(ROOT), await srv.login(A), await srv.login(B), await srv.login(C)];
    expect((await api(alice, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
    for (const e of [B, C]) expect((await api(alice, "POST", "/api/teams/eng/add", { email: e, role: "owner" })).status).toBe(200);

    expect((await api(alice, "POST", "/api/teams/eng/remove", { email: B })).status).toBe(200);
    expect((await api(carol, "POST", "/api/teams/eng/leave")).status).toBe(200);
    expect(accessAudits(srv.app.db, "role.revoked").map(r => [r.actor, r.target, r.detail.role, r.detail.scope])).toEqual([[A, B, "team_owner", "eng"], [C, C, "team_owner", "eng"]]);
    expect(bindings().map(b => b.principal_id)).toEqual([principalId(A)]);

    // Alice is the last owner, with bob back as a member: neither the admin route nor a demotion takes it.
    expect((await api(alice, "POST", "/api/teams/eng/add", { email: B })).status).toBe(200);
    expect((await revoke(root, "team_owner", A, "eng"))).toMatchObject({ status: 409, body: { message: expect.stringContaining("last owner") } });
    expect((await api(alice, "POST", "/api/teams/eng/add", { email: A, role: "member" })).status).toBe(409);
    expect((await api(alice, "POST", "/api/teams/eng/leave")).status).toBe(409);
    expect(bindings().map(b => b.principal_id)).toEqual([principalId(A)]);
    expect(bob).toBeTruthy();
  });
});

describe("service_invoke", () => {
  test("a grant is refused 404 while no service principal exists", async () => {
    const [root] = [await srv.login(ROOT), await srv.login(A)];
    expect(await grant(root, "service_invoke", A, "ingest")).toMatchObject({ status: 404, body: { message: 'no service named "ingest"' } });
    expect(await grant(root, "service_invoke", A)).toMatchObject({ status: 400 });
    expect(bindings()).toEqual([]);
  });
});

describe("stale authority", () => {
  test("an org admin revoked between the gate and the grant's write is refused, and nothing is written", async () => {
    const [root, alice] = [await srv.login(ROOT), await srv.login(A), await srv.login(B)];
    expect((await grant(root, "org_admin", A)).status).toBe(201);
    const res = await hostedPause("http:admin-role-grant:before-write",
      () => grant(alice, "org_admin", B),
      async () => { expect((await revoke(root, "org_admin", A)).status).toBe(200); });
    expect(res).toMatchObject({ status: 403, body: { message: expect.stringContaining("no longer holds") } });
    expect(bindings()).toEqual([]);
    expect(accessAudits(srv.app.db, "role.granted")).toHaveLength(1);
  });

  // `team add` decides inside its write transaction, so on SQLite nothing lands between the decision and the write;
  // the store's own re-check is what a Postgres interleaving reaches (P3 tests the interleaving itself). An owner whose
  // binding is gone by the write grants nothing.
  test("a demoted owner's grant re-checks their binding in the write and is refused", async () => {
    const [alice, bob] = [await srv.login(A), await srv.login(B), await srv.login(C)];
    expect((await api(alice, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
    for (const e of [B, C]) expect((await api(alice, "POST", "/api/teams/eng/add", { email: e })).status).toBe(200);
    expect((await api(alice, "POST", "/api/teams/eng/add", { email: B, role: "owner" })).status).toBe(200);
    // Bob demotes alice; the grant she was allowed to make before that, run now with her owner_or_admin authority,
    // grants carol nothing.
    const repo = srv.app.repo;
    const aliceId = (await repo.users.findByEmail(repo.read, A))!.id;
    expect((await api(bob, "POST", "/api/teams/eng/add", { email: A, role: "member" })).status).toBe(200);
    const out = await seed(repo, tx => grantRole(repo, tx, { holder: C, role: "team_owner", scope: "eng" }, { email: A, userId: aliceId, authority: "owner_or_admin" }));
    expect(out).toMatchObject({ refused: { status: 403 } });
    expect(bindings().map(b => b.principal_id)).toEqual([principalId(B)]);
  });
});
