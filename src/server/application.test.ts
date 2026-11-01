import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GRACE_MS, createApplication, type DeliveryEvent, type DeliverySink } from "./application.ts";
import { openDatabase } from "./db.ts";
import type { AuthedUser } from "./auth.ts";
import { writeAudit } from "./audit.ts";
import { createWsHandlers, type Conn } from "./ws.ts";
import { tokenSession } from "../../tests/support/token_session.ts";
import { until } from "../../tests/support/until.ts";

let store: ReturnType<typeof openDatabase>;
let application: ReturnType<typeof createApplication>;
let blobDir: string;
let alice: AuthedUser;
let bob: AuthedUser;
function sink(probe: DeliverySink["probe"] = async () => true) {
  const events: DeliveryEvent[] = [];
  const closed: string[] = [];
  return {
    events,
    closed,
    deliver: (event: DeliveryEvent) => {
      events.push(event);
    },
    probe,
    closedSink: (e: Error) => {
      closed.push(e.message);
    },
  };
}
function delivery(s: ReturnType<typeof sink>): DeliverySink {
  return { deliver: s.deliver, probe: s.probe, closed: s.closedSink };
}
beforeEach(() => {
  blobDir = mkdtempSync(join(tmpdir(), "gb-application-"));
  store = openDatabase(":memory:", { blobDir });
  application = createApplication(store.repo, store.db);
  const user = (email: string): AuthedUser => {
    const u = store.repo.users.upsertByEmail(email, null);
    // A WSS hello needs a live sign-in (#351).
    return tokenSession(store.repo, { user_id: u.id, user_email: u.email });
  };
  alice = user("alice@example.com");
  bob = user("bob@example.com");
});
afterEach(() => {
  application.stopExpiry();
  store.db.close();
  rmSync(blobDir, { recursive: true, force: true });
});

// #284 port: master's single-use admitIdentity had no production caller and
// is gone; a session key is the capability now, and a live one is single-use.
test("a session key admits one live session; a second hello on it collides", async () => {
  store.repo.aliases.create({ scope_kind: "person", scope_ref: alice.user_email, name: "be" }, alice.user_email);
  const selected = await application.selectIdentity(alice, "be", delivery(sink()), { create: false, session_key: "admit-key" });
  expect(selected.session.identityFull).toBe("alice@example.com/be");
  await expect(application.hello(alice, delivery(sink()), { session_key: "admit-key" })).rejects.toMatchObject({ code: "id_collision" });
  application.close(selected.session);
});

test("typed operations and delivery need no frames; receipts alone move the delivery cursor", async () => {
  const a = (await application.selectIdentity(alice, "BE", delivery(sink()))).session;
  const out = sink();
  const { session: b, info } = await application.selectIdentity(bob, "fe", delivery(out), { session_key: "bob-key" });
  expect(info.identity_full).toBe("bob@example.com/fe");
  expect(info).not.toHaveProperty("req_id");
  const sent = application.send(a, "bob@example.com/fe", "question?", { pending: true });
  expect(sent).toMatchObject({ delivered_now: true, pending: true });
  expect(sent).not.toHaveProperty("type");
  expect(out.events).toMatchObject([{ kind: "direct", message: { id: sent.message_id, body: "question?" } }]);
  expect(store.repo.cursors.directFor(b.identityFull)).toBe(0);
  application.acknowledgeDm(b, sent.message_id);
  expect(store.repo.cursors.directFor(b.identityFull)).toBe(0);
  application.close(b);
  const replay = sink();
  // A reconnect is the same session: its key, within the grace (#284 S4).
  const b2 = (await application.selectIdentity(bob, "fe", delivery(replay), { session_key: "bob-key" })).session;
  application.replay(b2);
  expect(replay.events).toHaveLength(1);
  application.receiptDirect(b2, [sent.message_id]);
  expect(store.repo.cursors.directFor(b.identityFull)).toBe(sent.message_id);
  expect(application.history(a)[0]).toMatchObject({ delivered: true });
  expect(application.inbox(a).promised).toHaveLength(1);
  application.acknowledgeDm(a, sent.message_id);
  expect(application.inbox(a).promised).toBeUndefined();
});

