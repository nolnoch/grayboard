import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication, type DeliverySink } from "./application.ts";
import { openDatabase } from "./db.ts";
import type { AuthedUser } from "./auth.ts";
import type { Tx } from "./store/tx.ts";
import { writeAudit } from "./audit.ts";
import { tokenSessionIn } from "../../tests/support/token_session.ts";
import { seed } from "../../tests/support/seed.ts";
import { AppSession } from "../../tests/support/app_session.ts";
import { scratchDbPath } from "../../tests/support/scratch_db.ts";
import { queueFor } from "./store/queue.ts";

let store: ReturnType<typeof openDatabase>;
let application: ReturnType<typeof createApplication>;
let blobDir: string;
let alice: AuthedUser;
let bob: AuthedUser;
function delivery(): DeliverySink {
  return { deliver: () => {}, closed: () => {} };
}
// A connected AppSession: it registers like a hosted session and binds `alias`.
async function connect(user: AuthedUser, alias: string | null, opts: ConstructorParameters<typeof AppSession>[4] = {}): Promise<AppSession> {
  const s = new AppSession(application, store.repo, user, alias, opts);
  await s.connect();
  return s;
}
const isDirect = (e: { kind: string }) => e.kind === "direct";
beforeEach(async () => {
  blobDir = mkdtempSync(join(tmpdir(), "gb-application-"));
  store = openDatabase(scratchDbPath(), { blobDir });
  application = createApplication(store.repo, store.db);
  const user = (tx: Tx, email: string): AuthedUser => {
    const u = store.repo.users.upsertByEmail(tx, email, null);
    // A session needs a live sign-in (#351).
    return tokenSessionIn(store.repo, tx, { user_id: u.id, user_email: u.email });
  };
  [alice, bob] = await seed(store.repo, tx => [user(tx, "alice@example.com"), user(tx, "bob@example.com")]);
});
afterEach(() => {
  application.stopExpiry();
  store.db.close();
  rmSync(blobDir, { recursive: true, force: true });
});


test("typed operations and delivery need no frames; receipts alone move the delivery cursor", async () => {
  const a = await connect(alice, "BE");
  const b = await connect(bob, "fe", { key: "bob-key" });
  const sent = await a.send("bob@example.com/fe", "question?", { pending: true });
  expect(sent).toMatchObject({ delivered_now: true, pending: true });
  expect(sent).not.toHaveProperty("type");
  expect(await b.next(isDirect)).toMatchObject({ kind: "direct", message: { id: sent.message_id, body: "question?" } });
  expect(store.repo.cursors.directFor(store.repo.read, b.session.identityFull)).toBe(0);
  await b.dmAck(sent.message_id);
  expect(store.repo.cursors.directFor(store.repo.read, b.session.identityFull)).toBe(0);
  b.close();
  // A rebuilt session on the same key is the same ID: it re-binds the alias it holds and replays its mail.
  const b2 = await connect(bob, "fe", { key: "bob-key" });
  expect(await b2.next(isDirect)).toMatchObject({ message: { id: sent.message_id } });
  await b2.ack([sent.message_id]);
  expect(store.repo.cursors.directFor(store.repo.read, b.session.identityFull)).toBe(sent.message_id);
  expect((await a.history())[0]).toMatchObject({ delivered: true });
  expect((await a.inbox()).promised).toHaveLength(1);
  await a.dmAck(sent.message_id);
  expect((await a.inbox()).promised).toBeUndefined();
});

