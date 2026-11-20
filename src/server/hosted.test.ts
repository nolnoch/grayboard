import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { Tx } from "./store/tx.ts";
import { refusalCount } from "./metrics.ts";
import { until } from "../../tests/support/until.ts";
import { AppSession } from "../../tests/support/app_session.ts";
import { hostedRowCount } from "../../tests/support/hosted_rows.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "./application.ts";
import { openDatabase, USER_BY_ID_SQL } from "./db.ts";
import { CLIENT_INFO_META_KEY } from "@modelcontextprotocol/server";
import { createHostedSessions, deliveryDeclaration, hostedBoundInstruction, OTHER_USER_NOTE, sessionContext, withoutFacts } from "./hosted.ts";
import { cleanFact } from "../core/boards.ts";
import { createOAuthServer, type OAuthPrincipal } from "./oauth.ts";
import { BUILTIN_CLIENT_IDS, OPENCODE_CLIENT, OPENCODE_SESSION_META } from "./oauth-config.ts";
import { GRAYBOARD_DELIVERY_META, GRAYBOARD_EFFORT_META, GRAYBOARD_LAUNCHER_META, GRAYBOARD_MODEL_META, GRAYBOARD_SESSION_META, GRAYBOARD_SUGGESTED_META, GRAYBOARD_WRITES_AS_META } from "../shared/session_meta.ts";
import { aliasUser, boundInstructions, childCapacity, dropHold } from "../core/bindings.ts";
import { COORDINATION_INSTRUCTIONS, DEFAULT_CHANNEL_SOURCE } from "../core/tools.ts";
import { DEFAULT_AUTH_FAIL_LIMIT, DEFAULT_HELLO_LIMIT } from "./rate_limit.ts";
import { DEFAULT_TRUSTED_PROXIES } from "./client_addr.ts";
import { issueOAuth } from "../../tests/helpers/oauth.ts";
import { createDelivery } from "./delivery.ts";
import { claim, listClaims } from "../core/claims.ts";
import { scratchDbPath } from "../../tests/support/scratch_db.ts";
import { queueFor } from "./store/queue.ts";
import { sessionEndPort } from "./session_end.ts";
import { seed } from "../../tests/support/seed.ts";
import { liveGrants } from "../../tests/support/grants.ts";

let database: ReturnType<typeof openDatabase>;
let application: ReturnType<typeof createApplication>;
let hosted: ReturnType<typeof createHostedSessions>;
let delivery: ReturnType<typeof createDelivery>;
let principal: OAuthPrincipal;
let now: number;
let authorized: boolean;
let blobDir: string;
const context = (raw: string) => sessionContext(principal, { [OPENCODE_SESSION_META]: raw });
beforeEach(async () => {
  blobDir = mkdtempSync(join(tmpdir(), "gb-hosted-"));
  database = openDatabase(scratchDbPath(), { blobDir , sessionEnd: sessionEndPort("team") });
  application = createApplication(database.repo);
  const user = await seed(database.repo, tx => database.repo.users.upsertByEmail(tx, "you@example.com", null));
  principal = { authed: { user_id: user.id, user_email: user.email, kind: "user", session_id: 0 }, clientId: OPENCODE_CLIENT, sourceKey: OPENCODE_SESSION_META, grantId: "G1", accessHash: "test", accessExpiry: Number.MAX_SAFE_INTEGER, scopes: ["tools", "delivery"] };
  await liveGrants(database.repo, user.id, ["G1", "G2"]);
  now = Date.now(); authorized = true;
  hosted = createHostedSessions(application, { now: () => now, isAuthorized: () => authorized }); await hosted.ready;
  delivery = createDelivery(hosted, { isAuthorized: () => authorized });
});
afterEach(async () => { delivery.close(); await hosted.close(); application.stopExpiry(); database.db.close(); rmSync(blobDir, { recursive: true, force: true }); });

test("#807: behind a write backlog longer than a tick, the timer keeps one sweep queued, not one per tick", async () => {
  // The service's timer, driven by hand: each call is one tick, so the test needs no wall clock (#961).
  await hosted.close();
  const real = setInterval;
  let tick!: () => void;
  const interval = spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms?: number, ...args: unknown[]) => {
    if (ms !== 250) return real(fn, ms, ...args);
    tick = fn;
    return real(() => {}, 1 << 30);
  }) as unknown as typeof setInterval);
  try { hosted = createHostedSessions(application, { now: () => now, isAuthorized: () => authorized }); } finally { interval.mockRestore(); }
  await hosted.ready;
  const store = database.repo.hosted;
  const expired = spyOn(store, "expired");
  try {
    let release!: () => void;
    const holder = queueFor(database.db).run(() => new Promise<void>(r => { release = r; }));
    const before = expired.mock.calls.length;
    for (let i = 0; i < 4; i++) tick();
    expect(expired.mock.calls.length).toBe(before);
    release();
    await holder;
    // FIFO: a write queued now runs after every sweep the ticks queued.
    await store.write(() => {});
    expect(expired.mock.calls.length - before).toBe(1);
    // The guard clears once the sweep settles, a few microtasks after its async body commits (#807 P3 A6e2):
    // a macrotask runs only once they drain. Then the next tick queues another.
    await new Promise<void>(resolve => setImmediate(resolve));
    tick();
    await store.write(() => {});
    expect(expired.mock.calls.length - before).toBe(2);
  } finally { expired.mockRestore(); }
});

test("#807 audit: withGate authorizes outside the transaction (the auth cache serves it) and again inside only after waiting in the queue", async () => {
  const inTxn: boolean[] = [];
  const service = createHostedSessions(application, { now: () => now, isAuthorized: () => { inTxn.push(database.db.inTransaction); return true; } }); await service.ready;
  try {
    await service.bind(principal, context("auth-root"), { name: "auth-peer", create: true });
    inTxn.length = 0;
    await service.whoami(principal, context("auth-root"));
    expect(inTxn.length).toBeGreaterThan(0);
    expect(inTxn).not.toContain(true);
    inTxn.length = 0;
    let release!: () => void;
    const holder = queueFor(database.db).run(() => new Promise<void>(r => { release = r; }));
    const call = service.whoami(principal, context("auth-root"));
    await Bun.sleep(0);
    const queuedAt = inTxn.length;
    expect(queuedAt).toBeGreaterThan(0);
    expect(inTxn).not.toContain(true);
    release();
    await holder; await call;
    expect(inTxn[queuedAt]).toBe(true);
  } finally { await service.close(); }
});

test("#998: an access check inside a hosted body reads on that body's Tx, one outside on the pool", async () => {
  const checks: { inTxn: boolean; handle: "pool" | "tx" }[] = [];
  const service = createHostedSessions(application, { now: () => now, isAuthorized: (_p, r) => {
    checks.push({ inTxn: database.db.inTransaction, handle: r === undefined || r === database.repo.read ? "pool" : "tx" });
    return true;
  } });
  await service.ready;
  try {
    await service.bind(principal, context("check-root"), { name: "check-peer", create: true });
    await service.register(principal, context("check-root"), "check-child");
    await service.run(principal, context("check-child"), "dm_send", (session, tx) => application.send(tx, session, "check-peer", "checked"));
    // A register under another grant reattaches the root (attach), which checks again after its fence.
    await service.register({ ...principal, grantId: "G2" }, context("check-root"), "check-child-2");
    // A gate that waited behind another body checks again inside its own.
    let release!: () => void;
    const holder = queueFor(database.db).run(() => new Promise<void>(r => { release = r; }));
    const call = service.whoami(principal, context("check-root"));
    await Bun.sleep(0);
    const queuedAt = checks.length;
    release();
    await holder; await call;
    expect(checks[queuedAt]).toEqual({ inTxn: true, handle: "tx" });
    expect(checks.filter(c => c.inTxn).length).toBeGreaterThan(2);
    expect(checks.filter(c => c.inTxn !== (c.handle === "tx"))).toEqual([]);
  } finally { await service.close(); }
});

test("#998 audit: delivery's access check inside the renew, receipt and release bodies reads on that body's Tx", async () => {
  const checks: { op: string; inTxn: boolean; handle: "pool" | "tx" }[] = [];
  let op = "open";
  const service = createDelivery(hosted, { isAuthorized: (_p, r) => {
    checks.push({ op, inTxn: database.db.inTransaction, handle: r === undefined || r === database.repo.read ? "pool" : "tx" });
    return true;
  } });
  try {
    await hosted.bind(principal, context("lease-root"), { name: "lease-peer", create: true });
    const lease = await service.open(principal, context("lease-root"));
    for (const [name, step] of [["renew", () => service.renew(principal, context("lease-root"), lease.capability)],
      ["receipt", () => service.receipt(principal, context("lease-root"), lease.capability, [])],
      ["release", () => service.release(principal, context("lease-root"), lease.capability)]] as const) {
      op = name;
      await step();
    }
    for (const name of ["renew", "receipt", "release"]) expect(checks.filter(c => c.op === name && c.inTxn)).toEqual([{ op: name, inTxn: true, handle: "tx" }]);
    expect(checks.filter(c => c.inTxn !== (c.handle === "tx"))).toEqual([]);
  } finally { await service.close(); }
});

// #807 P1c-13: the alias reads and writes a hosted body makes (bind's lazy create and cap, alias_held's holder,
// a tools-only root's writes_as, a send's peer, a create:false bind's unknown name, a bare name outside the sender's
// scope, unbind's candidates) run on that body's Tx. access.ts's mention resolver reads aliases on its caller's
// handle (#807 P3 C10d2-a deleted repo.policyNow); the attachment guard moved to its body's handle in #1053.
test("#807 P1c-13: alias reads inside hosted bodies run on that body's Tx", async () => {
  const checks: { op: string; inTxn: boolean; handle: "pool" | "tx"; site: string }[] = [];
  const spies = (["find", "countForScope", "listForScope", "findAllByName", "create", "remove"] as const).map(name => {
    const original = database.repo.aliases[name].bind(database.repo.aliases) as (...a: unknown[]) => unknown;
    return spyOn(database.repo.aliases, name).mockImplementation(((r: unknown, ...rest: unknown[]) => {
      const site = new Error().stack?.split("\n").find(l => l.includes("/src/") && !l.includes("hosted.test.ts")) ?? "";
      checks.push({ op: name, inTxn: database.db.inTransaction, handle: r === database.repo.read ? "pool" : "tx", site });
      return original(r, ...rest);
    }) as never);
  });
  const described: ("pool" | "tx")[] = [];
  const get = database.repo.hosted.get.bind(database.repo.hosted);
  const holder = spyOn(database.repo.hosted, "get").mockImplementation((r, id) => {
    if (new Error().stack?.includes("describeHolder")) described.push(r === database.repo.read ? "pool" : "tx");
    return get(r, id);
  });
  try {
    await hosted.bind(principal, context("p13-root"), { name: "p13", create: true });
    expect(checks.filter(c => c.op === "create" && c.inTxn)).toHaveLength(1);
    expect(checks.some(c => c.op === "countForScope" && c.inTxn)).toBe(true);
    await expect(hosted.bind(principal, context("p13-other"), { name: "p13" })).rejects.toHaveProperty("code", "alias_held");
    expect(described).toEqual(["tx"]);
    const { generic, meta } = toolsOnly();
    const before = checks.length;
    await hosted.whoami(generic, meta("p13-tools", "p13-scribe"));
    expect(checks.slice(before).some(c => c.inTxn && c.handle === "tx")).toBe(true);
    await hosted.run(principal, context("p13-root"), "dm_send", (session, tx) => application.send(tx, session, "p13-scribe", "hi"));
    const typo = checks.length;
    await expect(hosted.bind(principal, context("p13-other"), { name: "p13-typo", create: false })).rejects.toHaveProperty("code", "identity_unknown");
    expect(checks.slice(typo).filter(c => c.inTxn).map(c => `${c.op}:${c.handle}`)).toEqual(expect.arrayContaining(["find:tx", "listForScope:tx"]));
    const stranger = checks.length;
    await expect(hosted.run(principal, context("p13-root"), "dm_send", (session, tx) => application.send(tx, session, "p13-nobody", "hi"))).rejects.toHaveProperty("code", "not_found");
    expect(checks.slice(stranger).filter(c => c.op === "findAllByName").map(c => c.handle)).toEqual(["tx"]);
    await hosted.unbind(principal, context("p13-other"), { name: "p13" });
    expect(checks.filter(c => c.inTxn).length).toBeGreaterThan(4);
    expect(checks.filter(c => c.inTxn !== (c.handle === "tx"))).toEqual([]);
  } finally {
    for (const spy of spies) spy.mockRestore();
    holder.mockRestore();
  }
});

// #807 P1c-14b: the DM reads a hosted body makes (bind's undelivered notice, a send's parent and its
// undelivered count, dm_history, dm_thread, dm_inbox, dm_ack, a first bind's candidates and their last-seen) run on
// that body's Tx; an unbound root's whoami lists its candidates on the pool, outside any body.
// Every messages read and aliases.seen, recording the handle each was given and whether a body was open.
function spyMessageReads() {
  const checks: { op: string; inTxn: boolean; handle: "pool" | "tx" }[] = [];
  const spy = <S extends object>(store: S, names: readonly (keyof S & string)[]) => names.map(name => {
    const original = (store[name] as (...a: unknown[]) => unknown).bind(store);
    return spyOn(store, name as never).mockImplementation(((r: unknown, ...rest: unknown[]) => {
      checks.push({ op: name, inTxn: database.db.inTransaction, handle: r === database.repo.read ? "pool" : "tx" });
      return original(r, ...rest);
    }) as never);
  });
  const spies = [
    ...spy(database.repo.messages, ["getById", "writerUsers", "delegationIds", "bouncesFrom", "history", "thread", "unreadSince",
      "queuedTo", "undeliveredFrom", "receivedUnacked", "sentPending"] as const),
    ...spy(database.repo.aliases, ["seen"] as const),
  ];
  return { checks, restore: () => { for (const s of spies) s.mockRestore(); } };
}

test("#807 P1c-14b: messages reads inside hosted bodies run on that body's Tx", async () => {
  const { checks, restore } = spyMessageReads();
  const a = context("p14-a"), b = context("p14-b");
  try {
    await hosted.bind(principal, a, { name: "p14a", create: true });
    await hosted.bind(principal, b, { name: "p14b", create: true });
    const sent = await hosted.run(principal, a, "dm_send", (session, tx) => application.send(tx, session, "p14b", "question", { pending: true })) as { message_id: number };
    await hosted.run(principal, b, "dm_send", (session, tx) => application.send(tx, session, "p14a", "answer", { parent_id: sent.message_id }));
    await hosted.run(principal, a, "dm_history", (session, tx) => application.history(tx, session, {}));
    await hosted.run(principal, a, "dm_thread", (session, tx) => application.thread(tx, session, sent.message_id));
    await hosted.run(principal, a, "dm_inbox", (session, tx) => application.inbox(tx, session));
    await hosted.run(principal, a, "dm_ack", (session, tx) => application.acknowledgeDm(tx, session, sent.message_id));
    const late = await hosted.run(principal, a, "dm_send", (session, tx) => application.send(tx, session, "p14b", "never mind")) as { message_id: number };
    const retracted = checks.length;
    await hosted.run(principal, a, "dm_retract", (session, tx) => application.retract(tx, session, late.message_id));
    expect(checks.slice(retracted).map(c => `${c.op}:${c.handle}`)).toEqual(["getById:tx"]);
    await hosted.run(principal, a, "board_create", (session, tx) => application.call(tx, session, "board_create", { name: "p14", purpose: "tests" }));
    await hosted.run(principal, a, "board_post", (session, tx) => application.call(tx, session, "board_post", { board: "p14", body: "x" }));
    const read = checks.length;
    await hosted.run(principal, a, "board_read", (session, tx) => application.call(tx, session, "board_read", { board: "p14" }));
    expect(checks.slice(read).map(c => `${c.op}:${c.handle}`)).toEqual(["writerUsers:tx"]);
    await hosted.bind(principal, a, { name: "p14a-2", create: true });
    await hosted.unbind(principal, a, { name: "p14a-2" });
    await hosted.unbind(principal, a, { name: "p14a" });
    const inBody = new Set(checks.filter(c => c.inTxn).map(c => c.op));
    for (const op of ["getById", "writerUsers", "history", "thread", "queuedTo", "undeliveredFrom", "receivedUnacked", "sentPending", "seen"]) expect(inBody).toContain(op);
    const outside = checks.length;
    await hosted.whoami(principal, a);
    expect(checks.slice(outside).filter(c => c.op === "queuedTo" || c.op === "seen").map(c => `${c.op}:${c.handle}:${c.inTxn}`)).toEqual(["seen:pool:false", "queuedTo:pool:false"]);
    expect(checks.filter(c => c.inTxn !== (c.handle === "tx"))).toEqual([]);
  } finally { restore(); }
});

// #807 P1c-14b: a lease's pull reads on the pool; its receipt's unread check and the ack it records read on the receipt body's Tx.
test("#807 P1c-14b: a delivery receipt's messages reads run on its body's Tx", async () => {
  const { checks, restore } = spyMessageReads();
  const a = context("p14-lease"), b = context("p14-sender");
  try {
    await hosted.bind(principal, a, { name: "p14r", create: true });
    await hosted.bind(principal, b, { name: "p14s", create: true });
    const lease = await delivery.open(principal, a);
    await hosted.run(principal, b, "dm_send", (session, tx) => application.send(tx, session, "p14r", "hello"));
    const pulled = checks.length;
    const items = await delivery.pending(principal, a, lease.capability);
    expect(items).toHaveLength(1);
    expect(checks.slice(pulled).filter(c => c.op === "unreadSince").map(c => `${c.handle}:${c.inTxn}`)).toEqual(["pool:false"]);
    const received = checks.length;
    await delivery.receipt(principal, a, lease.capability, items.map(i => i.id));
    const ops = checks.slice(received).map(c => `${c.op}:${c.handle}`);
    expect(ops).toEqual(expect.arrayContaining(["unreadSince:tx", "getById:tx"]));
    expect(checks.filter(c => c.inTxn !== (c.handle === "tx"))).toEqual([]);
  } finally { restore(); }
});

