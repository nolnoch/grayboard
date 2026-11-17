import { DEFAULT_HELLO_LIMIT, DEFAULT_AUTH_FAIL_LIMIT } from "./rate_limit.ts";
import { refusalCount } from "./metrics.ts";
import { AppSession } from "../../tests/support/app_session.ts";
import { DEFAULT_TRUSTED_PROXIES } from "./client_addr.ts";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationError, createApplication, type ApplicationSession } from "./application.ts";
import { openDatabase, queuedTx } from "./db.ts";
import { boardResourceUri, createResources, parseBoardResourceUri } from "./resources.ts";
import { isSubscribed, subscribe } from "../core/boards.ts";
import { storeAttachment } from "../core/attachments.ts";
import { createTouchQueue, type AuthedUser } from "./auth.ts";
import { runRetention } from "./retention.ts";
import type { Config } from "./config.ts";
import { handleHttp } from "./http.ts";
import { scratchDbPath } from "../../tests/support/scratch_db.ts";
import { seed } from "../../tests/support/seed.ts";

let store: ReturnType<typeof openDatabase>;
let application: ReturnType<typeof createApplication>;
let resources: ReturnType<typeof createResources>;
let dir: string;
let alice: AuthedUser;
let bob: AuthedUser;
let revoked: Set<ApplicationSession>;
const hooks = () => {
  const counts = { changed: 0, closed: 0 };
  return { counts, changed: () => { counts.changed++; }, closed: () => { counts.closed++; } };
};
// An upload is its user's (#284 #367): a send carries only uploads its principal made.
const quotaOf = (user: AuthedUser) => ({ principal: user.user_email, unsent: 1 << 20, stored: 1 << 20 });
// push: false is a tools-only session (it writes as the alias and holds nothing), push: true a holder that is delivered to.
async function open(user: AuthedUser, name = "be", push = false) {
  const s = new AppSession(application, store.repo, user, name, { push });
  await s.connect();
  return s;
}
async function select(user: AuthedUser, name = "be", push = false) {
  return (await open(user, name, push)).session;
}
// A watch's changed hook awaits its token check (#807 P3 A7d2c): every check here resolves in microtasks, so a
// macrotask turn sees each notification a commit started.
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
// A board or claim tool on a raw session, in a queued body, as hosted run holds the write queue around a tool.
async function call<T = unknown>(session: ApplicationSession, tool: string, args: Record<string, unknown>): Promise<T> {
  const result = await seed(store.repo, tx => application.call(tx, session, tool, args)) as T;
  await flush();
  return result;
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "gb-resources-"));
  store = openDatabase(scratchDbPath(), { blobDir: dir });
  application = createApplication(store.repo);
  revoked = new Set();
  resources = createResources(application, { isCurrent: () => true, isAuthorized: s => !revoked.has(s) });
  const user = async (email: string): Promise<AuthedUser> => {
    const u = await seed(store.repo, tx => store.repo.users.upsertByEmail(tx, email, null));
    return { user_id: u.id, user_email: email, session_id: 0 };
  };
  alice = await user("alice@example.com");
  bob = await user("bob@example.com");
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
  await call(s, "board_create", { name: "e2e", purpose: "test" });
  const log = spyOn(console, "error").mockImplementation(() => {});
  const forged = new Error("Bearer PRIVATE\n    at f (/private/refresh-token.ts:1:1)", { cause: "AUTHORIZATION-CODE" });
  try {
    resources.watch(s, boardResourceUri("e2e"), { changed: async () => { throw forged; } }, true);
    await call(s, "board_post", { board: "e2e", body: "test" });
    await Promise.resolve(); await Promise.resolve();
    expect(log.mock.calls.flat()).toEqual(['[grayboard] {"operation":"resources.changed","category":"failure","level":"error","class":"Error"}']);
  } finally { log.mockRestore(); }
});

