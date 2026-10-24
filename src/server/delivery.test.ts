import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationError, createApplication, type ApplicationSession, type DeliverySink } from "./application.ts";
import { createDelivery, type DeliveryPrincipal } from "./delivery.ts";
import { openDatabase } from "./db.ts";
import { storeUpload } from "./attachments.ts";
import { createBoard, pendingFor, post, subscribe } from "../core/boards.ts";

let store: ReturnType<typeof openDatabase>;
let application: ReturnType<typeof createApplication>;
let delivery: ReturnType<typeof createDelivery>;
let alice: DeliveryPrincipal;
let bob: DeliveryPrincipal;
let sender: ApplicationSession;
let dir: string;
let now: number;
let authorized: boolean;
const sink: DeliverySink = { deliver() {}, closed() {}, probe: async () => true };
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "gb-delivery-"));
  store = openDatabase(":memory:", { blobDir: dir });
  application = createApplication(store.repo, store.db);
  const principal = (email: string): DeliveryPrincipal => {
    const user = store.repo.users.upsertByEmail(email, null);
    return { authed: { user_id: user.id, user_email: email, session_id: 0 }, grantId: `grant:${user.id}` };
  };
  alice = principal("alice@example.com");
  bob = principal("bob@example.com");
  now = Date.now();
  authorized = true;
  delivery = createDelivery(application, { ttlMs: 30_000, now: () => now, isAuthorized: () => authorized });
  sender = (await application.selectIdentity(alice.authed, "be", sink, { push: false })).session;
});
afterEach(() => {
  delivery.close();
  application.stopExpiry();
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});
const send = (body = "hello", pending = false) => application.send(sender, "bob@example.com/fe", body, { pending }).message_id;

test("durable reads repeat without admission; lost hints and explicit reconnect recover", async () => {
  let hints = 0;
  const lease = await delivery.open(bob, "fe", { changed: () => { hints++; throw new Error("lost"); } });
  const first = send("first", true);
  const second = send("second");
  expect(hints).toBe(2);
  const pending = delivery.pending(bob, lease.capability);
  expect(pending.map(p => p.id)).toEqual([`direct:${first}`, `direct:${second}`]);
  expect(pending.every(p => p.actionable)).toBe(true);
  expect(delivery.pending(bob, lease.capability)).toEqual(pending);
  expect(store.repo.cursors.directFor("bob@example.com/fe")).toBe(0);
  let recovered = 0;
  now += 10_000;
  expect(delivery.renew(bob, lease.capability, { changed: () => { recovered++; } }).expiresAt).toBe(now + 30_000);
  send("third");
  expect(recovered).toBe(1);
  expect(delivery.pending(bob, lease.capability)).toHaveLength(3);
  delivery.receipt(bob, lease.capability, pending.map(p => p.id));
  delivery.receipt(bob, lease.capability, pending.map(p => p.id));
  expect(store.repo.cursors.directFor("bob@example.com/fe")).toBe(second);
  expect(application.inbox(sender).promised).toHaveLength(1);
  delivery.release(bob, lease.capability);
  const again = await delivery.open(bob, "fe");
  expect(delivery.pending(bob, again.capability)).toHaveLength(1);
  expect(() => delivery.receipt(bob, again.capability, [pending[0]!.id])).toThrow();
});

test("only an issued contiguous direct prefix can advance the MAX cursor, ignoring global gaps", async () => {
  const lease = await delivery.open(bob, "fe");
  send("first");
  store.repo.messages.insert("alice@example.com/be", "user", "alice@example.com/be", "gap", null, false);
  send("second");
  const items = delivery.pending(bob, lease.capability);
  expect(() => delivery.receipt(bob, lease.capability, [items[1]!.id])).toThrow();
  expect(store.repo.cursors.directFor("bob@example.com/fe")).toBe(0);
  expect(() => delivery.receipt(bob, lease.capability, [items[0]!.id, "direct:99999"])).toThrow();
  expect(store.repo.cursors.directFor("bob@example.com/fe")).toBe(0);
  delivery.receipt(bob, lease.capability, [items[0]!.id]);
  delivery.receipt(bob, lease.capability, [items[0]!.id, items[1]!.id]);
  expect(delivery.pending(bob, lease.capability)).toEqual([]);
});