test("board observers are independent hints with concealed access and explicit lifecycle cleanup", async () => {
  const a = (await application.selectIdentity(alice, "be", delivery(sink()), { push: false })).session;
  application.call(a, "board_create", { name: "e2e", purpose: "tests" });
  let changed = 0, closed = 0;
  const unsubscribe = application.observeBoard(a, "#E2E", { changed: () => { changed++; }, closed: () => { closed++; } });
  application.observeBoard(a, "e2e", { changed: () => { throw new Error("ignored hint"); } });
  application.call(a, "board_post", { board: "e2e", body: "hello" });
  expect(changed).toBe(1);
  expect(application.boardSnapshot(a, "e2e").posts[0]!.body).toBe("hello");
  expect(application.boardCatalog(a).boards.map(b => b.name)).toContain("e2e");
  unsubscribe();
  unsubscribe();
  expect(closed).toBe(1);
  application.call(a, "board_post", { board: "e2e", body: "later" });
  expect(changed).toBe(1);
  application.close(a);
  expect(() => application.observeBoard(a, "e2e", { changed: () => {} })).toThrow("session is closed");
});

test("tools-only calls neither own nor drain deliveries nor reset the owner's status", async () => {
  const owner = sink();
  const a = (await application.selectIdentity(alice, "be", delivery(owner))).session;
  application.call(a, "peer_status", { text: "working" });
  const out = sink();
  const tools = (await application.selectIdentity(alice, "be", delivery(out), { push: false })).session;
  application.replay(tools);
  const b = (await application.selectIdentity(bob, "fe", delivery(sink()))).session;
  application.send(b, "alice@example.com/be", "hi");
  expect(owner.events).toHaveLength(1);
  expect(out.events).toHaveLength(0);
  const peers = application.call(tools, "peer_list", {}) as { peers: { handle: string; online: boolean; status?: string }[] };
  expect(peers.peers.find(p => p.handle === a.identityFull)).toMatchObject({ online: true, status: "working" });
  application.close(tools);
  // #284: a held alias refuses another session's bind as alias_held.
  await expect(application.selectIdentity(alice, "be", delivery(sink()))).rejects.toMatchObject({ code: "alias_held" });
});

test("only a push or hold hello consumes a bridge death notice, never a tools-only one", async () => {
  const target = `${alice.user_email}/human`;
  writeAudit(store.repo, "bridge.stopped", null, target, { reason: "fixture fatal", at: new Date().toISOString() });
  const tools = await application.selectIdentity(alice, "be", delivery(sink()), { push: false });
  // #284 port: a hosted unbound session gets no notices; a WSS unbound
  // session is a push session, so it would drain it (as next does below).
  const unbound = application.hostedSession(alice, "hosted-unbound", [], null, null, delivery(sink()));
  const human = await application.attachHuman(alice, delivery(sink()));
  for (const info of [tools.info, unbound.info]) expect(info.notices ?? []).toEqual([]);
  expect(human.ok.notices ?? []).toEqual([]);
  expect(store.repo.audit.last("bridge.notified", target)).toBeUndefined();

  const held = await application.selectIdentity(alice, "be", delivery(sink()), { push: false, hold: true });
  expect(held.info.notices).toHaveLength(1);
  expect(held.info.notices![0]).toContain("fixture fatal");
  const notified = store.repo.audit.last("bridge.notified", target);
  expect(notified).toBeDefined();
  const next = await application.selectIdentity(alice, "fe", delivery(sink()));
  expect(next.info.notices ?? []).toEqual([]);
  expect(store.repo.audit.last("bridge.notified", target)).toEqual(notified);
});