// #470: a receipt stamps delivered_at once; a cursor move alone (the Slack
// link-time backlog skip, or mail from before the column) proves delivery
// without a time.
test("a receipt stamps delivered_at once; a cursor-only delivery shows delivered without it", async () => {
  const a = await connect(alice, "be");
  const b = await connect(bob, "fe");
  const sent = await a.send("bob@example.com/fe", "stamp me");
  await b.next(isDirect);
  const before = await a.history();
  expect(before[0]).toMatchObject({ id: sent.message_id, delivered: false });
  expect(before[0]).not.toHaveProperty("delivered_at");
  expect((await a.thread(sent.message_id))[0]).not.toHaveProperty("delivered_at");

  const t0 = Date.now();
  await b.ack([sent.message_id]);
  const [row] = await a.history();
  const stamp = row!.delivered_at!;
  expect(row!.delivered).toBe(true);
  expect(stamp).toBeGreaterThanOrEqual(t0);
  expect((await a.thread(sent.message_id))[0]!.delivered_at).toBe(stamp);
  expect((await b.inbox()).unanswered[0]).toMatchObject({ id: sent.message_id, delivered_at: stamp });
  // A repeated receipt keeps the first stamp.
  await seed(store.repo, () => store.repo.messages.markDelivered(sent.message_id, stamp + 60_000));
  await b.ack([sent.message_id]);
  expect((await a.history())[0]!.delivered_at).toBe(stamp);

  b.close();
  const queued = await a.send("bob@example.com/fe", "skipped backlog");
  expect((await a.history()).at(-1)).toMatchObject({ id: queued.message_id, delivered: false });
  await seed(store.repo, tx => store.repo.cursors.advance(tx, "bob@example.com/fe", "direct", "bob@example.com/fe", queued.message_id));
  const skipped = (await a.history()).at(-1)!;
  expect(skipped).toMatchObject({ id: queued.message_id, delivered: true });
  expect(skipped).not.toHaveProperty("delivered_at");
});

test("board observers are independent hints with concealed access and explicit lifecycle cleanup", async () => {
  const a = (await connect(alice, "be", { push: false })).session;
  await seed(store.repo, tx => application.call(tx, a, "board_create", { name: "e2e", purpose: "tests" }));
  let changed = 0, closed = 0;
  const unsubscribe = application.observeBoard(a, "#E2E", { changed: () => { changed++; }, closed: () => { closed++; } });
  application.observeBoard(a, "e2e", { changed: () => { throw new Error("ignored hint"); } });
  await seed(store.repo, tx => application.call(tx, a, "board_post", { board: "e2e", body: "hello" }));
  expect(changed).toBe(1);
  expect((await application.boardSnapshot(store.repo.read, a, "e2e")).posts[0]!.body).toBe("hello");
  expect((await application.boardCatalog(store.repo.read, a)).boards.map(b => b.name)).toContain("e2e");
  unsubscribe();
  unsubscribe();
  expect(closed).toBe(1);
  await seed(store.repo, tx => application.call(tx, a, "board_post", { board: "e2e", body: "later" }));
  expect(changed).toBe(1);
  application.close(a);
  expect(() => application.observeBoard(a, "e2e", { changed: () => {} })).toThrow("session is closed");
});

