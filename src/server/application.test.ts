import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication, type DeliveryEvent, type DeliverySink } from "./application.ts";
import { openDatabase } from "./db.ts";
import type { AuthedUser } from "./auth.ts";

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
