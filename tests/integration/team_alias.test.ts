// #284 S9: team membership is checked for the life of a hold, not only at
// bind. A user who leaves a team, or is removed, stops acting as its aliases:
// a holder keeps its ID, a tools-only connection writing as one ends, and
// revalidate() is the backstop for a membership changed behind the server.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { closeSessions } from "../support/mcp.ts";
import { TestServer } from "../support/server.ts";
import { until } from "../support/until.ts";
import type { Any } from "../support/ws_client.ts";

const B = "bob@example.com";
let srv: TestServer;
let alice: string;
let bob: string;

beforeEach(async () => {
  srv = new TestServer();
  alice = await srv.login("alice@example.com");
  bob = await srv.login(B);
  expect((await srv.api(alice, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
  expect((await srv.api(alice, "POST", "/api/teams/eng/add", { email: B })).status).toBe(200);
});
afterEach(async () => {
  await closeSessions();
  srv.stop();
});

const rows = (sql: string, ...args: string[]) => srv.app.db.query(sql).all(...args);
const holder = (address: string) => rows(`SELECT id FROM alias_holds WHERE address = ?`, address).map((r: any) => r.id);
const lastEvent = (address: string) => rows(`SELECT session_id, event, detail FROM binding_events WHERE name = ? ORDER BY id DESC LIMIT 1`, address)[0];
const revoked = () => rows(`SELECT actor, target, detail FROM access_log WHERE action = 'alias.revoked' ORDER BY id`).map((r: any) => ({ ...r, detail: JSON.parse(r.detail) }));
const REASON = `${B} isn't a member of team eng`;

test("a removed member's sessions lose the team's aliases: a holder keeps its ID, a tools-only writer ends, a grace hold is dropped", async () => {
  const build = srv.client(bob, "eng/build");
  expect((await build.connect()).bind_ok.alias).toBe("eng/build");
  const writer = srv.client(bob, "eng/build", { push: false });
  expect(await writer.connect()).toMatchObject({ type: "hello_ok" });
  const deploy = srv.client(bob, "eng/deploy");
  await deploy.connect();
  deploy.close();
  await until(() => rows(`SELECT 1 FROM access_log WHERE action = 'id.detached' AND target = ?`, deploy.id).length > 0);
  // bob's own alias is untouched.
  const own = srv.client(bob, "be");
  await own.connect();

  expect((await srv.api(alice, "POST", "/api/teams/eng/remove", { email: B })).status).toBe(200);

  expect(await build.next((m: Any) => m.type === "alias_lost")).toEqual({ type: "alias_lost", alias: "eng/build", reason: REASON });
  expect(holder("eng/build")).toEqual([]);
  expect(lastEvent("eng/build")).toEqual({ session_id: build.id, event: "released", detail: `access revoked: ${REASON}` });
  expect(holder("eng/deploy")).toEqual([]);
  expect(lastEvent("eng/deploy")).toEqual({ session_id: deploy.id, event: "released", detail: `access revoked: ${REASON}` });
  expect(holder(`${B}/be`)).toEqual([own.id]);
  await own.none((m: Any) => m.type === "alias_lost");

  // The holder is live and acts as its ID now.
  expect(rows(`SELECT ended_at FROM ids WHERE id = ?`, build.id)).toEqual([{ ended_at: null }]);
  const sent = await build.request({ type: "send", recipient: `${B}/be`, body: "still here" });
  expect(sent).toMatchObject({ type: "send_ok" });
  expect(rows(`SELECT sender FROM messages WHERE id = ?`, String(sent.message_id))).toEqual([{ sender: build.id }]);
  expect((await build.bind("eng/build")).code).toBe("forbidden");

  // The tools-only writer had nothing else to be: refused, closed, ended.
  expect(await writer.next((m: Any) => m.type === "error")).toMatchObject({ code: "forbidden", message: `this connection wrote as "eng/build", and ${REASON}` });
  expect(rows(`SELECT ended_at IS NOT NULL AS ended FROM ids WHERE id = ?`, writer.id)).toEqual([{ ended: 1 }]);
  expect((await srv.client(bob, "eng/build", { push: false }).connect()).code).toBe("forbidden");

  const audited = revoked();
  expect(audited).toHaveLength(3);
  expect(audited).toEqual(expect.arrayContaining([
    // The actor is the admin who removed B; the principal is B.
    { actor: "alice@example.com", target: "eng/build", detail: { session: build.id, principal: B, reason: REASON } },
    { actor: "alice@example.com", target: "eng/build", detail: { session: writer.id, principal: B, writes_as: true, reason: REASON } },
    { actor: "alice@example.com", target: "eng/deploy", detail: { session: deploy.id, principal: B, reason: REASON } },
  ]));
  // A member can take the freed alias.
  expect((await srv.client(alice, "eng/build").connect()).bind_ok.alias).toBe("eng/build");
});

test("leaving a team releases its aliases from the leaver's sessions; revalidate catches a membership changed behind the server", async () => {
  const build = srv.client(bob, "eng/build");
  await build.connect();
  expect((await srv.api(bob, "POST", "/api/teams/eng/leave")).status).toBe(200);
  expect(await build.next((m: Any) => m.type === "alias_lost")).toMatchObject({ alias: "eng/build" });

  // Rejoin, rebind, then lose the membership without the HTTP route.
  await srv.api(alice, "POST", "/api/teams/eng/add", { email: B });
  expect((await build.bind("eng/build")).type).toBe("bind_ok");
  const team = srv.app.repo.teams.findByName("eng")!;
  srv.app.repo.teams.removeMember(team.id, srv.app.repo.users.findByEmail(B)!.id);
  await build.none((m: Any) => m.type === "alias_lost");
  srv.app.revalidate();
  expect(await build.next((m: Any) => m.type === "alias_lost")).toEqual({ type: "alias_lost", alias: "eng/build", reason: REASON });
  // A member's hold survives the backstop.
  const kept = srv.client(alice, "eng/build");
  await kept.connect();
  srv.app.revalidate();
  expect(holder("eng/build")).toEqual([kept.id]);
});

test("the plugin drops a lost team alias and says so in the next tool result", async () => {
  const s = await srv.session(bob, "eng/build");
  expect((await s.call("peer_list", {})).you).toBe("eng/build");
  expect((await srv.api(alice, "POST", "/api/teams/eng/remove", { email: B })).status).toBe(200);
  await until(() => s.stderr().includes(`lost "eng/build"`));
  const r = await s.c.callTool({ name: "peer_list", arguments: {} });
  const id = JSON.parse((r.content as { text: string }[])[0]!.text).you;
  expect(id).toMatch(/^id:[0-9a-z]{13}$/);
  expect((r.content as { text: string }[]).slice(1).map((c) => c.text)).toContain(
    `This session lost its bus name "eng/build": ${REASON}. It acts as its ID (${id}) now: bind(name) to take another.`,
  );
  expect((r.structuredContent as { name: string | null }).name).toBeNull();
}, 20_000);

// HTTP's ?as= takes the same check as bind (mayActIn).
test("acting as a team alias over HTTP follows membership", async () => {
  await srv.client(bob, "eng/build").connect();
  expect((await srv.upload(bob, "eng/build", "a.txt", "x")).status).toBe(201);
  expect((await srv.api(alice, "POST", "/api/teams/eng/remove", { email: B })).status).toBe(200);
  expect(await srv.upload(bob, "eng/build", "a.txt", "x")).toMatchObject({ status: 403, body: { code: "forbidden", message: `you can't act as "eng/build": ${REASON}` } });
});

// A team's alias follows its own team's board, not its creator's others.
test("a lazily created team alias follows only its team's board", async () => {
  expect((await srv.api(bob, "POST", "/api/teams", { name: "ops" })).status).toBe(201);
  await srv.client(bob, "eng/build").connect();
  expect(rows(`SELECT board FROM subscriptions WHERE handle = 'eng/build'`)).toEqual([{ board: "eng" }]);
  expect(rows(`SELECT created_by FROM boards WHERE name = 'eng'`)).toEqual([{ created_by: "alice@example.com" }]);
});

// #284 S8 (decided): an alias in use is exclusive across principals. While
// bob's session holds eng/build, alice can't write as it (tools-only
// writes_as, ?as=) or bind it; while alice's tools-only session writes as
// eng/deploy, bob can't bind it. A principal's own sessions share freely.
test("a team alias in use by one member's session refuses another member's writes_as, ?as= and bind", async () => {
  const build = srv.client(bob, "eng/build");
  expect((await build.connect()).bind_ok.alias).toBe("eng/build");
  // bob's own tools-only sidecar and ?as= stay allowed (#182).
  const own = srv.client(bob, "eng/build", { push: false });
  expect(await own.connect()).toMatchObject({ type: "hello_ok" });
  expect((await srv.upload(bob, "eng/build", "a.txt", "x")).status).toBe(201);

  const writer = srv.client(alice, "eng/build", { push: false });
  expect(await writer.connect()).toMatchObject({ type: "error", code: "alias_held", message: expect.stringContaining(`another user's session ${build.id}`) });
  expect(lastEvent("eng/build")).toMatchObject({ event: "refused", detail: `another user's session ${build.id}` });
  const up = await srv.upload(alice, "eng/build", "a.txt", "x");
  expect(up).toEqual({ status: 409, body: { code: "alias_held", message: expect.stringContaining(build.id) } });

  const sidecar = srv.client(alice, "eng/deploy", { push: false });
  expect(await sidecar.connect()).toMatchObject({ type: "hello_ok" });
  const bind = await srv.client(bob, "eng/deploy").connect();
  expect(bind).toMatchObject({ type: "error", code: "alias_held", message: expect.stringContaining(`another user's session ${sidecar.id}`) });
  expect(holder("eng/deploy")).toEqual([]);

  // Once bob's sessions using it end, the alias is free to alice.
  expect(await build.request({ type: "end" })).toMatchObject({ type: "end_ok" });
  expect((await srv.upload(alice, "eng/build", "a.txt", "x")).status).toBe(409);
  expect(await own.request({ type: "end" })).toMatchObject({ type: "end_ok" });
  expect((await srv.upload(alice, "eng/build", "a.txt", "x")).status).toBe(201);
});

// #284 PR 4: a revocation takes only the alias it revokes. A session holding
// two team aliases keeps the other, and the oldest hold left is its primary.
test("losing one of two team aliases keeps the other, which becomes the primary", async () => {
  expect((await srv.api(alice, "POST", "/api/teams", { name: "ops" })).status).toBe(201);
  expect((await srv.api(alice, "POST", "/api/teams/ops/add", { email: B })).status).toBe(200);
  const s = srv.client(bob, "eng/build");
  await s.connect();
  expect(await s.bind("ops/run", { create: true })).toMatchObject({ type: "bind_ok", held: ["eng/build", "ops/run"] });
  const peer = srv.client(alice, "fe");
  await peer.connect();
  const senderOf = async (c: typeof s) => {
    const sent = await c.request({ type: "send", recipient: "alice@example.com/fe", body: "who" });
    expect(sent).toMatchObject({ type: "send_ok" });
    return rows(`SELECT sender FROM messages WHERE id = ?`, String(sent.message_id))[0];
  };
  expect(await senderOf(s)).toEqual({ sender: "eng/build" });

  expect((await srv.api(alice, "POST", "/api/teams/eng/remove", { email: B })).status).toBe(200);
  expect(await s.next((m: Any) => m.type === "alias_lost")).toEqual({ type: "alias_lost", alias: "eng/build", reason: REASON });
  expect(holder("eng/build")).toEqual([]);
  expect(holder("ops/run")).toEqual([s.id]);
  expect(await senderOf(s)).toEqual({ sender: "ops/run" });
  // Mail to the kept alias still reaches it.
  expect(await peer.request({ type: "send", recipient: "ops/run", body: "still yours" })).toMatchObject({ type: "send_ok" });
  expect(await s.next((m: Any) => m.type === "push" && m.message.body === "still yours")).toBeDefined();
  expect(revoked()).toEqual([{ actor: "alice@example.com", target: "eng/build", detail: { session: s.id, principal: B, reason: REASON } }]);
});

const labels = (address: string) => rows(`SELECT task, source_board FROM aliases WHERE address = ?`, address)[0];
const metaSets = (address: string) => rows(`SELECT actor, detail FROM access_log WHERE action = 'alias.meta_set' AND target = ? ORDER BY id`, address).map((r: any) => ({ ...r, detail: JSON.parse(r.detail) }));
const peerRow = async (c: { call: (t: string, a?: Record<string, unknown>) => Promise<Any> }, match?: Record<string, string>) =>
  ((await c.call("peer_list", { include_offline: true, ...(match ? { match } : {}) })).result.peers as Any[]).find((p) => p.handle === "eng/build");

// #284 S12, S13 over the server: bind's meta labels a team alias; a re-bind of
// a held alias changes only labels that differ; the labels reach only members.
test("bind's meta over WSS: set, checked, cleared and audited; a held re-bind keeps bound_at; a non-member sees no labels", async () => {
  const build = srv.client(bob, "eng/build", { bind: { create: true, meta: { task: "ENG-142", source_board: "#E2E" } }, hello: { model: "opus" } });
  expect((await build.connect()).bind_ok).toMatchObject({ alias: "eng/build" });
  expect(labels("eng/build")).toEqual({ task: "ENG-142", source_board: "e2e" });
  expect(metaSets("eng/build")).toEqual([{ actor: build.id, detail: { address: "eng/build", fields: { task: "ENG-142", source_board: "e2e" }, session: build.id } }]);
  const boundAt = () => rows(`SELECT bound_at FROM alias_holds WHERE address = 'eng/build'`);
  const at = boundAt();
  const bound = () => rows(`SELECT event FROM binding_events WHERE name = 'eng/build'`).length;
  const events = bound();

  // Held already: the same labels write nothing; a change is audited; neither is a bind.
  expect(await build.bind("eng/build", { meta: { task: "ENG-142" } })).toMatchObject({ type: "bind_ok", held: ["eng/build"] });
  expect(metaSets("eng/build")).toHaveLength(1);
  expect(await build.bind("eng/build", { meta: { task: "" } })).toMatchObject({ type: "bind_ok" });
  expect(labels("eng/build")).toEqual({ task: null, source_board: "e2e" });
  expect(metaSets("eng/build").at(-1)!.detail).toEqual({ address: "eng/build", fields: { task: null }, session: build.id });
  expect(boundAt()).toEqual(at);
  expect(bound()).toBe(events);

  // Refusals change nothing.
  expect(await build.bind("eng/build", { meta: { task: "x".repeat(201) } })).toMatchObject({ type: "error", code: "bad_request", message: "meta.task must be at most 200 chars" });
  expect(await build.bind("eng/build", { meta: { source_board: "not a board" } })).toMatchObject({ type: "error", code: "bad_request", message: expect.stringContaining(`invalid board name "not a board"`) });
  expect(labels("eng/build")).toEqual({ task: null, source_board: "e2e" });
  expect(await build.bind("eng/build", { meta: { task: "ENG-142" } })).toMatchObject({ type: "bind_ok" });

  // A non-member can't bind it, so can't label it.
  const carol = await srv.login("carol@example.com");
  const outsider = srv.client(carol, null);
  await outsider.connect();
  expect(await outsider.bind("eng/build", { meta: { task: "mine" } })).toMatchObject({ type: "error", code: "forbidden" });
  expect(labels("eng/build")).toEqual({ task: "ENG-142", source_board: "e2e" });

  // The labels reach a member; a non-member's row has only the session's facts, and match can't probe them.
  const member = srv.client(alice, "fe");
  await member.connect();
  expect(await peerRow(member)).toMatchObject({ task: "ENG-142", source_board: "e2e", model: "opus" });
  expect(await peerRow(member, { task: "eng-142" })).toBeDefined();
  const seen = (await peerRow(outsider))!;
  expect(seen).toMatchObject({ handle: "eng/build", model: "opus" });
  expect(seen.task).toBeUndefined();
  expect(seen.source_board).toBeUndefined();
  expect(await peerRow(outsider, { task: "ENG-142" })).toBeUndefined();
});

// #284 S13: peer_list's match through the tool, each key ANDed and case-insensitive.
test("peer_list's match over WSS: model, task, id and scope; an unknown key is refused", async () => {
  const build = srv.client(bob, "eng/build", { bind: { create: true, meta: { task: "ENG-142" } }, hello: { model: "opus" } });
  await build.connect();
  const member = srv.client(alice, "fe", { hello: { model: "sonnet" } });
  await member.connect();
  const handles = async (match: Record<string, string>) => ((await member.call("peer_list", { match })).result.peers as Any[]).map((p) => p.handle);
  expect(await handles({ model: "OPUS" })).toEqual(["eng/build"]);
  expect(await handles({ task: "eng-142", model: "opus" })).toEqual(["eng/build"]);
  expect(await handles({ task: "eng-142", model: "sonnet" })).toEqual([]);
  expect(await handles({ id: build.id })).toEqual(["eng/build"]);
  expect(await handles({ scope: "eng" })).toEqual(["eng/build"]);
  expect(await handles({ scope: "alice@example.com" })).toEqual(["alice@example.com/fe"]);
  expect(await member.call("peer_list", { match: { colour: "red" } })).toMatchObject({ type: "error", message: expect.stringContaining(`match has no key "colour"`) });
});
