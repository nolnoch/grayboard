// The server's decisions land as `authz.decision` rows (#806, security audit
// F-19): every deny, and the allows of team management and admin routes. A
// hosted tool call's deny row survives the call's rollback.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { TestServer } from "../support/server.ts";
import { accessAudits } from "../support/audit.ts";
import { until } from "../support/until.ts";
import { HOSTED_CLIENT, HOSTED_SCOPES, HostedToolError } from "../support/hosted_session.ts";
import { Client, StreamableHTTPClientTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { MCP_PROTOCOL_VERSIONS } from "../../src/server/mcp.ts";
import { DENY_ROW_LIMIT } from "../../src/server/policy.ts";
import { hostedSessionId } from "../../src/server/hosted.ts";
import { HUMAN_RESERVED } from "../../src/shared/addressing.ts";
import { GRAYBOARD_SESSION_META, GRAYBOARD_WRITES_AS_META } from "../../src/shared/session_meta.ts";
import { issueOAuth } from "../helpers/oauth.ts";
import { withMeta } from "../helpers/hosted.ts";
import { seed } from "../support/seed.ts";
import { exec, rows as sqlRows } from "../support/repo_sql.ts";
import { hostedPause } from "../support/hosted-pause.ts";

const A = "alice@example.com";
const B = "bob@example.com";
const C = "carol@example.com";
const ROOT = "root@example.com";

let srv: TestServer;
beforeEach(async () => {
  srv = await TestServer.open({ admins: [ROOT], hostedRequestLimit: { burst: 10_000, perSec: 10_000 } });
});
const clients: Client[] = [];
afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((c) => c.close()));
  await srv.stop();
});

// A hosted tools-only root over real HTTP (#451): every request carries the
// generic session key and the alias it writes as (`writesAs`, changeable
// between calls), so the server's own transaction and `later` hook decide.
async function toolsOnly(email: string, sessionId: string, writesAs: () => string): Promise<(tool: string, args?: Record<string, unknown>) => Promise<CallToolResult>> {
  const { token } = await issueOAuth(srv.app.repo, srv.app.oauth.resource, email, HOSTED_SCOPES, Date.now(), HOSTED_CLIENT);
  const version = MCP_PROTOCOL_VERSIONS[0]!;
  const client = new Client({ name: "tools-only", version: "1" }, { supportedProtocolVersions: [version], versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" } });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`), {
    fetch: async (input, init) => {
      let request = new Request(input, init);
      request = await withMeta(request, GRAYBOARD_SESSION_META, sessionId);
      request = await withMeta(request, GRAYBOARD_WRITES_AS_META, writesAs());
      request.headers.set("Authorization", `Bearer ${token}`);
      return fetch(request);
    },
  }));
  return async (tool, args = {}) => (await client.callTool({ name: tool, arguments: args })) as CallToolResult;
}