// #831: observers are indexed by board and by session. A post tells only its board's observers, a close ends only
// its session's, an observer the walk finds dead leaves both indexes without costing the board's others, and a board
// or session whose last observer left takes new ones.
test("#831: board and session observer indexes: a post tells its board's observers, a close ends its session's", async () => {
  const a = (await connect(alice, "be", { push: false })).session;
  const b = (await connect(bob, "fe", { push: false })).session;
  await seed(store.repo, async tx => { for (const name of ["one", "two"]) await application.call(tx, a, "board_create", { name, purpose: "tests" }); });
  const seen: string[] = [];
  const watch = (s: typeof a, board: string, tag: string) =>
    application.observeBoard(s, board, { changed: () => { seen.push(`${tag}+`); }, closed: () => { seen.push(`${tag}-`); } });
  watch(a, "one", "a1"); watch(a, "two", "a2"); watch(b, "one", "b1");
  const b2off = watch(b, "two", "b2");
  expect(application.observerCount).toBe(4);
  await seed(store.repo, tx => application.call(tx, a, "board_post", { board: "one", body: "x" }));
  expect(seen.sort()).toEqual(["a1+", "b1+"]);

  seen.length = 0;
  application.close(a);
  expect(seen.sort()).toEqual(["a1-", "a2-"]);
  expect(application.observerCount).toBe(2);
  expect(application.observerIndexKeys).toEqual({ boards: 2, sessions: 1 });
  seen.length = 0;
  await seed(store.repo, tx => application.call(tx, b, "board_post", { board: "two", body: "y" }));
  expect(seen).toEqual(["b2+"]);

  // "two"'s last observer leaves, emptying its index entry; a new one on the emptied board is told.
  b2off();
  expect(application.observerIndexKeys).toEqual({ boards: 1, sessions: 1 });
  watch(b, "two", "b2'");
  expect(application.observerIndexKeys).toEqual({ boards: 2, sessions: 1 });
  seen.length = 0;
  await seed(store.repo, tx => application.call(tx, b, "board_post", { board: "two", body: "u" }));
  expect(seen).toEqual(["b2'+"]);

  // A second observer of "one" joins and leaves; the board's first is still told.
  seen.length = 0;
  const again = watch(b, "one", "b1'");
  await seed(store.repo, tx => application.call(tx, b, "board_post", { board: "one", body: "z" }));
  expect(seen.sort()).toEqual(["b1'+", "b1+"]);
  again();
  seen.length = 0;
  await seed(store.repo, tx => application.call(tx, b, "board_post", { board: "one", body: "w" }));
  expect(seen).toEqual(["b1+"]);

  // A dead session's observer is dropped by the walk that finds it; the board's live observers are still told.
  const c = await connect(alice, "be2", { push: false });
  watch(c.session, "one", "c1");
  c.session.active = false;
  seen.length = 0;
  await seed(store.repo, tx => application.call(tx, b, "board_post", { board: "one", body: "v" }));
  expect(seen.sort()).toEqual(["b1+", "c1-"]);
  expect(application.observerCount).toBe(2);
  expect(application.observerIndexKeys).toEqual({ boards: 2, sessions: 1 });
  application.close(b);
  expect(application.observerCount).toBe(0);
  expect(application.observerIndexKeys).toEqual({ boards: 0, sessions: 0 });
});

test("tools-only calls neither own nor drain deliveries nor reset the owner's status", async () => {
  const owner = await connect(alice, "be");
  await owner.call("peer_status", { text: "working" });
  const tools = await connect(alice, "be", { push: false });
  const b = await connect(bob, "fe");
  await b.send("alice@example.com/be", "hi");
  expect(await owner.next(isDirect)).toMatchObject({ message: { body: "hi" } });
  await tools.none(isDirect);
  const peers = await tools.call<{ peers: { handle: string; online: boolean; status?: string }[] }>("peer_list", {});
  expect(peers.peers.find(p => p.handle === owner.session.identityFull)).toMatchObject({ online: true, status: "working" });
  tools.close();
  // #284: a held alias refuses another session's bind as alias_held.
  await expect(connect(alice, "be")).rejects.toMatchObject({ code: "alias_held" });
});

test("bind budget is per user and spent before an alias is created or a hold taken", async () => {
  application.stopExpiry();
  application = createApplication(store.repo, store.db, { helloLimit: { burst: 1, perSec: 0.01 } });
  const a = await connect(alice, "be");
  await expect(a.bind("refused")).rejects.toMatchObject({ code: "rate_limited", extra: { retry_after_ms: expect.any(Number) } });
  expect(store.repo.aliases.listForScope(store.repo.read, "person", alice.user_email).map(x => x.name)).toEqual(["be"]);
  expect(store.db.query("SELECT event FROM binding_events").all()).toEqual([{ event: "bound" }]);
  expect(store.db.query("SELECT * FROM access_log WHERE action = 'bind.rate_limited'").all()).toHaveLength(1);
  expect((await application.attachHuman(alice, delivery())).session.human).toBe(true);
  // Per user: bob's bind spends his own budget.
  expect((await connect(bob, "fe")).session.holds).toEqual(["bob@example.com/fe"]);
});

