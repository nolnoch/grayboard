import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { until } from "../../tests/support/until.ts";
import { AppSession } from "../../tests/support/app_session.ts";
import { hostedRowCount } from "../../tests/support/hosted_rows.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "./application.ts";
import { openDatabase } from "./db.ts";
import { createHostedSessions, deliveryDeclaration, hostedBoundInstruction, sessionContext, withoutFacts } from "./hosted.ts";
import { cleanFact } from "../core/boards.ts";
import { createOAuthServer, type OAuthPrincipal } from "./oauth.ts";
import { BUILTIN_CLIENT_IDS, OPENCODE_CLIENT, OPENCODE_SESSION_META } from "./oauth-config.ts";
import { GRAYBOARD_DELIVERY_META, GRAYBOARD_EFFORT_META, GRAYBOARD_LAUNCHER_META, GRAYBOARD_MODEL_META, GRAYBOARD_SESSION_META, GRAYBOARD_SUGGESTED_META, GRAYBOARD_WRITES_AS_META } from "../shared/session_meta.ts";
import { aliasUser, boundInstructions, childCapacity } from "../core/bindings.ts";
import { COORDINATION_INSTRUCTIONS, DEFAULT_CHANNEL_SOURCE } from "../core/tools.ts";
import { DEFAULT_AUTH_FAIL_LIMIT, DEFAULT_HELLO_LIMIT } from "./rate_limit.ts";
import { DEFAULT_TRUSTED_PROXIES } from "./client_addr.ts";
import { issueOAuth } from "../../tests/helpers/oauth.ts";
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
  principal = { authed: { user_id: user.id, user_email: user.email, session_id: 0 }, clientId: OPENCODE_CLIENT, sourceKey: OPENCODE_SESSION_META, grantId: "G1", accessHash: "test", accessExpiry: Number.MAX_SAFE_INTEGER, scopes: ["tools", "delivery"] };
  now = Date.now(); authorized = true;
  hosted = createHostedSessions(application, { now: () => now, isAuthorized: () => authorized });
  delivery = createDelivery(hosted, { isAuthorized: () => authorized });
});
afterEach(() => { delivery.close(); hosted.close(); application.stopExpiry(); database.db.close(); rmSync(blobDir, { recursive: true, force: true }); });

test("one reconciliation invalidates listeners once, not once per root", async () => {
  for (let i = 0; i < 4; i++) await hosted.bind(principal, context(`root-${i}`), { name: `peer-${i}`, create: true });
  let invalidations = 0;
  const unlisten = hosted.listen(() => { invalidations++; });
  try {
    database.repo.hosted.atomic(() => {});
    expect(invalidations).toBe(1);
    expect(application.holdsByOwner().size).toBe(4);
  } finally { unlisten(); }
});

test("startup opens no holder session for a root its first sweep ends (#424 item 7)", async () => {
  const root = context("lapsed-root");
  if (!("id" in root)) throw new Error("fixture context");
  await hosted.bind(principal, root, { name: "be", create: true });
  await delivery.open(principal, root);
  hosted.close();
  // The lease lapsed while the server was still up: no credit, and the startup sweep ends the root.
  database.db.run("UPDATE hosted_sessions SET lease_deadline = ? WHERE session_id = ?", [now - 1, root.id]);
  now += 5 * 60_000;
  const opened = spyOn(application, "hostedSession");
  try {
    hosted = createHostedSessions(application, { now: () => now, isAuthorized: () => authorized });
    expect(database.repo.hosted.get(root.id)).toBeUndefined();
    expect(opened).not.toHaveBeenCalled();
  } finally { opened.mockRestore(); }
});

test("hosted source IDs attribute child writes and release only the root alias hold", async () => {
  const root = context("root"), child = context("child");
  if (!("id" in root) || !("id" in child)) throw new Error("fixture context");
  await hosted.bind(principal, root, { name: "be", create: true });
  await hosted.register(principal, root, "child");
  for (const id of [root.id, child.id]) {
    expect(id).toMatch(/^id:[0-9a-hjkmnp-tv-z]{13}$/);
    expect(database.db.query("SELECT principal, keyed, launcher FROM ids WHERE id=?").get(id)).toEqual({ principal: "you@example.com", keyed: 0, launcher: 0 });
  }
  expect(database.db.query("SELECT address, id FROM alias_holds").all()).toEqual([{ address: "you@example.com/be", id: root.id }]);
  await hosted.run(principal, child, "dm_send", session => application.send(session, "be", "child attribution"));
  expect(database.db.query("SELECT sender_id FROM messages WHERE body='child attribution'").get()).toEqual({ sender_id: child.id });
  await hosted.end(principal, root);
  expect(database.db.query("SELECT * FROM alias_holds").all()).toEqual([]);
  expect(database.db.query("SELECT id FROM ids WHERE id IN (?, ?)").all(root.id, child.id)).toHaveLength(2);
});

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
  expect(hostedRowCount(database.db)).toBe(0);
  await hosted.whoami(principal, context("overflow"));
  expect(hosted.gateCount).toBe(0);
  await hosted.end(principal, context("overflow"));
  expect(hostedRowCount(database.db)).toBe(0);
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
  expect(sessionContext({ ...principal, sourceKey: null }, { [OPENCODE_SESSION_META]: "one" })).toHaveProperty("missing");
  expect(sessionContext(principal, {})).toHaveProperty("missing");
});

test("the authenticated client selects the source key and harness; nothing else maps", async () => {
  const oauth = createOAuthServer(database.repo, { dbPath: ":memory:", blobDir, httpPort: 0, googleClientId: "dev", googleClientSecret: "", orgDomain: "example.com", publicUrl: "https://grayboard.example.com", messageRetentionDays: 90, auditRetentionDays: 90, devAuth: false, admins: [], helloLimit: DEFAULT_HELLO_LIMIT, authFailLimit: DEFAULT_AUTH_FAIL_LIMIT, trustedProxies: DEFAULT_TRUSTED_PROXIES, oauthClients: [
    { clientId: "broker", name: "Broker", redirectUris: ["http://127.0.0.1/callback"], scopes: ["grayboard:tools", "grayboard:delivery"], tokenEndpointAuthMethod: "none", sessionSource: true },
    { clientId: "plain", name: "Plain", redirectUris: ["http://127.0.0.1/callback"], scopes: ["grayboard:tools", "grayboard:delivery"], tokenEndpointAuthMethod: "none" },
  ] });
  try {
    const authenticate = (clientId: string) => {
      const issued = issueOAuth(database.repo, oauth.resource, "you@example.com", ["grayboard:tools", "grayboard:delivery"], now, clientId);
      const p = oauth.authenticate(new Request(oauth.resource, { headers: { Authorization: `Bearer ${issued.token}` } }));
      if (p instanceof Response) throw new Error("fixture authorization failed");
      return p;
    };
    const [broker, opencode, plain, cimd, ...builtins] = ["broker", OPENCODE_CLIENT, "plain", "https://client.example/client.json", ...BUILTIN_CLIENT_IDS].map(authenticate);
    expect([broker!.sourceKey, opencode!.sourceKey, plain!.sourceKey, cimd!.sourceKey]).toEqual([GRAYBOARD_SESSION_META, OPENCODE_SESSION_META, null, null]);
    expect(builtins.map(p => [p.clientId, p.sourceKey])).toEqual(BUILTIN_CLIENT_IDS.map(id => [id, GRAYBOARD_SESSION_META]));
    const both = { [GRAYBOARD_SESSION_META]: "generic", [OPENCODE_SESSION_META]: "opencode" };
    expect(sessionContext(broker!, both)).toMatchObject({ raw: "generic" });
    expect(sessionContext(opencode!, both)).toMatchObject({ raw: "opencode" });
    expect(sessionContext(broker!, { [OPENCODE_SESSION_META]: "root" })).toEqual({ missing: `the key _meta["${GRAYBOARD_SESSION_META}"] is missing` });
    expect(sessionContext(opencode!, { [GRAYBOARD_SESSION_META]: "root" })).toEqual({ missing: `the key _meta["${OPENCODE_SESSION_META}"] is missing` });
    for (const p of [plain!, cimd!]) expect(sessionContext(p, both)).toEqual({ missing: "the client has no mapped source" });
    const brokerRoot = sessionContext(broker!, { [GRAYBOARD_SESSION_META]: "same" }), opencodeRoot = sessionContext(opencode!, { [OPENCODE_SESSION_META]: "same" });
    if (!("id" in brokerRoot) || !("id" in opencodeRoot)) throw new Error("fixture source mapping");
    expect(brokerRoot.id).not.toBe(opencodeRoot.id);
    await hosted.bind(broker!, brokerRoot, { name: "broker-run", create: true });
    await hosted.register(broker!, brokerRoot, "broker-child");
    await hosted.bind(opencode!, opencodeRoot, { name: "oc-run", create: true });
    const harness = (id: string) => database.db.query<{ harness: string }, [string]>("SELECT harness FROM ids WHERE id = ?").get(id)?.harness;
    const child = sessionContext(broker!, { [GRAYBOARD_SESSION_META]: "broker-child" });
    if (!("id" in child)) throw new Error("fixture source mapping");
    expect([harness(brokerRoot.id), harness(child.id), harness(opencodeRoot.id)]).toEqual(["broker", "broker", "opencode"]);
    // Built-ins (#429): with no operator registration, the generic key binds and each
    // session carries its harness label, not its client ID.
    const roots: string[] = [];
    for (const p of builtins) {
      expect(sessionContext(p, { [OPENCODE_SESSION_META]: "root" })).toEqual({ missing: `the key _meta["${GRAYBOARD_SESSION_META}"] is missing` });
      const root = sessionContext(p, both);
      if (!("id" in root)) throw new Error("fixture source mapping");
      expect(root.raw).toBe("generic");
      await hosted.bind(p, root, { name: `${p.clientId}-run`, create: true });
      roots.push(root.id);
    }
    expect(new Set(roots).size).toBe(BUILTIN_CLIENT_IDS.length);
    expect(roots.map(harness)).toEqual(["pi", "omp", "claude-code"]);
  } finally { oauth.close(); }
});

