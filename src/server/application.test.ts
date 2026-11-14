import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication, type DeliverySink } from "./application.ts";
import { openDatabase } from "./db.ts";
import type { AuthedUser } from "./auth.ts";
import { writeAudit } from "./audit.ts";
import { tokenSession } from "../../tests/support/token_session.ts";
import { AppSession } from "../../tests/support/app_session.ts";

let store: ReturnType<typeof openDatabase>;
let application: ReturnType<typeof createApplication>;
let blobDir: string;
let alice: AuthedUser;
let bob: AuthedUser;
function delivery(): DeliverySink {
  return { deliver: () => {}, closed: () => {} };
}
// A connected AppSession: it registers like a hosted session and binds `alias`.
async function connect(user: AuthedUser, alias: string | null, opts: ConstructorParameters<typeof AppSession>[3] = {}): Promise<AppSession> {
  const s = new AppSession(application, user, alias, opts);
  await s.connect();
  return s;
}
const isDirect = (e: { kind: string }) => e.kind === "direct";
beforeEach(() => {
  blobDir = mkdtempSync(join(tmpdir(), "gb-application-"));
  store = openDatabase(":memory:", { blobDir });
  application = createApplication(store.repo, store.db);
  const user = (email: string): AuthedUser => {
    const u = store.repo.users.upsertByEmail(email, null);
    // A session needs a live sign-in (#351).
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


test("typed operations and delivery need no frames; receipts alone move the delivery cursor", async () => {
  const a = await connect(alice, "BE");
  const b = await connect(bob, "fe", { key: "bob-key" });
  const sent = await a.send("bob@example.com/fe", "question?", { pending: true });
  expect(sent).toMatchObject({ delivered_now: true, pending: true });
  expect(sent).not.toHaveProperty("type");
  expect(await b.next(isDirect)).toMatchObject({ kind: "direct", message: { id: sent.message_id, body: "question?" } });
  expect(store.repo.cursors.directFor(b.session.identityFull)).toBe(0);
  await b.dmAck(sent.message_id);
  expect(store.repo.cursors.directFor(b.session.identityFull)).toBe(0);
  b.close();
  // A rebuilt session on the same key is the same ID: it re-binds the alias it holds and replays its mail.
  const b2 = await connect(bob, "fe", { key: "bob-key" });
  expect(await b2.next(isDirect)).toMatchObject({ message: { id: sent.message_id } });
  await b2.ack([sent.message_id]);
  expect(store.repo.cursors.directFor(b.session.identityFull)).toBe(sent.message_id);
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
  store.repo.messages.markDelivered(sent.message_id, stamp + 60_000);
  await b.ack([sent.message_id]);
  expect((await a.history())[0]!.delivered_at).toBe(stamp);

  b.close();
  const queued = await a.send("bob@example.com/fe", "skipped backlog");
  expect((await a.history()).at(-1)).toMatchObject({ id: queued.message_id, delivered: false });
  store.repo.cursors.advance("bob@example.com/fe", "direct", "bob@example.com/fe", queued.message_id);
  const skipped = (await a.history()).at(-1)!;
  expect(skipped).toMatchObject({ id: queued.message_id, delivered: true });
  expect(skipped).not.toHaveProperty("delivered_at");
});

test("board observers are independent hints with concealed access and explicit lifecycle cleanup", async () => {
  const a = (await connect(alice, "be", { push: false })).session;
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
  expect(store.repo.aliases.listForScope("person", alice.user_email).map(x => x.name)).toEqual(["be"]);
  expect(store.db.query("SELECT event FROM binding_events").all()).toEqual([{ event: "bound" }]);
  expect(store.db.query("SELECT * FROM access_log WHERE action = 'bind.rate_limited'").all()).toHaveLength(1);
  expect((await application.attachHuman(alice, delivery())).session.human).toBe(true);
  // Per user: bob's bind spends his own budget.
  expect((await connect(bob, "fe")).session.holds).toEqual(["bob@example.com/fe"]);
});

test("reserved human authority is a separate trusted method, never a selected client field", async () => {
  await expect(connect(alice, "human")).rejects.toMatchObject({ code: "forbidden" });
  const human = (await application.attachHuman(alice, delivery())).session;
  application.disconnectUser(alice.user_id);
  expect(human.active).toBe(true);
  store.repo.users.setDisabled(alice.user_id, true);
  expect(() => application.inbox(human)).toThrow("an admin signed this user out");
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
  const pending = application.pending(b, 1);
  expect(pending).toMatchObject([{ kind: "direct", message: { id, body: "pending", pending: true } }]);
  expect(application.pending(b, 1)).toEqual(pending);
  expect(store.repo.cursors.directFor(b.identityFull)).toBe(0);
  expect(() => application.pending(b, 101)).toThrow();
  expect(() => application.pending(b, 0)).toThrow();
  store.repo.users.setDisabled(bob.user_id, true);
  expect(() => application.pending(b)).toThrow("an admin signed this user out");
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
  application.call(owner, "board_create", { name: "e2e", purpose: "fixture" });
  application.call(owner, "board_post", { board: "e2e", body: "hello" });
  const team = store.repo.teams.create("private", bob.user_id);
  store.repo.teams.addMember(team.id, bob.user_id);
  const bobBe = (await connect(bob, "be", { key: "bob-secret" })).session;
  application.call(bobBe, "board_create", { name: "secret", purpose: "fixture", team: "private" });
  const asked: string[] = [];
  const principalOf = store.repo.resolver.principalOf.bind(store.repo.resolver);
  store.repo.resolver.principalOf = (address: string) => { asked.push(address); return principalOf(address); };
  // One with no ids row (a foreign or pre-context ID), and one registered as hosted does at create.
  const unregistered = application.hostedSession(alice, "id:0000000000000", [], null, null, delivery()).session;
  application.hostedRegister(alice, "id:1111111111111", "opencode");
  const registered = application.hostedSession(alice, "id:1111111111111", [], null, null, delivery()).session;
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

test("a hosted session whose hello facts throw is left unregistered (#385 item 9)", async () => {
  const pushed: unknown[] = [];
  const teams = spyOn(store.repo.teams, "listForUser").mockImplementation(() => { throw new Error("db gone"); });
  try {
    expect(() => application.hostedSession(alice, "id:2222222222222", ["alice@example.com/be"], null, null, { deliver: e => { pushed.push(e); }, closed: () => {} }, true)).toThrow("db gone");
  } finally { teams.mockRestore(); }
  // An unheld "be": a DM to it is pushed only to a session the hub routes it to.
  store.repo.aliases.create({ scope_kind: "person", scope_ref: "alice@example.com", name: "be" }, "alice@example.com");
  const sender = await connect(alice, "sender");
  await sender.send("alice@example.com/be", "no route left behind");
  expect(pushed).toEqual([]);
  sender.close();
});

test("unbound hosted sessions cannot use named operations or persist synthetic handles", async () => {
  const { session, info } = application.hostedSession(alice, "hosted-unbound", [], null, null, delivery());
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

test("hold sessions block binding and candidates without push or online presence; a close leaves the hold", async () => {
  const owner = await connect(alice, "held", { push: false, hold: true, key: "hold-secret" });
  await owner.call("peer_status", { text: "working" });
  const tools = await connect(alice, "held", { push: false });
  const observer = application.hostedSession(alice, "hosted-observer", [], null, null, delivery()).session;
  expect((application.call(observer, "peer_list", { include_offline: true }) as { peers: unknown[] }).peers).toMatchObject([{ online: false, status: "working" }]);
  expect(tools.session.toolsOnly).toBe(true);
  expect(tools.session.holds).toEqual([]);
  await expect(connect(alice, "held")).rejects.toMatchObject({ code: "alias_held", extra: { holder: expect.stringContaining(owner.id) } });
  expect(application.hostedCandidates(alice, null)).toEqual([]);
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
  expect(store.repo.aliases.listForScope("person", alice.user_email)).toEqual([]);
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
  expect(store.repo.aliases.find(`${bob.user_email}/other`)).toBeUndefined();
});

test("a reply to anyone but the parent's other party is refused bad_request and writes nothing (#524, #530)", async () => {
  const carol = tokenSession(store.repo, (u => ({ user_id: u.id, user_email: u.email }))(store.repo.users.upsertByEmail("carol@example.com", null)));
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
