import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication, type ApplicationSession, type DeliverySink } from "./application.ts";
import { createDelivery, type DeliveryPrincipal } from "./delivery.ts";
import { createHostedSessions, OPENCODE_CLIENT, OPENCODE_SESSION_META, sessionContext } from "./hosted.ts";
import { openDatabase } from "./db.ts";
import { createBoard, post, subscribe } from "../core/boards.ts";

let store: ReturnType<typeof openDatabase>;
let application: ReturnType<typeof createApplication>;
let hosted: ReturnType<typeof createHostedSessions>;
let delivery: ReturnType<typeof createDelivery>;
let alice: DeliveryPrincipal;
let bob: DeliveryPrincipal;
let sender: ApplicationSession;
let dir: string;
let now: number;
let authorized: boolean;
const sink: DeliverySink = { deliver() {}, closed() {}, probe: async () => true };
const context = (p: DeliveryPrincipal, raw = "root") => sessionContext(p, { [OPENCODE_SESSION_META]: raw });
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "gb-delivery-"));
  store = openDatabase(":memory:", { blobDir: dir });
  application = createApplication(store.repo, store.db);
  const principal = (email: string): DeliveryPrincipal => {
    const user = store.repo.users.upsertByEmail(email, null);
    return { authed: { user_id: user.id, user_email: email, session_id: 0 }, grantId: `grant:${user.id}`, clientId: OPENCODE_CLIENT, scopes: ["tools", "delivery"], accessHash: "test", accessExpiry: Number.MAX_SAFE_INTEGER };
  };
  alice = principal("alice@example.com"); bob = principal("bob@example.com");
  now = Date.now(); authorized = true;
  hosted = createHostedSessions(application, { now: () => now, isAuthorized: () => authorized });
  delivery = createDelivery(hosted, { isAuthorized: () => authorized });
  sender = (await application.selectIdentity(alice.authed, "be", sink, { push: false })).session;
  await hosted.bind(bob, context(bob), { name: "fe", create: true });
});
afterEach(() => { delivery.close(); hosted.close(); application.stopExpiry(); store.db.close(); rmSync(dir, { recursive: true, force: true }); });
const send = (body = "hello", pending = false) => application.send(sender, "bob@example.com/fe", body, { pending }).message_id;

test("stale receipt audit survives rollback exactly once without committing any cursor", async () => {
  const lease = await delivery.open(bob, context(bob));
  send();
  const items = await delivery.pending(bob, context(bob), lease.capability);
  await expect(delivery.receipt(bob, context(bob), lease.capability, [items[0]!.id, "direct:99999"])).rejects.toHaveProperty("code", "not_found");
  expect(store.repo.cursors.directFor("bob@example.com/fe")).toBe(0);
  const rows = store.db.query<{ actor: string; detail: string }, []>("SELECT actor,detail FROM access_log WHERE action = 'hosted.stale_capability'").all();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.actor).toBe(bob.authed.user_email);
  expect(JSON.parse(rows[0]!.detail)).toEqual({ client_id: OPENCODE_CLIENT });
  expect(JSON.stringify(rows)).not.toContain(lease.capability);
  await delivery.receipt(bob, context(bob), lease.capability, [items[0]!.id]);
  expect(store.db.query("SELECT count(*) AS n FROM access_log WHERE action = 'hosted.stale_capability'").get()).toEqual({ n: 1 });
});

test("delivery hook diagnostics never inspect forged stack messages or causes", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  const forged = new Error("Bearer PRIVATE\n    at f (/private/refresh-token.ts:1:1)", { cause: "AUTHORIZATION-CODE" });
  try {
    const lease = await delivery.open(bob, context(bob), { changed: async () => { throw forged; }, closed: () => { throw forged; } });
    send();
    await Promise.resolve(); await Promise.resolve();
    expect(log.mock.calls.flat()).toEqual(['[grayboard] {"operation":"delivery.changed","category":"failure","level":"error","class":"Error"}']);
    await delivery.release(bob, context(bob), lease.capability);
    expect(log.mock.calls.flat()).toEqual([
      '[grayboard] {"operation":"delivery.changed","category":"failure","level":"error","class":"Error"}',
      '[grayboard] {"operation":"delivery.closed","category":"failure","level":"error","class":"Error"}',
    ]);
  } finally { log.mockRestore(); }
});

