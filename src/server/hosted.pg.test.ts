// #1479: hosted delivery's bind-generation fence across two server instances on one Postgres database. Each instance is
// its own pod as far as the fence goes: its own Repo (pool, write queue, auth LISTEN), Application, hosted sessions and
// delivery, so one instance's commit reaches the other's in-memory holders and leases only through that instance's own
// reads (its backstop reconcile, every RECONCILE_EVERY ticks), never through the committing instance's notices.
// hosted.test.ts's #1473 test pins the same refusal when the unbind runs on the lease's own instance. Without
// GRAYBOARD_TEST_PG_URL it skips.
import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppSession } from "../../tests/support/app_session.ts";
import { describePg, pgDatabase } from "../../tests/support/pg.ts";
import { seed } from "../../tests/support/seed.ts";
import { until } from "../../tests/support/until.ts";
import { createApplication } from "./application.ts";
import { writeAudit } from "./audit.ts";
import { createDelivery } from "./delivery.ts";
import { createHostedSessions, sessionContext } from "./hosted.ts";
import { OPENCODE_CLIENT, OPENCODE_SESSION_META } from "./oauth-config.ts";
import type { OAuthPrincipal } from "./oauth.ts";
import { makePgRepo, type PgRepo } from "./pg_repo.ts";
import { atSite, currentSite } from "./store/queue.ts";
import { DEFAULT_AUTH_FAIL_LIMIT, DEFAULT_HELLO_LIMIT } from "./rate_limit.ts";
import { DEFAULT_TRUSTED_PROXIES } from "./client_addr.ts";
import { createOAuthServer } from "./oauth.ts";
import { hashToken } from "./auth.ts";
import { gateCount } from "./metrics.ts";
import { GRAYBOARD_LAUNCHER_META, GRAYBOARD_MODEL_META } from "../shared/session_meta.ts";
import { issueOAuth } from "../../tests/helpers/oauth.ts";
import { hostedPause } from "../../tests/support/hosted-pause.ts";
import type { Tx } from "./store/tx_base.ts";

// Above the pool's 5 s lock_timeout (pg/tx.ts), so a broken lock fails on its own error, not on Bun's timeout.
setDefaultTimeout(30_000);

const ME = "you@example.com";

// One instance on `url`: the hosted MCP layer's composition (mcp.ts createHostedMcp) without its HTTP surface.
async function instance(url: string, side: string) {
  const blobDir = mkdtempSync(join(tmpdir(), "gb-pg-blobs-"));
  const repo = await makePgRepo(url, { blobDir, applicationName: `gb-test-${side}`, max: 4 });
  const application = createApplication(repo);
  const hosted = createHostedSessions(application, { isAuthorized: () => true });
  await hosted.ready;
  const delivery = createDelivery(hosted, { isAuthorized: () => true });
  return {
    repo, application, hosted, delivery,
    async [Symbol.asyncDispose]() {
      try { delivery.close(); await hosted.close(); await application.stopExpiry(); await repo.close(); }
      finally { rmSync(blobDir, { recursive: true, force: true }); }
    },
  };
}

describePg("hosted delivery across two instances (Postgres)", () => {
  // Instance A holds the lease and pulled the item; B commits the unbind (alias_holds and the bind_gen bump). A's next
  // pull and its receipt read the row B committed, so both are refused before A has heard of the unbind: its holder
  // still carries the old generation and the lease is still open, so the refusal is the fence's, not a finished lease's.
  // Mutations: delivery.ts `matches` without its bind_gen comparison (A's pull answers the item again); that and
  // receipt's `r.bind_gen !== row.bind_gen` both dropped (the receipt credits fe's cursor); no unbind (the bind_gen precondition fails).
  test("an unbind another instance committed refuses this instance's lease's pull and its receipt of the pulled item; the cursor stays (#1479)", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using a = await instance(db.url, "a");
    await using b = await instance(db.url, "b");
    const user = await seed(a.repo, tx => a.repo.users.upsertByEmail(tx, ME, null));
    await db.sql`INSERT INTO oauth_grants (id, user_id, expires_at, data) VALUES ('G1', ${user.id}, ${Number.MAX_SAFE_INTEGER}, '{}'::jsonb)`;
    const principal: OAuthPrincipal = { authed: { user_id: user.id, user_email: user.email, kind: "user", session_id: 0 }, clientId: OPENCODE_CLIENT, sourceKey: OPENCODE_SESSION_META, grantId: "G1", accessHash: "test", accessExpiry: Number.MAX_SAFE_INTEGER, scopes: ["tools", "delivery"] };
    const root = sessionContext(principal, { [OPENCODE_SESSION_META]: "root" });
    const rootId = (root as { id: string }).id;

    // fe and be, so the root keeps a hold (and its holder session) after fe goes.
    await a.hosted.bind(principal, root, { name: "fe", create: true });
    await a.hosted.bind(principal, root, { name: "be", create: true });
    const lease = await a.delivery.open(principal, root);
    const sender = new AppSession(a.application, a.repo, principal.authed, "sender", { push: false });
    await sender.connect();
    try {
      await sender.send(`${ME}/fe`, "to fe");
      const issued = await a.delivery.pending(principal, root, lease.capability);
      expect(issued).toHaveLength(1);
      const before = a.hosted.holder(rootId)!;
      expect(before.generation).toBe(lease.bind_gen);

      await b.hosted.unbind(principal, root, { name: "fe" });
      const after = (await b.repo.hosted.get(b.repo.read, rootId))!;
      expect(after.bind_gen).toBeGreaterThan(lease.bind_gen);
      expect((await db.sql`SELECT address FROM alias_holds ORDER BY address`).map((r: { address: string }) => r.address)).toEqual([`${ME}/be`]);

      await expect(a.delivery.pending(principal, root, lease.capability)).rejects.toHaveProperty("code", "not_found");
      await expect(a.delivery.receipt(principal, root, lease.capability, issued.map(item => item.id))).rejects.toHaveProperty("code", "not_found");
      expect(await a.repo.cursors.directFor(a.repo.read, `${ME}/fe`)).toBe(0);
      // A hasn't heard of the unbind: its holder is the old generation's and the lease is still open.
      expect(a.hosted.holder(rootId)).toEqual(before);
      expect(a.delivery.activeLeaseCount).toBe(1);
    } finally { sender.close(); }
  });
});