test("application selection shares the per-user hello budget across tools-only and unbound callers", async () => {
  application.stopExpiry();
  application = createApplication(store.repo, store.db, { helloLimit: { burst: 1, perSec: 0.01 } });
  await application.selectIdentity(alice, undefined, delivery(sink()));
  await expect(application.selectIdentity(alice, "refused", delivery(sink()), { push: false })).rejects.toMatchObject({ code: "rate_limited", extra: { retry_after_ms: expect.any(Number) } });
  expect(store.repo.aliases.listForScope("person", alice.user_email)).toEqual([]);
  expect(store.db.query("SELECT * FROM binding_events").all()).toEqual([]);
  expect(store.db.query("SELECT * FROM access_log WHERE action = 'hello.rate_limited'").all()).toHaveLength(1);
  expect((await application.attachHuman(alice, delivery(sink()))).session.human).toBe(true);
  // Per user: bob's hello spends his own budget (a bind spends it too, #284 S2).
  expect((await application.selectIdentity(bob, undefined, delivery(sink()))).session.primary).toMatch(/^id:/);
});

// #284: one live connection per session key; the probe is per ID.
test("concurrent hellos on one key recheck after a dead-holder probe", async () => {
  let resolve!: (alive: boolean) => void;
  const dead = sink(() => new Promise<boolean>(r => {
    resolve = r;
  }));
  await application.selectIdentity(alice, "be", delivery(dead), { session_key: "probe-key" });
  const first = application.selectIdentity(alice, "be", delivery(sink()), { session_key: "probe-key" });
  const second = application.selectIdentity(alice, "be", delivery(sink()), { session_key: "probe-key" });
  resolve(false);
  const results = await Promise.allSettled([first, second]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { code: "id_collision" } });
  expect(dead.closed).toHaveLength(1);
});

test("revocation during an owner probe cannot admit the waiting session", async () => {
  let resolve!: (alive: boolean) => void;
  await application.selectIdentity(alice, "be", delivery(sink(() => new Promise<boolean>(r => {
    resolve = r;
  }))), { session_key: "revoke-key" });
  const waiting = application.selectIdentity(alice, "be", delivery(sink()), { session_key: "revoke-key" });
  // An admin's sign-out revokes the sign-in, then disconnects (#351).
  store.repo.sessions.revoke(alice.session_id);
  application.disconnectUser(alice.user_id);
  resolve(false);
  await expect(waiting).rejects.toMatchObject({ code: "unauthenticated" });
});

test("reserved human authority is a separate trusted method, never a selected client field", async () => {
  await expect(application.selectIdentity(alice, "human", delivery(sink()))).rejects.toMatchObject({ code: "forbidden" });
  const human = (await application.attachHuman(alice, delivery(sink()))).session;
  application.disconnectUser(alice.user_id);
  expect(human.active).toBe(true);
  store.repo.users.setDisabled(alice.user_id, true);
  expect(() => application.inbox(human)).toThrow("an admin signed this user out");
});

test("board delivery is typed, replayable and acknowledged separately", async () => {
  const a = (await application.selectIdentity(alice, "be", delivery(sink()))).session;
  const out = sink();
  const b = (await application.selectIdentity(bob, "fe", delivery(out), { session_key: "bob-key" })).session;
  application.call(a, "board_create", { name: "e2e", purpose: "fixtures" });
  application.call(a, "board_post", { board: "e2e", body: "@bob@example.com/fe look" } /* #284 decision 16: @scope/name is exact */);
  const event = out.events[0];
  expect(event?.kind).toBe("board");
  if (event?.kind !== "board" || event.item.kind !== "push") throw new Error("missing board delivery");
  application.close(b);
  const again = sink();
  const b2 = (await application.selectIdentity(bob, "fe", delivery(again), { session_key: "bob-key" })).session;
  application.replay(b2);
  expect(again.events).toHaveLength(1);
  application.receiptBoards(b2, [{ kind: "push", post_id: event.item.post.id }]);
  application.close(b2);
  const final = sink();
  const b3 = (await application.selectIdentity(bob, "fe", delivery(final), { session_key: "bob-key" })).session;
  application.replay(b3);
  expect(final.events).toHaveLength(0);
});

