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
import { until } from "../../tests/support/until.ts";
import { AppSession } from "../../tests/support/app_session.ts";
import { scratchDbPath } from "../../tests/support/scratch_db.ts";
import { queueFor } from "./store/queue.ts";
import { MissingParent } from "./store/errors.ts";

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
  application = createApplication(store.repo);
  const user = async (tx: Tx, email: string): Promise<AuthedUser> => {
    const u = await store.repo.users.upsertByEmail(tx, email, null);
    // A session needs a live sign-in (#351).
    return tokenSessionIn(store.repo, tx, { user_id: u.id, user_email: u.email, kind: u.kind });
  };
  [alice, bob] = await seed(store.repo, async tx => [await user(tx, "alice@example.com"), await user(tx, "bob@example.com")]);
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
  expect(await store.repo.cursors.directFor(store.repo.read, b.session.identityFull)).toBe(0);
  await b.dmAck(sent.message_id);
  expect(await store.repo.cursors.directFor(store.repo.read, b.session.identityFull)).toBe(0);
  b.close();
  // A rebuilt session on the same key is the same ID: it re-binds the alias it holds and replays its mail.
  const b2 = await connect(bob, "fe", { key: "bob-key" });
  expect(await b2.next(isDirect)).toMatchObject({ message: { id: sent.message_id } });
  await b2.ack([sent.message_id]);
  expect(await store.repo.cursors.directFor(store.repo.read, b.session.identityFull)).toBe(sent.message_id);
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
  await seed(store.repo, tx => store.repo.messages.markDelivered(tx, sent.message_id, stamp + 60_000));
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
  await until(() => seen.length >= 2);
  expect(seen.sort()).toEqual(["a1+", "b1+"]);

  seen.length = 0;
  application.close(a);
  expect(seen.sort()).toEqual(["a1-", "a2-"]);
  expect(application.observerCount).toBe(2);
  expect(application.observerIndexKeys).toEqual({ boards: 2, sessions: 1 });
  seen.length = 0;
  await seed(store.repo, tx => application.call(tx, b, "board_post", { board: "two", body: "y" }));
  await until(() => seen.length >= 1);
  expect(seen).toEqual(["b2+"]);

  // "two"'s last observer leaves, emptying its index entry; a new one on the emptied board is told.
  b2off();
  expect(application.observerIndexKeys).toEqual({ boards: 1, sessions: 1 });
  watch(b, "two", "b2'");
  expect(application.observerIndexKeys).toEqual({ boards: 2, sessions: 1 });
  seen.length = 0;
  await seed(store.repo, tx => application.call(tx, b, "board_post", { board: "two", body: "u" }));
  await until(() => seen.length >= 1);
  expect(seen).toEqual(["b2'+"]);

  // A second observer of "one" joins and leaves; the board's first is still told.
  seen.length = 0;
  const again = watch(b, "one", "b1'");
  await seed(store.repo, tx => application.call(tx, b, "board_post", { board: "one", body: "z" }));
  await until(() => seen.length >= 2);
  expect(seen.sort()).toEqual(["b1'+", "b1+"]);
  again();
  seen.length = 0;
  await seed(store.repo, tx => application.call(tx, b, "board_post", { board: "one", body: "w" }));
  await until(() => seen.length >= 1);
  expect(seen).toEqual(["b1+"]);

  // A dead session's observer is dropped by the walk that finds it; the board's live observers are still told.
  const c = await connect(alice, "be2", { push: false });
  watch(c.session, "one", "c1");
  c.session.active = false;
  seen.length = 0;
  await seed(store.repo, tx => application.call(tx, b, "board_post", { board: "one", body: "v" }));
  await until(() => seen.length >= 2);
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
  application = createApplication(store.repo, { helloLimit: { burst: 1, perSec: 0.01 } });
  const a = await connect(alice, "be");
  await expect(a.bind("refused")).rejects.toMatchObject({ code: "rate_limited", extra: { retry_after_ms: expect.any(Number) } });
  expect((await store.repo.aliases.listForScope(store.repo.read, "person", alice.user_email)).map(x => x.name)).toEqual(["be"]);
  expect(store.db.query("SELECT event FROM binding_events").all()).toEqual([{ event: "bound" }]);
  expect(store.db.query("SELECT * FROM access_log WHERE action = 'bind.rate_limited'").all()).toHaveLength(1);
  expect((await application.attachHuman(alice, delivery())).session.human).toBe(true);
  // Per user: bob's bind spends his own budget.
  expect((await connect(bob, "fe")).session.holds).toEqual(["bob@example.com/fe"]);
});