test("separate multiwatcher fanout needs no attention subscriptions and preserves active ownership/status", async () => {
  const owner = await open(alice, "be", true);
  const ownerEvents = owner.events;
  await owner.call("peer_status", { text: "working" });
  const a = await select(alice);
  const b = await select(bob);
  await call(a, "board_create", { name: "e2e", purpose: "tests" });
  await seed(store.repo, () => subscribe(store.db, a.identityFull, "e2e", "off"));
  const h1 = hooks(), h2 = hooks(), h3 = hooks();
  resources.watch(a, boardResourceUri("e2e"), h1, true);
  resources.watch(a, boardResourceUri("e2e"), h2, true);
  resources.watch(b, boardResourceUri("e2e"), h3, true);
  expect(isSubscribed(store.db, a.identityFull, "e2e")).toBe(false);
  expect(isSubscribed(store.db, b.identityFull, "e2e")).toBe(false);
  await call(b, "board_post", { board: "e2e", body: "hello" });
  expect([h1.counts.changed, h2.counts.changed, h3.counts.changed]).toEqual([1, 1, 1]);
  expect((await resources.read(store.repo.read, a, boardResourceUri("e2e"))).posts[0]!.body).toBe("hello");
  expect(ownerEvents).toEqual([]);
  const peers = (await call(a, "peer_list", {})) as { peers: { handle: string; status?: string; online: boolean }[] };
  expect(peers.peers.find(p => p.handle === a.identityFull)).toMatchObject({ status: "working", online: true });
  // #284: a held alias refuses another session's bind as alias_held (was identity_in_use).
  await expect(select(alice, "be", true)).rejects.toMatchObject({ code: "alias_held" });
  resources.close();
  expect([h1.counts.closed, h2.counts.closed, h3.counts.closed]).toEqual([1, 1, 1]);
  await seed(store.repo, tx => application.send(tx, b, a.identityFull, "direct"));
  expect(ownerEvents).toHaveLength(1);
  expect(await store.repo.cursors.directFor(store.repo.read, a.identityFull)).toBe(0);
});

test("only authorized same-board watchers receive hints; lost membership closes without private data", async () => {
  const team = await seed(store.repo, async (tx) => {
    const t = await store.repo.teams.create(tx, "private", alice.user_id);
    await store.repo.teams.addMember(tx, t.id, alice.user_id);
    await store.repo.teams.addMember(tx, t.id, bob.user_id);
    return t;
  });
  const a = await select(alice), b = await select(bob);
  await call(a, "board_create", { name: "open", purpose: "open" });
  const privateUri = boardResourceUri("private");
  const ha = hooks(), hb = hooks(), other = hooks();
  resources.watch(a, privateUri, ha, true);
  resources.watch(b, privateUri, hb, true);
  resources.watch(b, boardResourceUri("open"), other, true);
  await call(a, "board_post", { board: "private", body: "secret" });
  expect([ha.counts.changed, hb.counts.changed, other.counts.changed]).toEqual([1, 1, 0]);
  await seed(store.repo, (tx) => store.repo.teams.removeMember(tx, team.id, bob.user_id));
  await call(a, "board_post", { board: "private", body: "after removal" });
  expect(hb.counts).toEqual({ changed: 1, closed: 1 });
  await resources.revalidate();
  expect(hb.counts.closed).toBe(1);
  expect((await resources.list(store.repo.read, b)).resources.map(r => r.uri)).not.toContain(privateUri);
  await expect(resources.read(store.repo.read, b, privateUri)).rejects.toThrow("no such board #private; see board_list");
  // The caller's board read (mcp's `Checked.boards`, #807 P3 B5a2) answers false, and the watch is refused as missing.
  const seen = (await application.boardsVisible(store.repo.read, b, ["private"])).get("private");
  expect(seen).toBe(false);
  expect(() => resources.watch(b, privateUri, hooks(), seen!)).toThrow("no such board #private; see board_list");
  await call(a, "board_post", { board: "private", body: "new secret" });
  expect([ha.counts.changed, hb.counts.changed, other.counts.changed]).toEqual([3, 1, 0]);
});

test("attachments are metadata only and cannot escape the selected board/page", async () => {
  const team = await seed(store.repo, async (tx) => {
    const t = await store.repo.teams.create(tx, "private", alice.user_id);
    await store.repo.teams.addMember(tx, t.id, alice.user_id);
    return t;
  });
  const a = await select(alice), b = await select(bob);
  await call(a, "board_create", { name: "open", purpose: "open" });
  const file = await storeAttachment(store.db, store.repo.blobs, a.identityFull, { filename: "visible.txt", type: "text/plain", data: new TextEncoder().encode("visible") }, { quota: quotaOf(alice), tx: queuedTx(store.repo) });
  await call(a, "board_post", { board: "open", body: "file", attachment_ids: [file.id] });
  const hidden = await storeAttachment(store.db, store.repo.blobs, a.identityFull, { filename: "hidden.txt", type: "text/plain", data: new TextEncoder().encode("hidden") }, { quota: quotaOf(alice), tx: queuedTx(store.repo) });
  await call(a, "board_post", { board: "private", body: "hidden", attachment_ids: [hidden.id] });
  const result = await resources.read(store.repo.read, b, boardResourceUri("open"));
  expect(result.posts[0]!.attachments).toEqual([{ id: file.id, filename: file.filename, type: file.type, size: file.size, sha256: file.sha256 }]);
  expect(JSON.stringify(result)).not.toContain("hidden");
  expect(JSON.stringify(result)).not.toContain(dir);
  await expect(resources.read(store.repo.read, b, boardResourceUri("private"))).rejects.toThrow("no such board");
  await call(a, "board_post", { board: "open", body: "no file" });
  expect((await resources.read(store.repo.read, b, boardResourceUri("open"), { limit: 1 })).posts[0]!.attachments).toBeUndefined();
});