// #807 P1c-15b: every core helper application.ts reaches goes through `repo.coreOn(handle)`: a body's `Tx` inside one,
// the pool outside. Logged per call with whether a transaction is open, so an in-body call on the pool (or the reverse) shows.
// P3 B5a1: the delivery pull and receipt reach boards through `repo.boards` (pool outside a body, the receipt's `Tx`
// inside); only the receipt's board check is still core's.
test("#807 P1c-15b: core helpers inside hosted bodies run on that body's Tx, outside on the pool", async () => {
  const checks: { op: string; inTxn: boolean; handle: "pool" | "tx" }[] = [];
  const log = (op: string, h: unknown) => checks.push({ op, inTxn: database.db.inTransaction, handle: h === database.repo.read ? "pool" : "tx" });
  const original = database.repo.coreOn.bind(database.repo);
  const spy = spyOn(database.repo, "coreOn").mockImplementation(((h: Parameters<typeof original>[0]) => { log("coreOn", h); return original(h); }) as never);
  const group = database.repo.boards;
  const boardSpies = (Object.keys(group) as (keyof typeof group)[]).map(name => {
    const own = (group[name] as (...a: unknown[]) => unknown).bind(group);
    return spyOn(group, name as never).mockImplementation(((h: unknown, ...rest: unknown[]) => { log(`boards.${name}`, h); return own(h, ...rest); }) as never);
  });
  const a = context("p15-a"), b = context("p15-b");
  try {
    await hosted.bind(principal, a, { name: "p15a", create: true });
    await hosted.bind(principal, b, { name: "p15b", create: true });
    // P3 B1c/B2: bind reaches core no more (its binding writes are repo.bindings', its claims read repo.claims').
    const bound = checks.length;
    await hosted.run(principal, a, "dm_send", (session, tx) => application.send(tx, session, "p15b", "question", { pending: true }));
    await hosted.run(principal, a, "board_create", (session, tx) => application.call(tx, session, "board_create", { name: "p15", purpose: "tests" }));
    await hosted.run(principal, b, "board_subscribe", (session, tx) => application.call(tx, session, "board_subscribe", { board: "p15", mode: "push" }));
    await hosted.run(principal, b, "board_read", (session, tx) => application.call(tx, session, "board_read", { board: "p15" }));
    // After the read: the pull below must find the post still pending, so the receipt acknowledges it.
    await hosted.run(principal, a, "board_post", (session, tx) => application.call(tx, session, "board_post", { board: "p15", body: "x" }));
    await hosted.run(principal, b, "dm_inbox", (session, tx) => application.inbox(tx, session));
    expect(checks.length).toBeGreaterThan(bound);
    const pull = checks.length;
    const lease = await delivery.open(principal, b);
    const items = await delivery.pending(principal, b, lease.capability);
    expect(items.length).toBeGreaterThan(0);
    await delivery.receipt(principal, b, lease.capability, items.map(i => i.id));
    const pulled = checks.slice(pull);
    // The pull and the receipt read boards through repo.boards alone (B5a2): the receipt's board check is
    // repo.boards.get on its Tx (board_reads visibleBoards), not core.
    expect(pulled.filter(c => c.op === "coreOn")).toEqual([]);
    expect(pulled.some(c => c.op === "boards.get" && c.handle === "tx" && c.inTxn)).toBe(true);
    expect(pulled.some(c => c.op === "boards.pendingPushes" && c.handle === "pool" && !c.inTxn)).toBe(true);
    expect(pulled.some(c => c.op === "boards.acknowledge" && c.handle === "tx" && c.inTxn)).toBe(true);
    await hosted.whoami(principal, a);
    expect(checks.filter(c => c.inTxn !== (c.handle === "tx"))).toEqual([]);
  } finally { spy.mockRestore(); for (const s of boardSpies) s.mockRestore(); }
});

// #807 P3 B5b1b1/B5b1b2/B5b2/B5b3c: board_list, peer_list, peer_status, board_create, board_archive, board_subscribe,
// board_read, claim_list, board_post and claim_take/release/watch run on the server's port, never core over `coreOn`, their reads and writes on
// the call's Tx; and every board tool's actor pick reads the board views on that Tx.
test("#807 P3 B5b1b: the ported board tools and the actor pick read and write through the repo on the call's Tx", async () => {
  const checks: { op: string; inTxn: boolean; handle: "pool" | "tx" }[] = [];
  const log = (op: string, h: unknown) => checks.push({ op, inTxn: database.db.inTransaction, handle: h === database.repo.read ? "pool" : "tx" });
  const original = database.repo.coreOn.bind(database.repo);
  const spies: { mockRestore(): void }[] = [spyOn(database.repo, "coreOn").mockImplementation(((h: Parameters<typeof original>[0]) => { log("coreOn", h); return original(h); }) as never)];
  const groups = {
    boards: [
      "views", "openSummaries", "roster", "get", "post", "create", "setArchived", "setSubscription", "read", "threadRoot", "mute",
      "insertPost", "authorAddresses", "subscribers", "threadFacts", "laneRows", "claimQueuePost", "insertOutbox",
    ],
    bindings: ["viewerIds", "idFacts", "setStatus", "setQueueParticipation"],
    aliases: ["isHuman", "scopesOf", "humansAmong"],
    claims: ["list", "ackQueue", "get", "take", "release", "recentEvents", "watchers", "liveForWatch", "addWatch", "unwatch", "expire", "logEvent", "takeWatchers"],
  } as const;
  for (const [g, names] of Object.entries(groups)) {
    const group = database.repo[g as keyof typeof groups] as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const name of names) {
      const own = group[name]!.bind(group);
      spies.push(spyOn(group, name as never).mockImplementation(((h: unknown, ...rest: unknown[]) => { log(`${g}.${name}`, h); return own(h, ...rest); }) as never));
    }
  }
  const a = context("b5b1b1-a"), lane = context("b5b2-lane");
  try {
    await hosted.bind(principal, a, { name: "b5b1b1a", create: true });
    await hosted.bind(principal, lane, { name: "b5b2lane", create: true });
    const ported: typeof checks = [];
    let last: unknown;
    const call = async (tool: string, args: Record<string, unknown>, as = a) => {
      const from = checks.length;
      last = await hosted.run(principal, as, tool, (session, tx) => application.call(tx, session, tool, args));
      const these = checks.slice(from);
      ported.push(...these);
      return these;
    };
    const ops = (cs: typeof checks) => [...new Set(cs.map(c => c.op))].sort();
    const create = await call("board_create", { name: "b5b1b1", purpose: "tests" });
    expect(ops(create)).toEqual(expect.arrayContaining(["boards.create", "boards.get", "boards.setSubscription"]));
    // A repeat (#254) is answered from the row, never a second insert.
    const again = await call("board_create", { name: "b5b1b1", purpose: "tests" });
    expect(ops(again)).toContain("boards.get");
    expect(ops(again)).not.toContain("boards.create");
    const list = await call("board_list", {});
    expect(ops(list)).toEqual(["boards.views"]);
    // A bound session lists no unbound sessions, so asks no ID facts.
    expect(ops(await call("peer_list", {}))).toEqual(["bindings.viewerIds", "boards.roster"]);
    expect(ops(await call("peer_list", { board: "b5b1b1" }))).toEqual(["bindings.viewerIds", "boards.get", "boards.roster"]);
    expect(ops(await call("peer_status", { text: "porting", queue: "off" }))).toEqual(["bindings.setQueueParticipation", "bindings.setStatus"]);
    expect(ops(await call("board_subscribe", { board: "b5b1b1", mode: "digest" }))).toEqual(expect.arrayContaining(["boards.get", "boards.setSubscription"]));
    // board_post (B5b2): a broadcast reads the subscribers, a reply its thread, and every post writes its row and outbox.
    expect(ops(await call("board_post", { board: "b5b1b1", body: "root" }))).toEqual(
      expect.arrayContaining(["boards.views", "boards.get", "aliases.isHuman", "boards.insertPost", "boards.authorAddresses", "boards.subscribers", "boards.insertOutbox"]),
    );
    const root = last as { post_id: number };
    expect(ops(await call("board_post", { board: "b5b1b1", body: "reply @b5b2lane", parent_id: root.post_id }))).toEqual(
      expect.arrayContaining(["boards.post", "boards.threadFacts", "aliases.humansAmong", "boards.insertOutbox", "aliases.scopesOf"]),
    );
    expect(ops(await call("board_subscribe", { board: "b5b1b1", mode: "off", thread: root.post_id }))).toEqual(expect.arrayContaining(["boards.post", "boards.threadRoot", "boards.mute"]));
    // A queue post rotates to the lane, which claims it; the lane's reply acks the claim.
    await call("board_create", { name: "b5b2q", purpose: "tests", kind: "queue" });
    await call("board_subscribe", { board: "b5b2q", mode: "push" }, lane);
    expect(ops(await call("board_post", { board: "b5b2q", body: "work" }))).toEqual(expect.arrayContaining(["boards.laneRows", "boards.claimQueuePost"]));
    const work = last as { post_id: number; notified: string[] };
    expect(work.notified).toEqual(["you@example.com/b5b2lane"]);
    expect(ops(await call("board_post", { board: "b5b2q", body: "done", parent_id: work.post_id }, lane))).toContain("claims.ackQueue");
    expect(ops(await call("claim_list", { prefix: "queue:b5b2q:" }))).toContain("claims.list");
    expect(last).toEqual([]);
    expect(ops(await call("board_read", { board: "b5b1b1" }))).toEqual(expect.arrayContaining(["boards.read", "claims.list"]));
    expect(ops(await call("claim_list", {}))).toContain("claims.list");
    expect(ops(await call("board_archive", { board: "b5b1b1" }))).toEqual(expect.arrayContaining(["aliases.isHuman", "boards.setArchived"]));
    expect(ops(await call("board_archive", { board: "b5b1b1", archived: false }))).toContain("boards.setArchived");
    // B5b3c: claim_take, claim_watch and claim_release run on the server's port too.
    expect(ops(await call("claim_take", { key: "b5b2:x", board: "b5b1b1" }))).toEqual(expect.arrayContaining(["claims.expire", "claims.get", "claims.take", "claims.logEvent", "boards.insertPost"]));
    expect(ops(await call("claim_watch", { key: "b5b2:x" }, lane))).toEqual(expect.arrayContaining(["claims.liveForWatch", "claims.addWatch"]));
    expect(ops(await call("claim_take", { key: "b5b2:x", note: "renew" }))).toEqual(expect.arrayContaining(["claims.take", "claims.watchers"]));
    expect(ops(await call("claim_release", { key: "b5b2:x" }))).toEqual(expect.arrayContaining(["claims.release", "claims.logEvent"]));
    expect(ops(await call("claim_release", { key: "b5b2:x" }))).toEqual(expect.arrayContaining(["claims.recentEvents"]));
    expect(ops(await call("claim_watch", { key: "b5b2:x", off: true }, lane))).toContain("claims.unwatch");
    // None of them reaches core.
    expect(ported.filter(c => c.op === "coreOn")).toEqual([]);
    expect(checks.filter(c => c.handle !== "tx" || !c.inTxn)).toEqual([]);
  } finally { for (const s of spies) s.mockRestore(); }
});

// #807 P3 B4a: a send to an `id:` address asks `repo.sessionEnd.refusal` on the send's Tx (the send side of an end's
// race, D3), not core's check over `coreOn`.
test("#807 P3 B4a: a send to an id: address checks deliverability through repo.sessionEnd on its Tx", async () => {
  const checks: { op: string; inTxn: boolean; handle: "pool" | "tx" }[] = [];
  const log = (op: string, h: unknown) => checks.push({ op, inTxn: database.db.inTransaction, handle: h === database.repo.read ? "pool" : "tx" });
  const group = database.repo.sessionEnd;
  const own = group.refusal.bind(group);
  const refusal = spyOn(group, "refusal").mockImplementation(((h: never, id: string) => { log("refusal", h); return own(h, id); }) as never);
  const original = database.repo.coreOn.bind(database.repo);
  const core = spyOn(database.repo, "coreOn").mockImplementation(((h: Parameters<typeof original>[0]) => { log("coreOn", h); return original(h); }) as never);
  const a = context("b4a-a"), b = context("b4a-b");
  try {
    await hosted.bind(principal, a, { name: "b4aa", create: true });
    await hosted.bind(principal, b, { name: "b4ab", create: true });
    const to = await hosted.run(principal, b, "dm_history", session => session.sessionId);
    expect(to.startsWith("id:")).toBe(true);
    const mark = checks.length;
    await hosted.run(principal, a, "dm_send", (session, tx) => application.send(tx, session, to, "to an ID", {}));
    expect(checks.slice(mark).map(c => `${c.op}:${c.handle}:${c.inTxn}`)).toEqual(["refusal:tx:true"]);
  } finally { refusal.mockRestore(); core.mockRestore(); }
});

// #807 P3 B1a: the holds, session-row and presence reads go through `repo.bindings` on the caller's handle: a body's
// `Tx` inside one (bind's checks, the send's last-seen, peer_list's unbound roots, the inbox), the pool outside (an
// unbound session's candidates, read by whoami).
test("#807 P3 B1a: binding reads inside hosted bodies run on that body's Tx, outside on the pool", async () => {
  const checks: { op: string; inTxn: boolean; handle: "pool" | "tx" }[] = [];
  const store = database.repo.bindings;
  const spies = (Object.keys(store) as (keyof typeof store)[]).map(name => {
    const original = (store[name] as (...a: unknown[]) => unknown).bind(store);
    return spyOn(store, name as never).mockImplementation(((r: unknown, ...rest: unknown[]) => {
      checks.push({ op: name, inTxn: database.db.inTransaction, handle: r === database.repo.read ? "pool" : "tx" });
      return original(r, ...rest);
    }) as never);
  });
  const a = context("b1a-a"), b = context("b1a-b"), idle = context("b1a-idle");
  try {
    await hosted.bind(principal, a, { name: "b1a", create: true });
    await hosted.bind(principal, b, { name: "b1b", create: true });
    await hosted.run(principal, a, "dm_send", (session, tx) => application.send(tx, session, "b1b", "question", { pending: true }));
    await hosted.run(principal, b, "dm_inbox", (session, tx) => application.inbox(tx, session));
    await hosted.run(principal, idle, "peer_list", (session, tx) => application.call(tx, session, "peer_list", {}));
    const inBody = new Set(checks.filter(c => c.inTxn).map(c => c.op));
    for (const op of ["holderOf", "userOf", "idRow", "lastSeen", "holdsOfMany", "idStatuses"]) expect(inBody).toContain(op);
    const outside = checks.length;
    await hosted.whoami(principal, idle);
    expect(checks.slice(outside).filter(c => c.op === "holdersOf").map(c => `${c.handle}:${c.inTxn}`)).toEqual(["pool:false"]);
    expect(checks.filter(c => c.inTxn !== (c.handle === "tx"))).toEqual([]);
  } finally { for (const s of spies) s.mockRestore(); }
});

// #807 P1c-15b-2: the rest of application.ts leaves `db`. A refusal's deferred row is written on the `Tx` of the body
// that flushes it; bind's place, unbind, a request's facts and a receipt's board check run on their body's `Tx`.
test("#807 P1c-15b-2: refusal rows, place, unbind, facts and board checks run on a body's Tx", async () => {
  const generic: OAuthPrincipal = { ...principal, clientId: "grayboard-pi", sourceKey: GRAYBOARD_SESSION_META };
  const ctx = (raw: string, extra: Record<string, unknown> = {}) => sessionContext(generic, { [GRAYBOARD_SESSION_META]: raw, ...extra });
  const checks: { inTxn: boolean; handle: "pool" | "tx" }[] = [];
  const original = database.repo.coreOn.bind(database.repo);
  const spy = spyOn(database.repo, "coreOn").mockImplementation(((h: Parameters<typeof original>[0]) => {
    checks.push({ inTxn: database.db.inTransaction, handle: h === database.repo.read ? "pool" : "tx" });
    return original(h);
  }) as never);
  // A binding row goes through `repo.bindings` (#807 P3 B1c): its writes are logged beside core's.
  const logs: { inTxn: boolean; handle: "pool" | "tx" }[] = [];
  const log = database.repo.bindings.log.bind(database.repo.bindings);
  const logSpy = spyOn(database.repo.bindings, "log").mockImplementation(((h: Parameters<typeof log>[0], ...rest: unknown[]) => {
    logs.push({ inTxn: database.db.inTransaction, handle: h === database.repo.read ? "pool" : "tx" });
    return (log as (...a: unknown[]) => Promise<void>)(h, ...rest);
  }) as never);
  const holder = ctx("p15b2-holder"), other = ctx("p15b2-other");
  const refused = () => database.db.prepare("SELECT name FROM binding_events WHERE session_id = ? AND event = 'refused'").all((other as { id: string }).id);
  try {
    await hosted.bind(generic, holder, { name: "p15b2", create: true, where: "repo on main" });
    expect(database.db.prepare("SELECT place FROM ids WHERE id = ?").get((holder as { id: string }).id)).toEqual({ place: "repo on main" });
    await delivery.open(generic, holder);
    await hosted.bind(generic, other, { name: "p15b2-other", create: true });
    const before = logs.length;
    await expect(hosted.bind(generic, other, { name: "p15b2" })).rejects.toHaveProperty("code", "alias_held");
    expect(refused()).toEqual([{ name: "you@example.com/p15b2" }]);
    // The refused bind's row is written by flushQueued's own body, on its Tx.
    expect(logs.slice(before)).toEqual([{ inTxn: true, handle: "tx" }]);
    await hosted.whoami(generic, ctx("p15b2-other", { [GRAYBOARD_MODEL_META]: "claude-opus-5-5" }));
    expect(database.db.prepare("SELECT model FROM ids WHERE id = ?").get((other as { id: string }).id)).toEqual({ model: "claude-opus-5-5" });
    await hosted.run(generic, holder, "board_create", (session, tx) => application.call(tx, session, "board_create", { name: "p15b2", purpose: "tests" }));
    await hosted.run(generic, holder, "board_subscribe", (session, tx) => application.call(tx, session, "board_subscribe", { board: "p15b2", mode: "push" }));
    await hosted.run(generic, other, "board_post", (session, tx) => application.call(tx, session, "board_post", { board: "p15b2", body: "x" }));
    const lease = await delivery.open(generic, holder);
    const items = await delivery.pending(generic, holder, lease.capability);
    expect(items.some(i => i.event.kind === "board")).toBe(true);
    await delivery.receipt(generic, holder, lease.capability, items.map(i => i.id));
    expect(await hosted.unbind(generic, other, { name: "p15b2-other" })).toMatchObject({ structuredContent: { name: null } });
    expect(checks.filter(c => c.inTxn !== (c.handle === "tx"))).toEqual([]);
  } finally { spy.mockRestore(); logSpy.mockRestore(); }
});

// #807 P3 A2: an audit row written inside a hosted body goes on that body's Tx, never through `repo.post` (which ran it
// inline before A2, and refuses inside a transaction since A3); the hosted row an audit without a principal reads to name its actor is read on the same Tx.
test("#807 P3 A2: audit rows inside hosted bodies write on that body's Tx, and the row an audit reads is read on it", async () => {
  const posts: { what: string; inTxn: boolean }[] = [];
  const post = database.repo.post.bind(database.repo);
  const postSpy = spyOn(database.repo, "post").mockImplementation(((fn: never, committed?: never, what?: string) => {
    posts.push({ what: what ?? "", inTxn: database.db.inTransaction });
    return post(fn, committed, what);
  }) as never);
  const reads: { inTxn: boolean; handle: "pool" | "tx" }[] = [];
  const get = database.repo.hosted.get.bind(database.repo.hosted);
  const getSpy = spyOn(database.repo.hosted, "get").mockImplementation((r, id) => {
    if (new Error().stack?.split("\n").some(l => /\bat audit \(.*\/hosted\.ts:/.test(l))) reads.push({ inTxn: database.db.inTransaction, handle: r === database.repo.read ? "pool" : "tx" });
    return get(r, id);
  });
  const a = context("a2-root"), b = context("a2-other");
  const rows = (action: string) => (database.db.prepare("SELECT COUNT(*) AS n FROM access_log WHERE action = ?").get(action) as { n: number }).n;
  try {
    await hosted.bind(principal, a, { name: "a2", create: true });
    await delivery.open(principal, a);
    // A second hold with the lease open closes it: an audit with no principal, which reads the root's row for its actor.
    await hosted.bind(principal, a, { name: "a2-second", create: true });
    expect(rows("hosted.lease_closed")).toBe(1);
    await hosted.run(principal, a, "board_create", (session, tx) => application.call(tx, session, "board_create", { name: "a2", purpose: "tests" }));
    expect(rows("hosted.write")).toBeGreaterThan(0);
    await expect(hosted.bind(principal, b, { name: "a2" })).rejects.toHaveProperty("code", "alias_held");
    await hosted.unbind(principal, a, { name: "a2-second" });
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.filter(r => !(r.inTxn && r.handle === "tx"))).toEqual([]);
    expect(posts.filter(p => p.what.startsWith("audit ") && p.inTxn)).toEqual([]);
  } finally { postSpy.mockRestore(); getSpy.mockRestore(); }
});