// #807 P1c-13: attachHuman's lazy human alias (the find, then the create) runs on its write's Tx.
test("#807 P1c-13: attachHuman reads and creates the human alias on its write's Tx", async () => {
  const repo = store.repo;
  const checks: string[] = [];
  const spies = (["find", "create"] as const).map(name => {
    const original = repo.aliases[name].bind(repo.aliases) as (...a: unknown[]) => unknown;
    return spyOn(repo.aliases, name).mockImplementation(((r: unknown, ...rest: unknown[]) => {
      checks.push(`${name}:${store.db.inTransaction && r !== repo.read ? "tx" : "pool"}`);
      return original(r, ...rest);
    }) as never);
  });
  try {
    await application.attachHuman(alice, delivery());
  } finally { for (const spy of spies) spy.mockRestore(); }
  expect(checks).toEqual(["find:tx", "create:tx"]);
});

test("reserved human authority is a separate trusted method, never a selected client field", async () => {
  await expect(connect(alice, "human")).rejects.toMatchObject({ code: "forbidden" });
  const human = (await application.attachHuman(alice, delivery())).session;
  application.disconnectUser(alice.user_id);
  expect(human.active).toBe(true);
  await seed(store.repo, tx => store.repo.users.setDisabled(tx, alice.user_id, true));
  await expect(application.inbox(store.repo.read, human)).rejects.toThrow("an admin signed this user out");
});

test("board delivery is typed, replayable and acknowledged separately", async () => {
  const a = await connect(alice, "be");
  const b = await connect(bob, "fe", { key: "bob-key" });
  await a.call("board_create", { name: "e2e", purpose: "fixtures" });
  await a.call("board_post", { board: "e2e", body: "@bob@example.com/fe look" } /* #284 decision 16: @scope/name is exact */);
  const event = await b.next(e => e.kind === "board");
  if (event.kind !== "board" || event.item.kind !== "push") throw new Error("missing board delivery");
  b.close();
  const b2 = await connect(bob, "fe", { key: "bob-key" });
  expect(await b2.next(e => e.kind === "board")).toMatchObject({ item: { kind: "push", post: { id: event.item.post.id } } });
  await b2.boardAck([{ kind: "push", post_id: event.item.post.id }]);
  b2.close();
  const b3 = await connect(bob, "fe", { key: "bob-key" });
  await b3.none(e => e.kind === "board");
});

test("bounded pending reads preserve pending flags and do not acknowledge or drain the owner", async () => {
  const a = await connect(alice, "be");
  const b = (await connect(bob, "fe", { push: false })).session;
  const id = (await a.send("bob@example.com/fe", "pending", { pending: true })).message_id;
  await a.send("bob@example.com/fe", "second");
  const pending = await application.pending(store.repo.read, b, 1);
  expect(pending).toMatchObject([{ kind: "direct", message: { id, body: "pending", pending: true } }]);
  expect(await application.pending(store.repo.read, b, 1)).toEqual(pending);
  expect(store.repo.cursors.directFor(store.repo.read, b.identityFull)).toBe(0);
  await expect(application.pending(store.repo.read, b, 101)).rejects.toThrow();
  await expect(application.pending(store.repo.read, b, 0)).rejects.toThrow();
  await seed(store.repo, tx => store.repo.users.setDisabled(tx, bob.user_id, true));
  await expect(application.pending(store.repo.read, b)).rejects.toThrow("an admin signed this user out");
});

// Judged by the bundler's import scan, not the source text (#385 item 21): comments, strings and erased
// type-only imports are no runtime dependency.
test("hosted Slack has no dependency on the transitional wire adapter", async () => {
  const source = await Bun.file(new URL("./slack.ts", import.meta.url)).text();
  const imports = new Bun.Transpiler({ loader: "ts" }).scanImports(source).map(i => i.path);
  expect(imports).toContain("./application.ts");
  expect(imports.filter(path => /(^|\/)shared\/protocol(\.[jt]s)?$/.test(path))).toEqual([]);
});