test("failed/missed callbacks do not acknowledge; reconcile reads recover and callback exceptions are isolated", async () => {
  const a = await select(alice), b = await select(bob);
  await call(a, "board_create", { name: "e2e", purpose: "tests" });
  resources.watch(b, boardResourceUri("e2e"), { changed: () => { throw new Error("sync"); } }, true);
  resources.watch(b, boardResourceUri("e2e"), { changed: async () => { throw new Error("async"); } }, true);
  const good = hooks();
  resources.watch(b, boardResourceUri("e2e"), good, true);
  await seed(store.repo, () => subscribe(store.db, b.identityFull, "e2e", "push"));
  await call(a, "board_post", { board: "e2e", body: "first" });
  await call(a, "board_post", { board: "e2e", body: "second" });
  await Promise.resolve();
  expect(good.counts.changed).toBe(2);
  const pending = await application.pending(store.repo.read, b);
  expect(pending).toHaveLength(2);
  expect((await resources.read(store.repo.read, b, boardResourceUri("e2e"))).posts.map(p => p.body)).toEqual(["first", "second"]);
  expect((await resources.read(store.repo.read, b, boardResourceUri("e2e"))).posts.map(p => p.body)).toEqual(["first", "second"]);
  expect(await application.pending(store.repo.read, b)).toEqual(pending);
});

test("claim create/update/release and refused acquisition's opportunistic lapse signal without attention watchers", async () => {
  const a = await select(alice), b = await select(bob);
  const uri = boardResourceUri("e2e");
  await call(a, "board_create", { name: "e2e", purpose: "tests" });
  await seed(store.repo, () => subscribe(store.db, a.identityFull, "e2e", "off"));
  const h = hooks();
  resources.watch(b, uri, h, true);
  const take = (key: string, extra = {}) => call(a, "claim_take", { key, board: "e2e", ...extra });
  const created = await take("ticket:ENG-142") as Record<string, unknown>;
  expect(created.ok).toBe(true);
  expect(created.boards).toBeUndefined();
  expect(h.counts.changed).toBe(1);
  await take("ticket:ENG-142"); // No post for an unchanged renewal.
  expect(h.counts.changed).toBe(1);
  await take("ticket:ENG-142", { note: "progress" });
  expect(h.counts.changed).toBe(2);
  await expect(call(b, "claim_release", { key: "ticket:ENG-142" })).rejects.toThrow("not you");
  expect(h.counts.changed).toBe(2);
  await call(a, "claim_release", { key: "ticket:ENG-142" });
  expect(h.counts.changed).toBe(3);
  await take("lapsed");
  await call(a, "claim_take", { key: "occupied" });
  await seed(store.repo, () => store.db.run("UPDATE claims SET expires_at = 0 WHERE key = 'lapsed'"));
  const refused = await call<{ ok: boolean }>(b, "claim_take", { key: "occupied" });
  expect(refused.ok).toBe(false);
  expect(h.counts.changed).toBe(5);
  expect((await resources.read(store.repo.read, b, uri)).posts.map(p => p.body)).toEqual([
    "[claim] ticket:ENG-142", "[update] ticket:ENG-142 — progress", "[release] ticket:ENG-142",
    "[claim] lapsed", `[expired] lapsed: not released by ${a.identityFull}; check with them before relying on it`,
  ]);
  expect(isSubscribed(store.db, a.identityFull, "e2e")).toBe(false);
  expect(isSubscribed(store.db, b.identityFull, "e2e")).toBe(false);
  expect(await application.pending(store.repo.read, b)).toEqual([]);
});