test("bounded pending reads preserve pending flags and do not acknowledge or drain the owner", async () => {
  const a = (await application.selectIdentity(alice, "be", delivery(sink()))).session;
  const b = (await application.selectIdentity(bob, "fe", delivery(sink()), { push: false })).session;
  const id = application.send(a, "bob@example.com/fe", "pending", { pending: true }).message_id;
  application.send(a, "bob@example.com/fe", "second");
  const pending = application.pending(b, 1);
  expect(pending).toMatchObject([{ kind: "direct", message: { id, body: "pending", pending: true } }]);
  expect(application.pending(b, 1)).toEqual(pending);
  expect(store.repo.cursors.directFor(b.identityFull)).toBe(0);
  expect(() => application.pending(b, 101)).toThrow();
  expect(() => application.pending(b, 0)).toThrow();
  store.repo.users.setDisabled(bob.user_id, true);
  expect(() => application.pending(b)).toThrow("an admin signed this user out");
});

test("hosted Slack has no dependency on the transitional wire adapter", async () => {
  const source = await Bun.file(new URL("./slack.ts", import.meta.url)).text();
  expect(source).not.toContain("./ws.ts");
  expect(source).not.toContain("shared/protocol");
  expect(source).not.toContain("JSON.parse");
  expect(source).not.toContain("HumanConn");
  expect(source).toContain("application.attachHuman");
});

// #284 port: a WSS session with no alias acts as its ID (S13); the
// read-only unbound model is hosted MCP's, so it's tested there.
// An unbound hosted session acts as no address (#229): its reads are judged
// by its user's principal, never as `<email>/human`, the bridge's reserved
// identity that #announce authority rests on.
test("unbound hosted reads never use the human address and still list and read boards", async () => {
  const owner = (await application.selectIdentity(alice, "be", delivery(sink()), { session_key: "owner-secret" })).session;
  application.call(owner, "board_create", { name: "e2e", purpose: "fixture" });
  application.call(owner, "board_post", { board: "e2e", body: "hello" });
  const team = store.repo.teams.create("private", bob.user_id);
  store.repo.teams.addMember(team.id, bob.user_id);
  const bobBe = (await application.selectIdentity(bob, "be", delivery(sink()), { session_key: "bob-secret" })).session;
  application.call(bobBe, "board_create", { name: "secret", purpose: "fixture", team: "private" });
  const asked: string[] = [];
  const principalOf = store.repo.resolver.principalOf.bind(store.repo.resolver);
  store.repo.resolver.principalOf = (address: string) => { asked.push(address); return principalOf(address); };
  // One with no ids row (a foreign or pre-context ID), and one registered as hosted does at create.
  const unregistered = application.hostedSession(alice, "id:0000000000000", [], null, null, delivery(sink())).session;
  application.hostedRegister(alice, "id:1111111111111", "opencode");
  const registered = application.hostedSession(alice, "id:1111111111111", [], null, null, delivery(sink())).session;
  for (const session of [unregistered, registered]) {
    expect(application.boardCatalog(session).boards.map(b => b.name)).toContain("e2e");
    expect(application.boardCatalog(session).boards.map(b => b.name)).not.toContain("secret");
    expect(application.boardSnapshot(session, "e2e").posts.map(p => p.body)).toEqual(["hello"]);
    expect(() => application.boardSnapshot(session, "secret")).toThrow();
  }
  expect((application.call(registered, "board_list", {}) as { name: string }[]).map(b => b.name)).toContain("e2e");
  expect((application.call(registered, "board_read", { board: "e2e" }) as { posts: { body: string }[] }).posts.map(p => p.body)).toEqual(["hello"]);
  expect(asked.filter(a => a.endsWith("/human"))).toEqual([]);
  expect(store.repo.aliases.find("alice@example.com/human")).toBeUndefined();
  expect(store.db.query("SELECT COUNT(*) AS n FROM subscriptions WHERE handle LIKE '%/human'").get()).toEqual({ n: 0 });
  application.close(owner);
  application.close(bobBe);
});