test("one reconciliation invalidates listeners once, not once per root", async () => {
  for (let i = 0; i < 4; i++) await hosted.bind(principal, context(`root-${i}`), { name: `peer-${i}`, create: true });
  const invalidations: (string | null)[] = [];
  const unlisten = hosted.listen(changed => { invalidations.push(changed); });
  try {
    await hosted.reconcile();
    expect(invalidations).toEqual([null]);
    expect((await application.holdsByOwner(database.repo.read)).size).toBe(4);
  } finally { unlisten(); }
});

test("a commit invalidates only the rows it changed; a touch or an empty commit tells nothing (#399)", async () => {
  for (let i = 0; i < 4; i++) await hosted.bind(principal, context(`root-${i}`), { name: `peer-${i}`, create: true });
  const target = context("root-2");
  if (!("id" in target)) throw new Error("fixture context");
  const invalidations: (string | null)[] = [];
  const unlisten = hosted.listen(changed => { invalidations.push(changed); });
  try {
    await seed(database.repo, tx => tx.savepoint(() => {}));
    await seed(database.repo, tx => tx.savepoint(sp => database.repo.hosted.touch(sp, target.id, now)));
    expect(invalidations).toEqual([]);
    await seed(database.repo, tx => tx.savepoint(sp => database.repo.hosted.end(sp, target.id, "closed", now)));
    expect(invalidations).toEqual([target.id]);
    expect((await application.holdsByOwner(database.repo.read)).size).toBe(3);
  } finally { unlisten(); }
});