// An unbound hosted session acts as no address (#229): its reads are judged
// by its user's principal, never as `<email>/human`, the bridge's reserved
// identity that #announce authority rests on.
test("unbound hosted reads never use the human address and still list and read boards", async () => {
  const owner = (await connect(alice, "be", { key: "owner-secret" })).session;
  await seed(store.repo, async tx => {
    await application.call(tx, owner, "board_create", { name: "e2e", purpose: "fixture" });
    await application.call(tx, owner, "board_post", { board: "e2e", body: "hello" });
    const team = store.repo.teams.create(tx, "private", bob.user_id);
    store.repo.teams.addMember(tx, team.id, bob.user_id);
  });
  const bobBe = (await connect(bob, "be", { key: "bob-secret" })).session;
  await seed(store.repo, tx => application.call(tx, bobBe, "board_create", { name: "secret", purpose: "fixture", team: "private" }));
  const asked: string[] = [];
  const principalOf = store.repo.resolver.principalOf.bind(store.repo.resolver);
  store.repo.resolver.principalOf = (address: string) => { asked.push(address); return principalOf(address); };
  // One with no ids row (a foreign or pre-context ID), and one registered as hosted does at create.
  const unregistered = application.hostedSession(store.repo.read, alice, "id:0000000000000", [], null, null, delivery()).session;
  await seed(store.repo, () => application.hostedRegister(alice, "id:1111111111111", "opencode"));
  const registered = application.hostedSession(store.repo.read, alice, "id:1111111111111", [], null, null, delivery()).session;
  for (const session of [unregistered, registered]) {
    expect((await application.boardCatalog(store.repo.read, session)).boards.map(b => b.name)).toContain("e2e");
    expect((await application.boardCatalog(store.repo.read, session)).boards.map(b => b.name)).not.toContain("secret");
    expect((await application.boardSnapshot(store.repo.read, session, "e2e")).posts.map(p => p.body)).toEqual(["hello"]);
    await expect(application.boardSnapshot(store.repo.read, session, "secret")).rejects.toThrow();
  }
  expect(((await seed(store.repo, tx => application.call(tx, registered, "board_list", {}))) as { name: string }[]).map(b => b.name)).toContain("e2e");
  expect(((await seed(store.repo, tx => application.call(tx, registered, "board_read", { board: "e2e" }))) as { posts: { body: string }[] }).posts.map(p => p.body)).toEqual(["hello"]);
  expect(asked.filter(a => a.endsWith("/human"))).toEqual([]);
  expect(store.repo.aliases.find(store.repo.read, "alice@example.com/human")).toBeUndefined();
  expect(store.db.query("SELECT COUNT(*) AS n FROM subscriptions WHERE handle LIKE '%/human'").get()).toEqual({ n: 0 });
  application.close(owner);
  application.close(bobBe);
});

test("a hosted session whose hello facts throw is left unregistered (#385 item 9)", async () => {
  const pushed: unknown[] = [];
  const teams = spyOn(store.repo.teams, "listForUser").mockImplementation(() => { throw new Error("db gone"); });
  try {
    expect(() => application.hostedSession(store.repo.read, alice, "id:2222222222222", ["alice@example.com/be"], null, null, { deliver: e => { pushed.push(e); }, closed: () => {} }, true)).toThrow("db gone");
  } finally { teams.mockRestore(); }
  // An unheld "be": a DM to it is pushed only to a session the hub routes it to.
  await seed(store.repo, tx => store.repo.aliases.create(tx, { scope_kind: "person", scope_ref: "alice@example.com", name: "be" }, "alice@example.com"));
  const sender = await connect(alice, "sender");
  await sender.send("alice@example.com/be", "no route left behind");
  expect(pushed).toEqual([]);
  sender.close();
});

