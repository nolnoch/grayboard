// Session end on the server (#284 S4, S10): an end ends a session at once;
// a closed one keeps its holds through its grace and ends at the sweep
// after it; a server restart gives every unended session a fresh grace; an
// admin revocation ends a user's sessions, live or in their grace. An end
// bounces the ID's unread mail to live senders and releases its claims.
// These are hub mechanics, driven at the application level (#282).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationError, GRACE_MS, SWEEP_MS } from "../../src/server/application.ts";
import { runRetention } from "../../src/server/retention.ts";
import type { AppSession, AppSessionOptions } from "../support/app_session.ts";
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

async function connect(token: string, identity: string | null, opts: AppSessionOptions = {}): Promise<AppSession> {
  const s = srv.appSession(token, identity, opts);
  await s.connect();
  return s;
}
// A connect's refusal (of the hello, or of the identity's bind).
async function refused(token: string, identity: string | null, opts: AppSessionOptions = {}): Promise<ApplicationError> {
  const e = await srv.appSession(token, identity, opts).connect().then(() => undefined, (e: unknown) => e);
  if (!(e instanceof ApplicationError)) throw new Error(`expected a refusal, got ${e}`);
  return e;
}
// The session is closed: every later wait fails at once.
const isClosed = (s: AppSession) => expect(s.next(() => false)).rejects.toThrow("closed");
// `s`'s connection closes: another session's bind of its alias is refused
// with the holder's grace in the reason.
async function inGrace(token: string, s: AppSession, alias: string): Promise<ApplicationError> {
  s.close();
  const e = await refused(token, alias);
  expect(e.code).toBe("alias_held");
  expect(e.extra.holder).toContain("disconnected at");
  return e;
}

// hosted twin: #451 (end)
test("an end ends the session at once: holds and claims released, unread mail bounced to a live sender, later operations refused", async () => {
  const alice = await srv.login(A);
  const bob = await srv.login("bob@example.com");
  const a = await connect(alice, null);
  const b = await connect(bob, "fe");
  // A claim taken as the ID ends with the session; one taken as the alias stays with it (S6).
  await a.call("claim_take", { key: "ticket:ENG-1" });
  await a.bind("be");
  await a.call("claim_take", { key: "ticket:ENG-142" });
  // Pushed to the ID and never acked: unread when it ends.
  const sent = await b.send(a.id, "still there?");
  expect(sent).toMatchObject({ delivered_now: true });
  await a.next(direct());

  await a.end();
  expect(row(a.id)).toEqual({ ended_at: clock, held_aliases_json: JSON.stringify([`${A}/be`]) });
  expect(holder(`${A}/be`)).toBeNull();
  expect(lastEvent(`${A}/be`)).toEqual({ session_id: a.id, event: "released", detail: "session_end: exit" });
  expect((await b.call<{ key: string; holder: string }[]>("claim_list")).map((c) => [c.key, c.holder])).toEqual([["ticket:ENG-142", `${A}/be`]]);
  expect(ended(a.id)).toEqual([{ principal: A, held: [`${A}/be`], why: "exit", bounced: 1 }]);

  const bounce = await b.next(direct());
  expect(bounce.message).toMatchObject({ sender: a.id, parent_id: sent.message_id, kind: "bounce" });
  expect(bounce.message.body).toBe(`${a.id} ended at ${new Date(clock).toISOString()} before reading this; it held \`${A}/be\`.`);

  // The ended session answers nothing more, and its key can't come back.
  await expect(a.call("board_list")).rejects.toMatchObject({ code: "id_ended" });
  await isClosed(a);
  expect(await refused(alice, "be", { key: a.key })).toMatchObject({ code: "id_collision", message: expect.stringContaining("ended at") });
  // Its alias is free for a new session.
  expect((await srv.appSession(alice, "be").connect()).bind?.alias).toBe(`${A}/be`);
});