test("unbound hosted sessions cannot use named operations or persist synthetic handles", async () => {
  const { session, info } = application.hostedSession(alice, "hosted-unbound", [], null, null, delivery(sink()));
  expect(session.writerId).toBeUndefined();
  expect(info.candidates).toEqual([]);
  expect(store.repo.aliases.listForScope("person", alice.user_email)).toEqual([]);
  expect(store.db.query("SELECT * FROM handles").all()).toEqual([]);
  const operations = [
    () => application.send(session, "be", "no"),
    () => application.delegate(session, { persona: "a researcher", task: "no" }),
    () => application.history(session),
    () => application.thread(session, 1),
    () => application.inbox(session),
    () => application.receiptDirect(session, [1]),
    () => application.receiptBoards(session, []),
    () => application.acknowledgeDm(session, 1),
    () => application.retract(session, 1),
    () => application.call(session, "board_create", { name: "e2e", purpose: "no" }),
  ];
  for (const operation of operations) {
    try { operation(); throw new Error("operation admitted"); } catch (e) { expect(e).toMatchObject({ code: "unbound" }); }
  }
  for (const tool of ["board_list", "peer_list", "claim_list"]) expect(() => application.call(session, tool, {})).not.toThrow();
  application.replay(session);
  expect(store.db.query("SELECT * FROM handles").all()).toEqual([]);
  const peers = application.call(session, "peer_list", {}) as Record<string, unknown>;
  expect(peers).not.toHaveProperty("you");
  expect(peers.unbound_sessions).toMatchObject([{ self: true }]);
  application.disconnectUser(alice.user_id);
  expect(() => application.call(session, "board_list", {})).toThrow("session is closed");
});

test("a WSS session with no alias acts as its ID and lists as an unbound peer of its own user only", async () => {
  const { session } = await application.selectIdentity(alice, undefined, delivery(sink()), { session_key: "unbound-secret" });
  expect(session.primary).toBe(session.sessionId);
  expect(session.writerId).toBe(session.sessionId);
  const peers = application.call(session, "peer_list", {}) as { unbound_sessions?: unknown[] };
  expect(peers.unbound_sessions).toMatchObject([{ session_id: session.sessionId, self: true }]);
  await application.selectIdentity(bob, undefined, delivery(sink()), { session_key: "bob-unbound-secret" });
  expect((application.call(session, "peer_list", {}) as { unbound_sessions: unknown[] }).unbound_sessions).toHaveLength(1);
  application.disconnectUser(alice.user_id);
  expect(() => application.call(session, "board_list", {})).toThrow("session is closed");
});

test("hold sessions block binding and candidates without push or online presence; release is at the end", async () => {
  const out = sink();
  const owner = (await application.selectIdentity(alice, "held", delivery(out), { push: false, hold: true, session_key: "hold-secret", where: "checkout" })).session;
  application.call(owner, "peer_status", { text: "working" });
  const tools = (await application.selectIdentity(alice, "held", delivery(sink()), { push: false })).session;
  const observer = application.hostedSession(alice, "hosted-observer", [], null, null, delivery(sink())).session;
  expect((application.call(observer, "peer_list", { include_offline: true }) as { peers: unknown[] }).peers).toMatchObject([{ online: false, status: "working" }]);
  expect(tools.toolsOnly).toBe(true);
  expect(tools.holds).toEqual([]);
  await expect(application.selectIdentity(alice, "held", delivery(sink()))).rejects.toMatchObject({ code: "alias_held", extra: { holder: expect.stringContaining("checkout") } });
  expect(application.hostedCandidates(alice)).toEqual([]);
  const sender = (await application.selectIdentity(bob, "sender", delivery(sink()))).session;
  expect(application.send(sender, "alice@example.com/held", "queued").delivered_now).toBe(false);
  application.replay(owner);
  expect(out.events).toEqual([]);
  application.close(owner);
  application.close(owner);
  // Closed, it holds the alias through its grace (#284 S4); the sweep ends it once.
  expect(store.db.query("SELECT * FROM binding_events WHERE name = ? AND event = 'released'").all(owner.identityFull)).toHaveLength(0);
  application.sweepSessions(Date.now() + GRACE_MS + 1);
  application.sweepSessions(Date.now() + GRACE_MS + 1);
  const releases = store.db.query("SELECT * FROM binding_events WHERE name = ? AND event = 'released'").all(owner.identityFull);
  expect(releases).toHaveLength(1);
});

