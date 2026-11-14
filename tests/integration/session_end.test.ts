// Session end on the server (#284 S4, S10), at the application level (#282).
// The WSS transport is gone, and with it `end`, the grace and its sweep and a
// hello's resume: a closed session keeps its holds (alias_holds is the hosted
// store's truth), and what ends a session the hosted store doesn't own is the
// server's start (why "wss_removed", the leftovers of a previous run) and a
// revoked tools-only alias (why "revoked"). An end bounces the ID's unread
// mail to live senders and releases its claims.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRetention } from "../../src/server/retention.ts";
import { direct } from "../support/events.ts";
import { TestServer } from "../support/server.ts";

const A = "alice@example.com";
let srv: TestServer;
let clock: number;
let dbDir: string;

const start = (dbPath = ":memory:") => new TestServer({ dbPath, admins: ["root@example.com"] }, { now: () => clock });

beforeEach(() => {
  clock = Date.now();
  dbDir = mkdtempSync(join(tmpdir(), "gb-end-"));
  srv = start();
});
afterEach(async () => {
  await srv.stop();
  rmSync(dbDir, { recursive: true, force: true });
});

const row = (id: string) => srv.app.db.prepare(`SELECT ended_at, held_aliases_json FROM ids WHERE id = ?`).get(id) as { ended_at: number | null; held_aliases_json: string | null } | null;
const holder = (address: string) => (srv.app.db.prepare(`SELECT id FROM alias_holds WHERE address = ?`).get(address) as { id: string } | null)?.id ?? null;
const lastEvent = (address: string) => srv.app.db.prepare(`SELECT session_id, event, detail FROM binding_events WHERE name = ? ORDER BY id DESC LIMIT 1`).get(address);
const ended = (id: string) => srv.app.db.prepare(`SELECT detail FROM access_log WHERE action = 'id.ended' AND target = ?`).all(id).map((r: any) => JSON.parse(r.detail));

// The server restarts on its database: every session the hosted store doesn't
// own, which nothing can reattach, is ended as it starts.
async function restart(): Promise<void> {
  await srv.stop();
  srv = start(join(dbDir, "bus.db"));
}

// hosted twin: #451 (end)
test("a restart ends a leftover session: holds released, claims of its ID released, unread mail bounced to a sender's next holder", async () => {
  await srv.stop();
  srv = start(join(dbDir, "bus.db"));
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
  expect(holder(`${A}/be`)).toBe(a.id);

  await restart();
  alice = await srv.login(A);
  bob = await srv.login("bob@example.com");
  expect(row(a.id)).toEqual({ ended_at: clock, held_aliases_json: JSON.stringify([`${A}/be`]) });
  expect(holder(`${A}/be`)).toBeNull();
  expect(lastEvent(`${A}/be`)).toEqual({ session_id: a.id, event: "released", detail: "session_end: wss_removed" });
  expect(ended(a.id)).toEqual([{ principal: A, held: [`${A}/be`], why: "wss_removed", bounced: 1 }]);

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
  const mail = srv.app.repo.mail;
  const unread = mail.unread.bind(mail);
  mail.unread = (id) => {
    if (id === bad.id) throw new Error("disk on fire");
    return unread(id);
  };

  expect((await srv.api(alice, "POST", "/api/teams/eng/remove", { email: "bob@example.com" })).status).toBe(200);
  expect(row(good.id)!.ended_at).toBe(clock);
  // The failed end rolled back whole: the ID is as it was.
  expect(row(bad.id)!.ended_at).toBeNull();
  const failed = srv.app.db.prepare(`SELECT actor, detail FROM access_log WHERE action = 'id.end_failed' AND target = ?`).all(bad.id) as { actor: string | null; detail: string }[];
  expect(failed.map((r) => ({ actor: r.actor, ...JSON.parse(r.detail) }))).toEqual([{ actor: null, why: "revoked", error: "Error: disk on fire" }]);

  // The session still writes as an alias it may not: the next revalidate ends it.
  mail.unread = unread;
  srv.app.revalidate();
  expect(row(bad.id)!.ended_at).toBe(clock);
  expect(ended(bad.id)).toEqual([expect.objectContaining({ why: "revoked" })]);
});