// #1510 chunk 2: the keyed write sites on Postgres (docs/future/postgres-server.md D4). A hosted call's end-of-call touch
// (hosted.ts touchAfter) is keyed by its root: touches of different roots overlap, a root's and its child's don't, and
// every exclusive body (an end, a bind, a revoke, a sweep) waits for a running touch. A posted audit (audit.ts
// writeAudit) is keyed by its subject and overlaps a touch. The touch is held inside its keyed body by a gate on the
// hosted store's touch UPDATE; every wait has a deadline. Without GRAYBOARD_TEST_PG_URL it skips.
const T0 = 1_800_000_000_000;
// Past TOUCH_EVERY_MS (hosted.ts), so a call's end touches its rows.
const LATER = 6_000;

type Gate = { open(): void; wait: Promise<void> };
function gate(): Gate {
  let open!: () => void;
  const wait = new Promise<void>(resolve => { open = resolve; });
  return { open, wait };
}

// One server's hosted composition on `url` (as `instance` above) with an injected clock, the hosted store's touch
// UPDATE gated in keyed bodies, and its exclusive bodies recorded.
async function keyedInstance(url: string) {
  const blobDir = mkdtempSync(join(tmpdir(), "gb-pg-blobs-"));
  let clock = T0;
  const repo: PgRepo = await makePgRepo(url, { blobDir, applicationName: "gb-test-keyed-sites", max: 4, now: () => clock });
  const q = repo.writeQueue;
  const store = repo.hosted;
  // The touch gate: an end-of-call touch's UPDATE (a keyed body at the queue site "touch": a keyed gate body's touch, at
  // "gate", passes) waits on `hold` while it's set.
  // `defer`: while set, a hosted exclusive body (the timer's sweep or heartbeat) waits on it before it queues, so none
  // lands between two touches a test has released into the queue together.
  const state = { hold: undefined as Gate | undefined, defer: undefined as Gate | undefined, held: 0, entered: [] as string[], touchQueued: 0 };
  // End-of-call touch bodies (touchAfter: the hosted store's writeKeyed at the site "touch") queued and not yet started:
  // the "touch queued" signal no close touch (application.ts, the Repo's writeKeyed) can satisfy (#1527 L4).
  const writeKeyed = store.writeKeyed;
  store.writeKeyed = ((keys: readonly string[], fn: (tx: Tx) => unknown, committed?: (v: unknown) => unknown) => {
    if (currentSite() !== "touch") return writeKeyed(keys, fn as (tx: Tx) => Promise<unknown>, committed);
    state.touchQueued++;
    return writeKeyed(keys, async (tx: Tx) => { state.touchQueued--; return fn(tx); }, committed);
  }) as typeof store.writeKeyed;
  const touch = store.touch.bind(store);
  store.touch = async (tx: Tx, id: string, t: number) => {
    const keyed = (tx as unknown as { txn?: { keys?: ReadonlySet<string> } }).txn?.keys !== undefined;
    if (keyed && currentSite() === "touch" && state.hold) {
      state.entered.push(id);
      state.held++;
      try { await state.hold.wait; } finally { state.held--; }
    }
    return touch(tx, id, t);
  };
  // Every hosted exclusive body (store.write): whether one started while a touch was held, and which were sweeps
  // (a sweep's body reads store.expired first).
  type Body = { queuedHeld: boolean; startedHeld?: boolean; sweep: boolean };
  const bodies: Body[] = [];
  let running: Body | undefined;
  const write = store.write;
  store.write = ((fn: (tx: Tx) => unknown, committed?: (v: unknown) => unknown) => {
    const queue = () => {
      const b: Body = { queuedHeld: state.held > 0, sweep: false };
      bodies.push(b);
      return write(async (tx: Tx) => {
        b.startedHeld = state.held > 0;
        running = b;
        try { return await fn(tx); } finally { running = undefined; }
      }, committed);
    };
    return state.defer ? state.defer.wait.then(queue) : queue();
  }) as typeof store.write;
  const expired = store.expired.bind(store);
  store.expired = (r, t) => { if (running) running.sweep = true; return expired(r, t); };

  const application = createApplication(repo);
  const hosted = createHostedSessions(application, { now: () => clock, isAuthorized: () => true });
  await hosted.ready;
  const user = await seed(repo, tx => repo.users.upsertByEmail(tx, ME, null));
  return {
    repo, q, hosted, user, state, bodies,
    advance(ms: number) { clock += ms; },
    async [Symbol.asyncDispose]() {
      state.hold?.open();
      try { await hosted.close(); await application.stopExpiry(); await repo.close(); }
      finally { rmSync(blobDir, { recursive: true, force: true }); }
    },
  };
}
type Instance = Awaited<ReturnType<typeof keyedInstance>>;

async function principalOf(x: Instance, sql: Awaited<ReturnType<typeof pgDatabase>>["sql"], grant: string): Promise<OAuthPrincipal> {
  await sql`INSERT INTO oauth_grants (id, user_id, expires_at, data) VALUES (${grant}, ${x.user.id}, ${Number.MAX_SAFE_INTEGER}, '{}'::jsonb)`;
  return { authed: { user_id: x.user.id, user_email: x.user.email, kind: "user", session_id: 0 }, clientId: OPENCODE_CLIENT, sourceKey: OPENCODE_SESSION_META, grantId: grant, accessHash: "test", accessExpiry: Number.MAX_SAFE_INTEGER, scopes: ["tools", "delivery"] };
}
const ctx = (p: OAuthPrincipal, source: string) => sessionContext(p, { [OPENCODE_SESSION_META]: source });
const idOf = (p: OAuthPrincipal, source: string) => (ctx(p, source) as { id: string }).id;

// A whoami tool call (no name needed) on `source` whose clock moves past the touch window during the call, so its end
// touches the row and its root (touchAfter).
const call = (x: Instance, p: OAuthPrincipal, source: string) => x.hosted.run(p, ctx(p, source), "whoami", () => { x.advance(LATER); return null; });
// Calls on `sources` whose ends are released together: each is a transfer, whose callback runs outside any write body,
// waiting until every call is in its callback. Their gate bodies (exclusive) are then all done, so nothing exclusive
// of theirs queues between the touches, and `defer` keeps the timer's out until the test opens it.
function together(x: Instance, p: OAuthPrincipal, sources: string[]) {
  let arrived = 0;
  const all = gate();
  return sources.map(s => x.hosted.transfer(p, ctx(p, s), async () => {
    x.advance(LATER);
    if (++arrived === sources.length) { x.state.defer = gate(); all.open(); }
    await all.wait;
    return null;
  }));
}