test("only a generic-key client's delivery declaration is read, and strictly", () => {
  const generic: OAuthPrincipal = { ...principal, clientId: "grayboard-pi", sourceKey: GRAYBOARD_SESSION_META };
  const declare = (value: unknown) => deliveryDeclaration(generic, { [GRAYBOARD_SESSION_META]: "root", [GRAYBOARD_DELIVERY_META]: value });
  expect(declare({ mode: "push", source: "grayboard" })).toEqual({ mode: "push", source: "grayboard" });
  expect(declare({ mode: "poll", source: "0" + "a:._-".repeat(12) + "abc" })).toEqual({ mode: "poll", source: "0" + "a:._-".repeat(12) + "abc" });
  expect(deliveryDeclaration(generic, { [GRAYBOARD_SESSION_META]: "root" })).toBeUndefined();
  expect(deliveryDeclaration(generic, undefined)).toBeUndefined();
  for (const value of [null, "push", [], {}, { mode: "push" }, { source: "grayboard" }, { mode: "stream", source: "grayboard" }, { mode: "PUSH", source: "grayboard" },
    { mode: "push", source: "" }, { mode: "push", source: "Grayboard" }, { mode: "push", source: "-grayboard" }, { mode: "push", source: "a".repeat(65) }, { mode: "push", source: "gray board" },
    { mode: "push", source: 'x"y' }, { mode: "push", source: 7 }, { mode: "push", source: "grayboard", extra: true }]) {
    let refusal: unknown;
    try { declare(value); } catch (error) { refusal = error; }
    expect(refusal, JSON.stringify(value)).toMatchObject({ code: "bad_request" });
  }
  // OpenCode's and an unmapped client's declarations are never read, even malformed ones.
  for (const p of [principal, { ...principal, clientId: "plain", sourceKey: null }]) expect(deliveryDeclaration(p, { [GRAYBOARD_DELIVERY_META]: "malformed" })).toBeUndefined();
});

test("a bind result follows the declared delivery: push has no lease note, poll has no channel lines and says to check, absent points at delivery_open", async () => {
  const generic: OAuthPrincipal = { ...principal, clientId: "grayboard-pi", sourceKey: GRAYBOARD_SESSION_META };
  const expected = (name: string, source: string | null, notes: string[]) => [`Bound to "${name}"; the instructions' note that this session has no bus name no longer applies.`, ...notes, ...boundInstructions(name, source, true, () => [], [])].join(" ");
  const cases = [
    ["push-run", { mode: "push", source: "grayboard-pi" }, "grayboard-pi", []],
    ["poll-run", { mode: "poll", source: "grayboard-pi" }, null, ["No pushes reach this session; check dm_inbox and board_read yourself."]],
    ["absent-run", undefined, DEFAULT_CHANNEL_SOURCE, [`No delivery lease is open for this session, so DMs to "absent-run" wait until the client opens one (delivery_open).`]],
  ] as const;
  const texts: Record<string, string> = {};
  for (const [name, declared, source, notes] of cases) {
    const result = await hosted.bind(generic, sessionContext(generic, { [GRAYBOARD_SESSION_META]: name }), { name, create: true }, declared);
    texts[name] = result.content[0]!.text;
    expect(texts[name]).toBe(expected(name, source, [...notes]));
    expect(result.structuredContent.instructions).toEqual(boundInstructions(name, source, true, () => [], []));
  }
  expect(texts["push-run"]).toContain(`<channel source="grayboard-pi" message_id="..."`);
  expect(texts["absent-run"]).toContain(`<channel source="grayboard" message_id="..."`);
  // A poll session's bind result reads as its `initialize` text does: no channel lines.
  for (const line of ["<channel", "Pushes don't survive /clear", "delivery_open"]) expect(texts["poll-run"]).not.toContain(line);
  for (const line of COORDINATION_INSTRUCTIONS) expect(texts["poll-run"]).toContain(line);
});

test("unbound context cannot write or implicitly create names", async () => {
  await expect(hosted.run(principal, context("one"), "dm_send", () => true)).rejects.toHaveProperty("code", "unbound");
  await expect(hosted.bind(principal, context("one"), { name: "fe" })).rejects.toHaveProperty("code", "identity_unknown");
  await expect(hosted.bind(principal, { missing: "metadata missing" }, { name: "fe", create: true })).rejects.toHaveProperty("code", "unbound");
  expect(database.repo.aliases.listForScope("person", principal.authed.user_email)).toEqual([]);
});

test("two contexts execute tools under distinct bound identities", async () => {
  await hosted.bind(principal, context("one"), { name: "fe", create: true });
  await hosted.bind(principal, context("two"), { name: "be", create: true });
  const identities = await Promise.all(["one", "two"].map(raw => hosted.run(principal, context(raw), "dm_history", session => session.identityFull)));
  expect(identities).toEqual(["you@example.com/fe", "you@example.com/be"]);
});

test("a hosted bind refused for a live holder leaves its refused binding row (the row survives the rolled-back transaction)", async () => {
  await hosted.bind(principal, context("one"), { name: "fe", create: true });
  await delivery.open(principal, context("one"));
  await expect(hosted.bind(principal, context("two"), { name: "fe" })).rejects.toHaveProperty("code", "alias_held");
  const two = context("two");
  if (!("id" in two)) throw new Error("fixture has no mapped source");
  expect(database.db.prepare("SELECT name, event FROM binding_events WHERE session_id = ? AND event = 'refused'").all(two.id)).toEqual([{ name: "you@example.com/fe", event: "refused" }]);
});

test("a second bind adds a hold, keeps ownership, children and the first hold's claims, and fences old delivery", async () => {
  await hosted.bind(principal, context("root"), { name: "fe", create: true });
  await hosted.register(principal, context("root"), "child");
  const before = await hosted.whoami(principal, context("root"));
  const lease = await delivery.open(principal, context("root"));
  claim(database.db, "you@example.com/fe", "ticket:ENG-142");
  const root = context("root");
  if (!("id" in root)) throw new Error("fixture has no mapped source");
  database.db.prepare("UPDATE ids SET status = ?, status_at = ? WHERE id = ?").run("reviewing", now, root.id);
  database.db.prepare("UPDATE aliases SET queue_off = 1 WHERE address = ?").run("you@example.com/fe");
  await hosted.bind(principal, context("root"), { name: "be", create: true });
  expect(database.db.prepare("SELECT status, status_at FROM ids WHERE id = ?").get(root.id)).toEqual({ status: "reviewing", status_at: now });
  expect(database.db.prepare("SELECT queue_off FROM aliases WHERE address = ?").get("you@example.com/fe")).toEqual({ queue_off: 1 });
  expect(database.db.prepare("SELECT queue_off FROM aliases WHERE address = ?").get("you@example.com/be")).toEqual({ queue_off: null });
  expect(listClaims(database.db)).toMatchObject([{ key: "ticket:ENG-142", holder: "you@example.com/fe" }]);
  expect(await hosted.whoami(principal, context("child"))).toMatchObject({ primary: "you@example.com/fe", held: ["you@example.com/fe", "you@example.com/be"], ownership: before.ownership, child: true });
  await expect(delivery.receipt(principal, context("root"), lease.capability, [])).rejects.toHaveProperty("code", "not_found");
  expect(delivery.activeLeaseCount).toBe(0);
});

test("children cannot bind or own delivery, and child end leaves root", async () => {
  await hosted.bind(principal, context("root"), { name: "fe", create: true });
  await hosted.register(principal, context("root"), "child");
  await expect(hosted.bind(principal, context("child"), { name: "be", create: true })).rejects.toHaveProperty("code", "child_session");
  await expect(delivery.open(principal, context("child"))).rejects.toHaveProperty("code", "child_session");
  await hosted.end(principal, context("child"));
  expect(await hosted.whoami(principal, context("root"))).toHaveProperty("primary", "you@example.com/fe");
  expect(await hosted.whoami(principal, context("child"))).toHaveProperty("unbound", true);
});

// #523: the root's inbox is its own; a child neither lists nor acks it, while the
// root's dm_inbox, dm_ack and a child's explicit reads go on as before.
test("a child's dm_inbox, dm_ack and board_subscribe are refused child_session; its dm_history and dm_thread aren't", async () => {
  await hosted.bind(principal, context("root"), { name: "fe", create: true });
  await hosted.bind(principal, context("peer"), { name: "be", create: true });
  const { child } = await hosted.register(principal, context("root"), "child") as { child: string };
  const sent = await hosted.run(principal, context("peer"), "dm_send", (s) => application.send(s, "you@example.com/fe", "owed by the root"));
  const message = `${child} is a subagent of you@example.com/fe; its root owns this inbox. dm_thread a thread you wrote to see its replies.`;
  await expect(hosted.run(principal, context("child"), "dm_inbox", (s) => application.inbox(s))).rejects.toMatchObject({ code: "child_session", message });
  await expect(hosted.run(principal, context("child"), "dm_ack", (s) => application.acknowledgeDm(s, sent.message_id))).rejects.toMatchObject({ code: "child_session", message });
  await hosted.run(principal, context("peer"), "board_create", (s) => application.call(s, "board_create", { name: "e2e", purpose: "test" }));
  const subs = { code: "child_session", message: `${child} is a subagent of you@example.com/fe; its root owns its board subscriptions and thread mutes. board_read reads a board without marking anything read.` };
  await expect(hosted.run(principal, context("child"), "board_subscribe", (s) => application.call(s, "board_subscribe", { board: "e2e", mode: "push" }))).rejects.toMatchObject(subs);
  await expect(hosted.run(principal, context("child"), "board_subscribe", (s) => application.call(s, "board_subscribe", { board: "e2e", mode: "off", thread: 1 }))).rejects.toMatchObject(subs);
  expect(database.db.query("SELECT COUNT(*) AS n FROM subscriptions WHERE board = 'e2e' AND handle = 'you@example.com/fe'").get()).toEqual({ n: 0 });
  expect((await hosted.run(principal, context("child"), "dm_history", (s) => application.history(s))).map((m) => m.id)).toEqual([sent.message_id]);
  expect((await hosted.run(principal, context("child"), "dm_thread", (s) => application.thread(s, sent.message_id))).map((m) => m.id)).toEqual([sent.message_id]);
  // The root's inbox still owes it, and the root's own ack settles it.
  expect((await hosted.run(principal, context("root"), "dm_inbox", (s) => application.inbox(s))).unanswered.map((m) => m.id)).toEqual([sent.message_id]);
  await hosted.run(principal, context("root"), "dm_ack", (s) => application.acknowledgeDm(s, sent.message_id));
  expect((await hosted.run(principal, context("root"), "dm_inbox", (s) => application.inbox(s))).unanswered).toEqual([]);
});

