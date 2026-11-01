import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { tokenSession } from "../../tests/support/token_session.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "./application.ts";
import { openDatabase } from "./db.ts";
import { createHostedSessions, deliveryDeclaration, sessionContext } from "./hosted.ts";
import { createOAuthServer, type OAuthPrincipal } from "./oauth.ts";
import { BUILTIN_CLIENT_IDS, OPENCODE_CLIENT, OPENCODE_SESSION_META } from "./oauth-config.ts";
import { GRAYBOARD_DELIVERY_META, GRAYBOARD_SESSION_META, GRAYBOARD_WRITES_AS_META } from "../shared/session_meta.ts";
import { aliasUser, boundInstructions } from "../core/bindings.ts";
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
  const sender = (await application.selectIdentity(tokenSession(application.repo, principal.authed), "sender", { deliver() {}, closed() {}, probe: async () => true }, { push: false })).session;
  application.send(sender, "you@example.com/fe", "old mailbox");
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
  const sender = (await application.selectIdentity(tokenSession(application.repo, principal.authed), "sender", { deliver() {}, closed() {}, probe: async () => true }, { push: false })).session;
  await paused("hosted:bind:after-commit", () => hosted.bind(principal, context("root"), { name: "be", create: true }), async () => {
    application.send(sender, "you@example.com/fe", "not for be");
    expect(application.hostedHolder("you@example.com/fe")).toBeDefined();
    expect(application.hostedHolder("you@example.com/be")).toBe(application.hostedHolder("you@example.com/fe"));
  });
  const lease = await delivery.open(principal, context("root"));
  expect(await delivery.pending(principal, context("root"), lease.capability)).toHaveLength(1);
});

test("WSS contender releases a never-leased hosted owner only after the idle window", async () => {
  await hosted.bind(principal, context("root"), { name: "fe", create: true });
  const sink = { deliver() {}, closed() {}, probe: async () => true };
  await expect(application.selectIdentity(tokenSession(application.repo, principal.authed), "fe", sink)).rejects.toHaveProperty("code", "alias_held"); // #284: a WSS bind's refusal (was identity_in_use)
  now += 900_001;
  const acquired = await application.selectIdentity(tokenSession(application.repo, principal.authed), "fe", sink);
  expect(acquired.session.identityFull).toBe("you@example.com/fe");
  expect(database.repo.hosted.all()).toEqual([]);
  application.close(acquired.session);
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
  expect(database.repo.hosted.all()).toEqual([]);
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