test("canceling duplicate open preserves accepted lease, children, receipts and notification owner", async () => {
  let originalHints = 0, duplicateHints = 0;
  await hosted.register(bob, context(bob), "child");
  const first = await delivery.open(bob, context(bob), { changed: () => { originalHints++; } });
  delivery.accept(first);
  send();
  const items = await delivery.pending(bob, context(bob), first.capability);
  const duplicate = await delivery.open(bob, context(bob), { changed: () => { duplicateHints++; } });
  await delivery.cancel(duplicate);
  expect(delivery.activeLeaseCount).toBe(1);
  expect(store.repo.hosted.all()).toHaveLength(2);
  expect(originalHints).toBe(1);
  send("next message");
  expect(originalHints).toBe(2); expect(duplicateHints).toBe(0);
  await delivery.receipt(bob, context(bob), first.capability, [items[0]!.id]);
  await delivery.renew(bob, context(bob), first.capability);
});

test("successful reuse fences older creator cancellation; canceled reuse does not leak a canceled creator", async () => {
  const creator = await delivery.open(bob, context(bob));
  const reuse = await delivery.open(bob, context(bob));
  delivery.accept(reuse);
  await delivery.cancel(creator);
  expect(delivery.activeLeaseCount).toBe(1);
  expect(delivery.describe(bob, context(bob), reuse.capability).capability).toBe(creator.capability);
  await delivery.release(bob, context(bob), reuse.capability);
  await hosted.bind(bob, context(bob), { name: "fe" });
  const next = await delivery.open(bob, context(bob));
  const canceledReuse = await delivery.open(bob, context(bob));
  await delivery.cancel(next);
  expect(delivery.activeLeaseCount).toBe(1);
  await delivery.cancel(canceledReuse);
  expect(delivery.activeLeaseCount).toBe(0);
  expect(store.repo.hosted.all()).toEqual([]);
});

test("old attempt cancellation cannot end a replacement generation or ownership", async () => {
  const old = await delivery.open(bob, context(bob));
  await hosted.bind(bob, context(bob), { name: "new", create: true });
  const current = await delivery.open(bob, context(bob)); delivery.accept(current);
  await delivery.cancel(old);
  expect(delivery.describe(bob, context(bob), current.capability).bind_gen).toBeGreaterThan(old.bind_gen);
  await delivery.release(bob, context(bob), current.capability);
  await hosted.bind(bob, context(bob), { name: "new" });
  const replacement = await delivery.open(bob, context(bob)); delivery.accept(replacement);
  await delivery.cancel(current);
  expect(delivery.describe(bob, context(bob), replacement.capability).ownership).not.toBe(current.ownership);
});

test("reads repeat without admission; receipt and dm_ack remain distinct", async () => {
  let hints = 0;
  const lease = await delivery.open(bob, context(bob), { changed: () => { hints++; throw new Error("lost hint"); } });
  const first = send("first", true), second = send("second");
  expect(hints).toBe(2);
  const pending = await delivery.pending(bob, context(bob), lease.capability);
  expect(pending.map(p => p.id)).toEqual([`direct:${first}`, `direct:${second}`]);
  expect(await delivery.pending(bob, context(bob), lease.capability)).toEqual(pending);
  expect(store.repo.cursors.directFor("bob@example.com/fe")).toBe(0);
  await delivery.receipt(bob, context(bob), lease.capability, pending.map(p => p.id));
  await delivery.receipt(bob, context(bob), lease.capability, pending.map(p => p.id));
  expect(store.repo.cursors.directFor("bob@example.com/fe")).toBe(second);
  expect(application.inbox(sender).promised).toHaveLength(1);
});

test("only an issued contiguous direct prefix advances MAX cursor, ignoring global gaps", async () => {
  const lease = await delivery.open(bob, context(bob));
  send("first");
  store.repo.messages.insert("alice@example.com/be", "user", "alice@example.com/be", "gap", null, false);
  send("second");
  const items = await delivery.pending(bob, context(bob), lease.capability);
  await expect(delivery.receipt(bob, context(bob), lease.capability, [items[1]!.id])).rejects.toHaveProperty("code", "not_found");
  expect(store.repo.cursors.directFor("bob@example.com/fe")).toBe(0);
  await expect(delivery.receipt(bob, context(bob), lease.capability, [items[0]!.id, "direct:99999"])).rejects.toHaveProperty("code", "not_found");
  expect(store.repo.cursors.directFor("bob@example.com/fe")).toBe(0);
  await delivery.receipt(bob, context(bob), lease.capability, [items[0]!.id]);
  await delivery.receipt(bob, context(bob), lease.capability, items.map(i => i.id));
  expect(await delivery.pending(bob, context(bob), lease.capability)).toEqual([]);
});

