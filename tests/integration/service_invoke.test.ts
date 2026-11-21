// Service boards and invocation, step 5 (#270 D5, D6, D4's alias.see_service): a queue board a service creates is
// the service's; posting on it is service.invoke, held by a user, a team or a service through a service_invoke
// binding, read live on every check (principle 11), recorded allow and deny (principle 8); only the service's own
// addresses are its lanes; the service's posts wake an invoker under wake.service_invoke (principle 10's grant); and to
// anyone else the board doesn't exist (principle 9: the refusal is a missing board's). The invocation is a post on a
// queue board, claimed by a lane, never a dispatch (principle 7). Each security invariant the step names has a test
// here that fails when it breaks.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { boardAccess } from "../../src/server/access.ts";
import type { DeliveryEvent } from "../../src/server/application.ts";
import { AppSession } from "../support/app_session.ts";
import { accessAudits } from "../support/audit.ts";
import { HostedSession, HostedToolError, type InboxItem } from "../support/hosted_session.ts";
import { TestServer, testSqlite } from "../support/server.ts";
import { serverAccess } from "../support/sync_access.ts";
import { row, rows as sqlRows } from "../support/repo_sql.ts";

const A = "alice@example.com", B = "bob@example.com", C = "carol@example.com", D = "dave@example.com", E = "erin@example.com", ROOT = "root@example.com";
const SVC = "ingest";
const LIMIT = { burst: 10_000, perSec: 10_000 };

let srv: TestServer;
let sessions: HostedSession[] = [];
let root: string;
let tokens: Record<string, string> = {};
beforeEach(async () => {
  srv = await TestServer.open({ admins: [ROOT, E], hostedRequestLimit: LIMIT });
  root = await srv.login(ROOT);
  tokens = {};
  for (const e of [A, B, C, D, E]) tokens[e] = await srv.login(e);
});
afterEach(async () => {
  await Promise.allSettled(sessions.splice(0).map(s => s.close()));
  await srv.stop();
});

const api = (t: string, method: string, path: string, body?: unknown) => srv.api(t, method, path, body);
const grant = async (principal: string) => {
  const r = await api(root, "POST", "/api/admin/roles/grant", { role: "service_invoke", principal, scope: SVC });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.binding.id as number;
};
const revoke = async (principal: string) => expect((await api(root, "POST", "/api/admin/roles/revoke", { role: "service_invoke", principal, scope: SVC })).status).toBe(200);

// A run token for the service, minted as a launcher does (client credentials).
async function runToken(service = SVC): Promise<string> {
  const c = await api(root, "POST", "/api/admin/services/credentials", { service });
  expect(c.status, JSON.stringify(c.body)).toBe(201);
  const r = await fetch(`${srv.base}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${btoa(`${encodeURIComponent(c.body.client_id)}:${encodeURIComponent(c.body.client_secret)}`)}` },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });
  const body = (await r.json()) as Record<string, string>;
  expect(r.status, JSON.stringify(body)).toBe(200);
  return body.access_token!;
}
let token: string | undefined;
// A service session bound to `name` in the service's scope, with a delivery lease.
async function worker(name: string): Promise<HostedSession> {
  token ??= await runToken();
  const s = new HostedSession(`${srv.base}/mcp`, token, name, { receipt: "manual" });
  sessions.push(s);
  await s.connect();
  return s;
}

// The cast: service ingest (owner alice) with worker w-1, which creates its queue board jobs; bob holds service_invoke
// directly; team qa (root's) holds it, with carol a member; dave holds nothing, nor does erin, an admin.
async function cast() {
  token = undefined;
  expect((await api(root, "POST", "/api/admin/services", { name: SVC, owners: [A] })).status).toBe(201);
  const w1 = await worker("w-1");
  await w1.call("board_create", { name: "jobs", purpose: "work for the service", kind: "queue" });
  expect((await api(root, "POST", "/api/teams", { name: "qa" })).status).toBe(201);
  expect((await api(root, "POST", "/api/teams/qa/add", { email: C })).status).toBe(200);
  const bob = await grant(B), qa = await grant("qa");
  return { w1, bindings: { bob, qa } };
}

const scopeOf = async (board: string) => (await row(srv, "SELECT scope FROM boards WHERE name = ?", board) as { scope: string | null } | null)?.scope;
const holderOf = async (board: string, id: number) => (await row(srv, "SELECT holder FROM claims WHERE key = ?", `queue:${board}:${id}`) as { holder: string } | null)?.holder;
const invokes = async () => (await accessAudits(srv, "authz.decision")).filter(r => r.detail.verb === "service.invoke");
const push = (body: string) => (e: DeliveryEvent) => e.kind === "board" && e.item.kind === "push" && e.item.post.body === body;
const post = (s: HostedSession, board: string, body: string, extra: Record<string, unknown> = {}) => s.call<{ post_id: number; notified: string[]; unresolved?: string[] }>("board_post", { board, body, ...extra });
const refusal = async (p: Promise<unknown>): Promise<HostedToolError> => {
  const e = await p.then((v) => new Error(`not refused: ${JSON.stringify(v)}`), (x: unknown) => x);
  if (!(e instanceof HostedToolError)) throw e;
  return e as HostedToolError;
};
// A refusal's text with the board's name taken out: a hidden board's and a missing one's must be the same.
const unnamed = (e: Error, board: string) => e.message.replaceAll(`#${board}`, "#BOARD");
async function missingBoardRefusal(s: HostedSession, tool = "board_post"): Promise<string> {
  const args = tool === "board_post" ? { board: "no-such-thing", body: "x" } : tool === "claim_take" ? { key: "ticket:NONE-1", board: "no-such-thing" } : { board: "no-such-thing" };
  return unnamed(await refusal(s.call(tool, args)), "no-such-thing");
}