test("rolled back claims and unauthorized board mutations emit no hint or transient lapse", async () => {
  const team = await seed(store.repo, async (tx) => {
    const t = await store.repo.teams.create(tx, "private", alice.user_id);
    await store.repo.teams.addMember(tx, t.id, alice.user_id);
    return t;
  });
  const a = await select(alice), b = await select(bob);
  const uri = boardResourceUri("e2e");
  await call(a, "board_create", { name: "e2e", purpose: "tests" });
  await seed(store.repo, () => subscribe(store.db, a.identityFull, "e2e", "off"));
  await call(a, "claim_take", { key: "lapsed", board: "e2e" });
  await seed(store.repo, () => store.db.run("UPDATE claims SET expires_at = 0 WHERE key = 'lapsed'"));
  const h = hooks();
  resources.watch(b, uri, h, true);
  store.db.run(`CREATE TRIGGER fail_claim_post BEFORE INSERT ON posts WHEN NEW.body = '[claim] rollback'
    BEGIN SELECT RAISE(ABORT, 'rollback'); END`);
  await expect(call(a, "claim_take", { key: "rollback", board: "e2e" })).rejects.toThrow("claim_take failed");
  expect(h.counts.changed).toBe(0);
  expect((await resources.read(store.repo.read, b, uri)).posts.map(p => p.body)).toEqual(["[claim] lapsed"]);
  expect(store.db.query("SELECT key FROM claims WHERE key = 'lapsed'").get()).toEqual({ key: "lapsed" });
  await expect(call(b, "board_post", { board: "private", body: "no" })).rejects.toThrow("no such board");
  await expect(call(b, "claim_take", { key: "private", board: "private" })).rejects.toThrow("no such board");
  expect(h.counts.changed).toBe(0);
});