test("unexposed items, foreign principal/grant/capability and mutated payloads confer no receipt authority", async () => {
  const lease = await delivery.open(bob, "fe");
  const id = send();
  expect(() => delivery.receipt(bob, lease.capability, [`direct:${id}`])).toThrow();
  const items = delivery.pending(bob, lease.capability);
  items[0]!.id = "direct:99999";
  expect(() => delivery.receipt(bob, lease.capability, [items[0]!.id])).toThrow();
  for (const [p, capability] of [[alice, lease.capability], [{ ...bob, grantId: "other" }, lease.capability], [bob, "unknown"]] as const) {
    expect(() => delivery.pending(p, capability)).toThrow("delivery lease or item not found");
    expect(() => delivery.renew(p, capability)).toThrow();
    expect(() => delivery.release(p, capability)).toThrow();
    expect(() => delivery.receipt(p, capability, [`direct:${id}`])).toThrow();
  }
  expect(store.repo.cursors.directFor("bob@example.com/fe")).toBe(0);
  delivery.receipt(bob, lease.capability, [`direct:${id}`]);
});

test("issued items are lease-bound and retain authorized attachment metadata", async () => {
  const lease = await delivery.open(bob, "fe");
  const other = await delivery.open(bob, "sim");
  const attachment = await storeUpload(store.repo, store.db, alice.authed.user_email, sender.identityFull, {
    filename: "note.txt", type: "text/plain", data: new TextEncoder().encode("fixture"),
  });
  application.send(sender, "bob@example.com/fe", "attached", { attachment_ids: [attachment.id] });
  const items = delivery.pending(bob, lease.capability);
  expect(items).toMatchObject([{ event: { kind: "direct", message: { attachments: [{ id: attachment.id, filename: "note.txt" }] } } }]);
  expect(() => delivery.receipt(bob, other.capability, [items[0]!.id])).toThrow();
  expect(delivery.pending(bob, other.capability)).toEqual([]);
  expect(delivery.pending(bob, lease.capability)).toEqual(items);
});