describe("D5: a service's board is a queue board in the service's scope", () => {
  test("a service's queue board is service-scoped; its broadcast board, and every user's board, stay org-open", async () => {
    const { w1 } = await cast();
    expect(await scopeOf("jobs")).toBe(`service:${SVC}`);
    await w1.call("board_create", { name: "news", purpose: "announcements" });
    expect(await scopeOf("news")).toBeNull();
    const bob = await srv.hosted(B, "fe");
    sessions.push(bob);
    await bob.call("board_create", { name: "bobq", purpose: "bob's queue", kind: "queue" });
    expect(await scopeOf("bobq")).toBeNull();
  });

  test("no one but the service creates in its scope: a user, the owner, another service, a team name", async () => {
    await cast();
    const read = srv.app.repo.read;
    const access = boardAccess(srv.app.repo);
    for (const handle of [`${B}/fe`, `${A}/fe`, "qa/bot", "other/w-1", `${C}/fe`]) {
      expect(await access.checkCreate(read, handle, `service:${SVC}`)).toBe(`invalid board scope "service:${SVC}"`);
    }
    // A scope naming no service is refused the same way.
    expect(await access.checkCreate(read, `${B}/fe`, "service:nope")).toBe('invalid board scope "service:nope"');
    // The service itself may; and not in another's.
    expect(await access.checkCreate(read, `${SVC}/w-1`, `service:${SVC}`)).toBeNull();
    expect(await access.checkCreate(read, `${SVC}/w-1`, "service:other")).toBe('invalid board scope "service:other"');
    // Through the tool, a user's only route is the team argument, which names a team.
    const bob = await srv.hosted(B, "fe");
    sessions.push(bob);
    await refusal(bob.call("board_create", { name: "sneak", purpose: "x", kind: "queue", team: `service:${SVC}` }));
    expect(await scopeOf("sneak")).toBeUndefined();
  });

  // The sync_access oracle reads the SQLite handle: its half of the check above.
  testSqlite("the sync_access oracle agrees: no one but the service creates in its scope", async () => {
    await cast();
    const core = serverAccess(srv.app.repo, srv.app.db);
    for (const handle of [`${B}/fe`, `${A}/fe`, "qa/bot", "other/w-1", `${C}/fe`]) {
      expect(core.checkCreate!(handle, `service:${SVC}`)).toBe(`invalid board scope "service:${SVC}"`);
    }
    expect(core.checkCreate!(`${SVC}/w-1`, `service:${SVC}`)).toBeNull();
  });
});