test("unknown and reserved names are audited without creation; trusted human gets binding attribution", async () => {
  await expect(application.selectIdentity(alice, "typo", delivery(sink()), { create: false, session_key: "typo-secret" })).rejects.toMatchObject({ code: "identity_unknown", extra: { known: [] } });
  expect(store.repo.aliases.listForScope("person", alice.user_email)).toEqual([]);
  await expect(application.selectIdentity(alice, "human", delivery(sink()), { session_key: "human-secret" })).rejects.toMatchObject({ code: "forbidden" });
  const human = (await application.attachHuman(alice, delivery(sink()))).session;
  // The bridge's human has no session ID (#284 S16); it logs as `human`.
  expect(human.sessionId).toBe("");
  application.close(human);
  expect(store.db.query("SELECT event FROM binding_events WHERE name = ? ORDER BY id").all(human.identityFull)).toEqual([{ event: "refused" }, { event: "bound" }, { event: "released" }]);
});

// #284 port: master tested #182's rebind (a hello naming `from` moved the
// claims). Under #284 PR 4 a session holds several aliases: bind adds one,
// unbind releases one, and claims and DMs stay with the alias (S6).
test("bind adds a hold without taking another session's; unbind leaves claims and DMs with the alias", async () => {
  const oldOut = sink();
  const old = (await application.selectIdentity(alice, "old", delivery(oldOut), { session_key: "rebind-secret" })).session;
  application.call(old, "claim_take", { key: "file:src/e2e.ts" });
  const blocker = (await application.selectIdentity(alice, "blocked", delivery(sink()))).session;
  await expect(application.bind(old, { alias: "blocked" })).rejects.toMatchObject({ code: "alias_held" });
  expect(old.holds).toEqual(["alice@example.com/old"]);
  const bound = await application.bind(old, { alias: "next" });
  expect(bound.held).toEqual(["alice@example.com/old", "alice@example.com/next"]);
  expect(old.primary).toBe("alice@example.com/old");
  const unbound = application.unbind(old, "old");
  expect(unbound).toMatchObject({ released: true, held: ["alice@example.com/next"], left: ["file:src/e2e.ts"] });
  expect(old.primary).toBe("alice@example.com/next");
  expect(store.db.query("SELECT holder FROM claims WHERE key = ?").get("file:src/e2e.ts")).toEqual({ holder: "alice@example.com/old" });
  const sender = (await application.selectIdentity(bob, "sender", delivery(sink()))).session;
  expect(application.send(sender, "alice@example.com/old", "old mailbox").delivered_now).toBe(false);
  expect(oldOut.events).toEqual([]);
  expect(application.unbind(old, "old")).toMatchObject({ released: false });
  expect(store.db.query("SELECT * FROM binding_events WHERE name = ? AND event = 'released'").all("alice@example.com/old")).toHaveLength(1);
  application.close(old);
  application.close(blocker);
});