test("foreign principal, grant, session, and unissued receipt have no authority", async () => {
  const lease = await delivery.open(bob, context(bob));
  const id = send();
  await expect(delivery.receipt(bob, context(bob), lease.capability, [`direct:${id}`])).rejects.toHaveProperty("code", "not_found");
  const items = await delivery.pending(bob, context(bob), lease.capability);
  for (const [p, c] of [[alice, context(alice)], [{ ...bob, grantId: "G2" }, context(bob)], [bob, context(bob, "other")]] as const) {
    await expect(delivery.receipt(p, c, lease.capability, [items[0]!.id])).rejects.toHaveProperty("code", "not_found");
  }
  items[0]!.id = "direct:99999";
  await expect(delivery.receipt(bob, context(bob), lease.capability, [items[0]!.id])).rejects.toHaveProperty("code", "not_found");
  expect(store.repo.cursors.directFor("bob@example.com/fe")).toBe(0);
});

test("renew is fenced and extends sticky deadline, reopening is idempotent", async () => {
  const lease = await delivery.open(bob, context(bob));
  expect((await delivery.open(bob, context(bob))).capability).toBe(lease.capability);
  now += 10_000;
  expect((await delivery.renew(bob, context(bob), lease.capability)).expiresAt).toBe(now + 30_000);
  now += 29_999; hosted.sweep();
  expect(delivery.activeLeaseCount).toBe(1);
  now += 1; hosted.sweep();
  expect(delivery.activeLeaseCount).toBe(0);
  expect(store.repo.hosted.all()).toHaveLength(0);
});

test("shutdown leaves ownership and deadline durable; reopen retains ownership", async () => {
  const lease = await delivery.open(bob, context(bob));
  delivery.close(); hosted.close();
  now += 10_000;
  hosted = createHostedSessions(application, { now: () => now, isAuthorized: () => authorized });
  delivery = createDelivery(hosted, { isAuthorized: () => authorized });
  expect(await hosted.whoami(bob, context(bob))).toHaveProperty("ownership", lease.ownership);
  const reopened = await delivery.open(bob, context(bob));
  expect(reopened.ownership).toBe(lease.ownership);
  expect(reopened.capability).not.toBe(lease.capability);
  expect(delivery.activeLeaseCount).toBe(1);
});

test("explicit release ends ownership and closes all children", async () => {
  await hosted.register(bob, context(bob), "child");
  const lease = await delivery.open(bob, context(bob));
  await delivery.release(bob, context(bob), lease.capability);
  expect(store.repo.hosted.all()).toEqual([]);
  await expect(delivery.renew(bob, context(bob), lease.capability)).rejects.toHaveProperty("code", "not_found");
  await hosted.bind(bob, context(bob), { name: "fe" });
  expect(await hosted.whoami(bob, context(bob))).not.toHaveProperty("ownership", lease.ownership);
});

test("cross WSS/hosted holders share one exclusion path", async () => {
  await expect(application.selectIdentity(bob.authed, "fe", sink)).rejects.toHaveProperty("code", "identity_in_use");
  const wss = (await application.selectIdentity(bob.authed, "be", sink)).session;
  await expect(hosted.bind(bob, context(bob), { name: "be" })).rejects.toHaveProperty("code", "identity_in_use");
  application.close(wss);
  await hosted.bind(bob, context(bob), { name: "be" });
  expect(await hosted.whoami(bob, context(bob))).toHaveProperty("name", "be");
});

test("disable immediately closes held ownership and invalidates capability", async () => {
  const lease = await delivery.open(bob, context(bob));
  store.repo.users.setDisabled(bob.authed.user_id, true);
  expect(store.repo.hosted.all()).toHaveLength(0);
  expect(delivery.activeLeaseCount).toBe(0);
  expect(() => delivery.describe(bob, context(bob), lease.capability)).toThrow();
});

test("board receipt is issued and scoped, not an arbitrary high-water cursor", async () => {
  createBoard(store.db, "alice@example.com/be", "#e2e", "test delivery");
  subscribe(store.db, "bob@example.com/fe", "#e2e", "push");
  const lease = await delivery.open(bob, context(bob));
  post(store.db, "alice@example.com/be", "#e2e", "hello");
  const items = await delivery.pending(bob, context(bob), lease.capability);
  expect(items.length).toBeGreaterThan(0);
  await expect(delivery.receipt(bob, context(bob), lease.capability, ["push:99999"])).rejects.toHaveProperty("code", "not_found");
  await delivery.receipt(bob, context(bob), lease.capability, items.map(i => i.id));
  expect(await delivery.pending(bob, context(bob), lease.capability)).toEqual([]);
});