test("startup opens no holder session for a root its first sweep ends (#424 item 7)", async () => {
  const root = context("lapsed-root");
  if (!("id" in root)) throw new Error("fixture context");
  await hosted.bind(principal, root, { name: "be", create: true });
  await delivery.open(principal, root);
  await hosted.close();
  // The lease lapsed while the server was still up: no credit, and the startup sweep ends the root.
  await seed(database.repo, () => database.db.run("UPDATE hosted_sessions SET lease_deadline = ? WHERE session_id = ?", [now - 1, root.id]));
  now += 5 * 60_000;
  const opened = spyOn(application, "hostedBuild");
  try {
    hosted = createHostedSessions(application, { now: () => now, isAuthorized: () => authorized }); await hosted.ready;
    expect(await database.repo.hosted.get(database.repo.read, root.id)).toBeUndefined();
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
  await hosted.run(principal, child, "dm_send", (session, tx) => application.send(tx, session, "be", "child attribution"));
  expect(database.db.query("SELECT sender_id FROM messages WHERE body='child attribution'").get()).toEqual({ sender_id: child.id });
  await hosted.end(principal, root);
  expect(database.db.query("SELECT * FROM alias_holds").all()).toEqual([]);
  expect(database.db.query("SELECT id FROM ids WHERE id IN (?, ?)").all(root.id, child.id)).toHaveLength(2);
});

test("unbound row quota survives service restart, idle cleanup frees rows and gates", async () => {
  for (let i = 0; i < hosted.limits.user; i++) await hosted.whoami(principal, context(`unbound-${i}`));
  expect(await database.repo.hosted.all(database.repo.read)).toHaveLength(hosted.limits.user);
  expect(hosted.gateCount).toBe(0);
  const before = database.db.query<{ count: number }, []>("SELECT count(*) AS count FROM hosted_ownerships").get()?.count;
  await expect(hosted.whoami(principal, context("overflow"))).rejects.toHaveProperty("code", "bad_request");
  expect(database.db.query<{ count: number }, []>("SELECT count(*) AS count FROM hosted_ownerships").get()?.count).toBe(before);
  await hosted.close();
  hosted = createHostedSessions(application, { now: () => now, isAuthorized: () => authorized }); await hosted.ready;
  await expect(hosted.whoami(principal, context("overflow"))).rejects.toHaveProperty("code", "bad_request");
  now += 900_001; await hosted.sweep();
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
  const counted = refusalCount("hosted_child");
  await expect(hosted.register(otherGrant, context("root"), "overflow")).rejects.toHaveProperty("code", "bad_request");
  expect(refusalCount("hosted_child")).toBe(counted + 1);
  expect((await database.repo.hosted.all(database.repo.read)).every(row => row.grant_id === "G1")).toBe(true);
  expect(delivery.describe(principal, context("root"), lease.capability, { row: await database.repo.hosted.get(database.repo.read, hostedId("root")) }).capability).toBe(lease.capability);
  await hosted.end(principal, context("child-0"));
  await hosted.register(principal, context("root"), "overflow");
  expect(await database.repo.hosted.all(database.repo.read)).toHaveLength(1 + hosted.limits.children);
  expect(hosted.gateCount).toBe(0);
});

test("global quota applies across users transactionally without creating an overflow ownership", async () => {
  await hosted.whoami(principal, context("template"));
  const template = (await database.repo.hosted.all(database.repo.read))[0]!;
  await hosted.end(principal, context("template"));
  await seed(database.repo, async tx => {
    for (let userIndex = 0; userIndex < hosted.limits.global / hosted.limits.user; userIndex++) {
      const user = await database.repo.users.upsertByEmail(tx, `user${userIndex}@example.com`, null);
      for (let i = 0; i < hosted.limits.user; i++) {
        const id = `seed-${userIndex}-${i}`;
        const ownership = await database.repo.hosted.start(tx, id, user.id, OPENCODE_CLIENT, now);
        await database.repo.hosted.insert(tx, { ...template, session_id: id, ownership_id: ownership, user_id: user.id });
      }
    }
  });
  await expect(hosted.whoami(principal, context("overflow"))).rejects.toHaveProperty("code", "bad_request");
  expect(await database.repo.hosted.all(database.repo.read)).toHaveLength(hosted.limits.global);
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
  const oauth = createOAuthServer(database.repo, { dbPath: scratchDbPath(), blobDir, httpPort: 0, googleClientId: "dev", googleClientSecret: "", orgDomain: "example.com", publicUrl: "https://grayboard.example.com", messageRetentionDays: 90, auditRetentionDays: 90, devAuth: false, admins: [], helloLimit: DEFAULT_HELLO_LIMIT, authFailLimit: DEFAULT_AUTH_FAIL_LIMIT, trustedProxies: DEFAULT_TRUSTED_PROXIES, oauthClients: [
    { clientId: "broker", name: "Broker", redirectUris: ["http://127.0.0.1/callback"], scopes: ["grayboard:tools", "grayboard:delivery"], tokenEndpointAuthMethod: "none", sessionSource: true },
    { clientId: "plain", name: "Plain", redirectUris: ["http://127.0.0.1/callback"], scopes: ["grayboard:tools", "grayboard:delivery"], tokenEndpointAuthMethod: "none" },
  ] });
  try {
    const authenticate = async (clientId: string) => {
      const issued = await issueOAuth(database.repo, oauth.resource, "you@example.com", ["grayboard:tools", "grayboard:delivery"], now, clientId);
      const p = await oauth.authenticate(new Request(oauth.resource, { headers: { Authorization: `Bearer ${issued.token}` } }));
      if (p instanceof Response) throw new Error("fixture authorization failed");
      return p;
    };
    const [broker, opencode, plain, cimd, ...builtins] = await Promise.all(["broker", OPENCODE_CLIENT, "plain", "https://client.example/client.json", ...BUILTIN_CLIENT_IDS].map(authenticate));
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
  // Every session is told what other_user and ungranted mean (security audit F-10): a poll session's reads carry them too (#825).
  const general = (_source: string | null) => () => [OTHER_USER_NOTE];
  const expected = (name: string, source: string | null, notes: string[]) => [`Bound to "${name}"; the instructions' note that this session has no bus name no longer applies.`, ...notes, ...boundInstructions(name, source, true, general(source), [])].join(" ");
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
    expect(result.structuredContent.instructions).toEqual(boundInstructions(name, source, true, general(source), []));
  }
  expect(texts["push-run"]).toContain(`<channel source="grayboard-pi" message_id="..."`);
  expect(texts["absent-run"]).toContain(`<channel source="grayboard" message_id="..."`);
  // A poll session's bind result reads as its `initialize` text does: no channel lines.
  for (const line of ["<channel", "Pushes don't survive /clear", "delivery_open"]) expect(texts["poll-run"]).not.toContain(line);
  for (const name of ["push-run", "absent-run", "poll-run"]) expect(texts[name]).toContain(OTHER_USER_NOTE);
  for (const line of COORDINATION_INSTRUCTIONS) expect(texts["poll-run"]).toContain(line);
  // Unbind's result under a remaining name carries the same general lines, the other_user line included.
  for (const [name, declared, source] of cases) {
    const ctx = sessionContext(generic, { [GRAYBOARD_SESSION_META]: name });
    await hosted.bind(generic, ctx, { name: `${name}-2`, create: true }, declared);
    const released = await hosted.unbind(generic, ctx, { name }, declared);
    const text = (released.structuredContent as { instructions: string[] }).instructions.join(" ");
    expect(text).toContain(OTHER_USER_NOTE);
  }
});

test("unbound context cannot write or implicitly create names", async () => {
  await expect(hosted.run(principal, context("one"), "dm_send", () => true)).rejects.toHaveProperty("code", "unbound");
  await expect(hosted.bind(principal, context("one"), { name: "fe" })).rejects.toHaveProperty("code", "identity_unknown");
  await expect(hosted.bind(principal, { missing: "metadata missing" }, { name: "fe", create: true })).rejects.toHaveProperty("code", "unbound");
  expect((await database.repo.aliases.listForScope(database.repo.read, "person", principal.authed.user_email))).toEqual([]);
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
  await seed(database.repo, () => claim(database.db, "you@example.com/fe", "ticket:ENG-142"));
  const root = context("root");
  if (!("id" in root)) throw new Error("fixture has no mapped source");
  await seed(database.repo, () => {
    database.db.prepare("UPDATE ids SET status = ?, status_at = ? WHERE id = ?").run("reviewing", now, root.id);
    database.db.prepare("UPDATE aliases SET queue_off = 1 WHERE address = ?").run("you@example.com/fe");
  });
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
  const sent = await hosted.run(principal, context("peer"), "dm_send", (s, tx) => application.send(tx, s, "you@example.com/fe", "owed by the root"));
  const message = `${child} is a subagent of you@example.com/fe; its root owns this inbox. dm_thread a thread you wrote to see its replies.`;
  await expect(hosted.run(principal, context("child"), "dm_inbox", (s, tx) => application.inbox(tx, s))).rejects.toMatchObject({ code: "child_session", message });
  await expect(hosted.run(principal, context("child"), "dm_ack", (s, tx) => application.acknowledgeDm(tx, s, sent.message_id))).rejects.toMatchObject({ code: "child_session", message });
  await hosted.run(principal, context("peer"), "board_create", (s, tx) => application.call(tx, s, "board_create", { name: "e2e", purpose: "test" }));
  const subs = { code: "child_session", message: `${child} is a subagent of you@example.com/fe; its root owns its board subscriptions and thread mutes. board_read reads a board without marking anything read.` };
  await expect(hosted.run(principal, context("child"), "board_subscribe", (s, tx) => application.call(tx, s, "board_subscribe", { board: "e2e", mode: "push" }))).rejects.toMatchObject(subs);
  await expect(hosted.run(principal, context("child"), "board_subscribe", (s, tx) => application.call(tx, s, "board_subscribe", { board: "e2e", mode: "off", thread: 1 }))).rejects.toMatchObject(subs);
  expect(database.db.query("SELECT COUNT(*) AS n FROM subscriptions WHERE board = 'e2e' AND handle = 'you@example.com/fe'").get()).toEqual({ n: 0 });
  expect((await hosted.run(principal, context("child"), "dm_history", (s, tx) => application.history(tx, s))).map((m) => m.id)).toEqual([sent.message_id]);
  expect((await hosted.run(principal, context("child"), "dm_thread", (s, tx) => application.thread(tx, s, sent.message_id))).map((m) => m.id)).toEqual([sent.message_id]);
  // The root's inbox still owes it, and the root's own ack settles it.
  expect((await hosted.run(principal, context("root"), "dm_inbox", (s, tx) => application.inbox(tx, s))).unanswered.map((m) => m.id)).toEqual([sent.message_id]);
  await hosted.run(principal, context("root"), "dm_ack", (s, tx) => application.acknowledgeDm(tx, s, sent.message_id));
  expect((await hosted.run(principal, context("root"), "dm_inbox", (s, tx) => application.inbox(tx, s))).unanswered).toEqual([]);
});

// #523 audit 2: under a root with no name yet, a child is offered no names to
// bind, and its write is refused naming the root, not with "bind a name first".
test("a child of an unbound root gets no bind candidates, and its write is refused naming its root", async () => {
  const { child, root } = await hosted.register(principal, context("root"), "child") as { child: string; root: string };
  const who = await hosted.whoami(principal, context("child"));
  expect(who).toMatchObject({ id: child, root, child: true, unbound: true });
  expect(who).not.toHaveProperty("candidates");
  expect(await hosted.whoami(principal, context("root"))).toHaveProperty("candidates");
  await expect(hosted.run(principal, context("child"), "dm_send", (s, tx) => application.send(tx, s, "you@example.com/be", "x")))
    .rejects.toMatchObject({ code: "unbound", message: `unbound; this session is a subagent of ${root}, which has no bus name yet. Its writes work once ${root} binds one; binding is the root's.` });
  await expect(hosted.run(principal, context("other"), "dm_send", (s, tx) => application.send(tx, s, "you@example.com/be", "x")))
    .rejects.toMatchObject({ code: "unbound", message: "unbound; bind a name first, or have this session's root register it as a child (session_register)" });
});

// #523 audit 6: a child's delegation audit rows name it under `child`, beside the routing `via`; a root's name none.
test("a child's delegate request and refusal are audited naming the child; the root's name none", async () => {
  await hosted.bind(principal, context("root"), { name: "fe", create: true });
  await hosted.bind(principal, context("peer"), { name: "be", create: true });
  const { child } = await hosted.register(principal, context("root"), "child") as { child: string };
  const ask = { persona: "a reviewer", task: "review", to: "be" };
  await expect(hosted.run(principal, context("child"), "delegate", (s, tx) => application.delegate(tx, s, ask))).rejects.toThrow("isn't a launcher session");
  await expect(hosted.run(principal, context("root"), "delegate", (s, tx) => application.delegate(tx, s, { ...ask, task: "the root's own" }))).rejects.toThrow("isn't a launcher session");
  const rows = (database.db.query("SELECT actor, target, detail FROM access_log WHERE action = 'delegation.refused' ORDER BY rowid").all() as { actor: string; target: string; detail: string }[])
    .map((r) => ({ ...r, detail: JSON.parse(r.detail) as Record<string, unknown> }));
  expect(rows.map((r) => [r.actor, r.target, r.detail.to, r.detail.child])).toEqual([
    ["you@example.com", "you@example.com/fe", "be", child],
    ["you@example.com", "you@example.com/fe", "be", undefined],
  ]);
  // be declares itself a launcher and goes live: the child's request lands, audited naming it.
  await hosted.whoami(principal, sessionContext(principal, { [OPENCODE_SESSION_META]: "peer", [GRAYBOARD_LAUNCHER_META]: true }));
  await delivery.open(principal, context("peer"));
  const sent = await hosted.run(principal, context("child"), "delegate", (s, tx) => application.delegate(tx, s, { ...ask, task: "now a launcher" }));
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
  const foreign = await seed(database.repo, tx => database.repo.users.upsertByEmail(tx, "peer@example.com", null));
  const outsider = { ...principal, authed: { user_id: foreign.id, user_email: foreign.email, kind: "user" as const, session_id: 0 } };
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
  expect((await hosted.readRow("id" in root ? root.id : ""))?.grant_id).toBe("G1");
  await expect(hosted.bind(second, root, { name: "missing" })).rejects.toHaveProperty("code", "identity_unknown");
  expect((await hosted.readRow("id" in root ? root.id : ""))?.grant_id).toBe("G1");
  await hosted.register(second, root, "child");
  expect((await hosted.readRow("id" in root ? root.id : ""))?.grant_id).toBe("G2");
});

test("durable lease deadline expires once without a contender", async () => {
  await hosted.bind(principal, context("root"), { name: "fe", create: true });
  await hosted.register(principal, context("root"), "child");
  await delivery.open(principal, context("root"));
  now += 30_001;
  await hosted.sweep(); await hosted.sweep();
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
  const sender = new AppSession(application, database.repo, principal.authed, "sender", { push: false });
  await sender.connect();
  await sender.send("you@example.com/fe", "old mailbox");
  let binding!: ReturnType<typeof hosted.bind>, finished = false;
  const issued = await paused("hosted:pending:in-gate", () => delivery.pending(principal, context("root"), lease.capability), async () => {
    binding = hosted.bind(principal, context("root"), { name: "be", create: true }).then(value => { finished = true; return value; });
    await Promise.resolve(); await Promise.resolve();
    expect(finished).toBe(false);
    expect([...(await application.holdsByOwner(database.repo.read)).values()].flat().map(a => a.slice(a.lastIndexOf("/") + 1))).toEqual(["fe"]);
  });
  await binding;
  expect(issued).toHaveLength(1);
  await expect(delivery.receipt(principal, context("root"), lease.capability, issued.map(item => item.id))).rejects.toHaveProperty("code", "not_found");
  expect(await database.repo.cursors.directFor(database.repo.read, "you@example.com/fe")).toBe(0);
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
  const sender = new AppSession(application, database.repo, principal.authed, "sender", { push: false });
  await sender.connect();
  await paused("hosted:bind:after-commit", () => hosted.bind(principal, context("root"), { name: "be", create: true }), async () => {
    await sender.send("you@example.com/fe", "not for be");
    expect(await application.aliasHolderId(application.repo.read, "you@example.com/fe")).not.toBeNull();
    expect(await application.aliasHolderId(application.repo.read, "you@example.com/be")).toBe(await application.aliasHolderId(application.repo.read, "you@example.com/fe"));
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
  expect((await database.repo.hosted.all(database.repo.read)).map(row => row.session_id)).toEqual([(context("contender") as { id: string }).id]);
});

test("a hosted root holds several names: bind adds, unbind releases one and promotes the oldest, the last leaves it owning but unbound (#451)", async () => {
  const at = (name: string) => `you@example.com/${name}`;
  for (const name of ["fe", "be", "ce"]) await hosted.bind(principal, context("root"), { name, create: true });
  const first = await hosted.whoami(principal, context("root"));
  expect(first).toMatchObject({ held: [at("fe"), at("be"), at("ce")], primary: at("fe") });
  // A repeated bind of a held name adds nothing and doesn't bump the generation.
  expect(await hosted.bind(principal, context("root"), { name: "be" })).toMatchObject({ content: [{ text: 'already bound to "be"' }] });
  const rootId = (context("root") as { id: string }).id, gen = (await database.repo.hosted.get(database.repo.read, rootId))!.bind_gen;
  await hosted.bind(principal, context("root"), { name: "be", where: "laptop" });
  expect(await database.repo.hosted.get(database.repo.read, rootId)).toMatchObject({ place: "laptop", bind_gen: gen });
  const released = await hosted.unbind(principal, context("root"), { name: "fe" });
  expect(released.content[0]!.text).toContain('Released "fe"');
  expect(released.content[0]!.text).toContain('You now send as "be"');
  expect(await hosted.whoami(principal, context("root"))).toMatchObject({ held: [at("be"), at("ce")], primary: at("be"), ownership: first.ownership });
  expect(await hosted.unbind(principal, context("root"), { name: "fe" })).toMatchObject({ content: [{ text: 'not holding "fe"' }] });
  await hosted.unbind(principal, context("root"), { name: "be" });
  await hosted.unbind(principal, context("root"), { name: "ce" });
  expect((await application.holdsByOwner(database.repo.read)).size).toBe(0);
  const unbound = await hosted.whoami(principal, context("root"));
  expect(unbound).toMatchObject({ held: [], ownership: first.ownership });
  await expect(hosted.run(principal, context("root"), "dm_send", () => true)).rejects.toHaveProperty("code", "unbound");
  // The released names' mail still queues for their next holder.
  expect(await database.repo.aliases.find(database.repo.read, at("fe"))).toBeDefined();
});

const at = (name: string) => `you@example.com/${name}`;
test("ending a hosted root releases every hold in one transaction and audits each release (#451)", async () => {
  await hosted.bind(principal, context("root"), { name: "fe", create: true });
  await hosted.bind(principal, context("root"), { name: "be", create: true });
  expect((await application.holdsByOwner(database.repo.read)).size).toBe(1);
  await hosted.end(principal, context("root"));
  expect((await application.holdsByOwner(database.repo.read)).size).toBe(0);
  expect(hostedRowCount(database.db)).toBe(0);
  expect(database.db.query("SELECT count(*) AS n FROM alias_holds").get()).toEqual({ n: 0 });
  // Another session can take either name at once.
  await hosted.bind(principal, context("other"), { name: "be", create: false });
  expect(await hosted.whoami(principal, context("other"))).toMatchObject({ primary: at("be") });
});

test("a generic-key poll root's writes_as is recorded, makes it tools-only, and a different later declaration is refused (#451)", async () => {
  const generic: OAuthPrincipal = { ...principal, clientId: "grayboard-pi", sourceKey: GRAYBOARD_SESSION_META };
  const meta = (as: string) => sessionContext(generic, { [GRAYBOARD_SESSION_META]: "poll-root", [GRAYBOARD_WRITES_AS_META]: as });
  await seed(database.repo, tx => application.hostedWritesAs(tx, generic.authed, "id:probe", "fe", true));
  const first = await hosted.whoami(generic, meta("fe"));
  expect(first).toMatchObject({ held: [], writes_as: "you@example.com/fe" });
  expect((await database.repo.hosted.all(database.repo.read)).map(r => r.writes_as)).toEqual(["you@example.com/fe"]);
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

test("a rate-limited hosted bind keeps its bind.rate_limited row after the transaction rolls back, and the streak's end is written once (#467)", async () => {
  const limited = createApplication(database.repo, { helloLimit: { burst: 1, perSec: 0.01 }, now: () => now });
  const service = createHostedSessions(limited, { now: () => now, isAuthorized: () => true }); await service.ready;
  const rows = (action: string) => (database.db.query("SELECT count(*) AS n FROM access_log WHERE action = ?").get(action) as { n: number }).n;
  try {
    await service.bind(principal, context("root"), { name: "fe", create: true });
    await expect(service.bind(principal, context("root"), { name: "be", create: true })).rejects.toHaveProperty("code", "rate_limited");
    expect(rows("bind.rate_limited")).toBe(1);
    // The bucket refills; the bind that ends the streak commits, so its row is written there and not again.
    now += 200_000;
    await service.bind(principal, context("other"), { name: "ops", create: true });
    expect(rows("bind.rate_limit_ended")).toBe(1);
    expect(service.refusalRowsLost).toBe(0);
  } finally { await service.close(); limited.stopExpiry(); }
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

test("refusal rows whose queued write fails as a whole are all counted lost, once (#961)", async () => {
  const store = database.repo.hosted;
  const { write } = store;
  let rows = 0;
  // flushQueued's body runs in a real transaction: each row fails on its own, then the whole write is refused, so a
  // row counted both ways would count twice.
  const writes = spyOn(store, "write").mockImplementation(((fn: (tx: unknown) => unknown, ...rest: unknown[]) => {
    if (!new Error().stack?.includes("flushQueued")) return (write as (...a: unknown[]) => unknown).call(store, fn, ...rest);
    return (write as (...a: unknown[]) => unknown).call(store, async (tx: Tx) => {
      // Each row's savepoint fails: flushQueued calls nothing else on its Tx.
      const failing = Object.create(tx, { savepoint: { value: async () => { rows++; throw new Error("row refused"); } } });
      await fn(failing);
      throw new Error("commit refused");
    });
  }) as typeof write);
  const quiet = spyOn(console, "error").mockImplementation(() => {});
  try {
    // The reserved name, a policy refusal: its binding row and its decision row, two rows in one flush.
    await expect(hosted.bind(principal, context("root"), { name: "human", create: true })).rejects.toHaveProperty("code", "forbidden");
    expect(rows).toBe(2);
    expect(hosted.refusalRowsLost).toBe(2);
    expect(database.db.query("SELECT event FROM binding_events WHERE event = 'refused'").all()).toHaveLength(0);
    // One diagnostic per failed row, and one for the refused write.
    expect(quiet.mock.calls.filter(([line]) => String(line).includes('"operation":"hosted.refusal_row"'))).toHaveLength(3);
  } finally { writes.mockRestore(); quiet.mockRestore(); }
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

// #807 P3 B1b: mcp.ts bindingLive judges whether a root holds a name from its stamp, read with its generation, so
// every change to a hosted root's holds must move bind_gen (or end the row). Bind and unbind here; the revoke and the
// contender's end are pinned by the tests below and above ("revoking one hosted hold", "a hosted contender").
test("#807 P3 B1b: each hosted bind or unbind that changes a root's holds moves its generation; a no-op bind doesn't", async () => {
  const gen = async () => (await database.repo.hosted.get(database.repo.read, (context("root") as { id: string }).id))!.bind_gen;
  await hosted.bind(principal, context("root"), { name: "fe", create: true });
  const g0 = await gen();
  await hosted.bind(principal, context("root"), { name: "be", create: true });
  const g1 = await gen();
  expect(g1).toBeGreaterThan(g0);
  await hosted.bind(principal, context("root"), { name: "be" });
  expect(await gen()).toBe(g1);
  await hosted.unbind(principal, context("root"), { name: "be" });
  const g2 = await gen();
  expect(g2).toBeGreaterThan(g1);
  await hosted.unbind(principal, context("root"), { name: "fe" });
  expect(await gen()).toBeGreaterThan(g2);
});

test("revoking one hosted hold releases only it, bumps the generation and closes the lease; the next whoami shows what is left (#451)", async () => {
  const team = await seed(database.repo, async (tx) => {
    const t = await database.repo.teams.create(tx, "ops", principal.authed.user_id);
    await database.repo.teams.addMember(tx, t.id, principal.authed.user_id);
    return t;
  });
  await hosted.bind(principal, context("root"), { name: "fe", create: true });
  await hosted.bind(principal, context("root"), { name: "ops/lead", create: true });
  const lease = await delivery.open(principal, context("root"));
  const before = (await database.repo.hosted.get(database.repo.read, (context("root") as { id: string }).id))!;
  await seed(database.repo, (tx) => database.repo.teams.removeMember(tx, team.id, principal.authed.user_id));
  await application.accessChanged(database.repo.read, principal.authed.user_email, "admin@example.com");
  const after = (await database.repo.hosted.get(database.repo.read, before.session_id))!;
  expect(after.bind_gen).toBeGreaterThan(before.bind_gen);
  expect(after.ownership_id).toBe(before.ownership_id);
  expect(delivery.activeLeaseCount).toBe(0); // closed by the revocation itself, before any hosted request could notice
  expect(await hosted.whoami(principal, context("root"))).toMatchObject({ held: ["you@example.com/fe"], primary: "you@example.com/fe", ownership: before.ownership_id });
  expect(database.db.query("SELECT count(*) AS n FROM access_log WHERE action = 'alias.revoked'").get()).toEqual({ n: 1 });
  await expect(delivery.receipt(principal, context("root"), lease.capability, [])).rejects.toHaveProperty("code", "not_found");
});

test("an alias revoke issued while another body holds the write queue waits behind it, then revokes and closes the lease (#807 P1b-4b)", async () => {
  const team = await seed(database.repo, async (tx) => {
    const t = await database.repo.teams.create(tx, "ops", principal.authed.user_id);
    await database.repo.teams.addMember(tx, t.id, principal.authed.user_id);
    return t;
  });
  await hosted.bind(principal, context("root"), { name: "ops/lead", create: true });
  await delivery.open(principal, context("root"));
  const before = (await database.repo.hosted.get(database.repo.read, (context("root") as { id: string }).id))!;
  await seed(database.repo, (tx) => database.repo.teams.removeMember(tx, team.id, principal.authed.user_id));
  let release!: () => void;
  const holder = queueFor(database.db).run(() => new Promise<void>(r => { release = r; }));
  const revoking = application.accessChanged(database.repo.read, principal.authed.user_email, "admin@example.com");
  expect((await database.repo.hosted.get(database.repo.read, before.session_id))!.bind_gen).toBe(before.bind_gen);
  expect(delivery.activeLeaseCount).toBe(1);
  release();
  await holder;
  await revoking;
  expect((await database.repo.hosted.get(database.repo.read, before.session_id))!.bind_gen).toBeGreaterThan(before.bind_gen);
  expect(delivery.activeLeaseCount).toBe(0);
  expect(database.db.query("SELECT count(*) AS n FROM access_log WHERE action = 'alias.revoked'").get()).toEqual({ n: 1 });
});

test("one alias revoke that throws rolls back alone, audited alias.revoke_failed; the recheck's other revokes land (#807 P1b-4b)", async () => {
  const team = await seed(database.repo, async (tx) => {
    const t = await database.repo.teams.create(tx, "ops", principal.authed.user_id);
    await database.repo.teams.addMember(tx, t.id, principal.authed.user_id);
    return t;
  });
  await hosted.bind(principal, context("root"), { name: "ops/lead", create: true });
  await hosted.bind(principal, context("other"), { name: "ops/dev", create: true });
  const ids = ["root", "other"].map(r => (context(r) as { id: string }).id);
  const before = await Promise.all(ids.map(async id => (await database.repo.hosted.get(database.repo.read, id))!.bind_gen));
  await seed(database.repo, (tx) => database.repo.teams.removeMember(tx, team.id, principal.authed.user_id));
  const lose = database.repo.hosted.lose.bind(database.repo.hosted);
  let calls = 0;
  const spy = spyOn(database.repo.hosted, "lose").mockImplementation((...args) => { if (calls++ === 0) throw new Error("bad row"); return lose(...args); });
  const error = spyOn(console, "error").mockImplementation(() => {});
  try { await application.accessChanged(database.repo.read, principal.authed.user_email, "admin@example.com"); }
  finally { spy.mockRestore(); error.mockRestore(); }
  const audits = (action: string) => database.db.query("SELECT target FROM access_log WHERE action = ?").all(action) as { target: string }[];
  expect(audits("alias.revoked")).toHaveLength(1);
  expect(audits("alias.revoke_failed")).toHaveLength(1);
  const bumped = await Promise.all(ids.map(async (id, i) => (await database.repo.hosted.get(database.repo.read, id))!.bind_gen > before[i]!));
  expect(bumped.filter(Boolean)).toHaveLength(1);
  // The failed use rolled back whole: its root still holds the alias it was to lose.
  const failedTarget = audits("alias.revoke_failed")[0]!.target;
  expect(aliasUser(database.db, failedTarget)).toBe(ids[bumped.indexOf(false)]!);
});

test("a revoked tools-only hosted root's ownership ends, audited once: a later recheck finds nothing to revoke again (#454)", async () => {
  const team = await seed(database.repo, async (tx) => {
    const t = await database.repo.teams.create(tx, "ops", principal.authed.user_id);
    await database.repo.teams.addMember(tx, t.id, principal.authed.user_id);
    return t;
  });
  const generic: OAuthPrincipal = { ...principal, clientId: "grayboard-pi", sourceKey: GRAYBOARD_SESSION_META };
  const meta = sessionContext(generic, { [GRAYBOARD_SESSION_META]: "poll-root", [GRAYBOARD_WRITES_AS_META]: "ops/lead" });
  const id = (meta as { id: string }).id;
  await seed(database.repo, tx => application.hostedWritesAs(tx, generic.authed, "id:probe", "ops/lead", true));
  expect(await hosted.whoami(generic, meta)).toMatchObject({ held: [], writes_as: "ops/lead" });
  const before = (await database.repo.hosted.get(database.repo.read, id))!;
  const audits = () => database.db.query("SELECT actor, target, detail FROM access_log WHERE action = 'alias.revoked'").all().map((r: any) => ({ ...r, detail: JSON.parse(r.detail) }));
  await seed(database.repo, (tx) => database.repo.teams.removeMember(tx, team.id, principal.authed.user_id));
  await application.accessChanged(database.repo.read, principal.authed.user_email, "admin@example.com");
  const revoked = [{ actor: "admin@example.com", target: "ops/lead", detail: { session: id, principal: "you@example.com", writes_as: true, reason: expect.any(String) } }];
  expect(audits()).toEqual(revoked);
  expect(await database.repo.hosted.get(database.repo.read, id)).toBeUndefined();
  expect(database.db.query("SELECT ended_at, end_reason FROM hosted_ownerships WHERE id = ?").get(before.ownership_id)).toMatchObject({ end_reason: "revoked" });
  expect(database.db.query("SELECT writes_as FROM ids WHERE id = ?").get(id)).toEqual({ writes_as: null });
  expect(aliasUser(database.db, "ops/lead")).toBeNull();
  // Both rechecks, the principal's and the server's sweep, find the use gone.
  await application.accessChanged(database.repo.read, principal.authed.user_email, "admin@example.com");
  await application.revalidate();
  expect(audits()).toEqual(revoked);
});

test("a hosted root holding two names sends as either with as:, its ID too, and is refused any other address (#454)", async () => {
  await hosted.bind(principal, context("root"), { name: "fe", create: true });
  await hosted.bind(principal, context("root"), { name: "be", create: true });
  await hosted.bind(principal, context("peer"), { name: "peer", create: true });
  const id = (context("root") as { id: string }).id;
  const send = (as: string | undefined, body: string) => hosted.run(principal, context("root"), "dm_send", (s, tx) => application.send(tx, s, "peer", body, as === undefined ? {} : { as }));
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
  const team = await seed(database.repo, async (tx) => {
    const t = await database.repo.teams.create(tx, "ops", principal.authed.user_id);
    await database.repo.teams.addMember(tx, t.id, principal.authed.user_id);
    return t;
  });
  const id = (raw: string) => (context(raw) as { id: string }).id;
  await hosted.bind(principal, context("revoked"), { name: "ops/lead", create: true });
  await delivery.open(principal, context("revoked"));
  await hosted.bind(principal, context("unbound"), { name: "fe", create: true });
  await delivery.open(principal, context("unbound"));
  await hosted.unbind(principal, context("unbound"), { name: "fe" });
  await seed(database.repo, (tx) => database.repo.teams.removeMember(tx, team.id, principal.authed.user_id));
  await application.accessChanged(database.repo.read, principal.authed.user_email, "admin@example.com");
  expect(delivery.activeLeaseCount).toBe(0);
  for (const raw of ["revoked", "unbound"]) expect(await database.repo.hosted.get(database.repo.read, id(raw))).toMatchObject({ lease_deadline: null });
  now += 300_000; // past any lease, short of the idle window
  await hosted.sweep();
  for (const raw of ["revoked", "unbound"]) expect(await database.repo.hosted.get(database.repo.read, id(raw))).toBeDefined();
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
  expect(await database.repo.hosted.get(database.repo.read, (ctx("root") as { id: string }).id)).toMatchObject({ suggested: "grayboard-gb-aux" });
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
  expect(await database.repo.hosted.get(database.repo.read, id)).toMatchObject({ suggested: "second" });
  await hosted.end(principal, ctx("root"));
  await hosted.whoami(principal, ctx("root"));
  expect(await database.repo.hosted.get(database.repo.read, id)).toMatchObject({ suggested: null });
  expect(started().map(d => d.suggested)).toEqual(["grayboard-gb-aux", "second", undefined]);
  // A child row's is null, whatever its requests suggest: a child never binds.
  await hosted.register(principal, ctx("root"), "suggest-child");
  const child = ctx("suggest-child", "kid");
  await hosted.whoami(principal, child);
  expect(await database.repo.hosted.get(database.repo.read, (child as { id: string }).id)).toMatchObject({ suggested: null, root_session_id: id });
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
  expect(hostedBoundInstruction(info, undefined, true, true)).toContain("You're a launcher session");
  expect(hostedBoundInstruction(info)).not.toContain("You're a launcher session");
  // A service's launcher names its own service's handles, not "your own user's" (#1327); a person's keeps its text.
  expect(hostedBoundInstruction(info, undefined, true, true, true)).toContain("from one of your own service's handles (never its owner's or an invoker's)");
  expect(hostedBoundInstruction(info, undefined, true, true, true)).not.toContain("your own user's handle");
  expect(hostedBoundInstruction(info, undefined, true, true)).toContain("from your own user's handle");
  // The requester is a third session of the same user: the declared launcher takes the request, the other is not a target.
  await hosted.bind(generic, ctx("req-root"), { name: "req", create: true });
  const result = await hosted.run(generic, ctx("req-root"), "delegate", (session, tx) => application.delegate(tx, session, { persona: "researcher", task: "inspect it" }));
  expect(result).toMatchObject({ to: "you@example.com/lead" });
  await expect(hosted.run(generic, ctx("req-root"), "delegate", (session, tx) => application.delegate(tx, session, { persona: "researcher", task: "inspect it", to: "plain" }))).rejects.toThrow("isn't a launcher session");
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

// #521 4 / #532 4: a declared launcher counts only while its delivery is live. Declared but with no lease (an
// unenrolled or polling root), it's neither auto-picked nor accepted by name; once its delivery opens, it is.
test("a declared launcher with no live delivery is no delegation target until its delivery opens (#521 4)", async () => {
  const generic: OAuthPrincipal = { ...principal, clientId: "grayboard-pi", sourceKey: GRAYBOARD_SESSION_META };
  const ctx = (raw: string, extra: Record<string, unknown> = {}) => sessionContext(generic, { [GRAYBOARD_SESSION_META]: raw, ...extra });
  const lead = ctx("idle-lead", { [GRAYBOARD_LAUNCHER_META]: true });
  await hosted.bind(generic, lead, { name: "idle-lead", create: true });
  await hosted.bind(generic, ctx("idle-req"), { name: "idle-req", create: true });
  const delegate = (to?: string) => hosted.run(generic, ctx("idle-req"), "delegate", (session, tx) => application.delegate(tx, session, { persona: "researcher", task: `t ${to ?? "auto"}`, ...(to ? { to } : {}) }));
  await expect(delegate("idle-lead")).rejects.toThrow('"you@example.com/idle-lead" is a launcher but offline');
  await expect(delegate()).rejects.toThrow("no live launcher session");
  await delivery.open(generic, lead);
  expect(await delegate("idle-lead")).toMatchObject({ to: "you@example.com/idle-lead" });
  expect(await delegate()).toMatchObject({ to: "you@example.com/idle-lead" });
  // A launcher declared poll is told nothing about launching: its bind text carries no launcher lines.
  const polled = await hosted.bind(generic, ctx("poll-lead", { [GRAYBOARD_LAUNCHER_META]: true }), { name: "poll-lead", create: true }, { mode: "poll", source: "x" });
  expect((polled.structuredContent as { instructions: string[] }).instructions.join(" ")).not.toContain("You're a launcher session");
});

test("a bound session with no delivery declaration (OpenCode) gets initialize text that follows its lease, as bind's does; a declaration still decides (#531)", () => {
  const info = { identity_full: "you@example.com/fe", teams: [], human: { linked: false } } as never;
  const channel = `<channel source="${DEFAULT_CHANNEL_SOURCE}"`;
  const note = `No delivery lease is open for this session, so DMs to "you@example.com/fe" wait until the client opens one (delivery_open).`;
  // Lease open: pushed, with the default source, and no poll or lease note.
  const leased = hostedBoundInstruction(info, undefined, false, true);
  expect(leased).toContain(channel);
  expect(leased).toContain(OTHER_USER_NOTE);
  for (const line of ["Poll dm_inbox", "delivery_open", "You're a launcher session"]) expect(leased).not.toContain(line);
  // No lease: it polls, and says why nothing is pushed yet.
  const unleased = hostedBoundInstruction(info);
  expect(unleased).toContain("Poll dm_inbox");
  expect(unleased).toContain(note);
  expect(unleased).not.toContain("<channel");
  expect(unleased).toContain(OTHER_USER_NOTE);
  // The launcher lines ride only a pushed session, and only with the flag: a polling launcher is never a
  // delegation target (#521 4).
  expect(hostedBoundInstruction(info, undefined, true, true)).toContain("You're a launcher session");
  expect(hostedBoundInstruction(info, { mode: "push", source: "pi" }, true, false)).toContain("You're a launcher session");
  expect(hostedBoundInstruction(info, undefined, true, false)).not.toContain("You're a launcher session");
  expect(hostedBoundInstruction(info, { mode: "poll", source: "x" }, true, true)).not.toContain("You're a launcher session");
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
  now += 900_001; await hosted.sweep();
  const parked = childAudits("hosted.child_parked");
  expect(parked).toHaveLength(hosted.limits.children);
  expect(parked.every(a => a.target === hostedId("root") && a.idle_ms > 900_000)).toBe(true);
  expect((await database.repo.hosted.all(database.repo.read)).filter(r => r.root_session_id)).toHaveLength(0);
  expect(await database.repo.hosted.children(database.repo.read, hostedId("root"))).toHaveLength(hosted.limits.children);
  await hosted.register(principal, context("root"), "overflow");
  expect((await database.repo.hosted.get(database.repo.read, hostedId("overflow")))?.parked_at).toBeNull();
  expect(await hosted.whoami(principal, context("root"))).toHaveProperty("primary", "you@example.com/be");
});

test("a parked child's next call runs as its root's child under the same ownership, audited (#566)", async () => {
  await hosted.bind(principal, context("root"), { name: "be", create: true });
  await hosted.register(principal, context("root"), "child");
  const ownerships = () => database.db.query<{ n: number }, []>("SELECT count(*) AS n FROM hosted_ownerships").get()!.n;
  const before = ownerships();
  now += 900_001; await hosted.sweep();
  expect((await database.repo.hosted.get(database.repo.read, hostedId("child")))?.parked_at).not.toBeNull();
  await hosted.run(principal, context("child"), "dm_send", (session, tx) => application.send(tx, session, "be", "after parking"));
  expect(database.db.query("SELECT sender_id FROM messages WHERE body='after parking'").get()).toEqual({ sender_id: hostedId("child") });
  const row = (await database.repo.hosted.get(database.repo.read, hostedId("child")))!;
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
  expect((await database.repo.hosted.get(database.repo.read, hostedId("child")))?.last_seen_at).toBe(now);
  now += 600_000; await hosted.sweep();
  expect((await database.repo.hosted.get(database.repo.read, hostedId("child")))?.parked_at).toBeNull();
  now += 900_001; await hosted.sweep();
  expect((await database.repo.hosted.get(database.repo.read, hostedId("child")))?.parked_at).not.toBeNull();
  expect(await hosted.register(principal, context("root"), "child")).toEqual({ message: "already registered" });
  expect(await database.repo.hosted.get(database.repo.read, hostedId("child"))).toMatchObject({ parked_at: null, last_seen_at: now });
  expect(childAudits("hosted.child_unparked")).toHaveLength(1);
});

test("an unpark at full child capacity is refused and leaves the child parked; its session_end still ends it (#566)", async () => {
  await hosted.bind(principal, context("root"), { name: "be", create: true });
  await hosted.register(principal, context("root"), "sleeper");
  now += 900_001; await hosted.sweep();
  for (let i = 0; i < hosted.limits.children; i++) await hosted.register(principal, context("root"), `child-${i}`);
  await expect(hosted.whoami(principal, context("sleeper"))).rejects.toHaveProperty("code", "bad_request");
  expect((await database.repo.hosted.get(database.repo.read, hostedId("sleeper")))?.parked_at).not.toBeNull();
  expect(childAudits("hosted.child_unparked")).toHaveLength(0);
  expect(await hosted.end(principal, context("sleeper"))).toEqual({ ended: true });
  expect(await database.repo.hosted.get(database.repo.read, hostedId("sleeper"))).toBeUndefined();
  expect(await database.repo.hosted.children(database.repo.read, hostedId("root"))).toHaveLength(hosted.limits.children);
});

test("a parked child goes with its root's ownership; it and an ended child start as roots when they call again (#566)", async () => {
  await hosted.bind(principal, context("root"), { name: "be", create: true });
  await hosted.register(principal, context("root"), "parked");
  await hosted.register(principal, context("root"), "ended");
  await hosted.end(principal, context("ended"));
  now += 900_001; await hosted.sweep();
  await hosted.end(principal, context("root"));
  expect(await database.repo.hosted.get(database.repo.read, hostedId("parked"))).toBeUndefined();
  for (const raw of ["parked", "ended"]) {
    expect(await hosted.whoami(principal, context(raw))).toHaveProperty("unbound", true);
    expect(await database.repo.hosted.get(database.repo.read, hostedId(raw))).toMatchObject({ root_session_id: null, parked_at: null });
  }
});

test("a root that holds parked children can't become a child (#566)", async () => {
  await hosted.register(principal, context("middle"), "leaf");
  now += 600_000; await hosted.whoami(principal, context("middle"));
  now += 300_001; await hosted.sweep();
  expect((await database.repo.hosted.get(database.repo.read, hostedId("leaf")))?.parked_at).not.toBeNull();
  await expect(hosted.register(principal, context("top"), "middle")).rejects.toHaveProperty("code", "has_children");
});

test("after an outage past the window the startup sweep parks children; each returning one unparks once (#566 audit 2)", async () => {
  await hosted.bind(principal, context("root"), { name: "be", create: true });
  await hosted.register(principal, context("root"), "child");
  await hosted.close();
  now += 900_001;
  hosted = createHostedSessions(application, { now: () => now, isAuthorized: () => authorized }); await hosted.ready;
  expect((await database.repo.hosted.get(database.repo.read, hostedId("child")))?.parked_at).toBe(now);
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
  now += 900_001; await hosted.sweep();
  expect((await database.repo.hosted.children(database.repo.read, hostedId("root"))).filter(r => r.parked_at !== null)).toHaveLength(2);
  await hosted.register(principal, context("root"), "third");
  now += 900_001; await hosted.sweep();
  expect(await database.repo.hosted.get(database.repo.read, hostedId("first"))).toBeUndefined();
  expect((await database.repo.hosted.children(database.repo.read, hostedId("root"))).map(r => r.session_id).sort()).toEqual([hostedId("second"), hostedId("third")].sort());
  expect(childAudits("hosted.child_parked").map(a => a.child)).toEqual([hostedId("first"), hostedId("second"), hostedId("third")]);
  expect(childAudits("hosted.child_released")).toEqual([expect.objectContaining({ target: hostedId("root"), child: hostedId("first"), reason: "evicted" })]);
  expect(await hosted.whoami(principal, context("first"))).toHaveProperty("unbound", true);
  expect(await database.repo.hosted.get(database.repo.read, hostedId("first"))).toMatchObject({ root_session_id: null, parked_at: null });
});

test("children parked in one sweep past the ceiling are evicted by last activity, then ID (#584)", async () => {
  hosted.limits.parked = 1;
  await hosted.bind(principal, context("root"), { name: "be", create: true });
  for (const raw of ["c", "a", "b"]) await hosted.register(principal, context("root"), raw);
  // Past the touch window (5 s, #912): activity inside it doesn't move last_seen_at.
  now += 10_000; await hosted.whoami(principal, context("c"));
  now += 900_001; await hosted.sweep();
  expect((await database.repo.hosted.children(database.repo.read, hostedId("root"))).map(r => r.session_id)).toEqual([hostedId("c")]);
  const evicted = childAudits("hosted.child_released").map(a => a.child);
  expect(evicted).toEqual([hostedId("a"), hostedId("b")].sort());
  // Parked and evicted in one sweep: both audits.
  expect(childAudits("hosted.child_parked").map(a => a.child).sort()).toEqual([hostedId("a"), hostedId("b"), hostedId("c")].sort());
});

test("a refused unpark, new register and convert each say local mode's child-capacity text (#584)", async () => {
  await hosted.bind(principal, context("root"), { name: "be", create: true });
  await hosted.register(principal, context("root"), "sleeper");
  now += 900_001; await hosted.sweep();
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
const rowOf = async (c: ReturnType<typeof context>) => { if (!("id" in c)) throw new Error("fixture context"); return await database.repo.hosted.get(database.repo.read, c.id); };

test("a child's call past the idle window neither parks it nor ends its unheld root; the window restarts at the call's end (#584)", async () => {
  const { generic, meta } = toolsOnly();
  await seed(database.repo, tx => application.hostedWritesAs(tx, generic.authed, "id:probe", "fe", true));
  await hosted.whoami(generic, meta("root", "fe"));
  await hosted.register(generic, meta("root", "fe"), "kid");
  const during = await hosted.transfer(generic, meta("kid"), async () => {
    now += 900_001; await hosted.sweep();
    return { kid: (await rowOf(meta("kid")))?.parked_at, root: await rowOf(meta("root", "fe")) !== undefined };
  });
  expect(during).toEqual({ kid: null, root: true });
  expect((await rowOf(meta("kid")))?.last_seen_at).toBe(now);
  expect((await rowOf(meta("root", "fe")))?.last_seen_at).toBe(now);
  now += 600_000; await hosted.sweep();
  expect((await rowOf(meta("kid")))?.parked_at).toBeNull();
  expect(childAudits("hosted.child_parked")).toHaveLength(0);
  expect(hosted.inflightCount).toBe(0);
});

test("an unheld root's own call past the idle window doesn't end it (#584)", async () => {
  const { generic, meta } = toolsOnly();
  await seed(database.repo, tx => application.hostedWritesAs(tx, generic.authed, "id:probe", "fe", true));
  await hosted.whoami(generic, meta("root", "fe"));
  const alive = await hosted.transfer(generic, meta("root", "fe"), async () => { now += 900_001; await hosted.sweep(); return await rowOf(meta("root", "fe")) !== undefined; });
  expect(alive).toBe(true);
  expect((await rowOf(meta("root", "fe")))?.last_seen_at).toBe(now);
});

test("a bind of a name whose holder is mid-call past the idle window doesn't end the holder (#584)", async () => {
  await hosted.bind(principal, context("root"), { name: "be", create: true });
  const taken = await hosted.transfer(principal, context("root"), async () => {
    now += 900_001;
    return hosted.bind(principal, context("other"), { name: "be", create: false }).then(() => "bound", (e: { code?: string }) => e.code ?? "error");
  });
  expect(taken).not.toBe("bound");
  expect(await rowOf(context("root"))).toBeDefined();
  expect(database.db.query("SELECT id FROM alias_holds WHERE address = 'you@example.com/be'").get()).toEqual({ id: hostedId("root") });
});

test("a call whose root's ownership ended and restarted before it returns keeps its result and leaves the new ownership as it is (#584)", async () => {
  await hosted.bind(principal, context("root"), { name: "be", create: true });
  const before = (await rowOf(context("root")))!.ownership_id;
  const value = await hosted.control(principal, context("root"), false, async () => {
    await seed(database.repo, () => database.db.run("UPDATE users SET disabled_at = ? WHERE id = ?", [now, principal.authed.user_id]));
    await hosted.sweep();
    await seed(database.repo, () => database.db.run("UPDATE users SET disabled_at = NULL WHERE id = ?", [principal.authed.user_id]));
    now += 1000;
    await hosted.whoami(principal, context("root"));
    return "done";
  });
  expect(value).toBe("done");
  const after = (await rowOf(context("root")))!;
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
  const seen = (await database.repo.hosted.get(database.repo.read, root.id))!.last_seen_at;
  await hosted.close();
  // 20 minutes down: without the credit, the unbound root is past the 15-minute idle window at startup.
  now += 20 * 60_000;
  hosted = createHostedSessions(application, { now: () => now, isAuthorized: () => authorized }); await hosted.ready;
  expect((await database.repo.hosted.get(database.repo.read, root.id))?.last_seen_at).toBe(now);
  expect(creditRows()).toEqual([expect.objectContaining({ field: "last_seen_at", before: seen, after: now, downtime_ms: 20 * 60_000 })]);
  expect(lastStart()).toMatchObject({ credited: 1 });
});

test("a disabled user's root earns no restart credit", async () => {
  const root = context("disabled-root");
  if (!("id" in root)) throw new Error("fixture context");
  await hosted.bind(principal, root, { name: "be", create: true });
  await delivery.open(principal, root);
  expect((await database.repo.hosted.get(database.repo.read, root.id))?.lease_deadline).not.toBeNull();
  await hosted.close();
  await seed(database.repo, () => database.db.run("UPDATE users SET disabled_at = ? WHERE id = ?", [now, principal.authed.user_id]));
  now += 5 * 60_000;
  hosted = createHostedSessions(application, { now: () => now, isAuthorized: () => authorized }); await hosted.ready;
  expect(creditRows()).toEqual([]);
  expect(lastStart()).toMatchObject({ downtime_ms: 5 * 60_000, credited: 0 });
  expect(await database.repo.hosted.get(database.repo.read, root.id)).toBeUndefined();
});

test("the heartbeat follows a clock that steps backwards", async () => {
  now += 5_000;
  await until(async () => await database.repo.hosted.aliveAt(database.repo.read) === now, 5_000);
  // Less than a heartbeat interval behind the last beat: only the t < beat branch writes it.
  now -= 500;
  await until(async () => await database.repo.hosted.aliveAt(database.repo.read) === now, 5_000);
});

test("a failed heartbeat write is reported and retried on the next tick", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const write = spyOn(database.repo.hosted, "heartbeat").mockImplementation(() => { throw new Error("disk full"); });
  try {
    const before = await database.repo.hosted.aliveAt(database.repo.read);
    now += 5_000;
    await until(() => errors.mock.calls.some(call => String(call[0]).includes('"operation":"hosted.heartbeat"')), 5_000);
    expect(await database.repo.hosted.aliveAt(database.repo.read)).toBe(before);
    write.mockRestore();
    // The fake clock stands still: a failure that had advanced the beat would never write again.
    await until(async () => await database.repo.hosted.aliveAt(database.repo.read) === now, 5_000);
  } finally { write.mockRestore(); errors.mockRestore(); }
});

// #475 items 1 and 7a: a released child's ID ends with the release's own reason, and an ID that comes back
// as a root reopens its row, so every session holding an alias has an unended row (revocation,
// deletion and retention all filter on ended_at IS NULL).
const idEnd = (id: string) => database.db.query<{ ended_at: number | null }, [string]>("SELECT ended_at FROM ids WHERE id = ?").get(id)?.ended_at ?? null;
const endedWhy = (id: string) => childAudits("id.ended").filter(a => a.target === id).map(a => a.why);
test("a released child's ID ends with the release's reason, not at the next start (#475 item 1)", async () => {
  hosted.limits.parked = 1;
  await hosted.bind(principal, context("root"), { name: "be", create: true });
  for (const raw of ["closed", "evicted", "kept"]) { await hosted.register(principal, context("root"), raw); now += 1000; }
  await hosted.end(principal, context("closed"));
  expect(idEnd(hostedId("closed"))).toBe(now);
  expect(endedWhy(hostedId("closed"))).toEqual(["closed"]);
  now += 900_001; await hosted.sweep();
  expect(await database.repo.hosted.get(database.repo.read, hostedId("evicted"))).toBeUndefined();
  expect(endedWhy(hostedId("evicted"))).toEqual(["evicted"]);
  // A root's end takes its children with it, each ended with the root's reason.
  await hosted.end(principal, context("root"));
  expect(endedWhy(hostedId("kept"))).toEqual(["closed"]);
  expect(idEnd(hostedId("root"))).toBeNull();
  // Nothing is left for the startup sweep to label a WSS leftover.
  await hosted.close(); application.stopExpiry();
  application = createApplication(database.repo);
  hosted = createHostedSessions(application, { now: () => now, isAuthorized: () => authorized }); await hosted.ready;
  expect(childAudits("id.ended").filter(a => a.why === "wss_removed")).toEqual([]);
});

test("an ended ID that comes back as a root reopens its row, audited, and its alias is revocable (#475 item 7a)", async () => {
  await hosted.bind(principal, context("root"), { name: "be", create: true });
  await hosted.register(principal, context("root"), "child");
  await hosted.end(principal, context("child"));
  // A row an earlier release ended at a restart (`wss_removed`) reopens the same way.
  const endedAt = now - 60_000;
  await seed(database.repo, () => database.db.run("UPDATE ids SET ended_at = ? WHERE id = ?", [endedAt, hostedId("child")]));
  now += 1000;
  await hosted.bind(principal, context("child"), { name: "fe", create: true });
  expect(idEnd(hostedId("child"))).toBeNull();
  expect(database.db.query("SELECT held_aliases_json, root_id FROM ids WHERE id = ?").get(hostedId("child"))).toEqual({ held_aliases_json: null, root_id: null });
  expect(childAudits("id.reopened")).toEqual([expect.objectContaining({ target: hostedId("child"), ended_at: endedAt })]);
  expect(aliasUser(database.db, "you@example.com/fe")).toBe(hostedId("child"));
});

// #399: a request's hosted bookkeeping reads O(its own rows), not O(the fleet). The row lists the store hands back
// during one call are counted with 3 and with 40 unrelated bound roots; the totals must match.
async function rowsReadDuring(call: () => Promise<unknown>) {
  const store = database.repo.hosted;
  const listing = ["all", "expired", "idle", "disabled", "children"] as const;
  let read = 0;
  const spies = listing.map(name => spyOn(store, name).mockImplementation(((original: (...a: unknown[]) => Promise<unknown[]>) => async (...a: unknown[]) => {
    const rows = await original(...a); read += rows.length; return rows;
  })((store[name] as (...a: unknown[]) => Promise<unknown[]>).bind(store)) as never));
  try { await call(); }
  finally { for (const spy of spies) spy.mockRestore(); }
  return read;
}
async function withOthers(others: number, tag: string, measure: () => Promise<number>) {
  for (let i = 0; i < others; i++) await hosted.bind(principal, context(`${tag}-${others}-${i}`), { name: `${tag}-${others}-${i}`, create: true });
  const read = await measure();
  for (let i = 0; i < others; i++) await hosted.end(principal, context(`${tag}-${others}-${i}`));
  return read;
}
test("one hosted call reads the same rows however many other sessions exist (#399)", async () => {
  async function rowsRead(others: number) {
    return withOthers(others, "other", async () => {
      const caller = context(`caller-${others}`);
      await hosted.bind(principal, caller, { name: `caller-${others}`, create: true });
      const read = await rowsReadDuring(() => hosted.run(principal, caller, "dm_history", session => session.identityFull));
      await hosted.end(principal, caller);
      return read;
    });
  }
  const few = await rowsRead(3), many = await rowsRead(40);
  expect(many).toBe(few);
});

// #805: admitting a new session counts the user's and the server's rows rather than listing them.
test("admitting a new session reads the same rows however many other sessions exist (#805)", async () => {
  async function rowsRead(others: number) {
    return withOthers(others, "admit", async () => {
      const caller = context(`fresh-${others}`);
      const read = await rowsReadDuring(() => hosted.whoami(principal, caller));
      expect(await database.repo.hosted.get(database.repo.read, hostedId(`fresh-${others}`))).toBeDefined();
      await hosted.end(principal, caller);
      return read;
    });
  }
  const few = await rowsRead(3), many = await rowsRead(40);
  expect(many).toBe(few);
});

// #399: the timer, not the request, ends idle rows; a request refused at capacity sweeps first (at most once a
// tick) and is admitted when the sweep freed a row.
test("a user at capacity with idle rows is admitted after the refusal's re-sweep, at most once per tick (#399)", async () => {
  for (let i = 0; i < hosted.limits.user; i++) await hosted.whoami(principal, context(`unbound-${i}`));
  const idle = spyOn(database.repo.hosted, "idle");
  try {
    now += 1_000;
    const counted = refusalCount("hosted_session");
    await expect(hosted.whoami(principal, context("refused-1"))).rejects.toHaveProperty("code", "bad_request");
    expect(refusalCount("hosted_session")).toBe(counted + 1);
    const swept = idle.mock.calls.length;
    expect(swept).toBeGreaterThan(0);
    await expect(hosted.whoami(principal, context("refused-2"))).rejects.toHaveProperty("code", "bad_request");
    expect(idle.mock.calls.length).toBe(swept);
    now += 900_001;
    await hosted.whoami(principal, context("admitted"));
    expect(idle.mock.calls.length).toBeGreaterThan(swept);
    expect(await database.repo.hosted.get(database.repo.read, hostedId("admitted"))).toBeDefined();
  } finally { idle.mockRestore(); }
});

test("a configured per-user session cap admits past the default and refuses at its size (#805 F-06)", async () => {
  await hosted.close();
  hosted = createHostedSessions(application, { now: () => now, isAuthorized: () => authorized, caps: { global: 4096, perUser: 300 } }); await hosted.ready;
  expect(hosted.limits).toMatchObject({ user: 300, global: 4096 });
  for (let i = 0; i < 300; i++) await hosted.whoami(principal, context(`unbound-${i}`));
  expect(hostedRowCount(database.db)).toBe(300);
  await expect(hosted.whoami(principal, context("overflow"))).rejects.toHaveProperty("code", "bad_request");
});

test("#881: a request reads its row once and skips its own user's disabled read; the sweep's settle still ends a disabled user's root", async () => {
  const { Database } = await import("bun:sqlite");
  const root = context("one-read");
  if (!("id" in root)) throw new Error("fixture context");
  await hosted.bind(principal, root, { name: "be", create: true });
  const query = spyOn(Database.prototype, "query");
  try {
    const count = (sql: string) => query.mock.calls.filter(([s]) => String(s) === sql).length;
    const rowReads = () => count("SELECT * FROM hosted_sessions WHERE session_id = ?"), userReads = () => count(USER_BY_ID_SQL);
    query.mockClear();
    await hosted.whoami(principal, root);
    // withGate's before-gate read and settle's (rowFor reuses it); the call ends inside the touch window, so its end
    // opens no transaction (#998). Before #881, four and one user read; before #998, three.
    expect(rowReads()).toBe(2);
    expect(userReads()).toBe(0);
    // Positive case: settle with no authorized user (the sweep's and mcp authorize's) still reads, and ends.
    await seed(database.repo, () => database.db.run("UPDATE users SET disabled_at = ? WHERE id = ?", [now, principal.authed.user_id]));
    query.mockClear();
    await seed(database.repo, tx => hosted.settle(tx, root.id));
    expect(userReads()).toBe(1);
    expect(await database.repo.hosted.get(database.repo.read, root.id)).toBeUndefined();
  } finally { query.mockRestore(); }
});

test("#881: a settle that ends a lapsed root stands when the same request is then refused", async () => {
  const lapsed = context("lapsed"), other = context("other");
  if (!("id" in lapsed)) throw new Error("fixture context");
  await hosted.bind(principal, lapsed, { name: "be", create: true });
  await delivery.open(principal, lapsed);
  await hosted.whoami(principal, other);
  delivery.close(); await hosted.close();
  hosted = createHostedSessions(application, { now: () => now, isAuthorized: () => authorized, caps: { global: 4096, perUser: 1 } }); await hosted.ready;
  delivery = createDelivery(hosted, { isAuthorized: () => authorized });
  await seed(database.repo, () => database.db.run("UPDATE hosted_sessions SET lease_deadline = ? WHERE session_id = ?", [now - 1, lapsed.id]));
  // settle ends the lapsed root; rowFor then starts a new row there, which the one-row cap refuses.
  await expect(hosted.whoami(principal, lapsed)).rejects.toHaveProperty("code", "bad_request");
  expect(await database.repo.hosted.get(database.repo.read, lapsed.id)).toBeUndefined();
  expect(hostedRowCount(database.db)).toBe(1);
});

test("#902: a bound native call reads its root's holds once, for the bound check and its session alike", async () => {
  const { Database } = await import("bun:sqlite");
  const root = context("one-holds");
  if (!("id" in root)) throw new Error("fixture context");
  await hosted.bind(principal, root, { name: "be", create: true });
  // `prepare(sql)` hands out the connection's cached statement through `query` (#912).
  const prepare = spyOn(Database.prototype, "query");
  try {
    await hosted.run(principal, root, "dm_send", (session, tx) => application.send(tx, session, "be", "held once"));
    // Before #902, named() and snapshot() each read them: two.
    expect(prepare.mock.calls.filter(([s]) => String(s) === "SELECT address FROM alias_holds WHERE id = ? ORDER BY bound_at, address").length).toBe(1);
  } finally { prepare.mockRestore(); }
});

// #907: a native tool call's gate reuses its exchange's verdict (`run`'s `prior`) only while the rows still read as
// the exchange left them. Each change in the window between the two gates ends as it does with no verdict at all:
// the same refusal, recovery, unpark and sender.
const windows: [string, (m: { root: string; child: string; other: string; name: string }) => Promise<void> | void][] = [
  ["nothing", () => {}],
  // The child alone goes idle: the root stays live (touched, its lease renewed), so a miss here is the child's.
  ["the child parked", async ({ root, child }) => { now += 900_001; await keepLive(root); await hosted.sweep(); const row = await database.repo.hosted.get(database.repo.read, hostedId(child)); expect(row).toBeDefined(); expect(row!.parked_at).not.toBeNull(); }],
  ["the root's lease lapsed", async ({ root }) => { await seed(database.repo, () => database.db.run("UPDATE hosted_sessions SET lease_deadline = ? WHERE session_id = ?", [now - 1, hostedId(root)])); }],
  ["the root's generation moved", async ({ root }) => { await seed(database.repo, async tx => { const r = (await database.repo.hosted.get(tx, hostedId(root)))!; return database.repo.hosted.update(tx, r.session_id, { bind_gen: r.bind_gen + 1 }); }); }],
  ["the root ended and started again", async ({ root }) => { await hosted.end(principal, context(root)); await hosted.whoami(principal, context(root)); }],
  ["the child moved to another root", async ({ root, other, child }) => { await hosted.end(principal, context(root), hostedId(child)); await hosted.register(principal, context(other), child); }],
  ["the child's idle window passed", async ({ root, child }) => { now += 900_001; await keepLive(root); expect(await database.repo.hosted.get(database.repo.read, hostedId(child))).toBeDefined(); }],
];
function keepLive(root: string) {
  return seed(database.repo, async tx => {
    await database.repo.hosted.touch(tx, hostedId(root), now);
    database.db.run("UPDATE hosted_sessions SET lease_deadline = ? WHERE session_id = ? AND lease_deadline IS NOT NULL", [now + 30_000, hostedId(root)]);
  });
}
for (const [change, apply] of windows) for (const caller of ["root", "child"] as const) {
  test(`#907: a ${caller}'s call with its exchange's verdict ends as one without it when, between the gates, ${change}`, async () => {
    const outcome = async (mode: "prior" | "full", parkedFirst: boolean) => {
      const tag = `${mode}-${parkedFirst ? "p" : "a"}`;
      const m = { root: `root-${tag}`, child: `child-${tag}`, other: `other-${tag}`, name: `be-${tag}` };
      await hosted.bind(principal, context(m.root), { name: m.name, create: true });
      await hosted.bind(principal, context(m.other), { name: `${m.name}-other`, create: true });
      // A lease would lapse over the parking's idle window and end the root with it.
      if (!parkedFirst) await delivery.open(principal, context(m.root));
      await hosted.register(principal, context(m.root), m.child);
      const self = caller === "root" ? m.root : m.child;
      if (parkedFirst) { now += 900_001; await hosted.sweep(); }
      const { verdict } = await hosted.snapshot(principal, context(self), false);
      await apply(m);
      const body = `${mode} ${change} ${caller} ${parkedFirst}`;
      // Row reads, locked or not (#807 P3 C8a: settle and fence read with `lock`).
      const get = spyOn(database.repo.hosted, "get"), lock = spyOn(database.repo.hosted, "lock");
      const result = await hosted.run(principal, context(self), "dm_send", (session, tx) => application.send(tx, session, m.name, body), undefined, mode === "prior" ? verdict : undefined)
        .then(() => "ok", (e: { code?: string }) => e.code ?? "error").finally(() => { reads.push(get.mock.calls.length + lock.mock.calls.length); get.mockRestore(); lock.mockRestore(); });
      const sent = database.db.query<{ sender_id: string }, [string]>("SELECT sender_id FROM messages WHERE body = ?").get(body)?.sender_id;
      const row = await database.repo.hosted.get(database.repo.read, hostedId(self));
      return { result, sender: sent === undefined ? null : sent === hostedId(self), parked: row?.parked_at ?? null, root: row?.root_session_id === null ? "self" : row?.root_session_id === hostedId(m.root) ? "root" : row?.root_session_id === hostedId(m.other) ? "other" : "none", inflight: hosted.inflightCount };
    };
    const reads: number[] = [];
    for (const parkedFirst of caller === "child" ? [false, true] : [false]) {
      reads.length = 0;
      const full = await outcome("full", parkedFirst);
      expect(await outcome("prior", parkedFirst)).toEqual(full);
      // With nothing changed, the verdict stands in for the full gate's settle and rowFor: fewer row reads.
      if (change === "nothing" && !parkedFirst) expect(reads[1]).toBeLessThan(reads[0]);
    }
  });
}

test("a call within the touch window leaves last_seen_at; one past it moves it, and the window shrinks to a tenth of a short idle (#912)", async () => {
  await hosted.bind(principal, context("root"), { name: "be", create: true });
  const seen = async (raw: string) => (await database.repo.hosted.get(database.repo.read, hostedId(raw)))!.last_seen_at;
  const touches = spyOn(database.repo.hosted, "touch");
  const start = await seen("root");
  now += 4_999; await hosted.whoami(principal, context("root"));
  expect(await seen("root")).toBe(start);
  expect(touches).not.toHaveBeenCalled();
  now += 1; await hosted.whoami(principal, context("root"));
  expect(await seen("root")).toBe(now);
  touches.mockRestore();

  await hosted.close();
  hosted = createHostedSessions(application, { now: () => now, idleSeconds: 2, isAuthorized: () => authorized }); await hosted.ready;
  const before = await seen("root");
  now += 199; await hosted.whoami(principal, context("root"));
  expect(await seen("root")).toBe(before);
  now += 1; await hosted.whoami(principal, context("root"));
  expect(await seen("root")).toBe(before + 200);
});

test("a call's end touches a child whose own last_seen_at left the touch window while its root's hadn't, under either gate (#998)", async () => {
  await hosted.bind(principal, context("root"), { name: "be", create: true });
  await hosted.register(principal, context("root"), "child");
  const seen = async (raw: string) => (await database.repo.hosted.get(database.repo.read, hostedId(raw)))!.last_seen_at;
  for (const mode of ["full", "prior"] as const) {
    now += 60_000;
    // The child last acted 4 s ago, its root just now: the call's start touches neither, and its end must touch the child.
    await seed(database.repo, () => {
      database.db.run("UPDATE hosted_sessions SET last_seen_at = ? WHERE session_id = ?", [now - 4_000, hostedId("child")]);
      database.db.run("UPDATE hosted_sessions SET last_seen_at = ? WHERE session_id = ?", [now, hostedId("root")]);
    });
    const verdict = mode === "prior" ? (await hosted.snapshot(principal, context("child"), false)).verdict : undefined;
    const start = now;
    await hosted.run(principal, context("child"), "dm_send", (session, tx) => { now += 2_000; return application.send(tx, session, "be", `${mode} end`); }, undefined, verdict);
    expect([mode, await seen("child"), await seen("root")]).toEqual([mode, now, start]);
  }
});

test("a child's native tool call under its exchange's verdict coalesces its touches and its root's (#912)", async () => {
  await hosted.bind(principal, context("root"), { name: "be", create: true });
  await hosted.register(principal, context("root"), "child");
  const seen = async (raw: string) => (await database.repo.hosted.get(database.repo.read, hostedId(raw)))!.last_seen_at;
  const call = async () => {
    const { verdict } = await hosted.snapshot(principal, context("child"), false);
    const touches = spyOn(database.repo.hosted, "touch");
    try { await hosted.run(principal, context("child"), "dm_send", (session, tx) => application.send(tx, session, "be", `at ${now}`), undefined, verdict); return touches.mock.calls.map(c => c[1]); }
    finally { touches.mockRestore(); }
  };
  const start = [await seen("root"), await seen("child")];
  now += 4_999;
  // The exchange's selection is past the window's start, so this call's own touches are the gate's only writes.
  expect(await call()).toEqual([]);
  expect([await seen("root"), await seen("child")]).toEqual(start);
  now += 5_000;
  const { verdict } = await hosted.snapshot(principal, context("child"), false);
  now += 5_000;
  const touches = spyOn(database.repo.hosted, "touch");
  await hosted.run(principal, context("child"), "dm_send", (session, tx) => application.send(tx, session, "be", "late"), undefined, verdict);
  const touched = touches.mock.calls.map(c => c[1]).sort();
  touches.mockRestore();
  expect(touched).toEqual([hostedId("child"), hostedId("root")].sort());
  expect([await seen("root"), await seen("child")]).toEqual([now, now]);
});

// #807 P3 A7d2b: the hosted and delivery checks await. A check the test holds: after arm(n), the nth call waits for
// release(), and the test changes state while it waits.
function heldAuth() {
  let target = 0, calls = 0, hit!: () => void, go!: (ok: boolean) => void;
  const reached = new Promise<void>(resolve => { hit = resolve; });
  const released = new Promise<boolean>(resolve => { go = resolve; });
  return {
    isAuthorized: (): boolean | Promise<boolean> => { if (target && ++calls === target) { hit(); return released; } return authorized; },
    arm(n: number) { target = n; calls = 0; },
    reached, release: (ok = true) => go(ok),
  };
}

test("#807 P3 A7d2b: delivery's pending refuses a lease finished while its token check awaited", async () => {
  const held = heldAuth();
  const service = createDelivery(hosted, { isAuthorized: held.isAuthorized });
  try {
    await hosted.bind(principal, context("lease-root"), { name: "lease-peer", create: true });
    const lease = await service.open(principal, context("lease-root"));
    // pending checks twice: the second check, after which nothing reads the lease map again before items go out.
    held.arm(2);
    const call = service.pending(principal, context("lease-root"), lease.capability);
    await held.reached;
    await seed(database.repo, tx => database.repo.users.setDisabled(tx, principal.authed.user_id, true));
    // The disable's full pass finishes the lease (#807 P3 A7h2).
    await until(() => service.activeLeaseCount === 0);
    held.release(true);
    await expect(call).rejects.toThrow("no live delivery lease");
    expect(database.db.query("SELECT count(*) AS n FROM access_log WHERE action = 'hosted.stale_capability'").get()).toEqual({ n: 1 });
  } finally { service.close(); }
});

test("#807 P3 A7d2b: fence reads the binding after its token check's await: a rebind meanwhile refuses", async () => {
  const held = heldAuth();
  const service = createHostedSessions(application, { now: () => now, isAuthorized: held.isAuthorized }); await service.ready;
  try {
    await service.bind(principal, context("fence-root"), { name: "fence-peer", create: true });
    let verdict: string | undefined;
    const transfer = service.transfer(principal, context("fence-root"), async (_session, guard) => {
      held.arm(1);
      const checked = guard(database.repo.read);
      await held.reached;
      const row = (await rowOf(context("fence-root")))!;
      await seed(database.repo, tx => database.repo.hosted.update(tx, row.session_id, { bind_gen: row.bind_gen + 1 }));
      held.release(true);
      verdict = await checked.then(() => "passed", (e: { code?: string }) => e.code ?? "error");
    });
    await transfer.catch(() => {});
    expect(verdict).toBe("unbound");
  } finally { await service.close(); }
});

test("#807 P3 A7d2b: a close while a hosted token check awaits refuses the call", async () => {
  const held = heldAuth();
  const service = createHostedSessions(application, { now: () => now, isAuthorized: held.isAuthorized }); await service.ready;
  held.arm(1);
  // No session context: nothing after the entry check would check again.
  const call = service.whoami(principal, sessionContext(principal, {}));
  await held.reached;
  await service.close();
  held.release(true);
  await expect(call).rejects.toThrow("unauthenticated");
});

// #807 P3 A7g1: a named commit's holder facts are read on its committing transaction, and a full reconcile reads and
// applies inside one queued body.
const rootId = () => (context("root") as { id: string }).id;
const bumpGen = () => seed(database.repo, async tx => {
  const r = (await database.repo.hosted.get(tx, rootId()))!;
  return database.repo.hosted.update(tx, r.session_id, { bind_gen: r.bind_gen + 1 });
});

test("#807 P3 A7g1: a full reconcile's read holds the write queue; two commits during it land after its apply and the holder matches the last", async () => {
  await hosted.bind(principal, context("root"), { name: "be", create: true });
  const start = (await database.repo.hosted.get(database.repo.read, rootId()))!.bind_gen;
  expect(hosted.holder(rootId())?.generation).toBe(start);
  let bumps: Promise<void>[] = [];
  await paused("hosted:reconcile:read", () => hosted.reconcile(), async () => {
    expect(queueFor(database.db).held).toBe(true);
    bumps = [bumpGen(), bumpGen()];
  });
  await Promise.all(bumps);
  const row = (await database.repo.hosted.get(database.repo.read, rootId()))!;
  expect(row.bind_gen).toBe(start + 2);
  expect(hosted.holder(rootId())).toEqual({ ownership: row.ownership_id, generation: row.bind_gen });
});

test("#807 P3 A7g1: a named commit's facts are read at COMMIT, so a hold dropped after the mark in the same body leaves no holder", async () => {
  await hosted.bind(principal, context("root"), { name: "be", create: true });
  expect(hosted.holderCount).toBe(1);
  await seed(database.repo, async tx => {
    const r = (await database.repo.hosted.get(tx, rootId()))!;
    await database.repo.hosted.update(tx, r.session_id, { bind_gen: r.bind_gen + 1 });
    dropHold(database.repo.coreOn(tx), at("be"), rootId());
  });
  expect(hosted.holder(rootId())).toBeUndefined();
  expect(hosted.holderCount).toBe(0);
});

test("#807 P3 A7g1 (#899): a named apply whose build throws still tells the listeners, and the commit stands", async () => {
  await hosted.bind(principal, context("root"), { name: "be", create: true });
  const seen: (string | null)[] = [];
  hosted.listen(changed => { seen.push(changed); });
  const build = spyOn(application, "hostedBuild").mockImplementation(() => { throw new Error("build failed"); });
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const before = (await database.repo.hosted.get(database.repo.read, rootId()))!.bind_gen;
    await bumpGen();
    expect(build).toHaveBeenCalled();
    expect(seen).toContain(rootId());
    expect((await database.repo.hosted.get(database.repo.read, rootId()))!.bind_gen).toBe(before + 1);
    expect(hosted.holder(rootId())).toBeUndefined();
  } finally { build.mockRestore(); log.mockRestore(); }
});

test("#807 P3 A7g1 (#899): a full reconcile tells the listeners null before its read is released", async () => {
  const seen: (string | null)[] = [];
  hosted.listen(changed => { seen.push(changed); });
  await paused("hosted:reconcile:read", () => hosted.reconcile(), async () => { expect(seen).toEqual([null]); });
  expect(seen).toEqual([null]);
});

test("#807 P3 A7g1: close() during a held full read applies nothing", async () => {
  await hosted.bind(principal, context("root"), { name: "be", create: true });
  // A held root with no holder: the rebuild after a generation bump fails once.
  const failing = spyOn(application, "hostedBuild").mockImplementation(() => { throw new Error("build failed"); });
  const log = spyOn(console, "error").mockImplementation(() => {});
  try { await bumpGen(); } finally { failing.mockRestore(); log.mockRestore(); }
  expect(hosted.holderCount).toBe(0);
  const build = spyOn(application, "hostedBuild");
  let closing!: Promise<void>;
  try {
    await paused("hosted:reconcile:read", () => hosted.reconcile(), async () => { closing = hosted.close(); });
    await closing;
    expect(hosted.holderCount).toBe(0);
    expect(build).not.toHaveBeenCalled();
  } finally { build.mockRestore(); }
});

test("#807 P3 A7g1: full reconciles requested before the queued one starts share its body", async () => {
  let release!: () => void;
  const holder = queueFor(database.db).run(() => new Promise<void>(r => { release = r; }));
  const all = spyOn(database.repo.hosted, "all");
  try {
    const first = hosted.reconcile(), second = hosted.reconcile();
    expect(second).toBe(first);
    release(); await holder; await first;
    expect(all).toHaveBeenCalledTimes(1);
  } finally { all.mockRestore(); }
});

test("#807 P3 A7g1: a full reconcile requested once the queued one has started runs a pass of its own", async () => {
  const all = spyOn(database.repo.hosted, "all");
  try {
    let again!: Promise<void>, first!: Promise<void>;
    await paused("hosted:reconcile:read", () => (first = hosted.reconcile()), async () => { again = hosted.reconcile(); expect(again).not.toBe(first); });
    await again;
    expect(all).toHaveBeenCalledTimes(2);
  } finally { all.mockRestore(); }
});

test("#807 P3 A7g1 audit: a full reconcile whose write is refused before its body starts doesn't stick", async () => {
  const write = spyOn(database.repo.hosted, "write").mockImplementationOnce(() => Promise.reject(new Error("BEGIN failed")));
  const all = spyOn(database.repo.hosted, "all");
  try {
    await expect(hosted.reconcile()).rejects.toThrow("BEGIN failed");
    await hosted.reconcile();
    expect(all).toHaveBeenCalledTimes(1);
  } finally { write.mockRestore(); all.mockRestore(); }
});

// #807 P3 C8a: the lock seams' call sites. On SQLite `lock`, `lockCapacity` and `grantLive` take no lock (the single
// writer serializes every body), so what these rows pin is where each call sits: in the write body, before the read it
// guards, with the guarded value read again after it. On Postgres those positions are what make the locks work.
type SeamCall = { name: string; id?: string };
function seamCalls(): { calls: SeamCall[]; restore(): void } {
  const store = database.repo.hosted, calls: SeamCall[] = [];
  const names = ["grantLive", "lockCapacity", "lock", "get", "counts", "start", "insert", "update", "touch", "unpark", "end"] as const;
  const spies = names.map(name => {
    const original = store[name] as (...a: unknown[]) => unknown;
    return spyOn(store, name).mockImplementation(((...a: unknown[]) => {
      // Write bodies only: a pool read is no lock's business.
      if (a[0] !== database.repo.read) calls.push({ name, id: typeof a[1] === "string" ? a[1] : (a[1] as { session_id?: string } | undefined)?.session_id });
      return original.apply(store, a);
    }) as never);
  });
  return { calls, restore: () => { for (const s of spies) s.mockRestore(); } };
}
const seamAt = (calls: SeamCall[], name: string, id?: string, from = 0) => calls.findIndex((c, i) => i >= from && c.name === name && (id === undefined || c.id === id));
const order = (calls: SeamCall[]) => calls.map(c => c.id ? `${c.name} ${c.id}` : c.name).join(", ");

test("#807 P3 C8a: a creating request reads its grant first, then takes the capacity lock and reads its row again before it counts or inserts", async () => {
  const id = hostedId("seam-new");
  const seams = seamCalls();
  try { await hosted.whoami(principal, context("seam-new")); } finally { seams.restore(); }
  const { calls } = seams, capacity = seamAt(calls, "lockCapacity");
  expect(order(calls)).toStartWith("grantLive");
  expect(capacity).toBeGreaterThan(0);
  const reread = seamAt(calls, "get", id, capacity);
  expect(reread, order(calls)).toBeGreaterThan(capacity);
  expect(reread, order(calls)).toBeLessThan(seamAt(calls, "counts"));
  expect(seamAt(calls, "counts"), order(calls)).toBeLessThan(seamAt(calls, "insert", id));
});

test("#807 P3 C8a: a same-ID row committed while a creating request waited for the capacity lock is found, not inserted twice (scope R1)", async () => {
  const id = hostedId("seam-racer");
  const store = database.repo.hosted, lockCapacity = store.lockCapacity.bind(store);
  // The racer's insert lands while this request waits for the lock: on SQLite, inside it, in the same body.
  const spy = spyOn(store, "lockCapacity").mockImplementationOnce(async tx => {
    await lockCapacity(tx);
    const ownership = await store.start(tx, id, principal.authed.user_id, principal.clientId, now);
    await store.insert(tx, { session_id: id, ownership_id: ownership, user_id: principal.authed.user_id, client_id: principal.clientId, grant_id: principal.grantId,
      source_session_id: "seam-racer", writes_as: null, bind_gen: 0, root_session_id: null, place: null, lease_deadline: null, created_at: now, last_seen_at: now, suggested: null, parked_at: null });
  });
  try { await hosted.whoami(principal, context("seam-racer")); } finally { spy.mockRestore(); }
  expect(database.db.query("SELECT count(*) AS n FROM hosted_ownerships WHERE session_id = ?").get(id)).toEqual({ n: 1 });
  expect(await store.get(database.repo.read, id)).toBeDefined();
});

test("#807 P3 C8a: a call on a live root reads its grant first and locks the row before settle writes it", async () => {
  const id = hostedId("seam-live");
  await hosted.whoami(principal, context("seam-live"));
  now += 1_000;
  const seams = seamCalls();
  try { await hosted.whoami(principal, context("seam-live")); } finally { seams.restore(); }
  const { calls } = seams;
  expect(order(calls)).toStartWith("grantLive");
  const locked = seamAt(calls, "lock", id);
  expect(locked, order(calls)).toBeGreaterThan(0);
  expect(seamAt(calls, "get", id), order(calls)).toBe(-1);
  const write = calls.findIndex(c => (c.name === "touch" || c.name === "update") && c.id === id);
  if (write !== -1) expect(locked).toBeLessThan(write);
});

test("#807 P3 C8a: bind reads its grant first and attach locks the root before it reads it for the update", async () => {
  const id = hostedId("seam-bind");
  await hosted.whoami(principal, context("seam-bind"));
  const seams = seamCalls();
  try { await hosted.bind(principal, context("seam-bind"), { name: "seam-fe", create: true }); } finally { seams.restore(); }
  const { calls } = seams;
  // Two bodies: the gate's settle, then the owning body that writes the bind; each starts with the grant.
  expect(calls[0]?.name, order(calls)).toBe("grantLive");
  const body = seamAt(calls, "grantLive", undefined, 1);
  expect(body, order(calls)).toBeGreaterThan(seamAt(calls, "lock", id));
  const locked = seamAt(calls, "lock", id, body), update = seamAt(calls, "update", id, body);
  expect(locked, order(calls)).toBeGreaterThan(body);
  expect(update, order(calls)).toBeGreaterThan(locked);
  // No unlocked read of the row before its update (an audit reads it after).
  expect(calls.slice(body, update).some(c => c.name === "get" && c.id === id), order(calls)).toBe(false);
});

test("#807 P3 C8a audit: attach locks the root before its fence reads it", async () => {
  await hosted.whoami(principal, context("seam-attach"));
  const store = database.repo.hosted, lock = store.lock.bind(store), callers: string[] = [];
  // Which function asked: the frame just above the spy's.
  const spy = spyOn(store, "lock").mockImplementation((tx, id) => {
    const stack = new Error().stack ?? "";
    callers.push(/\bat (?:async )?fence\b/.test(stack) ? "fence" : /\bat (?:async )?attach\b/.test(stack) ? "attach" : "other");
    return lock(tx, id);
  });
  try { await hosted.bind(principal, context("seam-attach"), { name: "seam-at", create: true }); } finally { spy.mockRestore(); }
  const attach = callers.indexOf("attach"), fence = callers.indexOf("fence");
  expect(attach, callers.join(", ")).toBeGreaterThanOrEqual(0);
  expect(fence, callers.join(", ")).toBeGreaterThan(attach);
});

test("#807 P3 C8a: register reads its grant first, then locks the root before it inserts the child", async () => {
  const root = hostedId("seam-root"), child = hostedId("seam-child");
  await hosted.bind(principal, context("seam-root"), { name: "seam-be", create: true });
  const seams = seamCalls();
  try { await hosted.register(principal, context("seam-root"), "seam-child"); } finally { seams.restore(); }
  const { calls } = seams;
  // Its body's first store call: before rowFor reads the root.
  const body = seamAt(calls, "grantLive");
  expect(body, order(calls)).toBe(0);
  const insert = seamAt(calls, "insert", child, body);
  expect(insert, order(calls)).toBeGreaterThan(body);
  expect(seamAt(calls, "lock", root, body), order(calls)).toBeGreaterThan(body);
  expect(seamAt(calls, "lock", root, body), order(calls)).toBeLessThan(insert);
  // admit's lock, before its count (admitChild takes it again).
  const capacity = seamAt(calls, "lockCapacity", undefined, body);
  expect(capacity, order(calls)).toBeGreaterThan(body);
  expect(capacity, order(calls)).toBeLessThan(seamAt(calls, "counts", undefined, body));
  expect(capacity, order(calls)).toBeLessThan(insert);
  expect(seamAt(calls, "lock", child, body), order(calls)).toBeGreaterThan(body);
  expect(seamAt(calls, "lock", child, body), order(calls)).toBeLessThan(insert);
  // The lock order (store/hosted.ts): root, then child, then capacity; attach's later root lock is re-entrant.
  expect(seamAt(calls, "lock", root, body), order(calls)).toBeLessThan(seamAt(calls, "lock", child, body));
  expect(seamAt(calls, "lock", child, body), order(calls)).toBeLessThan(capacity);
});

test("#807 P3 C8a: registering an unbound root as a child takes the capacity lock before it ends that root and inserts the child", async () => {
  const child = hostedId("seam-convert");
  await hosted.bind(principal, context("seam-root2"), { name: "seam-r2", create: true });
  await hosted.whoami(principal, context("seam-convert"));
  const seams = seamCalls();
  try { await hosted.register(principal, context("seam-root2"), "seam-convert"); } finally { seams.restore(); }
  const { calls } = seams;
  const body = seamAt(calls, "grantLive"), end = seamAt(calls, "end", child, body);
  expect(end, order(calls)).toBeGreaterThan(body);
  const capacity = seamAt(calls, "lockCapacity", undefined, body);
  expect(capacity, order(calls)).toBeGreaterThan(body);
  expect(capacity, order(calls)).toBeLessThan(end);
  expect(seamAt(calls, "insert", child, end), order(calls)).toBeGreaterThan(end);
  // The lock order: the root, then the root being converted, then capacity.
  const root = hostedId("seam-root2"), lockedRoot = seamAt(calls, "lock", root, body), lockedChild = seamAt(calls, "lock", child, body);
  expect(lockedRoot, order(calls)).toBeGreaterThan(body);
  expect(lockedRoot, order(calls)).toBeLessThan(lockedChild);
  expect(lockedChild, order(calls)).toBeLessThan(capacity);
});

test("#807 P3 C8a audit: a parked child's call locks it (its root first) before unpark takes the capacity lock", async () => {
  const child = hostedId("seam-wake-child");
  await hosted.bind(principal, context("seam-wake-root"), { name: "seam-wk", create: true });
  await hosted.register(principal, context("seam-wake-root"), "seam-wake-child");
  now += 900_001;
  await hosted.sweep();
  expect((await database.repo.hosted.get(database.repo.read, child))!.parked_at).not.toBeNull();
  const seams = seamCalls();
  try { await hosted.whoami(principal, context("seam-wake-child")); } finally { seams.restore(); }
  const { calls } = seams, locked = seamAt(calls, "lock", child), capacity = seamAt(calls, "lockCapacity"), unparked = seamAt(calls, "unpark", child);
  expect(locked, order(calls)).toBeGreaterThan(0);
  expect(capacity, order(calls)).toBeGreaterThan(locked);
  expect(unparked, order(calls)).toBeGreaterThan(capacity);
  // No row lock after the capacity lock until the unpark it guards.
  expect(calls.slice(capacity, unparked).some(c => c.name === "lock"), order(calls)).toBe(false);
});

test("#807 P3 C8a audit: register on an unknown root takes the capacity lock and reads the root again before it creates it", async () => {
  const root = hostedId("seam-fresh-root");
  const seams = seamCalls();
  try { await hosted.register(principal, context("seam-fresh-root"), "seam-fresh-child"); } finally { seams.restore(); }
  const { calls } = seams, capacity = seamAt(calls, "lockCapacity"), insert = seamAt(calls, "insert", root);
  expect(capacity, order(calls)).toBeGreaterThan(0);
  const reread = seamAt(calls, "get", root, capacity);
  expect(reread, order(calls)).toBeGreaterThan(capacity);
  expect(reread, order(calls)).toBeLessThan(insert);
  expect(seamAt(calls, "counts"), order(calls)).toBeGreaterThan(reread);
});

test("#807 P3 C8b2: register that creates its root and converts an existing root locks that root before any capacity lock", async () => {
  const root = hostedId("seam-new-root"), child = hostedId("seam-old-root");
  await hosted.whoami(principal, context("seam-old-root"));
  const seams = seamCalls();
  try { await hosted.register(principal, context("seam-new-root"), "seam-old-root"); } finally { seams.restore(); }
  const { calls } = seams, body = seamAt(calls, "grantLive"), capacity = seamAt(calls, "lockCapacity", undefined, body);
  // The path: rowFor creates the root under the capacity lock, then the old root is ended and inserted as its child.
  expect(seamAt(calls, "insert", root, body), order(calls)).toBeGreaterThan(capacity);
  expect(seamAt(calls, "end", child, body), order(calls)).toBeGreaterThan(capacity);
  expect(seamAt(calls, "insert", child, body), order(calls)).toBeGreaterThan(seamAt(calls, "end", child, body));
  // The lock order (store/hosted.ts): grant, root, child, capacity.
  const lockedChild = seamAt(calls, "lock", child, body);
  expect(lockedChild, order(calls)).toBeGreaterThan(body);
  expect(lockedChild, order(calls)).toBeLessThan(capacity);
});

test("#807 P3 C8a: delivery's renew, receipt and release lock the row before they read it; a tool call's fence in its body locks it", async () => {
  const id = hostedId("seam-lease");
  await hosted.bind(principal, context("seam-lease"), { name: "seam-dl", create: true });
  const lease = await delivery.open(principal, context("seam-lease"));
  const run = async (fn: () => Promise<unknown>) => {
    const seams = seamCalls();
    try { await fn(); } finally { seams.restore(); }
    return seams.calls;
  };
  const renew = await run(() => delivery.renew(principal, context("seam-lease"), lease.capability));
  expect(seamAt(renew, "lock", id), order(renew)).toBeGreaterThanOrEqual(0);
  expect(seamAt(renew, "lock", id), order(renew)).toBeLessThan(seamAt(renew, "update", id));
  expect(renew.slice(0, seamAt(renew, "update", id)).some(c => c.name === "get" && c.id === id), order(renew)).toBe(false);
  const receipt = await run(() => delivery.receipt(principal, context("seam-lease"), lease.capability, []));
  expect(seamAt(receipt, "lock", id), order(receipt)).toBeGreaterThanOrEqual(0);
  expect(receipt.some(c => c.name === "get" && c.id === id), order(receipt)).toBe(false);
  // A tool call: settle's lock, then the fence's, both in the body; neither reads the row unlocked there.
  const tool = await run(() => hosted.run(principal, context("seam-lease"), "dm_send", (session, tx) => application.send(tx, session, "seam-dl", "hi")));
  expect(tool.filter(c => c.name === "lock" && c.id === id).length, order(tool)).toBeGreaterThanOrEqual(2);
  expect(tool.filter(c => c.name === "get" && c.id === id).length, order(tool)).toBe(0);
  const release = await run(() => delivery.release(principal, context("seam-lease"), lease.capability));
  expect(seamAt(release, "lock", id), order(release)).toBeGreaterThanOrEqual(0);
  expect(release.slice(0, seamAt(release, "end", id)).some(c => c.name === "get" && c.id === id), order(release)).toBe(false);
});

test("#807 P3 C8a: a revoked hold's root is locked on the recheck's Tx, before the savepoint that reads and updates it", async () => {
  const team = await seed(database.repo, async tx => {
    const t = await database.repo.teams.create(tx, "ops", principal.authed.user_id);
    await database.repo.teams.addMember(tx, t.id, principal.authed.user_id);
    return t;
  });
  const id = hostedId("seam-revoke");
  await hosted.bind(principal, context("seam-revoke"), { name: "ops/seam", create: true });
  await seed(database.repo, tx => database.repo.teams.removeMember(tx, team.id, principal.authed.user_id));
  const handles: { name: string; tx: unknown }[] = [];
  const store = database.repo.hosted;
  const spies = (["lock", "get", "update"] as const).map(name => {
    const original = store[name] as (...a: unknown[]) => unknown;
    return spyOn(store, name).mockImplementation(((...a: unknown[]) => { if (a[1] === id && a[0] !== database.repo.read) handles.push({ name, tx: a[0] }); return original.apply(store, a); }) as never);
  });
  try { await application.accessChanged(database.repo.read, principal.authed.user_email, "admin@example.com"); }
  finally { for (const s of spies) s.mockRestore(); }
  const names = handles.map(h => h.name);
  expect(names[0], names.join(", ")).toBe("lock");
  expect(names.slice(1, 3), names.join(", ")).toEqual(["get", "update"]);
  // The lock on the caller's Tx, the read and the update on the savepoint's.
  expect(handles[1]!.tx).not.toBe(handles[0]!.tx);
  expect(handles[2]!.tx).toBe(handles[1]!.tx);
});

test("#807 P3 C8a: a cancelled creating open locks the row before it ends the session", async () => {
  const id = hostedId("seam-cancel");
  await hosted.bind(principal, context("seam-cancel"), { name: "seam-cx", create: true });
  const created = await delivery.open(principal, context("seam-cancel"));
  const seams = seamCalls();
  try { await delivery.cancel(created); } finally { seams.restore(); }
  const { calls } = seams;
  const end = seamAt(calls, "end", id);
  expect(end, order(calls)).toBeGreaterThan(0);
  expect(seamAt(calls, "lock", id), order(calls)).toBeLessThan(end);
  expect(seamAt(calls, "lock", id), order(calls)).toBeGreaterThanOrEqual(0);
});

test("#807 P3 C8a: a restart's downtime credit locks each root before it reads the column it credits", async () => {
  const id = hostedId("seam-credit");
  // An unleased root seen during the outage's idle window: the restart credits its last_seen_at.
  await hosted.whoami(principal, context("seam-credit"));
  delivery.close(); await hosted.close();
  await seed(database.repo, async tx => { await database.repo.hosted.heartbeat(tx, now - 600_000); await database.repo.hosted.touch(tx, id, now - 300_000); });
  const seams = seamCalls();
  const service = createHostedSessions(application, { now: () => now, isAuthorized: () => true });
  try { await service.ready; } finally { seams.restore(); await service.close(); }
  hosted = createHostedSessions(application, { now: () => now, isAuthorized: () => authorized }); await hosted.ready;
  delivery = createDelivery(hosted, { isAuthorized: () => authorized });
  const { calls } = seams;
  const update = seamAt(calls, "update", id);
  expect(update, order(calls)).toBeGreaterThanOrEqual(0);
  expect(seamAt(calls, "lock", id), order(calls)).toBeGreaterThanOrEqual(0);
  expect(seamAt(calls, "lock", id), order(calls)).toBeLessThan(update);
});

test("#807 P3 C8a audit: a restart's downtime credit is computed from the locked row, and skips one parked since the listing", async () => {
  const bumped = hostedId("credit-bumped"), parked = hostedId("credit-parked");
  // Two unleased roots seen during the outage's idle window; the listing reads them so, the lock reads them changed.
  await hosted.whoami(principal, context("credit-bumped"));
  await hosted.whoami(principal, context("credit-parked"));
  delivery.close(); await hosted.close();
  // A lease still live at the last heartbeat, whose credit stays under the one-TTL cap.
  const alive = now - 600_000, deadline = now - 590_000;
  await seed(database.repo, async tx => {
    await database.repo.hosted.heartbeat(tx, alive);
    for (const id of [bumped, parked]) await database.repo.hosted.touch(tx, id, now - 300_000);
  });
  const store = database.repo.hosted, lock = store.lock.bind(store);
  const lockSpy = spyOn(store, "lock").mockImplementation(async (tx, id) => {
    const row = await lock(tx, id);
    if (!row) return row;
    if (id === bumped) return { ...row, lease_deadline: deadline };
    if (id === parked) return { ...row, parked_at: now - 1 };
    return row;
  });
  const updates = spyOn(store, "update");
  const service = createHostedSessions(application, { now: () => now, isAuthorized: () => true });
  let patches: unknown[][];
  try { await service.ready; patches = updates.mock.calls.map(([, id, patch]) => [id, patch]); }
  finally { lockSpy.mockRestore(); updates.mockRestore(); await service.close(); }
  hosted = createHostedSessions(application, { now: () => now, isAuthorized: () => authorized }); await hosted.ready;
  delivery = createDelivery(hosted, { isAuthorized: () => authorized });
  // The locked row's lease, pushed out by the downtime; not the listed row's last_seen_at.
  expect(patches).toContainEqual([bumped, { lease_deadline: deadline + 600_000 }]);
  expect(patches.filter(([id]) => id === bumped)).toHaveLength(1);
  expect(patches.filter(([id]) => id === parked)).toEqual([]);
});

test("#807 P3 C8a audit: a park the store refuses writes no child_parked audit and evicts nothing", async () => {
  const child = hostedId("refused-park-child");
  await hosted.bind(principal, context("refused-park-root"), { name: "refused-pk", create: true });
  await hosted.register(principal, context("refused-park-root"), "refused-park-child");
  now += 900_001;
  const store = database.repo.hosted;
  const parks = spyOn(store, "park").mockImplementation(async () => false), childEnds = spyOn(store, "childEnd");
  let ended: number;
  try { await hosted.sweep(); ended = childEnds.mock.calls.length; expect(parks).toHaveBeenCalled(); }
  finally { parks.mockRestore(); childEnds.mockRestore(); }
  expect(ended).toBe(0);
  expect(database.db.query("SELECT count(*) AS n FROM access_log WHERE action = 'hosted.child_parked'").get()).toEqual({ n: 0 });
  expect((await store.get(database.repo.read, child))!.parked_at).toBeNull();
});

test("#807 P3 C8a audit: a delivery open and a renew move the root's last_seen_at", async () => {
  const id = hostedId("seen-lease");
  await hosted.bind(principal, context("seen-lease"), { name: "seen-ls", create: true });
  const seen = async () => (await database.repo.hosted.get(database.repo.read, id))!.last_seen_at;
  // Calls that touch the row on their own are kept out: only the store's update is observed.
  const updates = spyOn(database.repo.hosted, "update");
  let opened: unknown[][], renewed: unknown[][];
  try {
    now += 1_000;
    const lease = await delivery.open(principal, context("seen-lease"));
    opened = updates.mock.calls.filter(([, u]) => u === id).map(([, , patch]) => [patch]);
    expect(await seen()).toBe(now);
    updates.mockClear();
    now += 1_000;
    await delivery.renew(principal, context("seen-lease"), lease.capability);
    renewed = updates.mock.calls.filter(([, u]) => u === id).map(([, , patch]) => [patch]);
    expect(await seen()).toBe(now);
  } finally { updates.mockRestore(); }
  expect(opened.some(([patch]) => (patch as { last_seen_at?: number }).last_seen_at !== undefined), JSON.stringify(opened)).toBe(true);
  expect(renewed.some(([patch]) => (patch as { last_seen_at?: number }).last_seen_at !== undefined), JSON.stringify(renewed)).toBe(true);
});

test("#807 P3 C8a: the sweep hands each end and park the value it judged, for the store to check on the row it acts on", async () => {
  // An idle unleased root, a lapsed lease and an idle child.
  await hosted.whoami(principal, context("sweep-idle"));
  await hosted.bind(principal, context("sweep-lease"), { name: "sweep-ls", create: true });
  await delivery.open(principal, context("sweep-lease"));
  // The child's root holds a name and has no lease: neither idle nor expired, so the child parks.
  await hosted.bind(principal, context("sweep-held"), { name: "sweep-hd", create: true });
  await hosted.register(principal, context("sweep-held"), "sweep-child");
  const deadline = (await database.repo.hosted.get(database.repo.read, hostedId("sweep-lease")))!.lease_deadline!;
  now += 900_001;
  const store = database.repo.hosted;
  const ends = spyOn(store, "end"), parks = spyOn(store, "park");
  let endArgs: unknown[][], parkArgs: unknown[][];
  try {
    await hosted.sweep();
    endArgs = ends.mock.calls.map(([, id, reason, at, d, i]) => [id, reason, at, d, i]);
    parkArgs = parks.mock.calls.map(([, id, at, i]) => [id, at, i]);
  } finally { ends.mockRestore(); parks.mockRestore(); }
  const idleBefore = now - 900_000;
  expect(endArgs).toContainEqual([hostedId("sweep-idle"), "idle", now, undefined, idleBefore]);
  expect(endArgs).toContainEqual([hostedId("sweep-lease"), "expired", now, deadline, undefined]);
  expect(parkArgs).toContainEqual([hostedId("sweep-child"), now, idleBefore]);
});

test("#807 P3 C8a: a grant revoked after the request's auth check refuses its write body, whatever the auth cache says", async () => {
  await hosted.bind(principal, context("seam-revoked"), { name: "seam-rv", create: true });
  const id = hostedId("seam-revoked"), before = (await database.repo.hosted.get(database.repo.read, id))!;
  await seed(database.repo, tx => { database.db.run("UPDATE oauth_grants SET revoked_at = ? WHERE id = 'G1'", [now]); return Promise.resolve(); });
  // A new root: refused before its insert.
  await expect(hosted.whoami(principal, context("seam-new-under-revoked"))).rejects.toThrow("unauthenticated");
  expect(await database.repo.hosted.get(database.repo.read, hostedId("seam-new-under-revoked"))).toBeUndefined();
  // The live root: refused before its bind writes.
  await expect(hosted.bind(principal, context("seam-revoked"), { name: "seam-rv2", create: true })).rejects.toThrow("unauthenticated");
  expect((await database.repo.hosted.get(database.repo.read, id))!.bind_gen).toBe(before.bind_gen);
  // A child's register: refused before its insert.
  await expect(hosted.register(principal, context("seam-revoked"), "seam-rv-child")).rejects.toThrow("unauthenticated");
  expect(await database.repo.hosted.get(database.repo.read, hostedId("seam-rv-child"))).toBeUndefined();
});

// The ends a request makes of an idle or lapsed root hand the store the value they judged, as the sweep's do.
async function endArgsOf(fn: () => Promise<unknown>): Promise<unknown[][]> {
  const ends = spyOn(database.repo.hosted, "end");
  try { await fn(); return ends.mock.calls.map(([, id, reason, at, d, i]) => [id, reason, at, d, i]); } finally { ends.mockRestore(); }
}

test("#807 P3 C8a: settle's end of an idle root it was called on passes the idle cutoff it judged", async () => {
  const id = hostedId("seam-settle-idle");
  await hosted.whoami(principal, context("seam-settle-idle"));
  now += 900_001;
  const args = await endArgsOf(() => hosted.whoami(principal, context("seam-settle-idle")));
  expect(args).toContainEqual([id, "idle", now, undefined, now - 900_000]);
});

test("#807 P3 C8a audit: settle whose idle end the store refused keeps the row it read rather than reading it again", async () => {
  const id = hostedId("seam-settle-refused");
  await hosted.whoami(principal, context("seam-settle-refused"));
  now += 900_001;
  const store = database.repo.hosted, get = store.get.bind(store), calls: string[] = [];
  const ends = spyOn(store, "end").mockImplementation(async (_tx, session, reason) => { calls.push(`end ${session} ${reason}`); return false; });
  const gets = spyOn(store, "get").mockImplementation((r, session) => { if (r !== database.repo.read) calls.push(`get ${session}`); return get(r, session); });
  try { await hosted.whoami(principal, context("seam-settle-refused")); } finally { ends.mockRestore(); gets.mockRestore(); }
  expect(calls, calls.join(", ")).toContain(`end ${id} idle`);
  // Nothing was written, so rowFor takes settle's row: no second read of it.
  expect(calls, calls.join(", ")).not.toContain(`get ${id}`);
  expect(await database.repo.hosted.get(database.repo.read, id)).toBeDefined();
});

test("#807 P3 C8a: a bind's end of an idle or lapsed contender passes the cutoff or deadline it judged", async () => {
  const idleHolder = hostedId("seam-idle-holder"), leased = hostedId("seam-leased-holder");
  await hosted.bind(principal, context("seam-idle-holder"), { name: "seam-idle-name", create: true });
  await hosted.bind(principal, context("seam-leased-holder"), { name: "seam-lease-name", create: true });
  await delivery.open(principal, context("seam-leased-holder"));
  const deadline = (await database.repo.hosted.get(database.repo.read, leased))!.lease_deadline!;
  await hosted.whoami(principal, context("seam-taker"));
  now += 900_001;
  // The taker stays active: only the holders went quiet.
  await seed(database.repo, tx => database.repo.hosted.touch(tx, hostedId("seam-taker"), now));
  const idleArgs = await endArgsOf(() => hosted.bind(principal, context("seam-taker"), { name: "seam-idle-name" }));
  expect(idleArgs).toContainEqual([idleHolder, "idle", now, undefined, now - 900_000]);
  const leaseArgs = await endArgsOf(() => hosted.bind(principal, context("seam-taker"), { name: "seam-lease-name" }));
  expect(leaseArgs).toContainEqual([leased, "expired", now, deadline, undefined]);
});

// #1298: only a generic-source principal's request has its declared MCP client read; any other principal's is ignored.
test("#1298: sessionContext reads the declared client for a generic source only", () => {
  const meta = { [GRAYBOARD_SESSION_META]: "declared-1298", [CLIENT_INFO_META_KEY]: { name: "grayboard-omp" } };
  const svc: OAuthPrincipal = { ...principal, clientId: `svc_${"c".repeat(32)}`, sourceKey: GRAYBOARD_SESSION_META };
  expect(sessionContext({ ...svc, source: "generic" }, meta)).toHaveProperty("client", "grayboard-omp");
  for (const source of [null, undefined, "opencode"] as const) expect(sessionContext({ ...svc, source }, meta)).not.toHaveProperty("client");
  expect(sessionContext({ ...principal, clientId: "grayboard-pi", sourceKey: GRAYBOARD_SESSION_META }, meta)).not.toHaveProperty("client");
  expect(sessionContext({ ...svc, source: "generic" }, { ...meta, [CLIENT_INFO_META_KEY]: { name: 7 } })).not.toHaveProperty("client");
});

// #1299: a launcher declaration is read for a built-in client, OpenCode's, and a service credential of either source;
// an operator-configured third-party client's (no credential source) is ignored.
test("#1299: sessionContext reads a launcher declaration for a service credential of either source, never a third-party client's", () => {
  const meta = { [GRAYBOARD_SESSION_META]: "declared-1299", [OPENCODE_SESSION_META]: "declared-1299", [GRAYBOARD_LAUNCHER_META]: true };
  const svc: OAuthPrincipal = { ...principal, clientId: `svc_${"c".repeat(32)}`, sourceKey: GRAYBOARD_SESSION_META };
  expect(sessionContext({ ...svc, source: "generic" }, meta)).toHaveProperty("launcher", true);
  expect(sessionContext({ ...svc, source: "opencode", sourceKey: OPENCODE_SESSION_META }, meta)).toHaveProperty("launcher", true);
  for (const source of [null, undefined] as const) expect(sessionContext({ ...svc, source }, meta)).not.toHaveProperty("launcher");
  expect(sessionContext({ ...principal, clientId: "brokered-agents", sourceKey: GRAYBOARD_SESSION_META }, meta)).not.toHaveProperty("launcher");
  expect(sessionContext({ ...principal, clientId: "grayboard-pi", sourceKey: GRAYBOARD_SESSION_META }, meta)).toHaveProperty("launcher", true);
  // The same checks as a built-in client's: a non-boolean is refused, false is no declaration.
  expect(() => sessionContext({ ...svc, source: "generic" }, { ...meta, [GRAYBOARD_LAUNCHER_META]: "yes" })).toThrow(`_meta["${GRAYBOARD_LAUNCHER_META}"] must be a boolean`);
  expect(sessionContext({ ...svc, source: "generic" }, { ...meta, [GRAYBOARD_LAUNCHER_META]: false })).not.toHaveProperty("launcher");
});

// #1355: the server records a post's human mark on its row when written: a post and a claim's system posts written
// before the handle is marked human stay 0; the marked handle's own words are 1.
test("#1355: the server records the human mark at write time; a system post never bears it", async () => {
  const a = context("h1355");
  await hosted.bind(principal, a, { name: "h1355", create: true });
  const call = (tool: string, args: Record<string, unknown>) => hosted.run(principal, a, tool, (session, tx) => application.call(tx, session, tool, args));
  const mark = () => database.db.query<{ body: string; human: number | null }, []>("SELECT body, human FROM posts WHERE board = 'h1355' ORDER BY id").all();
  await call("board_create", { name: "h1355", purpose: "tests" });
  await call("board_post", { board: "h1355", body: "before" });
  await call("claim_take", { key: "h1355:x", board: "h1355" });
  await call("claim_release", { key: "h1355:x" });
  // The server marks only `<email>/human` (slack.ts), never a bound alias; marking one here drives the write path's gate.
  // Hosted delivery reads no column: adapters mark by that reserved author name (own-human.ts).
  await seed(database.repo, tx => database.repo.aliases.markHuman(tx, "you@example.com/h1355", true));
  await call("board_post", { board: "h1355", body: "after" });
  expect(mark()).toEqual([
    { body: "before", human: 0 }, { body: "[claim] h1355:x", human: 0 }, { body: "[release] h1355:x", human: 0 }, { body: "after", human: 1 },
  ]);
});

// #1364: the server records a DM's human mark on its row when written: one sent before its sender bears the mark
// stays 0, one sent after is 1.
test("#1364: the server records a DM's human mark at write time", async () => {
  const a = context("h1364");
  await hosted.bind(principal, a, { name: "h1364", create: true });
  const b = context("h1364b");
  await hosted.bind(principal, b, { name: "h1364b", create: true });
  const send = (body: string) => hosted.run(principal, a, "dm_send", (session, tx) => application.send(tx, session, "h1364b", body)) as Promise<{ message_id: number }>;
  const human = (id: number) => database.db.query<{ human: number | null }, [number]>("SELECT human FROM messages WHERE id = ?").get(id)!.human;
  const before = await send("before");
  // As in #1355's test: the server marks only `<email>/human`; marking a bound alias drives the write path's judgment.
  await seed(database.repo, tx => database.repo.aliases.markHuman(tx, "you@example.com/h1364", true));
  const after = await send("after");
  expect([human(before.message_id), human(after.message_id)]).toEqual([0, 1]);
});