test("unbound hosted sessions cannot use named operations or persist synthetic handles", async () => {
  // A hosted root's row: peer_list reads unbound roots from the store (#475).
  const now = Date.now();
  await seed(store.repo, tx => {
    const ownership = store.repo.hosted.start(tx, "hosted-unbound", alice.user_id, "test", now);
    store.repo.hosted.insert(tx, {
      session_id: "hosted-unbound", ownership_id: ownership, user_id: alice.user_id, client_id: "test", grant_id: "grant", source_session_id: "hosted-unbound",
      writes_as: null, bind_gen: 0, root_session_id: null, place: null, lease_deadline: null, created_at: now, last_seen_at: now, suggested: null, parked_at: null,
    });
  });
  const { session, info } = application.hostedSession(store.repo.read, alice, "hosted-unbound", [], null, null, delivery());
  expect(session.writerId).toBeUndefined();
  expect(info.candidates).toEqual([]);
  expect(store.repo.aliases.listForScope(store.repo.read, "person", alice.user_email)).toEqual([]);
  expect(store.db.query("SELECT * FROM handles").all()).toEqual([]);
  const operations = [
    () => seed(store.repo, tx => application.send(tx, session, "be", "no")),
    () => seed(store.repo, tx => application.delegate(tx, session, { persona: "a researcher", task: "no" })),
    () => application.history(store.repo.read, session),
    () => application.thread(store.repo.read, session, 1),
    () => application.inbox(store.repo.read, session),
    () => seed(store.repo, tx => application.receiptDirect(tx, session, [1])),
    () => application.receiptBoards(session, []),
    () => seed(store.repo, tx => application.acknowledgeDm(tx, session, 1)),
    () => seed(store.repo, tx => application.retract(tx, session, 1)),
    () => seed(store.repo, tx => application.call(tx, session, "board_create", { name: "e2e", purpose: "no" })),
  ];
  for (const operation of operations) {
    try { await operation(); throw new Error("operation admitted"); } catch (e) { expect(e).toMatchObject({ code: "unbound" }); }
  }
  for (const tool of ["board_list", "peer_list", "claim_list"]) await expect(seed(store.repo, tx => application.call(tx, session, tool, {}))).resolves.toBeDefined();
  await application.replay(session);
  expect(store.db.query("SELECT * FROM handles").all()).toEqual([]);
  const peers = (await seed(store.repo, tx => application.call(tx, session, "peer_list", {}))) as Record<string, unknown>;
  expect(peers).not.toHaveProperty("you");
  expect(peers.unbound_sessions).toMatchObject([{ self: true }]);
  application.disconnectUser(alice.user_id);
  await expect(seed(store.repo, tx => application.call(tx, session, "board_list", {}))).rejects.toThrow("session is closed");
});

test("hold sessions block binding and candidates without push or online presence; a close leaves the hold", async () => {
  const owner = await connect(alice, "held", { push: false, hold: true, key: "hold-secret" });
  await owner.call("peer_status", { text: "working" });
  const tools = await connect(alice, "held", { push: false });
  const observer = application.hostedSession(store.repo.read, alice, "hosted-observer", [], null, null, delivery()).session;
  expect(((await seed(store.repo, tx => application.call(tx, observer, "peer_list", { include_offline: true }))) as { peers: unknown[] }).peers).toMatchObject([{ online: false }]);
  expect(tools.session.toolsOnly).toBe(true);
  expect(tools.session.holds).toEqual([]);
  await expect(connect(alice, "held")).rejects.toMatchObject({ code: "alias_held", extra: { holder: expect.stringContaining(owner.id) } });
  expect(application.hostedCandidates(store.repo.read, alice, null)).toEqual([]);
  const sender = await connect(bob, "sender");
  expect((await sender.send("alice@example.com/held", "queued")).delivered_now).toBe(false);
  await owner.none(() => true);
  owner.close();
  owner.close();
  // Release is the hosted store's session end (alias_holds is the only truth, #451): a close leaves the hold.
  expect(store.db.query("SELECT id FROM alias_holds WHERE address = ?").get(owner.session.identityFull)).toEqual({ id: owner.id });
  expect(store.db.query("SELECT * FROM binding_events WHERE name = ? AND event = 'released'").all(owner.session.identityFull)).toHaveLength(0);
});

