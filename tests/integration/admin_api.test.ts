// The admin dashboard's read routes (#1651 D3, D5): the gate refuses a non-admin and a revoked admin on their next
// request, polling a view writes one allow row per window, a content view writes one admin.read row, lists carry no
// body, and every list pages to its end.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TestServer } from "../support/server.ts";
import { until } from "../support/until.ts";
import { accessAudits } from "../support/audit.ts";
import { drained, exec, row } from "../support/repo_sql.ts";
import { AdminRows, adminReadRoute, serveAdminRead } from "../../src/server/admin_api.ts";
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
    // Postgres writes audit rows through concurrent writers, so id order is not request order: compare as a set.
    expect(users.map(r => [r.actor, r.detail.allow]).sort()).toEqual([[A, false], [A, false], [ROOT, true]]);
    expect((await gateRows("/api/admin/threads")).length).toBe(2);
  });

  test("a dashboard read's gate row names its target, allow and deny; another /api/admin/ route's names none", async () => {
    const [a, root] = await Promise.all([srv.login(A), srv.login(ROOT)]);
    const [r1, r2] = [await post("e2e", null, "one"), await post("e2e", null, "two")];
    for (const r of [r1, r2, r1]) expect((await srv.api(root, "GET", `/api/admin/thread?root=${r}`)).status).toBe(200);
    expect((await srv.api(a, "GET", `/api/admin/thread?root=${r1}`)).status).toBe(403);
    expect((await gateRows("/api/admin/thread")).map(r => [r.actor, r.detail.allow, r.detail.target])).toEqual([[ROOT, true, String(r1)], [ROOT, true, String(r2)], [A, false, String(r1)]]);
    expect((await srv.api(root, "GET", "/api/admin/roles")).status).toBe(200);
    expect((await gateRows("/api/admin/roles")).map(r => "target" in r.detail)).toEqual([false]);
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

  test("the team view's bindings query (scope plus team_owner): a service can't share a team's name, and the role filter holds anyway", async () => {
    const root = await srv.login(ROOT);
    const a = await srv.login(A);
    expect((await srv.api(a, "POST", "/api/teams", { name: "deployer" })).status).toBe(201);
    expect((await srv.api(root, "POST", "/api/admin/services", { name: "deployer", owners: [A] })).status).toBe(409);
    expect((await srv.api(root, "POST", "/api/admin/services", { name: "indexer", owners: [A] })).status).toBe(201);
    const team = await srv.api(root, "GET", "/api/admin/role-bindings?scope=deployer&role=team_owner");
    expect(team.body.rows.map((b: { principal: string; role: string; scope: string }) => [b.principal, b.role, b.scope])).toEqual([[A, "team_owner", "deployer"]]);
    expect((await srv.api(root, "GET", "/api/admin/role-bindings?scope=indexer&role=team_owner")).body.rows).toEqual([]);
  });

  test("service-list pages services with their owners by id to the end", async () => {
    const root = await srv.login(ROOT);
    await srv.login(A);
    for (const name of ["deployer", "indexer", "sweeper"]) expect((await srv.api(root, "POST", "/api/admin/services", { name, owners: [A] })).status).toBe(201);
    const all = await srv.api(root, "GET", "/api/admin/service-list");
    expect(all.body.rows.map((s: { name: string; owners: string[] }) => [s.name, s.owners])).toEqual([["deployer", [A]], ["indexer", [A]], ["sweeper", [A]]]);
    expect(all.body.next).toBeNull();
    const seen: string[] = [];
    let after: number | null = 0;
    for (let i = 0; after !== null && i < 5; i++) {
      const page = await srv.api(root, "GET", `/api/admin/service-list?limit=2&after=${after}`);
      seen.push(...page.body.rows.map((s: { name: string }) => s.name));
      after = page.body.next;
    }
    expect(seen).toEqual(["deployer", "indexer", "sweeper"]);
    expect(after).toBeNull();
  });

  test("user-grants lists a user's OAuth grants and live CLI tokens without secrets, leaving out one idle past cliIdleDays", async () => {
    const root = await srv.login(ROOT);
    await srv.login(A);
    await srv.login(A);
    await srv.hosted(A, null);
    const grants = async () => (await srv.api(root, "GET", `/api/admin/user-grants?email=${A}`)).body.rows as Record<string, unknown>[];
    const rows = await grants();
    const oauth = rows.filter(g => g.kind === "oauth"), cli = rows.filter(g => g.kind === "cli");
    expect([oauth.length, cli.length]).toEqual([1, 2]);
    expect(Object.keys(oauth[0]!).sort()).toEqual(["client_id", "created_at", "expires_at", "id", "kind", "last_used_at"]);
    for (const g of cli) {
      expect(g.id).toMatch(/^cli:\d+$/);
      expect(Object.keys(g).sort()).toEqual(["created_at", "expires_at", "id", "kind", "label", "last_used_at"]);
    }
    // The default idle window is 30 days: a token last used 31 days ago is dead and left out.
    const idle = Number(String(cli[0]!.id).slice(4));
    await exec(srv, "UPDATE sessions SET last_used_at = ? WHERE id = ?", Date.now() - 31 * 86_400_000, idle);
    expect((await grants()).map(g => g.id)).not.toContain(`cli:${idle}`);
    expect((await grants()).filter(g => g.kind === "cli").length).toBe(1);
    expect((await srv.api(root, "GET", "/api/admin/user-grants?email=nobody@example.com")).body.rows).toEqual([]);
    expect((await srv.api(root, "GET", "/api/admin/user-grants")).status).toBe(400);
  });

  test("overview is a 501 where the server serves no overview getters", async () => {
    const res = await serveAdminRead("overview", new URL("http://x/api/admin/overview"), srv.app.repo, ROOT);
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({ code: "not_implemented" });
  });

  test("user-names lists a user's bound names, a held one with its holding session, most recently used first", async () => {
    const root = await srv.login(ROOT);
    const a = await srv.login(A);
    const live = await srv.connected(a, "be");
    const other = await srv.connected(a, "fe");
    await other.unbind("fe");
    const names = () => srv.api(root, "GET", `/api/admin/user-names?email=${A.toUpperCase()}`);
    const res = await until(async () => { const r = await names(); return r.status !== 200 || r.body.rows.some((x: { name: string; held_by: string | null }) => x.name === "fe" && x.held_by === null) ? r : null; });
    expect(res.status).toBe(200);
    const rows = res.body.rows as { name: string; held_by: string | null; last_seen: number | null }[];
    expect(rows.map(r => r.name).sort()).toEqual(["be", "fe"]);
    expect(rows.find(r => r.name === "be")!.held_by).toEqual(expect.any(String));
    expect(rows.find(r => r.name === "fe")!.held_by).toBeNull();
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1]!.last_seen ?? 0).toBeGreaterThanOrEqual(rows[i]!.last_seen ?? 0);
    expect((await srv.api(root, "GET", "/api/admin/user-names?email=nobody@example.com")).body.rows).toEqual([]);
    live.close();
    other.close();
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