describePg("keyed write sites (Postgres)", () => {
  // Mutation: touchAfter's writeKeyed back to write (exclusive): the second root's touch never enters while the first
  // is held.
  test("end-of-call touches of different roots overlap; a root's and its child's run one at a time", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await keyedInstance(db.url);
    const p = await principalOf(x, db.sql, "G1");
    // transfer needs a named root.
    await x.hosted.bind(p, ctx(p, "root-a"), { name: "fe", create: true });
    await x.hosted.bind(p, ctx(p, "root-b"), { name: "be", create: true });
    await x.hosted.register(p, ctx(p, "root-a"), "kid-a");
    const release = () => { x.state.hold!.open(); x.state.defer?.open(); x.state.defer = undefined; };

    // Two roots: both touches are inside their keyed bodies at once.
    x.state.hold = gate();
    const both = together(x, p, ["root-a", "root-b"]);
    try { await until(() => x.state.held === 2, 10_000, "both roots' touches held at once"); }
    finally { release(); }
    expect(new Set(x.state.entered)).toEqual(new Set([idOf(p, "root-a"), idOf(p, "root-b")]));
    await Promise.all(both);

    // A root and its child: the child's touch (root-a's key) waits in the queue behind the root's.
    x.state.hold = gate();
    x.state.entered = [];
    const pair = together(x, p, ["root-a", "kid-a"]);
    try {
      // The other call's end-of-call touch waits under the same key (touchQueued: not a close touch, application.ts,
      // which queues under the same root and site, #1527 L4).
      await until(() => x.state.held === 1 && x.state.touchQueued === 1, 10_000, "one touch held, its root's other queued");
      expect(x.state.entered).toHaveLength(1);
    } finally { release(); }
    await Promise.all(pair);
    // The second touch ran once the first committed: the child's row is written (its root's, at the same instant, is
    // already current and skipped).
    expect(x.state.entered).toHaveLength(2);
    expect(x.state.entered).toContain(idOf(p, "kid-a"));
  });

  // Mutations: touchAfter's key without the root (`root:${row.session_id}`): the child's touch enters beside its root's
  // (previous test); the scheduler letting an exclusive body start beside a keyed one (store/queue.ts startNext): the
  // bodies below start while the touch is held.
  test("an end, a bind, a revoke and a sweep each wait for a running touch; a posted audit overlaps it", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await keyedInstance(db.url);
    const p = await principalOf(x, db.sql, "G1");
    await x.hosted.run(p, ctx(p, "root-a"), "whoami", () => null);
    await x.hosted.run(p, ctx(p, "root-b"), "whoami", () => null);
    // The revoke's target: another user, so the bind below keeps its grant.
    const other = await seed(x.repo, tx => x.repo.users.upsertByEmail(tx, "other@example.com", null));
    const ended = idOf(p, "root-b");

    x.state.hold = gate();
    const touched = call(x, p, "root-a");
    await until(() => x.state.held === 1, 10_000, "root-a's touch held");
    // A posted audit commits while the touch is held.
    writeAudit(x.repo, x.repo.read, "hosted.write", ME, "keyed-audit", { n: 1 });
    await until(async () => (await db.sql`SELECT count(*)::int AS n FROM access_log WHERE target = 'keyed-audit'`)[0].n === 1, 10_000, "the posted audit committed beside the touch");
    expect(x.state.held).toBe(1);

    // Each exclusive body is queued (synchronously for release and the revoke; a bind reaches its gate body after its
    // in-memory gate and auth check) and none starts while the touch is held. root-b's end and bind: the bind is another
    // root's, since a bind of root-a waits on root-a's in-memory gate, which the call holds, before it reaches the queue.
    const before = x.q.waiting;
    const end = x.hosted.release(ended, "closed");
    expect(x.q.waiting).toBe(before + 1);
    const revoke = x.repo.write(tx => x.repo.sessions.revokeAllForUser(tx, other.id));
    expect(x.q.waiting).toBe(before + 2);
    const bind = x.hosted.bind(p, ctx(p, "root-c"), { name: "fe", create: true });
    await until(() => x.q.waitingAt("gate") === 1, 10_000, "the bind's gate body queued");
    // The end and the revoke are `other`, and so is a timer sweep, which queues behind the touch too (one at a time,
    // every 250 ms); which of the timer's bodies was a sweep is checked once they've run.
    await until(() => x.q.waitingAt("other") >= 3, 10_000, "a timer body queued while the touch is held");
    expect(x.state.held).toBe(1);
    expect(x.bodies.filter(b => b.startedHeld)).toEqual([]);

    x.state.hold.open();
    await Promise.all([touched, end, revoke, bind]);
    await until(() => x.bodies.some(b => b.queuedHeld && b.sweep), 10_000, "a sweep queued during the hold ran after it");
    expect(x.bodies.filter(b => b.startedHeld)).toEqual([]);
    expect(await x.repo.hosted.get(x.repo.read, ended)).toBeUndefined();
  });
  // #1527 L4: an exclusive writer of the held root's own rows waits. The user's revoke (revokeAllForUser: G1's grant,
  // then root-a's end) queues while root-a's end-of-call touch is held, starts only after the touch committed, and
  // then ends the row the touch wrote. Mutation: touchAfter's writeKeyed passing no key the revoke conflicts with is
  // impossible (exclusive conflicts with every key); the scheduler letting an exclusive body start beside a keyed one
  // (store/queue.ts startNext): the revoke starts while the touch is held.
  test("a revoke of the held root's grant waits for its touch, then ends the root (#1527 L4)", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await keyedInstance(db.url);
    const p = await principalOf(x, db.sql, "G1");
    await x.hosted.run(p, ctx(p, "root-a"), "whoami", () => null);
    const id = idOf(p, "root-a");
    const order: string[] = [];
    const touch = x.repo.hosted.touch;
    x.repo.hosted.touch = async (tx, sid, t) => { await touch(tx, sid, t); if (currentSite() === "touch") order.push(`touch ${sid}`); };
    x.state.hold = gate();
    const touched = call(x, p, "root-a");
    await until(() => x.state.held === 1, 10_000, "root-a's touch held");
    const before = x.q.waiting;
    const revoke = x.repo.write(async tx => { order.push("revoke"); await x.repo.sessions.revokeAllForUser(tx, x.user.id); });
    expect(x.q.waiting).toBe(before + 1);
    // Still queued: the revoke's body hasn't run, the grant is live and the row stands.
    expect(order).toEqual([]);
    expect((await db.sql`SELECT revoked_at FROM oauth_grants WHERE id = 'G1'`)[0].revoked_at).toBeNull();
    x.state.hold.open();
    await Promise.all([touched, revoke]);
    expect(order).toEqual([`touch ${id}`, "revoke"]);
    expect(await x.repo.hosted.get(x.repo.read, id)).toBeUndefined();
  });

  // Mutation: writeAudit's key back to one per row (`audit:<n>`): the subject's second row commits beside the first.
  test("posted audits of one subject commit in posting order, across actions; another subject's overlap them", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await keyedInstance(db.url);
    const hold = gate();
    let first = true, held = false;
    const write = x.repo.audit.write.bind(x.repo.audit);
    x.repo.audit.write = async (tx, row) => {
      if (first && row.target === "pair") { first = false; held = true; await hold.wait; held = false; }
      return write(tx, row);
    };
    const count = async (target: string) => (await db.sql`SELECT count(*)::int AS n FROM access_log WHERE target = ${target}`)[0].n as number;
    try {
      writeAudit(x.repo, x.repo.read, "hosted.write", ME, "pair", { n: 1 });
      await until(() => held, 10_000, "the pair's first audit held in its body");
      writeAudit(x.repo, x.repo.read, "hosted.legacy_dropped", ME, "pair", { n: 2 });
      writeAudit(x.repo, x.repo.read, "hosted.write", ME, "other", { n: 3 });
      await until(async () => await count("other") === 1, 10_000, "the other subject's audit committed beside the held one");
      expect(x.q.waitingAt("audit")).toBe(1);
      expect(await count("pair")).toBe(0);
    } finally { hold.open(); }
    await until(async () => await count("pair") === 2, 10_000, "both of the subject's audits committed");
    expect((await db.sql`SELECT detail->>'n' AS n FROM access_log WHERE target = 'pair' ORDER BY id`).map((r: { n: string }) => r.n)).toEqual(["1", "2"]);
  });
});

