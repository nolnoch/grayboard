import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "./application.ts";
import { openDatabase } from "./db.ts";
import { createHostedSessions, OPENCODE_CLIENT, OPENCODE_SESSION_META, sessionContext } from "./hosted.ts";
import type { OAuthPrincipal } from "./oauth.ts";
import { createDelivery } from "./delivery.ts";
import { claim, listClaims } from "../core/claims.ts";

let database: ReturnType<typeof openDatabase>;
let application: ReturnType<typeof createApplication>;
let hosted: ReturnType<typeof createHostedSessions>;
let delivery: ReturnType<typeof createDelivery>;
let principal: OAuthPrincipal;
let now: number;
let authorized: boolean;
let blobDir: string;
const context = (raw: string) => sessionContext(principal, { [OPENCODE_SESSION_META]: raw });
beforeEach(() => {
  blobDir = mkdtempSync(join(tmpdir(), "gb-hosted-"));
  database = openDatabase(":memory:", { blobDir });
  application = createApplication(database.repo, database.db);
  const user = database.repo.users.upsertByEmail("you@example.com", null);
  principal = { authed: { user_id: user.id, user_email: user.email, session_id: 0 }, clientId: OPENCODE_CLIENT, grantId: "G1", accessHash: "test", accessExpiry: Number.MAX_SAFE_INTEGER, scopes: ["tools", "delivery"] };
  now = Date.now(); authorized = true;
  hosted = createHostedSessions(application, { now: () => now, isAuthorized: () => authorized });
  delivery = createDelivery(hosted, { isAuthorized: () => authorized });
});
afterEach(() => { delivery.close(); hosted.close(); application.stopExpiry(); database.db.close(); rmSync(blobDir, { recursive: true, force: true }); });

test("unbound row quota survives service restart, idle cleanup frees rows and gates", async () => {
  for (let i = 0; i < hosted.limits.user; i++) await hosted.whoami(principal, context(`unbound-${i}`));
  expect(database.repo.hosted.all()).toHaveLength(hosted.limits.user);
  expect(hosted.gateCount).toBe(0);
  const before = database.db.query<{ count: number }, []>("SELECT count(*) AS count FROM hosted_ownerships").get()?.count;
  await expect(hosted.whoami(principal, context("overflow"))).rejects.toHaveProperty("code", "bad_request");
  expect(database.db.query<{ count: number }, []>("SELECT count(*) AS count FROM hosted_ownerships").get()?.count).toBe(before);
  hosted.close();
  hosted = createHostedSessions(application, { now: () => now, isAuthorized: () => authorized });
  await expect(hosted.whoami(principal, context("overflow"))).rejects.toHaveProperty("code", "bad_request");
  now += 900_001; hosted.sweep();
  expect(database.repo.hosted.all()).toEqual([]);
  await hosted.whoami(principal, context("overflow"));
  expect(hosted.gateCount).toBe(0);
  await hosted.end(principal, context("overflow"));
  expect(database.repo.hosted.all()).toEqual([]);
});

test("child quota refusal leaves grant, lease and graph unchanged; ending a child frees capacity", async () => {
  await hosted.bind(principal, context("root"), { name: "be", create: true });
  for (let i = 0; i < hosted.limits.children; i++) await hosted.register(principal, context("root"), `child-${i}`);
  const lease = await delivery.open(principal, context("root"));
  const otherGrant = { ...principal, grantId: "G2" };
  await expect(hosted.register(otherGrant, context("root"), "overflow")).rejects.toHaveProperty("code", "bad_request");
  expect(database.repo.hosted.all().every(row => row.grant_id === "G1")).toBe(true);
  expect(delivery.describe(principal, context("root"), lease.capability).capability).toBe(lease.capability);
  await hosted.end(principal, context("child-0"));
  await hosted.register(principal, context("root"), "overflow");
  expect(database.repo.hosted.all()).toHaveLength(1 + hosted.limits.children);
  expect(hosted.gateCount).toBe(0);
});