test("unknown and reserved names are audited without creation; trusted human gets binding attribution", async () => {
  await expect(connect(alice, "typo", { bind: { create: false }, key: "typo-secret" })).rejects.toMatchObject({ code: "identity_unknown", extra: { known: [] } });
  expect(store.repo.aliases.listForScope(store.repo.read, "person", alice.user_email)).toEqual([]);
  await expect(connect(alice, "human", { key: "human-secret" })).rejects.toMatchObject({ code: "forbidden" });
  const human = (await application.attachHuman(alice, delivery())).session;
  // The bridge's human has no session ID (#284 S16); it logs as `human`.
  expect(human.sessionId).toBe("");
  application.close(human);
  expect(store.db.query("SELECT event FROM binding_events WHERE name = ? ORDER BY id").all(human.identityFull)).toEqual([{ event: "refused" }, { event: "bound" }, { event: "released" }]);
});

// #284 port: master tested #182's rebind (a hello naming `from` moved the
// claims). Under #284 PR 4 a session holds several aliases: bind adds one,
// unbind releases one, and claims and DMs stay with the alias (S6).
test("bind adds a hold without taking another session's; unbind leaves claims and DMs with the alias", async () => {
  const old = await connect(alice, "old", { key: "rebind-secret" });
  await old.call("claim_take", { key: "file:src/e2e.ts" });
  const blocker = await connect(alice, "blocked");
  await expect(old.bind("blocked")).rejects.toMatchObject({ code: "alias_held" });
  expect(old.session.holds).toEqual(["alice@example.com/old"]);
  const bound = await old.bind("next");
  expect(bound.held).toEqual(["alice@example.com/old", "alice@example.com/next"]);
  expect(old.session.primary).toBe("alice@example.com/old");
  const unbound = await old.unbind("old");
  expect(unbound).toMatchObject({ released: true, held: ["alice@example.com/next"], left: ["file:src/e2e.ts"] });
  expect(old.session.primary).toBe("alice@example.com/next");
  expect(store.db.query("SELECT holder FROM claims WHERE key = ?").get("file:src/e2e.ts")).toEqual({ holder: "alice@example.com/old" });
  const sender = await connect(bob, "sender");
  expect((await sender.send("alice@example.com/old", "old mailbox")).delivered_now).toBe(false);
  await old.none(isDirect);
  expect(await old.unbind("old")).toMatchObject({ released: false });
  expect(store.db.query("SELECT * FROM binding_events WHERE name = ? AND event = 'released'").all("alice@example.com/old")).toHaveLength(1);
  old.close();
  blocker.close();
});

test("shared writes retain calling-session dedup, ID provenance and replay audit ownership", async () => {
  const first = await connect(alice, "be", { key: "first-session" });
  const sibling = await connect(alice, "be", { push: false, key: "sibling-session" });
  const recipient = await connect(bob, "fe");
  const send = (session: AppSession, resend = false) => session.send(recipient.session.identityFull, "same write", { resend });
  const a = await send(first);
  const replay = await send(first);
  expect(replay.message_id).toBe(a.message_id);
  expect(replay.replayed).toBeDefined();
  expect(recipient.events.filter(isDirect)).toHaveLength(1);
  const deliberate = await send(first, true);
  const other = await send(sibling);
  expect(new Set([a.message_id, deliberate.message_id, other.message_id]).size).toBe(3);
  expect(recipient.events.filter(isDirect)).toHaveLength(3);
  expect(store.db.query("SELECT sender_id FROM messages WHERE id = ?").get(a.message_id)).toEqual({ sender_id: first.id });
  // #284: a tools-only connection is a session too (S7), with its own ID.
  expect(store.db.query("SELECT sender_id FROM messages WHERE id = ?").get(other.message_id)).toEqual({ sender_id: sibling.id });
  expect(first.id).toMatch(/^id:[0-9a-hjkmnp-tv-z]{13}$/);
  expect(store.db.query("SELECT principal, keyed FROM ids WHERE id = ?").get(first.id)).toEqual({ principal: alice.user_email, keyed: 0 });
  expect(store.db.query("SELECT id FROM alias_holds WHERE address = ?").get(first.session.identityFull)).toEqual({ id: first.id });
  expect(store.db.query("SELECT writes_as FROM ids WHERE id = ?").get(sibling.id)).toEqual({ writes_as: "alice@example.com/be" });
  const audits = store.db.query("SELECT action, detail FROM access_log WHERE action IN ('request.replayed', 'request.resent') ORDER BY id").all() as { action: string; detail: string }[];
  expect(audits.map(a => a.action)).toEqual(["request.replayed", "request.resent"]);
  expect(JSON.parse(audits[0]!.detail)).toMatchObject({ session: first.id, transport: "hosted", tool: "dm_send" });
  first.close();
  // A close leaves its hold (#451).
  expect(store.db.query("SELECT id FROM alias_holds WHERE address = ?").get(first.session.identityFull)).toEqual({ id: first.id });
  await expect(connect(bob, "other", { key: "first-session" })).rejects.toMatchObject({ code: "id_collision" });
  expect(store.repo.aliases.find(store.repo.read, `${bob.user_email}/other`)).toBeUndefined();
});