// #1510 chunk 3: the hosted gate's keyed fast path (hosted.ts keyedBody) on Postgres. A live session's gate body runs
// keyed by its root; anything that would write beyond the touch misses before its first write and runs the exclusive
// body. The keyed body is held after settle's row locks (the grant's share lock and the root's and row's FOR UPDATE
// taken); every wait has a deadline. Without GRAYBOARD_TEST_PG_URL it skips.
const ORIGIN = "https://grayboard.example.com";
const RESOURCE = `${ORIGIN}/hosted/mcp`;

// One server's hosted composition with an injected clock and, with `oauth`, the real authorization (oauth.ts
// isAuthorized: the auth cache outside a body, uncached reads inside one). `state.hold`: a keyed gate body waits on it
// once settle has locked its rows. `defer`: while set, a write queued under no site (the timer's sweep, heartbeat and
// reconcile) waits on it before it queues, so a test's clock moves reach its own requests first. `beforePrior`: run once
// as the next prior body (withPrior's keyed body) is queued, after its checks outside the body. `priorHold`: a keyed
// prior body waits on it at its first row read, after its authorization and grant reads.
async function gateInstance(url: string, opts: { oauth?: boolean; keyedGate?: false; side?: string; idleSeconds?: number } = {}) {
  const blobDir = mkdtempSync(join(tmpdir(), "gb-pg-blobs-"));
  let clock = T0;
  const repo: PgRepo = await makePgRepo(url, { blobDir, applicationName: `gb-test-gate-${opts.side ?? "a"}`, max: 4, now: () => clock });
  const store = repo.hosted;
  const state = { hold: undefined as Gate | undefined, held: 0, keyedQueued: 0, defer: undefined as Gate | undefined, exclusive: [] as Array<{ site: string | undefined; startedHeld?: boolean }>,
    beforePrior: undefined as (() => Promise<void>) | undefined, priorHold: undefined as Gate | undefined };
  const isKeyed = (tx: unknown) => (tx as { txn?: { keys?: ReadonlySet<string> } }).txn?.keys !== undefined;
  const get = store.get.bind(store);
  store.get = (async (r: Parameters<typeof store.get>[0], id: string) => {
    if (isKeyed(r) && currentSite() === "prior" && state.priorHold) { state.held++; try { await state.priorHold.wait; } finally { state.held--; } }
    return get(r, id);
  }) as typeof store.get;
  const lock = store.lock.bind(store);
  store.lock = async (tx: Tx, id: string) => {
    const row = await lock(tx, id);
    const keyed = (tx as unknown as { txn?: { keys?: ReadonlySet<string> } }).txn?.keys !== undefined;
    if (keyed && currentSite() === "gate" && state.hold) { state.held++; try { await state.hold.wait; } finally { state.held--; } }
    return row;
  };
  // Keyed gate bodies queued and not yet started.
  const writeKeyed = store.writeKeyed;
  store.writeKeyed = ((keys: readonly string[], fn: (tx: Tx) => unknown, committed?: (v: unknown) => unknown) => {
    if (currentSite() === "prior" && state.beforePrior) {
      const before = state.beforePrior;
      state.beforePrior = undefined;
      return before().then(() => writeKeyed(keys, fn as (tx: Tx) => Promise<unknown>, committed));
    }
    if (currentSite() !== "gate") return writeKeyed(keys, fn as (tx: Tx) => Promise<unknown>, committed);
    state.keyedQueued++;
    return writeKeyed(keys, async (tx: Tx) => { state.keyedQueued--; return fn(tx); }, committed);
  }) as typeof store.writeKeyed;
  const write = store.write;
  store.write = ((fn: (tx: Tx) => unknown, committed?: (v: unknown) => unknown) => {
    const site = currentSite();
    const queue = () => {
      const b: { site: string | undefined; startedHeld?: boolean } = { site };
      state.exclusive.push(b);
      return write(async (tx: Tx) => { b.startedHeld = state.held > 0; return fn(tx); }, committed);
    };
    return site === undefined && state.defer ? state.defer.wait.then(queue) : queue();
  }) as typeof store.write;
  const application = createApplication(repo);
  const oauth = opts.oauth ? createOAuthServer(repo, { store: { kind: "postgres", url }, blobDir, httpPort: 0, googleClientId: "dev", googleClientSecret: "", orgDomain: "example.com", publicUrl: `${ORIGIN}:443/hosted`, messageRetentionDays: 90, auditRetentionDays: 90, devAuth: true, admins: [], helloLimit: DEFAULT_HELLO_LIMIT, authFailLimit: DEFAULT_AUTH_FAIL_LIMIT, trustedProxies: DEFAULT_TRUSTED_PROXIES }, { now: () => clock }) : undefined;
  await oauth?.ready;
  const hosted = createHostedSessions(application, { now: () => clock, isAuthorized: oauth ? (p, r) => oauth.isAuthorized(p, r) : () => true, ...(opts.keyedGate === false ? { keyedGate: false as const } : {}), ...(opts.idleSeconds ? { idleSeconds: opts.idleSeconds } : {}) });
  await hosted.ready;
  return {
    repo, hosted, state, oauth, q: repo.writeQueue,
    advance(ms: number) { clock += ms; },
    get clock() { return clock; },
    // Every write queued so far committed (an exclusive body waits for the keyed ones ahead of it): the posted audits
    // and close touches among them.
    drain: () => atSite("other", () => repo.write(() => {})),
    async [Symbol.asyncDispose]() {
      state.hold?.open(); state.defer?.open(); state.priorHold?.open();
      try { await hosted.close(); await application.stopExpiry(); oauth?.close(); await repo.close(); }
      finally { rmSync(blobDir, { recursive: true, force: true }); }
    },
  };
}
type GateInstance = Awaited<ReturnType<typeof gateInstance>>;

