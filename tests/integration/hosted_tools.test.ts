// Board, peer, claim, DM and attachment semantics over hosted MCP sessions
// (#282): an in-process server with dev auth, and sessions of two or three
// users through a built-in client's OAuth grant, delivering through the
// lease's inbox. Covers the distributed board semantics in
// docs/server-sessions.md and docs/server-access.md. Moved from ws.test.ts; hub mechanics are in
// hub.test.ts, routes in http_routes.test.ts.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { channelParams } from "../../adapters/hosted-core/src/channel.ts";
import { SubscriberError } from "../../adapters/hosted-core/src/wire.ts";
import type { ReadResult, WhoResult } from "../../src/core/boards.ts";
import type { BoardPostResult } from "../../src/core/tools.ts";
import type { DirectMessage, HistoryMessage, InboxResult, SendResult } from "../../src/server/application.ts";
import type { Config } from "../../src/server/config.ts";
import { OTHER_USER_NOTE } from "../../src/server/hosted.ts";
import { ATTACHMENT_LIMITS_CAPABILITY } from "../../src/shared/attachments.ts";
import type { Pending } from "../../src/shared/notifications.ts";
import { board, direct } from "../support/events.ts";
import { accessAudits } from "../support/audit.ts";
import { HostedToolError, type HostedSession } from "../support/hosted_session.ts";
import { TestServer } from "../support/server.ts";
import { until } from "../support/until.ts";
import { seed } from "../support/seed.ts";
import { drained, exec, execOn, row, rows } from "../support/repo_sql.ts";
import { holdWrites } from "../support/write_hold.ts";

const A = "alice@example.com";
const B = "bob@example.com";
const C = "carol@example.com";

// Inbox polling spends hosted requests.
const start = (overrides: Partial<Config> = {}) => TestServer.open({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 }, ...overrides });
let srv: TestServer;

// A test that needs other config replaces the server.
const restart = async (overrides: Partial<Config> = {}) => {
  await srv.stop();
  srv = await start(overrides);
};

beforeEach(async () => {
  srv = await start();
});

afterEach(() => srv.stop());

const login = (email: string) => srv.login(email);
const api = (token: string, method: string, path: string, body?: unknown) => srv.api(token, method, path, body);
const postOf = (item: Pending) => {
  if (item.kind !== "push") throw new Error(`expected a push, got a ${item.kind}`);
  return item.post;
};