test("a reply to anyone but the parent's other party is refused bad_request and writes nothing (#524, #530)", async () => {
  const carol = await seed(store.repo, tx => { const u = store.repo.users.upsertByEmail(tx, "carol@example.com", null); return tokenSessionIn(store.repo, tx, { user_id: u.id, user_email: u.email }); });
  const a = await connect(alice, "be");
  const b = await connect(bob, "fe");
  await connect(carol, "sim");
  const root = await a.send("bob@example.com/fe", "private");
  const messages = () => (store.db.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n;
  const before = messages();
  await expect(b.send("carol@example.com/sim", "x", { parent_id: root.message_id })).rejects.toMatchObject({
    code: "bad_request",
    message: `parent_id ${root.message_id} is a thread with alice@example.com/be, so a reply goes to alice@example.com/be; to write to someone else, send without parent_id`,
  });
  expect(messages()).toBe(before);
});

// #807 D4: the Slack human's attach commits its alias, audit and binding row through the write queue; the registry
// changes only after the commit.
test("#807: attachHuman while another body holds the write queue waits, then binds", async () => {
  let release!: () => void;
  const done = queueFor(store.db).run(() => new Promise<void>(r => { release = r; }));
  const attached = application.attachHuman(alice, delivery());
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  expect(store.db.query("SELECT event FROM binding_events").all()).toEqual([]);
  expect(store.repo.aliases.find(store.repo.read, "alice@example.com/human")).toBeUndefined();
  release();
  await done;
  expect((await attached).session.human).toBe(true);
  expect(store.db.query("SELECT event FROM binding_events").all()).toEqual([{ event: "bound" }]);
});

test("#807: a rolled-back attachHuman leaves the earlier bridge connection in place", async () => {
  const first = (await application.attachHuman(alice, delivery())).session;
  store.db.run(`CREATE TRIGGER fail_bind BEFORE INSERT ON binding_events BEGIN SELECT RAISE(ABORT, 'binding refused'); END`);
  await expect(application.attachHuman(alice, delivery())).rejects.toThrow("binding refused");
  expect(first.active).toBe(true);
  expect(await application.inbox(store.repo.read, first)).toBeDefined();
});

test("#807: attachHuman refuses inside its write when the bridge's check went stale, and registers nothing", async () => {
  const first = (await application.attachHuman(alice, delivery())).session;
  const rows = store.db.query("SELECT COUNT(*) AS n FROM binding_events").get();
  await expect(application.attachHuman(alice, delivery(), () => "the Slack link changed")).rejects.toThrow("the Slack link changed");
  expect(first.active).toBe(true);
  expect(store.db.query("SELECT COUNT(*) AS n FROM binding_events").get()).toEqual(rows);
});