// A real principal: a grant issued through the store and its token authenticated, as a request's would be.
async function issued(x: GateInstance, email = ME) {
  const i = await issueOAuth(x.repo, RESOURCE, email, ["grayboard:tools"], x.clock, OPENCODE_CLIENT);
  const p = await x.oauth!.authenticate(new Request(RESOURCE, { headers: { Authorization: `Bearer ${i.token}` } }), ["grayboard:tools"]);
  if (p instanceof Response) throw new Error("fixture auth failed");
  // `token`: the refresh token, whose revoke revokes the grant (and ends its sessions); `access`: the access token,
  // whose revoke leaves the grant live.
  return { p, token: i.refreshToken, access: i.token };
}
const whoami = (x: GateInstance, p: OAuthPrincipal, source: string, meta: Record<string, unknown> = {}) =>
  x.hosted.run(p, sessionContext(p, { [OPENCODE_SESSION_META]: source, ...meta }), "whoami", async () => null);
const delta = () => {
  const at = { keyed: gateCount("gate", "keyed"), miss: gateCount("gate", "miss"), skipped: gateCount("gate", "skipped") };
  return () => ({ keyed: gateCount("gate", "keyed") - at.keyed, miss: gateCount("gate", "miss") - at.miss, skipped: gateCount("gate", "skipped") - at.skipped });
};
const priorDelta = () => {
  const at = { keyed: gateCount("prior", "keyed"), miss: gateCount("prior", "miss") };
  return () => ({ keyed: gateCount("prior", "keyed") - at.keyed, miss: gateCount("prior", "miss") - at.miss });
};
const lockWaiters = async (sql: Awaited<ReturnType<typeof pgDatabase>>["sql"]) =>
  (await sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)[0].n as number;