const rows = async () =>
  (await accessAudits(srv, "authz.decision")).map((r) => ({
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
    expect(await rows()).toEqual([
      { actor: A, target: "team:eng", verb: "team.manage", allow: true, rule: "role.team_owner" },
      { actor: B, target: "team:eng", verb: "team.manage", allow: false, rule: "role.team_owner" },
      { actor: C, target: "team:eng", verb: "team.manage", allow: false, rule: "team.member" },
      { actor: C, target: "team:eng", verb: "team.read", allow: false, rule: "team.member" },
    ]);
  });

  // The roster is read before the guard decides (#807 P3 A7f1): a member removed between the two reads is refused,
  // not handed the roster read while they were still in the team.
  test("a member removed while their roster read waits reads not found, with a deny row", async () => {
    const [a, b] = await Promise.all([srv.login(A), srv.login(B)]);
    expect((await srv.api(a, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
    expect((await srv.api(a, "POST", "/api/teams/eng/add", { email: B })).status).toBe(200);
    const res = await hostedPause("http:team-members:between",
      () => srv.api(b, "GET", "/api/teams/eng/members"),
      async () => { expect((await srv.api(a, "POST", "/api/teams/eng/remove", { email: B })).status).toBe(200); });
    expect(res.status).toBe(404);
    expect((await rows()).filter((r) => r.actor === B)).toEqual([{ actor: B, target: "team:eng", verb: "team.read", allow: false, rule: "team.member" }]);
  });

  test("a non-admin's admin route denies; an admin's allows; both name the route", async () => {
    const [a, root] = await Promise.all([srv.login(A), srv.login(ROOT)]);
    expect((await srv.api(a, "POST", "/api/admin/enable-user", { email: A })).status).toBe(403);
    expect((await srv.api(root, "POST", "/api/admin/enable-user", { email: A })).status).toBe(200);
    expect(await rows()).toEqual([
      { actor: A, target: null, verb: "admin", allow: false, rule: "role.org_admin", route: "/api/admin/enable-user" },
      { actor: ROOT, target: null, verb: "admin", allow: true, rule: "admin.env", route: "/api/admin/enable-user" },
    ]);
  });
});

describe("deny rows", () => {
  test("a user looping on a refused act writes at most the burst of rows; allows aren't thinned", async () => {
    const [a, root] = await Promise.all([srv.login(A), srv.login(ROOT)]);
    for (let i = 0; i < DENY_ROW_LIMIT.burst + 10; i++) expect((await srv.api(a, "POST", "/api/admin/enable-user", { email: A })).status).toBe(403);
    for (let i = 0; i < DENY_ROW_LIMIT.burst + 10; i++) expect((await srv.api(root, "POST", "/api/admin/enable-user", { email: A })).status).toBe(200);
    const got = await rows();
    expect(got.filter((r) => r.actor === A).length).toBe(DENY_ROW_LIMIT.burst);
    expect(got.filter((r) => r.actor === ROOT).length).toBe(DENY_ROW_LIMIT.burst + 10);
  });

  // #1082: a streak that ends inside a write body (team leave's memberTeam deny runs in repo.write) writes its
  // authz.suppressed row on that body's Tx, so it commits with the body and is never posted. The buckets age on the
  // store's clock: here it runs ten days behind wall time and only it moves, so a limiter on Date.now never refills.
  test("a deny streak ending inside a write body writes authz.suppressed on that body, on the store's clock", async () => {
    await srv.stop();
    let clock = Date.now() - 10 * 24 * 3_600_000;
    srv = await TestServer.open({ admins: [ROOT], hostedRequestLimit: { burst: 10_000, perSec: 10_000 } }, { now: () => clock });
    const a = await srv.login(A);
    const leave = async () => expect((await srv.api(a, "POST", "/api/teams/nosuch/leave")).status).toBe(404);
    for (let i = 0; i < DENY_ROW_LIMIT.burst + 5; i++) await leave();
    expect(await accessAudits(srv, "authz.suppressed")).toEqual([]);
    clock += Math.ceil(DENY_ROW_LIMIT.burst / DENY_ROW_LIMIT.perSec) * 1000;
    const post = spyOn(srv.app.repo, "post");
    try {
      await leave();
      expect(post.mock.calls.filter((c) => c[2] === "audit authz.suppressed")).toEqual([]);
    } finally { post.mockRestore(); }
    expect((await accessAudits(srv, "authz.suppressed")).map((r) => [r.actor, r.at, r.detail])).toEqual([[A, clock, { refused: 5 }]]);
    // The refilled bucket records the deny that ended the streak.
    expect((await accessAudits(srv, "authz.decision")).filter((r) => r.actor === A).length).toBe(DENY_ROW_LIMIT.burst + 1);
  });

  test("a caller-chosen route or team name is clipped in the row", async () => {
    const a = await srv.login(A);
    const long = "x".repeat(4000);
    expect((await srv.api(a, "POST", `/api/admin/${long}`, {})).status).toBe(403);
    expect((await srv.api(a, "GET", `/api/teams/${long}/members`)).status).toBe(404);
    const got = await accessAudits(srv, "authz.decision");
    expect(got.length).toBe(2);
    expect(String(got[0].detail.route).length).toBeLessThanOrEqual(129);
    expect(String(got[1].detail.team_requested).length).toBeLessThanOrEqual(129);
  });
});

describe("session acts", () => {
  test("a refused DM to another user's human leaves one row, after the hosted rollback", async () => {
    await srv.login(A);
    await seed(srv.app.repo, tx => srv.app.repo.aliases.create(tx, { scope_kind: "person", scope_ref: A, name: "human" }, A));
    const fe = await srv.hosted(B, "fe");
    const err = (await fe.call("dm_send", { to: `${A}/human`, body: "hi" }).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(HostedToolError);
    expect(String(err.message)).toMatch(/reachable only by their teammates/);
    const got = await accessAudits(srv, "authz.decision");
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
    const got = await accessAudits(srv, "authz.decision");
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
    await expect(tools.connect()).rejects.toThrow(/"eng\/build": no team or service is named "eng"/);
    const got = await accessAudits(srv, "authz.decision");
    expect(got.map((r) => [r.actor, r.target, r.detail.verb, r.detail.allow, r.detail.rule])).toEqual([[B, "team:eng", "alias.bind", false, "scope.team_member"]]);
    expect(got[0].detail).toMatchObject({ address: "eng/build", session: expect.stringMatching(/^id:/) });
  });

  test("a hosted tools-only root's writes_as into a team one isn't in leaves a row, after the hosted rollback", async () => {
    const a = await srv.login(A);
    expect((await srv.api(a, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
    // The connect's first request is refused (the hosted session is never created).
    await expect(toolsOnly(B, "tools-new", () => "eng/build")).rejects.toThrow();
    const got = await accessAudits(srv, "authz.decision");
    expect(got.map((x) => [x.actor, x.target, x.detail.verb, x.detail.allow, x.detail.rule])).toEqual([[B, "team:eng", "alias.bind", false, "scope.team_member"]]);
    expect(got[0].detail).toMatchObject({ address: "eng/build", session: expect.stringMatching(/^id:/) });
  });

  test("an existing tools-only root that later declares a team one isn't in leaves a row", async () => {
    const a = await srv.login(A);
    expect((await srv.api(a, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
    let writesAs = "ci";
    const call = await toolsOnly(B, "tools-old", () => writesAs);
    expect((await call("whoami")).isError).not.toBe(true);
    writesAs = "eng/build";
    await expect(call("whoami")).rejects.toThrow();
    const got = await accessAudits(srv, "authz.decision");
    expect(got.map((x) => [x.actor, x.detail.verb, x.detail.allow, x.detail.address])).toEqual([[B, "alias.bind", false, "eng/build"]]);
  });
});

// #851: the refusals that decided inline before the seam now go through it,
// each with its response unchanged and one row.
describe("pre-seam refusals", () => {
  const claimAs = (token: string, as: string) => srv.api(token, "POST", "/api/claims/call", { as, tool: "claim_take", args: { key: "k" } });

  test("an HTTP `as` naming another user's, an unknown, a viewer's or an ended session ID is refused alike and leaves one row each", async () => {
    const [a, b] = await Promise.all([srv.login(A), srv.login(B)]);
    const theirs = (await srv.connected(a, "fe")).id;
    const mine = (await srv.connected(b, "be")).id;
    await exec(srv, "UPDATE ids SET ended_at = 1000 WHERE id = ?", mine);
    const viewer = (await srv.connected(b, "viewer")).id;
    await exec(srv, "UPDATE ids SET viewer = TRUE WHERE id = ?", viewer);
    const unknown = "id:0000000000000";
    const texts: string[] = [];
    for (const id of [theirs, unknown, viewer, mine]) {
      const r = await claimAs(b, id);
      expect(r.status).toBe(403);
      texts.push(r.body.message);
    }
    expect(texts).toEqual([`${theirs} isn't a session of yours`, `${unknown} isn't a session of yours`, `${viewer} isn't a session of yours`, `${mine} ended at ${new Date(1000).toISOString()}`]);
    const got = await accessAudits(srv, "authz.decision");
    expect(got.map((r) => [r.actor, r.target, r.detail.verb, r.detail.allow, r.detail.rule, r.detail.code])).toEqual([
      [B, theirs, "session.act", false, "session.other_user", "forbidden"],
      [B, unknown, "session.act", false, "session.unknown", "forbidden"],
      [B, viewer, "session.act", false, "session.viewer", "forbidden"],
      [B, mine, "session.act", false, "session.ended", "forbidden"],
    ]);
    // The row never names whose the ID is.
    expect(JSON.stringify(got[0].detail)).not.toContain(A);
  });

  test("an HTTP `as` naming `human`, or a scope no principal owns, is refused as before and leaves one row each", async () => {
    const b = await srv.login(B);
    const human = await claimAs(b, "human");
    expect(human.status).toBe(403);
    expect(human.body.message).toBe(`claims are for agents; "human" is your Slack link`);
    const ownerless = await claimAs(b, "nosuch/build");
    expect(ownerless.status).toBe(403);
    expect(ownerless.body.message).toBe(`you can't act as "nosuch/build": no principal owns its scope`);
    const got = await accessAudits(srv, "authz.decision");
    expect(got.map((r) => [r.actor, r.target, r.detail.verb, r.detail.allow, r.detail.rule, r.detail.address])).toEqual([
      [B, `person:${B}`, "act_as", false, "alias.human_reserved", `${B}/human`],
      [B, "nosuch/build", "act_as", false, "scope.ownerless", "nosuch/build"],
    ]);
  });

  test("binding `human` is refused as before and leaves one row, after the hosted rollback", async () => {
    await srv.login(B);
    const s = await srv.hosted(B, null);
    await expect(s.call("bind", { name: "human", create: true })).rejects.toMatchObject({ code: "forbidden", message: HUMAN_RESERVED });
    const got = await accessAudits(srv, "authz.decision");
    expect(got.map((r) => [r.actor, r.target, r.detail.verb, r.detail.allow, r.detail.rule, r.detail.name])).toEqual([[B, `person:${B}`, "alias.bind", false, "alias.human_reserved", "human"]]);
    expect(typeof got[0].detail.session).toBe("string");
  });

  test("leaving a team one isn't in reads as not found, for an admin too, and leaves one row each", async () => {
    const [a, c, root] = await Promise.all([srv.login(A), srv.login(C), srv.login(ROOT)]);
    expect((await srv.api(a, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
    expect((await srv.api(c, "POST", "/api/teams/eng/leave")).status).toBe(404);
    expect((await srv.api(root, "POST", "/api/teams/eng/leave")).status).toBe(404);
    expect(await srv.app.repo.teams.isMember(srv.app.repo.read, (await srv.app.repo.teams.findByName(srv.app.repo.read, "eng"))!.id, (await srv.app.repo.users.findByEmail(srv.app.repo.read, A))!.id)).toBe(true);
    expect((await rows()).filter((r) => r.verb === "team.leave")).toEqual([
      { actor: C, target: "team:eng", verb: "team.leave", allow: false, rule: "team.member" },
      { actor: ROOT, target: "team:eng", verb: "team.leave", allow: false, rule: "team.member" },
    ]);
  });

  // A hosted session's own row: its server-side ID, from the user, the client and the raw ID it sends.
  const hostedId = async (email: string, raw: string) => hostedSessionId((await srv.app.repo.users.findByEmail(srv.app.repo.read, email))!.id, HOSTED_CLIENT, raw);
  // A copy of row `from` under ID `id`, with `set`'s columns changed: the state only a hash collision (or another
  // client's session) could give.
  const forgeRow = async (id: string, from: string, set: Record<string, string | number>) => {
    // The columns, from the row copied (no pragma or information_schema both backends have).
    const cols = Object.keys((await sqlRows(srv, "SELECT * FROM hosted_sessions WHERE session_id = ?", from))[0]!);
    const picked = cols.map((c) => (c === "session_id" || c in set ? "?" : c)).join(", ");
    const values = cols.filter((c) => c === "session_id" || c in set).map((c) => (c === "session_id" ? id : set[c]!));
    return exec(srv, `INSERT INTO hosted_sessions (${cols.join(", ")}) SELECT ${picked} FROM hosted_sessions WHERE session_id = ?`, ...values, from);
  };

  test("session_end naming another user's or another client's hosted session reads as not found and leaves one row each, after the hosted rollback", async () => {
    const [a, b] = await Promise.all([srv.hosted(A, "fe"), srv.hosted(B, "be")]);
    const [theirs, mine] = [await hostedId(A, a.sessionId), await hostedId(B, b.sessionId)];
    // B's session through another OAuth client: a copy of B's row under that client's ID.
    const otherClient = hostedSessionId((await srv.app.repo.users.findByEmail(srv.app.repo.read, B))!.id, "another-client", b.sessionId);
    await forgeRow(otherClient, mine, { client_id: "another-client" });
    const unknown = hostedSessionId(1, HOSTED_CLIENT, "nobody");
    for (const id of [theirs, otherClient, unknown]) {
      await expect(b.subscriber.call("session_end", { session: id })).rejects.toMatchObject({ code: "not_found" });
      expect((await srv.app.repo.hosted.get(srv.app.repo.read, id))?.session_id ?? null).toBe(id === unknown ? null : id);
    }
    const got = await accessAudits(srv, "authz.decision");
    // A missing ID isn't a policy question: no row.
    expect(got.map((r) => [r.actor, r.target, r.detail.verb, r.detail.allow, r.detail.rule, r.detail.code, r.detail.session, r.detail.client])).toEqual([
      [B, theirs, "hosted.session", false, "hosted.other_user", "not_found", mine, HOSTED_CLIENT],
      [B, otherClient, "hosted.session", false, "hosted.other_client", "not_found", mine, HOSTED_CLIENT],
    ]);
    expect(JSON.stringify(got[0].detail)).not.toContain(A);
  });

  test("a request whose own hosted row is another user's reads as not found and leaves a row per request", async () => {
    await srv.login(A);
    const b = await srv.hosted(B, "be");
    // Forged under the ID B's next session will send, owned by A.
    const forged = await hostedId(B, "forged");
    await forgeRow(forged, await hostedId(B, b.sessionId), { user_id: (await srv.app.repo.users.findByEmail(srv.app.repo.read, A))!.id });
    // Refused while the exchange selects its row, before any tool runs: the HTTP 404 it always was.
    const e = await srv.hosted(B, null, { sessionId: "forged" }).then(() => null, (x: Error) => x);
    expect(e?.message).toContain(`{"code":"not_found","message":"resource not found"}`);
    // One row per refused request: the session's native wire and its subscriber each sent one.
    const row = { actor: B, target: forged, verb: "hosted.session", allow: false, rule: "hosted.other_user" };
    // connect() rejects on the first refusal; the second request's row may land after.
    await until(async () => (await rows()).filter((r) => r.verb === "hosted.session").length === 2);
    expect((await rows()).filter((r) => r.verb === "hosted.session")).toEqual([row, row]);
  });

  test("registering a child whose hosted row is another user's reads as not found and leaves one row, after the hosted rollback", async () => {
    await srv.login(A);
    const b = await srv.hosted(B, "be");
    const mine = await hostedId(B, b.sessionId), forged = await hostedId(B, "child");
    await forgeRow(forged, mine, { user_id: (await srv.app.repo.users.findByEmail(srv.app.repo.read, A))!.id });
    await expect(b.subscriber.call("session_register", { child: "child" })).rejects.toMatchObject({ code: "not_found" });
    const got = (await accessAudits(srv, "authz.decision")).filter((r) => r.detail.verb === "hosted.session");
    expect(got.map((r) => [r.actor, r.target, r.detail.rule, r.detail.session])).toEqual([[B, forged, "hosted.other_user", mine]]);
  });

  test("a download another identity can't read reads as missing, as before, and leaves its download_refused row and one decision row; a readable one leaves none", async () => {
    const aToken = await srv.login(A);
    expect((await srv.api(aToken, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
    const [a, b, c] = await Promise.all([srv.hosted(A, "be"), srv.hosted(B, "fe"), srv.hosted(C, "sim")]);
    const up = async (name: string) => (await a.uploadRaw(name, "hello")).body.id as number;
    const [unsent, onDm, onPost] = [await up("u.txt"), await up("d.txt"), await up("p.txt")];
    await a.call("dm_send", { to: `${B}/fe`, body: "file", attachment_ids: [onDm] });
    await a.call("board_create", { name: "plans", purpose: "p", team: "eng" });
    await a.call("board_post", { board: "plans", body: "file", attachment_ids: [onPost] });
    expect((await b.attachmentRaw("GET", `/${onDm}`)).status).toBe(200);
    const unknown = 999_999;
    for (const id of [unsent, onDm, onPost, unknown]) {
      const r = await c.attachmentRaw("GET", `/${id}`);
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ code: "not_found", message: `no attachment ${id} on a message or post you can read` });
    }
    expect((await accessAudits(srv, "attachment.download_refused")).map((r) => [r.actor, r.target])).toEqual([unsent, onDm, onPost, unknown].map((id) => [C, `attachment:${id}`]));
    const got = (await accessAudits(srv, "authz.decision")).filter((r) => r.detail.verb === "attachment.read");
    expect(got.map((r) => [r.actor, r.target, r.detail.allow, r.detail.rule, r.detail.code, r.detail.identity, r.detail.address])).toEqual([
      [C, `attachment:${unsent}`, false, "attachment.uploader", "not_found", `${C}/sim`, `${C}/sim`],
      [C, `attachment:${onDm}`, false, "attachment.dm_party", "not_found", `${C}/sim`, `${C}/sim`],
      [C, `attachment:${onPost}`, false, "attachment.board_visible", "not_found", `${C}/sim`, `${C}/sim`],
      [C, `attachment:${unknown}`, false, "attachment.unknown", "not_found", `${C}/sim`, `${C}/sim`],
    ]);
  });
});