// #807 P3 C5 decisions 4 and 5: on Postgres a delivery, a cursor move or a reply can commit between dm_retract's
// pre-check and the store's delete, and a parent can go between dm_send's check and its insert. The store's answer,
// not the pre-check, picks the refusal: each is forced here by the store method saying so.
test("dm_retract answers the store's reason, and dm_send a missing parent the store found", async () => {
  const a = await connect(alice, "fe");
  const b = await connect(bob, "be");
  b.close();
  const sent = await a.send("bob@example.com/be", "queued");
  const retract = () => seed(store.repo, tx => application.retract(tx, a.session, sent.message_id));
  const id = sent.message_id;
  for (const [reason, code, message] of [
    ["gone", "not_found", `no message ${id} from you`],
    ["read", "bad_request", `message ${id} already reached bob@example.com/be; send a correction instead`],
    ["replied", "bad_request", `message ${id} has a reply in its thread; send a correction instead`],
  ] as const) {
    const spy = spyOn(store.repo.messages, "retract").mockResolvedValue(reason);
    try { await expect(retract()).rejects.toMatchObject({ code, message }); } finally { spy.mockRestore(); }
  }
  expect(await store.repo.messages.getById(store.repo.read, id)).toBeDefined();
  const spy = spyOn(store.repo.messages, "insert").mockRejectedValue(new MissingParent(id));
  try {
    await expect(a.send("bob@example.com/be", "a reply", { parent_id: id })).rejects.toMatchObject({ code: "not_found", message: `parent_id ${id} is not a message you sent or received` });
  } finally { spy.mockRestore(); }
  expect(await retract()).toEqual({});
  a.close();
});

// #807 P3 C5a audit F3: on Postgres two retracts of one message by its sender can both pass the pre-check; the loser's
// store finds it gone, and answers as a repeat of the winner's retract when the audit shows it, as the pre-check would.
test("dm_retract whose store finds the message gone answers 'already retracted by you' when the caller's retract won", async () => {
  const a = await connect(alice, "fe");
  const b = await connect(bob, "be");
  b.close();
  const sent = await a.send("bob@example.com/be", "queued");
  const id = sent.message_id;
  const original = store.repo.messages.retract.bind(store.repo.messages);
  // The racing retract commits between this call's pre-check and its store call: forced by running it in the spy.
  const spy = spyOn(store.repo.messages, "retract").mockImplementation((async (...args: Parameters<typeof original>) => {
    expect(await original(...args)).toBe("retracted");
    return "gone";
  }) as never);
  let out: unknown;
  try { out = await seed(store.repo, tx => application.retract(tx, a.session, id)); } finally { spy.mockRestore(); }
  const at = store.db.query<{ at: number }, [string]>("SELECT at FROM access_log WHERE action = 'message.retracted' AND target = ?").get(`message:${id}`)!.at;
  expect(out).toEqual({ note: `already retracted by you at ${new Date(at).toISOString()}` });
  // Someone else's retract of it, gone, is told there's no message from them: the audit row names its sender.
  const c = await connect(bob, "qa");
  await expect(seed(store.repo, tx => application.retract(tx, c.session, id))).rejects.toMatchObject({ code: "not_found", message: `no message ${id} from you` });
  c.close();
  a.close();
});

// #807 P3 C5 decision 3: every bind runs the lazy create; on a name that exists it returns null, and the bind audits
// no second creation.
test("binding an existing name again creates nothing and audits no second alias.created", async () => {
  const created = () => store.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM access_log WHERE action = 'alias.created' AND target = ?").get("alice@example.com/fe")!.n;
  const first = await connect(alice, "fe");
  expect(created()).toBe(1);
  await first.unbind("fe");
  first.close();
  (await connect(alice, "fe")).close();
  expect(created()).toBe(1);
  expect((await store.repo.aliases.listForScope(store.repo.read, "person", "alice@example.com")).map(a => a.name)).toEqual(["fe"]);
});