describePg("hosted gate keyed fast path (Postgres)", () => {
  // Mutations: keyedBody's writeKeyed back to write (the second root's body never enters while the first is held);
  // its key `root:${context.id}` dropped for a constant (two roots' bodies run one at a time).
  test("fast paths of one grant on different roots overlap; two on one root run one at a time", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await gateInstance(db.url, { oauth: true });
    const { p } = await issued(x);
    await whoami(x, p, "root-a");
    await whoami(x, p, "root-b");
    const d = delta();
    x.state.hold = gate();
    const both = [whoami(x, p, "root-a"), whoami(x, p, "root-b")];
    try { await until(() => x.state.held === 2, 10_000, "both roots' keyed gate bodies held at once"); } finally { x.state.hold.open(); }
    await Promise.all(both);
    x.state.hold = gate();
    const same = [whoami(x, p, "root-a"), whoami(x, p, "root-a")];
    try {
      await until(() => x.state.held === 1 && x.state.keyedQueued === 1, 10_000, "one root-a body held, the other queued under its key");
      expect(x.state.held).toBe(1);
    } finally { x.state.hold.open(); }
    await Promise.all(same);
    expect(d()).toEqual({ keyed: 4, miss: 0, skipped: 0 });
  });

  // Each exclusive writer of the held root's rows queues behind the keyed gate body and starts only after it: a
  // revoke and a disable (each ends the root), an end, and the timer's sweep. The call the gate let through then meets
  // the committed change in its tool body (fence), which queued behind it: a revoke or disable refuses it
  // unauthenticated, an end unbound. Mutation: the scheduler letting an
  // exclusive body start beside a keyed one (store/queue.ts startNext): each starts while the body is held.
  for (const op of ["revoke", "disable", "end", "sweep"] as const) test(`a ${op} waits for a running keyed gate body of the root`, async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await gateInstance(db.url, { oauth: true });
    const { p, token } = await issued(x);
    await whoami(x, p, "root-a");
    const id = idOf(p, "root-a");
    const d = delta();
    x.state.hold = gate();
    const held = whoami(x, p, "root-a");
    await until(() => x.state.held === 1, 10_000, "root-a's keyed gate body held");
    const before = x.state.exclusive.length;
    const run = op === "revoke" ? x.repo.write(tx => x.repo.oauth.revokeToken(tx, hashToken(token), OPENCODE_CLIENT, x.clock))
      : op === "disable" ? x.repo.write(tx => x.repo.users.setDisabled(tx, p.authed.user_id, true))
      : op === "end" ? x.hosted.release(id, "closed")
      : until(() => x.state.exclusive.slice(before).some(b => b.site === undefined), 10_000, "a timer body queued");
    if (op === "sweep") await run; else await until(() => x.q.waiting >= 1, 10_000, `the ${op} queued`);
    expect(x.state.held).toBe(1);
    x.state.hold.open();
    const [result] = await Promise.all([held.catch((e: Error) => e.message), run]);
    expect(result).toBe(op === "revoke" || op === "disable" ? "unauthenticated" : op === "end" ? "session binding changed; select the current binding again" : null);
    expect(x.state.exclusive.filter(b => b.startedHeld)).toEqual([]);
    expect(d()).toEqual({ keyed: 1, miss: 0, skipped: 0 });
    if (op !== "sweep") expect(await x.repo.hosted.get(x.repo.read, id)).toBeUndefined();
  });

  // A revoke (of the grant, or of only the access token) or a disable that commits after the gate's cached check and
  // before its body: the keyed body's authorization, read in its own transaction, refuses before the probe, so no keyed
  // body acts on auth state older than its start. Mutation: keyedBody without its authorized(p, tx): the access token's
  // revoke leaves the grant live, so grantLive passes and the body runs keyed (the tool body's fence refuses later).
  for (const op of ["revoke", "access revoke", "disable"] as const) test(`a ${op} committed between the gate's cached check and its keyed body refuses it`, async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await gateInstance(db.url, { oauth: true });
    const { p, token, access } = await issued(x);
    await whoami(x, p, "root-a");
    // Warm: the cache serves the gate's check outside the body.
    await whoami(x, p, "root-a");
    const d = delta();
    const call = hostedPause("hosted:gate:checked", () => whoami(x, p, "root-a"), async () => {
      await x.repo.write(tx => op === "disable" ? x.repo.users.setDisabled(tx, p.authed.user_id, true) : x.repo.oauth.revokeToken(tx, hashToken(op === "revoke" ? token : access), OPENCODE_CLIENT, x.clock));
    });
    await expect(call).rejects.toThrow("unauthenticated");
    expect(d()).toEqual({ keyed: 0, miss: 0, skipped: 0 });
    expect(x.state.exclusive.filter(b => b.site === "gate")).toHaveLength(1);
  });

  // An end, a park and an idle sweep that would happen (or happened) first: the keyed attempt misses before its first
  // write and the exclusive body does the work. Mutation: keyedBody running settle outside readsOnly (the end, the
  // park: the keyed body writes them, so no miss is counted).
  test("an ended root, an idle child and an idle root each miss, and the exclusive body creates, parks and unparks, or ends and creates", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await gateInstance(db.url, { oauth: true, idleSeconds: 60 });
    const { p } = await issued(x);
    await whoami(x, p, "root-a");
    await atSite("other", () => x.hosted.register(p, sessionContext(p, { [OPENCODE_SESSION_META]: "root-a" }), "kid-a"));
    await whoami(x, p, "root-b");
    x.state.defer = gate();
    const own = async (source: string) => (await x.repo.hosted.get(x.repo.read, idOf(p, source)))?.ownership_id;
    // An end committed first: the row is gone, the keyed attempt misses, and the exclusive body starts a new one.
    const d = delta();
    const was = await own("root-b");
    await atSite("other", () => x.hosted.release(idOf(p, "root-b"), "closed"));
    // The pool pre-read finds no row: a skip, and the exclusive body creates it.
    await whoami(x, p, "root-b");
    expect(d()).toEqual({ keyed: 0, miss: 0, skipped: 1 });
    expect(await own("root-b")).not.toBe(was);
    // An idle child under a fresh root: settle would park it.
    await whoami(x, p, "kid-a");
    x.advance(36_000);
    await whoami(x, p, "root-a");
    x.advance(30_000);
    const parks = async (action: string) => (await db.sql`SELECT count(*)::int AS n FROM access_log WHERE action = ${action}`)[0].n as number;
    const d2 = delta();
    await whoami(x, p, "kid-a");
    await x.drain();
    expect(d2()).toEqual({ keyed: 0, miss: 1, skipped: 0 });
    expect([await parks("hosted.child_parked"), await parks("hosted.child_unparked")]).toEqual([1, 1]);
    // An idle root with no hold: settle would end it.
    x.advance(61_000);
    const d3 = delta();
    const old = await own("root-b");
    await whoami(x, p, "root-b");
    expect(d3()).toEqual({ keyed: 0, miss: 1, skipped: 0 });
    expect(await own("root-b")).not.toBe(old);
  });

  // A launcher declaration writes once (store/pg/hosted.ts declareLauncher reads first): its first request misses, the
  // next one is keyed. Mutation: declareLauncher's read dropped (every declaring request misses on its UPDATE).
  test("a repeated launcher declaration is keyed after the first, which misses", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await gateInstance(db.url, { oauth: true });
    const { p } = await issued(x);
    await whoami(x, p, "root-a");
    const d = delta();
    await whoami(x, p, "root-a", { [GRAYBOARD_LAUNCHER_META]: true });
    await whoami(x, p, "root-a", { [GRAYBOARD_LAUNCHER_META]: true });
    expect(d()).toEqual({ keyed: 1, miss: 1, skipped: 0 });
    expect((await db.sql`SELECT launcher FROM ids WHERE id = ${idOf(p, "root-a")}`)[0].launcher).toBe(true);
  });

  // Across instances a bind's exclusive body (another process's) waits on the keyed body's row locks; its commit
  // first leaves nothing for the keyed body to miss on (bind changes neither settle's nor rowFor's verdict).
  // Mutation: store.lock without FOR UPDATE (the other instance's bind doesn't wait on a lock).
  test("another instance's bind waits on the keyed body's row locks; a bind committed first leaves the next call keyed", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using a = await gateInstance(db.url, { oauth: true, side: "a" });
    await using b = await gateInstance(db.url, { oauth: true, side: "b" });
    const { p } = await issued(a);
    await whoami(a, p, "root-a");
    const id = idOf(p, "root-a");
    a.state.hold = gate();
    const held = whoami(a, p, "root-a");
    await until(() => a.state.held === 1, 10_000, "A's keyed gate body held");
    const bind = b.hosted.bind(p, sessionContext(p, { [OPENCODE_SESSION_META]: "root-a" }), { name: "fe", create: true });
    try { await until(async () => await lockWaiters(db.sql) >= 1, 10_000, "B's bind waiting on A's row lock"); } finally { a.state.hold.open(); }
    // A's call's tool body (fence) runs on A's queue, beside B's bind on another process: it commits before the bind
    // (the call stands) or meets it (the binding it selected changed). Either is the exclusive path's outcome too.
    const [result] = await Promise.all([held.catch((e: Error) => e.message), bind]);
    expect([null, "session binding changed; select the current binding again"]).toContain(result);
    const gen = (await a.repo.hosted.get(a.repo.read, id))!.bind_gen;
    expect(gen).toBeGreaterThan(0);
    const d = delta();
    await whoami(a, p, "root-a");
    expect(d()).toEqual({ keyed: 1, miss: 0, skipped: 0 });
  });

  // Miss-then-exclusive writes what the exclusive body alone writes: one script (creation, a child, a park, a facts
  // change, a launcher declaration, an idle end) on two fresh databases, one with the fast path
  // and one without (keyedGate: false), then every row of the tables the gate writes compared. Mutation: keyedBody
  // without its probe (readsOnly): the keyed attempt writes a park or an end itself and the exclusive body runs on
  // top, so the rows differ.
  // The timer's sweep parks an idle child of the held root only once the keyed gate body has committed: the sweep body
  // itself (queued at the site "other" here, unlike the timer's) waits, starts after the hold, and parks. The timer's own
  // bodies are deferred so none of them parks the child first. Mutation: as above, the scheduler letting an exclusive
  // body start beside a keyed one.
  test("a sweep that parks the held root's idle child waits for the keyed gate body, then parks it", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await gateInstance(db.url, { oauth: true, idleSeconds: 60 });
    const { p } = await issued(x);
    await whoami(x, p, "root-a");
    await atSite("other", () => x.hosted.register(p, sessionContext(p, { [OPENCODE_SESSION_META]: "root-a" }), "kid-a"));
    await whoami(x, p, "kid-a");
    x.state.defer = gate();
    x.advance(36_000);
    await whoami(x, p, "root-a");
    x.advance(30_000);
    const kid = idOf(p, "kid-a");
    const d = delta();
    x.state.hold = gate();
    const held = whoami(x, p, "root-a");
    await until(() => x.state.held === 1, 10_000, "root-a's keyed gate body held");
    const before = x.state.exclusive.length;
    const sweep = atSite("other", () => x.hosted.sweep(true));
    await until(() => x.q.waiting >= 1, 10_000, "the sweep queued");
    const body = x.state.exclusive.slice(before).filter(b => b.site === "other");
    expect(body).toHaveLength(1);
    expect(body[0]!.startedHeld).toBeUndefined();
    expect((await x.repo.hosted.get(x.repo.read, kid))?.parked_at).toBeNull();
    x.state.hold.open();
    await Promise.all([held, sweep]);
    expect(body[0]!.startedHeld).toBe(false);
    expect((await x.repo.hosted.get(x.repo.read, kid))?.parked_at).not.toBeNull();
    expect(d()).toEqual({ keyed: 1, miss: 0, skipped: 0 });
  });

  // An in-process bind of the held root: the BindGate holds it behind the running call, so it queues nothing until the
  // keyed body and the call finish, then binds.
  test("an in-process bind of the held root waits for the keyed gate body's call, then binds", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await gateInstance(db.url, { oauth: true });
    const { p } = await issued(x);
    await whoami(x, p, "root-a");
    const d = delta();
    x.state.hold = gate();
    const held = whoami(x, p, "root-a");
    await until(() => x.state.held === 1, 10_000, "root-a's keyed gate body held");
    let bound = false;
    const bind = x.hosted.bind(p, sessionContext(p, { [OPENCODE_SESSION_META]: "root-a" }), { name: "fe", create: true }).then(r => { bound = true; return r; });
    await new Promise(r => setTimeout(r, 200));
    expect(bound).toBe(false);
    expect(x.state.held).toBe(1);
    expect((await db.sql`SELECT count(*)::int AS n FROM aliases WHERE name = 'fe'`)[0].n).toBe(0);
    x.state.hold.open();
    await Promise.all([held, bind]);
    expect(bound).toBe(true);
    expect((await db.sql`SELECT count(*)::int AS n FROM aliases WHERE name = 'fe'`)[0].n).toBe(1);
    expect(x.state.exclusive.filter(b => b.startedHeld)).toEqual([]);
    expect(d().keyed).toBeGreaterThanOrEqual(1);
  });

  // The pool's pre-read names a root the row no longer lives under (here: the child read as a root): the keyed body,
  // keyed by that stale root, finds the row under another and misses before its touch, so no keyed body writes another
  // key's rows; the exclusive body then sees the change and the retry runs keyed under the real root. Mutation: the
  // keyed body's `!== id` MISS dropped (it touches root-a's rows under key `root:<kid>`: keyed 2, miss 0).
  test("a row under another root than the pool read named misses before its touch", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await gateInstance(db.url, { oauth: true });
    const { p } = await issued(x);
    await whoami(x, p, "root-a");
    await atSite("other", () => x.hosted.register(p, sessionContext(p, { [OPENCODE_SESSION_META]: "root-a" }), "kid-a"));
    await whoami(x, p, "kid-a");
    const kid = idOf(p, "kid-a");
    const get = x.repo.hosted.get;
    let stale = true;
    x.repo.hosted.get = (async (r: Parameters<typeof get>[0], id: string) => {
      const row = await get(r, id);
      if (stale && r === x.repo.read && id === kid && row) { stale = false; return { ...row, root_session_id: null }; }
      return row;
    }) as typeof get;
    const d = delta();
    await whoami(x, p, "kid-a");
    expect(stale).toBe(false);
    expect(d()).toEqual({ keyed: 1, miss: 1, skipped: 0 });
  });

  // A revoke of only the access token (the grant stays live) or a disable committed after withPrior's checks outside the
  // body and before its keyed body: the body's own authorization, read uncached in its transaction, refuses before it
  // compares or touches anything. Mutation: the prior body without authorized(p, tx) (it runs keyed and touches, and only
  // the tool body's fence refuses: prior keyed 1).
  for (const op of ["access revoke", "disable"] as const) test(`a ${op} committed between withPrior's checks and its keyed body refuses it`, async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await gateInstance(db.url, { oauth: true });
    const { p, access } = await issued(x);
    await whoami(x, p, "root-a");
    const c = sessionContext(p, { [OPENCODE_SESSION_META]: "root-a" });
    const verdict = (await x.hosted.snapshot(p, c, false)).verdict!;
    // The path works: a prior call with nothing between runs keyed.
    const warm = priorDelta();
    await x.hosted.run(p, c, "whoami", async () => null, undefined, verdict);
    expect(warm()).toEqual({ keyed: 1, miss: 0 });
    const d = priorDelta();
    x.state.beforePrior = async () => {
      await atSite("other", () => x.repo.write(tx => op === "disable" ? x.repo.users.setDisabled(tx, p.authed.user_id, true) : x.repo.oauth.revokeToken(tx, hashToken(access), OPENCODE_CLIENT, x.clock)));
    };
    await expect(x.hosted.run(p, c, "whoami", async () => null, undefined, verdict)).rejects.toThrow("unauthenticated");
    expect(x.state.beforePrior).toBeUndefined();
    expect(d()).toEqual({ keyed: 0, miss: 0 });
  });

  // The prior body share-locks its grant before it reads the rows: another process's revoke of the grant waits for the
  // body (and the body, reading after a revoke, refuses), so no call outlives its grant's revoke. Mutation: the prior
  // body without grantLive (the revoke's UPDATE commits while the body is held).
  test("another process's grant revoke waits for a running prior body's share lock", async () => {
    await using db = await pgDatabase({ max: 3 });
    await using x = await gateInstance(db.url, { oauth: true });
    const { p } = await issued(x);
    await whoami(x, p, "root-a");
    const c = sessionContext(p, { [OPENCODE_SESSION_META]: "root-a" });
    const verdict = (await x.hosted.snapshot(p, c, false)).verdict!;
    const d = priorDelta();
    x.state.priorHold = gate();
    const held = x.hosted.run(p, c, "whoami", async () => null, undefined, verdict);
    await until(() => x.state.held === 1, 10_000, "the prior body held after its grant read");
    let revoked = false;
    const revoke = db.sql`UPDATE oauth_grants SET revoked_at = ${x.clock} WHERE id = ${p.grantId}`.then(() => { revoked = true; });
    await until(async () => await lockWaiters(db.sql) >= 1, 10_000, "the revoke waiting on the grant's share lock");
    expect(revoked).toBe(false);
    x.state.priorHold.open();
    await Promise.all([held.catch(() => {}), revoke]);
    expect(revoked).toBe(true);
    expect(d()).toEqual({ keyed: 1, miss: 0 });
  });

  // pg_repo wires the notices' refusal (makeNotices' refuseKeyed): a notice-queuing write in a keyed body refuses by its
  // op name before its statement runs. Mutation: makeNotices without the refusal (the write runs, and only the
  // afterCommit refusal, naming no op, rolls it back).
  test("a notice-queuing Repo write in a keyed body refuses by its op name and writes nothing", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await gateInstance(db.url, { oauth: true });
    const { p } = await issued(x);
    await expect(atSite("other", () => x.repo.writeKeyed(["k"], tx => x.repo.users.setDisabled(tx, p.authed.user_id, true))))
      .rejects.toThrow("users.setDisabled (it queues a change notice) refused in a keyed write body");
    expect((await db.sql`SELECT disabled_at FROM users WHERE id = ${p.authed.user_id}`)[0].disabled_at).toBeNull();
  });

  // The Repo's writeKeyed passes no options through (audit L7): `{ effects: true }` exists only on PgTransactions, so a
  // caller that slips it past the types still has its effect refused. Mutation: the Repo's writeKeyed as t.writeKeyed.
  test("the Repo's writeKeyed drops an effects opt-in a caller passes past its types", async () => {
    await using db = await pgDatabase({ max: 2 });
    const blobDir = mkdtempSync(join(tmpdir(), "gb-pg-blobs-"));
    const repo = await makePgRepo(db.url, { blobDir, applicationName: "gb-test-l7", max: 2 });
    try {
      let ran = 0;
      type Loose = (keys: string[], fn: (tx: Tx) => Promise<void>, committed: undefined, opts: { effects: true }) => Promise<void>;
      for (const loose of [repo.writeKeyed as unknown as Loose, repo.hosted.writeKeyed as unknown as Loose]) {
        await expect(atSite("other", () => loose(["k"], async tx => { tx.afterCommit(() => { ran++; }); }, undefined, { effects: true })))
          .rejects.toThrow("afterCommit effect refused in a keyed write body (keys k)");
      }
      expect(ran).toBe(0);
    } finally { await repo.close(); rmSync(blobDir, { recursive: true, force: true }); }
  });

  test("miss-then-exclusive writes the same rows as the exclusive body alone", async () => {
    const script = async (x: GateInstance, sql: Awaited<ReturnType<typeof pgDatabase>>["sql"]) => {
      const user = await seed(x.repo, tx => x.repo.users.upsertByEmail(tx, ME, null));
      await sql`INSERT INTO oauth_grants (id, user_id, expires_at, data) VALUES ('G1', ${user.id}, ${Number.MAX_SAFE_INTEGER}, '{}'::jsonb)`;
      const p: OAuthPrincipal = { authed: { user_id: user.id, user_email: user.email, kind: "user", session_id: 0 }, clientId: OPENCODE_CLIENT, sourceKey: OPENCODE_SESSION_META, grantId: "G1", accessHash: "test", accessExpiry: Number.MAX_SAFE_INTEGER, scopes: ["tools", "delivery"] };
      x.state.defer = gate();
      const reg = (root: string, kid: string) => atSite("other", () => x.hosted.register(p, sessionContext(p, { [OPENCODE_SESSION_META]: root }), kid));
      const d = delta();
      await whoami(x, p, "root-a"); x.advance(10);
      await whoami(x, p, "root-b"); x.advance(10);
      await reg("root-a", "kid-a"); x.advance(10);
      await whoami(x, p, "kid-a"); x.advance(36_000);
      await whoami(x, p, "root-a"); x.advance(30_000);
      await whoami(x, p, "kid-a"); x.advance(6_000);
      await whoami(x, p, "root-a", { [GRAYBOARD_MODEL_META]: "m-2" }); x.advance(6_000);
      await whoami(x, p, "root-a", { [GRAYBOARD_LAUNCHER_META]: true }); x.advance(6_000);
      await whoami(x, p, "root-a", { [GRAYBOARD_LAUNCHER_META]: true, [GRAYBOARD_MODEL_META]: "m-2" }); x.advance(6_000);
      await whoami(x, p, "kid-a"); x.advance(61_000);
      await whoami(x, p, "root-a"); x.advance(10);
      await whoami(x, p, "root-a");
      await x.drain();
      return d();
    };
    const dump = async (sql: Awaited<ReturnType<typeof pgDatabase>>["sql"]) => {
      const out: Record<string, string[]> = {};
      for (const [table, drop] of [["hosted_sessions", []], ["hosted_ownerships", []], ["ids", []], ["access_log", ["id"]], ["binding_events", ["id"]]] as const) {
        const rows: Array<Record<string, unknown>> = await sql.unsafe(`SELECT * FROM ${table}`);
        out[table] = rows.map(r => JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => !(drop as readonly string[]).includes(k)).sort(([a], [b]) => a < b ? -1 : 1)), (_k, v) => typeof v === "bigint" ? String(v) : v)).sort();
      }
      return out;
    };
    await using fastDb = await pgDatabase({ max: 2 });
    await using refDb = await pgDatabase({ max: 2 });
    let fastRows: Record<string, string[]>, refRows: Record<string, string[]>, counts: { keyed: number; miss: number; skipped: number };
    { await using fast = await gateInstance(fastDb.url, { idleSeconds: 60, side: "fast" }); counts = await script(fast, fastDb.sql); fastRows = await dump(fastDb.sql); }
    { await using ref = await gateInstance(refDb.url, { idleSeconds: 60, side: "ref", keyedGate: false }); await script(ref, refDb.sql); refRows = await dump(refDb.sql); }
    // The fast instance ran both kinds: keyed hits and misses (the park, the facts change, the first launcher
    // declaration, the idle end).
    expect(counts.keyed).toBeGreaterThan(0);
    expect(counts.miss).toBeGreaterThanOrEqual(4);
    expect(fastRows).toEqual(refRows);
    expect(fastRows.access_log!.length).toBeGreaterThan(0);
  });
});
