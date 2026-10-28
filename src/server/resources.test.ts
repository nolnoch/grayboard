import { DEFAULT_HELLO_LIMIT, DEFAULT_AUTH_FAIL_LIMIT } from "./rate_limit.ts";
import { DEFAULT_TRUSTED_PROXIES } from "./client_addr.ts";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationError, createApplication, type ApplicationSession, type DeliveryEvent, type DeliverySink } from "./application.ts";
import { openDatabase } from "./db.ts";
import { boardResourceUri, createResources, parseBoardResourceUri } from "./resources.ts";
import { isSubscribed, subscribe } from "../core/boards.ts";
import { storeAttachment } from "../core/attachments.ts";
import { createTouchQueue, type AuthedUser } from "./auth.ts";
import { runRetention } from "./retention.ts";
import type { Config } from "./config.ts";
import { handleHttp } from "./http.ts";
import { UploadGate } from "./uploads.ts";

let store: ReturnType<typeof openDatabase>;
let application: ReturnType<typeof createApplication>;
let resources: ReturnType<typeof createResources>;
let dir: string;
let alice: AuthedUser;
let bob: AuthedUser;
let revoked: Set<ApplicationSession>;
const sink = (events: DeliveryEvent[] = []): DeliverySink => ({ deliver: e => { events.push(e); }, probe: async () => true, closed: () => {} });
const hooks = () => {
  const counts = { changed: 0, closed: 0 };
  return { counts, changed: () => { counts.changed++; }, closed: () => { counts.closed++; } };
};
async function select(user: AuthedUser, name = "be", push = false, events: DeliveryEvent[] = []) {
  return (await application.selectIdentity(user, name, sink(events), { push })).session;
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gb-resources-"));
  store = openDatabase(":memory:", { blobDir: dir });
  application = createApplication(store.repo, store.db);
  revoked = new Set();
  resources = createResources(application, { isAuthorized: s => !revoked.has(s) });
  const user = (email: string): AuthedUser => {
    const u = store.repo.users.upsertByEmail(email, null);
    return { user_id: u.id, user_email: email, session_id: 0 };
  };
  alice = user("alice@example.com");
  bob = user("bob@example.com");
});
afterEach(() => {
  resources.close();
  application.stopExpiry();
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("canonical board URIs reject encoded, delimiter, traversal, case and newline aliases", () => {
  expect(boardResourceUri("e2e")).toBe("grayboard://boards/e2e");
  expect(parseBoardResourceUri("grayboard://boards/e2e")).toBe("e2e");
  for (const suffix of ["%65%32e", "e2e/", "e2e?limit=1", "e2e#x", "../e2e", "%2f", "E2E", "e2e\n", "alice@example.com/be", ""]) {
    expect(() => parseBoardResourceUri(`grayboard://boards/${suffix}`)).toThrow("board resource not found");
  }
  expect(() => parseBoardResourceUri("GRAYBOARD://boards/e2e")).toThrow();
});

test("resource hook failures emit one fixed diagnostic without forged stack or cause", async () => {
  const s = await select(alice);
  application.call(s, "board_create", { name: "e2e", purpose: "test" });
  const log = spyOn(console, "error").mockImplementation(() => {});
  const forged = new Error("Bearer PRIVATE\n    at f (/private/refresh-token.ts:1:1)", { cause: "AUTHORIZATION-CODE" });
  try {
    resources.watch(s, boardResourceUri("e2e"), { changed: async () => { throw forged; } });
    application.call(s, "board_post", { board: "e2e", body: "test" });
    await Promise.resolve(); await Promise.resolve();
    expect(log.mock.calls.flat()).toEqual(['[grayboard] {"operation":"resources.changed","category":"failure","level":"error","class":"Error"}']);
  } finally { log.mockRestore(); }
});

test("separate multiwatcher fanout needs no attention subscriptions and preserves active ownership/status", async () => {
  const ownerEvents: DeliveryEvent[] = [];
  const owner = await select(alice, "be", true, ownerEvents);
  application.call(owner, "peer_status", { text: "working" });
  const a = await select(alice);
  const b = await select(bob);
  application.call(a, "board_create", { name: "e2e", purpose: "tests" });
  subscribe(store.db, a.identityFull, "e2e", "off");
  const h1 = hooks(), h2 = hooks(), h3 = hooks();
  resources.watch(a, boardResourceUri("e2e"), h1);
  resources.watch(a, boardResourceUri("e2e"), h2);
  resources.watch(b, boardResourceUri("e2e"), h3);
  expect(isSubscribed(store.db, a.identityFull, "e2e")).toBe(false);
  expect(isSubscribed(store.db, b.identityFull, "e2e")).toBe(false);
  application.call(b, "board_post", { board: "e2e", body: "hello" });
  expect([h1.counts.changed, h2.counts.changed, h3.counts.changed]).toEqual([1, 1, 1]);
  expect(resources.read(a, boardResourceUri("e2e")).posts[0]!.body).toBe("hello");
  expect(ownerEvents).toEqual([]);
  const peers = application.call(a, "peer_list", {}) as { peers: { handle: string; status?: string; online: boolean }[] };
  expect(peers.peers.find(p => p.handle === a.identityFull)).toMatchObject({ status: "working", online: true });
  await expect(select(alice, "be", true)).rejects.toMatchObject({ code: "identity_in_use" });
  resources.close();
  expect([h1.counts.closed, h2.counts.closed, h3.counts.closed]).toEqual([1, 1, 1]);
  application.send(b, a.identityFull, "direct");
  expect(ownerEvents).toHaveLength(1);
  expect(store.repo.cursors.directFor(a.identityFull)).toBe(0);
});

test("only authorized same-board watchers receive hints; lost membership closes without private data", async () => {
  const team = store.repo.teams.create("private", alice.user_id);
  store.repo.teams.addMember(team.id, alice.user_id);
  store.repo.teams.addMember(team.id, bob.user_id);
  const a = await select(alice), b = await select(bob);
  application.call(a, "board_create", { name: "open", purpose: "open" });
  const privateUri = boardResourceUri("private");
  const ha = hooks(), hb = hooks(), other = hooks();
  resources.watch(a, privateUri, ha);
  resources.watch(b, privateUri, hb);
  resources.watch(b, boardResourceUri("open"), other);
  application.call(a, "board_post", { board: "private", body: "secret" });
  expect([ha.counts.changed, hb.counts.changed, other.counts.changed]).toEqual([1, 1, 0]);
  store.repo.teams.removeMember(team.id, bob.user_id);
  application.call(a, "board_post", { board: "private", body: "after removal" });
  expect(hb.counts).toEqual({ changed: 1, closed: 1 });
  resources.revalidate();
  expect(hb.counts.closed).toBe(1);
  expect(resources.list(b).resources.map(r => r.uri)).not.toContain(privateUri);
  expect(() => resources.read(b, privateUri)).toThrow("no such board #private; see board_list");
  expect(() => resources.watch(b, privateUri, hooks())).toThrow("no such board #private; see board_list");
  application.call(a, "board_post", { board: "private", body: "new secret" });
  expect([ha.counts.changed, hb.counts.changed, other.counts.changed]).toEqual([3, 1, 0]);
});

test("attachments are metadata only and cannot escape the selected board/page", async () => {
  const team = store.repo.teams.create("private", alice.user_id);
  store.repo.teams.addMember(team.id, alice.user_id);
  const a = await select(alice), b = await select(bob);
  application.call(a, "board_create", { name: "open", purpose: "open" });
  const file = await storeAttachment(store.db, store.repo.blobs, a.identityFull, { filename: "visible.txt", type: "text/plain", data: new TextEncoder().encode("visible") });
  application.call(a, "board_post", { board: "open", body: "file", attachment_ids: [file.id] });
  const hidden = await storeAttachment(store.db, store.repo.blobs, a.identityFull, { filename: "hidden.txt", type: "text/plain", data: new TextEncoder().encode("hidden") });
  application.call(a, "board_post", { board: "private", body: "hidden", attachment_ids: [hidden.id] });
  const result = resources.read(b, boardResourceUri("open"));
  expect(result.posts[0]!.attachments).toEqual([{ id: file.id, filename: file.filename, type: file.type, size: file.size, sha256: file.sha256 }]);
  expect(JSON.stringify(result)).not.toContain("hidden");
  expect(JSON.stringify(result)).not.toContain(dir);
  expect(() => resources.read(b, boardResourceUri("private"))).toThrow("no such board");
  application.call(a, "board_post", { board: "open", body: "no file" });
  expect(resources.read(b, boardResourceUri("open"), { limit: 1 }).posts[0]!.attachments).toBeUndefined();
});

test("failed/missed callbacks do not acknowledge; reconcile reads recover and callback exceptions are isolated", async () => {
  const a = await select(alice), b = await select(bob);
  application.call(a, "board_create", { name: "e2e", purpose: "tests" });
  resources.watch(b, boardResourceUri("e2e"), { changed: () => { throw new Error("sync"); } });
  resources.watch(b, boardResourceUri("e2e"), { changed: async () => { throw new Error("async"); } });
  const good = hooks();
  resources.watch(b, boardResourceUri("e2e"), good);
  subscribe(store.db, b.identityFull, "e2e", "push");
  application.call(a, "board_post", { board: "e2e", body: "first" });
  application.call(a, "board_post", { board: "e2e", body: "second" });
  await Promise.resolve();
  expect(good.counts.changed).toBe(2);
  const pending = application.pending(b);
  expect(pending).toHaveLength(2);
  expect(resources.read(b, boardResourceUri("e2e")).posts.map(p => p.body)).toEqual(["first", "second"]);
  expect(resources.read(b, boardResourceUri("e2e")).posts.map(p => p.body)).toEqual(["first", "second"]);
  expect(application.pending(b)).toEqual(pending);
});

test("claim create/update/release and refused acquisition's opportunistic lapse signal without attention watchers", async () => {
  const a = await select(alice), b = await select(bob);
  const uri = boardResourceUri("e2e");
  application.call(a, "board_create", { name: "e2e", purpose: "tests" });
  subscribe(store.db, a.identityFull, "e2e", "off");
  const h = hooks();
  resources.watch(b, uri, h);
  const take = (key: string, extra = {}) => application.call(a, "claim_take", { key, board: "e2e", ...extra });
  const created = take("ticket:ENG-142") as Record<string, unknown>;
  expect(created.ok).toBe(true);
  expect(created.boards).toBeUndefined();
  expect(h.counts.changed).toBe(1);
  take("ticket:ENG-142"); // No post for an unchanged renewal.
  expect(h.counts.changed).toBe(1);
  take("ticket:ENG-142", { note: "progress" });
  expect(h.counts.changed).toBe(2);
  expect(() => application.call(b, "claim_release", { key: "ticket:ENG-142" })).toThrow("not you");
  expect(h.counts.changed).toBe(2);
  application.call(a, "claim_release", { key: "ticket:ENG-142" });
  expect(h.counts.changed).toBe(3);
  take("lapsed");
  application.call(a, "claim_take", { key: "occupied" });
  store.db.run("UPDATE claims SET expires_at = 0 WHERE key = 'lapsed'");
  const refused = application.call(b, "claim_take", { key: "occupied" }) as { ok: boolean };
  expect(refused.ok).toBe(false);
  expect(h.counts.changed).toBe(5);
  expect(resources.read(b, uri).posts.map(p => p.body)).toEqual([
    "[claim] ticket:ENG-142", "[update] ticket:ENG-142 — progress", "[release] ticket:ENG-142",
    "[claim] lapsed", `[expired] lapsed: not released by ${a.identityFull}; check with them before relying on it`,
  ]);
  expect(isSubscribed(store.db, a.identityFull, "e2e")).toBe(false);
  expect(isSubscribed(store.db, b.identityFull, "e2e")).toBe(false);
  expect(application.pending(b)).toEqual([]);
});

test("rolled back claims and unauthorized board mutations emit no hint or transient lapse", async () => {
  const team = store.repo.teams.create("private", alice.user_id);
  store.repo.teams.addMember(team.id, alice.user_id);
  const a = await select(alice), b = await select(bob);
  const uri = boardResourceUri("e2e");
  application.call(a, "board_create", { name: "e2e", purpose: "tests" });
  subscribe(store.db, a.identityFull, "e2e", "off");
  application.call(a, "claim_take", { key: "lapsed", board: "e2e" });
  store.db.run("UPDATE claims SET expires_at = 0 WHERE key = 'lapsed'");
  const h = hooks();
  resources.watch(b, uri, h);
  store.db.run(`CREATE TRIGGER fail_claim_post BEFORE INSERT ON posts WHEN NEW.body = '[claim] rollback'
    BEGIN SELECT RAISE(ABORT, 'rollback'); END`);
  expect(() => application.call(a, "claim_take", { key: "rollback", board: "e2e" })).toThrow("claim_take failed");
  expect(h.counts.changed).toBe(0);
  expect(resources.read(b, uri).posts.map(p => p.body)).toEqual(["[claim] lapsed"]);
  expect(store.db.query("SELECT key FROM claims WHERE key = 'lapsed'").get()).toEqual({ key: "lapsed" });
  expect(() => application.call(b, "board_post", { board: "private", body: "no" })).toThrow("no such board");
  expect(() => application.call(b, "claim_take", { key: "private", board: "private" })).toThrow("no such board");
  expect(h.counts.changed).toBe(0);
});

test("real bearer CLI claim route hints committed posts without attention subscribers or private leaks", async () => {
  const team = store.repo.teams.create("private", alice.user_id);
  store.repo.teams.addMember(team.id, alice.user_id);
  store.repo.teams.addMember(team.id, bob.user_id);
  const a = await select(alice), b = await select(bob);
  application.call(a, "board_create", { name: "e2e", purpose: "tests" });
  for (const session of [a, b]) {
    for (const board of ["e2e", "private"]) subscribe(store.db, session.identityFull, board, "off");
  }
  const publicHint = hooks(), privateHint = hooks(), removedHint = hooks();
  resources.watch(b, boardResourceUri("e2e"), publicHint);
  resources.watch(a, boardResourceUri("private"), privateHint);
  resources.watch(b, boardResourceUri("private"), removedHint);
  const config: Config = {
    dbPath: ":memory:", blobDir: dir, httpPort: 0,
    devAuth: true, publicUrl: "http://localhost", googleClientId: "dev", googleClientSecret: "",
    messageRetentionDays: 90, auditRetentionDays: 90, admins: [], helloLimit: DEFAULT_HELLO_LIMIT, authFailLimit: DEFAULT_AUTH_FAIL_LIMIT, trustedProxies: DEFAULT_TRUSTED_PROXIES, orgDomain: "example.com",
  };
  const uploads = new UploadGate(4 * store.repo.attachmentLimits.total, store.repo.attachmentLimits.total);
  const touches = createTouchQueue();
  const server = Bun.serve({
    port: 0,
    fetch: req => handleHttp(req, store.repo, store.db, config, touches, uploads, application.wake, undefined, application.disconnectUser, "127.0.0.1", application.boardsChanged),
  });
  const base = `http://localhost:${server.port}`;
  try {
    const login = async (email: string) => {
      const response = await fetch(`${base}/api/auth/dev-login`, { method: "POST", body: JSON.stringify({ email }) });
      expect(response.status).toBe(200);
      return (await response.json() as { session_token: string }).session_token;
    };
    const at = await login(alice.user_email), bt = await login(bob.user_email);
    const call = async (token: string, tool: string, args: Record<string, unknown>) => {
      const response = await fetch(`${base}/api/claims/call`, {
        method: "POST", headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ identity: "be", tool, args }),
      });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    expect(store.db.query("SELECT key FROM claims").all()).toEqual([]);
    expect((await call(at, "claim_take", { key: "short", board: "e2e", ttl_minutes: 0.001 })).body.ok).toBe(true);
    expect(publicHint.counts.changed).toBe(1);
    const deadline = Date.now() + 2_000;
    while (publicHint.counts.changed < 2 && Date.now() < deadline) await Bun.sleep(10);
    expect(publicHint.counts.changed).toBe(2);
    expect(store.db.query("SELECT key FROM claims").all()).toEqual([]);
    expect(resources.read(b, boardResourceUri("e2e")).posts.at(-1)!.body).toStartWith("[expired] short:");
    expect((await call(at, "claim_take", { key: "ticket:ENG-142", board: "e2e" })).body.ok).toBe(true);
    expect(publicHint.counts.changed).toBe(3);
    expect((await call(at, "claim_release", { key: "ticket:ENG-142" })).status).toBe(200);
    expect(publicHint.counts.changed).toBe(4);
    await call(at, "claim_take", { key: "lapsed", board: "e2e" });
    await call(at, "claim_take", { key: "occupied" });
    store.db.run("UPDATE claims SET expires_at = 0 WHERE key = 'lapsed'");
    const refused = await call(bt, "claim_take", { key: "occupied" });
    expect(refused.status).toBe(200);
    expect(refused.body.ok).toBe(false);
    expect(refused.body.boards).toBeUndefined();
    expect(publicHint.counts.changed).toBe(6);
    const bodies = resources.read(b, boardResourceUri("e2e")).posts.map(p => p.body);
    expect(bodies.slice(2, 5)).toEqual(["[claim] ticket:ENG-142", "[release] ticket:ENG-142", "[claim] lapsed"]);
    expect(bodies.at(-1)).toStartWith("[expired] lapsed:");
    store.repo.teams.removeMember(team.id, bob.user_id);
    expect((await call(at, "claim_take", { key: "secret", board: "private" })).status).toBe(200);
    expect(privateHint.counts.changed).toBe(1);
    expect(removedHint.counts).toEqual({ changed: 0, closed: 1 });
    expect((await call(bt, "claim_take", { key: "denied", board: "private" })).status).toBe(400);
    expect(publicHint.counts.changed).toBe(6);
    expect(privateHint.counts.changed).toBe(1);
    expect(() => resources.read(b, boardResourceUri("private"))).toThrow("no such board");
    const state = () => ({
      subscriptions: store.db.query("SELECT * FROM subscriptions ORDER BY board, handle").all(),
      outbox: store.db.query("SELECT * FROM outbox ORDER BY handle, post_id").all(),
    });
    const before = state();
    resources.read(b, boardResourceUri("e2e"));
    resources.read(a, boardResourceUri("private"));
    expect(state()).toEqual(before);
    for (const session of [a, b]) {
      expect(isSubscribed(store.db, session.identityFull, "e2e")).toBe(false);
      expect(application.pending(session)).toEqual([]);
      expect(store.repo.cursors.directFor(session.identityFull)).toBe(0);
    }
  } finally { touches.cancelAll(); server.stop(true); }
});

test("timer expiry independently hints with no attention subscribers", async () => {
  const a = await select(alice), b = await select(bob);
  const uri = boardResourceUri("e2e");
  application.call(a, "board_create", { name: "e2e", purpose: "tests" });
  subscribe(store.db, a.identityFull, "e2e", "off");
  const h = hooks();
  resources.watch(b, uri, h);
  application.call(a, "claim_take", { key: "short", board: "e2e", ttl_minutes: 0.001 });
  expect(h.counts.changed).toBe(1);
  const deadline = Date.now() + 2_000;
  while (h.counts.changed < 2 && Date.now() < deadline) await Bun.sleep(10);
  expect(h.counts.changed).toBe(2);
  expect(resources.read(b, uri).posts.at(-1)!.body).toStartWith("[expired] short:");
  expect(isSubscribed(store.db, a.identityFull, "e2e")).toBe(false);
  expect(isSubscribed(store.db, b.identityFull, "e2e")).toBe(false);
  expect(application.pending(b)).toEqual([]);
});

test("retention hints only actual committed post deletions and snapshot reads leave attention state intact", async () => {
  const a = await select(alice), b = await select(bob);
  const uri = boardResourceUri("e2e");
  application.call(a, "board_create", { name: "e2e", purpose: "tests" });
  subscribe(store.db, a.identityFull, "e2e", "off");
  application.call(a, "board_post", { board: "e2e", body: "old" });
  store.db.run("UPDATE posts SET created_at = 0 WHERE board = 'e2e'");
  application.call(a, "board_post", { board: "e2e", body: "kept" });
  const h = hooks();
  resources.watch(b, uri, h);
  const state = () => ({
    subscriptions: store.db.query("SELECT * FROM subscriptions ORDER BY board, handle").all(),
    outbox: store.db.query("SELECT * FROM outbox ORDER BY handle, post_id").all(),
  });
  const before = state();
  const config = { messageRetentionDays: 1, auditRetentionDays: 1 } as Config;
  await runRetention(store.repo, store.db, config, Date.now(), application.boardsChanged);
  expect(h.counts.changed).toBe(1);
  expect(resources.read(b, uri).posts.map(p => p.body)).toEqual(["kept"]);
  expect(state()).toEqual(before);
  await runRetention(store.repo, store.db, config, Date.now(), application.boardsChanged);
  expect(h.counts.changed).toBe(1);
});

test("unwatch is session-bound and bounded capacity is reclaimed by cancellation and closure", async () => {
  const a = await select(alice), b = await select(bob);
  application.call(a, "board_create", { name: "e2e", purpose: "tests" });
  const h = hooks();
  const ids = Array.from({ length: 32 }, () => resources.watch(a, boardResourceUri("e2e"), h));
  expect(() => resources.watch(a, boardResourceUri("e2e"), h)).toThrow("capacity");
  expect(() => resources.unwatch(b, ids[0]!)).toThrow("not found");
  resources.unwatch(a, ids[0]!);
  resources.unwatch(a, ids[0]!);
  resources.watch(a, boardResourceUri("e2e"), h);
  expect(h.counts.closed).toBe(1);
  application.close(a);
  expect(h.counts.closed).toBe(33);
  expect(() => resources.read(a, boardResourceUri("e2e"))).toThrow("unauthorized");
});

test("revocation, disabled users, application disconnect and stop close watchers", async () => {
  const a = await select(alice), b = await select(bob);
  application.call(a, "board_create", { name: "e2e", purpose: "tests" });
  const revokedHook = hooks();
  resources.watch(a, boardResourceUri("e2e"), revokedHook);
  revoked.add(a);
  // Notification must recheck authorization even without explicit revalidation.
  application.call(b, "board_post", { board: "e2e", body: "after revoke" });
  expect(revokedHook.counts).toEqual({ changed: 0, closed: 1 });
  expect(() => resources.list(a)).toThrow("unauthorized");
  const disabledHook = hooks();
  resources.watch(b, boardResourceUri("e2e"), disabledHook);
  store.repo.users.setDisabled(bob.user_id, true);
  resources.revalidate();
  expect(disabledHook.counts.closed).toBe(1);
  revoked.delete(a);
  const disconnectHook = hooks();
  resources.watch(a, boardResourceUri("e2e"), disconnectHook);
  application.disconnectUser(alice.user_id);
  expect(disconnectHook.counts.closed).toBe(1);
  const c = await select(alice, "fe");
  const stopped = hooks();
  resources.watch(c, boardResourceUri("e2e"), stopped);
  application.stopExpiry();
  expect(stopped.counts.closed).toBe(1);
  resources.close();
  expect(() => resources.watch(c, boardResourceUri("e2e"), hooks())).toThrow("unauthorized");
});

for (const boundary of ["grant", "session"] as const) for (const internal of [false, true]) test(`strict resource ${boundary} faults preserve provenance and watches (application error: ${internal})`, async () => {
  const a = await select(alice), b = await select(bob);
  application.call(a, "board_create", { name: "e2e", purpose: "tests" });
  resources.close();
  const failure = internal ? new ApplicationError("internal", "storage unavailable") : new Error("storage unavailable");
  let failed = false;
  resources = createResources(application, { isAuthorized: () => {
    if (failed && boundary === "grant") throw failure;
    return true;
  } });
  const validate = application.revalidateSession;
  application.revalidateSession = session => {
    if (failed && boundary === "session") throw failure;
    validate(session);
  };
  const uri = boardResourceUri("e2e"), h = hooks();
  const watch = resources.watch(b, uri, h);
  failed = true;
  try {
    for (const call of [() => resources.list(b), () => resources.read(b, uri), () => resources.watch(b, uri, hooks()), () => resources.unwatch(b, watch)]) {
      try { call(); throw new Error("request unexpectedly succeeded"); } catch (error) { expect(error).toBe(failure); }
    }
    expect(h.counts).toEqual({ changed: 0, closed: 0 });
    expect(store.repo.cursors.directFor(b.identityFull)).toBe(0);
  } finally { failed = false; application.revalidateSession = validate; }
  application.call(a, "board_post", { board: "e2e", body: "healthy" });
  expect(h.counts).toEqual({ changed: 1, closed: 0 });
  expect(resources.read(b, uri).posts.map(p => p.body)).toEqual(["healthy"]);
  expect(isSubscribed(store.db, b.identityFull, "e2e")).toBe(false);
  resources.unwatch(b, watch);
  expect(h.counts.closed).toBe(1);
});

for (const background of ["revalidate", "hint", "closed", "timer"] as const) test(`background resource ${background} faults isolate cleanup and close callbacks`, async () => {
  const a = await select(alice), b = await select(bob);
  application.call(a, "board_create", { name: "e2e", purpose: "tests" });
  resources.close();
  let failed = false;
  resources = createResources(application, { isAuthorized: () => {
    if (failed) throw new Error("grant storage unavailable");
    return true;
  } });
  const observe = application.observeBoard;
  application.observeBoard = (...args) => {
    const unsubscribe = observe(...args);
    return () => { unsubscribe(); throw new Error("cleanup failed"); };
  };
  let changed = 0, closed = 0;
  try {
    resources.watch(b, boardResourceUri("e2e"), {
      changed() { changed++; }, closed() { closed++; throw new Error("closed callback failed"); },
    });
    failed = true;
    if (background === "revalidate") expect(() => resources.revalidate()).not.toThrow();
    if (background === "hint") expect(() => application.call(a, "board_post", { board: "e2e", body: "committed" })).not.toThrow();
    if (background === "closed") expect(() => application.close(b)).not.toThrow();
    if (background === "timer") {
      const deadline = Date.now() + 2_000;
      while (closed === 0 && Date.now() < deadline) await Bun.sleep(10);
    }
    expect({ changed, closed }).toEqual({ changed: 0, closed: 1 });
    failed = false;
    if (background === "hint") expect(resources.read(a, boardResourceUri("e2e")).posts[0]!.body).toBe("committed");
    expect(store.repo.cursors.directFor(b.identityFull)).toBe(0);
    expect(() => resources.close()).not.toThrow();
    expect(closed).toBe(1);
  } finally { failed = false; application.observeBoard = observe; }
});

test("resource background session storage faults fail closed, but authoritative refusals still refuse requests", async () => {
  const a = await select(alice);
  application.call(a, "board_create", { name: "e2e", purpose: "tests" });
  const h = hooks();
  resources.watch(a, boardResourceUri("e2e"), h);
  const validate = application.revalidateSession;
  application.revalidateSession = () => { throw new Error("session storage unavailable"); };
  try {
    expect(() => resources.revalidate()).not.toThrow();
    expect(h.counts).toEqual({ changed: 0, closed: 1 });
  } finally { application.revalidateSession = validate; }
  for (let i = 0; i < 32; i++) resources.watch(a, boardResourceUri("e2e"), hooks());
  application.revalidateSession = () => { throw new ApplicationError("unauthenticated", "closed session"); };
  try { expect(() => resources.list(a)).toThrow("unauthorized"); }
  finally { application.revalidateSession = validate; }
  for (let i = 0; i < 32; i++) resources.watch(a, boardResourceUri("e2e"), hooks());
});