// #807 P1c-13: attachHuman's lazy human alias runs on its write's Tx. #807 P3 C5 decision 3: the create is
// insert-if-absent, with no find before it; a second attach's create finds it and audits nothing.
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
  const created = () => store.db.query<{ n: number }, []>("SELECT count(*) AS n FROM access_log WHERE action = 'alias.created'").get()!.n;
  try {
    await application.attachHuman(alice, delivery());
    expect(created()).toBe(1);
    application.disconnectUser(alice.user_id);
    await application.attachHuman(alice, delivery());
  } finally { for (const spy of spies) spy.mockRestore(); }
  expect(checks).toEqual(["create:tx", "create:tx"]);
  expect(created()).toBe(1);
});

test("reserved human authority is a separate trusted method, never a selected client field", async () => {
  await expect(connect(alice, "human")).rejects.toMatchObject({ code: "forbidden" });
  const human = (await application.attachHuman(alice, delivery())).session;
  application.disconnectUser(alice.user_id);
  expect(human.active).toBe(true);
  await seed(store.repo, tx => store.repo.users.setDisabled(tx, alice.user_id, true));
  await expect(application.inbox(store.repo.read, human)).rejects.toThrow("an admin signed this user out");
});

// #807 P3 A3: a disabled user's session terminated inside a body writes its close rows on the body's Tx (post refuses
// inside a transaction): its last-seen touch joins the body, its sink is told why, and the caller gets the sign-out.
test("a session terminated inside a write body closes on its Tx and tells its sink", async () => {
  const a = await connect(alice, "be");
  const closed = spyOn(a.session.sink, "closed");
  expect(a.session.writerId).toBeTruthy();
  await seed(store.repo, tx => store.repo.users.setDisabled(tx, alice.user_id, true));
  await expect(store.repo.write(tx => application.receiptDirect(tx, a.session, []))).rejects.toThrow("an admin signed this user out");
  expect(a.session.active).toBe(false);
  expect(closed).toHaveBeenCalledTimes(1);
  expect(String(closed.mock.calls[0]![0])).toContain("an admin signed this user out");
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
  expect(await store.repo.cursors.directFor(store.repo.read, b.identityFull)).toBe(0);
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
    const team = await store.repo.teams.create(tx, "private", bob.user_id);
    await store.repo.teams.addMember(tx, team.id, bob.user_id);
  });
  const bobBe = (await connect(bob, "be", { key: "bob-secret" })).session;
  await seed(store.repo, tx => application.call(tx, bobBe, "board_create", { name: "secret", purpose: "fixture", team: "private" }));
  const asked: string[] = [];
  const principalOf = store.repo.policyNow.principalOf.bind(store.repo.policyNow);
  store.repo.policyNow.principalOf = (address: string) => { asked.push(address); return principalOf(address); };
  // One with no ids row (a foreign or pre-context ID), and one registered as hosted does at create.
  const unregistered = (await application.hostedSession(store.repo.read, alice, "id:0000000000000", [], null, null, delivery())).session;
  await seed(store.repo, tx => application.hostedRegister(tx, alice, "id:1111111111111", "opencode"));
  const registered = (await application.hostedSession(store.repo.read, alice, "id:1111111111111", [], null, null, delivery())).session;
  for (const session of [unregistered, registered]) {
    expect((await application.boardCatalog(store.repo.read, session)).boards.map(b => b.name)).toContain("e2e");
    expect((await application.boardCatalog(store.repo.read, session)).boards.map(b => b.name)).not.toContain("secret");
    expect((await application.boardSnapshot(store.repo.read, session, "e2e")).posts.map(p => p.body)).toEqual(["hello"]);
    await expect(application.boardSnapshot(store.repo.read, session, "secret")).rejects.toThrow();
  }
  expect(((await seed(store.repo, tx => application.call(tx, registered, "board_list", {}))) as { name: string }[]).map(b => b.name)).toContain("e2e");
  expect(((await seed(store.repo, tx => application.call(tx, registered, "board_read", { board: "e2e" }))) as { posts: { body: string }[] }).posts.map(p => p.body)).toEqual(["hello"]);
  expect(asked.filter(a => a.endsWith("/human"))).toEqual([]);
  expect(await store.repo.aliases.find(store.repo.read, "alice@example.com/human")).toBeUndefined();
  expect(store.db.query("SELECT COUNT(*) AS n FROM subscriptions WHERE handle LIKE '%/human'").get()).toEqual({ n: 0 });
  application.close(owner);
  application.close(bobBe);
});