// #328 (S10, S17): retention deletes an ended session's ids row on the
// message window. A keyed row would leave a tombstone, but the server no
// longer registers keyed IDs (the session key was the WSS hello's), so none
// does; the keyed tombstone and id.reused are core's, in
// src/local/retention.test.ts and session_key.test.ts.
test("retention prunes ended sessions, never a live one, and leaves no tombstone", async () => {
  await srv.stop();
  srv = start(join(dbDir, "bus.db"));
  let alice = await srv.login(A);
  const first = await srv.connected(alice, "be");
  const second = await srv.connected(alice, "fe");
  await restart();
  alice = await srv.login(A);
  const live = await srv.connected(alice, "api");

  const db = srv.app.db;
  const tombstones = () => db.prepare(`SELECT id, ended_at, pruned_at FROM pruned_ids`).all();
  // Inside the window nothing goes.
  await runRetention(srv.app.repo, db, srv.config, clock + 1);
  expect(row(first.id)).not.toBeNull();
  const later = clock + (srv.config.messageRetentionDays + 1) * 86_400_000;
  await runRetention(srv.app.repo, db, srv.config, later);
  expect([row(first.id), row(second.id)]).toEqual([null, null]);
  // A live session is never pruned, however old.
  expect(row(live.id)).toEqual({ ended_at: null, held_aliases_json: null });
  expect(tombstones()).toEqual([]);
  // Provenance naming the pruned IDs stays: each alias keeps its last bind.
  expect(lastEvent(`${A}/be`)).toEqual({ session_id: first.id, event: "bound", detail: null });
});

// #284 S18: a send or mention naming an ID that can't receive is refused
// with that ID's own code, not bad_request, and the same text local mode shows.
// The ended ID is a session a restart ended.
// hosted twin: #451 (tools-only)
test("a send or @id: mention to an ID that can't receive carries its code: not_found, id_ended, no_delivery", async () => {
  await srv.stop();
  srv = start(join(dbDir, "bus.db"));
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
  expect(srv.app.db.prepare(`SELECT COUNT(*) AS n FROM messages`).get()).toEqual({ n: 0 });
  expect(srv.app.db.prepare(`SELECT COUNT(*) AS n FROM posts`).get()).toEqual({ n: 0 });
});

// #284 S7: a hold session takes mail like local channels-off (#71): it gets
// no pushes, and what's sent to it waits for dm_inbox. Its row says delivery
// 'push'; only tools-only is 'none'.
// hosted twin: #451 (hold session)
test("a hold session registers delivery push: a send to its ID is accepted and waits", async () => {
  const alice = await srv.login(A);
  const a = await srv.connected(alice, "be");
  const held = await srv.connected(alice, "fe", { push: false, hold: true });
  expect(srv.app.db.prepare(`SELECT delivery FROM ids WHERE id = ?`).get(held.id)).toEqual({ delivery: "push" });

  expect(await a.send(held.id, "for later")).toMatchObject({ delivered_now: false });
  await held.none(direct());
  expect(await held.inbox()).toMatchObject({ unanswered: [expect.objectContaining({ body: "for later", from: `${A}/be` })] });
});

// #284 PR 4: a session's holds are a set: mail to each alias is delivered to
// it. A restart ends it (a closed one keeps both holds) and releases both.
// hosted twin: #451 (multi-alias holds)
test("a two-hold session is delivered to on each hold; a restart ends it and releases both", async () => {
  await srv.stop();
  srv = start(join(dbDir, "bus.db"));
  const alice = await srv.login(A);
  const s = await srv.connected(alice, "be");
  expect(await s.bind("be2", { create: true })).toMatchObject({ held: [`${A}/be`, `${A}/be2`] });
  const peer = await srv.connected(alice, "fe");
  for (const alias of ["be", "be2"]) {
    await peer.send(alias, `to ${alias}`);
    expect(await s.next(direct((m) => m.body === `to ${alias}`), 3000)).toBeDefined();
  }

  s.close();
  expect([holder(`${A}/be`), holder(`${A}/be2`)]).toEqual([s.id, s.id]);
  await restart();
  expect(row(s.id)!.ended_at).toBe(clock);
  expect(row(s.id)!.held_aliases_json).toBe(JSON.stringify([`${A}/be`, `${A}/be2`]));
  expect([holder(`${A}/be`), holder(`${A}/be2`)]).toEqual([null, null]);
  expect(lastEvent(`${A}/be2`)).toEqual({ session_id: s.id, event: "released", detail: "session_end: wss_removed" });
});
