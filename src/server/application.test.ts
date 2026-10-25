import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication, type DeliveryEvent, type DeliverySink } from "./application.ts";
import { openDatabase } from "./db.ts";
import type { AuthedUser } from "./auth.ts";
import { writeAudit } from "./audit.ts";

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
    return { user_id: u.id, user_email: u.email, session_id: 0 };
  };
  alice = user("alice@example.com");
  bob = user("bob@example.com");
});
afterEach(() => {
  application.stopExpiry();
  store.db.close();
  rmSync(blobDir, { recursive: true, force: true });
});

test("typed operations and delivery need no frames; receipts alone move the delivery cursor", async () => {
  const a = (await application.selectIdentity(alice, "BE", delivery(sink()))).session;
  const out = sink();
  const { session: b, info } = await application.selectIdentity(bob, "fe", delivery(out));
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
  const b2 = (await application.selectIdentity(bob, "fe", delivery(replay))).session;
  application.replay(b2);
  expect(replay.events).toHaveLength(1);
  application.receiptDirect(b2, [sent.message_id]);
  expect(store.repo.cursors.directFor(b.identityFull)).toBe(sent.message_id);
  expect(application.history(a)[0]).toMatchObject({ delivered: true });
  expect(application.inbox(a).promised).toHaveLength(1);
  application.acknowledgeDm(a, sent.message_id);
  expect(application.inbox(a).promised).toBeUndefined();
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
  await expect(application.selectIdentity(alice, "be", delivery(sink()))).rejects.toMatchObject({ code: "identity_in_use" });
});