test("a closed session keeps its holds through the grace: a reconnect re-attaches, and the sweep after the grace ends it", async () => {
  const alice = await srv.login(A);
  const a = await connect(alice, "be");
  // In the grace: another session's bind is told when to retry.
  const held = await inGrace(alice, a, "be");
  expect(held).toMatchObject({ code: "alias_held", extra: { retry_after_ms: GRACE_MS + SWEEP_MS } });
  expect(held.extra.holder).toContain(`ends by ${new Date(clock + GRACE_MS).toISOString()}`);
  const detached = srv.app.db.prepare(`SELECT actor, detail FROM access_log WHERE action = 'id.detached' AND target = ?`).all(a.id) as { actor: string; detail: string }[];
  expect(detached.map((r) => ({ actor: r.actor, ...JSON.parse(r.detail) }))).toEqual([{ actor: A, held: [`${A}/be`], grace_until: clock + GRACE_MS }]);

  // Mail sent in the gap, to the alias and to the ID, waits for the session.
  const b = await connect(await srv.login("bob@example.com"), "ops");
  for (const recipient of [`${A}/be`, a.id]) {
    expect(await b.send(recipient, `gap: ${recipient}`)).toMatchObject({ delivered_now: false });
  }

  // The same key re-attaches, holding the alias already (no bind), and drains the gap's mail.
  const back = srv.appSession(alice, "be", { key: a.key });
  const hello = await back.connect();
  expect(hello).toMatchObject({ id: a.id, bound: [`${A}/be`] });
  expect(hello.bind).toBeUndefined();
  const drained = [(await back.next(direct())).message, (await back.next(direct())).message];
  expect(drained.map((m) => m.body).sort()).toEqual([`gap: ${A}/be`, `gap: ${a.id}`].sort());
  const reattached = srv.app.db.prepare(`SELECT detail FROM access_log WHERE action = 'id.reattached' AND target = ?`).get(a.id) as { detail: string };
  expect(JSON.parse(reattached.detail)).toMatchObject({ in_grace: true });

  // A live session is never swept, whatever its grace said.
  clock += GRACE_MS;
  srv.app.sweepSessions();
  expect(row(a.id)!.ended_at).toBeNull();

  await inGrace(alice, back, "be");
  srv.app.sweepSessions(clock + GRACE_MS - 1);
  expect(row(a.id)!.ended_at).toBeNull();
  expect(holder(`${A}/be`)).toBe(a.id);
  clock += GRACE_MS;
  srv.app.sweepSessions();
  expect(row(a.id)!.ended_at).toBe(clock);
  expect(lastEvent(`${A}/be`)).toEqual({ session_id: a.id, event: "released", detail: "session_end: grace" });
  expect((await srv.appSession(alice, "be").connect()).bind?.alias).toBe(`${A}/be`);
});

// Audit F1/A1 (#345): one end that throws is audited and retried a grace
// later; the other sessions in the same sweep still end, and the sweep
// itself doesn't throw (an uncaught throw in its interval exits the server).
test("a session whose end fails is audited and retried a grace later; the others in the sweep still end", async () => {
  const alice = await srv.login(A);
  const bad = await connect(alice, "be");
  const good = await connect(alice, "fe");
  await inGrace(alice, bad, "be");
  await inGrace(alice, good, "fe");
  const mail = srv.app.repo.mail;
  const unread = mail.unread.bind(mail);
  mail.unread = (id) => {
    if (id === bad.id) throw new Error("disk on fire");
    return unread(id);
  };

  clock += GRACE_MS;
  expect(() => srv.app.sweepSessions()).not.toThrow();
  expect(row(good.id)!.ended_at).toBe(clock);
  // The failed end rolled back whole: the ID and its hold are as they were.
  expect(row(bad.id)!.ended_at).toBeNull();
  expect(holder(`${A}/be`)).toBe(bad.id);
  const failed = srv.app.db.prepare(`SELECT actor, detail FROM access_log WHERE action = 'id.end_failed' AND target = ?`).all(bad.id) as { actor: string | null; detail: string }[];
  expect(failed.map((r) => ({ actor: r.actor, ...JSON.parse(r.detail) }))).toEqual([{ actor: null, why: "grace", error: "Error: disk on fire", retry_at: clock + GRACE_MS }]);

  // Not retried before its retry time; ended by the sweep after it.
  mail.unread = unread;
  srv.app.sweepSessions(clock + GRACE_MS - 1);
  expect(row(bad.id)!.ended_at).toBeNull();
  clock += GRACE_MS;
  srv.app.sweepSessions();
  expect(row(bad.id)!.ended_at).toBe(clock);
  expect(holder(`${A}/be`)).toBeNull();
});