// #523 audit 2: under a root with no name yet, a child is offered no names to
// bind, and its write is refused naming the root, not with "bind a name first".
test("a child of an unbound root gets no bind candidates, and its write is refused naming its root", async () => {
  const { child, root } = await hosted.register(principal, context("root"), "child") as { child: string; root: string };
  const who = await hosted.whoami(principal, context("child"));
  expect(who).toMatchObject({ id: child, root, child: true, unbound: true });
  expect(who).not.toHaveProperty("candidates");
  expect(await hosted.whoami(principal, context("root"))).toHaveProperty("candidates");
  await expect(hosted.run(principal, context("child"), "dm_send", (s) => application.send(s, "you@example.com/be", "x")))
    .rejects.toMatchObject({ code: "unbound", message: `unbound; this session is a subagent of ${root}, which has no bus name yet. Its writes work once ${root} binds one; binding is the root's.` });
  await expect(hosted.run(principal, context("other"), "dm_send", (s) => application.send(s, "you@example.com/be", "x")))
    .rejects.toMatchObject({ code: "unbound", message: "unbound; bind a name first, or have this session's root register it as a child (session_register)" });
});

// #523 audit 6: a child's delegation audit rows name it under `child`, beside the routing `via`; a root's name none.
test("a child's delegate request and refusal are audited naming the child; the root's name none", async () => {
  await hosted.bind(principal, context("root"), { name: "fe", create: true });
  await hosted.bind(principal, context("peer"), { name: "be", create: true });
  const { child } = await hosted.register(principal, context("root"), "child") as { child: string };
  const ask = { persona: "a reviewer", task: "review", to: "be" };
  await expect(hosted.run(principal, context("child"), "delegate", (s) => application.delegate(s, ask))).rejects.toThrow("isn't a launcher session");
  await expect(hosted.run(principal, context("root"), "delegate", (s) => application.delegate(s, { ...ask, task: "the root's own" }))).rejects.toThrow("isn't a launcher session");
  const rows = (database.db.query("SELECT actor, target, detail FROM access_log WHERE action = 'delegation.refused' ORDER BY rowid").all() as { actor: string; target: string; detail: string }[])
    .map((r) => ({ ...r, detail: JSON.parse(r.detail) as Record<string, unknown> }));
  expect(rows.map((r) => [r.actor, r.target, r.detail.to, r.detail.child])).toEqual([
    ["you@example.com", "you@example.com/fe", "be", child],
    ["you@example.com", "you@example.com/fe", "be", undefined],
  ]);
  // be declares itself a launcher and goes live: the child's request lands, audited naming it.
  await hosted.whoami(principal, sessionContext(principal, { [OPENCODE_SESSION_META]: "peer", [GRAYBOARD_LAUNCHER_META]: true }));
  await delivery.open(principal, context("peer"));
  const sent = await hosted.run(principal, context("child"), "delegate", (s) => application.delegate(s, { ...ask, task: "now a launcher" }));
  const requested = database.db.query("SELECT actor, target, detail FROM access_log WHERE action = 'delegation.requested'").all() as { actor: string; target: string; detail: string }[];
  expect(requested.map((r) => ({ ...r, detail: JSON.parse(r.detail) }))).toEqual([
    { actor: "you@example.com", target: "you@example.com/be", detail: { requester: "you@example.com/fe", via: "explicit", message_id: sent.message_id, child } },
  ]);
});