describe("Tests item 4: the pilot gate", () => {
  test("a holder's post reaches exactly one service lane, actionable, allowed by its binding; the service's reply wakes the holder", async () => {
    const { w1, bindings } = await cast();
    const bob = await srv.hosted(B, "fe");
    sessions.push(bob);
    const p = await post(bob, "jobs", "job 1");
    expect(await holderOf("jobs", p.post_id)).toBe(`${SVC}/w-1`);
    const item = await w1.next(push("job 1"));
    expect(item.actionable).toBe(true);
    expect(item.event).toMatchObject({ item: { post: { other_user: true } } });
    expect((item.event as { item: { post: { ungranted?: true } } }).item.post.ungranted).toBeUndefined();
    expect(await invokes()).toEqual([expect.objectContaining({ actor: B, target: `service:${SVC}`, detail: expect.objectContaining({
      address: `${B}/fe`, allow: true, rule: "role.service_invoke", binding: bindings.bob, role: "service_invoke", scope: SVC, principal: B, principal_kind: "user", board: "jobs", post_id: p.post_id,
    }) })]);
    // The reply acks it and wakes bob, granted.
    await post(w1, "jobs", "done 1", { parent_id: p.post_id });
    expect(await holderOf("jobs", p.post_id)).toBeUndefined();
    const reply = await bob.next(push("done 1"));
    expect(reply.actionable).toBe(true);
    expect(reply.event).toMatchObject({ item: { post: { other_user: true } } });
    expect((reply.event as { item: { post: { ungranted?: true } } }).item.post.ungranted).toBeUndefined();
    // The service's own post is service.own, recorded.
    expect((await invokes()).at(-1)).toMatchObject({ actor: SVC, detail: { address: `${SVC}/w-1`, allow: true, rule: "service.own" } });
  });

  test("a team member invokes through the team's binding, recorded with the team; removed from the team, refused", async () => {
    const { w1, bindings } = await cast();
    const carol = await srv.hosted(C, "fe");
    sessions.push(carol);
    const p = await post(carol, "jobs", "carol's job");
    expect(await holderOf("jobs", p.post_id)).toBe(`${SVC}/w-1`);
    expect((await invokes()).at(-1)).toMatchObject({ actor: C, detail: { address: `${C}/fe`, allow: true, rule: "role.service_invoke", binding: bindings.qa, team: "qa", principal: C } });
    await w1.next(push("carol's job"));
    await post(w1, "jobs", "carol's done", { parent_id: p.post_id });
    expect((await carol.next(push("carol's done"))).actionable).toBe(true);
    expect((await api(root, "POST", "/api/teams/qa/remove", { email: C })).status).toBe(200);
    const missing = await missingBoardRefusal(carol);
    expect(unnamed(await refusal(post(carol, "jobs", "after removal")), "jobs")).toBe(missing);
    expect((await invokes()).at(-1)).toMatchObject({ actor: C, detail: { address: `${C}/fe`, allow: false, rule: "role.service_invoke", code: "not_found", principal: C } });
  });

  test("a session bound to a team's name acts as the team: refused until the team holds the grant", async () => {
    await cast();
    // bob holds the grant himself; eng, his team, doesn't.
    expect((await api(tokens[B]!, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
    const build = await srv.hosted(B, "eng/build");
    sessions.push(build);
    const missing = await missingBoardRefusal(build);
    expect(unnamed(await refusal(post(build, "jobs", "as eng")), "jobs")).toBe(missing);
    // No address of the session sees the board (its ID is judged as eng there too), so the post is eng/build's.
    expect((await invokes()).at(-1)).toMatchObject({ actor: B, detail: { address: "eng/build", allow: false, rule: "role.service_invoke", principal: "eng", principal_kind: "team" } });
    const eng = await grant("eng");
    await post(build, "jobs", "as eng, granted");
    expect((await invokes()).at(-1)).toMatchObject({ actor: B, detail: { allow: true, rule: "role.service_invoke", binding: eng, principal: "eng", principal_kind: "team" } });
  });

  test("a non-holder (the service's owner, an admin, a stranger) is refused as a missing board, with a deny row", async () => {
    await cast();
    for (const email of [A, E, D]) {
      const s = await srv.hosted(email, "fe");
      sessions.push(s);
      const missing = await refusal(post(s, "no-such-thing", "x"));
      const before = (await invokes()).length;
      const e = await refusal(post(s, "jobs", "let me in"));
      expect(unnamed(e, "jobs")).toBe(unnamed(missing, "no-such-thing"));
      expect(e.code).toBe(missing.code);
      expect((await invokes()).slice(before)).toEqual([expect.objectContaining({ actor: email, target: `service:${SVC}`, detail: expect.objectContaining({
        address: `${email}/fe`, allow: false, rule: "role.service_invoke", code: "not_found", principal: email, board: "jobs",
      }) })]);
      // claim_take on the board is decided the same way.
      const c = await refusal(s.call("claim_take", { key: "ticket:ENG-1", board: "jobs" }));
      expect(unnamed(c, "jobs")).toBe(unnamed(await refusal(s.call("claim_take", { key: "ticket:ENG-1", board: "no-such-thing" })), "no-such-thing"));
      expect((await invokes()).at(-1)).toMatchObject({ detail: { allow: false, rule: "role.service_invoke" } });
    }
    expect(await row(srv, "SELECT count(*) AS n FROM posts WHERE board = 'jobs'")).toEqual({ n: 0 });
  });

  // service.own is the service's own board alone (#1402): another service, holding no binding, is refused it as a
  // missing board, the same as a user is; its own board's post is still service.own.
  test("another service is refused the service's board as a missing one; its own board stays service.own", async () => {
    await cast();
    expect((await api(root, "POST", "/api/admin/services", { name: "other", owners: [A] })).status).toBe(201);
    const o = new HostedSession(`${srv.base}/mcp`, await runToken("other"), "w-1", { receipt: "manual" });
    sessions.push(o);
    await o.connect();
    await o.call("board_create", { name: "other-jobs", purpose: "other's work", kind: "queue" });
    expect(await scopeOf("other-jobs")).toBe("service:other");
    const missing = await refusal(post(o, "no-such-thing", "x"));
    const before = (await invokes()).length;
    const e = await refusal(post(o, "jobs", "let me in"));
    expect(unnamed(e, "jobs")).toBe(unnamed(missing, "no-such-thing"));
    expect(e.code).toBe(missing.code);
    expect((await invokes()).slice(before)).toEqual([expect.objectContaining({ actor: "other", target: `service:${SVC}`, detail: expect.objectContaining({
      address: "other/w-1", allow: false, rule: "role.service_invoke", code: "not_found", principal: "other", board: "jobs",
    }) })]);
    expect(unnamed(await refusal(o.call("board_read", { board: "jobs" })), "jobs")).toBe(await missingBoardRefusal(o, "board_read"));
    const listed = await o.call<{ name: string }[] | { boards: { name: string }[] }>("board_list", {});
    expect((Array.isArray(listed) ? listed : listed.boards).map(b => b.name)).not.toContain("jobs");
    expect(await row(srv, "SELECT count(*) AS n FROM posts WHERE board = 'jobs'")).toEqual({ n: 0 });
    await post(o, "other-jobs", "mine");
    expect((await invokes()).at(-1)).toMatchObject({ actor: "other", detail: { address: "other/w-1", allow: true, rule: "service.own", board: "other-jobs" } });
  });

  test("a holder's push subscription is never a lane: not in rotation, not on a decline, not by an @mention", async () => {
    const { w1 } = await cast();
    const w2 = await worker("w-2");
    await w2.call("board_subscribe", { board: "jobs", mode: "push" });
    const bob = await srv.hosted(B, "fe");
    sessions.push(bob);
    await bob.call("board_subscribe", { board: "jobs", mode: "push" });
    expect(await sqlRows(srv, "SELECT handle FROM subscriptions WHERE board = 'jobs' ORDER BY handle")).toEqual([{ handle: `${B}/fe` }, { handle: `${SVC}/w-1` }, { handle: `${SVC}/w-2` }]);
    const carol = await srv.hosted(C, "fe");
    sessions.push(carol);
    const lanes = new Set([`${SVC}/w-1`, `${SVC}/w-2`]);
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) {
      const p = await post(carol, "jobs", `job ${i}`);
      expect(lanes.has((await holderOf("jobs", p.post_id))!), `job ${i} went to ${(await holderOf("jobs", p.post_id))}`).toBe(true);
      ids.push(p.post_id);
    }
    // Each decline hands the item to the other service lane, never bob.
    for (const id of ids) {
      const holder = await holderOf("jobs", id)!;
      const s = holder === `${SVC}/w-1` ? w1 : w2;
      await s.call("claim_release", { key: `queue:jobs:${id}` });
      const next = await holderOf("jobs", id);
      expect(next === undefined || lanes.has(next), `declined job ${id} went to ${next}`).toBe(true);
    }
    // An invoker's post that @mentions the holder tells it, but doesn't hand it the work, nor hold it back from a
    // lane (#1256).
    const named = await post(carol, "jobs", `@${B}/fe please look`);
    expect(lanes.has((await holderOf("jobs", named.post_id))!), `named job went to ${(await holderOf("jobs", named.post_id))}`).toBe(true);
    expect(named.notified).toContain(`${B}/fe`);
    // A lane's own top-level notice to an invoker answers, it isn't new work: no sibling lane holds it.
    const notice = await post(w1, "jobs", `@${B}/fe your job is done`);
    expect(notice.notified).toEqual([`${B}/fe`]);
    expect(await holderOf("jobs", notice.post_id)).toBeUndefined();
    // Nor is a claim's system notice cc'ing a watcher (non-strict): only an author's own words rotate past a name.
    await carol.call("claim_take", { key: "ticket:ENG-7", board: "jobs" });
    await bob.call("claim_watch", { key: "ticket:ENG-7" });
    const before = (await row(srv, "SELECT max(id) AS m FROM posts") as { m: number }).m;
    await carol.call("claim_release", { key: "ticket:ENG-7" });
    const ccs = await sqlRows(srv, "SELECT id FROM posts WHERE board = 'jobs' AND id > ? AND body LIKE ?", before, `%@${B}/fe%`) as { id: number }[];
    expect(ccs.length).toBe(1);
    expect(await holderOf("jobs", ccs[0]!.id)).toBeUndefined();
    // A post naming a lane among others is direct addressing: no rotation, and no claim (several names); one lane
    // named alone holds it.
    const direct = await post(carol, "jobs", `@${SVC}/w-2 @${B}/fe this one is yours`);
    expect(await holderOf("jobs", direct.post_id)).toBeUndefined();
    const solo = await post(carol, "jobs", `@${SVC}/w-2 this one is yours`);
    expect(await holderOf("jobs", solo.post_id)).toBe(`${SVC}/w-2`);
    for (const id of [...ids, named.post_id]) expect(await holderOf("jobs", id)).not.toBe(`${B}/fe`);
  });

  test("a revoked binding or a removed membership turns the queued item ungranted for the service, and ends the right", async () => {
    const { w1 } = await cast();
    const bob = await srv.hosted(B, "fe");
    const carol = await srv.hosted(C, "fe");
    sessions.push(bob, carol);
    await post(bob, "jobs", "bob's queued job");
    await post(carol, "jobs", "carol's queued job");
    await revoke(B);
    expect((await api(root, "POST", "/api/teams/qa/remove", { email: C })).status).toBe(200);
    for (const body of ["bob's queued job", "carol's queued job"]) {
      const item: InboxItem = await w1.next(push(body));
      expect(item.actionable, body).toBe(false);
      expect(item.event).toMatchObject({ item: { post: { other_user: true, ungranted: true } } });
    }
    // The next check refuses both.
    for (const s of [bob, carol]) expect(unnamed(await refusal(post(s, "jobs", "again")), "jobs")).toBe(await missingBoardRefusal(s));
  });
});

describe("a non-holder can't learn a service's board exists", () => {
  test("board_list, board_read, a snapshot and the catalog show it to holders only", async () => {
    await cast();
    const bob = await srv.hosted(B, "fe"), dave = await srv.hosted(D, "fe"), alice = await srv.hosted(A, "fe");
    sessions.push(bob, dave, alice);
    const names = async (s: HostedSession) => (await s.call<{ name: string }[] | { boards: { name: string }[] }>("board_list", {}));
    const listed = async (s: HostedSession) => { const r = await names(s); return (Array.isArray(r) ? r : r.boards).map(b => b.name); };
    expect(await listed(bob)).toContain("jobs");
    for (const s of [dave, alice]) {
      expect(await listed(s)).not.toContain("jobs");
      expect(unnamed(await refusal(s.call("board_read", { board: "jobs" })), "jobs")).toBe(await missingBoardRefusal(s, "board_read"));
    }
    expect(await bob.call("board_read", { board: "jobs" })).toBeDefined();
    const app = srv.app.application, read = srv.app.repo.read;
    for (const email of [D, A]) {
      const s = (await srv.connected(tokens[email]!, "ops")).session;
      expect((await app.boardCatalog(read, s)).boards.map(b => b.name)).not.toContain("jobs");
      const hidden = await app.boardSnapshot(read, s, "jobs").then(() => undefined, (e: Error) => e);
      const missing = await app.boardSnapshot(read, s, "no-such-thing").then(() => undefined, (e: Error) => e);
      expect(hidden).toBeInstanceOf(Error);
      expect(unnamed(hidden!, "jobs")).toBe(unnamed(missing!, "no-such-thing"));
    }
    const holder = (await srv.connected(tokens[B]!, "ops")).session;
    expect((await app.boardCatalog(read, holder)).boards.map(b => b.name)).toContain("jobs");
    expect((await app.boardSnapshot(read, holder, "jobs")).posts).toEqual([]);
  });

  test("the service's names don't resolve as mentions or list as peers to a non-holder", async () => {
    await cast();
    const bob = await srv.hosted(B, "fe"), dave = await srv.hosted(D, "fe");
    sessions.push(bob, dave);
    await bob.call("board_create", { name: "lobby", purpose: "everyone" });
    expect((await post(dave, "lobby", `@${SVC}/w-1 hello`)).unresolved).toEqual([`${SVC}/w-1`]);
    expect((await post(bob, "lobby", `@${SVC}/w-1 hello`)).unresolved).toBeUndefined();
    const peers = async (s: HostedSession) => JSON.stringify(await s.call("peer_list", { include_offline: true }));
    expect(await peers(dave)).not.toContain(`${SVC}/w-1`);
    expect(await peers(bob)).toContain(`${SVC}/w-1`);
    // With the board named: the hidden board's roster refuses as a missing board's.
    expect(unnamed(await refusal(dave.call("peer_list", { board: "jobs" })), "jobs")).toBe(unnamed(await refusal(dave.call("peer_list", { board: "no-such-thing" })), "no-such-thing"));
  });
});

// The ID a session bound to `address` acts through, as its alias hold names it.
const idHolding = async (address: string) => (await row(srv, "SELECT id FROM alias_holds WHERE address = ?", address) as { id: string }).id;
// A refusal's text with `key` taken out: a hidden queue post's claim and a missing key must answer alike.
const unkeyed = (e: Error, key: string) => e.message.replaceAll(key, "KEY");

describe("a queue post's claim on a hidden board is no claim at all (audit F1)", () => {
  test("claim_list leaves it out; claim_watch and claim_release answer it as a missing key, on a service's board and a team's", async () => {
    await cast();
    const bob = await srv.hosted(B, "fe"), dave = await srv.hosted(D, "fe"), carol = await srv.hosted(C, "fe");
    sessions.push(bob, dave, carol);
    const p = await post(bob, "jobs", "job for the service");
    const key = `queue:jobs:${p.post_id}`;
    expect(await holderOf("jobs", p.post_id)).toBe(`${SVC}/w-1`);
    // A team queue board: qa's (carol), its lane root's session; dave is in neither.
    const rootS = await srv.hosted(ROOT, "fe");
    sessions.push(rootS);
    await carol.call("board_create", { name: "qaq", purpose: "qa's work", kind: "queue", team: "qa" });
    await rootS.call("board_subscribe", { board: "qaq", mode: "push" });
    const q = await post(carol, "qaq", "job for qa");
    const teamKey = `queue:qaq:${q.post_id}`;
    expect(await holderOf("qaq", q.post_id)).toBe(`${ROOT}/fe`);
    const keys = async (s: HostedSession) => (await s.call<{ key: string }[]>("claim_list", {})).map((c) => c.key);
    expect(await keys(bob)).toContain(key);
    expect(await keys(carol)).toContain(teamKey);
    const daves = await keys(dave);
    expect(daves.filter((k) => k.startsWith("queue:"))).toEqual([]);
    expect(await dave.call("claim_list", { prefix: "queue:jobs" })).toEqual([]);
    for (const k of [key, teamKey]) {
      const missing = `queue:nope:${k.split(":")[2]}`;
      for (const tool of ["claim_watch", "claim_release"]) {
        const hidden = await refusal(dave.call(tool, { key: k }));
        const none = await refusal(dave.call(tool, { key: missing }));
        expect(unkeyed(hidden, k), `${tool} ${k}`).toBe(unkeyed(none, missing));
        expect(hidden.code).toBe(none.code);
        // The HTTP route answers alike.
        const h = await api(tokens[D]!, "POST", "/api/claims/call", { as: `${D}/fe`, tool, args: { key: k } });
        const n = await api(tokens[D]!, "POST", "/api/claims/call", { as: `${D}/fe`, tool, args: { key: missing } });
        expect(h.status).toBe(n.status);
        expect(JSON.stringify(h.body).replaceAll(k, "KEY")).toBe(JSON.stringify(n.body).replaceAll(missing, "KEY"));
      }
    }
    // Nothing moved: the claims stand with their lanes, and dave watches nothing.
    expect(await holderOf("jobs", p.post_id)).toBe(`${SVC}/w-1`);
    expect(await holderOf("qaq", q.post_id)).toBe(`${ROOT}/fe`);
    expect(await row(srv, "SELECT count(*) AS n FROM claim_watches")).toEqual({ n: 0 });
  });

  test("a claim announced on a hidden board shows no board or note to an outsider: claim_list, the held take, HTTP (#1257)", async () => {
    await cast();
    const dave = await srv.hosted(D, "fe"), carol = await srv.hosted(C, "fe");
    sessions.push(dave, carol);
    await carol.call("board_create", { name: "qa-room", purpose: "qa only", team: "qa" });
    await carol.call("claim_take", { key: "ticket:QA-1", board: "qa-room", note: "the secret plan" });
    type Row = { key: string; holder: string | null; board: string | null; note: string | null };
    const row = async (s: HostedSession) => (await s.call<Row[]>("claim_list", { prefix: "ticket:QA-1" }))[0];
    expect(await row(carol)).toMatchObject({ holder: `${C}/fe`, board: "qa-room", note: "the secret plan" });
    expect(await row(dave)).toMatchObject({ key: "ticket:QA-1", holder: `${C}/fe`, board: null, note: null });
    expect(await dave.call("claim_take", { key: "ticket:QA-1" })).toMatchObject({ ok: false, held_by: `${C}/fe`, note: null });
    const h = await api(tokens[D]!, "GET", "/api/claims?prefix=ticket:QA-1");
    expect(JSON.stringify(h.body)).not.toContain("secret plan");
    expect(JSON.stringify(h.body)).toContain("ticket:QA-1");
    const t = await api(tokens[D]!, "POST", "/api/claims/call", { as: `${D}/fe`, tool: "claim_take", args: { key: "ticket:QA-1" } });
    expect(JSON.stringify(t.body)).not.toContain("secret plan");
  });
});

describe("a session bound to a team's name sees a service's board only by the team's binding (audit F2)", () => {
  test("its ID can't list, read or subscribe to the board its user holds directly; with the team's grant it can", async () => {
    await cast();
    expect((await api(tokens[B]!, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
    const build = await srv.hosted(B, "eng/build");
    sessions.push(build);
    const id = await idHolding("eng/build");
    const listed = async () => (await build.call<{ name: string }[]>("board_list", {})).map((b) => b.name);
    expect(await listed()).not.toContain("jobs");
    expect(unnamed(await refusal(build.call("board_read", { board: "jobs" })), "jobs")).toBe(await missingBoardRefusal(build, "board_read"));
    const sub = await refusal(build.call("board_subscribe", { board: "jobs", mode: "push", as: id }));
    expect(unnamed(sub, "jobs")).toBe(unnamed(await refusal(build.call("board_subscribe", { board: "no-such-thing", mode: "push", as: id })), "no-such-thing"));
    expect(await row(srv, "SELECT count(*) AS n FROM subscriptions WHERE board = 'jobs' AND handle = ?", id)).toEqual({ n: 0 });
    // Nor its names: peer_list (judged for the session's ID) and a DM read them as missing.
    const peers = async () => JSON.stringify(await build.call("peer_list", { include_offline: true }));
    expect(await peers()).not.toContain(`${SVC}/w-1`);
    const dm = (to: string) => refusal(build.call("dm_send", { to, body: "hi" }));
    expect((await dm(`${SVC}/w-1`)).message.replaceAll(`${SVC}/w-1`, "NAME")).toBe((await dm(`${SVC}/w-404`)).message.replaceAll(`${SVC}/w-404`, "NAME"));
    // The access rule itself: the ID is judged as eng on the service's board, as its user everywhere else.
    const access = boardAccess(srv.app.repo), read = srv.app.repo.read;
    const jobs = (await srv.app.repo.boards.get(read, "jobs"))!;
    expect(await access.canSee(read, id, jobs)).toBe(false);
    expect([...(await access.visibleTo(read, id, [jobs]))]).toEqual([]);
    await grant("eng");
    expect(await access.canSee(read, id, jobs)).toBe(true);
    expect(await peers()).toContain(`${SVC}/w-1`);
    expect(await listed()).toContain("jobs");
    expect(await build.call("board_read", { board: "jobs" })).toBeDefined();
  });
});

describe("claim_take on a service's board is an invocation, on every route (audit F3)", () => {
  test("a holder's claim_take records exactly one allow; a non-holder's exactly one deny; over MCP and HTTP", async () => {
    const { bindings } = await cast();
    const bob = await srv.hosted(B, "fe"), dave = await srv.hosted(D, "fe");
    sessions.push(bob, dave);
    const routes = {
      mcp: (s: HostedSession, _t: string, args: Record<string, unknown>) => s.call("claim_take", args).then(() => 200, (e: unknown) => { if (e instanceof HostedToolError) return 400; throw e; }),
      http: async (_s: HostedSession, t: string, args: Record<string, unknown>, as: string) => (await api(t, "POST", "/api/claims/call", { as, tool: "claim_take", args })).status,
    };
    for (const [route, take] of Object.entries(routes)) {
      let before = (await invokes()).length;
      expect(await take(bob, tokens[B]!, { key: `ticket:ENG-${route}`, board: "jobs" }, `${B}/fe`), route).toBe(200);
      expect((await invokes()).slice(before), route).toEqual([expect.objectContaining({ actor: B, detail: expect.objectContaining({
        address: `${B}/fe`, allow: true, rule: "role.service_invoke", binding: bindings.bob, principal: B, board: "jobs",
      }) })]);
      before = (await invokes()).length;
      expect(await take(dave, tokens[D]!, { key: `ticket:DAVE-${route}`, board: "jobs" }, `${D}/fe`), route).toBe(400);
      expect((await invokes()).slice(before), route).toEqual([expect.objectContaining({ actor: D, detail: expect.objectContaining({
        address: `${D}/fe`, allow: false, rule: "role.service_invoke", code: "not_found", principal: D, board: "jobs",
      }) })]);
    }
    expect(await sqlRows(srv, "SELECT key FROM claims WHERE key LIKE 'ticket:%' ORDER BY key")).toEqual([{ key: "ticket:ENG-http" }, { key: "ticket:ENG-mcp" }]);
  });

  test("claim_take as the ID of a session bound to a team's name is judged as the team, over MCP and HTTP", async () => {
    await cast();
    expect((await api(tokens[B]!, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
    const build = await srv.hosted(B, "eng/build");
    sessions.push(build);
    const id = await idHolding("eng/build");
    const viaMcp = (key: string) => build.call("claim_take", { key, board: "jobs", as: id });
    const viaHttp = (key: string) => api(tokens[B]!, "POST", "/api/claims/call", { as: id, tool: "claim_take", args: { key, board: "jobs" } });
    let before = (await invokes()).length;
    expect(unnamed(await refusal(viaMcp("ticket:ENG-1")), "jobs")).toBe(await missingBoardRefusal(build, "claim_take"));
    const h = await viaHttp("ticket:ENG-2");
    expect(h.status).toBe(400);
    expect((await invokes()).slice(before)).toEqual([0, 1].map(() => expect.objectContaining({ actor: B, detail: expect.objectContaining({
      address: id, allow: false, rule: "role.service_invoke", principal: "eng", principal_kind: "team", board: "jobs",
    }) })));
    const eng = await grant("eng");
    before = (await invokes()).length;
    await viaMcp("ticket:ENG-3");
    expect((await viaHttp("ticket:ENG-4")).status).toBe(200);
    expect((await invokes()).slice(before)).toEqual([0, 1].map(() => expect.objectContaining({ actor: B, detail: expect.objectContaining({
      address: id, allow: true, binding: eng, principal: "eng", principal_kind: "team",
    }) })));
  });
});

describe("a claim's renewal and release announced on a service's board are invocations (#1259)", () => {
  test("each announcement records one allow for the address it posts as; a quiet renewal none; a revoked holder releases unannounced", async () => {
    const { bindings } = await cast();
    const bob = await srv.hosted(B, "fe");
    sessions.push(bob);
    const routes = {
      mcp: (tool: string, args: Record<string, unknown>) => bob.call(tool, args).then(() => 200),
      http: async (tool: string, args: Record<string, unknown>) => (await api(tokens[B]!, "POST", "/api/claims/call", { as: `${B}/fe`, tool, args })).status,
    };
    const allow = expect.objectContaining({ actor: B, detail: expect.objectContaining({
      address: `${B}/fe`, allow: true, rule: "role.service_invoke", binding: bindings.bob, principal: B, board: "jobs",
    }) });
    const posts = async () => (await row(srv, "SELECT count(*) AS n FROM posts WHERE board = 'jobs'") as { n: number }).n;
    for (const [route, call] of Object.entries(routes)) {
      const key = `ticket:ENG-${route}`;
      expect(await call("claim_take", { key, board: "jobs", note: "start" }), route).toBe(200);
      let before = (await invokes()).length, n = await posts();
      // A renewal with a new note and no board announces on the claim's board.
      expect(await call("claim_take", { key, note: "halfway" }), route).toBe(200);
      expect(await posts(), route).toBe(n + 1);
      expect((await invokes()).slice(before), route).toEqual([allow]);
      // The same note again announces nothing, so records nothing.
      before = (await invokes()).length;
      expect(await call("claim_take", { key, note: "halfway" }), route).toBe(200);
      expect((await invokes()).slice(before), route).toEqual([]);
      // Nor does the same note naming the board: the take decides, but posts nothing to record.
      expect(await call("claim_take", { key, board: "jobs", note: "halfway" }), route).toBe(200);
      expect((await invokes()).slice(before), route).toEqual([]);
      // A renewal naming the board is the claim_take's own invocation: one row, not two.
      expect(await call("claim_take", { key, board: "jobs", note: "nearly" }), route).toBe(200);
      expect((await invokes()).slice(before), route).toEqual([allow]);
      before = (await invokes()).length, n = await posts();
      expect(await call("claim_release", { key, note: "done" }), route).toBe(200);
      expect(await posts(), route).toBe(n + 1);
      expect((await invokes()).slice(before), route).toEqual([allow]);
    }
    // Revoked, the holder can still let go of its claim: the release stands, its announcement and its row don't.
    await bob.call("claim_take", { key: "ticket:ENG-late", board: "jobs" });
    await revoke(B);
    const before = (await invokes()).length, n = await posts();
    await bob.call("claim_release", { key: "ticket:ENG-late", note: "done" });
    expect(await posts()).toBe(n);
    expect((await invokes()).slice(before)).toEqual([]);
    expect(await row(srv, "SELECT key FROM claims WHERE key = 'ticket:ENG-late'")).toBeNull();
  });
  test("a renewal naming the board through another address records the holder's grant, the one its post exercised (audit M1)", async () => {
    const { bindings } = await cast();
    expect((await api(tokens[B]!, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
    const eng = await grant("eng");
    const bob = await srv.hosted(B, "fe");
    sessions.push(bob);
    await bob.call("bind", { name: "eng/build", create: true });
    const author = async (id: number) => (await row(srv, "SELECT author FROM posts WHERE id = ?", id) as { author: string }).author;
    const last = async () => (await row(srv, "SELECT max(id) AS id FROM posts WHERE board = 'jobs'") as { id: number }).id;
    const routes = {
      mcp: (args: Record<string, unknown>, as: string) => bob.call("claim_take", { ...args, as }).then(() => 200),
      http: async (args: Record<string, unknown>, as: string) => (await api(tokens[B]!, "POST", "/api/claims/call", { as, tool: "claim_take", args })).status,
    };
    for (const [route, take] of Object.entries(routes)) {
      const key = `ticket:M1-${route}`;
      expect(await take({ key, board: "jobs" }, "eng/build"), route).toBe(200);
      const before = (await invokes()).length;
      // Held by eng/build, renewed by bob's own name: the [update] posts as eng/build, on eng's grant.
      expect(await take({ key, board: "jobs", note: "moved" }, `${B}/fe`), route).toBe(200);
      expect(await author(await last()), route).toBe("eng/build");
      expect((await invokes()).slice(before), route).toEqual([expect.objectContaining({ actor: B, detail: expect.objectContaining({
        address: "eng/build", allow: true, binding: eng, principal: "eng", board: "jobs",
      }) })]);
      expect(eng, route).not.toBe(bindings.bob);
    }
  });
  test("a renewal can't move a claim onto the service's board when its holder lacks service_invoke, though the caller has it (#1269)", async () => {
    await cast();
    expect((await api(tokens[B]!, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
    const bob = await srv.hosted(B, "fe");
    sessions.push(bob);
    await bob.call("bind", { name: "eng/build", create: true });
    const claimRow = async (key: string) => await row(srv, "SELECT holder, board, note FROM claims WHERE key = ?", key);
    const routes = {
      mcp: (args: Record<string, unknown>, as: string) => bob.call("claim_take", { ...args, as }).then(() => "ok", async (e: unknown) => {
        if (e instanceof HostedToolError) return e.message;
        throw e;
      }),
      http: async (args: Record<string, unknown>, as: string) => {
        const r = await api(tokens[B]!, "POST", "/api/claims/call", { as, tool: "claim_take", args });
        return r.status === 200 ? "ok" : JSON.stringify(r.body);
      },
    };
    for (const [route, take] of Object.entries(routes)) {
      const key = `ticket:MOVE-${route}`;
      // eng holds no grant on the service, so eng/build can't see #jobs; bob's own name can.
      expect(await take({ key, note: "start" }, "eng/build"), route).toBe("ok");
      const before = (await invokes()).length;
      expect(await take({ key, board: "jobs", note: "moved" }, `${B}/fe`), route).toContain("eng/build, which holds " + key + ", can't see #jobs");
      expect(await claimRow(key), route).toEqual({ holder: "eng/build", board: null, note: "start" });
      // The refused move rolls back with its savepoint and records nothing.
      expect((await invokes()).length, route).toBe(before);
      }
    });
  test("each announcement's invocation row names the post that exercised the grant, as board_post's does (#1261)", async () => {
    await cast();
    const bob = await srv.hosted(B, "fe");
    sessions.push(bob);
    const body = async (id: unknown) => (await row(srv, "SELECT body FROM posts WHERE id = ?", id as number) as { body: string } | null)?.body;
    const routes = {
      mcp: (tool: string, args: Record<string, unknown>) => bob.call(tool, args).then(() => 200),
      http: async (tool: string, args: Record<string, unknown>) => (await api(tokens[B]!, "POST", "/api/claims/call", { as: `${B}/fe`, tool, args })).status,
    };
    for (const [route, call] of Object.entries(routes)) {
      const key = `ticket:POST-${route}`;
      const steps: [string, Record<string, unknown>, string][] = [
        ["claim_take", { key, board: "jobs", note: "start" }, `[claim] ${key}`],
        ["claim_take", { key, note: "halfway" }, `[update] ${key}`],
        ["claim_release", { key, note: "done" }, `[release] ${key}`],
      ];
      for (const [tool, args, prefix] of steps) {
        const before = (await invokes()).length;
        expect(await call(tool, args), `${route} ${prefix}`).toBe(200);
        const rows = (await invokes()).slice(before);
        expect(rows, `${route} ${prefix}`).toHaveLength(1);
        expect(await body(rows[0]!.detail.post_id), `${route} ${prefix}`).toStartWith(prefix);
      }
    }
  });
});

describe("an ID is judged as its session's primary alike on every route (audit F5)", () => {
  test("a tools-only session writing as a team's name: its ID invokes as the team over HTTP and MCP", async () => {
    await cast();
    expect((await api(tokens[B]!, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
    // Tools-only: it holds nothing and writes as eng/tool, so its primary is that name, not a hold.
    const tool = await srv.connected(tokens[B]!, "eng/tool", { push: false });
    expect(await row(srv, "SELECT count(*) AS n FROM alias_holds WHERE id = ?", tool.id)).toEqual({ n: 0 });
    let before = (await invokes()).length;
    const h = await api(tokens[B]!, "POST", "/api/claims/call", { as: tool.id, tool: "claim_take", args: { key: "ticket:TOOL-1", board: "jobs" } });
    expect(h.status).toBe(400);
    expect((await invokes()).slice(before)).toEqual([expect.objectContaining({ actor: B, detail: expect.objectContaining({ address: tool.id, allow: false, principal: "eng", principal_kind: "team" }) })]);
    const eng = await grant("eng");
    before = (await invokes()).length;
    expect((await api(tokens[B]!, "POST", "/api/claims/call", { as: tool.id, tool: "claim_take", args: { key: "ticket:TOOL-2", board: "jobs" } })).status).toBe(200);
    await tool.call("claim_take", { key: "ticket:TOOL-3", board: "jobs" });
    expect((await invokes()).slice(before)).toEqual([
      expect.objectContaining({ detail: expect.objectContaining({ address: tool.id, allow: true, binding: eng, principal: "eng" }) }),
      expect.objectContaining({ detail: expect.objectContaining({ address: "eng/tool", allow: true, binding: eng, principal: "eng" }) }),
    ]);
  });
});

describe("wake.service_invoke judges each post by its own board and reader (audit F3)", () => {
  test("one pull: a holder's request on the service's board is granted, the same user's post on an org board isn't", async () => {
    const { w1 } = await cast();
    // w-1 takes no rotations, so w-9 is the only lane; w-9 also follows an org board bob posts on.
    await w1.call("peer_status", { text: "busy", queue: "off" });
    // An application session of the service's own (a run token isn't an API session token).
    const svc = await row(srv, "SELECT u.id, u.email FROM users u JOIN principals p ON p.user_id = u.id AND p.kind = 'service' WHERE p.name = ?", SVC) as { id: number; email: string };
    const w9 = new AppSession(srv.app.application, srv.app.repo, { user_id: svc.id, user_email: svc.email, kind: "service", session_id: 0 }, "w-9");
    await w9.connect();
    await w9.call("board_subscribe", { board: "jobs", mode: "push" });
    const bob = await srv.hosted(B, "fe");
    sessions.push(bob);
    await bob.call("board_create", { name: "lobby", purpose: "everyone" });
    await w9.call("board_subscribe", { board: "lobby", mode: "push" });
    const job = await post(bob, "jobs", "a request");
    expect(await holderOf("jobs", job.post_id)).toBe(`${SVC}/w-9`);
    await post(bob, "lobby", "small talk");
    // Both in one pull, so one writerMarks call judges them.
    const items = await w9.pending();
    const marked = (body: string) => items.find((e) => e.kind === "board" && e.item.kind === "push" && e.item.post.body === body) as { item: { post: { other_user?: true; ungranted?: true } } } | undefined;
    expect(marked("a request")?.item.post).toMatchObject({ other_user: true });
    expect(marked("a request")!.item.post.ungranted).toBeUndefined();
    expect(marked("small talk")?.item.post).toMatchObject({ other_user: true, ungranted: true });
    w9.close();
  });

  test("a reply is judged for the address it was read for, not the session's primary", async () => {
    const { w1 } = await cast();
    expect((await api(tokens[B]!, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
    // bob's session: eng/build first (its primary, which holds no grant), then bob's own fe (which does).
    const bob = await srv.connected(tokens[B]!, "eng/build");
    await bob.bind(`${B}/fe`);
    const p = await bob.call<{ post_id: number }>("board_post", { board: "jobs", body: "bob's job", as: `${B}/fe` });
    await w1.next(push("bob's job"));
    await post(w1, "jobs", "bob's answer", { parent_id: p.post_id });
    const items = await bob.pending();
    const reply = items.find((e) => e.kind === "board" && e.item.kind === "push" && e.item.post.body === "bob's answer") as { item: { post: { other_user?: true; ungranted?: true } } } | undefined;
    expect(reply?.item.post).toMatchObject({ other_user: true });
    expect(reply!.item.post.ungranted).toBeUndefined();
  });
});

describe("the residuals (audit re-verification)", () => {
  test("a session's bind notices and the CLI's claim list name a queue post's claim only to those who see its board", async () => {
    await cast();
    const bob = await srv.hosted(B, "fe"), dave = await srv.hosted(D, "fe");
    sessions.push(bob, dave);
    const p = await post(bob, "jobs", "job for the service");
    const key = `queue:jobs:${p.post_id}`;
    await bob.call("claim_take", { key: "ticket:OPEN-1" });
    const notices = async (s: HostedSession, name: string) => JSON.stringify(await s.call("bind", { name, create: true }));
    const daves = await notices(dave, "second");
    expect(daves).toContain("ticket:OPEN-1");
    expect(daves).not.toContain("queue:jobs");
    expect(await notices(bob, "second")).toContain(key);
    const cli = async (t: string) => ((await api(t, "GET", "/api/claims")).body as { key: string }[]).map((c) => c.key);
    expect(await cli(tokens[D]!)).toEqual(["ticket:OPEN-1"]);
    expect(await cli(tokens[B]!)).toContain(key);
  });

  test("an ID's sight of a service's names, single and in a mention roster, is its session's primary's", async () => {
    await cast();
    expect((await api(tokens[B]!, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
    const build = await srv.hosted(B, "eng/build");
    sessions.push(build);
    await build.call("board_create", { name: "lobby", purpose: "everyone" });
    const id = await idHolding("eng/build");
    const access = boardAccess(srv.app.repo), read = srv.app.repo.read;
    const scope = { scope_kind: "service" as const, scope_ref: SVC };
    expect(await access.seesAlias(read, id, scope)).toBe(false);
    // A bare @w-1 that isn't eng's: strict, a seen holder is named in the refusal; an unseen one is just unresolved.
    expect((await post(build, "lobby", "@w-1 hello")).unresolved).toEqual(["w-1"]);
    await grant("eng");
    expect(await access.seesAlias(read, id, scope)).toBe(true);
    expect((await refusal(post(build, "lobby", "@w-1 hello again"))).message).toContain(`${SVC}/w-1`);
  });

  // Its user holds the grant through eng too (invokeBinding reads a user's teams), so this holds whether writerMarks
  // judges the ID as eng or as its user: a regression check for the as-ID post, not a mutation guard for seerIn there.
  test("a team-granted session's post as its ID reaches the service granted", async () => {
    const { w1 } = await cast();
    expect((await api(tokens[B]!, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
    await revoke(B);
    await grant("eng");
    const build = await srv.hosted(B, "eng/build");
    sessions.push(build);
    await post(build, "jobs", "as the ID", { as: (await idHolding("eng/build")) });
    const item = await w1.next(push("as the ID"));
    expect(item.actionable).toBe(true);
    expect((item.event as { item: { post: { ungranted?: true } } }).item.post.ungranted).toBeUndefined();
  });
});