test("a restarted server gives every unended session a fresh grace: one that comes back keeps its alias, one that doesn't ends", async () => {
  await srv.stop();
  srv = start(join(dbDir, "bus.db"));
  const alice = await srv.login(A);
  const back = await connect(alice, "be");
  const gone = await connect(alice, "fe");

  await srv.stop();
  clock += 60_000;
  srv = start(join(dbDir, "bus.db"));
  const alice2 = await srv.login(A);
  // The holds survived the restart.
  expect(holder(`${A}/fe`)).toBe(gone.id);
  expect(await refused(alice2, "fe")).toMatchObject({ code: "alias_held", extra: { retry_after_ms: GRACE_MS + SWEEP_MS } });
  expect(await srv.appSession(alice2, "be", { key: back.key }).connect()).toMatchObject({ bound: [`${A}/be`] });

  clock += GRACE_MS;
  srv.app.sweepSessions();
  expect(row(gone.id)!.ended_at).toBe(clock);
  expect(row(back.id)!.ended_at).toBeNull();
  expect(lastEvent(`${A}/fe`)).toEqual({ session_id: gone.id, event: "released", detail: "session_end: grace" });
});

test("revoking a user ends every session of theirs, live or in its grace; another user's are untouched", async () => {
  const root = await srv.login("root@example.com");
  const alice = await srv.login(A);
  const bob = await srv.login("bob@example.com");
  const live = await connect(alice, "be");
  const grace = await connect(alice, "fe");
  const theirs = await connect(bob, "be");
  await inGrace(alice, grace, "fe");

  expect((await srv.api(root, "POST", "/api/admin/revoke-session", { email: A })).status).toBe(200);
  expect(await live.next((e) => e.kind === "closed")).toMatchObject({ code: "unauthenticated" });
  await isClosed(live);
  for (const s of [live, grace]) {
    expect(row(s.id)!.ended_at).toBe(clock);
    expect(ended(s.id)).toEqual([expect.objectContaining({ why: "revoked" })]);
  }
  expect(holder(`${A}/be`)).toBeNull();
  expect(holder(`${A}/fe`)).toBeNull();
  expect(row(theirs.id)!.ended_at).toBeNull();
  await theirs.call("board_list");
  // Nothing left to sweep.
  clock += GRACE_MS;
  srv.app.sweepSessions();
  expect(ended(grace.id)).toHaveLength(1);
});

// #328 (S10, S17): retention deletes an ended session's ids row on the
// message window. A keyed one leaves a tombstone, so its key coming back
// is a new session audited as id.reused; an unkeyed key isn't remembered.
// hosted twin: #451 (keyed resume, end)
test("retention prunes ended sessions; a keyed one's key coming back is audited as reused, an unkeyed one's isn't", async () => {
  const alice = await srv.login(A);
  const keyed = await connect(alice, "be", { hello: { keyed: true } });
  const plain = await connect(alice, "fe");
  const live = await connect(alice, "api");
  for (const s of [keyed, plain]) await s.end();
  keyed.close();
  plain.close();

  const db = srv.app.db;
  const tombstones = () => db.prepare(`SELECT id, ended_at, pruned_at FROM pruned_ids`).all();
  const audits = (action: string) => db.prepare(`SELECT target, detail FROM access_log WHERE action = ?`).all(action).map((r: any) => ({ target: r.target, detail: JSON.parse(r.detail) }));
  // Inside the window nothing goes.
  await runRetention(srv.app.repo, db, srv.config, clock + 1);
  expect(row(keyed.id)).not.toBeNull();
  const later = clock + (srv.config.messageRetentionDays + 1) * 86_400_000;
  await runRetention(srv.app.repo, db, srv.config, later);
  expect([row(keyed.id), row(plain.id)]).toEqual([null, null]);
  // A live session is never pruned, however old.
  expect(row(live.id)).toEqual({ ended_at: null, held_aliases_json: null });
  expect(tombstones()).toEqual([{ id: keyed.id, ended_at: clock, pruned_at: later }]);
  // Provenance naming the pruned IDs stays: each alias keeps its last bind.
  expect(lastEvent(`${A}/be`)).toEqual({ session_id: keyed.id, event: "bound", detail: null });

  await connect(alice, null, { key: keyed.key, hello: { keyed: true } });
  expect(audits("id.reused")).toEqual([{ target: keyed.id, detail: { ended_at: clock, pruned_at: later } }]);
  expect(tombstones()).toEqual([]);
  await connect(alice, null, { key: plain.key });
  expect(audits("id.reused")).toHaveLength(1);
  expect(audits("id.registered").filter((a) => a.target === plain.id)).toHaveLength(1);
});