test("global quota applies across users transactionally without creating an overflow ownership", async () => {
  await hosted.whoami(principal, context("template"));
  const template = database.repo.hosted.all()[0]!;
  await hosted.end(principal, context("template"));
  database.repo.hosted.atomic(() => {
    for (let userIndex = 0; userIndex < hosted.limits.global / hosted.limits.user; userIndex++) {
      const user = database.repo.users.upsertByEmail(`user${userIndex}@example.com`, null);
      for (let i = 0; i < hosted.limits.user; i++) {
        const id = `seed-${userIndex}-${i}`;
        const ownership = database.repo.hosted.start(id, user.id, OPENCODE_CLIENT, now);
        database.repo.hosted.insert({ ...template, session_id: id, ownership_id: ownership, user_id: user.id });
      }
    }
  });
  await expect(hosted.whoami(principal, context("overflow"))).rejects.toHaveProperty("code", "bad_request");
  expect(database.repo.hosted.all()).toHaveLength(hosted.limits.global);
  expect(hosted.gateCount).toBe(0);
});

test("queued readers and writers retain one gate through retirement and root conversion", async () => {
  const lock = hosted.gate("ordered");
  let release!: () => void, entered = false;
  const held = lock.call(async () => { entered = true; await new Promise<void>(resolve => { release = resolve; }); });
  expect(entered).toBe(true);
  const order: string[] = [];
  const writer = hosted.gate("ordered").bind(async () => { order.push("writer"); });
  const reader = hosted.gate("ordered").call(async () => { order.push("reader"); });
  expect(hosted.gateCount).toBe(1);
  release(); await Promise.all([held, writer, reader]);
  expect(order).toEqual(["writer", "reader"]);
  expect(hosted.gateCount).toBe(0);
  await hosted.whoami(principal, context("child"));
  await hosted.register(principal, context("root"), "child");
  await hosted.whoami(principal, context("child"));
  expect(hosted.gateCount).toBe(0);
});

test("native metadata is mapped only for the registered client", () => {
  expect(context("one")).not.toEqual(context("two"));
  expect(sessionContext({ ...principal, clientId: "other" }, { [OPENCODE_SESSION_META]: "one" })).toHaveProperty("missing");
  expect(sessionContext(principal, {})).toHaveProperty("missing");
});

test("unbound context cannot write or implicitly create names", async () => {
  await expect(hosted.run(principal, context("one"), "dm_send", () => true)).rejects.toHaveProperty("code", "unbound");
  await expect(hosted.bind(principal, context("one"), { name: "fe" })).rejects.toHaveProperty("code", "identity_unknown");
  await expect(hosted.bind(principal, { missing: "metadata missing" }, { name: "fe", create: true })).rejects.toHaveProperty("code", "unbound");
  expect(database.repo.identities.listForUser(principal.authed.user_id)).toEqual([]);
});

test("two contexts execute tools under distinct bound identities", async () => {
  await hosted.bind(principal, context("one"), { name: "fe", create: true });
  await hosted.bind(principal, context("two"), { name: "be", create: true });
  const identities = await Promise.all(["one", "two"].map(raw => hosted.run(principal, context(raw), "dm_history", session => session.identityFull)));
  expect(identities).toEqual(["you@example.com/fe", "you@example.com/be"]);
});

test("rebind retains ownership and children but fences old delivery", async () => {
  await hosted.bind(principal, context("root"), { name: "fe", create: true });
  await hosted.register(principal, context("root"), "child");
  const before = await hosted.whoami(principal, context("root"));
  const lease = await delivery.open(principal, context("root"));
  claim(database.db, "you@example.com/fe", "ticket:ENG-142");
  database.db.prepare("UPDATE handles SET status = ?, status_at = ?, queue_off = 1 WHERE name = ?").run("reviewing", now, "you@example.com/fe");
  await hosted.bind(principal, context("root"), { name: "be", create: true });
  expect(database.db.prepare("SELECT status, status_at, queue_off FROM handles WHERE name = ?").get("you@example.com/be")).toEqual({ status: "reviewing", status_at: now, queue_off: 1 });
  expect(listClaims(database.db)).toMatchObject([{ key: "ticket:ENG-142", holder: "you@example.com/be" }]);
  expect(await hosted.whoami(principal, context("child"))).toMatchObject({ name: "be", ownership: before.ownership, child: true });
  await expect(delivery.receipt(principal, context("root"), lease.capability, [])).rejects.toHaveProperty("code", "not_found");
  expect(delivery.activeLeaseCount).toBe(0);
});

