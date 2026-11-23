// The admin dashboard's read routes (#1651 D3, D5): the gate refuses a non-admin and a revoked admin on their next
// request, polling a view writes one allow row per window, a content view writes one admin.read row, lists carry no
// body, and every list pages to its end.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TestServer } from "../support/server.ts";
import { accessAudits } from "../support/audit.ts";
import { drained, exec, row } from "../support/repo_sql.ts";
import { AdminRows, adminReadRoute } from "../../src/server/admin_api.ts";
import pkg from "../../package.json" with { type: "json" };

const A = "alice@example.com";
const ROOT = "root@example.com";
const T0 = 1_700_000_000_000;

let srv: TestServer;
beforeEach(async () => { srv = await TestServer.open({ admins: [ROOT] }); });
afterEach(async () => { await srv.stop(); });

const audits = async (action: string) => { await drained(srv); return accessAudits(srv, action); };
const gateRows = async (route: string) => (await audits("authz.decision")).filter(r => r.detail.route === route);

async function post(board: string, parent: number | null, body: string): Promise<number> {
  await exec(srv, "INSERT INTO boards (name, purpose, scope, created_by, created_at) VALUES (?, '', NULL, 'test', ?) ON CONFLICT DO NOTHING", board, T0);
  await exec(srv, "INSERT INTO posts (board, author, body, parent_id, created_at, expires_at) VALUES (?, 'be', ?, ?, ?, NULL)", board, body, parent, T0);
  return Number((await row<{ id: number }>(srv, "SELECT max(id) AS id FROM posts"))!.id);
}
async function message(sender: string, recipient: string, body: string): Promise<number> {
  await exec(srv, "INSERT INTO messages (sender, recipient_type, recipient, body, parent_id, created_at, delivered_at, kind) VALUES (?, 'user', ?, ?, NULL, ?, NULL, NULL)", sender, recipient, body, T0);
  return Number((await row<{ id: number }>(srv, "SELECT max(id) AS id FROM messages"))!.id);
}

describe("gate", () => {
  test("a non-admin is refused and each refusal is written; an admin's polling writes one allow per route and target", async () => {
    const [a, root] = await Promise.all([srv.login(A), srv.login(ROOT)]);
    for (let i = 0; i < 2; i++) expect((await srv.api(a, "GET", "/api/admin/users")).status).toBe(403);
    for (let i = 0; i < 3; i++) expect((await srv.api(root, "GET", "/api/admin/users")).status).toBe(200);
    for (const board of ["e2e", "e2e", "other"]) expect((await srv.api(root, "GET", `/api/admin/threads?board=${board}`)).status).toBe(200);
    const users = await gateRows("/api/admin/users");
    expect(users.map(r => [r.actor, r.detail.allow])).toEqual([[A, false], [A, false], [ROOT, true]]);
    expect((await gateRows("/api/admin/threads")).length).toBe(2);
  });

  test("a revoked org_admin is refused on the next read", async () => {
    const [a, root] = await Promise.all([srv.login(A), srv.login(ROOT)]);
    expect((await srv.api(root, "POST", "/api/admin/roles/grant", { role: "org_admin", principal: A })).status).toBe(201);
    expect((await srv.api(a, "GET", "/api/admin/claims")).status).toBe(200);
    expect((await srv.api(root, "POST", "/api/admin/roles/revoke", { role: "org_admin", principal: A })).status).toBe(200);
    expect((await srv.api(a, "GET", "/api/admin/claims")).status).toBe(403);
  });

  test("a non-dashboard route under /api/admin/ still writes its allow every time", async () => {
    const root = await srv.login(ROOT);
    for (let i = 0; i < 2; i++) expect((await srv.api(root, "GET", `/api/admin/roles`)).status).toBe(200);
    expect((await gateRows("/api/admin/roles")).length).toBe(2);
  });
});

