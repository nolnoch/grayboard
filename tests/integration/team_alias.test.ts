// #284 S9: team membership is checked for the life of a hold, not only at
// bind. A user who leaves a team, or is removed, stops acting as its aliases:
// a holder keeps its ID, a tools-only connection writing as one ends, and
// revalidate() is the backstop for a membership changed behind the server.
// A team alias is held by application sessions: a hosted session holds one
// person-scope name (#451). There is no WSS transport to tell a holder (#282):
// a revocation is the database's (hold released, binding event, audit), and
// the application session isn't told, so these assert that state.
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { WhoResult } from "../../src/core/boards.ts";
import type { AppSession } from "../support/app_session.ts";
import { direct } from "../support/events.ts";
import { closeSessions } from "../support/mcp.ts";
import { TestServer } from "../support/server.ts";

const B = "bob@example.com";
let srv: TestServer;
let alice: string;
let bob: string;

beforeEach(async () => {
  // Inbox polling spends hosted requests.
  srv = new TestServer({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 } });
  alice = await srv.login("alice@example.com");
  bob = await srv.login(B);
  expect((await srv.api(alice, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
  expect((await srv.api(alice, "POST", "/api/teams/eng/add", { email: B })).status).toBe(200);
});
afterEach(async () => {
  await closeSessions();
  await srv.stop();
});

const rows = (sql: string, ...args: string[]) => srv.app.db.query(sql).all(...args);
const holder = (address: string) => rows(`SELECT id FROM alias_holds WHERE address = ?`, address).map((r: any) => r.id);
const lastEvent = (address: string) => rows(`SELECT session_id, event, detail FROM binding_events WHERE name = ? ORDER BY id DESC LIMIT 1`, address)[0];
const revoked = () => rows(`SELECT actor, target, detail FROM access_log WHERE action = 'alias.revoked' ORDER BY id`).map((r: any) => ({ ...r, detail: JSON.parse(r.detail) }));
const REASON = `${B} isn't a member of team eng`;

// hosted twin: #451 (team aliases on a session, alias_lost, a tools-only writer)
test("a removed member's sessions lose the team's aliases: a holder keeps its ID, a tools-only writer ends, a closed session's hold is dropped", async () => {
  const build = srv.appSession(bob, "eng/build");
  expect((await build.connect()).bind?.alias).toBe("eng/build");
  const writer = srv.appSession(bob, "eng/build", { push: false });
  await writer.connect();
  const deploy = srv.appSession(bob, "eng/deploy");
  await deploy.connect();
  // A closed session no longer enters a grace and ends (#282): its hold stays until revoked.
  deploy.close();
  expect(holder("eng/deploy")).toEqual([deploy.id]);
  // bob's own alias is untouched.
  const own = srv.appSession(bob, "be");
  await own.connect();

  expect((await srv.api(alice, "POST", "/api/teams/eng/remove", { email: B })).status).toBe(200);

  expect(holder("eng/build")).toEqual([]);
  expect(lastEvent("eng/build")).toEqual({ session_id: build.id, event: "released", detail: `access revoked: ${REASON}` });
  expect(holder("eng/deploy")).toEqual([]);
  expect(lastEvent("eng/deploy")).toEqual({ session_id: deploy.id, event: "released", detail: `access revoked: ${REASON}` });
  expect(holder(`${B}/be`)).toEqual([own.id]);

  // The holder keeps its ID (not ended) and can't take the alias back.
  expect(rows(`SELECT ended_at FROM ids WHERE id = ?`, build.id)).toEqual([{ ended_at: null }]);
  await expect(build.bind("eng/build")).rejects.toMatchObject({ code: "forbidden" });

  // The tools-only writer had nothing else to be: its ID ends. No transport
  // closes it with a `forbidden` frame any more.
  expect(rows(`SELECT ended_at IS NOT NULL AS ended FROM ids WHERE id = ?`, writer.id)).toEqual([{ ended: 1 }]);
  await expect(srv.appSession(bob, "eng/build", { push: false }).connect()).rejects.toMatchObject({ code: "forbidden" });

  const audited = revoked();
  expect(audited).toHaveLength(3);
  expect(audited).toEqual(expect.arrayContaining([
    // The actor is the admin who removed B; the principal is B.
    { actor: "alice@example.com", target: "eng/build", detail: { session: build.id, principal: B, reason: REASON } },
    { actor: "alice@example.com", target: "eng/build", detail: { session: writer.id, principal: B, writes_as: true, reason: REASON } },
    { actor: "alice@example.com", target: "eng/deploy", detail: { session: deploy.id, principal: B, reason: REASON } },
  ]));
  // A member can take the freed alias.
  expect((await srv.appSession(alice, "eng/build").connect()).bind?.alias).toBe("eng/build");
});

// hosted twin: #451 (team aliases on a session, alias_lost)
test("leaving a team releases its aliases from the leaver's sessions; revalidate catches a membership changed behind the server", async () => {
  let build = srv.appSession(bob, "eng/build");
  await build.connect();
  const first = build.id;
  expect((await srv.api(bob, "POST", "/api/teams/eng/leave")).status).toBe(200);
  expect(holder("eng/build")).toEqual([]);
  expect(lastEvent("eng/build")).toMatchObject({ session_id: first, event: "released" });

  // Rejoin, rebind (a new session: the old one isn't told, so still thinks it
  // holds the alias), then lose the membership without the HTTP route.
  await srv.api(alice, "POST", "/api/teams/eng/add", { email: B });
  build = srv.appSession(bob, "eng/build");
  expect((await build.connect()).bind).toMatchObject({ alias: "eng/build" });
  const team = srv.app.repo.teams.findByName("eng")!;
  srv.app.repo.teams.removeMember(team.id, srv.app.repo.users.findByEmail(B)!.id);
  expect(holder("eng/build")).toEqual([build.id]);
  srv.app.revalidate();
  expect(holder("eng/build")).toEqual([]);
  expect(lastEvent("eng/build")).toEqual({ session_id: build.id, event: "released", detail: `access revoked: ${REASON}` });
  // A member's hold survives the backstop.
  const kept = srv.appSession(alice, "eng/build");
  await kept.connect();
  srv.app.revalidate();
  expect(holder("eng/build")).toEqual([kept.id]);
});

// HTTP's ?as= takes the same check as bind (mayActIn).
// hosted twin: #451 (the hold: a team alias on a session)
test("acting as a team alias over HTTP follows membership", async () => {
  await srv.appSession(bob, "eng/build").connect();
  expect((await srv.upload(bob, "eng/build", "a.txt", "x")).status).toBe(201);
  expect((await srv.api(alice, "POST", "/api/teams/eng/remove", { email: B })).status).toBe(200);
  expect(await srv.upload(bob, "eng/build", "a.txt", "x")).toMatchObject({ status: 403, body: { code: "forbidden", message: `you can't act as "eng/build": ${REASON}` } });
});

// #284 acceptance 4, #356: eng/x is one alias, reached by a DM to its one
// holder; team:eng is the team, reached only through its board.
test("a DM to a team alias reaches its holder alone; team:eng isn't a DM recipient, its board reaches every member", async () => {
  const deploy = await srv.connected(bob, "eng/deploy");
  const bobFe = await srv.connected(bob, "fe");
  const aliceQa = await srv.connected(alice, "qa");
  const be = await srv.connected(alice, "be");

  await be.send("eng/deploy", "ship it");
  await deploy.next(direct((m) => m.body === "ship it"));
  expect(rows(`SELECT sender, recipient FROM messages WHERE body = 'ship it'`)).toEqual([{ sender: "alice@example.com/be", recipient: "eng/deploy" }]);
  await bobFe.none(direct((m) => m.body === "ship it"));
  await aliceQa.none(direct((m) => m.body === "ship it"));

  await expect(be.send("team:eng", "everyone")).rejects.toMatchObject({ message: "team:eng isn't a person; to reach a team, board_post to its board #eng" });
  expect(rows(`SELECT 1 FROM messages WHERE body = 'everyone'`)).toEqual([]);
  await be.call("board_post", { board: "eng", body: "everyone" });
  for (const s of [deploy, bobFe, aliceQa]) expect((await s.call<{ posts: { body: string }[] }>("board_read", { board: "eng" })).posts.map((p) => p.body)).toEqual(["everyone"]);
});

// A team's alias follows its own team's board, not its creator's others.
// hosted twin: #451 (a team alias on a session)
test("a lazily created team alias follows only its team's board", async () => {
  expect((await srv.api(bob, "POST", "/api/teams", { name: "ops" })).status).toBe(201);
  await srv.appSession(bob, "eng/build").connect();
  expect(rows(`SELECT board FROM subscriptions WHERE handle = 'eng/build'`)).toEqual([{ board: "eng" }]);
  expect(rows(`SELECT created_by FROM boards WHERE name = 'eng'`)).toEqual([{ created_by: "alice@example.com" }]);
});

// #349: an alias_held refusal names the holder's place (its machine and
// directory) only to the holder's own principal.
test("an alias_held refusal shows the holder's place to its own principal, not to another member", async () => {
  const build = srv.appSession(bob, "eng/build");
  expect((await build.connect()).bind?.alias).toBe("eng/build");
  srv.app.db.query(`UPDATE ids SET place = 'bob-box:~/src/secret-project' WHERE id = ?`).run(build.id);

  const other = srv.appSession(alice, "eng/build");
  const refusal = await other.connect().then(() => { throw new Error("alice's bind was not refused"); }, (e: { code: string; message: string }) => e);
  expect(refusal.code).toBe("alias_held");
  expect(refusal.message).toContain(build.id);
  expect(refusal.message).not.toContain("secret-project");

  await expect(srv.appSession(bob, "eng/build").connect()).rejects.toMatchObject({ code: "alias_held", message: expect.stringContaining(`${build.id}, in bob-box:~/src/secret-project`) });
});

// #284 S8 (decided): an alias in use is exclusive across principals. While
// bob's session holds eng/build, alice can't write as it (tools-only
// writes_as, ?as=) or bind it; while alice's tools-only session writes as
// eng/deploy, bob can't bind it. A principal's own sessions share freely.
// hosted twin: #451 (team aliases on a session, tools-only writes_as, end)
test("a team alias in use by one member's session refuses another member's writes_as, ?as= and bind", async () => {
  const build = srv.appSession(bob, "eng/build");
  expect((await build.connect()).bind?.alias).toBe("eng/build");
  // bob's own tools-only sidecar and ?as= stay allowed (#182).
  const own = srv.appSession(bob, "eng/build", { push: false });
  await own.connect();
  expect((await srv.upload(bob, "eng/build", "a.txt", "x")).status).toBe(201);

  const writer = srv.appSession(alice, "eng/build", { push: false });
  await expect(writer.connect()).rejects.toMatchObject({ code: "alias_held", message: expect.stringContaining(`another user's session ${build.id}`) });
  const up = await srv.upload(alice, "eng/build", "a.txt", "x");
  expect(up).toEqual({ status: 409, body: { code: "alias_held", message: expect.stringContaining(build.id) } });

  const sidecar = srv.appSession(alice, "eng/deploy", { push: false });
  await sidecar.connect();
  await expect(srv.appSession(bob, "eng/deploy").connect()).rejects.toMatchObject({ code: "alias_held", message: expect.stringContaining(`another user's session ${sidecar.id}`) });
  expect(holder("eng/deploy")).toEqual([]);
  expect(lastEvent("eng/deploy")).toMatchObject({ event: "refused", detail: `another user's session ${sidecar.id}` });

  // Once bob's sessions using it stop, the alias is free to alice. A close
  // leaves a hold alone (#282), so the holder unbinds; the tools-only writer's
  // ID ends, as the hosted store's end does it.
  await build.unbind("eng/build");
  expect((await srv.upload(alice, "eng/build", "a.txt", "x")).status).toBe(409);
  srv.app.db.query(`UPDATE ids SET ended_at = ? WHERE id = ?`).run(Date.now(), own.id);
  expect((await srv.upload(alice, "eng/build", "a.txt", "x")).status).toBe(201);
});

// #284 PR 4: a revocation takes only the alias it revokes. A session holding
// two team aliases keeps the other, and the oldest hold left is its primary.
// hosted twin: #451 (team aliases on a session, multi-alias holds, alias_lost)
test("losing one of two team aliases keeps the other, which becomes the primary", async () => {
  expect((await srv.api(alice, "POST", "/api/teams", { name: "ops" })).status).toBe(201);
  expect((await srv.api(alice, "POST", "/api/teams/ops/add", { email: B })).status).toBe(200);
  const s = srv.appSession(bob, "eng/build");
  await s.connect();
  expect(await s.bind("ops/run", { create: true })).toMatchObject({ alias: "ops/run", held: ["eng/build", "ops/run"] });
  const peer = srv.appSession(alice, "fe");
  await peer.connect();
  const senderOf = async (c: AppSession) => {
    const sent = await c.send("alice@example.com/fe", "who");
    return rows(`SELECT sender FROM messages WHERE id = ?`, String(sent.message_id))[0];
  };
  expect(await senderOf(s)).toEqual({ sender: "eng/build" });

  expect((await srv.api(alice, "POST", "/api/teams/eng/remove", { email: B })).status).toBe(200);
  expect(holder("eng/build")).toEqual([]);
  expect(holder("ops/run")).toEqual([s.id]);
  // Mail to the kept alias still reaches it.
  await peer.send("ops/run", "still yours");
  await s.next(direct((m) => m.body === "still yours"));
  expect(revoked()).toEqual([{ actor: "alice@example.com", target: "eng/build", detail: { session: s.id, principal: B, reason: REASON } }]);
});

const labels = (address: string) => rows(`SELECT task, source_board FROM aliases WHERE address = ?`, address)[0];
const metaSets = (address: string) => rows(`SELECT actor, detail FROM access_log WHERE action = 'alias.meta_set' AND target = ? ORDER BY id`, address).map((r: any) => ({ ...r, detail: JSON.parse(r.detail) }));
const peerRow = async (c: AppSession, match?: Record<string, string>) =>
  (await c.call<WhoResult>("peer_list", { include_offline: true, ...(match ? { match } : {}) })).peers.find((p) => p.handle === "eng/build");

// #284 S12, S13 on the server: bind's meta labels a team alias; a re-bind of
// a held alias changes only labels that differ; the labels reach only members.
// hosted twin: #451 (a team alias on a session, bind's meta)
test("bind's meta on a session: set, checked, cleared and audited; a held re-bind keeps bound_at; a non-member sees no labels", async () => {
  const build = srv.appSession(bob, "eng/build", { bind: { create: true, meta: { task: "ENG-142", source_board: "#E2E" } }, harness: "opus" });
  expect((await build.connect()).bind).toMatchObject({ alias: "eng/build" });
  expect(labels("eng/build")).toEqual({ task: "ENG-142", source_board: "e2e" });
  expect(metaSets("eng/build")).toEqual([{ actor: build.id, detail: { address: "eng/build", fields: { task: "ENG-142", source_board: "e2e" }, session: build.id } }]);
  const boundAt = () => rows(`SELECT bound_at FROM alias_holds WHERE address = 'eng/build'`);
  const at = boundAt();
  const bound = () => rows(`SELECT event FROM binding_events WHERE name = 'eng/build'`).length;
  const events = bound();

  // Held already: the same labels write nothing; a change is audited; neither is a bind.
  expect(await build.bind("eng/build", { meta: { task: "ENG-142" } })).toMatchObject({ alias: "eng/build", held: ["eng/build"] });
  expect(metaSets("eng/build")).toHaveLength(1);
  expect(await build.bind("eng/build", { meta: { task: "" } })).toMatchObject({ alias: "eng/build" });
  expect(labels("eng/build")).toEqual({ task: null, source_board: "e2e" });
  expect(metaSets("eng/build").at(-1)!.detail).toEqual({ address: "eng/build", fields: { task: null }, session: build.id });
  expect(boundAt()).toEqual(at);
  expect(bound()).toBe(events);

  // Refusals change nothing.
  await expect(build.bind("eng/build", { meta: { task: "x".repeat(201) } })).rejects.toMatchObject({ code: "bad_request", message: "meta.task must be at most 200 chars" });
  await expect(build.bind("eng/build", { meta: { source_board: "not a board" } })).rejects.toMatchObject({ code: "bad_request", message: expect.stringContaining(`invalid board name "not a board"`) });
  expect(labels("eng/build")).toEqual({ task: null, source_board: "e2e" });
  expect(await build.bind("eng/build", { meta: { task: "ENG-142" } })).toMatchObject({ alias: "eng/build" });

  // A non-member can't bind it, so can't label it.
  const carol = await srv.login("carol@example.com");
  const outsider = srv.appSession(carol, null);
  await outsider.connect();
  await expect(outsider.bind("eng/build", { meta: { task: "mine" } })).rejects.toMatchObject({ code: "forbidden" });
  expect(labels("eng/build")).toEqual({ task: "ENG-142", source_board: "e2e" });

  // The labels reach a member; a non-member's row has only the session's facts, and match can't probe them.
  const member = srv.appSession(alice, "fe");
  await member.connect();
  expect(await peerRow(member)).toMatchObject({ task: "ENG-142", source_board: "e2e", harness: "opus" });
  expect(await peerRow(member, { task: "eng-142" })).toBeDefined();
  const seen = (await peerRow(outsider))!;
  expect(seen).toMatchObject({ handle: "eng/build", harness: "opus" });
  expect(seen.task).toBeUndefined();
  expect(seen.source_board).toBeUndefined();
  expect(await peerRow(outsider, { task: "ENG-142" })).toBeUndefined();
});

// #284 S13: peer_list's match through the tool, each key ANDed and case-insensitive.
// hosted twin: #451 (a team alias on a session, bind's meta)
test("peer_list's match: harness, task, id and scope; an unknown key is refused", async () => {
  const build = srv.appSession(bob, "eng/build", { bind: { create: true, meta: { task: "ENG-142" } }, harness: "opus" });
  await build.connect();
  const member = srv.appSession(alice, "fe", { harness: "sonnet" });
  await member.connect();
  const handles = async (match: Record<string, string>) => (await member.call<WhoResult>("peer_list", { match })).peers.map((p) => p.handle);
  expect(await handles({ harness: "OPUS" })).toEqual(["eng/build"]);
  expect(await handles({ task: "eng-142", harness: "opus" })).toEqual(["eng/build"]);
  expect(await handles({ task: "eng-142", harness: "sonnet" })).toEqual([]);
  expect(await handles({ id: build.id })).toEqual(["eng/build"]);
  expect(await handles({ scope: "eng" })).toEqual(["eng/build"]);
  expect(await handles({ scope: "alice@example.com" })).toEqual(["alice@example.com/fe"]);
  await expect(member.call("peer_list", { match: { colour: "red" } })).rejects.toMatchObject({ message: expect.stringContaining(`match has no key "colour"`) });
});

// #356: the bind-target checks a team's scope shares with a person's, end to end.
test("a bind of human in a team's scope is refused as reserved, and creates nothing", async () => {
  await expect(srv.appSession(bob, "eng/human").connect()).rejects.toMatchObject({ code: "forbidden", message: expect.stringContaining(`"human" is reserved`) });
  expect(rows(`SELECT address FROM aliases WHERE address = 'eng/human'`)).toEqual([]);
});

test("a bind in a service principal's scope is refused until #270, and creates nothing", async () => {
  srv.app.db.prepare(`INSERT INTO principals (kind, name, created_at) VALUES ('service', 'ingest', 0)`).run();
  await expect(srv.appSession(bob, "ingest/worker").connect()).rejects.toMatchObject({ code: "forbidden", message: expect.stringContaining("service principals arrive with #270") });
  expect(rows(`SELECT address FROM aliases WHERE address = 'ingest/worker'`)).toEqual([]);
});
