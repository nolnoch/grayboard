// The server's decisions land as `authz.decision` rows (#806, security audit
// F-19): every deny, and the allows of team management and admin routes. A
// hosted tool call's deny row survives the call's rollback.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TestServer } from "../support/server.ts";
import { accessAudits } from "../support/audit.ts";
import { HostedToolError } from "../support/hosted_session.ts";

const A = "alice@example.com";
const B = "bob@example.com";
const C = "carol@example.com";
const ROOT = "root@example.com";

let srv: TestServer;
beforeEach(() => {
  srv = new TestServer({ admins: [ROOT], hostedRequestLimit: { burst: 10_000, perSec: 10_000 } });
});
afterEach(() => srv.stop());

const rows = () =>
  accessAudits(srv.app.db, "authz.decision").map((r) => ({
    actor: r.actor, target: r.target, verb: r.detail.verb, allow: r.detail.allow, rule: r.detail.rule,
    ...(r.detail.route ? { route: r.detail.route } : {}),
  }));

describe("team management", () => {
  test("owner allows, a member's removal and a stranger's add deny, a stranger's read denies, a member's read writes nothing", async () => {
    const [a, b, c] = await Promise.all([srv.login(A), srv.login(B), srv.login(C)]);
    expect((await srv.api(a, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
    expect((await srv.api(a, "POST", "/api/teams/eng/add", { email: B })).status).toBe(200);
    expect((await srv.api(b, "POST", "/api/teams/eng/remove", { email: A })).status).toBe(403);
    expect((await srv.api(c, "POST", "/api/teams/eng/add", { email: C })).status).toBe(404);
    expect((await srv.api(c, "GET", "/api/teams/eng/members")).status).toBe(404);
    expect((await srv.api(b, "GET", "/api/teams/eng/members")).status).toBe(200);
    expect(rows()).toEqual([
      { actor: A, target: "team:eng", verb: "team.manage", allow: true, rule: "team.owner" },
      { actor: B, target: "team:eng", verb: "team.manage", allow: false, rule: "team.owner" },
      { actor: C, target: "team:eng", verb: "team.manage", allow: false, rule: "team.member" },
      { actor: C, target: "team:eng", verb: "team.read", allow: false, rule: "team.member" },
    ]);
  });

  test("a non-admin's admin route denies; an admin's allows; both name the route", async () => {
    const [a, root] = await Promise.all([srv.login(A), srv.login(ROOT)]);
    expect((await srv.api(a, "POST", "/api/admin/enable-user", { email: A })).status).toBe(403);
    expect((await srv.api(root, "POST", "/api/admin/enable-user", { email: A })).status).toBe(200);
    expect(rows()).toEqual([
      { actor: A, target: null, verb: "admin", allow: false, rule: "admin.env", route: "/api/admin/enable-user" },
      { actor: ROOT, target: null, verb: "admin", allow: true, rule: "admin.env", route: "/api/admin/enable-user" },
    ]);
  });
});

describe("session acts", () => {
  test("a refused DM to another user's human leaves one row, after the hosted rollback", async () => {
    await srv.login(A);
    srv.app.repo.aliases.create({ scope_kind: "person", scope_ref: A, name: "human" }, A);
    const fe = await srv.hosted(B, "fe");
    const err = (await fe.call("dm_send", { to: `${A}/human`, body: "hi" }).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(HostedToolError);
    expect(String(err.message)).toMatch(/reachable only by their teammates/);
    const got = accessAudits(srv.app.db, "authz.decision");
    expect(got.length).toBe(1);
    expect(got[0].actor).toBe(B);
    expect(got[0].target).toBe(`${A}/human`);
    expect(got[0].detail).toMatchObject({ verb: "msg.send", allow: false, rule: "human.teammates", code: "forbidden", user: B, address: `${B}/fe` });
    expect(typeof got[0].detail.session).toBe("string");
  });

  test("binding, and acting over HTTP, in a team one isn't in each leave a row", async () => {
    const [a, b] = await Promise.all([srv.login(A), srv.login(B)]);
    expect((await srv.api(a, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
    const s = await srv.hosted(B, null);
    const err = await s.call("bind", { name: "eng/build", create: true }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(HostedToolError);
    const call = await srv.api(b, "POST", "/api/claims/call", { as: "eng/build", tool: "claim_take", args: { key: "k" } });
    expect(call.status).toBe(403);
    const got = accessAudits(srv.app.db, "authz.decision");
    expect(got.map((r) => [r.actor, r.target, r.detail.verb, r.detail.allow, r.detail.rule])).toEqual([
      [B, "team:eng", "alias.bind", false, "scope.team_member"],
      [B, "team:eng", "act_as", false, "scope.team_member"],
    ]);
    expect(got[0].detail).toMatchObject({ address: "eng/build" });
    expect(typeof got[0].detail.session).toBe("string");
    expect(got[1].detail).toMatchObject({ address: "eng/build", session: null });
  });

  test("a tools-only session declaring writes_as in a team one isn't in leaves a row", async () => {
    const [a, b] = await Promise.all([srv.login(A), srv.login(B)]);
    expect((await srv.api(a, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
    const tools = srv.appSession(b, "eng/build", { push: false });
    await expect(tools.connect()).rejects.toThrow(/you can't act as "eng\/build"/);
    const got = accessAudits(srv.app.db, "authz.decision");
    expect(got.map((r) => [r.actor, r.target, r.detail.verb, r.detail.allow, r.detail.rule])).toEqual([[B, "team:eng", "alias.bind", false, "scope.team_member"]]);
    expect(got[0].detail).toMatchObject({ address: "eng/build", session: expect.stringMatching(/^id:/) });
  });
});