// #284 S18: a send or mention naming an ID that can't receive is refused
// with that ID's own code, not bad_request, and the same text local mode shows.
// hosted twin: #451 (tools-only, end)
test("a send or @id: mention to an ID that can't receive carries its code: not_found, id_ended, no_delivery", async () => {
  const alice = await srv.login(A);
  const a = await connect(alice, "be");
  const gone = await connect(alice, null);
  await gone.end();
  const tools = await connect(alice, "be", { push: false });
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
// no pushes, and what's sent to it waits for dm_inbox. Its row and its
// id.registered audit both say delivery 'push'; only tools-only is 'none'.
// hosted twin: #451 (hold session)
test("a hold session registers delivery push: a send to its ID is accepted and waits", async () => {
  const alice = await srv.login(A);
  const a = await connect(alice, "be");
  const held = await connect(alice, "fe", { push: false, hold: true });
  const registered = srv.app.db.prepare(`SELECT detail FROM access_log WHERE action = 'id.registered' AND target = ?`).get(held.id) as { detail: string };
  expect(JSON.parse(registered.detail)).toMatchObject({ delivery: "push", hold: true });
  expect(srv.app.db.prepare(`SELECT delivery FROM ids WHERE id = ?`).get(held.id)).toEqual({ delivery: "push" });

  expect(await a.send(held.id, "for later")).toMatchObject({ delivered_now: false });
  await held.none(direct());
  expect(await held.inbox()).toMatchObject({ unanswered: [expect.objectContaining({ body: "for later", from: `${A}/be` })] });
});

// #284 PR 4: a session's holds are a set; a resume inside the grace and a
// server restart's re-attach both bring every hold back, each delivered.
// hosted twin: #451 (multi-alias holds, keyed resume)
test("a two-hold session keeps both holds through a resume and a server restart, and each is delivered", async () => {
  await srv.stop();
  srv = start(join(dbDir, "bus.db"));
  let alice = await srv.login(A);
  const s = await connect(alice, "be");
  expect(await s.bind("be2", { create: true })).toMatchObject({ held: [`${A}/be`, `${A}/be2`] });
  const peer = await connect(alice, "fe");
  const reaches = async (to: AppSession, alias: string, body: string) => {
    await peer.send(alias, body);
    return to.next(direct((m) => m.body === body), 3000);
  };

  // A resume inside the grace.
  await inGrace(alice, s, "be2");
  const resumed = srv.appSession(alice, "be", { key: s.key, hello: { resume: true } });
  expect(await resumed.connect()).toMatchObject({ id: s.id, bound: [`${A}/be`, `${A}/be2`] });
  for (const alias of ["be", "be2"]) expect(await reaches(resumed, alias, `resumed to ${alias}`)).toBeDefined();

  // A server restart: the re-attach registers both.
  await srv.stop();
  clock += 60_000;
  srv = start(join(dbDir, "bus.db"));
  alice = await srv.login(A);
  expect(holder(`${A}/be2`)).toBe(s.id);
  const back = srv.appSession(alice, "be", { key: s.key, hello: { resume: true } });
  expect(await back.connect()).toMatchObject({ id: s.id, bound: [`${A}/be`, `${A}/be2`] });
  // The first peer holds fe through its own fresh grace: this one takes another name.
  const peer2 = await connect(alice, "ops");
  for (const alias of ["be", "be2"]) {
    await peer2.send(alias, `restarted to ${alias}`);
    expect(await back.next(direct((m) => m.body === `restarted to ${alias}`), 3000)).toBeDefined();
  }
});