test("children cannot bind or own delivery, and child end leaves root", async () => {
  await hosted.bind(principal, context("root"), { name: "fe", create: true });
  await hosted.register(principal, context("root"), "child");
  await expect(hosted.bind(principal, context("child"), { name: "be", create: true })).rejects.toHaveProperty("code", "child_session");
  await expect(delivery.open(principal, context("child"))).rejects.toHaveProperty("code", "child_session");
  await hosted.end(principal, context("child"));
  expect(await hosted.whoami(principal, context("root"))).toHaveProperty("name", "fe");
  expect(await hosted.whoami(principal, context("child"))).toHaveProperty("unbound", true);
});

test("registration rejects invalid ownership graphs without moving an existing child", async () => {
  await hosted.bind(principal, context("root"), { name: "fe", create: true });
  await hosted.bind(principal, context("other"), { name: "be", create: true });
  await hosted.register(principal, context("root"), "child");
  await expect(hosted.register(principal, context("root"), "root")).rejects.toHaveProperty("code", "invalid_registration");
  await expect(hosted.register(principal, context("child"), "grandchild")).rejects.toHaveProperty("code", "root_is_child");
  await expect(hosted.register(principal, context("root"), "other")).rejects.toHaveProperty("code", "child_bound");
  await expect(hosted.register(principal, context("other"), "child")).rejects.toHaveProperty("code", "child_registered_elsewhere");
  await hosted.register(principal, context("unbound"), "grandchild");
  await expect(hosted.register(principal, context("root"), "unbound")).rejects.toHaveProperty("code", "has_children");
  const rootContext = context("root");
  if (!("id" in rootContext)) throw new Error("fixture context missing");
  await expect(hosted.end(principal, context("child"), rootContext.id)).rejects.toHaveProperty("code", "child_session");
  expect(await hosted.whoami(principal, context("child"))).toMatchObject({ name: "fe", child: true });
  const foreign = database.repo.users.upsertByEmail("peer@example.com", null);
  const outsider = { ...principal, authed: { user_id: foreign.id, user_email: foreign.email, session_id: 0 } };
  const outsiderContext = sessionContext(outsider, { [OPENCODE_SESSION_META]: "root" });
  expect(await hosted.whoami(outsider, outsiderContext)).toHaveProperty("unbound", true);
  await hosted.bind(outsider, outsiderContext, { name: "fe", create: true });
  expect(await hosted.whoami(principal, context("root"))).toHaveProperty("name", "fe");
  const wrongClient = { ...principal, clientId: "https://other.example/client.json" };
  await expect(hosted.bind(wrongClient, sessionContext(wrongClient, { [OPENCODE_SESSION_META]: "root" }), { name: "fe" })).rejects.toHaveProperty("code", "unbound");
});

test("a second grant write does not attach; successful owning call does", async () => {
  const root = context("root");
  await hosted.bind(principal, root, { name: "fe", create: true });
  const second = { ...principal, grantId: "G2" };
  await hosted.run(second, root, "peer_status", () => true);
  expect(hosted.row("id" in root ? root.id : "")?.grant_id).toBe("G1");
  await expect(hosted.bind(second, root, { name: "missing" })).rejects.toHaveProperty("code", "identity_unknown");
  expect(hosted.row("id" in root ? root.id : "")?.grant_id).toBe("G1");
  await hosted.register(second, root, "child");
  expect(hosted.row("id" in root ? root.id : "")?.grant_id).toBe("G2");
});

test("durable lease deadline expires once without a contender", async () => {
  await hosted.bind(principal, context("root"), { name: "fe", create: true });
  await hosted.register(principal, context("root"), "child");
  await delivery.open(principal, context("root"));
  now += 30_001;
  hosted.sweep(); hosted.sweep();
  expect(delivery.activeLeaseCount).toBe(0);
  expect(database.repo.hosted.all()).toEqual([]);
});