test("registration rejects invalid ownership graphs without moving an existing child", async () => {
  await hosted.bind(principal, context("root"), { name: "fe", create: true });
  await hosted.bind(principal, context("other"), { name: "be", create: true });
  await hosted.register(principal, context("root"), "child");
  await expect(hosted.register(principal, context("root"), "root")).rejects.toHaveProperty("code", "invalid_registration");
  await expect(hosted.register(principal, context("child"), "grandchild")).rejects.toHaveProperty("code", "root_is_child");
  await expect(hosted.register(principal, context("root"), "other")).rejects.toHaveProperty("code", "child_bound");
  // The message names when it bound as a date, not a raw epoch, and leaves out an unknown place (#387 item 17).
  await expect(hosted.register(principal, context("root"), "other")).rejects.toThrow(/holds "you@example.com\/be" as its own root \(bound \d{4}-\d\d-\d\dT[^,)]*\);/);
  await expect(hosted.register(principal, context("other"), "child")).rejects.toHaveProperty("code", "child_registered_elsewhere");
  await hosted.register(principal, context("unbound"), "grandchild");
  await expect(hosted.register(principal, context("root"), "unbound")).rejects.toHaveProperty("code", "has_children");
  const rootContext = context("root");
  if (!("id" in rootContext)) throw new Error("fixture context missing");
  await expect(hosted.end(principal, context("child"), rootContext.id)).rejects.toHaveProperty("code", "child_session");
  expect(await hosted.whoami(principal, context("child"))).toMatchObject({ primary: "you@example.com/fe", child: true });
  const foreign = database.repo.users.upsertByEmail("peer@example.com", null);
  const outsider = { ...principal, authed: { user_id: foreign.id, user_email: foreign.email, session_id: 0 } };
  const outsiderContext = sessionContext(outsider, { [OPENCODE_SESSION_META]: "root" });
  expect(await hosted.whoami(outsider, outsiderContext)).toHaveProperty("unbound", true);
  await hosted.bind(outsider, outsiderContext, { name: "fe", create: true });
  expect(await hosted.whoami(principal, context("root"))).toHaveProperty("primary", "you@example.com/fe");
  const wrongClient = { ...principal, clientId: "https://other.example/client.json", sourceKey: null };
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
  expect(hostedRowCount(database.db)).toBe(0);
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
  const sender = new AppSession(application, principal.authed, "sender", { push: false });
  await sender.connect();
  await sender.send("you@example.com/fe", "old mailbox");
  let binding!: ReturnType<typeof hosted.bind>, finished = false;
  const issued = await paused("hosted:pending:in-gate", () => delivery.pending(principal, context("root"), lease.capability), async () => {
    binding = hosted.bind(principal, context("root"), { name: "be", create: true }).then(value => { finished = true; return value; });
    await Promise.resolve(); await Promise.resolve();
    expect(finished).toBe(false);
    expect([...application.holdsByOwner().values()].flat().map(a => a.slice(a.lastIndexOf("/") + 1))).toEqual(["fe"]);
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

test("bind publishes its new hold before the after-commit pause and the first hold's mail still reaches the root", async () => {
  await hosted.bind(principal, context("root"), { name: "fe", create: true });
  const sender = new AppSession(application, principal.authed, "sender", { push: false });
  await sender.connect();
  await paused("hosted:bind:after-commit", () => hosted.bind(principal, context("root"), { name: "be", create: true }), async () => {
    await sender.send("you@example.com/fe", "not for be");
    expect(application.hostedHolder("you@example.com/fe")).toBeDefined();
    expect(application.hostedHolder("you@example.com/be")).toBe(application.hostedHolder("you@example.com/fe"));
  });
  const lease = await delivery.open(principal, context("root"));
  expect(await delivery.pending(principal, context("root"), lease.capability)).toHaveLength(1);
});

test("a hosted contender releases a never-leased hosted owner only after the idle window", async () => {
  // Rehomed from a WSS contender (#282): hello's idle-window release was removed with the socket; hosted.bind keeps it between two hosted roots.
  await hosted.bind(principal, context("root"), { name: "fe", create: true });
  await expect(hosted.bind(principal, context("contender"), { name: "fe" })).rejects.toHaveProperty("code", "alias_held");
  now += 900_001;
  await hosted.bind(principal, context("contender"), { name: "fe" });
  expect(database.repo.hosted.all().map(row => row.session_id)).toEqual([(context("contender") as { id: string }).id]);
});

test("a hosted root holds several names: bind adds, unbind releases one and promotes the oldest, the last leaves it owning but unbound (#451)", async () => {
  const at = (name: string) => `you@example.com/${name}`;
  for (const name of ["fe", "be", "ce"]) await hosted.bind(principal, context("root"), { name, create: true });
  const first = await hosted.whoami(principal, context("root"));
  expect(first).toMatchObject({ held: [at("fe"), at("be"), at("ce")], primary: at("fe") });
  // A repeated bind of a held name adds nothing and doesn't bump the generation.
  expect(await hosted.bind(principal, context("root"), { name: "be" })).toMatchObject({ content: [{ text: 'already bound to "be"' }] });
  const rootId = (context("root") as { id: string }).id, gen = database.repo.hosted.get(rootId)!.bind_gen;
  await hosted.bind(principal, context("root"), { name: "be", where: "laptop" });
  expect(database.repo.hosted.get(rootId)).toMatchObject({ place: "laptop", bind_gen: gen });
  const released = await hosted.unbind(principal, context("root"), { name: "fe" });
  expect(released.content[0]!.text).toContain('Released "fe"');
  expect(released.content[0]!.text).toContain('You now send as "be"');
  expect(await hosted.whoami(principal, context("root"))).toMatchObject({ held: [at("be"), at("ce")], primary: at("be"), ownership: first.ownership });
  expect(await hosted.unbind(principal, context("root"), { name: "fe" })).toMatchObject({ content: [{ text: 'not holding "fe"' }] });
  await hosted.unbind(principal, context("root"), { name: "be" });
  await hosted.unbind(principal, context("root"), { name: "ce" });
  expect(application.holdsByOwner().size).toBe(0);
  const unbound = await hosted.whoami(principal, context("root"));
  expect(unbound).toMatchObject({ held: [], ownership: first.ownership });
  await expect(hosted.run(principal, context("root"), "dm_send", () => true)).rejects.toHaveProperty("code", "unbound");
  // The released names' mail still queues for their next holder.
  expect(database.repo.aliases.find(at("fe"))).toBeDefined();
});

const at = (name: string) => `you@example.com/${name}`;
test("ending a hosted root releases every hold in one transaction and audits each release (#451)", async () => {
  await hosted.bind(principal, context("root"), { name: "fe", create: true });
  await hosted.bind(principal, context("root"), { name: "be", create: true });
  expect(application.holdsByOwner().size).toBe(1);
  await hosted.end(principal, context("root"));
  expect(application.holdsByOwner().size).toBe(0);
  expect(hostedRowCount(database.db)).toBe(0);
  expect(database.db.query("SELECT count(*) AS n FROM alias_holds").get()).toEqual({ n: 0 });
  // Another session can take either name at once.
  await hosted.bind(principal, context("other"), { name: "be", create: false });
  expect(await hosted.whoami(principal, context("other"))).toMatchObject({ primary: at("be") });
});

test("a generic-key poll root's writes_as is recorded, makes it tools-only, and a different later declaration is refused (#451)", async () => {
  const generic: OAuthPrincipal = { ...principal, clientId: "grayboard-pi", sourceKey: GRAYBOARD_SESSION_META };
  const meta = (as: string) => sessionContext(generic, { [GRAYBOARD_SESSION_META]: "poll-root", [GRAYBOARD_WRITES_AS_META]: as });
  await application.hostedWritesAs(generic.authed, "id:probe", "fe", true);
  const first = await hosted.whoami(generic, meta("fe"));
  expect(first).toMatchObject({ held: [], writes_as: "you@example.com/fe" });
  expect(database.repo.hosted.all().map(r => r.writes_as)).toEqual(["you@example.com/fe"]);
  await expect(hosted.whoami(generic, meta("be"))).rejects.toHaveProperty("code", "id_collision");
  // A plain principal's declaration is never read.
  expect(sessionContext(principal, { [OPENCODE_SESSION_META]: "root", [GRAYBOARD_WRITES_AS_META]: "fe" })).not.toHaveProperty("writesAs");
});

test("a refused writes_as declaration through the hosted gate keeps its refused row after the transaction rolls back (#452)", async () => {
  const generic: OAuthPrincipal = { ...principal, clientId: "grayboard-pi", sourceKey: GRAYBOARD_SESSION_META };
  const ctx = sessionContext(generic, { [GRAYBOARD_SESSION_META]: "poll-human", [GRAYBOARD_WRITES_AS_META]: "human" });
  await expect(hosted.whoami(generic, ctx)).rejects.toHaveProperty("code", "forbidden");
  expect(hostedRowCount(database.db)).toBe(0);
  expect(database.db.query("SELECT event FROM binding_events WHERE event = 'refused' AND detail LIKE '%human%'").all()).toHaveLength(1);
});

test("a rate-limited hosted bind keeps its hello.rate_limited row after the transaction rolls back, and the streak's end is written once (#467)", async () => {
  const limited = createApplication(database.repo, database.db, { helloLimit: { burst: 1, perSec: 0.01 }, now: () => now });
  const service = createHostedSessions(limited, { now: () => now, isAuthorized: () => true });
  const rows = (action: string) => (database.db.query("SELECT count(*) AS n FROM access_log WHERE action = ?").get(action) as { n: number }).n;
  try {
    await service.bind(principal, context("root"), { name: "fe", create: true });
    await expect(service.bind(principal, context("root"), { name: "be", create: true })).rejects.toHaveProperty("code", "rate_limited");
    expect(rows("hello.rate_limited")).toBe(1);
    // The bucket refills; the bind that ends the streak commits, so its row is written there and not again.
    now += 200_000;
    await service.bind(principal, context("other"), { name: "ops", create: true });
    expect(rows("hello.rate_limit_ended")).toBe(1);
    expect(service.refusalRowsLost).toBe(0);
  } finally { service.close(); limited.stopExpiry(); }
});

test("a refusal row whose write after the rollback fails is counted, and the refusal is still what the caller sees (#467)", async () => {
  const generic: OAuthPrincipal = { ...principal, clientId: "grayboard-pi", sourceKey: GRAYBOARD_SESSION_META };
  const ctx = sessionContext(generic, { [GRAYBOARD_SESSION_META]: "poll-human", [GRAYBOARD_WRITES_AS_META]: "human" });
  const write = spyOn(application, "hostedRefused").mockImplementation(() => { throw new Error("disk full"); });
  const quiet = spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(hosted.whoami(generic, ctx)).rejects.toHaveProperty("code", "forbidden");
    expect(hosted.refusalRowsLost).toBe(1);
    expect(quiet.mock.calls.some(([line]) => String(line).includes('"operation":"hosted.refusal_row"'))).toBe(true);
  } finally { write.mockRestore(); quiet.mockRestore(); }
});

test("ending a tools-only hosted root frees its alias for other users and restores writes_as when the same ID starts again (#451)", async () => {
  const generic: OAuthPrincipal = { ...principal, clientId: "grayboard-pi", sourceKey: GRAYBOARD_SESSION_META };
  const meta = sessionContext(generic, { [GRAYBOARD_SESSION_META]: "poll-root", [GRAYBOARD_WRITES_AS_META]: "fe" });
  const id = (meta as { id: string }).id;
  await hosted.whoami(generic, meta);
  const used = () => database.db.prepare("SELECT writes_as FROM ids WHERE id = ?").get(id);
  expect(used()).toEqual({ writes_as: "you@example.com/fe" });
  expect(aliasUser(database.db, "you@example.com/fe")).toBe(id);
  await hosted.end(generic, meta);
  expect(used()).toEqual({ writes_as: null });
  expect(aliasUser(database.db, "you@example.com/fe")).toBeNull();
  await hosted.whoami(generic, meta);
  expect(used()).toEqual({ writes_as: "you@example.com/fe" });
  expect(aliasUser(database.db, "you@example.com/fe")).toBe(id);
});

test("revoking one hosted hold releases only it, bumps the generation and closes the lease; the next whoami shows what is left (#451)", async () => {
  const team = database.repo.teams.create("ops", principal.authed.user_id);
  database.repo.teams.addMember(team.id, principal.authed.user_id);
  await hosted.bind(principal, context("root"), { name: "fe", create: true });
  await hosted.bind(principal, context("root"), { name: "ops/lead", create: true });
  const lease = await delivery.open(principal, context("root"));
  const before = database.repo.hosted.get((context("root") as { id: string }).id)!;
  database.repo.teams.removeMember(team.id, principal.authed.user_id);
  application.accessChanged(principal.authed.user_email, "admin@example.com");
  const after = database.repo.hosted.get(before.session_id)!;
  expect(after.bind_gen).toBeGreaterThan(before.bind_gen);
  expect(after.ownership_id).toBe(before.ownership_id);
  expect(delivery.activeLeaseCount).toBe(0); // closed by the revocation itself, before any hosted request could notice
  expect(await hosted.whoami(principal, context("root"))).toMatchObject({ held: ["you@example.com/fe"], primary: "you@example.com/fe", ownership: before.ownership_id });
  expect(database.db.query("SELECT count(*) AS n FROM access_log WHERE action = 'alias.revoked'").get()).toEqual({ n: 1 });
  await expect(delivery.receipt(principal, context("root"), lease.capability, [])).rejects.toHaveProperty("code", "not_found");
});

test("a revoked tools-only hosted root's ownership ends, audited once: a later recheck finds nothing to revoke again (#454)", async () => {
  const team = database.repo.teams.create("ops", principal.authed.user_id);
  database.repo.teams.addMember(team.id, principal.authed.user_id);
  const generic: OAuthPrincipal = { ...principal, clientId: "grayboard-pi", sourceKey: GRAYBOARD_SESSION_META };
  const meta = sessionContext(generic, { [GRAYBOARD_SESSION_META]: "poll-root", [GRAYBOARD_WRITES_AS_META]: "ops/lead" });
  const id = (meta as { id: string }).id;
  await application.hostedWritesAs(generic.authed, "id:probe", "ops/lead", true);
  expect(await hosted.whoami(generic, meta)).toMatchObject({ held: [], writes_as: "ops/lead" });
  const before = database.repo.hosted.get(id)!;
  const audits = () => database.db.query("SELECT actor, target, detail FROM access_log WHERE action = 'alias.revoked'").all().map((r: any) => ({ ...r, detail: JSON.parse(r.detail) }));
  database.repo.teams.removeMember(team.id, principal.authed.user_id);
  application.accessChanged(principal.authed.user_email, "admin@example.com");
  const revoked = [{ actor: "admin@example.com", target: "ops/lead", detail: { session: id, principal: "you@example.com", writes_as: true, reason: expect.any(String) } }];
  expect(audits()).toEqual(revoked);
  expect(database.repo.hosted.get(id)).toBeUndefined();
  expect(database.db.query("SELECT ended_at, end_reason FROM hosted_ownerships WHERE id = ?").get(before.ownership_id)).toMatchObject({ end_reason: "revoked" });
  expect(database.db.query("SELECT writes_as FROM ids WHERE id = ?").get(id)).toEqual({ writes_as: null });
  expect(aliasUser(database.db, "ops/lead")).toBeNull();
  // Both rechecks, the principal's and the server's sweep, find the use gone.
  application.accessChanged(principal.authed.user_email, "admin@example.com");
  application.revalidate();
  expect(audits()).toEqual(revoked);
});

test("a hosted root holding two names sends as either with as:, its ID too, and is refused any other address (#454)", async () => {
  await hosted.bind(principal, context("root"), { name: "fe", create: true });
  await hosted.bind(principal, context("root"), { name: "be", create: true });
  await hosted.bind(principal, context("peer"), { name: "peer", create: true });
  const id = (context("root") as { id: string }).id;
  const send = (as: string | undefined, body: string) => hosted.run(principal, context("root"), "dm_send", s => application.send(s, "peer", body, as === undefined ? {} : { as }));
  await send(undefined, "primary");
  await send("be", "second");
  await send("you@example.com/fe", "full");
  await send(id, "by id");
  const senders = database.db.query("SELECT body, sender FROM messages WHERE body IN ('primary', 'second', 'full', 'by id') ORDER BY id").all();
  expect(senders).toEqual([
    { body: "primary", sender: "you@example.com/fe" },
    { body: "second", sender: "you@example.com/be" },
    { body: "full", sender: "you@example.com/fe" },
    { body: "by id", sender: id },
  ]);
  for (const other of ["peer", "you@example.com/qa"]) {
    await expect(send(other, "refused")).rejects.toMatchObject({ code: "bad_request", message: expect.stringContaining("isn't one of this session's addresses") });
  }
  expect(database.db.query("SELECT count(*) AS n FROM messages WHERE body = 'refused'").get()).toEqual({ n: 0 });
});

test("a root whose last hold is revoked or unbound has no lease, so the sweep leaves it owning instead of expiring it (#451)", async () => {
  const team = database.repo.teams.create("ops", principal.authed.user_id);
  database.repo.teams.addMember(team.id, principal.authed.user_id);
  const id = (raw: string) => (context(raw) as { id: string }).id;
  await hosted.bind(principal, context("revoked"), { name: "ops/lead", create: true });
  await delivery.open(principal, context("revoked"));
  await hosted.bind(principal, context("unbound"), { name: "fe", create: true });
  await delivery.open(principal, context("unbound"));
  await hosted.unbind(principal, context("unbound"), { name: "fe" });
  database.repo.teams.removeMember(team.id, principal.authed.user_id);
  application.accessChanged(principal.authed.user_email, "admin@example.com");
  expect(delivery.activeLeaseCount).toBe(0);
  for (const raw of ["revoked", "unbound"]) expect(database.repo.hosted.get(id(raw))).toMatchObject({ lease_deadline: null });
  now += 300_000; // past any lease, short of the idle window
  hosted.sweep();
  for (const raw of ["revoked", "unbound"]) expect(database.repo.hosted.get(id(raw))).toBeDefined();
});

test("a request's model and effort are the session's latest: registered, updated on a change, never cleared by absence, restated by a new ownership, audited (#364)", async () => {
  const generic: OAuthPrincipal = { ...principal, clientId: "grayboard-pi", sourceKey: GRAYBOARD_SESSION_META };
  const ctx = (extra: Record<string, unknown> = {}) => sessionContext(generic, { [GRAYBOARD_SESSION_META]: "facts-root", ...extra });
  const id = (ctx() as { id: string }).id;
  const facts = () => database.db.prepare("SELECT model, effort FROM ids WHERE id = ?").get(id);
  const changes = () => database.db.query<{ detail: string }, []>("SELECT detail FROM access_log WHERE action = 'id.facts_changed'").all().map(r => JSON.parse(r.detail));
  await hosted.whoami(generic, ctx({ [GRAYBOARD_MODEL_META]: "claude-opus-5-5", [GRAYBOARD_EFFORT_META]: "high" }));
  expect(facts()).toEqual({ model: "claude-opus-5-5", effort: "high" });
  // No facts, or one of them: the other keeps its value.
  await hosted.whoami(generic, ctx());
  await hosted.whoami(generic, ctx({ [GRAYBOARD_MODEL_META]: "claude-sonnet-5-5" }));
  expect(facts()).toEqual({ model: "claude-sonnet-5-5", effort: "high" });
  // An unchanged value writes nothing to audit; a change records before and after.
  await hosted.whoami(generic, ctx({ [GRAYBOARD_MODEL_META]: "claude-sonnet-5-5" }));
  expect(changes()).toMatchObject([
    { before: { model: "claude-opus-5-5", effort: "high" }, after: { model: "claude-sonnet-5-5", effort: "high" }, why: "request" },
  ]);
  // A new ownership of the same ID reports its own: the last one's model is stale. Audited like a request's change.
  await hosted.end(generic, ctx());
  await hosted.whoami(generic, ctx());
  expect(facts()).toEqual({ model: null, effort: null });
  await hosted.end(generic, ctx());
  await hosted.whoami(generic, ctx({ [GRAYBOARD_MODEL_META]: "claude-haiku-5-5" }));
  expect(facts()).toEqual({ model: "claude-haiku-5-5", effort: null });
  expect(changes().slice(1)).toEqual([
    { before: { model: "claude-sonnet-5-5", effort: "high" }, after: { model: null, effort: null }, why: "ownership" },
    { before: { model: null, effort: null }, after: { model: "claude-haiku-5-5", effort: null }, why: "ownership" },
  ]);
});

test("an empty model or effort clears the stored one, audited once; an absent key keeps it; a first request or a new ownership with one stores none (#558)", async () => {
  const generic: OAuthPrincipal = { ...principal, clientId: "grayboard-pi", sourceKey: GRAYBOARD_SESSION_META };
  const ctx = (extra: Record<string, unknown> = {}) => sessionContext(generic, { [GRAYBOARD_SESSION_META]: "facts-clear", ...extra });
  const id = (ctx() as { id: string }).id;
  const facts = () => database.db.prepare("SELECT model, effort FROM ids WHERE id = ?").get(id);
  const audit = (action: string) => database.db.query<{ detail: string }, [string, string]>("SELECT detail FROM access_log WHERE action = ? AND target = ?").all(action, id).map(r => JSON.parse(r.detail));
  // A first request's empty effort registers none, with no change row.
  await hosted.whoami(generic, ctx({ [GRAYBOARD_MODEL_META]: "claude-opus-5-5", [GRAYBOARD_EFFORT_META]: "" }));
  expect(facts()).toEqual({ model: "claude-opus-5-5", effort: null });
  expect(audit("id.registered")).toEqual([{ harness: expect.any(String), model: "claude-opus-5-5" }]);
  expect(audit("id.facts_changed")).toEqual([]);
  await hosted.whoami(generic, ctx({ [GRAYBOARD_EFFORT_META]: "high" }));
  // Absent keeps it; empty clears it, once.
  await hosted.whoami(generic, ctx());
  expect(facts()).toEqual({ model: "claude-opus-5-5", effort: "high" });
  await hosted.whoami(generic, ctx({ [GRAYBOARD_EFFORT_META]: "" }));
  expect(facts()).toEqual({ model: "claude-opus-5-5", effort: null });
  await hosted.whoami(generic, ctx({ [GRAYBOARD_EFFORT_META]: "" }));
  expect(audit("id.facts_changed")).toEqual([
    { before: { model: "claude-opus-5-5", effort: null }, after: { model: "claude-opus-5-5", effort: "high" }, why: "request" },
    { before: { model: "claude-opus-5-5", effort: "high" }, after: { model: "claude-opus-5-5", effort: null }, why: "request" },
  ]);
  // A new ownership's first request with an empty model stores none.
  await hosted.end(generic, ctx());
  await hosted.whoami(generic, ctx({ [GRAYBOARD_MODEL_META]: "", [GRAYBOARD_EFFORT_META]: "low" }));
  expect(facts()).toEqual({ model: null, effort: "low" });
  expect(audit("id.facts_changed").at(-1)).toEqual({ before: { model: "claude-opus-5-5", effort: null }, after: { model: null, effort: "low" }, why: "ownership" });
  // A legacy replay never carries a clear.
  expect(withoutFacts({ [GRAYBOARD_SESSION_META]: "r", [GRAYBOARD_EFFORT_META]: "" })).toEqual({ [GRAYBOARD_SESSION_META]: "r" });
});

test("a model or effort that isn't a string is refused, an empty one is a clear, and format characters and length are cut when stored (#364)", async () => {
  const generic: OAuthPrincipal = { ...principal, clientId: "grayboard-pi", sourceKey: GRAYBOARD_SESSION_META };
  const meta = (extra: Record<string, unknown>) => ({ [GRAYBOARD_SESSION_META]: "facts-bad", ...extra });
  expect(() => sessionContext(generic, meta({ [GRAYBOARD_MODEL_META]: 5 }))).toThrow(`_meta["${GRAYBOARD_MODEL_META}"] must be a string`);
  // An empty one is a clear (#558), kept so the server can tell it from an absent key.
  expect(sessionContext(generic, meta({ [GRAYBOARD_MODEL_META]: "" }))).toMatchObject({ facts: { model: "" } });
  // Any client's facts are read, not only a generic key's.
  expect(sessionContext(principal, { [OPENCODE_SESSION_META]: "root", [GRAYBOARD_EFFORT_META]: "low" })).toMatchObject({ facts: { effort: "low" } });
  const ctx = sessionContext(generic, meta({ [GRAYBOARD_MODEL_META]: `a\u202eb\u2066c\u200e\u200b\n${"x".repeat(200)}` }));
  await hosted.whoami(generic, ctx);
  const stored = (database.db.prepare("SELECT model FROM ids WHERE id = ?").get((ctx as { id: string }).id) as { model: string }).model;
  expect(stored).toMatch(/^abc x+$/);
  expect(stored.length).toBe(64);
});

test("cleanFact drops format characters before folding the line, and stores NFC, so match compares what a reader sees (#364)", () => {
  expect(cleanFact("a \u202e b")).toBe("a b");
  expect(cleanFact("x\u200fy\u061c\ufeff")).toBe("xy");
  expect(cleanFact("e\u0301")).toBe("\u00e9");
  expect(cleanFact("\u200b")).toBeNull();
});

test("a root's suggested name is its first request's, offered first among its unbound candidates while free, refused when not a string, and no suggestion when not an identity name (#443)", async () => {
  const ctx = (raw: string, suggested?: unknown) => sessionContext(principal, { [OPENCODE_SESSION_META]: raw, ...(suggested === undefined ? {} : { [GRAYBOARD_SUGGESTED_META]: suggested }) });
  await hosted.bind(principal, ctx("other"), { name: "older", create: true });
  await hosted.unbind(principal, ctx("other"), { name: "older" });
  const first = await hosted.whoami(principal, ctx("root", "Grayboard-GB-Aux"));
  expect(first.candidates).toEqual([{ name: "grayboard-gb-aux", queued: 0, claims: 0, where: null, fresh: true, suggested: true }, expect.objectContaining({ name: "older" })]);
  // Fixed for the root's life: a later request's suggestion, or none, changes nothing.
  expect((await hosted.whoami(principal, ctx("root", "elsewhere"))).candidates?.[0]).toMatchObject({ name: "grayboard-gb-aux", suggested: true });
  expect((await hosted.whoami(principal, ctx("root"))).candidates?.[0]).toMatchObject({ name: "grayboard-gb-aux", suggested: true });
  expect(database.repo.hosted.get((ctx("root") as { id: string }).id)).toMatchObject({ suggested: "grayboard-gb-aux" });
  // After an unbind the instructions offer it again; while another session holds it, it isn't offered.
  await hosted.bind(principal, ctx("root"), { name: "fe", create: true });
  const released = await hosted.unbind(principal, ctx("root"), { name: "fe" });
  expect(released.content[0]!.text).toContain("grayboard-gb-aux (this checkout's default: ");
  await hosted.bind(principal, ctx("other"), { name: "grayboard-gb-aux", create: true });
  expect((await hosted.whoami(principal, ctx("root"))).candidates?.map(c => c.name)).not.toContain("grayboard-gb-aux");
  expect(() => ctx("root", 5)).toThrow(`_meta["${GRAYBOARD_SUGGESTED_META}"] must be a string`);
  for (const bad of ["", "a/b", "human", "x".repeat(33)]) expect(ctx("root", bad)).not.toHaveProperty("suggested");
  // The ownership's start audit records its suggestion (#522), so the trail says why a session was offered a name.
  const id = (ctx("root") as { id: string }).id;
  const started = () => database.db.query<{ detail: string }, [string]>("SELECT detail FROM access_log WHERE action = 'hosted.ownership_started' AND target = ? ORDER BY rowid").all(id).map(r => JSON.parse(r.detail) as { suggested?: string });
  expect(started().map(d => d.suggested)).toEqual(["grayboard-gb-aux"]);
  // A new ownership of the same source ID takes its own suggestion, and one with none records none.
  await hosted.end(principal, ctx("root"));
  await hosted.whoami(principal, ctx("root", "second"));
  expect(database.repo.hosted.get(id)).toMatchObject({ suggested: "second" });
  await hosted.end(principal, ctx("root"));
  await hosted.whoami(principal, ctx("root"));
  expect(database.repo.hosted.get(id)).toMatchObject({ suggested: null });
  expect(started().map(d => d.suggested)).toEqual(["grayboard-gb-aux", "second", undefined]);
  // A child row's is null, whatever its requests suggest: a child never binds.
  await hosted.register(principal, ctx("root"), "suggest-child");
  const child = ctx("suggest-child", "kid");
  await hosted.whoami(principal, child);
  expect(database.repo.hosted.get((child as { id: string }).id)).toMatchObject({ suggested: null, root_session_id: id });
});

test("a request's launcher declaration is the ownership's: set by any root request and audited once, restated by a new ownership, cleared and audited at its end, ignored on session_end and for a child, refused unless a boolean (#473, #520, #532)", async () => {
  const generic: OAuthPrincipal = { ...principal, clientId: "grayboard-pi", sourceKey: GRAYBOARD_SESSION_META };
  const ctx = (extra: Record<string, unknown> = {}) => sessionContext(generic, { [GRAYBOARD_SESSION_META]: "launcher-root", ...extra });
  const id = (ctx() as { id: string }).id;
  const flag = () => (database.db.prepare("SELECT launcher FROM ids WHERE id = ?").get(id) as { launcher: number }).launcher;
  const audited = () => database.db.query<{ target: string; detail: string }, []>("SELECT target, detail FROM access_log WHERE action = 'handle.launcher_set' ORDER BY id").all();
  const trail = () => audited().map(a => (JSON.parse(a.detail) as { on: boolean }).on);
  expect(() => sessionContext(generic, { [GRAYBOARD_SESSION_META]: "x", [GRAYBOARD_LAUNCHER_META]: "yes" })).toThrow(`_meta["${GRAYBOARD_LAUNCHER_META}"] must be a boolean`);
  expect(ctx({ [GRAYBOARD_LAUNCHER_META]: false })).not.toHaveProperty("launcher");
  // A built-in client's declaration is read, whatever its source key; a third-party client's never is.
  expect(sessionContext(principal, { [OPENCODE_SESSION_META]: "root", [GRAYBOARD_LAUNCHER_META]: true })).toMatchObject({ launcher: true });
  expect(sessionContext({ ...generic, clientId: "third-party" }, { [GRAYBOARD_SESSION_META]: "x", [GRAYBOARD_LAUNCHER_META]: true })).not.toHaveProperty("launcher");
  // A tools-only root can't receive pushes, so its declaration is ignored.
  const toolsOnly = ctx({ [GRAYBOARD_LAUNCHER_META]: true, [GRAYBOARD_WRITES_AS_META]: "scribe" });
  await hosted.whoami(generic, toolsOnly);
  expect(flag()).toBe(0);
  await hosted.end(generic, toolsOnly);
  await hosted.bind(generic, ctx({ [GRAYBOARD_LAUNCHER_META]: true }), { name: "lead", create: true });
  expect(flag()).toBe(1);
  expect(audited().map(a => ({ target: a.target, ...JSON.parse(a.detail) }))).toEqual([{ target: id, on: true, ownership: expect.any(Number), client_id: "grayboard-pi" }]);
  // The ownership's end clears it, audited `on: false` under the session with the user as actor (#532); a new
  // ownership that declares nothing isn't one, and one that declares restates it.
  await hosted.end(generic, ctx());
  expect(flag()).toBe(0);
  const cleared = database.db.query<{ actor: string; target: string; detail: string }, []>("SELECT actor, target, detail FROM access_log WHERE action = 'handle.launcher_set' ORDER BY rowid DESC LIMIT 1").get()!;
  expect({ actor: cleared.actor, target: cleared.target, ...JSON.parse(cleared.detail) }).toEqual({ actor: principal.authed.user_email, target: id, on: false, ownership: expect.any(Number), reason: "closed", client_id: "grayboard-pi" });
  await hosted.whoami(generic, ctx());
  expect(flag()).toBe(0);
  // An ownership that was never a launcher ends with no row.
  await hosted.end(generic, ctx());
  expect(trail()).toEqual([true, false]);
  await hosted.whoami(generic, ctx({ [GRAYBOARD_LAUNCHER_META]: true }));
  expect(flag()).toBe(1);
  expect(trail()).toEqual([true, false, true]);
  // A later request of the ownership turns it on (#520: OpenCode's native client starts the ownership without the
  // plugin's `_meta`), audited once; a repeat, or a request that declares nothing, changes nothing.
  await hosted.end(generic, ctx());
  await hosted.whoami(generic, ctx());
  expect(flag()).toBe(0);
  // session_end's declaration doesn't count (#532): it would set the flag only for the end to clear it, leaving a
  // `true, false` pair for a launcher that never was one.
  await hosted.end(generic, ctx({ [GRAYBOARD_LAUNCHER_META]: true }));
  expect(flag()).toBe(0);
  expect(trail()).toEqual([true, false, true, false]);
  await hosted.whoami(generic, ctx());
  await hosted.whoami(generic, ctx({ [GRAYBOARD_LAUNCHER_META]: true }));
  await hosted.whoami(generic, ctx({ [GRAYBOARD_LAUNCHER_META]: true }));
  await hosted.whoami(generic, ctx());
  expect(flag()).toBe(1);
  expect(trail()).toEqual([true, false, true, false, true]);
  // A child's declaration is ignored: the root launches, not its subagent.
  await hosted.register(generic, ctx(), "launcher-child");
  const child = sessionContext(generic, { [GRAYBOARD_SESSION_META]: "launcher-child", [GRAYBOARD_LAUNCHER_META]: true });
  await hosted.whoami(generic, child);
  expect((database.db.prepare("SELECT launcher FROM ids WHERE id = ?").get((child as { id: string }).id) as { launcher: number }).launcher).toBe(0);
  expect(audited()).toHaveLength(5);
});

test("a declared launcher is a delegation target, and only its own session's initialize and bind text carry the launcher instruction (#473)", async () => {
  const generic: OAuthPrincipal = { ...principal, clientId: "grayboard-pi", sourceKey: GRAYBOARD_SESSION_META };
  const ctx = (raw: string, extra: Record<string, unknown> = {}) => sessionContext(generic, { [GRAYBOARD_SESSION_META]: raw, ...extra });
  const bound = await hosted.bind(generic, ctx("lead-root", { [GRAYBOARD_LAUNCHER_META]: true }), { name: "lead", create: true });
  const plain = await hosted.bind(generic, ctx("plain-root"), { name: "plain", create: true });
  // A launcher is a target while its delivery is live.
  await delivery.open(generic, ctx("lead-root", { [GRAYBOARD_LAUNCHER_META]: true }));
  await delivery.open(generic, ctx("plain-root"));
  const instructions = (r: { structuredContent?: unknown }) => ((r.structuredContent as { instructions: string[] }).instructions).join(" ");
  expect(instructions(bound)).toContain("You're a launcher session");
  expect(instructions(plain)).not.toContain("You're a launcher session");
  const info = { identity_full: "you@example.com/lead", teams: [], human: { linked: false } } as never;
  expect(hostedBoundInstruction(info, undefined, true)).toContain("You're a launcher session");
  expect(hostedBoundInstruction(info)).not.toContain("You're a launcher session");
  // The requester is a third session of the same user: the declared launcher takes the request, the other is not a target.
  await hosted.bind(generic, ctx("req-root"), { name: "req", create: true });
  const result = await hosted.run(generic, ctx("req-root"), "delegate", session => application.delegate(session, { persona: "researcher", task: "inspect it" }));
  expect(result).toMatchObject({ to: "you@example.com/lead" });
  await expect(hosted.run(generic, ctx("req-root"), "delegate", session => application.delegate(session, { persona: "researcher", task: "inspect it", to: "plain" }))).rejects.toThrow("isn't a launcher session");
  // The text follows the stored flag, not the later request: a restart without the declaration still gets the rule.
  const later = await hosted.bind(generic, ctx("lead-root"), { name: "lead2", create: true });
  expect(instructions(later)).toContain("You're a launcher session");
  // Unbind's text follows the same flag (#521 item 7): the launcher keeps the sentence under its remaining name, the plain session never gets it.
  expect(instructions(await hosted.unbind(generic, ctx("lead-root"), { name: "lead" }))).toContain("You're a launcher session");
  await hosted.bind(generic, ctx("plain-root"), { name: "plain2", create: true });
  const plainUnbound = await hosted.unbind(generic, ctx("plain-root"), { name: "plain" });
  expect(instructions(plainUnbound)).toContain('"plain2"');
  expect(instructions(plainUnbound)).not.toContain("You're a launcher session");
});

test("a bound session with no delivery declaration (OpenCode) gets initialize text that follows its lease, as bind's does; a declaration still decides (#531)", () => {
  const info = { identity_full: "you@example.com/fe", teams: [], human: { linked: false } } as never;
  const channel = `<channel source="${DEFAULT_CHANNEL_SOURCE}"`;
  const note = `No delivery lease is open for this session, so DMs to "you@example.com/fe" wait until the client opens one (delivery_open).`;
  // Lease open: pushed, with the default source, and no poll or lease note.
  const leased = hostedBoundInstruction(info, undefined, false, true);
  expect(leased).toContain(channel);
  for (const line of ["Poll dm_inbox", "delivery_open", "You're a launcher session"]) expect(leased).not.toContain(line);
  // No lease: it polls, and says why nothing is pushed yet.
  const unleased = hostedBoundInstruction(info);
  expect(unleased).toContain("Poll dm_inbox");
  expect(unleased).toContain(note);
  expect(unleased).not.toContain("<channel");
  // The launcher lines ride either, only with the flag.
  for (const leaseOpen of [false, true]) expect(hostedBoundInstruction(info, undefined, true, leaseOpen)).toContain("You're a launcher session");
  // A declaration outranks the lease.
  const poll = hostedBoundInstruction(info, { mode: "poll", source: "x" }, false, true);
  expect(poll).not.toContain("<channel");
  expect(poll).not.toContain("delivery_open");
  expect(hostedBoundInstruction(info, { mode: "push", source: "pi" }, false, false)).toContain(`<channel source="pi"`);
});

// #566: hosted child rows are parked once idle past the window, so a long-lived root's finished subagents stop
// counting against its child capacity, and a parked child's next request makes it active under the same root.
const childAudits = (action: string) => database.db.query<{ target: string; detail: string }, [string]>("SELECT target, detail FROM access_log WHERE action = ? ORDER BY id").all(action).map(r => ({ target: r.target, ...JSON.parse(r.detail) }));
const hostedId = (raw: string) => { const c = context(raw); if (!("id" in c)) throw new Error("fixture context"); return c.id; };

test("the sweep parks children idle past the window, audited; parked children free the root's capacity (#566)", async () => {
  await hosted.bind(principal, context("root"), { name: "be", create: true });
  for (let i = 0; i < hosted.limits.children; i++) await hosted.register(principal, context("root"), `child-${i}`);
  await expect(hosted.register(principal, context("root"), "overflow")).rejects.toHaveProperty("code", "bad_request");
  now += 900_001; hosted.sweep();
  const parked = childAudits("hosted.child_parked");
  expect(parked).toHaveLength(hosted.limits.children);
  expect(parked.every(a => a.target === hostedId("root") && a.idle_ms > 900_000)).toBe(true);
  expect(database.repo.hosted.all().filter(r => r.root_session_id)).toHaveLength(0);
  expect(database.repo.hosted.children(hostedId("root"))).toHaveLength(hosted.limits.children);
  await hosted.register(principal, context("root"), "overflow");
  expect(database.repo.hosted.get(hostedId("overflow"))?.parked_at).toBeNull();
  expect(await hosted.whoami(principal, context("root"))).toHaveProperty("primary", "you@example.com/be");
});

test("a parked child's next call runs as its root's child under the same ownership, audited (#566)", async () => {
  await hosted.bind(principal, context("root"), { name: "be", create: true });
  await hosted.register(principal, context("root"), "child");
  const ownerships = () => database.db.query<{ n: number }, []>("SELECT count(*) AS n FROM hosted_ownerships").get()!.n;
  const before = ownerships();
  now += 900_001; hosted.sweep();
  expect(database.repo.hosted.get(hostedId("child"))?.parked_at).not.toBeNull();
  await hosted.run(principal, context("child"), "dm_send", session => application.send(session, "be", "after parking"));
  expect(database.db.query("SELECT sender_id FROM messages WHERE body='after parking'").get()).toEqual({ sender_id: hostedId("child") });
  const row = database.repo.hosted.get(hostedId("child"))!;
  expect(row).toMatchObject({ parked_at: null, root_session_id: hostedId("root"), last_seen_at: now });
  expect(ownerships()).toBe(before);
  expect(childAudits("hosted.child_unparked")).toEqual([expect.objectContaining({ target: hostedId("root"), child: hostedId("child"), parked_ms: 0 })]);
  expect(await hosted.whoami(principal, context("child"))).toHaveProperty("child", true);
});

test("register of an existing child moves the child's last_seen_at; of a parked one unparks it (#566)", async () => {
  await hosted.bind(principal, context("root"), { name: "be", create: true });
  await hosted.register(principal, context("root"), "child");
  now += 600_000;
  expect(await hosted.register(principal, context("root"), "child")).toEqual({ message: "already registered" });
  expect(database.repo.hosted.get(hostedId("child"))?.last_seen_at).toBe(now);
  now += 600_000; hosted.sweep();
  expect(database.repo.hosted.get(hostedId("child"))?.parked_at).toBeNull();
  now += 900_001; hosted.sweep();
  expect(database.repo.hosted.get(hostedId("child"))?.parked_at).not.toBeNull();
  expect(await hosted.register(principal, context("root"), "child")).toEqual({ message: "already registered" });
  expect(database.repo.hosted.get(hostedId("child"))).toMatchObject({ parked_at: null, last_seen_at: now });
  expect(childAudits("hosted.child_unparked")).toHaveLength(1);
});

test("an unpark at full child capacity is refused and leaves the child parked; its session_end still ends it (#566)", async () => {
  await hosted.bind(principal, context("root"), { name: "be", create: true });
  await hosted.register(principal, context("root"), "sleeper");
  now += 900_001; hosted.sweep();
  for (let i = 0; i < hosted.limits.children; i++) await hosted.register(principal, context("root"), `child-${i}`);
  await expect(hosted.whoami(principal, context("sleeper"))).rejects.toHaveProperty("code", "bad_request");
  expect(database.repo.hosted.get(hostedId("sleeper"))?.parked_at).not.toBeNull();
  expect(childAudits("hosted.child_unparked")).toHaveLength(0);
  expect(await hosted.end(principal, context("sleeper"))).toEqual({ ended: true });
  expect(database.repo.hosted.get(hostedId("sleeper"))).toBeUndefined();
  expect(database.repo.hosted.children(hostedId("root"))).toHaveLength(hosted.limits.children);
});

test("a parked child goes with its root's ownership; it and an ended child start as roots when they call again (#566)", async () => {
  await hosted.bind(principal, context("root"), { name: "be", create: true });
  await hosted.register(principal, context("root"), "parked");
  await hosted.register(principal, context("root"), "ended");
  await hosted.end(principal, context("ended"));
  now += 900_001; hosted.sweep();
  await hosted.end(principal, context("root"));
  expect(database.repo.hosted.get(hostedId("parked"))).toBeUndefined();
  for (const raw of ["parked", "ended"]) {
    expect(await hosted.whoami(principal, context(raw))).toHaveProperty("unbound", true);
    expect(database.repo.hosted.get(hostedId(raw))).toMatchObject({ root_session_id: null, parked_at: null });
  }
});

test("a root that holds parked children can't become a child (#566)", async () => {
  await hosted.register(principal, context("middle"), "leaf");
  now += 600_000; await hosted.whoami(principal, context("middle"));
  now += 300_001; hosted.sweep();
  expect(database.repo.hosted.get(hostedId("leaf"))?.parked_at).not.toBeNull();
  await expect(hosted.register(principal, context("top"), "middle")).rejects.toHaveProperty("code", "has_children");
});

test("after an outage past the window the startup sweep parks children; each returning one unparks once (#566 audit 2)", async () => {
  await hosted.bind(principal, context("root"), { name: "be", create: true });
  await hosted.register(principal, context("root"), "child");
  hosted.close();
  now += 900_001;
  hosted = createHostedSessions(application, { now: () => now, isAuthorized: () => authorized });
  expect(database.repo.hosted.get(hostedId("child"))?.parked_at).toBe(now);
  expect(childAudits("hosted.child_parked")).toHaveLength(1);
  expect(await hosted.whoami(principal, context("child"))).toHaveProperty("child", true);
  expect(await hosted.whoami(principal, context("child"))).toHaveProperty("child", true);
  expect(childAudits("hosted.child_unparked")).toHaveLength(1);
  expect(await hosted.whoami(principal, context("root"))).toHaveProperty("primary", "you@example.com/be");
});

// #584: the parked ceiling, one child-capacity refusal text, and no idle end or park while a call runs.
test("past the parked ceiling the sweep evicts a root's oldest parked children, audited; an evicted one returns as a root (#584)", async () => {
  hosted.limits.parked = 2;
  await hosted.bind(principal, context("root"), { name: "be", create: true });
  for (const raw of ["first", "second"]) { await hosted.register(principal, context("root"), raw); now += 1000; }
  now += 900_001; hosted.sweep();
  expect(database.repo.hosted.children(hostedId("root")).filter(r => r.parked_at !== null)).toHaveLength(2);
  await hosted.register(principal, context("root"), "third");
  now += 900_001; hosted.sweep();
  expect(database.repo.hosted.get(hostedId("first"))).toBeUndefined();
  expect(database.repo.hosted.children(hostedId("root")).map(r => r.session_id).sort()).toEqual([hostedId("second"), hostedId("third")].sort());
  expect(childAudits("hosted.child_parked").map(a => a.child)).toEqual([hostedId("first"), hostedId("second"), hostedId("third")]);
  expect(childAudits("hosted.child_released")).toEqual([expect.objectContaining({ target: hostedId("root"), child: hostedId("first"), reason: "evicted" })]);
  expect(await hosted.whoami(principal, context("first"))).toHaveProperty("unbound", true);
  expect(database.repo.hosted.get(hostedId("first"))).toMatchObject({ root_session_id: null, parked_at: null });
});

test("children parked in one sweep past the ceiling are evicted by last activity, then ID (#584)", async () => {
  hosted.limits.parked = 1;
  await hosted.bind(principal, context("root"), { name: "be", create: true });
  for (const raw of ["c", "a", "b"]) await hosted.register(principal, context("root"), raw);
  now += 1000; await hosted.whoami(principal, context("c"));
  now += 900_001; hosted.sweep();
  expect(database.repo.hosted.children(hostedId("root")).map(r => r.session_id)).toEqual([hostedId("c")]);
  const evicted = childAudits("hosted.child_released").map(a => a.child);
  expect(evicted).toEqual([hostedId("a"), hostedId("b")].sort());
  // Parked and evicted in one sweep: both audits.
  expect(childAudits("hosted.child_parked").map(a => a.child).sort()).toEqual([hostedId("a"), hostedId("b"), hostedId("c")].sort());
});

test("a refused unpark, new register and convert each say local mode's child-capacity text (#584)", async () => {
  await hosted.bind(principal, context("root"), { name: "be", create: true });
  await hosted.register(principal, context("root"), "sleeper");
  now += 900_001; hosted.sweep();
  await hosted.whoami(principal, context("loose"));
  for (let i = 0; i < hosted.limits.children; i++) await hosted.register(principal, context("root"), `child-${i}`);
  const text = childCapacity(hostedId("root"));
  await expect(hosted.whoami(principal, context("sleeper"))).rejects.toMatchObject({ code: "bad_request", message: text });
  await expect(hosted.register(principal, context("root"), "overflow")).rejects.toMatchObject({ code: "bad_request", message: text });
  await expect(hosted.register(principal, context("root"), "loose")).rejects.toMatchObject({ code: "bad_request", message: text });
});

const toolsOnly = () => {
  const generic: OAuthPrincipal = { ...principal, clientId: "grayboard-pi", sourceKey: GRAYBOARD_SESSION_META };
  return { generic, meta: (raw: string, as?: string) => sessionContext(generic, as ? { [GRAYBOARD_SESSION_META]: raw, [GRAYBOARD_WRITES_AS_META]: as } : { [GRAYBOARD_SESSION_META]: raw }) };
};
const rowOf = (c: ReturnType<typeof context>) => { if (!("id" in c)) throw new Error("fixture context"); return database.repo.hosted.get(c.id); };

test("a child's call past the idle window neither parks it nor ends its unheld root; the window restarts at the call's end (#584)", async () => {
  const { generic, meta } = toolsOnly();
  await application.hostedWritesAs(generic.authed, "id:probe", "fe", true);
  await hosted.whoami(generic, meta("root", "fe"));
  await hosted.register(generic, meta("root", "fe"), "kid");
  const during = await hosted.transfer(generic, meta("kid"), async () => {
    now += 900_001; hosted.sweep();
    return { kid: rowOf(meta("kid"))?.parked_at, root: rowOf(meta("root", "fe")) !== undefined };
  });
  expect(during).toEqual({ kid: null, root: true });
  expect(rowOf(meta("kid"))?.last_seen_at).toBe(now);
  expect(rowOf(meta("root", "fe"))?.last_seen_at).toBe(now);
  now += 600_000; hosted.sweep();
  expect(rowOf(meta("kid"))?.parked_at).toBeNull();
  expect(childAudits("hosted.child_parked")).toHaveLength(0);
  expect(hosted.inflightCount).toBe(0);
});

test("an unheld root's own call past the idle window doesn't end it (#584)", async () => {
  const { generic, meta } = toolsOnly();
  await application.hostedWritesAs(generic.authed, "id:probe", "fe", true);
  await hosted.whoami(generic, meta("root", "fe"));
  const alive = await hosted.transfer(generic, meta("root", "fe"), async () => { now += 900_001; hosted.sweep(); return rowOf(meta("root", "fe")) !== undefined; });
  expect(alive).toBe(true);
  expect(rowOf(meta("root", "fe"))?.last_seen_at).toBe(now);
});

test("a bind of a name whose holder is mid-call past the idle window doesn't end the holder (#584)", async () => {
  await hosted.bind(principal, context("root"), { name: "be", create: true });
  const taken = await hosted.transfer(principal, context("root"), async () => {
    now += 900_001;
    return hosted.bind(principal, context("other"), { name: "be", create: false }).then(() => "bound", (e: { code?: string }) => e.code ?? "error");
  });
  expect(taken).not.toBe("bound");
  expect(rowOf(context("root"))).toBeDefined();
  expect(database.db.query("SELECT id FROM alias_holds WHERE address = 'you@example.com/be'").get()).toEqual({ id: hostedId("root") });
});

test("a call whose root's ownership ended and restarted before it returns keeps its result and leaves the new ownership as it is (#584)", async () => {
  await hosted.bind(principal, context("root"), { name: "be", create: true });
  const before = rowOf(context("root"))!.ownership_id;
  const value = await hosted.control(principal, context("root"), false, async () => {
    database.db.run("UPDATE users SET disabled_at = ? WHERE id = ?", [now, principal.authed.user_id]);
    hosted.sweep();
    database.db.run("UPDATE users SET disabled_at = NULL WHERE id = ?", [principal.authed.user_id]);
    now += 1000;
    await hosted.whoami(principal, context("root"));
    return "done";
  });
  expect(value).toBe("done");
  const after = rowOf(context("root"))!;
  expect(after.ownership_id).toBeGreaterThan(before);
  expect(database.db.query("SELECT ended_at FROM hosted_ownerships WHERE id = ?").get(after.ownership_id)).toEqual({ ended_at: null });
  expect(hosted.inflightCount).toBe(0);
});

// #424 items 2-4: the restart credit and the liveness heartbeat's untested branches.
const creditRows = () => database.db.query<{ detail: string }, []>("SELECT detail FROM access_log WHERE action='hosted.lease_restart_credit'").all().map(row => JSON.parse(row.detail));
const lastStart = () => JSON.parse(database.db.query<{ detail: string }, []>("SELECT detail FROM access_log WHERE action='server.started' ORDER BY id DESC LIMIT 1").get()!.detail);

test("the restart credit is what keeps an unbound idle root alive across a long outage", async () => {
  const root = context("idle-root");
  if (!("id" in root)) throw new Error("fixture context");
  await hosted.whoami(principal, root);
  const seen = database.repo.hosted.get(root.id)!.last_seen_at;
  hosted.close();
  // 20 minutes down: without the credit, the unbound root is past the 15-minute idle window at startup.
  now += 20 * 60_000;
  hosted = createHostedSessions(application, { now: () => now, isAuthorized: () => authorized });
  expect(database.repo.hosted.get(root.id)?.last_seen_at).toBe(now);
  expect(creditRows()).toEqual([expect.objectContaining({ field: "last_seen_at", before: seen, after: now, downtime_ms: 20 * 60_000 })]);
  expect(lastStart()).toMatchObject({ credited: 1 });
});

test("a disabled user's root earns no restart credit", async () => {
  const root = context("disabled-root");
  if (!("id" in root)) throw new Error("fixture context");
  await hosted.bind(principal, root, { name: "be", create: true });
  await delivery.open(principal, root);
  expect(database.repo.hosted.get(root.id)?.lease_deadline).not.toBeNull();
  hosted.close();
  database.db.run("UPDATE users SET disabled_at = ? WHERE id = ?", [now, principal.authed.user_id]);
  now += 5 * 60_000;
  hosted = createHostedSessions(application, { now: () => now, isAuthorized: () => authorized });
  expect(creditRows()).toEqual([]);
  expect(lastStart()).toMatchObject({ downtime_ms: 5 * 60_000, credited: 0 });
  expect(database.repo.hosted.get(root.id)).toBeUndefined();
});

test("the heartbeat follows a clock that steps backwards", async () => {
  now += 5_000;
  await until(() => database.repo.hosted.aliveAt() === now, 5_000);
  // Less than a heartbeat interval behind the last beat: only the t < beat branch writes it.
  now -= 500;
  await until(() => database.repo.hosted.aliveAt() === now, 5_000);
});

test("a failed heartbeat write is reported and retried on the next tick", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const write = spyOn(database.repo.hosted, "heartbeat").mockImplementation(() => { throw new Error("disk full"); });
  try {
    const before = database.repo.hosted.aliveAt();
    now += 5_000;
    await until(() => errors.mock.calls.some(call => String(call[0]).includes('"operation":"hosted.heartbeat"')), 5_000);
    expect(database.repo.hosted.aliveAt()).toBe(before);
    write.mockRestore();
    // The fake clock stands still: a failure that had advanced the beat would never write again.
    await until(() => database.repo.hosted.aliveAt() === now, 5_000);
  } finally { write.mockRestore(); errors.mockRestore(); }
});
