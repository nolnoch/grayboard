// Session end on the server (#284 S4, S10), at the application level (#282).
// The WSS transport is gone, and with it `end`, the grace and its sweep and a
// hello's resume: a closed session keeps its holds (alias_holds is the hosted
// store's truth), and what ends a session the hosted store doesn't own is the
// server's start (why "wss_removed", the leftovers of a previous run) and a
// revoked tools-only alias (why "revoked"). An end bounces the ID's unread
// mail to live senders and releases its claims.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { runRetention } from "../../src/server/retention.ts";
import { direct } from "../support/events.ts";
import { TestServer } from "../support/server.ts";
import { drained, row as sqlRow, rows } from "../support/repo_sql.ts";

const A = "alice@example.com";
let srv: TestServer;
let clock: number;

const OVERRIDES = { admins: ["root@example.com"] };
const start = () => TestServer.open(OVERRIDES, { now: () => clock });

beforeEach(async () => {
  clock = Date.now();
  srv = await start();
});
afterEach(async () => {
  await srv.stop();
});

const row = (id: string) => sqlRow<{ ended_at: number | null; held_aliases_json: string | null }>(srv, `SELECT ended_at, held_aliases_json FROM ids WHERE id = ?`, id);
const holder = async (address: string) => (await sqlRow<{ id: string }>(srv, `SELECT id FROM alias_holds WHERE address = ?`, address))?.id ?? null;
const lastEvent = (address: string) => sqlRow(srv, `SELECT session_id, event, detail FROM binding_events WHERE name = ? ORDER BY id DESC LIMIT 1`, address);
// An audit row is a post: queued on Postgres, so drain before reading it.
const ended = async (id: string) => { await drained(srv); return (await rows<{ detail: string }>(srv, `SELECT detail FROM access_log WHERE action = 'id.ended' AND target = ?`, id)).map((r) => JSON.parse(r.detail)); };

// The server restarts on its database: every session the hosted store doesn't
// own, which nothing can reattach, is ended as it starts.
async function restart(): Promise<void> {
  srv = await srv.restart(OVERRIDES, { now: () => clock });
  await srv.app.ready;
}

// hosted twin: #451 (end)
test("a restart ends a leftover session: holds released, claims of its ID released, unread mail bounced to a sender's next holder", async () => {
  let alice = await srv.login(A);
  let bob = await srv.login("bob@example.com");
  const a = await srv.connected(alice, "be");
  const b = await srv.connected(bob, "fe");
  // A claim taken as the alias stays with it (S6); an unbound session can take none (#229).
  await a.call("claim_take", { key: "ticket:ENG-142" });
  // Pushed to the ID and never acked: unread when it ends.
  const sent = await b.send(a.id, "still there?");
  expect(sent).toMatchObject({ delivered_now: true });
  await a.next(direct());
  // A closed session keeps its hold: nothing but an end releases it.
  a.close();
  expect(await holder(`${A}/be`)).toBe(a.id);

  await restart();
  alice = await srv.login(A);
  bob = await srv.login("bob@example.com");
  expect(await row(a.id)).toEqual({ ended_at: clock, held_aliases_json: JSON.stringify([`${A}/be`]) });
  expect(await holder(`${A}/be`)).toBeNull();
  expect(await lastEvent(`${A}/be`)).toEqual({ session_id: a.id, event: "released", detail: "session_end: wss_removed" });
  expect(await ended(a.id)).toEqual([{ principal: A, held: [`${A}/be`], why: "wss_removed", bounced: 1 }]);

  // The bounce waits for the sender's alias, and its next holder gets it.
  const b2 = await srv.connected(bob, "fe");
  expect((await b2.call<{ key: string; holder: string }[]>("claim_list")).map((c) => [c.key, c.holder])).toEqual([["ticket:ENG-142", `${A}/be`]]);
  const bounce = await b2.next(direct());
  expect(bounce.message).toMatchObject({ sender: a.id, parent_id: sent.message_id, kind: "bounce" });
  expect(bounce.message.body).toBe(`\`${a.id}\` ended at ${new Date(clock).toISOString()} before reading this; it held \`${A}/be\`.`);

  // Its alias is free for a new session.
  expect((await srv.appSession(alice, "be").connect()).bind?.alias).toBe(`${A}/be`);
});