async function paused<T>(point: string, start: () => Promise<T>, overlap: () => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "gb-hosted-pause-"));
  const file = join(dir, "release");
  const oldPoint = process.env.BUS_TEST_PAUSE, oldFile = process.env.BUS_TEST_PAUSE_FILE;
  let hit!: () => void;
  const reached = new Promise<void>(resolve => { hit = resolve; });
  const log = spyOn(console, "error").mockImplementation((message: unknown) => {
    if (message === `[grayboard] test pause hit: ${point}`) hit();
  });
  process.env.BUS_TEST_PAUSE = point; process.env.BUS_TEST_PAUSE_FILE = file;
  const operation = start();
  try {
    await reached;
    await overlap();
    writeFileSync(file, "release");
    return await operation;
  } finally {
    writeFileSync(file, "release");
    await operation.catch(() => {});
    if (oldPoint === undefined) delete process.env.BUS_TEST_PAUSE; else process.env.BUS_TEST_PAUSE = oldPoint;
    if (oldFile === undefined) delete process.env.BUS_TEST_PAUSE_FILE; else process.env.BUS_TEST_PAUSE_FILE = oldFile;
    log.mockRestore(); rmSync(dir, { recursive: true, force: true });
  }
}

test("pending holds the reader gate while rebind waits; stale receipt cannot move the old cursor", async () => {
  await hosted.bind(principal, context("root"), { name: "fe", create: true });
  const lease = await delivery.open(principal, context("root"));
  const sender = (await application.selectIdentity(principal.authed, "sender", { deliver() {}, closed() {}, probe: async () => true }, { push: false })).session;
  application.send(sender, "you@example.com/fe", "old mailbox");
  let binding!: ReturnType<typeof hosted.bind>, finished = false;
  const issued = await paused("hosted:pending:in-gate", () => delivery.pending(principal, context("root"), lease.capability), async () => {
    binding = hosted.bind(principal, context("root"), { name: "be", create: true }).then(value => { finished = true; return value; });
    await Promise.resolve(); await Promise.resolve();
    expect(finished).toBe(false);
    expect((await database.repo.hosted.all()).find(row => row.name)?.name).toBe("fe");
  });
  await binding;
  expect(issued).toHaveLength(1);
  await expect(delivery.receipt(principal, context("root"), lease.capability, issued.map(item => item.id))).rejects.toHaveProperty("code", "not_found");
  expect(database.repo.cursors.directFor("you@example.com/fe")).toBe(0);
  await expect(delivery.renew(principal, context("root"), lease.capability)).rejects.toHaveProperty("code", "not_found");
  await expect(delivery.release(principal, context("root"), lease.capability)).rejects.toHaveProperty("code", "not_found");
});

test("tool reader gate excludes rebind and revoke during its pause prevents the write", async () => {
  await hosted.bind(principal, context("root"), { name: "fe", create: true });
  let wrote = false;
  const operation = paused("hosted:tool:in-gate", () => hosted.run(principal, context("root"), "dm_send", () => { wrote = true; }), async () => { authorized = false; });
  await expect(operation).rejects.toHaveProperty("code", "unauthenticated");
  expect(wrote).toBe(false);
});

test("bind publishes its new holder before the after-commit pause and old-mailbox DMs stay queued", async () => {
  await hosted.bind(principal, context("root"), { name: "fe", create: true });
  const sender = (await application.selectIdentity(principal.authed, "sender", { deliver() {}, closed() {}, probe: async () => true }, { push: false })).session;
  await paused("hosted:bind:after-commit", () => hosted.bind(principal, context("root"), { name: "be", create: true }), async () => {
    application.send(sender, "you@example.com/fe", "not for be");
    expect(application.hostedHolder("you@example.com/fe")).toBeUndefined();
    expect(application.hostedHolder("you@example.com/be")).toBeDefined();
  });
  const lease = await delivery.open(principal, context("root"));
  expect(await delivery.pending(principal, context("root"), lease.capability)).toEqual([]);
  expect(database.repo.cursors.directFor("you@example.com/fe")).toBe(0);
});

test("WSS contender releases a never-leased hosted owner only after the idle window", async () => {
  await hosted.bind(principal, context("root"), { name: "fe", create: true });
  const sink = { deliver() {}, closed() {}, probe: async () => true };
  await expect(application.selectIdentity(principal.authed, "fe", sink)).rejects.toHaveProperty("code", "identity_in_use");
  now += 900_001;
  const acquired = await application.selectIdentity(principal.authed, "fe", sink);
  expect(acquired.session.identityFull).toBe("you@example.com/fe");
  expect(database.repo.hosted.all()).toEqual([]);
  application.close(acquired.session);
});