test("only an owning agent selection consumes a bridge death notice, including hold-only owners", async () => {
  const target = `${alice.user_email}/human`;
  writeAudit(store.repo, "bridge.stopped", null, target, { reason: "fixture fatal", at: new Date().toISOString() });
  const tools = await application.selectIdentity(alice, "be", delivery(sink()), { push: false });
  const unbound = await application.selectIdentity(alice, undefined, delivery(sink()), { read_only: true });
  const human = await application.attachHuman(alice, delivery(sink()));
  for (const { info } of [tools, unbound, human]) expect(info.notices ?? []).toEqual([]);
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

test("concurrent owner acquisitions recheck after a dead-owner probe", async () => {
  let resolve!: (alive: boolean) => void;
  const dead = sink(() => new Promise<boolean>(r => {
    resolve = r;
  }));
  await application.selectIdentity(alice, "be", delivery(dead));
  const first = application.selectIdentity(alice, "be", delivery(sink()));
  const second = application.selectIdentity(alice, "be", delivery(sink()));
  resolve(false);
  const results = await Promise.allSettled([first, second]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { code: "identity_in_use" } });
  expect(dead.closed).toHaveLength(1);
});

test("revocation during an owner probe cannot admit the waiting session", async () => {
  let resolve!: (alive: boolean) => void;
  await application.selectIdentity(alice, "be", delivery(sink(() => new Promise<boolean>(r => {
    resolve = r;
  }))));
  const waiting = application.selectIdentity(alice, "be", delivery(sink()));
  application.disconnectUser(alice.user_id);
  resolve(false);
  await expect(waiting).rejects.toMatchObject({ code: "unauthenticated" });
});

test("reserved human authority is a separate trusted method, never a selected client field", async () => {
  await expect(application.selectIdentity(alice, "human", delivery(sink()))).rejects.toMatchObject({ code: "bad_request" });
  const human = (await application.attachHuman(alice, delivery(sink()))).session;
  application.disconnectUser(alice.user_id);
  expect(human.active).toBe(true);
  store.repo.users.setDisabled(alice.user_id, true);
  expect(() => application.inbox(human)).toThrow("an admin signed this user out");
});

test("board delivery is typed, replayable and acknowledged separately", async () => {
  const a = (await application.selectIdentity(alice, "be", delivery(sink()))).session;
  const out = sink();
  const b = (await application.selectIdentity(bob, "fe", delivery(out))).session;
  application.call(a, "board_create", { name: "e2e", purpose: "fixtures" });
  application.call(a, "board_post", { board: "e2e", body: "@bob/fe look" });
  const event = out.events[0];
  expect(event?.kind).toBe("board");
  if (event?.kind !== "board" || event.item.kind !== "push") throw new Error("missing board delivery");
  application.close(b);
  const again = sink();
  const b2 = (await application.selectIdentity(bob, "fe", delivery(again))).session;
  application.replay(b2);
  expect(again.events).toHaveLength(1);
  application.receiptBoards(b2, [{ kind: "push", post_id: event.item.post.id }]);
  application.close(b2);
  const final = sink();
  const b3 = (await application.selectIdentity(bob, "fe", delivery(final))).session;
  application.replay(b3);
  expect(final.events).toHaveLength(0);
});

test("hosted Slack has no dependency on the transitional wire adapter", async () => {
  const source = await Bun.file(new URL("./slack.ts", import.meta.url)).text();
  expect(source).not.toContain("./ws.ts");
  expect(source).not.toContain("shared/protocol");
  expect(source).not.toContain("JSON.parse");
  expect(source).not.toContain("HumanConn");
  expect(source).toContain("application.attachHuman");
});

test("unbound application sessions cannot use named operations or persist synthetic handles", async () => {
  const { session, info } = await application.selectIdentity(alice, undefined, delivery(sink()), { read_only: true, session_key: "unbound-secret", suggested: "fresh" });
  expect(session.identityId).toBe(0);
  expect(info.candidates).toMatchObject([{ name: "fresh", fresh: true }]);
  expect(store.repo.identities.listForUser(alice.user_id)).toEqual([]);
  expect(store.db.query("SELECT * FROM handles").all()).toEqual([]);
  const operations = [
    () => application.send(session, "be", "no"),
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
  await application.selectIdentity(bob, undefined, delivery(sink()), { read_only: true, session_key: "bob-unbound-secret" });
  expect((application.call(session, "peer_list", {}) as { unbound_sessions: unknown[] }).unbound_sessions).toHaveLength(1);
  application.disconnectUser(alice.user_id);
  expect(() => application.call(session, "board_list", {})).toThrow("session is closed");
});

test("hold owners block binding and candidates without push or online presence; release is once", async () => {
  const out = sink();
  const owner = (await application.selectIdentity(alice, "held", delivery(out), { push: false, hold: true, session_key: "hold-secret", where: "checkout" })).session;
  application.call(owner, "peer_status", { text: "working" });
  const tools = (await application.selectIdentity(alice, "held", delivery(sink()), { push: false })).session;
  const observer = (await application.selectIdentity(alice, undefined, delivery(sink()), { read_only: true })).session;
  expect((application.call(observer, "peer_list", { include_offline: true }) as { peers: unknown[] }).peers).toMatchObject([{ online: false, status: "working" }]);
  expect(tools.owner).toBe(false);
  await expect(application.selectIdentity(alice, "held", delivery(sink()))).rejects.toMatchObject({ code: "identity_in_use", extra: { holder: expect.stringContaining("checkout") } });
  const unbound = await application.selectIdentity(alice, undefined, delivery(sink()), { read_only: true, suggested: "held" });
  expect(unbound.info.candidates).toEqual([]);
  const sender = (await application.selectIdentity(bob, "sender", delivery(sink()))).session;
  expect(application.send(sender, "alice@example.com/held", "queued").delivered_now).toBe(false);
  application.replay(owner);
  expect(out.events).toEqual([]);
  application.close(owner);
  application.close(owner);
  const releases = store.db.query("SELECT * FROM binding_events WHERE name = ? AND event = 'released'").all(owner.identityFull);
  expect(releases).toHaveLength(1);
});

test("unknown and reserved names are audited without creation; trusted human gets binding attribution", async () => {
  await expect(application.selectIdentity(alice, "typo", delivery(sink()), { create: false, session_key: "typo-secret" })).rejects.toMatchObject({ code: "identity_unknown", extra: { known: [] } });
  expect(store.repo.identities.listForUser(alice.user_id)).toEqual([]);
  await expect(application.selectIdentity(alice, "human", delivery(sink()), { session_key: "human-secret" })).rejects.toMatchObject({ code: "bad_request" });
  const human = (await application.attachHuman(alice, delivery(sink()))).session;
  expect(human.sessionId).not.toBe("");
  application.close(human);
  expect(store.db.query("SELECT event FROM binding_events WHERE name = ? ORDER BY id").all(human.identityFull)).toEqual([{ event: "refused" }, { event: "bound" }, { event: "released" }]);
});

test("rebind acquires target before releasing source, moves claims not DMs, and refuses stale resume", async () => {
  const oldOut = sink();
  const old = (await application.selectIdentity(alice, "old", delivery(oldOut), { session_key: "rebind-secret" })).session;
  application.call(old, "claim_take", { key: "file:src/e2e.ts" });
  const blocker = (await application.selectIdentity(alice, "blocked", delivery(sink()))).session;
  await expect(application.selectIdentity(alice, "blocked", delivery(sink()), { from: "old", session_key: "rebind-secret" })).rejects.toMatchObject({ code: "identity_in_use" });
  expect(old.owner).toBe(true);
  const nextOut = sink();
  const next = await application.selectIdentity(alice, "next", delivery(nextOut), { from: "old", session_key: "rebind-secret" });
  expect(next.info.moved).toEqual(["file:src/e2e.ts"]);
  expect(old.owner).toBe(false);
  expect(next.session.owner).toBe(true);
  expect(store.db.query("SELECT holder FROM claims WHERE key = ?").get("file:src/e2e.ts")).toEqual({ holder: next.session.identityFull });
  expect(store.db.query("SELECT * FROM claim_events WHERE key = ?").all("file:src/e2e.ts").length).toBeGreaterThan(1);
  const sender = (await application.selectIdentity(bob, "sender", delivery(sink()))).session;
  expect(application.send(sender, old.identityFull, "old mailbox").delivered_now).toBe(false);
  expect(nextOut.events).toEqual([]);
  await expect(application.selectIdentity(alice, "old", delivery(sink()), { resume: true, session_key: "rebind-secret" })).rejects.toMatchObject({ code: "identity_in_use" });
  application.close(old);
  expect(store.db.query("SELECT * FROM binding_events WHERE name = ? AND event = 'released'").all(old.identityFull)).toHaveLength(1);
  application.close(blocker);
});