// Audit F1/A1 (#345): one end that throws is audited; the other sessions in
// the same pass still end, and the pass doesn't throw. A tools-only session
// writing as a team alias ends when its principal loses the team (S9), and the
// failed one retries at the next revalidate.
test("a session whose end fails is audited and retried at the next revalidate; the others in the pass still end", async () => {
  const alice = await srv.login(A);
  const bob = await srv.login("bob@example.com");
  expect((await srv.api(alice, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
  expect((await srv.api(alice, "POST", "/api/teams/eng/add", { email: "bob@example.com" })).status).toBe(200);
  const bad = await srv.connected(bob, "eng/deploy", { push: false });
  const good = await srv.connected(bob, "eng/ops", { push: false });
  // bad's end runs whole, then fails: the savepoint must roll back everything it wrote.
  const repo = srv.app.repo, end = repo.sessionEnd.end;
  repo.sessionEnd.end = async (tx, id, opts) => {
    const out = await end(tx, id, opts);
    if (id === bad.id) throw new Error("disk on fire");
    return out;
  };

  expect((await srv.api(alice, "POST", "/api/teams/eng/remove", { email: "bob@example.com" })).status).toBe(200);
  expect((await row(good.id))!.ended_at).toBe(clock);
  // The failed end rolled back whole: the ID is as it was.
  expect((await row(bad.id))!.ended_at).toBeNull();
  await drained(srv);
  const failed = await rows<{ actor: string | null; detail: string }>(srv, `SELECT actor, detail FROM access_log WHERE action = 'id.end_failed' AND target = ?`, bad.id);
  expect(failed.map((r) => ({ actor: r.actor, ...JSON.parse(r.detail) }))).toEqual([{ actor: null, why: "revoked", error: "Error: disk on fire" }]);

  // The session still writes as an alias it may not: the next revalidate ends it.
  repo.sessionEnd.end = end;
  await srv.app.revalidate();
  expect((await row(bad.id))!.ended_at).toBe(clock);
  expect(await ended(bad.id)).toEqual([expect.objectContaining({ why: "revoked" })]);
});

// #328 (S10, S17): retention deletes an ended session's ids row on the
// message window. A keyed row would leave a tombstone, but the server no
// longer registers keyed IDs (the session key was the WSS hello's), so none
// does; the keyed tombstone and id.reused are core's, in
// src/local/retention.test.ts and session_key.test.ts.
test("retention prunes ended sessions, never a live one, and leaves no tombstone", async () => {
  let alice = await srv.login(A);
  const first = await srv.connected(alice, "be");
  const second = await srv.connected(alice, "fe");
  await restart();
  alice = await srv.login(A);
  const live = await srv.connected(alice, "api");

  const tombstones = () => rows(srv, `SELECT id, ended_at, pruned_at FROM pruned_ids`);
  // Inside the window nothing goes.
  await runRetention(srv.app.repo, srv.config, clock + 1);
  expect(await row(first.id)).not.toBeNull();
  const later = clock + (srv.config.messageRetentionDays + 1) * 86_400_000;
  await runRetention(srv.app.repo, srv.config, later);
  expect([await row(first.id), await row(second.id)]).toEqual([null, null]);
  // A live session is never pruned, however old.
  expect(await row(live.id)).toEqual({ ended_at: null, held_aliases_json: null });
  expect(await tombstones()).toEqual([]);
  // Provenance naming the pruned IDs stays: each alias keeps its last bind.
  expect(await lastEvent(`${A}/be`)).toEqual({ session_id: first.id, event: "bound", detail: null });
});

// #284 S18: a send or mention naming an ID that can't receive is refused
// with that ID's own code, not bad_request, and the same text local mode shows.
// The ended ID is a session a restart ended.
// hosted twin: #451 (tools-only)
test("a send or @id: mention to an ID that can't receive carries its code: not_found, id_ended, no_delivery", async () => {
  let alice = await srv.login(A);
  const gone = await srv.connected(alice, null);
  await restart();
  alice = await srv.login(A);
  const a = await srv.connected(alice, "be");
  const tools = await srv.connected(alice, "be", { push: false });
  await a.call("board_create", { name: "e2e", purpose: "test" });

  const at = new Date(clock).toISOString();
  await expect(a.send("id:0123456789abz", "hi")).rejects.toMatchObject({ code: "not_found", message: "no session id:0123456789abz" });
  await expect(a.send(gone.id, "hi")).rejects.toMatchObject({ code: "id_ended", message: `${gone.id} ended at ${at}; it held no alias` });
  await expect(a.send(tools.id, "hi")).rejects.toMatchObject({
    code: "no_delivery",
    message: `${tools.id} is a tools-only session and receives nothing; send to ${A}/be`,
  });
  await expect(a.call("board_post", { board: "e2e", body: `@${gone.id} hi` })).rejects.toMatchObject({ code: "id_ended", message: `${gone.id} ended at ${at}; it held no alias` });
  await expect(a.call("board_post", { board: "e2e", body: `@${tools.id} hi` })).rejects.toMatchObject({ code: "no_delivery" });
  // Nothing was written.
  expect(await sqlRow(srv, `SELECT COUNT(*) AS n FROM messages`)).toEqual({ n: 0 });
  expect(await sqlRow(srv, `SELECT COUNT(*) AS n FROM posts`)).toEqual({ n: 0 });
});

// #284 S7: a hold session takes mail like local channels-off (#71): it gets
// no pushes, and what's sent to it waits for dm_inbox. Its row says delivery
// 'push'; only tools-only is 'none'.
// hosted twin: #451 (hold session)
test("a hold session registers delivery push: a send to its ID is accepted and waits", async () => {
  const alice = await srv.login(A);
  const a = await srv.connected(alice, "be");
  const held = await srv.connected(alice, "fe", { push: false, hold: true });
  expect(await sqlRow(srv, `SELECT delivery FROM ids WHERE id = ?`, held.id)).toEqual({ delivery: "push" });

  expect(await a.send(held.id, "for later")).toMatchObject({ delivered_now: false });
  await held.none(direct());
  expect(await held.inbox()).toMatchObject({ unanswered: [expect.objectContaining({ body: "for later", from: `${A}/be` })] });
});

// #284 PR 4: a session's holds are a set: mail to each alias is delivered to
// it. A restart ends it (a closed one keeps both holds) and releases both.
// hosted twin: #451 (multi-alias holds)
test("a two-hold session is delivered to on each hold; a restart ends it and releases both", async () => {
  const alice = await srv.login(A);
  const s = await srv.connected(alice, "be");
  expect(await s.bind("be2", { create: true })).toMatchObject({ held: [`${A}/be`, `${A}/be2`] });
  const peer = await srv.connected(alice, "fe");
  for (const alias of ["be", "be2"]) {
    await peer.send(alias, `to ${alias}`);
    expect(await s.next(direct((m) => m.body === `to ${alias}`), 3000)).toBeDefined();
  }

  s.close();
  expect([await holder(`${A}/be`), await holder(`${A}/be2`)]).toEqual([s.id, s.id]);
  await restart();
  expect((await row(s.id))!.ended_at).toBe(clock);
  expect((await row(s.id))!.held_aliases_json).toBe(JSON.stringify([`${A}/be`, `${A}/be2`]));
  expect([await holder(`${A}/be`), await holder(`${A}/be2`)]).toEqual([null, null]);
  expect(await lastEvent(`${A}/be2`)).toEqual({ session_id: s.id, event: "released", detail: "session_end: wss_removed" });
});