test("tools-only connections coexist, but live WS-style and competing lease owners collide", async () => {
  const ws = (await application.selectIdentity(bob.authed, "fe", sink)).session;
  await expect(delivery.open(bob, "fe")).rejects.toMatchObject({ code: "identity_in_use" });
  application.close(ws);
  const results = await Promise.allSettled([delivery.open(bob, "fe"), delivery.open(bob, "fe")]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  const lease = results.find(r => r.status === "fulfilled");
  if (lease?.status !== "fulfilled") throw new Error("missing lease");
  const tools = (await application.selectIdentity(bob.authed, "fe", sink, { push: false })).session;
  send();
  expect(application.pending(tools)).toHaveLength(1);
  expect(delivery.pending(bob, lease.value.capability)).toHaveLength(1);
  await expect(application.selectIdentity(bob.authed, "fe", sink)).rejects.toMatchObject({ code: "identity_in_use" });
  delivery.release(bob, lease.value.capability);
  await expect(application.selectIdentity(bob.authed, "fe", sink)).resolves.toHaveProperty("session");
});

test("expiry, grant revocation, user disable and application disconnect release the same registry", async () => {
  for (const reason of ["expiry", "grant", "disable", "disconnect"] as const) {
    let closed = 0;
    const lease = await delivery.open(bob, "fe", { closed: () => { closed++; } });
    send();
    const item = delivery.pending(bob, lease.capability)[0]!;
    if (reason === "expiry") now = lease.expiresAt;
    if (reason === "grant") authorized = false;
    if (reason === "disable") store.repo.users.setDisabled(bob.authed.user_id, true);
    if (reason === "disconnect") application.disconnectUser(bob.authed.user_id);
    delivery.revalidate();
    expect(closed).toBe(1);
    expect(() => delivery.receipt(bob, lease.capability, [item.id])).toThrow();
    expect(store.repo.cursors.directFor("bob@example.com/fe")).toBe(0);
    authorized = true;
    store.repo.users.setDisabled(bob.authed.user_id, false);
    const replacement = (await application.selectIdentity(bob.authed, "fe", sink)).session;
    application.close(replacement);
  }
});

test("an expired lease probe permits replacement, but valid leases require the explicit capability", async () => {
  let closed = 0;
  const lease = await delivery.open(bob, "fe", { closed: () => { closed++; } });
  send();
  await expect(delivery.open(bob, "fe")).rejects.toMatchObject({ code: "identity_in_use" });
  now = lease.expiresAt;
  const replacement = await delivery.open(bob, "fe");
  expect(closed).toBe(1);
  expect(delivery.pending(bob, replacement.capability)).toHaveLength(1);
  expect(() => delivery.renew(bob, lease.capability)).toThrow();
});

test("asynchronous failed invalidation is a hint only and cannot poison later hints", async () => {
  let count = 0;
  const lease = await delivery.open(bob, "fe", { changed: async () => { count++; throw new Error("unavailable"); } });
  send();
  await Promise.resolve();
  send();
  await Promise.resolve();
  expect(count).toBe(2);
  expect(delivery.pending(bob, lease.capability)).toHaveLength(2);
  expect(store.repo.cursors.directFor("bob@example.com/fe")).toBe(0);
});

test("timer revalidation expires leases without traffic", async () => {
  let closed = 0;
  delivery.close();
  delivery = createDelivery(application, { ttlMs: 12, isAuthorized: () => true });
  await delivery.open(bob, "fe", { closed: () => { closed++; } });
  await Bun.sleep(30);
  expect(closed).toBe(1);
  await expect(application.selectIdentity(bob.authed, "fe", sink)).resolves.toHaveProperty("session");
});

test("shutdown and revoke during acquisition cannot leave an owner behind", async () => {
  for (const action of ["shutdown", "revoke"] as const) {
    let resolve!: (value: boolean) => void;
    const holder = (await application.selectIdentity(bob.authed, "fe", { ...sink, probe: () => new Promise(r => { resolve = r; }) })).session;
    const opening = delivery.open(bob, "fe");
    if (action === "shutdown") delivery.close();
    else application.disconnectUser(bob.authed.user_id);
    resolve(false);
    await expect(opening).rejects.toMatchObject({ code: "unauthenticated" });
    application.close(holder);
    const fresh = (await application.selectIdentity(bob.authed, "fe", sink)).session;
    application.close(fresh);
    if (action === "shutdown") delivery = createDelivery(application, { isAuthorized: () => true });
  }
  const opening = delivery.open(bob, "fe");
  delivery.close();
  await expect(opening).rejects.toThrow();
  await expect(delivery.open(bob, "fe")).rejects.toThrow();
  await expect(application.selectIdentity(bob.authed, "fe", sink)).resolves.toHaveProperty("session");
});

test("digest receipts use the exact issued snapshot, not a later digest highwater", async () => {
  const lease = await delivery.open(bob, "fe");
  createBoard(store.db, "alice@example.com/be", "e2e", "fixtures");
  subscribe(store.db, "bob@example.com/fe", "e2e", "digest");
  post(store.db, "alice@example.com/be", "e2e", "one");
  const first = delivery.pending(bob, lease.capability)[0]!;
  expect(first).toMatchObject({ actionable: false, event: { kind: "board", item: { kind: "digest", unread: 1 } } });
  const latest = post(store.db, "alice@example.com/be", "e2e", "two").post;
  expect(() => delivery.receipt(bob, lease.capability, [`digest:e2e:${latest.id}`])).toThrow();
  delivery.receipt(bob, lease.capability, [first.id]);
  delivery.receipt(bob, lease.capability, [first.id]);
  const sub = store.db.query<{ cursor: number; notified_id: number }, []>("SELECT cursor, notified_id FROM subscriptions WHERE board='e2e'").get()!;
  expect(sub.cursor).toBe(0);
  expect(sub.notified_id).toBeLessThan(latest.id);
});

test("deferred replies remain context-only; mentions actionable; no board-read on resource reads", async () => {
  const lease = await delivery.open(bob, "fe");
  createBoard(store.db, "alice@example.com/be", "e2e", "fixtures");
  const root = post(store.db, "alice@example.com/be", "e2e", "question").post;
  post(store.db, "bob@example.com/fe", "e2e", "participating", root.id);
  post(store.db, "alice@example.com/be", "e2e", "reply", root.id);
  post(store.db, "alice@example.com/be", "e2e", "@bob/fe attention");
  const items = delivery.pending(bob, lease.capability);
  expect(items).toHaveLength(2);
  expect(items[0]).toMatchObject({ actionable: false, event: { item: { kind: "push", deferred: true, reason: "thread" } } });
  expect(items[1]).toMatchObject({ actionable: true, event: { item: { kind: "push", reason: "mention" } } });
  expect(delivery.pending(bob, lease.capability)).toEqual(items);
  expect(pendingFor(store.db, "bob@example.com/fe", { all: true })).toHaveLength(2);
});

test("team removal rejects issued board receipts and cleans inaccessible outbox without admission", async () => {
  const team = store.repo.teams.create("eng", alice.authed.user_id);
  store.repo.teams.addMember(team.id, alice.authed.user_id);
  store.repo.teams.addMember(team.id, bob.authed.user_id);
  const lease = await delivery.open(bob, "fe");
  application.call(sender, "board_post", { board: "eng", body: "@bob/fe private" });
  const items = delivery.pending(bob, lease.capability);
  expect(items).toHaveLength(1);
  store.repo.teams.removeMember(team.id, bob.authed.user_id);
  expect(() => delivery.receipt(bob, lease.capability, [items[0]!.id])).toThrow();
  expect(delivery.pending(bob, lease.capability)).toEqual([]);
  expect(() => delivery.receipt(bob, lease.capability, [items[0]!.id])).toThrow();
});

test("bounded batches progress by receipt and issued receipt storage backpressures instead of evicting", async () => {
  const lease = await delivery.open(bob, "fe");
  for (let i = 0; i < 1001; i++) send(String(i));
  for (let i = 0; i < 10; i++) {
    const items = delivery.pending(bob, lease.capability);
    expect(items).toHaveLength(100);
    delivery.receipt(bob, lease.capability, items.map(p => p.id));
  }
  expect(() => delivery.pending(bob, lease.capability)).toThrow("capacity");
  delivery.receipt(bob, lease.capability, ["direct:1"]);
  delivery.release(bob, lease.capability);
  const next = await delivery.open(bob, "fe");
  expect(delivery.pending(bob, next.capability)).toHaveLength(1);
});

test("human selection remains a separate trusted capability", async () => {
  await expect(delivery.open(bob, "human")).rejects.toMatchObject({ code: "bad_request" });
});

test("readonly lease descriptors validate the principal without renewal or mutable identity aliases", async () => {
  const lease = await delivery.open(bob, "fe");
  now += 10_000;
  const descriptor = delivery.describe(bob, lease.capability);
  expect(descriptor.expiresAt).toBe(lease.expiresAt);
  descriptor.identity.identity_full = "other@example.com/be";
  descriptor.identity.teams.push("#other");
  expect(delivery.describe(bob, lease.capability)).toEqual(lease);
  expect(() => delivery.describe(alice, lease.capability)).toThrow();
  expect(() => delivery.describe({ ...bob, grantId: "other" }, lease.capability)).toThrow();
  expect(delivery.activeLeaseCount).toBe(1);
  now = lease.expiresAt;
  expect(() => delivery.describe(bob, lease.capability)).toThrow();
  expect(delivery.activeLeaseCount).toBe(0);
});

test("per-user lease capacity frees on release and refuses before selecting another owner", async () => {
  const leases = [];
  for (let i = 0; i < 32; i++) leases.push(await delivery.open(bob, `lease${i}`));
  expect(delivery.activeLeaseCount).toBe(32);
  await expect(delivery.open(bob, "overflow")).rejects.toThrow("capacity");
  expect(store.repo.identities.findByUserAndName(bob.authed.user_id, "overflow")).toBeUndefined();
  delivery.release(bob, leases[0]!.capability);
  await delivery.open(bob, "overflow");
  expect(delivery.activeLeaseCount).toBe(32);
  delivery.close();
  expect(delivery.activeLeaseCount).toBe(0);
  const replacement = (await application.selectIdentity(bob.authed, "overflow", sink)).session;
  application.close(replacement);
});

test("global capacity includes pending async acquisitions and shutdown removes all reservations", async () => {
  const select = application.selectIdentity;
  let resume!: () => void;
  const gate = new Promise<void>(r => { resume = r; });
  let selections = 0;
  application.selectIdentity = async (...args) => { selections++; await gate; return select(...args); };
  const users = [alice, bob];
  for (let i = 0; i < 7; i++) {
    const u = store.repo.users.upsertByEmail(`user${i}@example.com`, null);
    users.push({ authed: { user_id: u.id, user_email: u.email, session_id: 0 }, grantId: `grant:${u.id}` });
  }
  const pending = [];
  try {
    for (const p of users.slice(0, 8)) for (let i = 0; i < 32; i++) pending.push(delivery.open(p, `lease${i}`));
    const settled = Promise.allSettled(pending);
    expect(delivery.activeLeaseCount).toBe(256);
    expect(selections).toBe(256);
    await expect(delivery.open(users[8]!, "overflow")).rejects.toThrow("capacity");
    expect(selections).toBe(256);
    delivery.close();
    expect(delivery.activeLeaseCount).toBe(0);
    resume();
    expect((await settled).every(r => r.status === "rejected")).toBe(true);
    expect(store.repo.identities.findByUserAndName(bob.authed.user_id, "lease0")).toBeUndefined();
    const replacement = (await select(bob.authed, "lease0", sink)).session;
    application.close(replacement);
  } finally { resume(); application.selectIdentity = select; }
});

for (const boundary of ["grant", "caller", "session"] as const) for (const internal of [false, true]) test(`strict delivery ${boundary} faults preserve ownership, TTL and receipts (application error: ${internal})`, async () => {
  delivery.close();
  const failure = internal ? new ApplicationError("internal", "storage unavailable") : new Error("storage unavailable");
  let failed = false;
  delivery = createDelivery(application, { now: () => now, isAuthorized: principal => {
    if (failed && (boundary === "grant" || boundary === "caller" && principal === bob)) throw failure;
    return true;
  } });
  const validate = application.revalidateSession;
  application.revalidateSession = session => {
    if (failed && boundary === "session" && session.push) throw failure;
    validate(session);
  };
  const lease = await delivery.open(bob, "fe");
  const first = send("first");
  const issued = delivery.pending(bob, lease.capability);
  const second = send("second");
  now += 10_000;
  failed = true;
  try {
    for (const call of [() => delivery.describe(bob, lease.capability), () => delivery.renew(bob, lease.capability), () => delivery.pending(bob, lease.capability), () => delivery.receipt(bob, lease.capability, [issued[0]!.id]), () => delivery.release(bob, lease.capability)]) {
      try { call(); throw new Error("request unexpectedly succeeded"); } catch (error) { expect(error).toBe(failure); }
      expect(delivery.activeLeaseCount).toBe(1);
      expect(store.repo.cursors.directFor("bob@example.com/fe")).toBe(0);
    }
  } finally { failed = false; application.revalidateSession = validate; }
  expect(delivery.describe(bob, lease.capability).expiresAt).toBe(lease.expiresAt);
  await expect(application.selectIdentity(bob.authed, "fe", sink)).rejects.toMatchObject({ code: "identity_in_use" });
  expect(() => delivery.receipt(bob, lease.capability, [`direct:${second}`])).toThrow("not found");
  expect(delivery.renew(bob, lease.capability).expiresAt).toBe(now + 30_000);
  delivery.receipt(bob, lease.capability, [issued[0]!.id]);
  expect(store.repo.cursors.directFor("bob@example.com/fe")).toBe(first);
  expect(delivery.pending(bob, lease.capability).map(item => item.id)).toEqual([`direct:${second}`]);
});

for (const phase of ["initial", "selected"] as const) test(`failed ${phase} open preserves the original fault and frees capacity and ownership`, async () => {
  delivery.close();
  const failure = new Error("original storage failure");
  let failed = true;
  delivery = createDelivery(application, { now: () => now, isAuthorized: () => {
    if (failed && phase === "initial") throw failure;
    return true;
  } });
  const validate = application.revalidateSession, close = application.close;
  application.revalidateSession = session => {
    if (failed && phase === "selected") throw failure;
    validate(session);
  };
  application.close = session => { close(session); throw new Error("cleanup storage failure"); };
  try {
    await expect(delivery.open(bob, "fe")).rejects.toBe(failure);
    expect(delivery.activeLeaseCount).toBe(0);
  } finally { failed = false; application.revalidateSession = validate; application.close = close; }
  const lease = await delivery.open(bob, "fe");
  expect(delivery.activeLeaseCount).toBe(1);
  delivery.release(bob, lease.capability);
  expect(delivery.activeLeaseCount).toBe(0);
});

for (const background of ["revalidate", "hint", "probe", "closed", "timer"] as const) test(`background delivery ${background} faults fail closed without poisoning commits or cleanup`, async () => {
  delivery.close();
  let failed = false, changed = 0, closed = 0;
  delivery = createDelivery(application, { now: () => now, isAuthorized: () => {
    if (failed) throw new Error("grant storage unavailable");
    return true;
  } });
  const select = application.selectIdentity, close = application.close;
  await delivery.open(bob, "fe", { changed() { changed++; }, closed() { closed++; throw new Error("callback failed"); } });
  application.close = session => { close(session); throw new Error("cleanup storage failure"); };
  failed = true;
  try {
    if (background === "revalidate") expect(() => delivery.revalidate()).not.toThrow();
    if (background === "hint") {
      const id = send("committed");
      expect(store.repo.messages.getById(id)?.body).toBe("committed");
    }
    if (background === "probe") {
      const replacement = await select(bob.authed, "fe", sink);
      close(replacement.session);
    }
    if (background === "closed") expect(() => application.disconnectUser(bob.authed.user_id)).not.toThrow();
    if (background === "timer") {
      const deadline = Date.now() + 2_000;
      while (closed === 0 && Date.now() < deadline) await Bun.sleep(10);
    }
    expect({ changed, closed }).toEqual({ changed: 0, closed: 1 });
    expect(delivery.activeLeaseCount).toBe(0);
    expect(store.repo.cursors.directFor("bob@example.com/fe")).toBe(0);
    expect(() => delivery.revalidate()).not.toThrow();
  } finally { failed = false; application.close = close; }
  const replacement = await select(bob.authed, "fe", sink);
  close(replacement.session);
});

test("background application session storage faults close leases, while actual revocation still releases owners", async () => {
  let closed = 0;
  await delivery.open(bob, "fe", { closed() { closed++; } });
  const validate = application.revalidateSession;
  application.revalidateSession = () => { throw new Error("session storage failure"); };
  try { expect(() => delivery.revalidate()).not.toThrow(); }
  finally { application.revalidateSession = validate; }
  expect(delivery.activeLeaseCount).toBe(0);
  expect(closed).toBe(1);
  const lease = await delivery.open(bob, "fe");
  authorized = false;
  expect(() => delivery.renew(bob, lease.capability)).toThrow("not found");
  expect(delivery.activeLeaseCount).toBe(0);
  authorized = true;
  const again = await delivery.open(bob, "fe");
  application.revalidateSession = () => { throw new ApplicationError("unauthenticated", "closed session"); };
  try { expect(() => delivery.describe(bob, again.capability)).toThrow("not found"); }
  finally { application.revalidateSession = validate; }
  expect(delivery.activeLeaseCount).toBe(0);
});