test("shared writes retain calling-session dedup, ID provenance and replay audit ownership", async () => {
  const first = (await application.selectIdentity(alice, "be", delivery(sink()), { session_key: "first-session" })).session;
  const sibling = (await application.selectIdentity(alice, "be", delivery(sink()), { push: false, session_key: "sibling-session" })).session;
  const events = sink();
  const recipient = (await application.selectIdentity(bob, "fe", delivery(events))).session;
  const send = (session: typeof first, resend = false) => application.send(session, recipient.identityFull, "same write", { resend });
  const a = send(first);
  const replay = send(first);
  expect(replay.message_id).toBe(a.message_id);
  expect(replay.replayed).toBeDefined();
  expect(events.events).toHaveLength(1);
  const deliberate = send(first, true);
  const other = send(sibling);
  expect(new Set([a.message_id, deliberate.message_id, other.message_id]).size).toBe(3);
  expect(events.events).toHaveLength(3);
  expect(store.db.query("SELECT sender_id FROM messages WHERE id = ?").get(a.message_id)).toEqual({ sender_id: first.sessionId });
  // #284: a tools-only connection is a session too (S7), with its own ID.
  expect(store.db.query("SELECT sender_id FROM messages WHERE id = ?").get(other.message_id)).toEqual({ sender_id: sibling.sessionId });
  expect(first.sessionId).toMatch(/^id:[0-9a-hjkmnp-tv-z]{13}$/);
  expect(store.db.query("SELECT principal, keyed FROM ids WHERE id = ?").get(first.sessionId)).toEqual({ principal: alice.user_email, keyed: 0 });
  expect(store.db.query("SELECT id FROM alias_holds WHERE address = ?").get(first.identityFull)).toEqual({ id: first.sessionId });
  expect(store.db.query("SELECT writes_as FROM ids WHERE id = ?").get(sibling.sessionId)).toEqual({ writes_as: "alice@example.com/be" });
  const audits = store.db.query("SELECT action, detail FROM access_log WHERE action IN ('request.replayed', 'request.resent') ORDER BY id").all() as { action: string; detail: string }[];
  expect(audits.map(a => a.action)).toEqual(["request.replayed", "request.resent"]);
  expect(JSON.parse(audits[0]!.detail)).toMatchObject({ session: first.sessionId, transport: "wss", tool: "dm_send" });
  application.close(first);
  // Closed, its hold stays through the grace (#284 S4).
  expect(store.db.query("SELECT id FROM alias_holds WHERE address = ?").get(first.identityFull)).toEqual({ id: first.sessionId });
  await expect(application.selectIdentity(bob, "other", delivery(sink()), { session_key: "first-session" })).rejects.toMatchObject({ code: "id_collision" });
  expect(store.repo.aliases.find(`${bob.user_email}/other`)).toBeUndefined();
});

test("WSS transport attribution is server-owned even if hello carries an extra field", async () => {
  const frames: Record<string, unknown>[] = [];
  const conn: Conn = {
    data: { authed: alice, ready: false },
    readyState: 1,
    send: raw => { frames.push(JSON.parse(raw)); },
    close() {},
  };
  const { handlers } = createWsHandlers(application);
  handlers.message(conn, JSON.stringify({ type: "hello", req_id: "h", proto: 2, session_key: "f".repeat(64), transport: "hosted" }));
  await until(() => frames.find(f => f.req_id === "h"));
  expect(frames[0]?.type).toBe("hello_ok");
  handlers.message(conn, JSON.stringify({ type: "bind", req_id: "bind", alias: "be" }));
  await until(() => frames.find(f => f.req_id === "bind"));
  expect(frames.find(f => f.req_id === "bind")?.type).toBe("bind_ok");
  for (const req_id of ["a", "b"]) handlers.message(conn, JSON.stringify({ type: "send", req_id, recipient: "be", body: "same write" }));
  const replay = store.db.query("SELECT detail FROM access_log WHERE action = 'request.replayed'").get() as { detail: string };
  expect(JSON.parse(replay.detail)).toMatchObject({ transport: "wss", tool: "dm_send" });
  expect(frames.find(f => f.req_id === "b")).toMatchObject({ type: "send_ok", replayed: { ref: { kind: "message" } } });
  handlers.close(conn);
});