test("team board: members see it and get pushes; non-members can't see or be mentioned", async () => {
  const alice = await login(A);
  const bob = await login(B);
  await login(C);
  await api(bob, "POST", "/api/identities", { name: "fe" });
  expect((await api(alice, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
  await api(alice, "POST", "/api/teams/eng/add", { email: C });

  const a = await srv.hosted(A, "be");
  const b = await srv.hosted(B, "fe");
  const c = await srv.hosted(C, "sim");

  const posted = await a.call<BoardPostResult>("board_post", { board: "eng", body: `@${C}/sim @bob/fe secret plan` });
  expect(posted.unresolved).toEqual(["bob/fe"]);

  const pushed = await c.next(board());
  expect(pushed.event.item).toMatchObject({
    kind: "push",
    reason: "mention",
    post: { board: "eng", author: `${A}/be`, body: `@${C}/sim @bob/fe secret plan` },
  });
  await b.none(board());

  expect((await b.call<{ name: string }[]>("board_list")).map((x) => x.name)).toEqual([]);
  await expect(b.call("board_read", { board: "eng" })).rejects.toMatchObject({ message: "no such board #eng; see board_list" });
  expect(await c.call("board_list")).toMatchObject([{ name: "eng", scope: "team:eng", mode: "digest" }]);
});

test("who: live sessions are online; a closed one is offline with last_seen; team board scopes it", async () => {
  const alice = await login(A);
  await login(B);
  await api(alice, "POST", "/api/teams", { name: "eng" });
  await api(alice, "POST", "/api/teams/eng/add", { email: B });

  await srv.hosted(A, "be");
  // A hosted name's last_seen is its session's last request, so it's bounded by the session's life.
  const before = Date.now();
  const a2 = await srv.hosted(A, "be-stream");
  const b = await srv.hosted(B, "fe");
  const c = await srv.hosted(C, "sim");

  const online = await c.call<WhoResult>("peer_list");
  expect(online.you).toBe(`${C}/sim`);
  expect(online.peers.map((p) => p.handle)).toEqual([`${A}/be`, `${A}/be-stream`, `${B}/fe`, `${C}/sim`]);

  await a2.close();
  const closed = Date.now();
  const after = await c.call<WhoResult>("peer_list");
  expect(after.offline_hidden).toBe(1);
  const all = await c.call<WhoResult>("peer_list", { include_offline: true });
  const gone = all.peers.find((p) => p.handle === `${A}/be-stream`)!;
  expect(gone.online).toBe(false);
  expect(gone.last_seen).toBeGreaterThanOrEqual(before);
  expect(gone.last_seen).toBeLessThanOrEqual(closed);

  const team = await b.call<WhoResult>("peer_list", { board: "eng", include_offline: true });
  expect(team.peers.map((p) => [p.handle, p.online])).toEqual([
    [`${A}/be`, true],
    [`${A}/be-stream`, false],
    [`${B}/fe`, true],
  ]);
  await expect(c.call("peer_list", { board: "eng" })).rejects.toMatchObject({ message: "no such board #eng; see board_list" });
});

// Security audit F-12: another user's agent shows its handle and presence,
// never where it runs, its status, harness, model, effort or launcher flag,
// and match can't probe them; a team alias shows them to the team's members.
test("peer_list shows a session's facts only inside a scope the caller may act in (F-12)", async () => {
  const alice = await login(A);
  const bob = await login(B);
  await login(C);
  await api(alice, "POST", "/api/teams", { name: "eng" });
  await api(alice, "POST", "/api/teams/eng/add", { email: B });

  const a = await srv.hosted(A, "be");
  const b = await srv.hosted(B, "fe");
  const c = await srv.hosted(C, "sim");
  await srv.connected(bob, "eng/deploy");
  await seed(srv.app.repo, async (tx) => {
    const facts = (address: string, model: string) =>
      execOn(tx, `UPDATE ids SET place = 'host:/src/secret-repo (feat/x)', harness = 'claude-code', model = ?, effort = 'high', launcher = TRUE, status = 'on ENG-142', status_at = ?
        WHERE id = (SELECT id FROM alias_holds WHERE address = ?)`, model, Date.now(), address);
    await facts(`${A}/be`, "model-a");
    await facts(`${B}/fe`, "model-b");
    await facts("eng/deploy", "model-d");
  });
  const FACTS = ["where", "status", "status_age", "harness", "model", "effort", "launcher"];
  const row = (r: WhoResult, h: string) => r.peers.find((p) => p.handle === h)! as unknown as Record<string, unknown>;
  const shown = (r: WhoResult, h: string) => FACTS.filter((k) => row(r, h)[k] !== undefined);

  const byAlice = await a.call<WhoResult>("peer_list");
  expect(shown(byAlice, `${A}/be`)).toEqual(FACTS);
  expect(shown(byAlice, `${B}/fe`)).toEqual([]);
  expect(row(byAlice, `${B}/fe`)).toMatchObject({ handle: `${B}/fe`, online: true });
  // alice is in eng, so its alias's facts show to her though bob's session holds it.
  expect(shown(byAlice, "eng/deploy")).toEqual(FACTS);
  expect(await b.call<WhoResult>("peer_list").then((r) => shown(r, `${B}/fe`))).toEqual(FACTS);

  // carol is in no team: only her own row shows facts, and eng's alias isn't listed to her at all (#348).
  const byCarol = await c.call<WhoResult>("peer_list");
  expect([`${A}/be`, `${B}/fe`].map((h) => shown(byCarol, h))).toEqual([[], []]);
  expect(byCarol.peers.find((p) => p.handle === "eng/deploy")).toBeUndefined();

  // A hidden fact can't be probed with match.
  expect((await c.call<WhoResult>("peer_list", { match: { model: "model-b" } })).peers).toEqual([]);
  expect((await c.call<WhoResult>("peer_list", { match: { harness: "claude-code" } })).peers).toEqual([]);
  expect((await b.call<WhoResult>("peer_list", { match: { model: "model-b" } })).peers.map((p) => p.handle)).toEqual([`${B}/fe`]);
});

// Security audit F-12: an ID row (a subscription taken unbound) is judged
// by its principal's person scope: a teammate sees bob's ID on the roster,
// never its facts.
test("peer_list(board) shows another user's ID subscription without its facts (F-12)", async () => {
  const alice = await login(A);
  await login(B);
  await api(alice, "POST", "/api/teams", { name: "eng" });
  await api(alice, "POST", "/api/teams/eng/add", { email: B });
  const a = await srv.hosted(A, "be");
  const b = await srv.hosted(B, null);
  await b.call("peer_list");
  // A hosted session can't subscribe unbound; a row as its ID is what a
  // released alias's subscription leaves, so write it directly.
  const { id: bobId } = (await row<{ id: string }>(srv, `SELECT id FROM ids WHERE principal = ?`, B))!;
  await seed(srv.app.repo, async (tx) => {
    await execOn(tx, `INSERT INTO subscriptions (board, handle, mode, cursor, notified_id) VALUES ('eng', ?, 'push', 0, 0)`, bobId);
    await execOn(tx, `UPDATE ids SET place = 'host:/src/secret-repo (feat/x)', harness = 'claude-code', model = 'model-b', effort = 'high', status = 'on ENG-142', status_at = ? WHERE id = ?`,
      Date.now(), bobId);
  });
  const FACTS = ["where", "status", "harness", "model", "effort"];
  const shown = (r: WhoResult) => {
    const row = r.peers.find((p) => p.handle === bobId) as unknown as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    return FACTS.filter((k) => row![k] !== undefined);
  };
  expect(shown(await b.call<WhoResult>("peer_list", { board: "eng" }))).toEqual(FACTS);
  expect(shown(await a.call<WhoResult>("peer_list", { board: "eng", include_offline: true }))).toEqual([]);
});

test("leaving a team drops its board and pending pushes", async () => {
  const alice = await login(A);
  const carol = await login(C);
  await api(alice, "POST", "/api/teams", { name: "eng" });
  await api(alice, "POST", "/api/teams/eng/add", { email: C });
  const a = await srv.hosted(A, "be");
  // carol is offline when mentioned, then leaves before connecting.
  await api(carol, "POST", "/api/identities", { name: "sim" });
  await a.call("board_post", { board: "eng", body: `@${C}/sim are you there` });
  await api(carol, "POST", "/api/teams/eng/leave");

  const c = await srv.hosted(C, "sim");
  await c.none(board());
  expect(await c.call("board_list")).toEqual([]);
});

test("removing a member drops their board and pending pushes", async () => {
  const alice = await login(A);
  const carol = await login(C);
  await api(alice, "POST", "/api/teams", { name: "eng" });
  await api(alice, "POST", "/api/teams/eng/add", { email: C });
  const a = await srv.hosted(A, "be");
  await api(carol, "POST", "/api/identities", { name: "sim" });
  await a.call("board_post", { board: "eng", body: `@${C}/sim are you there` });
  expect((await api(alice, "POST", "/api/teams/eng/remove", { email: C })).status).toBe(200);

  const c = await srv.hosted(C, "sim");
  await c.none(board());
  expect(await c.call("board_list")).toEqual([]);
  expect((await api(carol, "GET", "/api/teams/eng/members")).status).toBe(404);
});

test("org boards are open to everyone; bare @name prefers the author's own identity", async () => {
  const a = await srv.hosted(A, "be");
  const as = await srv.hosted(A, "sim");
  const bs = await srv.hosted(B, "sim");

  await a.call("board_create", { name: "general", purpose: "Everyone" });
  await a.call("board_post", { board: "general", body: "@sim run the fixtures" });
  expect((await as.next(board())).event.item).toMatchObject({ reason: "mention" });
  await bs.none(board());

  const r = await bs.call<ReadResult>("board_read", { board: "general" });
  expect(r.posts).toHaveLength(1);
  await expect(bs.call("board_create", { name: "x", purpose: "y", team: "eng" })).rejects.toMatchObject({ message: 'no such team "eng"' });
});

// #635 over hosted MCP: the creator's address, not its user, archives; the
// team board can't be; a reply still reaches the thread.
test("board_archive: the creator retires a board; others still read and reply by name", async () => {
  const alice = await login(A);
  expect((await api(alice, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
  const a = await srv.hosted(A, "be");
  const as = await srv.hosted(A, "sim");
  const bs = await srv.hosted(B, "sim");

  await a.call("board_create", { name: "task-1", purpose: "One task" });
  const root = (await bs.call<BoardPostResult>("board_post", { board: "task-1", body: "started" })).post_id;
  await a.next(board());
  await expect(as.call("board_archive", { board: "task-1" })).rejects.toMatchObject({ message: `only #task-1's creator (${A}/be) or its user (${A}, from Slack: archive #task-1 / reopen #task-1) can archive or reopen it` });
  await expect(a.call("board_archive", { board: "eng" })).rejects.toMatchObject({ message: "#eng belongs to the bus itself and can't be archived" });
  expect(await a.call("board_archive", { board: "task-1" })).toMatchObject({ name: "task-1", archived_by: `${A}/be` });

  expect((await bs.call<{ name: string }[]>("board_list")).map((x) => x.name)).not.toContain("task-1");
  await expect(bs.call("board_post", { board: "task-1", body: "more" })).rejects.toMatchObject({ message: expect.stringContaining("#task-1 is archived") });
  await bs.call("board_post", { board: "task-1", body: "done", parent_id: root });
  expect((await a.next(board())).event.item).toMatchObject({ post: { body: "done", parent_id: root } });
  expect((await bs.call<ReadResult>("board_read", { board: "task-1", before_id: 999 })).posts.map((p) => p.body)).toEqual(["started", "done"]);

  // A team alias's board names no user who may archive it from Slack (#848).
  const deploy = await srv.hosted(A, "eng/deploy");
  await deploy.call("board_create", { name: "rollout", purpose: "Team rollout" });
  await expect(a.call("board_archive", { board: "rollout" })).rejects.toMatchObject({ message: "only #rollout's creator (eng/deploy) can archive or reopen it" });
});

// #848: board_archive acts as the address that sees the board (BOARD_USES), as board_read does: a session whose
// primary is another team's alias still archives a board its other alias created.
test("#848: board_archive acts as the alias that sees the board, not the primary", async () => {
  const alice = await login(A);
  for (const name of ["eng", "ops"]) expect((await api(alice, "POST", "/api/teams", { name })).status).toBe(201);
  const t = await srv.hosted(A, "ops/y");
  await t.call("board_create", { name: "ops-task", purpose: "One task", team: "ops" });
  await t.end();
  const s = await srv.hosted(A, "eng/x");
  await s.call("bind", { name: "ops/y" });
  expect(await s.call("board_archive", { board: "ops-task" })).toMatchObject({ name: "ops-task", archived_by: "ops/y" });
});

test("claims are org-wide and atomic across users", async () => {
  const a = await srv.hosted(A, "be");
  const b = await srv.hosted(B, "be");
  expect((await a.call<{ ok: boolean }>("claim_take", { key: "ticket:ENG-1", note: "on it" })).ok).toBe(true);
  expect(await b.call("claim_take", { key: "ticket:ENG-1" })).toMatchObject({
    ok: false,
    held_by: `${A}/be`,
    note: "on it",
  });
  expect((await b.call<{ key: string }[]>("claim_list")).map((c) => c.key)).toEqual(["ticket:ENG-1"]);
});

test("direct messages still deliver live", async () => {
  const a = await srv.hosted(A, "be");
  const b = await srv.hosted(B, "fe");
  expect(await a.call("dm_send", { to: `${B}/fe`, body: "hi" })).toMatchObject({ delivered_now: true });
  expect((await b.next(direct())).event.message.body).toBe("hi");
});

// The hosted half of ws.test.ts's handler test: a receipt (the lease's ack)
// whose write fails inside is refused as internal, and the session goes on.
test("a receipt that fails inside answers an internal error and keeps the session", async () => {
  const be = await srv.hosted(A, "be");
  const fe = await srv.hosted(A, "fe", { receipt: "manual" });
  await be.call("dm_send", { to: "fe", body: "hi" });
  const item = await fe.next(direct());
  // A read-point table gone from under the live server makes the receipt's cursor write fail.
  await exec(srv, `ALTER TABLE mailbox_cursors RENAME TO mailbox_cursors_gone`);
  await expect(fe.receipt([item.id])).rejects.toMatchObject({ code: "internal_error" });
  await fe.call("board_list");
});

// #843: a fault in whoami, dm_ack and bind answers one code, in structuredContent and in the text a client reads.
test("#843: a whoami, dm_ack or bind fault answers internal_error in structuredContent and the text alike", async () => {
  const be = await srv.hosted(A, "be");
  const fe = await srv.hosted(A, "fe");
  const unbound = await srv.hosted(A, null);
  const sent = await be.call<SendResult>("dm_send", { to: "fe", body: "hi" });
  const textOf = (r: Awaited<ReturnType<HostedSession["callRaw"]>>) => r.content?.[0]?.type === "text" ? r.content[0].text : "";
  // An unbound session's whoami lists its candidates, which admission doesn't: their listing throwing faults whoami alone.
  srv.app.application.hostedCandidates = () => { throw new Error("candidates fail"); };
  const who = await unbound.callRaw("whoami", {});
  expect([who.isError, who.structuredContent, textOf(who)]).toEqual([true, { code: "internal_error" }, "error: internal error"]);
  // A hold's insert that aborts makes bind fail inside, after admission.
  const pg = srv.config.store.kind === "postgres";
  if (pg) {
    await exec(srv, `CREATE FUNCTION holds_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'holds_fail'; END $$`);
    await exec(srv, `CREATE TRIGGER holds_fail BEFORE INSERT ON alias_holds FOR EACH ROW EXECUTE FUNCTION holds_fail()`);
  } else await exec(srv, `CREATE TRIGGER holds_fail BEFORE INSERT ON alias_holds BEGIN SELECT RAISE(ABORT, 'holds_fail'); END`);
  const bind = await unbound.callRaw("bind", { name: "sim", create: true });
  expect([bind.isError, bind.structuredContent, JSON.parse(textOf(bind))]).toEqual([true, { code: "internal_error" }, { code: "internal_error", message: "internal error" }]);
  // The ack table gone from under the live server makes the ack's write fail. The first ID is missing, the
  // second faults: the fault keeps its own code rather than becoming the missing ID's not_found.
  await exec(srv, `ALTER TABLE dm_acks RENAME TO dm_acks_gone`);
  const ack = await fe.callRaw("dm_ack", { message_id: [99999, sent.message_id] });
  expect([ack.isError, ack.structuredContent, textOf(ack)]).toEqual([true, { code: "internal_error" }, "error: internal error"]);
  // Put the schema back, so the server's stop ends sessions cleanly.
  await exec(srv, `ALTER TABLE dm_acks_gone RENAME TO dm_acks`);
  if (pg) {
    await exec(srv, `DROP TRIGGER holds_fail ON alias_holds`);
    await exec(srv, `DROP FUNCTION holds_fail()`);
  } else await exec(srv, `DROP TRIGGER holds_fail`);
});

// #1032: a bind refused not_found (a scope that names no team) is logged as a refusal, like the other bind codes.
test("#1032: a bind into a scope that names no team logs a not_found refusal", async () => {
  const unbound = await srv.hosted(A, null);
  const err = spyOn(console, "error");
  try {
    await expect(unbound.call("bind", { name: "no-such-team/sim", create: true })).rejects.toMatchObject({ code: "not_found" });
    const refusals = err.mock.calls.map(c => String(c[0])).filter(l => l.startsWith("[grayboard] hosted MCP refused: "))
      .map(l => JSON.parse(l.slice("[grayboard] hosted MCP refused: ".length)) as { reason: string });
    expect(refusals.map(r => r.reason)).toEqual(["not_found"]);
  } finally { err.mockRestore(); }
});

test("a bare DM recipient is only ever your own identity of that name (F-08)", async () => {
  const a = await srv.hosted(A, "be");
  const a2 = await srv.hosted(A, "be-stream");
  const b = await srv.hosted(B, "be-stream");
  await srv.hosted(B, "fe");
  const c = await srv.hosted(C, "fe");

  // alice and bob both have be-stream: alice's bare name means her own.
  await a.call("dm_send", { to: "be-stream", body: "mine" });
  expect((await a2.next(direct())).event.message.body).toBe("mine");
  await b.none(direct());
  // carol has no be: alice's, the only one, is named in full, never woken by the bare name.
  // dm_history and delegate resolve a bare name the same way as dm_send.
  const notMine = { message: `"be" isn't in your scope; name it in full: ${A}/be; peer_list shows exact handles` };
  await expect(c.call("dm_history", { peer: "be" })).rejects.toMatchObject(notMine);
  await expect(c.call("delegate", { persona: "reviewer", task: "look", to: "be" })).rejects.toMatchObject(notMine);
  await expect(c.call("dm_send", { to: "be", body: "only one" })).rejects.toMatchObject({
    message: `"be" isn't in your scope; name it in full: ${A}/be; peer_list shows exact handles`,
  });
  await a.none(direct());
  await c.call("dm_send", { to: `${A}/be`, body: "in full" });
  expect((await a.next(direct())).event.message.body).toBe("in full");
  // alice has no fe, and bob and carol each have one.
  await expect(a.call("dm_send", { to: "fe", body: "?" })).rejects.toMatchObject({
    message: `"fe" isn't in your scope; name it in full: ${B}/fe, ${C}/fe; peer_list shows exact handles`,
  });
  await expect(a.call("dm_send", { to: "nobody", body: "?" })).rejects.toMatchObject({
    message: `no identity is named "nobody"; peer_list shows exact handles`,
  });
});

test("dm_history: peer resolves like dm_send's recipient, oldest first, limit clamped; empty and NUL bodies refused", async () => {
  const a = await srv.hosted(A, "be");
  await srv.hosted(B, "fe");
  for (const body of ["one", "two", "three"]) await a.call("dm_send", { to: `${B}/fe`, body });
  await expect(a.call("dm_send", { to: `${B}/fe`, body: "  " })).rejects.toMatchObject({ message: "body is required" });
  // NUL is refused as local mode refuses it (#807 P3 C5 decision 7), for a DM and a post alike.
  await expect(a.call("dm_send", { to: `${B}/fe`, body: "a\u0000b" })).rejects.toMatchObject({ code: "bad_request", message: "body contains a NUL character" });
  await a.call("board_create", { name: "nul", purpose: "x" });
  await expect(a.call("board_post", { board: "nul", body: "a\u0000b" })).rejects.toMatchObject({ code: "bad_request", message: "body contains a NUL character" });

  const bodies = async (peer: string, limit?: number) =>
    (await a.call<HistoryMessage[]>("dm_history", { peer, ...(limit !== undefined ? { limit } : {}) })).map((m) => m.body);
  expect(await bodies(`${B}/fe`)).toEqual(["one", "two", "three"]);
  expect(await bodies("Bob@Example.com/FE")).toEqual(["one", "two", "three"]);
  expect(await bodies(`${B}/fe`, 2)).toEqual(["two", "three"]);
  expect(await bodies(`${B}/fe`, 0)).toEqual(["three"]);
  await expect(a.call("dm_history", { peer: "nobody" })).rejects.toMatchObject({
    message: `no identity is named "nobody"; peer_list shows exact handles`,
  });
});

test("senders see what hasn't reached an offline peer", async () => {
  const b = await srv.hosted(B, "fe");
  await b.close();
  const a = await srv.hosted(A, "be");
  await a.call("dm_send", { to: `${B}/fe`, body: "one" });
  const sent = await a.call("dm_send", { to: `${B}/fe`, body: "two" });
  expect(sent).toMatchObject({ delivered_now: false, recipient_last_seen: expect.stringMatching(/ago$/), undelivered_from_you: 2 });
  const delivered = async () =>
    (await a.call<HistoryMessage[]>("dm_history", { peer: `${B}/fe` })).map((m) => m.delivered);
  expect(await delivered()).toEqual([false, false]);

  // The lease's receipt is the ack: it moves the read point.
  const b2 = await srv.hosted(B, "fe", { receipt: "manual" });
  const items = [await b2.next(direct()), await b2.next(direct())];
  await b2.receipt(items.map((i) => i.id));
  expect(await delivered()).toEqual([true, true]);
});

test("dm_retract withdraws a queued message; one the recipient is holding or has acked stays", async () => {
  const b = await srv.hosted(B, "fe");
  await b.close();
  const a = await srv.hosted(A, "be");
  const fresh = await a.call<SendResult>("dm_send", { to: `${B}/fe`, body: "fresh" });
  expect(fresh.note).toMatch(/^Recipient offline/);
  await exec(srv, "UPDATE aliases SET last_seen = ? WHERE address = ?", Date.now() - 22 * 3_600_000, `${B}/fe`);
  const wrong = await a.call<SendResult>("dm_send", { to: `${B}/fe`, body: "wrong" });
  expect(wrong.note).toMatch(/^Queued: bob@example.com\/fe last seen 22h ago\. .*dm_retract/);

  const other = await srv.hosted(B, "sim");
  await expect(other.call("dm_retract", { message_id: wrong.message_id })).rejects.toMatchObject({
    message: `no message ${wrong.message_id} from you`,
  });
  await a.call("dm_retract", { message_id: wrong.message_id });
  expect((await a.call<HistoryMessage[]>("dm_history", { peer: `${B}/fe` })).map((m) => m.body)).toEqual(["fresh"]);

  // Delivered but not receipted: the cursor hasn't moved, but bob is live.
  const b2 = await srv.hosted(B, "fe", { receipt: "manual" });
  expect((await b2.next(direct())).event.message.body).toBe("fresh");
  await b2.none(direct());
  await expect(a.call("dm_retract", { message_id: fresh.message_id })).rejects.toMatchObject({ message: expect.stringContaining("already reached") });
});

test("dm_retract refuses a queued message that has a reply, and leaves it in place", async () => {
  const b = await srv.hosted(B, "fe");
  await b.close();
  const a = await srv.hosted(A, "be");
  const first = await a.call<SendResult>("dm_send", { to: `${B}/fe`, body: "first" });
  expect(first.note).toMatch(/^Recipient offline/);
  await a.call<SendResult>("dm_send", { to: `${B}/fe`, body: "also", parent_id: first.message_id });

  await expect(a.call("dm_retract", { message_id: first.message_id })).rejects.toMatchObject({ message: expect.stringMatching(/has a reply/) });
  expect((await a.call<HistoryMessage[]>("dm_history", { peer: `${B}/fe` })).map((m) => m.body)).toEqual(["first", "also"]);
});

test("dm_inbox: replied and acked messages drop out; only the recipient can ack", async () => {
  const a = await srv.hosted(A, "be");
  const b = await srv.hosted(B, "fe");
  const q = await b.call<SendResult>("dm_send", { to: `${A}/be`, body: "question?" });
  const fyi = await b.call<SendResult>("dm_send", { to: `${A}/be`, body: "FYI" });
  const inbox = async () => (await a.call<InboxResult>("dm_inbox")).unanswered.map((m) => m.id);
  expect(await inbox()).toEqual([q.message_id, fyi.message_id]);

  await a.call("dm_send", { to: `${B}/fe`, body: "answer", parent_id: q.message_id });
  await expect(b.call("dm_ack", { message_id: fyi.message_id })).rejects.toMatchObject({
    message: `no message ${fyi.message_id} to you or pending from you; dm_inbox lists them`,
  });
  await a.call("dm_ack", { message_id: fyi.message_id });
  expect(await inbox()).toEqual([]);
});

test("a pending send is echoed, listed as promised until the sender's next message, and ackable by the sender", async () => {
  const a = await srv.hosted(A, "be");
  const b = await srv.hosted(B, "fe");
  const p = await a.call<SendResult>("dm_send", { to: `${B}/fe`, body: "results by noon", pending: true });
  expect(p).toMatchObject({ pending: true });
  const plain = await a.call<SendResult>("dm_send", { to: `${B}/fe`, body: "fyi" });
  expect(plain.pending).toBeUndefined();
  const promises = async () => (await a.call<InboxResult>("dm_inbox", { days: 1 })).promised?.map((m) => m.id);
  expect(await promises()).toEqual([p.message_id]);
  // History is oldest first; only the pending row says so.
  expect((await a.call<HistoryMessage[]>("dm_history", { peer: `${B}/fe` })).map((m) => m.pending)).toEqual([true, undefined]);

  // Bob's reply doesn't keep it, and his ack (as its recipient) doesn't drop it.
  await b.call("dm_send", { to: `${A}/be`, body: "thanks", parent_id: p.message_id });
  await b.call("dm_ack", { message_id: p.message_id });
  expect(await promises()).toEqual([p.message_id]);
  await a.call("dm_send", { to: `${B}/fe`, body: "done", parent_id: p.message_id });
  expect(await promises()).toBeUndefined();

  const p2 = await a.call<SendResult>("dm_send", { to: `${B}/fe`, body: "later", pending: true });
  await expect(a.call("dm_ack", { message_id: plain.message_id })).rejects.toMatchObject({
    message: `no message ${plain.message_id} to you or pending from you; dm_inbox lists them`,
  });
  await a.call("dm_ack", { message_id: p2.message_id });
  expect(await promises()).toBeUndefined();
});

test("only a message's sender and recipient can read its thread or reply to it", async () => {
  const a = await srv.hosted(A, "be");
  const b = await srv.hosted(B, "fe");
  const c = await srv.hosted(C, "sim");
  const root = await a.call<SendResult>("dm_send", { to: `${B}/fe`, body: "private" });
  const reply = await b.call<SendResult>("dm_send", { to: `${A}/be`, body: "re", parent_id: root.message_id });
  expect((await b.call<DirectMessage[]>("dm_thread", { thread: root.message_id })).map((m) => m.id)).toEqual([
    root.message_id,
    reply.message_id,
  ]);
  await expect(c.call("dm_thread", { thread: reply.message_id })).rejects.toMatchObject({
    message: `message ${reply.message_id} not found`,
  });
  await expect(c.call("dm_send", { to: `${A}/be`, body: "x", parent_id: root.message_id })).rejects.toMatchObject({
    message: `parent_id ${root.message_id} is not a message you sent or received`,
  });
  // #524: a reply goes to the parent's other party; to anyone else it would thread where that party can't read it.
  // A native tool's refusal carries its code in structuredContent (#806), as the subscriber role's do; the text is unchanged.
  const code = async (s: HostedSession, tool: string, args: Record<string, unknown>) => {
    const result = await s.callRaw(tool, args);
    return [result.isError, result.structuredContent, result.content?.[0]?.type === "text" ? result.content[0].text.startsWith("error: ") : false];
  };
  expect(await code(b, "dm_send", { to: `${C}/sim`, body: "x", parent_id: root.message_id })).toEqual([true, { code: "bad_request" }, true]);
  expect(await code(c, "dm_thread", { thread: reply.message_id })).toEqual([true, { code: "not_found" }, true]);
  expect(await code(c, "dm_ack", { message_id: 99999 })).toEqual([true, { code: "not_found" }, true]);
  expect((await c.callRaw("bind", { name: "never-made" })).structuredContent).toMatchObject({ code: "identity_unknown" });
  await expect(b.call("dm_send", { to: `${C}/sim`, body: "x", parent_id: root.message_id })).rejects.toMatchObject({
    message: `parent_id ${root.message_id} is a thread with ${A}/be, so a reply goes to ${A}/be; to write to someone else, send without parent_id`,
  });
  await expect(a.call("dm_send", { to: `${C}/sim`, body: "x", parent_id: reply.message_id })).rejects.toMatchObject({
    message: `parent_id ${reply.message_id} is a thread with ${B}/fe, so a reply goes to ${B}/fe; to write to someone else, send without parent_id`,
  });
  // Neither refusal wrote anything (#530): not in the thread from either party's view, nor anywhere c can see.
  for (const party of [a, b]) expect((await party.call<DirectMessage[]>("dm_thread", { thread: root.message_id })).map((m) => m.id)).toEqual([root.message_id, reply.message_id]);
  expect((await c.call<{ unanswered: unknown[] }>("dm_inbox", {})).unanswered).toEqual([]);
  await b.call("dm_send", { to: `${C}/sim`, body: "new thread" });
  await expect(a.call("dm_send", { to: `${B}/fe`, body: "x", parent_id: 99999 })).rejects.toBeInstanceOf(HostedToolError);
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);

// The hosted byte routes (src/server/mcp-attachments.ts), acting as the session's bound name.
const upload = (s: HostedSession, filename: string, data: Uint8Array<ArrayBuffer> | string) => s.uploadRaw(filename, data);
const download = (s: HostedSession, id: number) => s.attachmentRaw("GET", `/${id}`);

const audits = (action: string) => accessAudits(srv, action);

test("#385: the DM tools take local's definitions, so a bad message ID or an unknown argument is refused before any handler", async () => {
  const a = await srv.hosted(A, "be");
  const b = await srv.hosted(B, "fe");
  const root = await a.call<SendResult>("dm_send", { to: `${B}/fe`, body: "hi" });
  for (const [tool, args] of [
    ["dm_thread", { thread: 1.5 }],
    ["dm_thread", { thread: 0 }],
    ["dm_history", { before_id: -1 }],
    ["dm_send", { to: `${A}/be`, body: "x", parent_id: root.message_id + 0.5 }],
    ["dm_send", { to: `${A}/be`, body: "x", attachments: ["/etc/passwd"] }],
    // application.send takes `resend` only as a boolean; the schema is what refuses any other (#475).
    ["dm_send", { to: `${A}/be`, body: "x", resend: "yes" }],
    ["delegate", { persona: "researcher", task: "x", resend: 1 }],
  ] as const) {
    const result = await b.callRaw(tool, args);
    const text = result.content?.[0]?.type === "text" ? result.content[0].text : "";
    expect([tool, args, result.isError, text.startsWith(`Input validation error: Invalid arguments for tool ${tool}:`), result.structuredContent]).toEqual([tool, args, true, true, { code: "bad_request" }]);
  }
  // Nothing was sent by the refused calls.
  expect((await b.call<HistoryMessage[]>("dm_history", {})).map((m) => m.body)).toEqual(["hi"]);
});

test("#1220: every class of input-schema refusal carries code bad_request, local's code, with the SDK's text", async () => {
  const a = await srv.hosted(A, "be");
  for (const [tool, args] of [
    ["peer_status", { text: "busy", queue: "maybe" }], // enum
    ["board_subscribe", { board: "e2e", mode: "loud" }], // enum
    ["board_create", { name: "e2e", kind: "fifo" }], // enum
    ["claim_take", { key: "ticket:ENG-142", ttl_minutes: "30" }], // a string for a number
    ["peer_list", { include_offline: 1 }], // a number for a boolean
    ["board_post", { board: "e2e" }], // a required argument missing
    ["claim_list", { prefix: "ticket:", extra: true }], // an unknown argument
    ["dm_inbox", { days: -1 }], // a zod schema's bound
    ["whoami", { x: 1 }], // a zod strict object
    ["bind", { name: 7 }], // the hosted bind input
  ] as const) {
    const result = await a.callRaw(tool, args);
    const text = result.content?.[0]?.type === "text" ? result.content[0].text : "";
    expect([tool, result.isError, result.structuredContent, text.startsWith(`Input validation error: Invalid arguments for tool ${tool}:`)]).toEqual([tool, true, { code: "bad_request" }, true]);
    await expect(a.call(tool, args)).rejects.toMatchObject({ code: "bad_request" });
  }
  // The subscriber role's tools too: hosted-core's Wire sees the code, not a code-less invalid_response.
  for (const [tool, args] of [
    ["delivery_receipt", { ids: "x" }], // a string for an array
    ["bind", { name: 7 }], // a number for a string
  ] as const) {
    const refused = await a.subscriber.call(tool, args).then(() => undefined, (e: unknown) => e);
    expect([tool, refused instanceof SubscriberError, (refused as SubscriberError | undefined)?.code]).toEqual([tool, true, "bad_request"]);
  }
  // The refused peer_status set nothing.
  expect((await a.call<{ peers: { handle: string; status?: string }[] }>("peer_list", {})).peers.find((p) => p.handle === "be")?.status ?? null).toBeNull();
});

test("attachments on a DM: uploaded as your identity, bound by the send, pushed and read, fetched by its two parties", async () => {
  const a = await srv.hosted(A, "be");
  const b = await srv.hosted(B, "fe");
  const c = await srv.hosted(C, "sim");

  expect((await upload(a, "x.bin", new Uint8Array([0, 1, 2]))).body.message).toMatch(/not an image/);
  expect((await upload(a, "x.txt", new Uint8Array(0))).body.message).toBe("file x.txt: empty file");
  // The upload runs the checks an agent's path gets: names, key material, an extension matching the type.
  expect((await upload(a, ".env", "A=1")).body.message).toMatch(/dotfiles/);
  expect((await upload(a, "id_rsa", "x")).body.message).toMatch(/key or credentials/);
  expect((await upload(a, "n.txt", "-----BEGIN RSA PRIVATE KEY-----")).body.message).toMatch(/key material/);

  // A name with a path in it is refused before the body is read.
  expect(await upload(a, "../shot.png", PNG)).toEqual({ status: 400, body: { code: "bad_request", message: "invalid filename" } });
  const up = await upload(a, "shot.png", PNG);
  expect(up.status).toBe(201);
  expect(up.body).toEqual({ id: expect.any(Number), filename: "shot.png", type: "image/png", size: PNG.length, sha256: expect.any(String) });
  const info = { id: up.body.id, filename: "shot.png", type: "image/png", size: PNG.length, sha256: up.body.sha256 };
  expect(await audits("attachment.uploaded")).toMatchObject([
    { actor: A, target: `attachment:${up.body.id}`, detail: { identity: `${A}/be` } },
  ]);

  // Only the uploader's identity can send it.
  await expect(c.call("dm_send", { to: `${B}/fe`, body: "mine now", attachment_ids: [up.body.id] })).rejects.toMatchObject({
    message: `attachment ${up.body.id} isn't an unsent upload of yours`,
  });
  const sent = await a.call<SendResult>("dm_send", { to: `${B}/fe`, body: "see shot", attachment_ids: [up.body.id] });
  expect(sent).toMatchObject({ delivered_now: true, attachments: [info] });
  expect((await b.next(direct())).event.message).toMatchObject({ body: "see shot", attachments: [info] });
  // Once bound, it can't ride a second message.
  await expect(a.call("dm_send", { to: `${B}/fe`, body: "again", attachment_ids: [up.body.id] })).rejects.toBeInstanceOf(HostedToolError);

  expect((await b.call<DirectMessage[]>("dm_thread", { thread: sent.message_id }))[0]!.attachments).toEqual([info]);
  expect((await b.call<HistoryMessage[]>("dm_history", { peer: `${A}/be` }))[0]!.attachments).toEqual([info]);
  expect((await b.call<InboxResult>("dm_inbox")).unanswered[0]!.attachments).toEqual([info]);

  const got = await download(b, up.body.id);
  expect(got.status).toBe(200);
  expect(got.headers.get("content-type")).toBe("image/png");
  expect(got.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''shot.png");
  expect(got.headers.get("repr-digest")).toBe(`sha-256=:${createHash("sha256").update(PNG).digest("base64")}:`);
  expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG);
  expect((await download(a, up.body.id)).status).toBe(200);
  // Not a party: reads as missing, and is logged.
  const refused = await download(c, up.body.id);
  expect(refused.status).toBe(404);
  expect(await refused.json()).toMatchObject({ message: `no attachment ${up.body.id} on a message or post you can read` });
  expect(await audits("attachment.download_refused")).toMatchObject([{ actor: C, target: `attachment:${up.body.id}` }]);
  expect((await audits("attachment.downloaded")).map((r) => r.actor)).toEqual([B, A]);
});

test("attachments: a failed blob read or write is audited; a swept blob is a 404, a fault a bare 500", async () => {
  const blobDir = srv.config.blobDir!;
  const a = await srv.hosted(A, "be");
  const b = await srv.hosted(B, "fe");

  const up = await upload(a, "shot.png", PNG);
  await a.call("dm_send", { to: `${B}/fe`, body: "see shot", attachment_ids: [up.body.id] });
  // Swept between the read check and the read.
  rmSync(join(blobDir, up.body.sha256.slice(0, 2), up.body.sha256));
  const gone = await download(b, up.body.id);
  expect(gone.status).toBe(404);
  expect(await gone.json()).toEqual({ code: "not_found", message: `attachment ${up.body.id}'s bytes are gone` });
  expect(await audits("attachment.download_failed")).toMatchObject([{ actor: B, target: `attachment:${up.body.id}`, detail: { error: expect.stringContaining("are missing") } }]);
  expect(await audits("attachment.downloaded")).toEqual([]);

  // An unwritable blob directory: the client hears nothing of the path or errno.
  chmodSync(join(blobDir, "tmp"), 0o500);
  try {
    const failed = await upload(a, "other.png", new Uint8Array([...PNG, 1]));
    expect(failed).toEqual({ status: 500, body: { code: "internal", message: "internal error" } });
  } finally {
    chmodSync(join(blobDir, "tmp"), 0o700);
  }
  expect(await audits("attachment.upload_failed")).toMatchObject([{ actor: A, target: null, detail: { filename: "other.png", error: expect.stringContaining("EACCES") } }]);
});

test("attachments on a team board post follow the board; a retracted DM takes its files; uploads are capped", async () => {
  const alice = await login(A);
  const bob = await login(B);
  await login(C);
  await api(alice, "POST", "/api/teams", { name: "eng" });
  await api(alice, "POST", "/api/teams/eng/add", { email: C });
  await api(bob, "POST", "/api/identities", { name: "fe" });
  const a = await srv.hosted(A, "be");
  const c = await srv.hosted(C, "sim");

  const up = await upload(a, "plan.md", "# plan");
  expect(up.body.type).toBe("text/markdown");
  // A client can't name paths for the server to read: the hosted board_post
  // has no attachments field (attachment_ids only), and refuses one.
  await expect(a.call("board_post", { board: "eng", body: "x", attachments: ["/etc/hosts"] })).rejects.toMatchObject({ message: "Input validation error: Invalid arguments for tool board_post: data must NOT have additional properties" });
  // #1225: core's refusal order, the body before the uploads, so a call with both faults reads as it does locally.
  await expect(a.call("board_post", { board: "eng", body: " ", attachment_ids: [999_999] })).rejects.toMatchObject({ message: "body is required" });
  await expect(a.call("board_post", { board: "eng", body: "x", attachment_ids: [999_999] })).rejects.toMatchObject({ message: "attachment 999999 isn't an unsent upload of yours" });
  const posted = await a.call<BoardPostResult>("board_post", { board: "eng", body: `@${C}/sim plan attached`, attachment_ids: [up.body.id] });
  const info = { id: up.body.id, filename: "plan.md", type: "text/markdown", size: 6, sha256: up.body.sha256 };
  expect(posted.attachments).toEqual([info]);
  expect(postOf((await c.next(board())).event.item).attachments).toEqual([info]);
  expect((await download(c, up.body.id)).status).toBe(200);

  // bob/fe is offline, so the DM stays retractable.
  const note = await upload(a, "note.txt", "retract me");
  const queued = await a.call<SendResult>("dm_send", { to: `${B}/fe`, body: "oops", attachment_ids: [note.body.id] });
  expect(queued.delivered_now).toBe(false);
  await a.call("dm_retract", { message_id: queued.message_id });
  expect((await download(a, note.body.id)).status).toBe(404);
  // The retract sweeps the freed blob after its commit, not before its reply.
  await until(async () => !(await row(srv, `SELECT 1 FROM attachment_blobs WHERE sha256 = ?`, note.body.sha256)), 5000, "the retracted DM's blob swept");
  // Not on the team: the board's file reads as missing.
  expect((await download(await srv.hosted(B, "fe"), up.body.id)).status).toBe(404);

  const big = new Uint8Array(10 * 1024 * 1024).fill(0x61);
  expect((await upload(a, "big.txt", new Uint8Array(big.length + 1).fill(0x61))).status).toBe(413);
  // 50MB of unsent uploads per user, across their identities.
  for (let i = 0; i < 5; i++) {
    big[0] = 0x62 + i;
    expect((await upload(a, `big${i}.txt`, big)).status).toBe(201);
  }
  const over = await upload(a, "one-more.txt", "x");
  expect(over.status).toBe(413);
  expect(over.body.message).toMatch(/unsent uploads would exceed 50MB/);
  expect((await upload(c, "theirs.txt", "x")).status).toBe(201);
});

// #974: the sweep after a retract deletes the freed blob's catalog row through the write queue (#807 D4): while
// another body holds the queue the row stays, and it goes once that body ends.
test("#974: a retract's blob sweep waits behind another body holding the write queue", async () => {
  await login(A);
  const bob = await login(B);
  await api(bob, "POST", "/api/identities", { name: "fe" });
  const a = await srv.hosted(A, "be");
  const note = await upload(a, "note.txt", "retract me");
  const sha = String(note.body.sha256);
  const queued = await a.call<SendResult>("dm_send", { to: `${B}/fe`, body: "oops", attachment_ids: [note.body.id] });
  expect(queued.delivered_now).toBe(false);
  const blobs = srv.app.repo.blobs, del = blobs.delete;
  let release: (() => void) | undefined;
  let held: Promise<void> | undefined;
  // Held once the sweep has deleted the bytes, so its catalog delete is the next write to queue.
  blobs.delete = async (s: string) => {
    await del.call(blobs, s);
    if (s === sha && !held) { const hold = holdWrites(srv); release = hold.release; held = hold.done; }
  };
  const catalogued = async () => Boolean(await row(srv, `SELECT 1 FROM attachment_blobs WHERE sha256 = ?`, sha));
  try {
    await a.call("dm_retract", { message_id: queued.message_id });
    await until(() => held !== undefined, 5000, "the sweep deleted the retracted DM's bytes");
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(await catalogued()).toBe(true);
    release!();
    await held;
    await until(async () => !(await catalogued()), 5000, "the sweep's catalog delete ran after the hold");
  } finally { blobs.delete = del; release?.(); }
});

test("a server's own attachment limits: sent at initialize, enforced per file, per message and on unsent uploads", async () => {
  await restart({ attachmentLimits: { file: 100, total: 150 } });
  const a = await srv.hosted(A, "be");
  expect(a.native.client.getServerCapabilities()?.experimental?.[ATTACHMENT_LIMITS_CAPABILITY]).toEqual({ file: 100, total: 150 });

  expect((await upload(a, "big.txt", "x".repeat(101))).body.message).toBe("file big.txt: 101B exceeds the 100B limit per file");
  expect((await upload(a, "page.html", "<script>")).body.filename).toBe("page.html.txt");
  const one = await upload(a, "a.txt", "a".repeat(80));
  const two = await upload(a, "b.txt", "b".repeat(80));
  await expect(a.call("dm_send", { to: "be", body: "both", attachment_ids: [one.body.id, two.body.id] })).rejects.toMatchObject({
    message: "attachments exceed 150B in all",
  });
  // Unsent uploads are capped at twice the per-message total.
  await upload(a, "c.txt", "c".repeat(80));
  expect((await upload(a, "d.txt", "d".repeat(80))).body.message).toMatch(/unsent uploads would exceed 300B/);
});

test("a user's stored attachments are capped, sent or not; an upload needs a length; refusals are audited", async () => {
  await restart({ attachmentLimits: { file: 100, total: 150 }, attachmentUserQuota: 200 });
  const a = await srv.hosted(A, "be");
  for (const n of ["a", "b"]) {
    const up = await upload(a, `${n}.txt`, n.repeat(90));
    await a.call("dm_send", { to: "be", body: n, attachment_ids: [up.body.id] });
  }
  const over = await upload(a, "c.txt", "c".repeat(30));
  expect(over).toMatchObject({ status: 413, body: { message: "your stored attachments would exceed 200B; they're freed as their messages and posts age out" } });
  expect((await upload(a, "d.txt", "d".repeat(20))).status).toBe(201);

  // A streamed body declares no length.
  const streamed = await a.attachmentRaw("POST", "?filename=e.txt", new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode("e")), c.close()) }));
  expect(streamed.status).toBe(411);

  expect((await audits("attachment.upload_refused")).map((r): Record<string, unknown> => ({ actor: r.actor, ...r.detail }))).toEqual([
    { actor: A, identity: `${A}/be`, filename: "c.txt", size: 30, reason: over.body.message },
  ]);
});

// #463 item 2: the hosted whoami names the session ID and the principal beside the holds, as the local and WSS ones did.
test("#463: whoami names the session ID, the holds oldest first and the principal", async () => {
  const s = await srv.hosted(A, null);
  expect(await s.call("whoami")).toMatchObject({ id: expect.stringMatching(/^id:/), principal: A, held: [], primary: null, unbound: true });
  await s.bind("zed");
  await s.bind("alpha");
  expect(await s.call("whoami")).toMatchObject({ principal: A, held: [`${A}/zed`, `${A}/alpha`], primary: `${A}/zed` });
});

// ── child sessions (#523) ────────────────────────────────────────────────────

// `root`'s child for the raw source ID `raw`, registered as a harness's
// subscriber registers a subagent, and its own hosted session (no lease: a
// child never holds delivery).
async function childOf(root: HostedSession, email: string, raw: string): Promise<{ child: HostedSession; id: string; root: string }> {
  const registered = await root.subscriber.call("session_register", { child: raw }) as { child: string; root: string };
  return { child: await srv.hosted(email, null, { sessionId: raw, delivery: false }), id: registered.child, root: registered.root };
}
// The push channel a hosted adapter renders for an inbox item (hosted-core's channelParams), as `identity`.
const channelOf = (item: { id: string; actionable: boolean; event: unknown; ownership: number; bind_gen: number }, identity: string) =>
  channelParams(item, { user: { email: identity.slice(0, identity.indexOf("/")) }, identity_full: identity, issuer: "", resource: "" });
// A board resource's snapshot, read by `s`'s native role as a hosted client reads it.
async function boardSnapshot(s: HostedSession, board: string): Promise<ReadResult> {
  const resource = await s.native.client.readResource({ uri: `grayboard://boards/${board}` });
  const content = resource.contents[0];
  if (!content || !("text" in content)) throw new Error(`grayboard://boards/${board} answered no text`);
  // The server's snapshot (core's snapshot()), as JSON.
  const snapshot: ReadResult = JSON.parse(content.text);
  return snapshot;
}

// #475 item 1: disabling a user ends their hosted children through the repo's own store, so the ends'
// after-commit half runs: a live sender gets its bounce pushed now. The message stands in for mail that reached
// the ID before it was a child (a send to a child's ID is refused).
test("disable-user ends a hosted child and pushes its bounce to a live sender (#475 item 1)", async () => {
  await restart({ admins: [C] });
  const admin = await login(C);
  await login(A);
  const be = await srv.hosted(A, "be");
  // An application session, not a hosted one: it gets the bounce only by the live push, where a hosted
  // session's inbox poll would find it in the table anyway.
  const fe = await srv.connected(await login(B), "fe");
  const { child, id } = await childOf(be, A, "reviewer-run");
  // Their clients drop first (no release), so the disable's 401s reach no client; the rows stay.
  await Promise.all([be.drop(), child.drop()]);
  expect((await srv.app.repo.hosted.get(srv.app.repo.read, id))?.root_session_id).toBeTruthy();
  await exec(srv, `INSERT INTO messages (sender, sender_id, recipient_type, recipient, body, parent_id, created_at, pending)
    VALUES (?, NULL, 'user', ?, 'before it was a child', NULL, ?, FALSE)`, `${B}/fe`, id, Date.now());
  expect((await api(admin, "POST", "/api/admin/disable-user", { email: A })).status).toBe(200);
  expect((await fe.next(direct())).message).toMatchObject({ sender: id, kind: "bounce" });
  expect(await srv.app.repo.hosted.get(srv.app.repo.read, id)).toBeUndefined();
});

// #807 P3 A7i: an end's bounces are read in its transaction and pushed at its commit, with no read after it, so no
// newer message to the sender can be pushed first; the wake and the sweep follow (here the sweep takes an orphaned
// upload's bytes).
test("#807 P3 A7i: an end's bounces are pushed at its commit with no read after it, then the sweep runs", async () => {
  await restart({ admins: [C] });
  const admin = await login(C);
  await login(A);
  const be = await srv.hosted(A, "be");
  const fe = await srv.connected(await login(B), "fe");
  const { child, id } = await childOf(be, A, "reviewer-run");
  await Promise.all([be.drop(), child.drop()]);
  const orphan = "0".repeat(64);
  await seed(srv.app.repo, async (tx) => {
    await execOn(tx, `INSERT INTO messages (sender, sender_id, recipient_type, recipient, body, parent_id, created_at, pending)
      VALUES (?, NULL, 'user', ?, 'before it was a child', NULL, ?, FALSE)`, `${B}/fe`, id, Date.now());
    await execOn(tx, `INSERT INTO attachment_blobs (sha256, size, created_at) VALUES (?, 1, ?)`, orphan, Date.now());
  });
  const bounces = spyOn(srv.app.repo.messages, "bouncesFrom");
  const deleted = spyOn(srv.app.repo.blobs, "delete");
  try {
    expect((await api(admin, "POST", "/api/admin/disable-user", { email: A })).status).toBe(200);
    expect((await fe.next(direct())).message).toMatchObject({ sender: id, kind: "bounce" });
    await until(() => deleted.mock.calls.some((c) => c[0] === orphan), 5000, "the sweep deleted the orphaned blob");
    expect(bounces).not.toHaveBeenCalled();
  } finally { bounces.mockRestore(); deleted.mockRestore(); }
});

test("#523: a child's DM and post carry its ID as via in pushes, reads and board snapshots, and still do after it ends; its root's carry none", async () => {
  const be = await srv.hosted(A, "be");
  const fe = await srv.hosted(A, "fe");
  const { child, id } = await childOf(be, A, "reviewer-run");
  await be.call("board_create", { name: "e2e", purpose: "fixtures" });
  await fe.call("board_subscribe", { board: "e2e", mode: "push" });

  // The DM: sent as the root's primary, stored with the child's sender_id and via, pushed with via.
  const sent = await child.call<SendResult>("dm_send", { to: "fe", body: "from the subagent" });
  const pushed = await fe.next(direct((m) => m.body === "from the subagent"));
  expect(pushed.event.message).toMatchObject({ id: sent.message_id, sender: `${A}/be`, via: id });
  expect(channelOf(pushed, `${A}/fe`).meta).toMatchObject({ from: `${A}/be`, via: id });
  expect(await row(srv, "SELECT sender_id, via FROM messages WHERE id = ?", sent.message_id)).toEqual({ sender_id: id, via: id });
  const own = await be.call<SendResult>("dm_send", { to: "fe", body: "from the root" });
  const ownPush = await fe.next(direct((m) => m.body === "from the root"));
  expect(ownPush.event.message).not.toHaveProperty("via");
  expect(channelOf(ownPush, `${A}/fe`).meta).not.toHaveProperty("via");
  expect(await row(srv, "SELECT via FROM messages WHERE id = ?", own.message_id)).toEqual({ via: null });

  // The post, and a claim's announcement and release: the child's posts, pushed with via; the root's without.
  const posted = await child.call<BoardPostResult>("board_post", { board: "e2e", body: "subagent post" });
  const postPush = await fe.next(board((i) => i.kind === "push" && i.post.body === "subagent post"));
  expect(channelOf(postPush, `${A}/fe`).meta).toMatchObject({ post_id: String(posted.post_id), from: `${A}/be`, via: id });
  expect(await row(srv, "SELECT author_id, via FROM posts WHERE id = ?", posted.post_id)).toEqual({ author_id: id, via: id });
  await be.call("board_post", { board: "e2e", body: "root post" });
  const rootPush = await fe.next(board((i) => i.kind === "push" && i.post.body === "root post"));
  expect(channelOf(rootPush, `${A}/fe`).meta).not.toHaveProperty("via");
  await child.call("claim_take", { key: "ticket:ENG-142", board: "e2e" });
  await child.call("claim_release", { key: "ticket:ENG-142" });
  const claimPush = await fe.next(board((i) => i.kind === "push" && i.post.body === "[claim] ticket:ENG-142"));
  expect(channelOf(claimPush, `${A}/fe`).meta).toMatchObject({ from: `${A}/be`, via: id });

  const reads = async () => {
    // dm_history, dm_thread and dm_inbox, for the recipient and the root: via on the child's message alone.
    for (const [s, peer] of [[fe, "be"], [be, "fe"]] as const) {
      const history = await s.call<HistoryMessage[]>("dm_history", { peer });
      expect(history.map((m) => [m.body, m.via])).toEqual([["from the subagent", id], ["from the root", undefined]]);
      expect(history[1]).not.toHaveProperty("via");
      expect(await s.call<HistoryMessage[]>("dm_thread", { thread: sent.message_id })).toEqual([expect.objectContaining({ id: sent.message_id, via: id })]);
    }
    const inbox = await fe.call<InboxResult>("dm_inbox");
    expect(inbox.unanswered.find((m) => m.id === sent.message_id)).toMatchObject({ from: `${A}/be`, via: id });
    expect(inbox.unanswered.find((m) => m.id === own.message_id)).not.toHaveProperty("via");
    // board_read and the board resource's snapshot.
    const expected = [
      ["subagent post", `${A}/be`, id],
      ["root post", `${A}/be`, undefined],
      ["[claim] ticket:ENG-142", `${A}/be`, id],
      ["[release] ticket:ENG-142", `${A}/be`, id],
    ];
    const read = await fe.call<ReadResult>("board_read", { board: "e2e", limit: 10 });
    expect(read.posts.map((p) => [p.body, p.author, p.via])).toEqual(expected);
    expect(read.posts[1]).not.toHaveProperty("via");
    const snapshot = await boardSnapshot(fe, "e2e");
    expect(snapshot.posts.map((p) => [p.body, p.author, p.via])).toEqual(expected);
    expect(snapshot.posts[1]).not.toHaveProperty("via");
  };
  await reads();

  // Its end deletes its source row; what it wrote stays attributed to it.
  await child.end();
  expect(await row(srv, "SELECT 1 FROM hosted_sessions WHERE session_id = ?", id)).toBeNull();
  await reads();
});

test("#523: a DM or @mention to a child's ID refuses child_session naming its root's primary, live or ended; the child can't act as its own ID", async () => {
  const be = await srv.hosted(A, "be");
  const fe = await srv.hosted(A, "fe");
  // The application's own refusal carries the code; the hosted DM and board tools answer its message (HostedToolError).
  const ops = srv.appSession(await login(A), "ops");
  await ops.connect();
  const { child, id, root } = await childOf(be, A, "reviewer-run");
  await be.call("board_create", { name: "e2e", purpose: "fixtures" });
  const message = `${id} is a subagent acting under session ${root} and receives nothing; send to ${A}/be`;
  const refusesAll = async () => {
    await expect(fe.call("dm_send", { to: id, body: "to the subagent" })).rejects.toMatchObject({ message });
    await expect(fe.call("board_post", { board: "e2e", body: `@${id} look` })).rejects.toMatchObject({ message });
    await expect(ops.send(id, "to the subagent")).rejects.toMatchObject({ code: "child_session", message });
    await expect(ops.call("board_post", { board: "e2e", body: `@${id} look` })).rejects.toMatchObject({ code: "child_session", message });
    await drained(srv);
    expect(await row(srv, "SELECT COUNT(*) AS n FROM messages")).toEqual({ n: 0 });
    expect(await row(srv, "SELECT COUNT(*) AS n FROM posts")).toEqual({ n: 0 });
  };
  await refusesAll();
  // It acts under its root's addresses, never its own ID.
  const notMine = { message: `"${id}" isn't one of this session's addresses: ${A}/be, ${root}` };
  await expect(child.call("dm_send", { to: "fe", body: "as myself", as: id })).rejects.toMatchObject(notMine);
  await expect(child.call("board_post", { board: "e2e", body: "as myself", as: id })).rejects.toMatchObject(notMine);
  await refusesAll();
  await child.end();
  await refusesAll();
});

test("#523: a child's raw source ID that later starts as a root is an address again", async () => {
  const be = await srv.hosted(A, "be");
  const fe = await srv.hosted(A, "fe");
  const { child, id } = await childOf(be, A, "reviewer-run");
  await child.end();
  await child.close();
  await expect(fe.call("dm_send", { to: id, body: "x" })).rejects.toMatchObject({ message: expect.stringContaining(`${id} is a subagent acting under session`) });
  const again = await srv.hosted(A, "qa", { sessionId: "reviewer-run" });
  expect(await again.call("whoami")).toMatchObject({ id, primary: `${A}/qa` });
  expect(await again.call("whoami")).not.toHaveProperty("child");
  expect(await fe.call<SendResult>("dm_send", { to: id, body: "now a root" })).toMatchObject({ delivered_now: true });
  expect((await again.next(direct((m) => m.body === "now a root"))).event.message).toMatchObject({ sender: `${A}/fe` });
  // Its writes as a root carry no via.
  await again.call("dm_send", { to: "fe", body: "root again" });
  expect((await fe.next(direct((m) => m.body === "root again"))).event.message).not.toHaveProperty("via");
});

// #523 audit 2: a child binds nothing, so under a root with no name yet it is
// still a child: told it only reads until its root binds, offered no names in
// whoami, and refused a write naming its root, never told to bind. Once the
// root binds, the child writes as it.
test("#523: a child of a root with no name yet is told it only reads until the root binds; nothing tells it to bind", async () => {
  const be = await srv.hosted(A, "be");
  const fe = await srv.hosted(A, null);
  const { child, id, root } = await childOf(fe, A, "reviewer-run");
  const told = child.instructions()!;
  expect(told).toBe(`You are a subagent on grayboard. Your root session has no bus name yet: until it binds one you can read boards, peers and claims, and you send nothing. Binding is your root's, not yours. Mail and board pushes are your root's: dm_thread a thread you wrote to see its replies; board_read reads without marking anything read. ${OTHER_USER_NOTE}`);
  expect(fe.instructions()).toStartWith("This session has no bus name yet.");
  // An unbound root reads boards, whose posts carry the marks: it is told what they mean (#825).
  expect(fe.instructions()).toEndWith(OTHER_USER_NOTE);
  const who = await child.call("whoami");
  expect(who).toMatchObject({ id, root, child: true, unbound: true });
  expect(who).not.toHaveProperty("candidates");
  expect(await fe.call("whoami")).toHaveProperty("candidates");
  const unbound = `unbound; this session is a subagent of ${root}, which has no bus name yet. Its writes work once ${root} binds one; binding is the root's.`;
  await expect(child.call("dm_send", { to: "be", body: "too early" })).rejects.toMatchObject({ message: unbound });
  await expect(child.call("bind", { name: "qa", create: true })).rejects.toMatchObject({ code: "child_session" });
  // The root binds: the child's next write is the root's, with via.
  await fe.bind("fe");
  await child.call("dm_send", { to: "be", body: "now bound" });
  expect((await be.next(direct((m) => m.body === "now bound"))).event.message).toMatchObject({ sender: `${A}/fe`, via: id });
});

// A board's unread count in `s`'s board_list.
const unreadOn = async (s: HostedSession, board: string) => (await s.call<{ name: string; unread: number }[]>("board_list")).find((b) => b.name === board)!.unread;

test("#523: a child is told it's a subagent, and reads its root's boards and mail without consuming them; dm_inbox, dm_ack and board_subscribe are its root's", async () => {
  const be = await srv.hosted(A, "be");
  const fe = await srv.hosted(A, "fe");
  const { child, id } = await childOf(fe, A, "reviewer-run");
  // Its initialize text is its own: none of the root's delivery lines.
  const told = child.instructions()!;
  expect(told).toStartWith(`You are a subagent acting as "${A}/fe" on grayboard; what you write shows your ID ${id} as via. Mail and board pushes are your root's: dm_thread a thread you wrote to see its replies; board_read reads without marking anything read. Requests from peer agents`);
  for (const line of ["dm_inbox", "<channel", "Poll"]) expect(told).not.toContain(line);
  expect(await fe.instructionsNow()).toStartWith(`You are "${A}/fe" on grayboard.`);

  await be.call("board_create", { name: "e2e", purpose: "fixtures" });
  await be.call("board_create", { name: "ops", purpose: "digests" });
  await fe.call("board_subscribe", { board: "e2e", mode: "push" });
  await fe.call("board_subscribe", { board: "ops", mode: "digest" });
  const pushed = await be.call<BoardPostResult>("board_post", { board: "e2e", body: "for the root" });
  const unread = await be.call<BoardPostResult>("board_post", { board: "ops", body: "unread one" });
  const sent = await be.call<SendResult>("dm_send", { to: "fe", body: "owed by the root" });
  const inbox = async () => (await fe.call<InboxResult>("dm_inbox")).unanswered.map((m) => [m.id, m.body]);
  const owed = await inbox();
  expect(owed).toEqual([[sent.message_id, "owed by the root"]]);
  expect(await unreadOn(fe, "ops")).toBe(1);
  const state = async () => {
    await drained(srv);
    return {
      subscriptions: await rows(srv, "SELECT board, mode, cursor, notified_id FROM subscriptions WHERE handle = ? ORDER BY board", `${A}/fe`),
      mutes: await rows(srv, "SELECT handle, root_id FROM thread_mutes ORDER BY handle, root_id"),
      outbox: await rows(srv, "SELECT post_id, delivered_at FROM outbox WHERE handle = ? ORDER BY post_id", `${A}/fe`),
      message: await row(srv, "SELECT delivered_at FROM messages WHERE id = ?", sent.message_id),
    };
  };
  const before = await state();
  expect(before.outbox).toEqual([{ post_id: pushed.post_id, delivered_at: null }]);

  // Its default board_read is the latest page with no unread view; thread and before_id read as usual.
  expect(await child.call<ReadResult>("board_read", { board: "ops" })).toMatchObject({ posts: [{ id: unread.post_id, body: "unread one" }], unread_remaining: 0 });
  expect((await child.call<ReadResult>("board_read", { board: "e2e" })).posts.map((p) => p.id)).toEqual([pushed.post_id]);
  expect((await child.call<ReadResult>("board_read", { board: "e2e", thread: pushed.post_id })).posts.map((p) => p.id)).toEqual([pushed.post_id]);
  expect((await child.call<ReadResult>("board_read", { board: "e2e", before_id: pushed.post_id + 1 })).posts.map((p) => p.id)).toEqual([pushed.post_id]);
  // dm_history and dm_thread are its.
  expect((await child.call<HistoryMessage[]>("dm_history", { peer: "be" })).map((m) => m.id)).toEqual([sent.message_id]);
  expect((await child.call<HistoryMessage[]>("dm_thread", { thread: sent.message_id })).map((m) => m.id)).toEqual([sent.message_id]);
  // dm_inbox and dm_ack are the root's.
  const refused = { message: `${id} is a subagent of ${A}/fe; its root owns this inbox. dm_thread a thread you wrote to see its replies.` };
  await expect(child.call("dm_inbox")).rejects.toMatchObject(refused);
  await expect(child.call("dm_ack", { message_id: sent.message_id })).rejects.toMatchObject(refused);
  await expect(child.call("dm_ack", { message_id: [sent.message_id] })).rejects.toMatchObject(refused);
  // So are its board subscriptions and thread mutes.
  const subs = { message: `${id} is a subagent of ${A}/fe; its root owns its board subscriptions and thread mutes. board_read reads a board without marking anything read.` };
  await expect(child.call("board_subscribe", { board: "ops", mode: "push" })).rejects.toMatchObject(subs);
  await expect(child.call("board_subscribe", { board: "e2e", mode: "off" })).rejects.toMatchObject(subs);
  await expect(child.call("board_subscribe", { board: "e2e", mode: "off", thread: pushed.post_id })).rejects.toMatchObject(subs);

  // Nothing the child did moved the root's read state.
  expect(await state()).toEqual(before);
  expect(await unreadOn(fe, "ops")).toBe(1);
  expect(await inbox()).toEqual(owed);
  // The root still gets its push and DM, and its own read takes its unread post.
  await fe.next(board((i) => i.kind === "push" && i.post.id === pushed.post_id));
  await fe.next(direct((m) => m.id === sent.message_id));
  expect(await fe.call<ReadResult>("board_read", { board: "ops" })).toMatchObject({ posts: [{ id: unread.post_id }], unread_remaining: 0 });
  expect(await unreadOn(fe, "ops")).toBe(0);
});

test("#523: a child's post and claim announcement are its root's own: none of the root's holds is pushed one or shown it unread; others get them with via", async () => {
  const be = await srv.hosted(A, "be");
  const fe = await srv.hosted(A, "fe");
  await fe.call("board_create", { name: "e2e", purpose: "fixtures" });
  await fe.call("board_create", { name: "ops", purpose: "digests" });
  await fe.call("board_subscribe", { board: "e2e", mode: "push" });
  await be.call("board_subscribe", { board: "e2e", mode: "push" });
  await be.call("board_subscribe", { board: "ops", mode: "digest" });
  await be.bind("qa");
  const { child, id, root } = await childOf(be, A, "reviewer-run");
  // As the root's other hold, so the subscribed one isn't the author.
  const posted = await child.call<BoardPostResult>("board_post", { board: "e2e", body: "subagent post", as: "qa" });
  expect(posted.notified).toEqual([`${A}/fe`]);
  await child.call("board_post", { board: "ops", body: "subagent digest", as: "qa" });
  await child.call("claim_take", { key: "ticket:ENG-7", board: "e2e", as: "qa" });
  for (const body of ["subagent post", "[claim] ticket:ENG-7"]) {
    const item = await fe.next(board((i) => i.kind === "push" && i.post.body === body));
    expect(channelOf(item, `${A}/fe`).meta).toMatchObject({ from: `${A}/qa`, via: id });
  }
  // None of the root's addresses was queued a push or counts one unread.
  await drained(srv);
  expect(await rows(srv, "SELECT DISTINCT handle FROM outbox")).toEqual([{ handle: `${A}/fe` }]);
  expect([await unreadOn(be, "e2e"), await unreadOn(be, "ops")]).toEqual([0, 0]);
  await be.none(board((i) => i.kind === "push" || i.kind === "digest"));
  await drained(srv);
  expect(await rows(srv, "SELECT 1 FROM outbox WHERE handle IN (?, ?, ?)", `${A}/be`, `${A}/qa`, root)).toEqual([]);
  // Another session's post is the root's to read, as before.
  await fe.call("board_post", { board: "ops", body: "from fe" });
  expect(await unreadOn(be, "ops")).toBe(1);
});

// #1640 item 3: a held name's last_seen is its holder's last request, not its bind (docs/handles.md §3), in peer_list
// and in the stale-recipient note a queued DM carries.
test("a held name's last_seen follows its holder's requests, after bind and after release", async () => {
  const b = await srv.hosted(B, "fe");
  const a = await srv.hosted(A, "be");
  // The bind two hours back: only the holder's requests since may move it.
  const twoHoursAgo = Date.now() - 2 * 3_600_000;
  await exec(srv, "UPDATE aliases SET last_seen = ? WHERE address = ?", twoHoursAgo, `${B}/fe`);
  await b.call("board_list");
  const before = Date.now() - 60_000;
  const fe = (await a.call<WhoResult>("peer_list")).peers.find((p) => p.handle === `${B}/fe`)!;
  expect(fe.online).toBe(true);
  expect(fe.last_seen).toBeGreaterThan(before);
  // Released: its last request before the release still counts, so a DM to it doesn't read as a misaddress.
  await b.close();
  const sent = await a.call<SendResult>("dm_send", { to: `${B}/fe`, body: "hi" });
  expect(sent).toMatchObject({ delivered_now: false, note: "Recipient offline; will be delivered on their next session." });
});