describe("reads", () => {
  test("users page to the end by id with a cursor; a bad parameter is a 400", async () => {
    const root = await srv.login(ROOT);
    await Promise.all(["b@example.com", "c@example.com", "d@example.com"].map(e => srv.login(e)));
    const seen: string[] = [];
    let after: unknown = 0;
    for (let i = 0; after !== null; i++) {
      expect(i).toBeLessThan(10);
      const r = await srv.api(root, "GET", `/api/admin/users?limit=2&after=${after}`);
      expect(r.status).toBe(200);
      seen.push(...r.body.rows.map((u: { email: string }) => u.email));
      after = r.body.next;
    }
    expect(seen.sort()).toEqual(["b@example.com", "c@example.com", "d@example.com", ROOT].sort());
    expect((await srv.api(root, "GET", "/api/admin/users?after=-1")).status).toBe(400);
    expect((await srv.api(root, "GET", "/api/admin/threads")).status).toBe(400);
    expect((await srv.api(root, "GET", "/api/admin/audit?actor=x&action=y")).status).toBe(400);
    expect((await srv.api(root, "GET", "/api/admin/audit?before_at=1")).status).toBe(400);
  });

  test("threads list roots without bodies; opening a thread returns its posts and writes one admin.read per window", async () => {
    const root = await srv.login(ROOT);
    const r1 = await post("e2e", null, "root body");
    const reply = await post("e2e", r1, "reply body");
    const list = await srv.api(root, "GET", "/api/admin/threads?board=e2e");
    expect(list.body.rows).toEqual([{ id: r1, author: "be", created_at: T0 }]);
    for (let i = 0; i < 2; i++) {
      const t = await srv.api(root, "GET", `/api/admin/thread?root=${r1}`);
      expect(t.body.rows.map((p: { id: number; body: string }) => [p.id, p.body])).toEqual([[r1, "root body"], [reply, "reply body"]]);
    }
    expect((await srv.api(root, "GET", `/api/admin/thread?root=${reply + 100}`)).body.rows).toEqual([]);
    const reads = await audits("admin.read");
    expect(reads.map(r => [r.actor, r.target, r.detail.view])).toEqual([[ROOT, `e2e#${r1}`, "thread"]]);
  });

  test("the DM list has no bodies; a conversation returns both directions and one admin.read for the pair either way round", async () => {
    const root = await srv.login(ROOT);
    const m1 = await message("be", "fe", "secret one");
    const m2 = await message("fe", "be", "secret two");
    await message("be", "sim", "elsewhere");
    const list = await srv.api(root, "GET", "/api/admin/messages");
    expect(list.body.rows.length).toBe(3);
    for (const m of list.body.rows) expect(m).not.toHaveProperty("body");
    const c = await srv.api(root, "GET", "/api/admin/conversation?a=be&b=fe");
    expect(c.body.rows.map((m: { id: number; body: string }) => [m.id, m.body])).toEqual([[m2, "secret two"], [m1, "secret one"]]);
    expect((await srv.api(root, "GET", "/api/admin/conversation?a=fe&b=be")).status).toBe(200);
    expect((await audits("admin.read")).map(r => [r.target, r.detail.view])).toEqual([["be fe", "conversation"]]);
  });

  test("overview reports the in-process numbers, one page, and writes no row beyond the gate's", async () => {
    const [a, root] = await Promise.all([srv.login(A), srv.login(ROOT)]);
    expect((await srv.api(a, "GET", "/api/admin/overview")).status).toBe(403);
    for (let i = 0; i < 2; i++) {
      const r = await srv.api(root, "GET", "/api/admin/overview");
      expect(r.status).toBe(200);
      expect(r.body.next).toBeNull();
      const o = r.body.rows[0];
      expect(o.version).toBe(pkg.version);
      expect(o.health).toEqual({ ok: true, code: null });
      expect(o.slack).toBe("off");
      expect(typeof o.uptime_s).toBe("number");
      expect(typeof o.queue_waiters).toBe("number");
      expect(Object.keys(o.refusals)).toContain("mcp_post");
      expect(o.gauges.map((g: { name: string }) => g.name)).toContain("hosted_sessions_holding");
    }
    // The deny and the first allow, in either order: audit rows are written off the request path.
    expect((await gateRows("/api/admin/overview")).map(r => [r.actor, r.detail.allow]).sort()).toEqual([[A, false], [ROOT, true]]);
    expect(await audits("admin.read")).toEqual([]);
  });

  test("an empty conversation writes no admin.read, and a long pair's gate target is clipped", async () => {
    const root = await srv.login(ROOT);
    const long = "x".repeat(5000);
    const r = await srv.api(root, "GET", `/api/admin/conversation?a=nobody&b=${long}`);
    expect(r.status).toBe(200);
    expect(r.body.rows).toEqual([]);
    await drained(srv);
    expect(await audits("admin.read")).toEqual([]);
    for (const row of await audits("authz.decision")) expect(String(row.target ?? "").length).toBeLessThanOrEqual(256);
  });

  test("role-bindings lead with the bootstrap admins, page by id and filter; a bad role is a 400", async () => {
    const root = await srv.login(ROOT);
    await srv.login(A);
    expect((await srv.api(root, "POST", "/api/admin/roles/grant", { role: "org_admin", principal: A })).status).toBe(201);
    const all = await srv.api(root, "GET", "/api/admin/role-bindings");
    expect(all.status).toBe(200);
    expect(all.body.rows.map((b: { principal: string; role: string; source: string }) => [b.principal, b.role, b.source])).toEqual([[ROOT, "org_admin", "bootstrap"], [A, "org_admin", "binding"]]);
    expect(all.body.next).toBeNull();
    const mine = await srv.api(root, "GET", `/api/admin/role-bindings?principal=${A}`);
    expect(mine.body.rows.map((b: { principal: string }) => b.principal)).toEqual([A]);
    const paged = await srv.api(root, "GET", "/api/admin/role-bindings?limit=1");
    expect(paged.body.next).toBe(all.body.rows[1].id);
    expect((await srv.api(root, "GET", `/api/admin/role-bindings?after=${paged.body.next}`)).body.rows).toEqual([]);
    expect((await srv.api(root, "GET", "/api/admin/role-bindings?role=nope")).status).toBe(400);
  });

  test("service-list pages services with owners; user-grants lists a user's live CLI tokens and grants without secrets", async () => {
    const root = await srv.login(ROOT);
    await srv.login(A);
    await srv.login(A);
    expect((await srv.api(root, "POST", "/api/admin/services", { name: "deployer", owners: [A] })).status).toBe(201);
    const services = await srv.api(root, "GET", "/api/admin/service-list");
    expect(services.body.rows.map((s: { name: string; owners: string[] }) => [s.name, s.owners])).toEqual([["deployer", [A]]]);
    const grants = await srv.api(root, "GET", `/api/admin/user-grants?email=${A}`);
    expect(grants.status).toBe(200);
    expect(grants.body.rows.length).toBe(2);
    for (const g of grants.body.rows) {
      expect(g.kind).toBe("cli");
      expect(g.id).toMatch(/^cli:\d+$/);
      expect(Object.keys(g).sort()).toEqual(["client_id", "created_at", "expires_at", "id", "kind", "label", "last_used_at"]);
    }
    expect((await srv.api(root, "GET", "/api/admin/user-grants?email=nobody@example.com")).body.rows).toEqual([]);
    expect((await srv.api(root, "GET", "/api/admin/user-grants")).status).toBe(400);
  });

  test("no dashboard route shadows another /api/admin/ path: the CLI's GET lists keep their own shapes", async () => {
    const source = await Bun.file(new URL("../../src/server/http.ts", import.meta.url)).text();
    const paths = [...new Set([...source.matchAll(/path === "(\/api\/admin\/[a-z/-]+)"/g)].map(m => m[1]!))];
    expect(paths).toContain("/api/admin/roles");
    for (const path of paths) expect([path, adminReadRoute("GET", path, new URL(`http://x${path}`))]).toEqual([path, undefined]);
    const root = await srv.login(ROOT);
    expect(Object.keys((await srv.api(root, "GET", "/api/admin/roles")).body).sort()).toEqual(["bindings", "next"]);
    expect(Object.keys((await srv.api(root, "GET", "/api/admin/services")).body).sort()).toEqual(["next", "services"]);
  });

  test("audit pages newest first under a filter with an (at, id) cursor", async () => {
    const root = await srv.login(ROOT);
    for (let i = 0; i < 3; i++) await srv.api(root, "GET", `/api/admin/threads?board=b${i}`);
    await drained(srv);
    const ids: number[] = [];
    let q = "/api/admin/audit?action=authz.decision&limit=2";
    for (let i = 0; ; i++) {
      expect(i).toBeLessThan(10);
      const r = await srv.api(root, "GET", q);
      ids.push(...r.body.rows.map((x: { id: number }) => x.id));
      if (!r.body.next) break;
      q = `/api/admin/audit?action=authz.decision&limit=2&before_at=${r.body.next.at}&before_id=${r.body.next.id}`;
    }
    expect(ids.length).toBeGreaterThanOrEqual(3);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

test("AdminRows: one row per key per window, again after it, and undeduplicated past the key cap", () => {
  const rows = new AdminRows(1000, 2);
  expect(rows.due("gate", "r", "users", "", 0)).toBe(true);
  expect(rows.due("gate", "r", "users", "", 999)).toBe(false);
  expect(rows.due("read", "r", "users", "", 999)).toBe(true);
  expect(rows.due("gate", "r", "users", "", 1000)).toBe(true);
  // Full: a new key is written every time until a sweep frees room.
  expect(rows.due("gate", "r", "threads", "x", 1500)).toBe(true);
  expect(rows.due("gate", "r", "threads", "x", 1500)).toBe(true);
  expect(rows.due("gate", "r", "threads", "y", 2500)).toBe(true);
  expect(rows.due("gate", "r", "threads", "y", 2600)).toBe(false);
});
