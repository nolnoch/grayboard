// Service boards and invocation, step 5 (#270 D5, D6, D4's alias.see_service): a queue board a service creates is
// the service's; posting on it is service.invoke, held by a user, a team or a service through a service_invoke
// binding, read live on every check (principle 11), recorded allow and deny (principle 8); only the service's own
// addresses are its lanes; the service's posts wake an invoker under wake.service_invoke (principle 10's grant); and to
// anyone else the board doesn't exist (principle 9: the refusal is a missing board's). The invocation is a post on a
// queue board, claimed by a lane, never a dispatch (principle 7). Each security invariant the step names has a test
// here that fails when it breaks.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { boardAccess, serverAccess } from "../../src/server/access.ts";
import type { DeliveryEvent } from "../../src/server/application.ts";
import { accessAudits } from "../support/audit.ts";
import { HostedSession, HostedToolError, type InboxItem } from "../support/hosted_session.ts";
import { TestServer } from "../support/server.ts";

const A = "alice@example.com", B = "bob@example.com", C = "carol@example.com", D = "dave@example.com", E = "erin@example.com", ROOT = "root@example.com";
const SVC = "ingest";
const LIMIT = { burst: 10_000, perSec: 10_000 };

let srv: TestServer;
let sessions: HostedSession[] = [];
let root: string;
let tokens: Record<string, string> = {};
beforeEach(async () => {
  srv = new TestServer({ admins: [ROOT, E], hostedRequestLimit: LIMIT });
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
async function runToken(): Promise<string> {
  const c = await api(root, "POST", "/api/admin/services/credentials", { service: SVC });
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

const scopeOf = (board: string) => (srv.app.db.query("SELECT scope FROM boards WHERE name = ?").get(board) as { scope: string | null } | null)?.scope;
const holderOf = (board: string, id: number) => (srv.app.db.query("SELECT holder FROM claims WHERE key = ?").get(`queue:${board}:${id}`) as { holder: string } | null)?.holder;
const invokes = () => accessAudits(srv.app.db, "authz.decision").filter(r => r.detail.verb === "service.invoke");
const push = (body: string) => (e: DeliveryEvent) => e.kind === "board" && e.item.kind === "push" && e.item.post.body === body;
const post = (s: HostedSession, board: string, body: string, extra: Record<string, unknown> = {}) => s.call<{ post_id: number; unresolved?: string[] }>("board_post", { board, body, ...extra });
const refusal = async (p: Promise<unknown>): Promise<HostedToolError> => {
  const e = await p.then((v) => new Error(`not refused: ${JSON.stringify(v)}`), (x: unknown) => x);
  if (!(e instanceof HostedToolError)) throw e;
  return e as HostedToolError;
};
// A refusal's text with the board's name taken out: a hidden board's and a missing one's must be the same.
const unnamed = (e: Error, board: string) => e.message.replaceAll(`#${board}`, "#BOARD");
async function missingBoardRefusal(s: HostedSession, tool = "board_post"): Promise<string> {
  const args = tool === "board_post" ? { board: "no-such-thing", body: "x" } : { board: "no-such-thing" };
  return unnamed(await refusal(s.call(tool, args)), "no-such-thing");
}

describe("D5: a service's board is a queue board in the service's scope", () => {
  test("a service's queue board is service-scoped; its broadcast board, and every user's board, stay org-open", async () => {
    const { w1 } = await cast();
    expect(scopeOf("jobs")).toBe(`service:${SVC}`);
    await w1.call("board_create", { name: "news", purpose: "announcements" });
    expect(scopeOf("news")).toBeNull();
    const bob = await srv.hosted(B, "fe");
    sessions.push(bob);
    await bob.call("board_create", { name: "bobq", purpose: "bob's queue", kind: "queue" });
    expect(scopeOf("bobq")).toBeNull();
  });

  test("no one but the service creates in its scope: a user, the owner, another service, a team name", async () => {
    await cast();
    const read = srv.app.repo.read;
    const access = boardAccess(srv.app.repo), core = serverAccess(srv.app.repo, srv.app.db);
    for (const handle of [`${B}/fe`, `${A}/fe`, "qa/bot", "other/w-1", `${C}/fe`]) {
      expect(await access.checkCreate(read, handle, `service:${SVC}`)).toBe(`invalid board scope "service:${SVC}"`);
      expect(core.checkCreate!(handle, `service:${SVC}`)).toBe(`invalid board scope "service:${SVC}"`);
    }
    // A scope naming no service is refused the same way.
    expect(await access.checkCreate(read, `${B}/fe`, "service:nope")).toBe('invalid board scope "service:nope"');
    // The service itself may; and not in another's.
    expect(await access.checkCreate(read, `${SVC}/w-1`, `service:${SVC}`)).toBeNull();
    expect(core.checkCreate!(`${SVC}/w-1`, `service:${SVC}`)).toBeNull();
    expect(await access.checkCreate(read, `${SVC}/w-1`, "service:other")).toBe('invalid board scope "service:other"');
    // Through the tool, a user's only route is the team argument, which names a team.
    const bob = await srv.hosted(B, "fe");
    sessions.push(bob);
    await refusal(bob.call("board_create", { name: "sneak", purpose: "x", kind: "queue", team: `service:${SVC}` }));
    expect(scopeOf("sneak")).toBeUndefined();
  });
});

describe("Tests item 4: the pilot gate", () => {
  test("a holder's post reaches exactly one service lane, actionable, allowed by its binding; the service's reply wakes the holder", async () => {
    const { w1, bindings } = await cast();
    const bob = await srv.hosted(B, "fe");
    sessions.push(bob);
    const p = await post(bob, "jobs", "job 1");
    expect(holderOf("jobs", p.post_id)).toBe(`${SVC}/w-1`);
    const item = await w1.next(push("job 1"));
    expect(item.actionable).toBe(true);
    expect(item.event).toMatchObject({ item: { post: { other_user: true } } });
    expect((item.event as { item: { post: { ungranted?: true } } }).item.post.ungranted).toBeUndefined();
    expect(invokes()).toEqual([expect.objectContaining({ actor: B, target: `service:${SVC}`, detail: expect.objectContaining({
      address: `${B}/fe`, allow: true, rule: "role.service_invoke", binding: bindings.bob, role: "service_invoke", scope: SVC, principal: B, principal_kind: "user", board: "jobs", post_id: p.post_id,
    }) })]);
    // The reply acks it and wakes bob, granted.
    await post(w1, "jobs", "done 1", { parent_id: p.post_id });
    expect(holderOf("jobs", p.post_id)).toBeUndefined();
    const reply = await bob.next(push("done 1"));
    expect(reply.actionable).toBe(true);
    expect(reply.event).toMatchObject({ item: { post: { other_user: true } } });
    expect((reply.event as { item: { post: { ungranted?: true } } }).item.post.ungranted).toBeUndefined();
    // The service's own post is service.own, recorded.
    expect(invokes().at(-1)).toMatchObject({ actor: SVC, detail: { address: `${SVC}/w-1`, allow: true, rule: "service.own" } });
  });

  test("a team member invokes through the team's binding, recorded with the team; removed from the team, refused", async () => {
    const { w1, bindings } = await cast();
    const carol = await srv.hosted(C, "fe");
    sessions.push(carol);
    const p = await post(carol, "jobs", "carol's job");
    expect(holderOf("jobs", p.post_id)).toBe(`${SVC}/w-1`);
    expect(invokes().at(-1)).toMatchObject({ actor: C, detail: { address: `${C}/fe`, allow: true, rule: "role.service_invoke", binding: bindings.qa, team: "qa", principal: C } });
    await w1.next(push("carol's job"));
    await post(w1, "jobs", "carol's done", { parent_id: p.post_id });
    expect((await carol.next(push("carol's done"))).actionable).toBe(true);
    expect((await api(root, "POST", "/api/teams/qa/remove", { email: C })).status).toBe(200);
    const missing = await missingBoardRefusal(carol);
    expect(unnamed(await refusal(post(carol, "jobs", "after removal")), "jobs")).toBe(missing);
    expect(invokes().at(-1)).toMatchObject({ actor: C, detail: { address: `${C}/fe`, allow: false, rule: "role.service_invoke", code: "not_found", principal: C } });
  });

  test("a session bound to a team's name acts as the team: refused until the team holds the grant", async () => {
    await cast();
    // bob holds the grant himself; eng, his team, doesn't.
    expect((await api(tokens[B]!, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
    const build = await srv.hosted(B, "eng/build");
    sessions.push(build);
    const missing = await missingBoardRefusal(build);
    expect(unnamed(await refusal(post(build, "jobs", "as eng")), "jobs")).toBe(missing);
    // The post fell back to the session's ID, which sees the board as bob; the invocation is still judged as eng.
    expect(invokes().at(-1)).toMatchObject({ actor: B, detail: { address: expect.stringMatching(/^id:/), allow: false, rule: "role.service_invoke", principal: "eng", principal_kind: "team" } });
    const eng = await grant("eng");
    await post(build, "jobs", "as eng, granted");
    expect(invokes().at(-1)).toMatchObject({ actor: B, detail: { allow: true, rule: "role.service_invoke", binding: eng, principal: "eng", principal_kind: "team" } });
  });

  test("a non-holder (the service's owner, an admin, a stranger) is refused as a missing board, with a deny row", async () => {
    await cast();
    for (const email of [A, E, D]) {
      const s = await srv.hosted(email, "fe");
      sessions.push(s);
      const missing = await refusal(post(s, "no-such-thing", "x"));
      const before = invokes().length;
      const e = await refusal(post(s, "jobs", "let me in"));
      expect(unnamed(e, "jobs")).toBe(unnamed(missing, "no-such-thing"));
      expect(e.code).toBe(missing.code);
      expect(invokes().slice(before)).toEqual([expect.objectContaining({ actor: email, target: `service:${SVC}`, detail: expect.objectContaining({
        address: `${email}/fe`, allow: false, rule: "role.service_invoke", code: "not_found", principal: email, board: "jobs",
      }) })]);
      // claim_take on the board is decided the same way.
      const c = await refusal(s.call("claim_take", { key: "ticket:ENG-1", board: "jobs" }));
      expect(unnamed(c, "jobs")).toBe(unnamed(await refusal(s.call("claim_take", { key: "ticket:ENG-1", board: "no-such-thing" })), "no-such-thing"));
      expect(invokes().at(-1)).toMatchObject({ detail: { allow: false, rule: "role.service_invoke" } });
    }
    expect(srv.app.db.query("SELECT count(*) AS n FROM posts WHERE board = 'jobs'").get()).toEqual({ n: 0 });
  });

  test("a holder's push subscription is never a lane: not in rotation, not on a decline, not by an @mention", async () => {
    const { w1 } = await cast();
    const w2 = await worker("w-2");
    await w2.call("board_subscribe", { board: "jobs", mode: "push" });
    const bob = await srv.hosted(B, "fe");
    sessions.push(bob);
    await bob.call("board_subscribe", { board: "jobs", mode: "push" });
    expect(srv.app.db.query("SELECT handle FROM subscriptions WHERE board = 'jobs' ORDER BY handle").all()).toEqual([{ handle: `${B}/fe` }, { handle: `${SVC}/w-1` }, { handle: `${SVC}/w-2` }]);
    const carol = await srv.hosted(C, "fe");
    sessions.push(carol);
    const lanes = new Set([`${SVC}/w-1`, `${SVC}/w-2`]);
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) {
      const p = await post(carol, "jobs", `job ${i}`);
      expect(lanes.has(holderOf("jobs", p.post_id)!), `job ${i} went to ${holderOf("jobs", p.post_id)}`).toBe(true);
      ids.push(p.post_id);
    }
    // Each decline hands the item to the other service lane, never bob.
    for (const id of ids) {
      const holder = holderOf("jobs", id)!;
      const s = holder === `${SVC}/w-1` ? w1 : w2;
      await s.call("claim_release", { key: `queue:jobs:${id}` });
      const next = holderOf("jobs", id);
      expect(next === undefined || lanes.has(next), `declined job ${id} went to ${next}`).toBe(true);
    }
    // A post that @mentions the holder tells it, but doesn't hand it the work.
    const named = await post(carol, "jobs", `@${B}/fe please look`);
    expect(holderOf("jobs", named.post_id)).not.toBe(`${B}/fe`);
    for (const id of [...ids, named.post_id]) expect(holderOf("jobs", id)).not.toBe(`${B}/fe`);
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