test("a hosted session whose hello facts throw is left unregistered (#385 item 9)", async () => {
  const pushed: unknown[] = [];
  const teams = spyOn(store.repo.teams, "listForUser").mockImplementation(() => Promise.reject(new Error("db gone")));
  try {
    await expect(application.hostedSession(store.repo.read, alice, "id:2222222222222", ["alice@example.com/be"], null, null, { deliver: e => { pushed.push(e); }, closed: () => {} }, true)).rejects.toThrow("db gone");
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
  await seed(store.repo, async tx => {
    const ownership = await store.repo.hosted.start(tx, "hosted-unbound", alice.user_id, "test", now);
    await store.repo.hosted.insert(tx, {
      session_id: "hosted-unbound", ownership_id: ownership, user_id: alice.user_id, client_id: "test", grant_id: "grant", source_session_id: "hosted-unbound",
      writes_as: null, bind_gen: 0, root_session_id: null, place: null, lease_deadline: null, created_at: now, last_seen_at: now, suggested: null, parked_at: null,
    });
  });
  const { session, info } = await application.hostedSession(store.repo.read, alice, "hosted-unbound", [], null, null, delivery());
  expect(session.writerId).toBeUndefined();
  expect(info.candidates).toEqual([]);
  expect((await store.repo.aliases.listForScope(store.repo.read, "person", alice.user_email))).toEqual([]);
  expect(store.db.query("SELECT * FROM handles").all()).toEqual([]);
  const operations = [
    () => seed(store.repo, tx => application.send(tx, session, "be", "no")),
    () => seed(store.repo, tx => application.delegate(tx, session, { persona: "a researcher", task: "no" })),
    () => application.history(store.repo.read, session),
    () => application.thread(store.repo.read, session, 1),
    () => application.inbox(store.repo.read, session),
    () => seed(store.repo, tx => application.receiptDirect(tx, session, [1])),
    () => seed(store.repo, tx => application.receiptBoards(tx, session, [])),
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
  const observer = (await application.hostedSession(store.repo.read, alice, "hosted-observer", [], null, null, delivery())).session;
  expect(((await seed(store.repo, tx => application.call(tx, observer, "peer_list", { include_offline: true }))) as { peers: unknown[] }).peers).toMatchObject([{ online: false }]);
  expect(tools.session.toolsOnly).toBe(true);
  expect(tools.session.holds).toEqual([]);
  await expect(connect(alice, "held")).rejects.toMatchObject({ code: "alias_held", extra: { holder: expect.stringContaining(owner.id) } });
  expect((await application.hostedCandidates(store.repo.read, alice, null))).toEqual([]);
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
  expect((await store.repo.aliases.listForScope(store.repo.read, "person", alice.user_email))).toEqual([]);
  await expect(connect(alice, "human", { key: "human-secret" })).rejects.toMatchObject({ code: "forbidden" });
  const human = (await application.attachHuman(alice, delivery())).session;
  // The bridge's human has no session ID (#284 S16); it logs as `human`.
  expect(human.sessionId).toBe("");
  application.close(human);
  // Outside a body, close queues its release row (#807 P3 B1c): a write behind it on the queue runs after it.
  await store.repo.write(async () => {});
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
  expect(await store.repo.aliases.find(store.repo.read, `${bob.user_email}/other`)).toBeUndefined();
});

test("a reply to anyone but the parent's other party is refused bad_request and writes nothing (#524, #530)", async () => {
  const carol = await seed(store.repo, async tx => { const u = await store.repo.users.upsertByEmail(tx, "carol@example.com", null); return tokenSessionIn(store.repo, tx, { user_id: u.id, user_email: u.email, kind: u.kind }); });
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
  expect(await store.repo.aliases.find(store.repo.read, "alice@example.com/human")).toBeUndefined();
  release();
  await done;
  expect((await attached).session.human).toBe(true);
  expect(store.db.query("SELECT event FROM binding_events").all()).toEqual([{ event: "bound" }]);
});

// #807 P3 B1c: the take is the authority (D3). A hold or a writer that lands between bind's early checks and its take
// (here a trigger on the lazy create, standing in for Postgres's concurrent bind) refuses the bind alias_held, naming
// whoever has it now; the refused row is written after the rollback, which takes the lazily created alias with it.
test("#807 P3 B1c: a hold or another user's writer landing after bind's checks refuses at the take", async () => {
  const a = await connect(alice, null), other = await connect(alice, null, { key: "alice-other" });
  const writer = await connect(bob, null, { key: "bob-tools", push: false });
  const race = "alice@example.com/race", race2 = "alice@example.com/race2";
  store.db.run(`CREATE TEMP TRIGGER land_hold AFTER INSERT ON aliases WHEN NEW.address = '${race}'
    BEGIN INSERT INTO alias_holds (address, id, bound_at) VALUES (NEW.address, '${other.id}', 1); END`);
  store.db.run(`CREATE TEMP TRIGGER land_writer AFTER INSERT ON aliases WHEN NEW.address = '${race2}'
    BEGIN UPDATE ids SET writes_as = NEW.address WHERE id = '${writer.id}'; END`);
  const refused = (name: string) => store.db.query("SELECT detail FROM binding_events WHERE session_id = ? AND name = ? AND event = 'refused'").all(a.id, name);
  await expect(a.bind("race", { create: true })).rejects.toMatchObject({ code: "alias_held", extra: { holder: expect.stringContaining(other.id) } });
  expect(refused(race)).toEqual([{ detail: expect.stringContaining(other.id) }]);
  await expect(a.bind("race2", { create: true })).rejects.toMatchObject({ code: "alias_held", message: expect.stringContaining(`another user's session ${writer.id}`) });
  expect(refused(race2)).toEqual([{ detail: `another user's session ${writer.id}` }]);
  for (const address of [race, race2]) expect(await store.repo.aliases.find(store.repo.read, address)).toBeUndefined();
  expect(store.db.query("SELECT COUNT(*) AS n FROM alias_holds").get()).toEqual({ n: 0 });
  expect(a.session.holds).toEqual([]);
});

// #807 P3 C10a Q3: bindings.setMeta returns its diff and bind writes alias.meta_set itself, on the bind's Tx once the
// store's write has settled: a setMeta that settles late (as a Postgres one does) still leaves its row, and a bind that
// fails after it keeps neither the labels nor the row.
test("#807 P3 C10a: bind audits setMeta's diff on its own Tx after the store settles", async () => {
  const metaSets = () => store.db.query<{ actor: string; detail: string }, []>("SELECT actor, detail FROM access_log WHERE action = 'alias.meta_set' ORDER BY id").all()
    .map(r => ({ actor: r.actor, detail: JSON.parse(r.detail) as unknown }));
  const setMeta = store.repo.bindings.setMeta.bind(store.repo.bindings);
  const late = spyOn(store.repo.bindings, "setMeta").mockImplementation(async (...args: Parameters<typeof setMeta>) => {
    const diff = await setMeta(...args);
    await new Promise<void>(resolve => setImmediate(resolve));
    return diff;
  });
  try {
    const a = await connect(alice, null);
    // A new bind's labels, then a held re-bind's change, then one that changes nothing.
    await a.bind("fe", { create: true, meta: { task: "ENG-142" } });
    await a.bind("fe", { meta: { task: "ENG-143", owner: "o" } });
    await a.bind("fe", { meta: { task: "ENG-143" } });
    const fe = "alice@example.com/fe";
    expect(metaSets()).toEqual([
      { actor: "alice@example.com", detail: { address: fe, fields: { task: "ENG-142" }, session: a.id } },
      { actor: "alice@example.com", detail: { address: fe, fields: { task: "ENG-143", owner: "o" }, session: a.id } },
    ]);
    // A bind that fails after its labels are written rolls both back.
    const touch = spyOn(store.repo.bindings, "touchAlias").mockRejectedValue(new Error("touch failed"));
    try {
      await expect(a.bind("be", { create: true, meta: { task: "lost" } })).rejects.toThrow("touch failed");
    } finally { touch.mockRestore(); }
    expect(metaSets()).toHaveLength(2);
    expect(await store.repo.aliases.find(store.repo.read, "alice@example.com/be")).toBeUndefined();
  } finally { late.mockRestore(); }
});

// #807 P3 C10a Q4: a tools-only root's writes_as is judged under the alias's "use" lock on the create path, after the
// lazy create and before the userOf check (on Postgres that lock serializes it against a bind's take, aliases.pg.test.ts
// T-C5-6); the create=false re-check takes none. A lock that finds the alias gone (a delete committed first) refuses.
test("#807 P3 C10a: hostedWritesAs locks the alias before its check on the create path only", async () => {
  const steps: string[] = [];
  const lock = store.repo.aliases.lock.bind(store.repo.aliases), userOf = store.repo.bindings.userOf.bind(store.repo.bindings);
  const create = store.repo.aliases.create.bind(store.repo.aliases);
  const locks = spyOn(store.repo.aliases, "lock").mockImplementation(async (...a: Parameters<typeof lock>) => { steps.push(`lock ${a[1]} ${a[2]}`); return lock(...a); });
  const spies = [
    locks,
    spyOn(store.repo.bindings, "userOf").mockImplementation(async (...a: Parameters<typeof userOf>) => { steps.push(`userOf ${a[1]}`); return userOf(...a); }),
    spyOn(store.repo.aliases, "create").mockImplementation(async (...a: Parameters<typeof create>) => { steps.push("create"); return create(...a); }),
  ];
  const fe = "alice@example.com/fe";
  try {
    expect(await seed(store.repo, tx => application.hostedWritesAs(tx, alice, "id:w1", "fe", true))).toBe(fe);
    expect(steps).toEqual(["create", `lock ${fe} use`, `userOf ${fe}`]);
    steps.length = 0;
    expect(await seed(store.repo, tx => application.hostedWritesAs(tx, alice, "id:w1", "fe", false))).toBe(fe);
    expect(steps).toEqual([`userOf ${fe}`]);
    // Another user's session writing as the alias: refused on the create path, under the lock.
    await seed(store.repo, tx => store.repo.bindings.registerId(tx, { id: "id:w2", principal: "bob@example.com", launcher: false, writesAs: fe }));
    await expect(seed(store.repo, tx => application.hostedWritesAs(tx, alice, "id:w1", "fe", true))).rejects.toThrow("another user's session id:w2");
    locks.mockImplementation(async () => undefined);
    await expect(seed(store.repo, tx => application.hostedWritesAs(tx, alice, "id:w1", "be", true))).rejects.toThrow(`"alice@example.com/be" was deleted while this session declared it`);
  } finally { for (const s of spies) s.mockRestore(); }
});

// #807 P3 B1c: close's rows. On a body's Tx they're written at its commit and roll back with it, as when written
// inline; outside a body they're queued writes, so a close from the write queue's holder (a commit callback) lands
// after it rather than throwing as an async post there would.
test("#807 P3 B1c: close's touch commits or rolls back with its body, and from a commit callback is queued", async () => {
  const seen = (id: string) => (store.db.query("SELECT last_seen FROM ids WHERE id = ?").get(id) as { last_seen: number }).last_seen;
  const errors = spyOn(console, "error");
  try {
    const rolled = await connect(alice, "rolled"), kept = await connect(alice, "kept", { key: "alice-kept" }), late = await connect(alice, "late", { key: "alice-late" });
    await seed(store.repo, async tx => { store.repo.coreOn(tx).run("UPDATE ids SET last_seen = 0"); });
    await expect(store.repo.write(async tx => { application.close(rolled.session, tx); throw new Error("body refused"); })).rejects.toThrow("body refused");
    expect(rolled.session.active).toBe(false);
    expect(seen(rolled.id)).toBe(0);
    await store.repo.write(async tx => {
      application.close(kept.session, tx);
      // Not mid-body: at the commit.
      expect(seen(kept.id)).toBe(0);
    });
    expect(seen(kept.id)).toBeGreaterThan(0);
    await store.repo.write(async () => {}, () => application.close(late.session));
    await until(() => seen(late.id) > 0, 2000, "the queued close touch");
    expect(errors.mock.calls.filter(c => String(c[0]).includes("last-seen touch"))).toEqual([]);
  } finally { errors.mockRestore(); }
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