test("failed rebind preserves lease and original grant attachment", async () => {
  const lease = await delivery.open(bob, context(bob));
  const second = { ...bob, grantId: "G2" };
  await expect(hosted.bind(second, context(bob), { name: "missing" })).rejects.toHaveProperty("code", "identity_unknown");
  expect(delivery.describe(bob, context(bob), lease.capability).capability).toBe(lease.capability);
});

test("receipt storage failure rolls back direct admission and keeps the issued batch retryable", async () => {
  const lease = await delivery.open(bob, context(bob));
  send();
  const batch = await delivery.pending(bob, context(bob), lease.capability);
  const original = application.receiptBoards;
  application.receiptBoards = () => { throw new Error("injected receipt rollback"); };
  try {
    await expect(delivery.receipt(bob, context(bob), lease.capability, batch.map(item => item.id))).rejects.toThrow("injected receipt rollback");
    expect(store.repo.cursors.directFor("bob@example.com/fe")).toBe(0);
    expect(delivery.describe(bob, context(bob), lease.capability).capability).toBe(lease.capability);
  } finally { application.receiptBoards = original; }
  await delivery.receipt(bob, context(bob), lease.capability, batch.map(item => item.id));
  expect(await delivery.pending(bob, context(bob), lease.capability)).toEqual([]);
});

test("per-user delivery capacity refuses without attaching another grant or dropping owners", async () => {
  const first = await delivery.open(bob, context(bob));
  for (let i = 1; i < 32; i++) {
    const c = context(bob, `root-${i}`);
    await hosted.bind(bob, c, { name: `worker-${i}`, create: true });
    await delivery.open(bob, c);
  }
  const contender = context(bob, "contender");
  await hosted.bind(bob, contender, { name: "contender", create: true });
  await expect(delivery.open({ ...bob, grantId: "G2" }, contender)).rejects.toHaveProperty("code", "bad_request");
  expect(delivery.activeLeaseCount).toBe(32);
  expect(hosted.row("id" in contender ? contender.id : "")?.grant_id).toBe(bob.grantId);
  expect(delivery.describe(bob, context(bob), first.capability).capability).toBe(first.capability);
});

test("one lease admits more than 1000 deliveries with bounded idempotent receipt history", async () => {
  const lease = await delivery.open(bob, context(bob));
  for (let i = 0; i < 1100; i++) send(`message ${i}`);
  let firstId = "";
  let latest: string[] = [];
  for (let i = 0; i < 11; i++) {
    const batch = await delivery.pending(bob, context(bob), lease.capability);
    expect(batch).toHaveLength(100);
    firstId ||= batch[0]!.id;
    latest = batch.map(item => item.id);
    await delivery.receipt(bob, context(bob), lease.capability, latest);
    await delivery.receipt(bob, context(bob), lease.capability, latest);
  }
  const cursor = store.repo.cursors.directFor("bob@example.com/fe");
  await expect(delivery.receipt(bob, context(bob), lease.capability, [firstId])).rejects.toHaveProperty("code", "not_found");
  expect(store.repo.cursors.directFor("bob@example.com/fe")).toBe(cursor);
  expect(await delivery.pending(bob, context(bob), lease.capability)).toEqual([]);
  expect((await delivery.open(bob, context(bob))).capability).toBe(lease.capability);
  expect(delivery.activeLeaseCount).toBe(1);
});

test("renew completes while a transfer holds the reader gate past the original deadline", async () => {
  const lease = await delivery.open(bob, context(bob));
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const transfer = hosted.transfer(bob, context(bob), async (_session, guard) => {
    entered(); await held; guard();
  });
  await started;
  try {
    now += 20_000;
    const renewed = await delivery.renew(bob, context(bob), lease.capability);
    expect(renewed.expiresAt).toBe(now + 30_000);
    now += 20_000;
    hosted.sweep();
    expect(delivery.activeLeaseCount).toBe(1);
    expect(delivery.describe(bob, context(bob), lease.capability).ownership).toBe(lease.ownership);
  } finally { release(); }
  await transfer;
});

test("reattachment on successful open invalidates old grant capabilities", async () => {
  const lease = await delivery.open(bob, context(bob));
  const second = { ...bob, grantId: "G2" };
  const replacement = await delivery.open(second, context(bob));
  expect(replacement.ownership).toBe(lease.ownership);
  expect(delivery.activeLeaseCount).toBe(1);
  await expect(delivery.pending(bob, context(bob), lease.capability)).rejects.toHaveProperty("code", "not_found");
});