test("real bearer CLI claim route hints committed posts without attention subscribers or private leaks", async () => {
  const team = await seed(store.repo, async (tx) => {
    const t = await store.repo.teams.create(tx, "private", alice.user_id);
    await store.repo.teams.addMember(tx, t.id, alice.user_id);
    await store.repo.teams.addMember(tx, t.id, bob.user_id);
    return t;
  });
  const a = await select(alice), b = await select(bob);
  await call(a, "board_create", { name: "e2e", purpose: "tests" });
  for (const session of [a, b]) {
    await seed(store.repo, () => { for (const board of ["e2e", "private"]) subscribe(store.db, session.identityFull, board, "off"); });
  }
  const publicHint = hooks(), privateHint = hooks(), removedHint = hooks();
  resources.watch(b, boardResourceUri("e2e"), publicHint, true);
  resources.watch(a, boardResourceUri("private"), privateHint, true);
  resources.watch(b, boardResourceUri("private"), removedHint, true);
  const config: Config = {
    dbPath: scratchDbPath(), blobDir: dir, httpPort: 0,
    devAuth: true, publicUrl: "http://localhost", googleClientId: "dev", googleClientSecret: "",
    messageRetentionDays: 90, auditRetentionDays: 90, admins: [], helloLimit: DEFAULT_HELLO_LIMIT, authFailLimit: DEFAULT_AUTH_FAIL_LIMIT, trustedProxies: DEFAULT_TRUSTED_PROXIES, orgDomain: "example.com",
  };
  const touches = createTouchQueue();
  const server = Bun.serve({
    port: 0,
    fetch: req => handleHttp(req, store.repo, config, touches, application.wake, undefined, { disconnectUser: application.disconnectUser, accessChanged: application.accessChanged }, "127.0.0.1", application.boardsChanged),
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
        body: JSON.stringify({ as: "be", tool, args }),
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
    expect((await resources.read(store.repo.read, b, boardResourceUri("e2e"))).posts.at(-1)!.body).toStartWith("[expired] short:");
    expect((await call(at, "claim_take", { key: "ticket:ENG-142", board: "e2e" })).body.ok).toBe(true);
    expect(publicHint.counts.changed).toBe(3);
    expect((await call(at, "claim_release", { key: "ticket:ENG-142" })).status).toBe(200);
    expect(publicHint.counts.changed).toBe(4);
    await call(at, "claim_take", { key: "lapsed", board: "e2e" });
    await call(at, "claim_take", { key: "occupied" });
    await seed(store.repo, () => store.db.run("UPDATE claims SET expires_at = 0 WHERE key = 'lapsed'"));
    const refused = await call(bt, "claim_take", { key: "occupied" });
    expect(refused.status).toBe(200);
    expect(refused.body.ok).toBe(false);
    expect(refused.body.boards).toBeUndefined();
    expect(publicHint.counts.changed).toBe(6);
    const bodies = (await resources.read(store.repo.read, b, boardResourceUri("e2e"))).posts.map(p => p.body);
    expect(bodies.slice(2, 5)).toEqual(["[claim] ticket:ENG-142", "[release] ticket:ENG-142", "[claim] lapsed"]);
    expect(bodies.at(-1)).toStartWith("[expired] lapsed:");
    await seed(store.repo, (tx) => store.repo.teams.removeMember(tx, team.id, bob.user_id));
    expect((await call(at, "claim_take", { key: "secret", board: "private" })).status).toBe(200);
    expect(privateHint.counts.changed).toBe(1);
    expect(removedHint.counts).toEqual({ changed: 0, closed: 1 });
    expect((await call(bt, "claim_take", { key: "denied", board: "private" })).status).toBe(400);
    expect(publicHint.counts.changed).toBe(6);
    expect(privateHint.counts.changed).toBe(1);
    await expect(resources.read(store.repo.read, b, boardResourceUri("private"))).rejects.toThrow("no such board");
    const state = () => ({
      subscriptions: store.db.query("SELECT * FROM subscriptions ORDER BY board, handle").all(),
      outbox: store.db.query("SELECT * FROM outbox ORDER BY handle, post_id").all(),
    });
    const before = state();
    await resources.read(store.repo.read, b, boardResourceUri("e2e"));
    await expect(resources.read(store.repo.read, a, boardResourceUri("private"))).resolves.toBeDefined();
    expect(state()).toEqual(before);
    for (const session of [a, b]) {
      expect(isSubscribed(store.db, session.identityFull, "e2e")).toBe(false);
      expect(await application.pending(store.repo.read, session)).toEqual([]);
      expect(await store.repo.cursors.directFor(store.repo.read, session.identityFull)).toBe(0);
    }
  } finally { touches.cancelAll(); server.stop(true); }
});

test("timer expiry independently hints with no attention subscribers", async () => {
  const a = await select(alice), b = await select(bob);
  const uri = boardResourceUri("e2e");
  await call(a, "board_create", { name: "e2e", purpose: "tests" });
  await seed(store.repo, () => subscribe(store.db, a.identityFull, "e2e", "off"));
  const h = hooks();
  resources.watch(b, uri, h, true);
  await call(a, "claim_take", { key: "short", board: "e2e", ttl_minutes: 0.001 });
  expect(h.counts.changed).toBe(1);
  const deadline = Date.now() + 2_000;
  while (h.counts.changed < 2 && Date.now() < deadline) await Bun.sleep(10);
  expect(h.counts.changed).toBe(2);
  expect((await resources.read(store.repo.read, b, uri)).posts.at(-1)!.body).toStartWith("[expired] short:");
  expect(isSubscribed(store.db, a.identityFull, "e2e")).toBe(false);
  expect(isSubscribed(store.db, b.identityFull, "e2e")).toBe(false);
  expect(await application.pending(store.repo.read, b)).toEqual([]);
});

test("retention hints only actual committed post deletions and snapshot reads leave attention state intact", async () => {
  const a = await select(alice), b = await select(bob);
  const uri = boardResourceUri("e2e");
  await call(a, "board_create", { name: "e2e", purpose: "tests" });
  await seed(store.repo, () => subscribe(store.db, a.identityFull, "e2e", "off"));
  await call(a, "board_post", { board: "e2e", body: "old" });
  await seed(store.repo, () => store.db.run("UPDATE posts SET created_at = 0 WHERE board = 'e2e'"));
  await call(a, "board_post", { board: "e2e", body: "kept" });
  const h = hooks();
  resources.watch(b, uri, h, true);
  const state = () => ({
    subscriptions: store.db.query("SELECT * FROM subscriptions ORDER BY board, handle").all(),
    outbox: store.db.query("SELECT * FROM outbox ORDER BY handle, post_id").all(),
  });
  const before = state();
  const config = { messageRetentionDays: 1, auditRetentionDays: 1 } as Config;
  await runRetention(store.repo, config, Date.now(), application.boardsChanged);
  await flush();
  expect(h.counts.changed).toBe(1);
  expect((await resources.read(store.repo.read, b, uri)).posts.map(p => p.body)).toEqual(["kept"]);
  expect(state()).toEqual(before);
  await runRetention(store.repo, config, Date.now(), application.boardsChanged);
  await flush();
  expect(h.counts.changed).toBe(1);
});

test("unwatch is session-bound and bounded capacity is reclaimed by cancellation and closure", async () => {
  const a = await select(alice), b = await select(bob);
  await call(a, "board_create", { name: "e2e", purpose: "tests" });
  const h = hooks();
  const ids = Array.from({ length: 32 }, () => resources.watch(a, boardResourceUri("e2e"), h, true));
  expect(() => resources.watch(a, boardResourceUri("e2e"), h, true)).toThrow("capacity");
  await expect(resources.unwatch(b, ids[0]!)).rejects.toThrow("not found");
  await resources.unwatch(a, ids[0]!);
  await resources.unwatch(a, ids[0]!);
  resources.watch(a, boardResourceUri("e2e"), h, true);
  expect(h.counts.closed).toBe(1);
  application.close(a);
  expect(h.counts.closed).toBe(33);
  await expect(resources.read(store.repo.read, a, boardResourceUri("e2e"))).rejects.toThrow("unauthorized");
});

test("revocation, disabled users, application disconnect and stop close watchers", async () => {
  const a = await select(alice), b = await select(bob);
  await call(a, "board_create", { name: "e2e", purpose: "tests" });
  const revokedHook = hooks();
  resources.watch(a, boardResourceUri("e2e"), revokedHook, true);
  revoked.add(a);
  // Notification must recheck authorization even without explicit revalidation.
  await call(b, "board_post", { board: "e2e", body: "after revoke" });
  expect(revokedHook.counts).toEqual({ changed: 0, closed: 1 });
  await expect(resources.list(store.repo.read, a)).rejects.toThrow("unauthorized");
  const disabledHook = hooks();
  resources.watch(b, boardResourceUri("e2e"), disabledHook, true);
  await seed(store.repo, tx => store.repo.users.setDisabled(tx, bob.user_id, true));
  await resources.revalidate();
  expect(disabledHook.counts.closed).toBe(1);
  revoked.delete(a);
  const disconnectHook = hooks();
  resources.watch(a, boardResourceUri("e2e"), disconnectHook, true);
  application.disconnectUser(alice.user_id);
  expect(disconnectHook.counts.closed).toBe(1);
  const c = await select(alice, "fe");
  const stopped = hooks();
  resources.watch(c, boardResourceUri("e2e"), stopped, true);
  application.stopExpiry();
  expect(stopped.counts.closed).toBe(1);
  resources.close();
  expect(() => resources.watch(c, boardResourceUri("e2e"), hooks(), true)).toThrow("unauthorized");
});

for (const boundary of ["grant", "session"] as const) for (const internal of [false, true]) test(`strict resource ${boundary} faults preserve provenance and watches (application error: ${internal})`, async () => {
  const a = await select(alice), b = await select(bob);
  await call(a, "board_create", { name: "e2e", purpose: "tests" });
  resources.close();
  const failure = internal ? new ApplicationError("internal", "storage unavailable") : new Error("storage unavailable");
  let failed = false;
  resources = createResources(application, { isCurrent: () => true, isAuthorized: () => {
    if (failed && boundary === "grant") throw failure;
    return true;
  } });
  // A checked watch's session check reads nothing (revalidateNow, #807 P3 A7u1); the others read the user too.
  const validate = application.revalidateSession, validateNow = application.revalidateNow;
  application.revalidateSession = session => {
    if (failed && boundary === "session") throw failure;
    return validate(session);
  };
  application.revalidateNow = session => {
    if (failed && boundary === "session") throw failure;
    validateNow(session);
  };
  const uri = boardResourceUri("e2e"), h = hooks();
  const watch = resources.watch(b, uri, h, true);
  failed = true;
  try {
    // A checked watch reads no grant (its caller just did), so only the session boundary reaches it.
    const watchAgain = boundary === "session" ? [() => resources.watch(b, uri, hooks(), true)] : [];
    for (const call of [() => resources.list(store.repo.read, b), () => resources.read(store.repo.read, b, uri), ...watchAgain, () => resources.unwatch(b, watch)]) {
      try { await call(); throw new Error("request unexpectedly succeeded"); } catch (error) { expect(error).toBe(failure); }
    }
    expect(h.counts).toEqual({ changed: 0, closed: 0 });
    expect(await store.repo.cursors.directFor(store.repo.read, b.identityFull)).toBe(0);
  } finally { failed = false; application.revalidateSession = validate; application.revalidateNow = validateNow; }
  await call(a, "board_post", { board: "e2e", body: "healthy" });
  expect(h.counts).toEqual({ changed: 1, closed: 0 });
  expect((await resources.read(store.repo.read, b, uri)).posts.map(p => p.body)).toEqual(["healthy"]);
  expect(isSubscribed(store.db, b.identityFull, "e2e")).toBe(false);
  await resources.unwatch(b, watch);
  expect(h.counts.closed).toBe(1);
});

for (const background of ["revalidate", "hint", "closed"] as const) test(`background resource ${background} faults isolate cleanup and close callbacks`, async () => {
  const a = await select(alice), b = await select(bob);
  await call(a, "board_create", { name: "e2e", purpose: "tests" });
  resources.close();
  let failed = false;
  resources = createResources(application, { isCurrent: () => true, isAuthorized: () => {
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
    }, true);
    failed = true;
    if (background === "revalidate") await resources.revalidate();
    if (background === "hint") await call(a, "board_post", { board: "e2e", body: "committed" });
    if (background === "closed") expect(() => application.close(b)).not.toThrow();
    expect({ changed, closed }).toEqual({ changed: 0, closed: 1 });
    failed = false;
    if (background === "hint") expect((await resources.read(store.repo.read, a, boardResourceUri("e2e"))).posts[0]!.body).toBe("committed");
    expect(await store.repo.cursors.directFor(store.repo.read, b.identityFull)).toBe(0);
    expect(() => resources.close()).not.toThrow();
    expect(closed).toBe(1);
  } finally { failed = false; application.observeBoard = observe; }
});

test("resource background session storage faults fail closed, but authoritative refusals still refuse requests", async () => {
  const a = await select(alice);
  await call(a, "board_create", { name: "e2e", purpose: "tests" });
  const h = hooks();
  resources.watch(a, boardResourceUri("e2e"), h, true);
  const validate = application.revalidateSession;
  application.revalidateSession = () => { throw new Error("session storage unavailable"); };
  try {
    await resources.revalidate();
    expect(h.counts).toEqual({ changed: 0, closed: 1 });
  } finally { application.revalidateSession = validate; }
  for (let i = 0; i < 32; i++) resources.watch(a, boardResourceUri("e2e"), hooks(), true);
  application.revalidateSession = () => { throw new ApplicationError("unauthenticated", "closed session"); };
  try { await expect(resources.list(store.repo.read, a)).rejects.toThrow("unauthorized"); }
  finally { application.revalidateSession = validate; }
  for (let i = 0; i < 32; i++) resources.watch(a, boardResourceUri("e2e"), hooks(), true);
});

// #805: a session's watches are counted per session, not by scanning every watch; closing one frees its slot, and
// a revoked session's watches all close.
test("per-session watch capacity counts only that session's watches and frees on unwatch and revoke", async () => {
  const a = await select(alice), b = await select(bob);
  await call(a, "board_create", { name: "cap", purpose: "capacity" });
  await call(b, "board_create", { name: "other", purpose: "capacity" });
  const ids = Array.from({ length: 32 }, () => resources.watch(a, "grayboard://boards/cap", hooks(), true));
  const counted = refusalCount("resource_watch");
  expect(() => resources.watch(a, "grayboard://boards/cap", hooks(), true)).toThrow("resource watch capacity reached");
  expect(refusalCount("resource_watch")).toBe(counted + 1);
  const theirs = resources.watch(b, "grayboard://boards/other", hooks(), true);
  await resources.unwatch(a, ids[0]!);
  ids[0] = resources.watch(a, "grayboard://boards/cap", hooks(), true);
  expect(resources.activeWatchCount).toBe(33);
  revoked.add(a);
  await expect(resources.list(store.repo.read, a)).rejects.toThrow("resource session is closed or unauthorized");
  expect(resources.activeWatchCount).toBe(1);
  await resources.unwatch(b, theirs);
  expect(resources.activeWatchCount).toBe(0);
});

// #805 F-06: raised watch caps reach both the resource registry and the application's board observers, whose own
// cap was a hard-coded 1024 that would bind first.
test("configured watch caps admit past the defaults and refuse at the configured size", async () => {
  resources.close();
  application.stopExpiry();
  application = createApplication(store.repo, { observerCap: 1100 });
  resources = createResources(application, { isCurrent: () => true, isAuthorized: () => true, caps: { global: 1100, perSession: 1100 } });
  const a = await select(alice);
  await call(a, "board_create", { name: "wide", purpose: "capacity" });
  for (let i = 0; i < 1100; i++) resources.watch(a, "grayboard://boards/wide", hooks(), true);
  expect(resources.activeWatchCount).toBe(1100);
  expect(() => resources.watch(a, "grayboard://boards/wide", hooks(), true)).toThrow("resource watch capacity reached");
});

test("#998 audit: list and read check access on the handle they read on, a body's Tx inside one", async () => {
  const handles: ("pool" | "tx")[] = [];
  const checked = createResources(application, { isCurrent: () => true, isAuthorized: (_s, r) => { handles.push(r === undefined || r === store.repo.read ? "pool" : "tx"); return true; } });
  const a = await select(alice);
  await call(a, "board_create", { name: "e2e", purpose: "tests" });
  await seed(store.repo, async tx => { await checked.list(tx, a); await checked.read(tx, a, boardResourceUri("e2e")); });
  expect(handles).toEqual(["tx", "tx"]);
  handles.length = 0;
  await checked.list(store.repo.read, a);
  await checked.read(store.repo.read, a, boardResourceUri("e2e"));
  expect(handles).toEqual(["pool", "pool"]);
  checked.close();
});

// #807 P3 A7d2c (T-c1): the changed hook's token check awaits; a watch finished meanwhile (here by unwatch, which
// leaves the session and its board access intact) gets no notification.
test("A7d2c: a watch finished while its changed check awaits is not notified", async () => {
  const a = await select(alice), b = await select(bob);
  const uri = boardResourceUri("e2e");
  await call(a, "board_create", { name: "e2e", purpose: "tests" });
  const h = hooks();
  const id = resources.watch(b, uri, h, true);
  const point = "resources:live:checked";
  const pauseDir = mkdtempSync(join(tmpdir(), "gb-resources-pause-")), file = join(pauseDir, "release");
  let hit!: () => void, released!: () => void;
  const reached = new Promise<void>(resolve => { hit = resolve; }), done = new Promise<void>(resolve => { released = resolve; });
  const log = spyOn(console, "error").mockImplementation((message: unknown) => {
    if (message === `[grayboard] test pause hit: ${point}`) hit();
    if (message === `[grayboard] test pause released: ${point}`) released();
  });
  const oldPoint = process.env.BUS_TEST_PAUSE, oldFile = process.env.BUS_TEST_PAUSE_FILE;
  process.env.BUS_TEST_PAUSE = point; process.env.BUS_TEST_PAUSE_FILE = file;
  try {
    await call(a, "board_post", { board: "e2e", body: "during the check" });
    await reached;
    await resources.unwatch(b, id);
    expect(h.counts).toEqual({ changed: 0, closed: 1 });
    writeFileSync(file, "release");
    await done;
    await flush();
    expect(h.counts).toEqual({ changed: 0, closed: 1 });
  } finally {
    writeFileSync(file, "release");
    if (oldPoint === undefined) delete process.env.BUS_TEST_PAUSE; else process.env.BUS_TEST_PAUSE = oldPoint;
    if (oldFile === undefined) delete process.env.BUS_TEST_PAUSE_FILE; else process.env.BUS_TEST_PAUSE_FILE = oldFile;
    log.mockRestore(); rmSync(pauseDir, { recursive: true, force: true });
  }
});

// #807 P3 A7d2c (T-c3), B5a2: watch reads neither token nor board, trusting its caller's checks; a caller whose board
// read said no, or that has no answer, is refused as a missing board, and the session's other watches stay open.
test("A7d2c/B5a2: a watch its caller didn't judge visible is refused", async () => {
  const b = await select(bob);
  await call(b, "board_create", { name: "e2e", purpose: "tests" });
  const h = hooks();
  resources.watch(b, boardResourceUri("e2e"), h, true);
  for (const visible of [false, undefined as unknown as boolean]) {
    expect(() => resources.watch(b, boardResourceUri("e2e"), hooks(), visible)).toThrow("no such board #e2e; see board_list");
  }
  expect(resources.activeWatchCount).toBe(1);
  expect(h.counts.closed).toBe(0);
  // The synchronous auth forms are gone (#807 P3 A7d2c): every token read is async.
  expect("authNow" in store.repo).toBe(false);
});
