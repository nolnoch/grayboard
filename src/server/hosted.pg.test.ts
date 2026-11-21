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
import { createApplication, KeyedSendMiss } from "./application.ts";
import { writeAudit } from "./audit.ts";
import { createDelivery } from "./delivery.ts";
import { createHostedSessions, sessionContext } from "./hosted.ts";
import { OPENCODE_CLIENT, OPENCODE_SESSION_META } from "./oauth-config.ts";
import type { OAuthPrincipal } from "./oauth.ts";
import { makePgRepo, type PgRepo } from "./pg_repo.ts";
import { atSite, currentSite, RequestAbortedError } from "./store/queue.ts";
import { DEFAULT_AUTH_FAIL_LIMIT, DEFAULT_HELLO_LIMIT } from "./rate_limit.ts";
import { DEFAULT_TRUSTED_PROXIES } from "./client_addr.ts";
import { createOAuthServer } from "./oauth.ts";
import { hashToken } from "./auth.ts";
import { gateCount, refusalCount, statementTotals } from "./metrics.ts";
import { GRAYBOARD_EFFORT_META, GRAYBOARD_LAUNCHER_META, GRAYBOARD_MODEL_META } from "../shared/session_meta.ts";
import { issueOAuth } from "../../tests/helpers/oauth.ts";
import { hostedPause } from "../../tests/support/hosted-pause.ts";
import { isTx, type Tx } from "./store/tx_base.ts";
import { pgOf } from "./store/pg/tx.ts";

// Above the pool's 5 s lock_timeout (pg/tx.ts), so a broken lock fails on its own error, not on Bun's timeout.
setDefaultTimeout(30_000);

const ME = "you@example.com";
// The timer's exclusive bodies (hosted.ts: the sweep and the reconcile), which a test's `defer` holds back.
const timerSite = (site: string | undefined) => site === "sweep" || site === "reconcile";

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
  // `defer`: while set, a hosted exclusive body (the timer's sweep; the heartbeat is keyed) waits on it before it queues, so none
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
    // A sweep called directly: the timer's skips when the pool finds nothing due (#1537 PR 6).
    const swept = x.hosted.sweep(true);
    expect(x.q.waiting).toBe(before + 3);
    const bind = x.hosted.bind(p, ctx(p, "root-c"), { name: "fe", create: true });
    await until(() => x.q.waitingAt("gate") === 1, 10_000, "the bind's gate body queued");
    expect(x.state.held).toBe(1);
    expect(x.bodies.filter(b => b.startedHeld)).toEqual([]);

    x.state.hold.open();
    await Promise.all([touched, end, revoke, bind, swept]);
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
// once settle has locked its rows. `defer`: while set, a write queued at a timer site (the timer's sweep and
// reconcile) waits on it before it queues, so a test's clock moves reach its own requests first. `beforePrior`: run once
// as the next prior body (withPrior's keyed body) is queued, after its checks outside the body. `priorHold`: a keyed
// prior body waits on it at its first row read, after its authorization and grant reads.
async function gateInstance(url: string, opts: { oauth?: boolean; keyedGate?: false; side?: string; idleSeconds?: number; caps?: { perUser: number; global: number } } = {}) {
  const blobDir = mkdtempSync(join(tmpdir(), "gb-pg-blobs-"));
  let clock = T0;
  const repo: PgRepo = await makePgRepo(url, { blobDir, applicationName: `gb-test-gate-${opts.side ?? "a"}`, max: 4, now: () => clock });
  const store = repo.hosted;
  const state = { hold: undefined as Gate | undefined, held: 0, keyedQueued: 0, defer: undefined as Gate | undefined, exclusive: [] as Array<{ site: string | undefined; startedHeld?: boolean }>,
    beforePrior: undefined as (() => Promise<void>) | undefined, priorHold: undefined as Gate | undefined, absent: new Map<string, number>(), onAbsent: undefined as ((id: string) => void) | undefined, denyNext: false };
  const isKeyed = (tx: unknown) => (tx as { txn?: { keys?: ReadonlySet<string> } }).txn?.keys !== undefined;
  const get = store.get.bind(store);
  store.get = (async (r: Parameters<typeof store.get>[0], id: string) => {
    if (isKeyed(r) && currentSite() === "prior" && state.priorHold) { state.held++; try { await state.priorHold.wait; } finally { state.held--; } }
    const row = await get(r, id);
    if (!isTx(r) && row === undefined) { state.absent.set(id, (state.absent.get(id) ?? 0) + 1); state.onAbsent?.(id); }
    return row;
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
    return timerSite(site) && state.defer ? state.defer.wait.then(queue) : queue();
  }) as typeof store.write;
  const application = createApplication(repo);
  const oauth = opts.oauth ? createOAuthServer(repo, { store: { kind: "postgres", url }, blobDir, httpPort: 0, googleClientId: "dev", googleClientSecret: "", orgDomain: "example.com", publicUrl: `${ORIGIN}:443/hosted`, messageRetentionDays: 90, auditRetentionDays: 90, devAuth: true, admins: [], helloLimit: DEFAULT_HELLO_LIMIT, authFailLimit: DEFAULT_AUTH_FAIL_LIMIT, trustedProxies: DEFAULT_TRUSTED_PROXIES }, { now: () => clock }) : undefined;
  await oauth?.ready;
  const hosted = createHostedSessions(application, { now: () => clock, isAuthorized: (p, r) => { if (state.denyNext) { state.denyNext = false; return false; } return oauth ? oauth.isAuthorized(p, r) : true; }, ...(opts.keyedGate === false ? { keyedGate: false as const } : {}), ...(opts.idleSeconds ? { idleSeconds: opts.idleSeconds } : {}), ...(opts.caps ? { caps: opts.caps } : {}) });
  await hosted.ready;
  // Delivery on the same authorization, for the subscriber calls' verdict reuse (#1537 C5, C7).
  const delivery = createDelivery(hosted, { isAuthorized: (p, r) => oauth ? oauth.isAuthorized(p, r) : true });
  return {
    repo, hosted, delivery, state, oauth, q: repo.writeQueue,
    advance(ms: number) { clock += ms; },
    get clock() { return clock; },
    // Every write queued so far committed (an exclusive body waits for the keyed ones ahead of it): the posted audits
    // and close touches among them.
    drain: () => atSite("other", () => repo.write(() => {})),
    async [Symbol.asyncDispose]() {
      state.hold?.open(); state.defer?.open(); state.priorHold?.open();
      try { delivery.close(); await hosted.close(); await application.stopExpiry(); oauth?.close(); await repo.close(); }
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

  // #1537 PR 0: the keyed gate body's statements, pinned so a later round-trip cut updates them on purpose. A live
  // root, no facts, the touch window not passed: 8, BEGIN; authorized's findActiveAccess and users.active; grantLive's
  // FOR SHARE; settle's store.lock (the root probe, then the row FOR UPDATE); the auth-mark read; COMMIT. rowFor and
  // rootOf send nothing (they use settle's rows). With the clock past the touch window the root's touch adds its
  // UPDATE: 9. Every statement is awaited, so each is its own round trip. The method label is the tool call's (`tool`).
  // Mutation: tx.ts statements() without counted (the counts drop to the framing's 3).
  test("a keyed gate body sends a pinned number of statements, one round trip each (#1537 PR 0)", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await gateInstance(db.url, { oauth: true });
    const { p } = await issued(x);
    await whoami(x, p, "root-a");
    await whoami(x, p, "root-a");
    const measured = async (fn: () => Promise<unknown>) => {
      const at = statementTotals("gate"), tool = gateCount("gate", "keyed", "tool");
      await fn();
      const now = statementTotals("gate");
      return { bodies: now.bodies - at.bodies, statements: now.statements - at.statements, roundTrips: now.roundTrips - at.roundTrips, keyedTool: gateCount("gate", "keyed", "tool") - tool };
    };
    expect(await measured(() => whoami(x, p, "root-a"))).toEqual({ bodies: 1, statements: 8, roundTrips: 8, keyedTool: 1 });
    x.advance(LATER);
    expect(await measured(() => whoami(x, p, "root-a"))).toEqual({ bodies: 1, statements: 9, roundTrips: 9, keyedTool: 1 });
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
      : atSite("other", () => x.hosted.sweep(true));
    await until(() => x.q.waiting >= 1, 10_000, `the ${op} queued`);
    expect(x.state.held).toBe(1);
    x.state.hold.open();
    const [result] = await Promise.all([held.catch((e: Error) => e.message), run]);
    expect(result).toBe(op === "revoke" || op === "disable" ? "unauthenticated" : op === "end" ? "session binding changed; select the current binding again" : null);
    expect(x.state.exclusive.filter(b => b.startedHeld)).toEqual([]);
    expect(d()).toEqual({ keyed: 1, miss: 0, skipped: 0 });
    if (op !== "sweep") expect(await x.repo.hosted.get(x.repo.read, id)).toBeUndefined();
  });

  // #1535: a keyed gate body whose request aborts while it waits (behind an exclusive holder) is skipped: the call
  // rejects RequestAbortedError, and the exclusive body never runs after it (a skip isn't a miss). Mutation: keyedBody
  // catching RequestAbortedError as MISS (the exclusive gate body runs); no signal passed (the body runs).
  test("a keyed gate body whose request aborts while it waits is skipped, with no exclusive fallback", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await gateInstance(db.url, { oauth: true });
    const { p } = await issued(x);
    await whoami(x, p, "root-a");
    const d = delta(), before = x.state.exclusive.length;
    let release!: () => void;
    const holder = x.q.run(() => new Promise<void>(r => { release = r; }));
    const ac = new AbortController();
    const call = x.hosted.run(p, sessionContext(p, { [OPENCODE_SESSION_META]: "root-a" }), "whoami", async () => null, undefined, undefined, ac.signal);
    const failed = call.catch(e => e);
    try {
      await until(() => x.state.keyedQueued === 1, 10_000, "root-a's keyed gate body queued behind the holder");
      ac.abort();
      expect(await failed).toBeInstanceOf(RequestAbortedError);
    } finally { release(); }
    await holder;
    await x.drain();
    expect(d()).toEqual({ keyed: 0, miss: 0, skipped: 0 });
    expect(x.state.exclusive.slice(before).filter(b => b.site === "gate")).toEqual([]);
    expect(x.q.idle).toBe(true);
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

  // withPrior stands in for rowFor only while the selection's change-only writes still read as made (#364): a request
  // built before a facts switch and committed after it (a lease op with the old model and effort) reverts them, and a
  // launcher flag can read off. A prior whose request's model, effort or launcher declaration differs from what's stored
  // misses, and the full gate writes the request's. Mutation: the prior body without priorWouldWrite (it runs keyed and
  // the stale facts stick).
  test("a prior whose request's facts or launcher differ from the stored ones misses, and the full gate writes them", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await gateInstance(db.url, { oauth: true });
    const { p } = await issued(x);
    const meta = { [OPENCODE_SESSION_META]: "root-a", [GRAYBOARD_MODEL_META]: "new-model", [GRAYBOARD_EFFORT_META]: "low", [GRAYBOARD_LAUNCHER_META]: true };
    const c = sessionContext(p, meta);
    const id = idOf(p, "root-a");
    const stored = async () => (await db.sql`SELECT model, effort, launcher FROM ids WHERE id = ${id}`)[0] as { model: string | null; effort: string | null; launcher: boolean | null };
    // The selection writes the request's facts and launcher; with nothing between, its prior runs keyed.
    await whoami(x, p, "root-a", meta);
    const verdict = (await x.hosted.snapshot(p, c, false)).verdict!;
    const warm = priorDelta();
    await x.hosted.run(p, c, "whoami", async () => null, undefined, verdict);
    expect(warm()).toEqual({ keyed: 1, miss: 0 });
    for (const [what, revert] of [
      ["model", sql => sql`UPDATE ids SET model = 'old-model' WHERE id = ${id}`],
      ["effort", sql => sql`UPDATE ids SET effort = 'high' WHERE id = ${id}`],
      ["launcher", sql => sql`UPDATE ids SET launcher = false WHERE id = ${id}`],
    ] as Array<[string, (sql: typeof db.sql) => Promise<unknown>]>) {
      // A stale write committed between the selection and the tool call's prior.
      await revert(db.sql);
      const d = priorDelta();
      await x.hosted.run(p, c, "whoami", async () => null, undefined, verdict);
      expect([what, d()]).toEqual([what, { keyed: 0, miss: 1 }]);
      expect(await stored()).toEqual({ model: "new-model", effort: "low", launcher: true });
    }
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

// #1537a: a second request of an ID whose first request is creating it (an MCP client's two wires, opened at once)
// waits for the creator's exclusive body and reads again (hosted.ts withGate, `creating`). The creator is held at the
// gate's `hosted:gate:checked` pause, after its registration and before its body; the second request's pool read of
// the row (`state.absent`, counted when it returns no row) shows it read before the creation. Every wait has a deadline.
describePg("a first contact's second wire waits for the in-flight create (Postgres)", () => {
  const rows = async (sql: Awaited<ReturnType<typeof pgDatabase>>["sql"], id: string) => ({
    sessions: (await sql`SELECT count(*)::int AS n FROM hosted_sessions WHERE session_id = ${id}`)[0].n as number,
    ownerships: (await sql`SELECT count(*)::int AS n FROM access_log WHERE action = 'hosted.ownership_started' AND target = ${id}`)[0].n as number,
  });
  const absent = (x: GateInstance, id: string) => x.state.absent.get(id) ?? 0;
  // Two first contacts of one ID: the first held at its gate until the second (and any request it starts) has read
  // no row `reads` times. The pause's file outlives both, since the second passes the same pause point after the first.
  // Returns both results.
  async function pair(x: GateInstance, first: () => Promise<unknown>, second: () => Promise<unknown>, id: string, reads = 1) {
    const at = absent(x, id);
    const settled = (q: Promise<unknown>) => q.then(v => ({ ok: v }), (e: unknown) => ({ error: e }));
    let other!: Promise<unknown>, started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    return await hostedPause("hosted:gate:checked", () => Promise.all([settled(first()), ready.then(() => other)]), async () => {
      other = settled(second());
      started();
      await until(() => absent(x, id) >= at + 1 + reads, 10_000, "the second request read no row while the first was held");
    });
  }

  // The second wire runs one keyed gate body, not a second exclusive one; one row, one ownership. Then the ID's end and
  // a second pair on it: the first pair's entry left the map, so the second pair waits the same way.
  // Mutations: no wait (both bodies exclusive: skipped 2); the entry never deleted (the second pair's first request
  // waits on the stale entry and doesn't register, so its second runs exclusive too: skipped 2).
  test("two first contacts of one new ID: one exclusive body, one keyed; one row and one ownership audit; again after its end", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await gateInstance(db.url, { oauth: true });
    const { p } = await issued(x);
    const id = idOf(p, "new-a");
    for (const round of [1, 2]) {
      const d = delta();
      const [one, two] = await pair(x, () => whoami(x, p, "new-a"), () => whoami(x, p, "new-a"), id);
      expect([one, two]).toEqual([{ ok: null }, { ok: null }]);
      expect(d()).toEqual({ keyed: 1, miss: 0, skipped: 1 });
      await x.drain();
      expect(await rows(db.sql, id)).toEqual({ sessions: 1, ownerships: round });
      if (round === 1) { await x.hosted.release(id, "closed"); expect(await rows(db.sql, id)).toEqual({ sessions: 0, ownerships: 1 }); }
    }
  });

  // The first request refused at capacity: each waiter reads no row again and runs its own exclusive body, which
  // refuses and counts its own refusal. Two waiters: whichever re-reads first registers, and the other doesn't wait
  // for it, so each request reads the row at most twice (5 reads). Mutation: the loop waiting twice (the later
  // waiter waits for the earlier one and reads a third time: 6).
  test("a first contact refused at capacity: each waiter refuses too, counted per request, after one wait each", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await gateInstance(db.url, { oauth: true, caps: { perUser: 1, global: 16 } });
    const { p } = await issued(x);
    await whoami(x, p, "full");
    const id = idOf(p, "new-b");
    const d = delta(), refused = refusalCount("hosted_session"), at = absent(x, id);
    const [one, rest] = await pair(x, () => whoami(x, p, "new-b"), () => Promise.all([whoami(x, p, "new-b").catch((e: unknown) => e), whoami(x, p, "new-b").catch((e: unknown) => e)]), id, 2);
    const errors = [(one as { error: unknown }).error, ...(rest as { ok: unknown[] }).ok];
    expect(errors.map(e => (e as { code?: string }).code)).toEqual(["bad_request", "bad_request", "bad_request"]);
    expect(refusalCount("hosted_session") - refused).toBe(3);
    expect(d()).toEqual({ keyed: 0, miss: 0, skipped: 3 });
    expect(absent(x, id) - at).toBe(5);
    expect(await rows(db.sql, id)).toEqual({ sessions: 0, ownerships: 0 });
  });

  // A waiter whose request aborts rejects RequestAbortedError at once, while the creator is still held, and writes
  // nothing; it never registered, so the ID's next pair (after its end) waits as the first did.
  // Mutation: the wait ignoring the signal (the waiter rejects only once the creator's body settles, after the hold).
  test("a waiter whose request aborts rejects RequestAbortedError before the create settles and writes nothing", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await gateInstance(db.url, { oauth: true });
    const { p } = await issued(x);
    const id = idOf(p, "new-c");
    const d = delta(), before = x.state.exclusive.length, at = absent(x, id);
    const ac = new AbortController();
    // The aborted waiter never reaches the pause point, so the pause need only outlive the first request.
    let failed: unknown;
    await hostedPause("hosted:gate:checked", () => whoami(x, p, "new-c"), async () => {
      const second = x.hosted.run(p, ctx(p, "new-c"), "whoami", async () => null, undefined, undefined, ac.signal);
      void second.catch(e => { failed = e; });
      await until(() => absent(x, id) === at + 2, 10_000, "the second request read no row while the first was held");
      ac.abort();
      await until(() => failed !== undefined, 10_000, "the aborted waiter rejected while the creator was held");
    });
    expect(failed).toBeInstanceOf(RequestAbortedError);
    await x.drain();
    expect(d()).toEqual({ keyed: 0, miss: 0, skipped: 1 });
    expect(x.state.exclusive.slice(before).filter(b => b.site === "gate")).toHaveLength(1);
    expect(await rows(db.sql, id)).toEqual({ sessions: 1, ownerships: 1 });
    await x.hosted.release(id, "closed");
    const again = delta();
    await pair(x, () => whoami(x, p, "new-c"), () => whoami(x, p, "new-c"), id);
    expect(again()).toEqual({ keyed: 1, miss: 0, skipped: 1 });
  });

  // Another user's request naming the ID being created (a forged context: IDs derive from the user) waits, finds the
  // creator's row, misses in the keyed probe (ownRow) and refuses in its exclusive body, which writes its
  // `authz.decision` row: the wait changes nothing about the refusal.
  test("another user's second wire on the ID being created refuses as not found and writes its authz.decision row", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await gateInstance(db.url, { oauth: true });
    const { p } = await issued(x);
    const { p: other } = await issued(x, "other@example.com");
    const id = idOf(p, "new-d");
    const d = delta();
    const [one, two] = await pair(x, () => whoami(x, p, "new-d"), () => x.hosted.run(other, ctx(p, "new-d"), "whoami", async () => null), id);
    expect(one).toEqual({ ok: null });
    expect((two as { error?: { code?: string } }).error?.code).toBe("not_found");
    expect(d()).toEqual({ keyed: 0, miss: 1, skipped: 1 });
    await x.drain();
    const decisions = await db.sql`SELECT actor, detail->>'rule' AS rule, detail->>'verb' AS verb FROM access_log WHERE action = 'authz.decision' AND target = ${id}`;
    expect(decisions.map((r: Record<string, unknown>) => ({ ...r }))).toEqual([{ actor: "other@example.com", rule: "hosted.other_user", verb: "hosted.session" }]);
    expect(await rows(db.sql, id)).toEqual({ sessions: 1, ownerships: 1 });
  });
});

describePg("a first contact's creating entry is released on every exit (Postgres)", () => {
  const absent = (x: GateInstance, id: string) => x.state.absent.get(id) ?? 0;
  const deadline = <T>(q: Promise<T>, ms: number, what: string) => Promise.race([q, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`deadline: ${what}`)), ms))]);
  test("a registrant that throws before its exclusive body (auth refused in the gate) leaves no entry", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await gateInstance(db.url, { oauth: true });
    const { p } = await issued(x);
    const id = idOf(p, "aud-a");
    let armed = true;
    x.state.onAbsent = k => { if (k === id && armed) { armed = false; x.state.denyNext = true; } };
    const e = await whoami(x, p, "aud-a").catch((err: unknown) => err);
    expect((e as { code?: string }).code).toBe("unauthenticated");
    x.state.onAbsent = undefined;
    const d = delta();
    expect(await deadline(whoami(x, p, "aud-a"), 5000, "the next first contact hung on a stale entry")).toBeNull();
    expect(d()).toEqual({ keyed: 0, miss: 0, skipped: 1 });
  });
  test("the waiter runs keyed while the creator's fn is still running (entry released before fn)", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await gateInstance(db.url, { oauth: true });
    const { p } = await issued(x);
    const id = idOf(p, "aud-b");
    let release!: () => void; const held = new Promise<void>(r => { release = r; });
    let creatorDone = false, waiterSawCreatorRunning: boolean | undefined;
    const d = delta();
    let waiter!: Promise<unknown>;
    const out = await hostedPause("hosted:gate:checked", () => x.hosted.control(p, ctx(p, "aud-b"), false, async () => { await held; return 1; }).finally(() => { creatorDone = true; }), async () => {
      waiter = deadline(whoami(x, p, "aud-b"), 4000, "waiter blocked behind creator fn").then(v => { waiterSawCreatorRunning = !creatorDone; release(); return v; }, e => { release(); throw e; });
      void waiter.catch(() => {});
      await until(() => absent(x, id) >= 2, 10_000, "waiter read");
    });
    expect(out).toBe(1);
    expect(await waiter).toBeNull();
    expect(waiterSawCreatorRunning).toBe(true);
    expect(d()).toEqual({ keyed: 1, miss: 0, skipped: 1 });
  });
});

// #1510 chunk 4: delivery's renew and receipt keyed by their root on Postgres (delivery.ts keyedOr, D4). Each runs its
// reads in a probe, then writes only the session's own rows; anything else misses into today's exclusive body. A keyed
// renew is held at its lease UPDATE and a keyed receipt at its first markDelivered or board acknowledge (`state.hold`);
// `state.entry`, while set, holds a renew or receipt after its gate, before its keyed body queues, so two of one root
// can both be past their gates. Every wait has a deadline. Without GRAYBOARD_TEST_PG_URL it skips.
async function leaseInstance(url: string, opts: { keyed?: false; keyedTools?: false; side?: string } = {}) {
  const blobDir = mkdtempSync(join(tmpdir(), "gb-pg-blobs-"));
  let clock = T0;
  const repo: PgRepo = await makePgRepo(url, { blobDir, applicationName: `gb-test-lease-${opts.side ?? "a"}`, max: 4, now: () => clock });
  const store = repo.hosted;
  const state = { hold: undefined as Gate | undefined, entry: undefined as Gate | undefined, arrived: 0, held: 0, entered: [] as string[], marked: [] as number[],
    exclusive: [] as Array<{ site: string | undefined; startedHeld?: boolean }>, defer: undefined as Gate | undefined };
  const keyedTx = (tx: unknown) => (tx as { txn?: { keys?: ReadonlySet<string> } }).txn?.keys !== undefined;
  const holdHere = async (what: string) => {
    if (!state.hold) return;
    state.entered.push(what); state.held++;
    try { await state.hold.wait; } finally { state.held--; }
  };
  const update = store.update;
  store.update = (async (tx: Tx, id: string, patch: Parameters<typeof update>[2]) => {
    if (keyedTx(tx) && currentSite() === "renew") await holdHere(`renew ${id}`);
    return update(tx, id, patch);
  }) as typeof store.update;
  const markDelivered = repo.messages.markDelivered;
  repo.messages.markDelivered = async (tx, id, at) => {
    if (currentSite() === "receipt") state.marked.push(id);
    await markDelivered(tx, id, at);
    // After its first row lock, so a held receipt holds that message's row.
    if (keyedTx(tx) && currentSite() === "receipt" && state.marked.length === 1) await holdHere(`receipt ${id}`);
  };
  const acknowledge = repo.boards.acknowledge;
  repo.boards.acknowledge = async (tx, handle, ref, receiver) => {
    if (keyedTx(tx) && currentSite() === "receipt") await holdHere(`ack ${handle}`);
    return acknowledge(tx, handle, ref, receiver);
  };
  const writeKeyedEffects = repo.writeKeyedEffects!;
  repo.writeKeyedEffects = (async (keys: readonly string[], notices: readonly string[], fn: (tx: Tx) => Promise<unknown>, committed?: (v: unknown) => unknown) => {
    if (state.entry) { state.arrived++; await state.entry.wait; }
    return writeKeyedEffects(keys, notices, fn, committed);
  }) as typeof repo.writeKeyedEffects;
  // Every exclusive body, hosted's and the Repo's: whether it started while a keyed body was held. `defer`: while set,
  // a hosted write queued at a timer site (timerSite: the sweep and the reconcile) waits on it before it queues.
  for (const target of [repo, store] as Array<{ write: PgRepo["write"] }>) {
    const write = target.write;
    target.write = ((fn: (tx: Tx) => unknown, committed?: (v: unknown) => unknown) => {
      const site = currentSite();
      const queue = () => {
        const b: { site: string | undefined; startedHeld?: boolean } = { site };
        state.exclusive.push(b);
        return write(async (tx: Tx) => { b.startedHeld = state.held > 0; return fn(tx); }, committed);
      };
      return target === store && timerSite(site) && state.defer ? state.defer.wait.then(queue) : queue();
    }) as PgRepo["write"];
  }
  const application = createApplication(repo);
  const hosted = createHostedSessions(application, { now: () => clock, isAuthorized: () => true, ...(opts.keyedTools === false ? { keyedTools: false as const } : {}) });
  await hosted.ready;
  const delivery = createDelivery(hosted, { isAuthorized: () => true, ...(opts.keyed === false ? { keyed: false as const } : {}) });
  const user = await seed(repo, tx => repo.users.upsertByEmail(tx, ME, null));
  return {
    repo, application, hosted, delivery, user, state, q: repo.writeQueue,
    advance(ms: number) { clock += ms; },
    get clock() { return clock; },
    async [Symbol.asyncDispose]() {
      state.hold?.open(); state.entry?.open(); state.defer?.open();
      try { delivery.close(); await hosted.close(); await application.stopExpiry(); await repo.close(); }
      finally { rmSync(blobDir, { recursive: true, force: true }); }
    },
  };
}
type LeaseInstance = Awaited<ReturnType<typeof leaseInstance>>;
const leasePrincipal = async (x: LeaseInstance, sql: Awaited<ReturnType<typeof pgDatabase>>["sql"], grant = "G1"): Promise<OAuthPrincipal> => {
  await sql`INSERT INTO oauth_grants (id, user_id, expires_at, data) VALUES (${grant}, ${x.user.id}, ${Number.MAX_SAFE_INTEGER}, '{}'::jsonb) ON CONFLICT DO NOTHING`;
  return { authed: { user_id: x.user.id, user_email: x.user.email, kind: "user", session_id: 0 }, clientId: OPENCODE_CLIENT, sourceKey: OPENCODE_SESSION_META, grantId: grant, accessHash: "test", accessExpiry: Number.MAX_SAFE_INTEGER, scopes: ["tools", "delivery"] };
};
// A root `source` bound to `name` with an open lease; `changed` counts the lease's wakes.
async function leased(x: LeaseInstance, p: OAuthPrincipal, source: string, name: string) {
  const c = ctx(p, source);
  await x.hosted.bind(p, c, { name, create: true });
  const wakes = { n: 0 };
  const lease = await x.delivery.open(p, c, { changed: () => { wakes.n++; } });
  x.delivery.accept(lease);
  return { c, id: idOf(p, source), lease, wakes };
}
const renewDelta = (site: "renew" | "receipt") => {
  const at = { keyed: gateCount(site, "keyed"), miss: gateCount(site, "miss"), skipped: gateCount(site, "skipped") };
  return () => ({ keyed: gateCount(site, "keyed") - at.keyed, miss: gateCount(site, "miss") - at.miss, skipped: gateCount(site, "skipped") - at.skipped });
};

describePg("keyed renew and receipt (Postgres)", () => {
  // The renew's notice (hosted.update's, its one opted-in notice) is what moves the lease's row, which `deliver()`
  // judges: past the first deadline a DM still wakes the lease. Mutation: renew's notices [] (the keyed update
  // refuses and renew rejects); keyedOr's countGate("keyed") dropped (the count is 0).
  test("a keyed renew writes the lease's columns, and its notice keeps the lease waking past its first deadline", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await leaseInstance(db.url);
    const p = await leasePrincipal(x, db.sql);
    const { c, id, lease, wakes } = await leased(x, p, "root-a", "fe");
    const sender = new AppSession(x.application, x.repo, p.authed, "be", { push: false });
    await sender.connect();
    try {
      x.advance(20_000);
      const d = renewDelta("renew");
      const renewed = await x.delivery.renew(p, c, lease.capability);
      expect(d()).toEqual({ keyed: 1, miss: 0, skipped: 0 });
      expect(renewed.expiresAt).toBe(x.clock + 30_000);
      const row = (await db.sql`SELECT lease_deadline, last_seen_at FROM hosted_sessions WHERE session_id = ${id}`)[0];
      expect([Number(row.lease_deadline), Number(row.last_seen_at)]).toEqual([x.clock + 30_000, x.clock]);
      // Past the open's deadline, inside the renewed one.
      x.advance(15_000);
      const before = wakes.n;
      await sender.send(`${ME}/fe`, "after the first deadline");
      await until(() => wakes.n > before, 10_000, "the renewed lease woke for the DM");
      expect(x.delivery.activeLeaseCount).toBe(1);
    } finally { sender.close(); }
  });

  // Mutation: renew's key `root:<capability>` (two of one root overlap) or one key for every renew (different roots
  // don't). `defer` holds the timer's site-less writes: one queued behind a's held renew is exclusive, and every keyed
  // waiter behind it waits (queue.ts behind()), so b's renew would never enter (#1547). Every renew settles before the
  // dispose closes delivery, so a failure here is not charged to the next test.
  test("renews of different roots overlap; two of one root run one at a time", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await leaseInstance(db.url);
    const p = await leasePrincipal(x, db.sql);
    const a = await leased(x, p, "root-a", "fe"), b = await leased(x, p, "root-b", "be");
    const renews: Promise<unknown>[] = [];
    const renew = (l: typeof a) => { const r = x.delivery.renew(p, l.c, l.lease.capability); renews.push(r); return r; };
    x.state.defer = gate();
    try {
      // Different roots: a is held at its update, and b's enters beside it.
      x.state.hold = gate();
      const ra = renew(a);
      await until(() => x.state.held === 1, 10_000, "a's renew held");
      const rb = renew(b);
      await until(() => x.state.held === 2, 10_000, "b's renew entered beside a's");
      x.state.hold.open();
      await Promise.all([ra, rb]);
      expect(x.state.entered).toEqual([`renew ${a.id}`, `renew ${b.id}`]);
      // One root: both past their gates first, then released into the queue together; the second waits on the key.
      x.state.entered = [];
      x.state.entry = gate(); x.state.arrived = 0;
      const r1 = renew(a), r2 = renew(a);
      await until(() => x.state.arrived === 2, 10_000, "both renews past their gates");
      x.state.hold = gate();
      x.state.entry.open(); x.state.entry = undefined;
      await until(() => x.state.held === 1 && x.q.waitingAt("renew") === 1, 10_000, "one renew held, the other queued on its key");
      expect(x.state.entered).toEqual([`renew ${a.id}`]);
      x.state.hold.open();
      await Promise.all([r1, r2]);
      expect(x.state.entered).toEqual([`renew ${a.id}`, `renew ${a.id}`]);
    } finally {
      x.state.hold?.open(); x.state.entry?.open(); x.state.defer.open();
      await Promise.allSettled(renews);
    }
  });

  // A renew and a receipt of one root, both past their gates, run one at a time; the second waits on the root's key.
  // Mutation: receipt's key `root:<capability>` or one per call (the receipt's mark enters beside the held renew).
  // `defer` and the settled finally as in the test above (#1547).
  test("a renew and a receipt of one root run one at a time", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await leaseInstance(db.url);
    const p = await leasePrincipal(x, db.sql);
    const { c, id, lease } = await leased(x, p, "root-a", "fe");
    const sender = new AppSession(x.application, x.repo, p.authed, "be", { push: false });
    await sender.connect();
    let renewed: Promise<unknown> | undefined, receipt: Promise<unknown> | undefined;
    try {
      await sender.send(`${ME}/fe`, "one");
      const items = await x.delivery.pending(p, c, lease.capability);
      x.state.entry = gate(); x.state.arrived = 0; x.state.marked = []; x.state.defer = gate();
      renewed = x.delivery.renew(p, c, lease.capability);
      await until(() => x.state.arrived === 1, 10_000, "the renew past its gate");
      receipt = x.delivery.receipt(p, c, lease.capability, items.map(i => i.id));
      await until(() => x.state.arrived === 2, 10_000, "the receipt past its gate");
      x.state.hold = gate();
      x.state.entry.open(); x.state.entry = undefined;
      await until(() => x.state.held === 1 && x.q.waitingAt("receipt") === 1, 10_000, "the renew held, the receipt queued on its key");
      expect(x.state.entered).toEqual([`renew ${id}`]);
      expect(x.state.marked).toEqual([]);
      x.state.hold.open();
      await Promise.all([renewed, receipt]);
      expect(x.state.marked).toHaveLength(1);
    } finally {
      x.state.hold?.open(); x.state.entry?.open(); x.state.defer?.open();
      await Promise.allSettled([renewed, receipt]);
      sender.close();
    }
  });

  // Anything the receipt's reads would write (pending's lost-ack repair is the one today) refuses in the probe: a miss,
  // and the exclusive body runs it. Injected here as a no-op UPDATE in the cursor read pending makes. Mutation:
  // keyedOr treating a ProbeWrite as the request's (the receipt rejects with it).
  test("a write the receipt's probed reads would send misses, and the exclusive body sends it", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await leaseInstance(db.url);
    const p = await leasePrincipal(x, db.sql);
    const { c, lease } = await leased(x, p, "root-a", "fe");
    const sender = new AppSession(x.application, x.repo, p.authed, "be", { push: false });
    await sender.connect();
    try {
      await sender.send(`${ME}/fe`, "one");
      const items = await x.delivery.pending(p, c, lease.capability);
      const get = x.repo.cursors.get;
      let sent = 0;
      x.repo.cursors.get = async (r, ...a) => {
        if (currentSite() === "receipt") { await pgOf(r)`UPDATE hosted_sessions SET last_seen_at = last_seen_at WHERE false`; sent++; }
        return get(r, ...a);
      };
      const d = renewDelta("receipt");
      await x.delivery.receipt(p, c, lease.capability, items.map(i => i.id));
      expect(d()).toEqual({ keyed: 0, miss: 1, skipped: 0 });
      expect(sent).toBeGreaterThan(0);
      expect(await x.repo.cursors.directFor(x.repo.read, `${ME}/fe`)).toBe(Number(items[0]!.id.slice("direct:".length)));
    } finally { sender.close(); }
  });

  // Across processes the probe's FOR UPDATE of the root is the ownership recheck (#1510 chunk 4 audit M1): another
  // instance's unbind (bind_gen + 1, lease_deadline NULL) waits for a keyed renew held past its probe, then commits
  // over it. Mutation: the renew probe's store.lock as store.get (the unbind commits first and the renew's UPDATE
  // re-arms a lease on the unbound root).
  test("another instance's unbind waits for a keyed renew held after its probe, and leaves no lease on the root", async () => {
    await using db = await pgDatabase({ max: 4 });
    await using a = await leaseInstance(db.url, { side: "a" });
    await using b = await leaseInstance(db.url, { side: "b" });
    const p = await leasePrincipal(a, db.sql);
    const { c, id, lease } = await leased(a, p, "root-a", "fe");
    a.advance(1_000);
    a.state.hold = gate();
    const renewed = a.delivery.renew(p, c, lease.capability);
    await until(() => a.state.held === 1, 10_000, "the renew held before its update");
    const unbound = b.hosted.unbind(p, c, { name: "fe" });
    try { await until(async () => await lockWaiters(db.sql) >= 1, 10_000, "the unbind waiting on the renew's root lock"); }
    finally { a.state.hold.open(); }
    await renewed;
    await unbound;
    expect((await db.sql`SELECT lease_deadline FROM hosted_sessions WHERE session_id = ${id}`)[0].lease_deadline).toBeNull();
  });

  // The same for a keyed receipt held at its first mark: the probe's lock holds another instance's unbind until the
  // receipt commits. Mutation: the receipt probe's store.lock as store.get (the unbind commits beside the receipt).
  test("another instance's unbind waits for a keyed receipt held after its probe", async () => {
    await using db = await pgDatabase({ max: 4 });
    await using a = await leaseInstance(db.url, { side: "a" });
    await using b = await leaseInstance(db.url, { side: "b" });
    const p = await leasePrincipal(a, db.sql);
    const { c, lease } = await leased(a, p, "root-a", "fe");
    const sender = new AppSession(a.application, a.repo, p.authed, "be", { push: false });
    await sender.connect();
    try {
      await sender.send(`${ME}/fe`, "one");
      const items = await a.delivery.pending(p, c, lease.capability);
      a.state.marked = []; a.state.hold = gate();
      const receipt = a.delivery.receipt(p, c, lease.capability, items.map(i => i.id));
      await until(() => a.state.held === 1, 10_000, "the receipt held after its first mark");
      let done = false;
      const unbound = b.hosted.unbind(p, c, { name: "fe" }).finally(() => { done = true; });
      try {
        await until(async () => done || await lockWaiters(db.sql) >= 1, 10_000, "the unbind waiting on the receipt's root lock, or done");
        expect(done).toBe(false);
      } finally { a.state.hold.open(); }
      await receipt;
      await unbound;
      expect(await a.repo.cursors.directFor(a.repo.read, `${ME}/fe`)).toBe(Number(items[0]!.id.slice("direct:".length)));
    } finally { sender.close(); }
  });

  // A user disabled by an outside commit the probe's authorization read missed (#1510 chunk 4 audit L2): pending's
  // valid() terminates the session inside the probe, whose Tx refuses close's row write. The transport is still told,
  // so the lease finishes, as the exclusive body's terminate finishes it. Mutation: terminate's sink.closed outside its
  // finally (the lease stays tracked).
  test("a user disabled outside the queue during a keyed receipt's probe leaves no lease tracked", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await leaseInstance(db.url);
    const p = await leasePrincipal(x, db.sql);
    const { c, lease } = await leased(x, p, "root-a", "fe");
    const sender = new AppSession(x.application, x.repo, p.authed, "be", { push: false });
    await sender.connect();
    try {
      await sender.send(`${ME}/fe`, "one");
      const items = await x.delivery.pending(p, c, lease.capability);
      await db.sql`UPDATE users SET disabled_at = 1 WHERE id = ${x.user.id}`;
      const d = renewDelta("receipt");
      // The probe's terminate finished the lease, so the exclusive body finds the capability stale.
      await expect(x.delivery.receipt(p, c, lease.capability, items.map(i => i.id))).rejects.toHaveProperty("code", "not_found");
      expect(d()).toEqual({ keyed: 0, miss: 1, skipped: 0 });
      expect(x.delivery.activeLeaseCount).toBe(0);
    } finally { sender.close(); }
  });

  // An ApplicationError from the receipt's writes (its session closed meanwhile, outside the queue) is a miss, not the
  // request's error: the keyed attempt rolls back and the exclusive body runs, refusing the closed session as it would
  // have alone (#1510 chunk 4 audit L3). A bare close leaves the lease open, so the exclusive body's refusal is the
  // session's, not a stale capability's. Mutation: keyedOr's write part rethrowing ApplicationError (m09: the request
  // fails from the keyed attempt, counted neither keyed nor missed, and the exclusive body never runs).
  test("a session closed during a keyed receipt's writes misses, and the exclusive body refuses it", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await leaseInstance(db.url);
    const p = await leasePrincipal(x, db.sql);
    const { c, lease } = await leased(x, p, "root-a", "fe");
    const sender = new AppSession(x.application, x.repo, p.authed, "be", { push: false });
    await sender.connect();
    try {
      await sender.send(`${ME}/fe`, "one");
      const items = await x.delivery.pending(p, c, lease.capability);
      const receiptDirect = x.application.receiptDirect;
      const calls: Array<string | undefined> = [];
      x.application.receiptDirect = async (tx, session, ...rest) => {
        // On the body's Tx: its row write (the touch) rolls back with the keyed attempt.
        if (calls.push(currentSite()) === 1) x.application.close(session, tx);
        return receiptDirect(tx, session, ...rest);
      };
      const d = renewDelta("receipt");
      await expect(x.delivery.receipt(p, c, lease.capability, items.map(i => i.id))).rejects.toThrow("session is closed");
      expect(d()).toEqual({ keyed: 0, miss: 1, skipped: 0 });
      // Only the keyed attempt reached the writes: the exclusive body's reads (pending's valid) refuse the closed session.
      expect(calls).toEqual(["receipt"]);
      expect(await x.repo.cursors.directFor(x.repo.read, `${ME}/fe`)).toBe(0);
    } finally { sender.close(); }
  });

  // The notices a keyed body may queue are fixed in pg_repo.ts, not by the caller (#1510 chunk 4 audit L1), and only
  // for its own root's row. Mutations: KEYED_NOTICE_OPS check dropped (hosted.end's opt-in is accepted and the body
  // runs); refuseKeyedNotice's root-key check dropped (another root's update commits keyed).
  test("writeKeyedEffects accepts only hosted.update's notices, for the body's own root's row", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await leaseInstance(db.url);
    const p = await leasePrincipal(x, db.sql);
    const { id } = await leased(x, p, "root-a", "fe");
    const { id: other } = await leased(x, p, "root-b", "be");
    let ran = 0;
    await expect(x.repo.writeKeyedEffects!([`root:${id}`], ["hosted.update", "hosted.end"], async () => { ran++; })).rejects.toThrow("a keyed body may not queue hosted.end's notices");
    expect(ran).toBe(0);
    await expect(x.repo.writeKeyedEffects!([`root:${id}`], ["hosted.update"], tx => x.repo.hosted.update(tx, other, { last_seen_at: 1 }))).rejects.toThrow(`for ${other}, not this body's root refused in a keyed write body`);
    await x.repo.writeKeyedEffects!([`root:${id}`], ["hosted.update"], tx => x.repo.hosted.update(tx, id, { last_seen_at: 1 }));
    expect(Number((await db.sql`SELECT last_seen_at FROM hosted_sessions WHERE session_id = ${id}`)[0].last_seen_at)).toBe(1);
  });

  // A lease finished while a keyed renew's update awaits: the renew misses, and the exclusive body refuses it, so the
  // new deadline is rolled back (delivery.test.ts's #807 P3 A6e2 test, keyed). Mutation: the keyed body's lease recheck
  // after its update dropped (the deadline commits, then `committed` refuses).
  test("a lease finished while a keyed renew's update awaits stays finished, and its deadline is rolled back", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await leaseInstance(db.url);
    const p = await leasePrincipal(x, db.sql);
    const { c, id, lease } = await leased(x, p, "root-a", "fe");
    const deadline = async () => Number((await db.sql`SELECT lease_deadline FROM hosted_sessions WHERE session_id = ${id}`)[0].lease_deadline);
    const before = await deadline();
    x.advance(1_000);
    const d = renewDelta("renew");
    x.state.hold = gate();
    const renewed = x.delivery.renew(p, c, lease.capability);
    await until(() => x.state.held === 1, 10_000, "the renew held at its update");
    x.delivery.close();
    expect(x.delivery.activeLeaseCount).toBe(0);
    x.state.hold.open();
    await expect(renewed).rejects.toHaveProperty("code", "not_found");
    expect(d()).toEqual({ keyed: 0, miss: 1, skipped: 0 });
    expect(await deadline()).toBe(before);
  });

  // Mutation: the scheduler letting an exclusive body start beside a keyed one (each exclusive body below starts held).
  test("an end, a bind, a revoke and a sweep each wait for a running keyed renew; a bind of its root waits on its call", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await leaseInstance(db.url);
    const p = await leasePrincipal(x, db.sql);
    const a = await leased(x, p, "root-a", "fe");
    await x.hosted.run(p, ctx(p, "root-b"), "whoami", () => null);
    const other = await seed(x.repo, tx => x.repo.users.upsertByEmail(tx, "other@example.com", null));
    x.state.exclusive = [];
    x.state.hold = gate();
    const renewed = x.delivery.renew(p, a.c, a.lease.capability);
    await until(() => x.state.held === 1, 10_000, "the renew held");
    const end = x.hosted.release(idOf(p, "root-b"), "closed");
    const revoke = x.repo.write(tx => x.repo.sessions.revokeAllForUser(tx, other.id));
    const bind = x.hosted.bind(p, ctx(p, "root-c"), { name: "be", create: true });
    // The held root's own bind waits in memory, on the root's gate the renew's call holds.
    const sameRoot = x.hosted.bind(p, a.c, { name: "qa", create: true });
    // A sweep called directly (the timer's skips when the pool finds nothing due, #1537 PR 6).
    const swept = x.hosted.sweep(true);
    await until(() => x.q.waitingAt("gate") >= 1 && x.q.waitingAt("end") >= 1 && x.q.waitingAt("other") >= 2, 10_000, "the end, the revoke, the bind and the sweep queued");
    expect(x.state.exclusive.filter(b => b.startedHeld)).toEqual([]);
    x.state.hold.open();
    await Promise.all([renewed, end, revoke, bind, sameRoot, swept]);
    expect(x.state.exclusive.filter(b => b.startedHeld)).toEqual([]);
    expect(x.state.entered).toEqual([`renew ${a.id}`]);
    // The bind committed after the renew, so the lease is finished by it.
    expect(x.delivery.activeLeaseCount).toBe(0);
  });

  // A bind another instance commits between the gate and the renew's body: the probe's row differs from the gate's,
  // so the renew misses, and the exclusive body refuses the stale capability with one audit. Mutation: the probe's
  // comparison with the gate's row dropped survives (get's lease match refuses the same rows: reported); keyedOr
  // treating an ApplicationError from the probe as the request's (the renew refuses keyed, miss 0).
  test("a renew whose root another instance re-bound since its gate misses, and the exclusive body refuses it once; a receipt the same", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using a = await leaseInstance(db.url, { side: "a" });
    await using b = await leaseInstance(db.url, { side: "b" });
    const p = await leasePrincipal(a, db.sql);
    // fe and be, so the root keeps a hold after B's unbind of fe.
    const c = ctx(p, "root-a"), id = idOf(p, "root-a");
    await a.hosted.bind(p, c, { name: "fe", create: true });
    await a.hosted.bind(p, c, { name: "be", create: true });
    const lease = await a.delivery.open(p, c);
    a.delivery.accept(lease);
    a.state.entry = gate(); a.state.arrived = 0;
    const d = renewDelta("renew");
    const renewed = a.delivery.renew(p, c, lease.capability);
    await until(() => a.state.arrived === 1, 10_000, "the renew past its gate");
    await b.hosted.unbind(p, c, { name: "fe" });
    a.state.entry.open(); a.state.entry = undefined;
    await expect(renewed).rejects.toHaveProperty("code", "not_found");
    expect(d()).toEqual({ keyed: 0, miss: 1, skipped: 0 });
    await atSite("other", () => a.repo.write(() => {}));
    expect((await db.sql`SELECT count(*)::int AS n FROM access_log WHERE action = 'hosted.stale_capability' AND target = ${id}`)[0].n).toBe(1);
    // A receipt the same: its probe's lease check refuses the new generation, a miss, and the exclusive body's refusal
    // is audited once.
    const r = renewDelta("receipt");
    await expect(a.delivery.receipt(p, c, lease.capability, [])).rejects.toHaveProperty("code", "not_found");
    expect(r()).toEqual({ keyed: 0, miss: 1, skipped: 0 });
    const audits = async () => (await db.sql`SELECT count(*)::int AS n FROM access_log WHERE action = 'hosted.stale_capability' AND target = ${id}`)[0].n as number;
    // The refusal's audit is posted (writeAudit): committed once the posted write has run.
    await until(async () => await audits() === 2, 10_000, "the receipt's refusal audited");
    await atSite("other", () => a.repo.write(() => {}));
    expect(await audits()).toBe(2);
  });

  // The send is exclusive: it waits for the keyed receipt of its address. Mutation: receipt's key dropped to none
  // (writeKeyedEffects([])) is refused by the scheduler; the scheduler starting the send beside it (startedHeld).
  test("a send to the address waits for a running keyed receipt, then lands after it", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await leaseInstance(db.url);
    const p = await leasePrincipal(x, db.sql);
    const { c, lease } = await leased(x, p, "root-a", "fe");
    const sender = new AppSession(x.application, x.repo, p.authed, "be", { push: false });
    await sender.connect();
    try {
      await sender.send(`${ME}/fe`, "one");
      const items = await x.delivery.pending(p, c, lease.capability);
      expect(items).toHaveLength(1);
      x.state.exclusive = [];
      x.state.hold = gate();
      const d = renewDelta("receipt");
      const receipt = x.delivery.receipt(p, c, lease.capability, items.map(i => i.id));
      await until(() => x.state.held === 1, 10_000, "the receipt held after its first mark");
      const before = x.q.waiting;
      const sent = sender.send(`${ME}/fe`, "two");
      await until(() => x.q.waiting > before, 10_000, "the send queued");
      expect(x.state.exclusive.filter(b => b.startedHeld)).toEqual([]);
      x.state.hold.open();
      await Promise.all([receipt, sent]);
      expect(d()).toEqual({ keyed: 1, miss: 0, skipped: 0 });
      expect(x.state.exclusive.filter(b => b.startedHeld)).toEqual([]);
      const next = await x.delivery.pending(p, c, lease.capability);
      expect(next.map(i => (i.event as { message: { body: string } }).message.body)).toEqual(["two"]);
    } finally { sender.close(); }
  });

  // handleAck marks in id order whatever order the client sent (scope pair 4), so it locks messages as
  // messages.prune's batch does. Mutation: handleAck without its sort (the marks come in the client's order).
  test("a receipt of unsorted ids marks them in id order", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await leaseInstance(db.url);
    const p = await leasePrincipal(x, db.sql);
    const { c, lease } = await leased(x, p, "root-a", "fe");
    const sender = new AppSession(x.application, x.repo, p.authed, "be", { push: false });
    await sender.connect();
    try {
      for (const body of ["one", "two", "three"]) await sender.send(`${ME}/fe`, body);
      const items = await x.delivery.pending(p, c, lease.capability);
      x.state.marked = [];
      await x.delivery.receipt(p, c, lease.capability, items.map(i => i.id).reverse());
      const ids = items.map(i => Number(i.id.slice("direct:".length)));
      expect(x.state.marked).toEqual([...ids].sort((m, n) => m - n));
      expect(ids.length).toBe(3);
    } finally { sender.close(); }
  });

  // The deadlock pairs (scope pairs 4 and 5), forced across two instances, since on one the scheduler never runs a
  // prune or an end beside a keyed receipt. A's receipt of reversed ids is held after its first mark; B's prune of
  // those messages, then B's end of the root, wait on its locks and finish after it, with no 40P01. Mutation: handleAck
  // without its sort (the receipt holds the newest message, the prune locks the oldest and waits on it, and the
  // receipt's next mark waits on the prune: 40P01).
  test("another instance's prune and end of the root wait for a held keyed receipt, with no deadlock", async () => {
    await using db = await pgDatabase({ max: 4 });
    await using a = await leaseInstance(db.url, { side: "a" });
    await using b = await leaseInstance(db.url, { side: "b" });
    const p = await leasePrincipal(a, db.sql);
    const { c, id, lease } = await leased(a, p, "root-a", "fe");
    const sender = new AppSession(a.application, a.repo, p.authed, "be", { push: false });
    await sender.connect();
    try {
      for (const body of ["one", "two", "three"]) await sender.send(`${ME}/fe`, body);
      const items = await a.delivery.pending(p, c, lease.capability);
      a.state.marked = [];
      a.state.hold = gate();
      const receipt = a.delivery.receipt(p, c, lease.capability, items.map(i => i.id).reverse());
      await until(() => a.state.held === 1, 10_000, "the receipt held after its first mark");
      const prune = atSite("other", () => b.repo.write(tx => b.repo.messages.prune(tx, a.clock + 1)));
      await until(async () => await lockWaiters(db.sql) >= 1, 10_000, "the prune waits on the receipt's row lock");
      a.state.hold.open();
      await receipt;
      await prune;
      expect(await db.sql`SELECT id FROM messages`).toEqual([]);

      // The end: B ends the root while A's next receipt is held.
      await sender.send(`${ME}/fe`, "four");
      const more = await a.delivery.pending(p, c, lease.capability);
      a.state.marked = [];
      a.state.hold = gate();
      const second = a.delivery.receipt(p, c, lease.capability, more.map(i => i.id));
      await until(() => a.state.held === 1, 10_000, "the second receipt held");
      const ended = b.hosted.release(id, "closed");
      await until(async () => await lockWaiters(db.sql) >= 1, 10_000, "the end waits on the receipt's root lock");
      a.state.hold.open();
      await second;
      await ended;
      expect(await b.repo.hosted.get(b.repo.read, id)).toBeUndefined();
    } finally { sender.close(); }
  });
});

describePg("keyed renew and receipt rows (Postgres)", () => {
  // One script on two databases: keyed (receipts of DMs and a broadcast push, renews) with misses (a queue board's
  // push, whose first ack credits its take; a stale capability's renew and receipt, each refused and audited once by
  // the exclusive body), and the same with the keyed path off. Mutations: keyedOr letting a queue board's receipt run
  // keyed (the store's backstop refuses it: the receipt rejects); the miss path skipping the exclusive body (the
  // rows differ); a stale capability counted as the request's in the keyed body (audited twice or not at all).
  test("miss-then-exclusive writes the same rows as the exclusive bodies alone", async () => {
    const script = async (x: LeaseInstance, sql: Awaited<ReturnType<typeof pgDatabase>>["sql"]) => {
      const p = await leasePrincipal(x, sql);
      const tool = (source: string, name: string, args: Record<string, unknown>) =>
        x.hosted.run(p, ctx(p, source), name, (session, tx) => x.application.call(tx, session, name, args));
      await x.hosted.bind(p, ctx(p, "root-s"), { name: "ops", create: true });
      await tool("root-s", "board_create", { name: "b1", purpose: "broadcast" });
      await tool("root-s", "board_create", { name: "q1", purpose: "queue", kind: "queue" });
      const { c, lease } = await leased(x, p, "root-a", "fe");
      await tool("root-a", "board_subscribe", { board: "b1", mode: "push" });
      await tool("root-a", "board_subscribe", { board: "q1", mode: "push" });
      // A fixed key, so the sender's ID is the same in both runs.
      const sender = new AppSession(x.application, x.repo, p.authed, "be", { push: false, key: "rows-sender-key" });
      await sender.connect();
      const renew = renewDelta("renew"), receipt = renewDelta("receipt");
      try {
        x.state.defer = gate();
        for (const body of ["one", "two"]) { await sender.send(`${ME}/fe`, body); x.advance(10); }
        await tool("root-s", "board_post", { board: "b1", body: "news" }); x.advance(10);
        await tool("root-s", "board_post", { board: "q1", body: "job" }); x.advance(10);
        const items = await x.delivery.pending(p, c, lease.capability);
        const kinds = items.map(i => i.id.split(":")[0]);
        expect(kinds).toEqual(["direct", "direct", "push", "push"]);
        x.advance(10);
        await x.delivery.receipt(p, c, lease.capability, [items[1]!.id, items[0]!.id]); x.advance(10);
        await x.delivery.receipt(p, c, lease.capability, [items[2]!.id]); x.advance(10);
        await x.delivery.receipt(p, c, lease.capability, [items[3]!.id]); x.advance(10);
        await x.delivery.renew(p, c, lease.capability); x.advance(10);
        await expect(x.delivery.renew(p, c, "no-such-capability")).rejects.toHaveProperty("code", "not_found"); x.advance(10);
        await expect(x.delivery.receipt(p, c, lease.capability, ["direct:999999"])).rejects.toHaveProperty("code", "not_found"); x.advance(10);
        await x.delivery.renew(p, c, lease.capability);
        await atSite("other", () => x.repo.write(() => {}));
      } finally { sender.close(); }
      return { renew: renew(), receipt: receipt() };
    };
    const dump = async (sql: Awaited<ReturnType<typeof pgDatabase>>["sql"]) => {
      const out: Record<string, string[]> = {};
      for (const [table, drop] of [["hosted_sessions", []], ["messages", []], ["mailbox_cursors", []], ["outbox", []], ["subscriptions", []], ["claim_events", ["id"]], ["dm_acks", []], ["access_log", ["id"]]] as const) {
        const rows: Array<Record<string, unknown>> = await sql.unsafe(`SELECT * FROM ${table}`);
        // A message's delivered_at is the application's wall clock (application.ts now), not the injected one: only
        // whether it was set is compared.
        const norm = (r: Record<string, unknown>) => table === "messages" ? { ...r, delivered_at: r.delivered_at === null ? null : "set" } : r;
        out[table] = rows.map(r => JSON.stringify(Object.fromEntries(Object.entries(norm(r)).filter(([k]) => !(drop as readonly string[]).includes(k)).sort(([a], [b]) => a < b ? -1 : 1)), (_k, v) => typeof v === "bigint" ? String(v) : v)).sort();
      }
      return out;
    };
    await using fastDb = await pgDatabase({ max: 2 });
    await using refDb = await pgDatabase({ max: 2 });
    let fastRows: Record<string, string[]>, refRows: Record<string, string[]>, fast: Awaited<ReturnType<typeof script>>, ref: Awaited<ReturnType<typeof script>>;
    { await using x = await leaseInstance(fastDb.url, { side: "fast" }); fast = await script(x, fastDb.sql); fastRows = await dump(fastDb.sql); }
    { await using x = await leaseInstance(refDb.url, { side: "ref", keyed: false }); ref = await script(x, refDb.sql); refRows = await dump(refDb.sql); }
    expect(fast).toEqual({ renew: { keyed: 2, miss: 1, skipped: 0 }, receipt: { keyed: 2, miss: 2, skipped: 0 } });
    expect(ref).toEqual({ renew: { keyed: 0, miss: 0, skipped: 3 }, receipt: { keyed: 0, miss: 0, skipped: 4 } });
    expect(fastRows).toEqual(refRows);
    // The rows the receipts wrote: both DMs delivered, the take credited, two stale-capability audits.
    expect(fastRows.messages!.every(r => !r.includes('"delivered_at":null'))).toBe(true);
    expect(fastRows.access_log!.filter(r => r.includes("hosted.stale_capability"))).toHaveLength(2);
  });
});

// #1537 C5, C7: the subscriber's renew, receipt and pending (hosted `control`) and its delivery open and bind (`owning`)
// reuse the exchange's selection verdict (withPrior) in place of a second gate body. Each change between the selection
// and the call ends as it does with no verdict (today's full gate): the same answer, the same leases tracked, and the
// same rows, audits and refusal rows (every table but the OAuth ones, whose tokens are random, normalized). The change
// commits in one of three windows: before the call; inside the prior, after its checks outside the body and before the
// body (`beforePrior`; the full arm's reference is the change before the call, the same state when its gate starts);
// and after the gate or prior, before the call's own body (its testPause point; none for renew, whose fn goes straight
// to its keyed body, so the existing keyed renew tests cover that window against the gate's row). The changes: an end,
// a rebind (the generation bump, by this process with its notice and by an outside writer without one), the grant
// revoked (by this process and by an outside writer's UPDATE, whose NOTIFY this process may not have heard), the user
// disabled, the access token (the request's secret) revoked. Mutations: withPrior's bind_gen comparison dropped; its
// fallback on a miss replaced by the call (no full gate); the body's authorization read dropped (pinned by the
// existing "committed between withPrior's checks" tests); renew's own ownership/generation check dropped. Results in
// p1537/c4/result.md.
type VerdictOp = "renew" | "receipt" | "pending" | "open" | "bind";
const VERDICT_STALES = ["nothing", "end", "rebind", "rebind outside", "grant revoke", "grant revoke outside", "disable", "access revoke"] as const;
type VerdictStale = typeof VERDICT_STALES[number];
type VerdictWindow = "before" | "in prior" | "in call";
const CALL_PAUSE: Partial<Record<VerdictOp, string>> = { open: "hosted:owning:before-txn", bind: "hosted:owning:before-txn", receipt: "hosted:receipt:before-txn", pending: "hosted:pending:in-gate" };
const OAUTH_TABLES = /^(oauth_|auth_|gb_|schema_|hosted_meta$|sessions$|users$|login_)/;

async function verdictRun(op: VerdictOp, stale: VerdictStale, window: VerdictWindow, arm: "prior" | "full") {
  await using db = await pgDatabase({ max: 3 });
  await using x = await gateInstance(db.url, { oauth: true });
  const { p, token, access } = await issued(x);
  const c = ctx(p, "root-a"), id = idOf(p, "root-a"), s = ctx(p, "root-s");
  await x.hosted.bind(p, s, { name: "sender", create: true });
  await x.hosted.bind(p, c, { name: "fe", create: true });
  await x.hosted.bind(p, c, { name: "be", create: true });
  const lease = await x.delivery.open(p, c);
  x.delivery.accept(lease);
  await x.hosted.run(p, s, "dm_send", (session, tx) => x.hosted.application.send(tx, session, "fe", "one"));
  const items = await x.delivery.pending(p, c, lease.capability);
  expect(items).toHaveLength(1);
  const verdict = (await x.hosted.snapshot(p, c)).verdict!;
  const prior = arm === "prior" ? verdict : undefined;
  const write = (fn: (tx: Tx) => Promise<unknown>) => atSite("other", () => x.repo.write(fn));
  const act = async () => {
    switch (stale) {
      case "nothing": return;
      case "end": await write(tx => x.repo.hosted.end(tx, id, "closed", x.clock)); return;
      case "rebind": await write(async tx => { const r = (await x.repo.hosted.get(tx, id))!; await x.repo.hosted.update(tx, id, { bind_gen: r.bind_gen + 1 }); }); return;
      case "rebind outside": await db.sql`UPDATE hosted_sessions SET bind_gen = bind_gen + 1 WHERE session_id = ${id}`; return;
      case "grant revoke": await write(tx => x.repo.oauth.revokeToken(tx, hashToken(token), OPENCODE_CLIENT, x.clock)); return;
      case "grant revoke outside": await db.sql`UPDATE oauth_grants SET revoked_at = ${x.clock} WHERE id = ${p.grantId}`; return;
      case "disable": await write(tx => x.repo.users.setDisabled(tx, p.authed.user_id, true)); return;
      case "access revoke": await write(tx => x.repo.oauth.revokeToken(tx, hashToken(access), OPENCODE_CLIENT, x.clock)); return;
    }
  };
  const call = (): Promise<unknown> => {
    switch (op) {
      case "renew": return x.delivery.renew(p, c, lease.capability, undefined, prior);
      case "receipt": return x.delivery.receipt(p, c, lease.capability, items.map(i => i.id), prior);
      case "pending": return x.delivery.pending(p, c, lease.capability, 100, prior);
      case "open": return x.delivery.open(p, c, {}, {}, prior);
      case "bind": return x.hosted.bind(p, c, { name: "qa", create: true }, undefined, undefined, prior);
    }
  };
  const answer = (pr: Promise<unknown>) => pr.then(() => "ok", (e: { code?: string; message?: string }) => `${e.code ?? "error"}: ${e.message}`);
  const method = op;
  const at = { gate: ["keyed", "miss", "skipped"].map(o => gateCount("gate", o as "keyed", method)), prior: ["keyed", "miss", "skipped"].map(o => gateCount("prior", o as "keyed", method)) };
  let outcome: string;
  if (window === "before") { await act(); outcome = await answer(call()); }
  else if (window === "in prior") {
    let ran = false;
    x.state.beforePrior = async () => { ran = true; await act(); };
    outcome = await answer(call());
    x.state.beforePrior = undefined;
    expect([op, stale, "beforePrior ran", ran]).toEqual([op, stale, "beforePrior ran", true]);
  } else outcome = await answer(hostedPause(CALL_PAUSE[op]!, call, act));
  const counts = { gate: ["keyed", "miss", "skipped"].map((o, i) => gateCount("gate", o as "keyed", method) - at.gate[i]!), prior: ["keyed", "miss", "skipped"].map((o, i) => gateCount("prior", o as "keyed", method) - at.prior[i]!) };
  // Posted audits (writeAudit) and end-of-call touches committed.
  await x.drain(); await x.drain();
  const secrets = [p.grantId, token, access, hashToken(token), hashToken(access)];
  const rows: Record<string, string[]> = {};
  const tables = (await db.sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`).map((r: { tablename: string }) => r.tablename).filter((t: string) => !OAUTH_TABLES.test(t));
  for (const table of tables) {
    const found: Array<Record<string, unknown>> = await db.sql.unsafe(`SELECT * FROM ${table}`);
    rows[table] = found.map(r => {
      // A column the application stamps with its wall clock (application.ts now: a hold's bound_at, a write receipt's
      // at, a message's delivered_at), not the injected one: only that it was set is compared.
      const wall = (v: unknown) => { const n = typeof v === "bigint" || typeof v === "string" && /^\d{13}$/.test(v) ? Number(v) : v; return typeof n === "number" && Math.abs(n - Date.now()) < 86_400_000 ? "wall" : v; };
      let text = JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => k !== "id" || table !== "access_log").map(([k, v]) => [k, wall(v)]).sort(([a], [b]) => String(a) < String(b) ? -1 : 1)), (_k, v) => typeof v === "bigint" ? String(v) : v);
      for (const secret of secrets) text = text.split(secret).join("<secret>");
      return text;
    }).sort();
  }
  return { outcome, leases: x.delivery.activeLeaseCount, lost: x.hosted.refusalRowsLost, rows, counts };
}

describePg("control and owning reuse the exchange's verdict (#1537 C5, C7) (Postgres)", () => {
  // A normal exchange: the call's gate body is gone (0 at the gate site for its method), and its prior ran keyed.
  test("with nothing changed, each call's second gate body is a keyed prior: renew, receipt, pending, open, bind", async () => {
    for (const op of ["renew", "receipt", "pending", "open", "bind"] as const) {
      const full = await verdictRun(op, "nothing", "before", "full"), got = await verdictRun(op, "nothing", "before", "prior");
      expect([op, full.outcome, full.counts]).toEqual([op, "ok", { gate: [1, 0, 0], prior: [0, 0, 0] }]);
      expect([op, got.outcome, got.counts]).toEqual([op, "ok", { gate: [0, 0, 0], prior: [1, 0, 0] }]);
      expect([op, got.leases, got.lost, got.rows]).toEqual([op, full.leases, full.lost, full.rows]);
    }
  }, 120_000);

  for (const op of ["renew", "receipt", "pending", "open", "bind"] as const) {
    test(`${op}: each change between the selection and the call ends as it does with no verdict, in every window`, async () => {
      const windows: VerdictWindow[] = CALL_PAUSE[op] ? ["before", "in prior", "in call"] : ["before", "in prior"];
      const seen: string[] = [];
      for (const stale of VERDICT_STALES.filter(s => s !== "nothing")) for (const window of windows) {
        const ref = await verdictRun(op, stale, window === "in prior" ? "before" : window, "full");
        const got = await verdictRun(op, stale, window, "prior");
        expect([stale, window, got.outcome, got.leases, got.lost]).toEqual([stale, window, ref.outcome, ref.leases, ref.lost]);
        expect([stale, window, got.rows]).toEqual([stale, window, ref.rows]);
        // The prior site ran for every prior call (keyed or missed, or refused in its body).
        expect([stale, window, got.counts.prior.reduce((a: number, b: number) => a + b, 0) <= 1]).toEqual([stale, window, true]);
        seen.push(`${stale} / ${window}: ${got.outcome}`);
      }
      // A change that refuses refuses in both arms: the outcome list is what the reference gave.
      expect(seen.length).toBeGreaterThan(0);
    }, 600_000);
  }
});

// #1537 PR 5 (#1510 chunk 6a, docs/future/postgres-server.md D4): dm_send's tool body keyed on Postgres under the
// sender's root, the recipient's stream (`dm:<address>`) and, when the recipient has a live holder, that holder's root
// (D5's conservative key). A keyed send is held right after its INSERT (its id allocated, its row and FK locks taken)
// by a gate on messages.insert, with the timer's bodies deferred meanwhile (an exclusive one queued behind a held keyed
// body would hold every later body behind it); every wait has a deadline. Results and mutation killers: p1537/c5/result.md.
const toolDelta = () => {
  const at = { keyed: gateCount("tool", "keyed"), miss: gateCount("tool", "miss"), skipped: gateCount("tool", "skipped") };
  return () => ({ keyed: gateCount("tool", "keyed") - at.keyed, miss: gateCount("tool", "miss") - at.miss, skipped: gateCount("tool", "skipped") - at.skipped });
};
const keyedTx = (tx: unknown) => (tx as { txn?: { keys?: ReadonlySet<string> } }).txn?.keys !== undefined;
// Bodies queued under a call's own sites (its gate body, its tool body), not a timer's.
const callWaiting = (x: LeaseInstance) => x.q.waitingAt("gate") + x.q.waitingAt("prior") + x.q.waitingAt("tool");
// Keyed sends held after their insert while `hold` is set; `entered`: `<sender> > <recipient>` in insert order.
function holdSends(x: LeaseInstance) {
  const sends = { hold: undefined as Gate | undefined, held: 0, entered: [] as string[] };
  const insert = x.repo.messages.insert;
  x.repo.messages.insert = (async (tx: Tx, sender: string, type: string, recipient: string, ...rest: unknown[]) => {
    const row = await (insert as (...a: unknown[]) => Promise<unknown>)(tx, sender, type, recipient, ...rest);
    if (keyedTx(tx) && currentSite() === "tool" && sends.hold) {
      sends.entered.push(`${sender} > ${recipient}`); sends.held++;
      try { await sends.hold.wait; } finally { sends.held--; }
    }
    return row;
  }) as typeof insert;
  return sends;
}
const bound = (x: LeaseInstance, p: OAuthPrincipal, source: string, name: string) => x.hosted.bind(p, ctx(p, source), { name, create: true });
const dm = (x: LeaseInstance, p: OAuthPrincipal, source: string, to: string, body: string, options: Parameters<LeaseInstance["application"]["send"]>[4] = {}) =>
  x.hosted.dmSend(p, ctx(p, source), to, body, options);

describePg("keyed dm_send (Postgres)", () => {
  // Two sends to one recipient (from different roots, the recipient with no live holder) run one at a time on its
  // stream key; a send to another recipient enters beside the held one. Ids then commit in allocation order per
  // address. Mutation: the `dm:` key dropped from runTool's keys (the second send to r1 enters beside the first).
  test("two sends to one recipient never overlap; a send to another recipient overlaps them", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await leaseInstance(db.url);
    const p = await leasePrincipal(x, db.sql);
    for (const [s, n] of [["root-s1", "s1"], ["root-s2", "s2"], ["root-s3", "s3"], ["root-r1", "r1"], ["root-r2", "r2"]]) await bound(x, p, s!, n!);
    const sends = holdSends(x);
    const d = toolDelta();
    sends.hold = gate(); x.state.defer = gate();
    const first = dm(x, p, "root-s1", `${ME}/r1`, "one");
    await until(() => sends.held === 1, 10_000, "s1's send to r1 held after its insert");
    const second = dm(x, p, "root-s2", `${ME}/r1`, "two");
    try {
      // Queued on r1's stream in its tool body, or (a slow run past the gate's fast path) earlier, in an exclusive body.
      await until(() => callWaiting(x) === 1 || sends.held > 1, 10_000, "s2's send to r1 queued");
      expect(sends.held).toBe(1);
      const other = dm(x, p, "root-s3", `${ME}/r2`, "three");
      await until(() => sends.held === 2, 10_000, "s3's send to r2 entered beside s1's to r1");
      sends.hold.open();
      await Promise.all([first, second, other]);
    } finally { sends.hold.open(); x.state.defer?.open(); }
    expect(sends.entered).toEqual([`${ME}/s1 > ${ME}/r1`, `${ME}/s3 > ${ME}/r2`, `${ME}/s2 > ${ME}/r1`]);
    const r1 = await db.sql`SELECT id, body FROM messages WHERE recipient = ${`${ME}/r1`} ORDER BY id`;
    expect(r1.map((r: { body: string }) => r.body)).toEqual(["one", "two"]);
    expect(d()).toEqual({ keyed: 3, miss: 0, skipped: 0 });
  });

  // Two sends of one sender root run one at a time, whatever their recipients. Mutation: the sender's `root:` key
  // dropped (the second enters beside the first).
  test("two sends of one sender root run one at a time", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await leaseInstance(db.url);
    const p = await leasePrincipal(x, db.sql);
    for (const [s, n] of [["root-s1", "s1"], ["root-r1", "r1"], ["root-r2", "r2"]]) await bound(x, p, s!, n!);
    const sends = holdSends(x);
    sends.hold = gate(); x.state.defer = gate();
    const first = dm(x, p, "root-s1", `${ME}/r1`, "one");
    await until(() => sends.held === 1, 10_000, "the first send held");
    const second = dm(x, p, "root-s1", `${ME}/r2`, "two");
    try {
      // It queues on the root key, in its gate body (site prior) or its tool body.
      await until(() => callWaiting(x) === 1 || sends.held > 1, 10_000, "the second send queued on the sender's root");
      expect(sends.held).toBe(1);
    } finally { sends.hold.open(); x.state.defer?.open(); }
    await Promise.all([first, second]);
    expect(sends.entered).toEqual([`${ME}/s1 > ${ME}/r1`, `${ME}/s1 > ${ME}/r2`]);
  });

  // D5: a send to a recipient with a live holder (an open lease) waits for a keyed renew of that holder's root, which
  // can finish or rebuild the holder (its notice), then lands and wakes the lease. Mutation: the holder's `root:` key
  // dropped (the send commits while the renew is held).
  test("a send to a live holder waits for a running keyed renew of its root, then wakes the lease", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await leaseInstance(db.url);
    const p = await leasePrincipal(x, db.sql);
    await bound(x, p, "root-s1", "s1");
    const { c, id, lease, wakes } = await leased(x, p, "root-a", "fe");
    const d = toolDelta();
    x.advance(1_000);
    x.state.hold = gate(); x.state.defer = gate();
    const renewed = x.delivery.renew(p, c, lease.capability);
    await until(() => x.state.held === 1, 10_000, "the renew held at its update");
    const before = wakes.n;
    // Whether the send's insert ran while the renew was held.
    let early = false;
    const insert = x.repo.messages.insert;
    x.repo.messages.insert = ((...a: Parameters<typeof insert>) => { if (x.state.held > 0) early = true; return insert(...a); }) as typeof insert;
    const sent = dm(x, p, "root-s1", `${ME}/fe`, "to the holder");
    try {
      // Queued on the holder's root in its tool body, or (a slow run past the gate's fast path) earlier, exclusive.
      await until(() => callWaiting(x) === 1 || early, 10_000, "the send queued behind the held renew");
      expect(early).toBe(false);
      expect(x.state.entered).toEqual([`renew ${id}`]);
    } finally { x.state.hold.open(); x.state.defer?.open(); }
    await renewed;
    expect(await sent).toMatchObject({ delivered_now: true });
    await until(() => wakes.n > before, 10_000, "the lease woke for the DM");
    expect(d()).toEqual({ keyed: 1, miss: 0, skipped: 0 });
  });

  // A→B beside B→A (neither recipient with a live holder, so their keys are disjoint): both held after their inserts
  // at once, neither waits on the other's locks (their rows in common take share locks at most: a reply's parent
  // FOR KEY SHARE), and both commit, with no 40P01.
  test("A to B and B to A held at once commit with no lock wait and no deadlock", async () => {
    await using db = await pgDatabase({ max: 3 });
    await using x = await leaseInstance(db.url);
    const p = await leasePrincipal(x, db.sql);
    await bound(x, p, "root-a", "fa"); await bound(x, p, "root-b", "fb");
    const sends = holdSends(x);
    const d = toolDelta();
    sends.hold = gate(); x.state.defer = gate();
    const ab = dm(x, p, "root-a", `${ME}/fb`, "a to b"), ba = dm(x, p, "root-b", `${ME}/fa`, "b to a");
    try {
      await until(() => sends.held === 2, 10_000, "both sends held after their inserts");
      expect(await lockWaiters(db.sql)).toBe(0);
    } finally { sends.hold.open(); x.state.defer?.open(); }
    await Promise.all([ab, ba]);
    expect(d()).toEqual({ keyed: 2, miss: 0, skipped: 0 });
    expect((await db.sql`SELECT count(*)::int AS n FROM messages`)[0].n).toBe(2);
  });

  // A drain whose read lands mid-burst (a push session binding the recipient, held after its read) loses nothing:
  // sends committed before the read come through the drain, sends committed while it's held go to session.draining
  // through deliverSend (the keyed body's afterCommit effect), and each arrives once, in id order. Mutation: the keyed
  // body without effects (deliverSend refuses; the sends reject).
  test("a drain read in the middle of a burst of keyed sends loses nothing and delivers in id order", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await leaseInstance(db.url);
    const p = await leasePrincipal(x, db.sql);
    await bound(x, p, "root-s1", "s1"); await bound(x, p, "root-s2", "s2");
    const first = new AppSession(x.application, x.repo, p.authed, "rx", { key: "rx-key", bind: { create: true } });
    await first.connect();
    first.close();
    const d = toolDelta();
    const ids: number[] = [];
    const burst = async (tag: string) => {
      const out = await Promise.all([dm(x, p, "root-s1", `${ME}/rx`, `${tag} s1`), dm(x, p, "root-s2", `${ME}/rx`, `${tag} s2`)]);
      ids.push(...out.map(r => (r as { message_id: number }).message_id));
    };
    await burst("before");
    const rx = new AppSession(x.application, x.repo, p.authed, "rx", { key: "rx-key", bind: { create: true } });
    try {
      await hostedPause("server:drain:after-read", () => rx.connect(), async () => { await burst("during"); });
      await burst("after");
      const got = () => rx.events.filter(e => e.kind === "direct").map(e => (e as { message: { id: number } }).message.id);
      await until(() => got().length >= ids.length, 10_000, "every message delivered to rx");
      expect(got()).toEqual([...ids].sort((a, b) => a - b));
    } finally { rx.close(); }
    expect(d().keyed).toBe(6);
  });

  // The plan's live holder changed before the keyed body (a lease opened for the recipient after the pool's plan, so
  // the body holds no key of that root): the body's check before its insert misses, writing nothing, and the
  // exclusive body sends and wakes the new lease. Mutation: handleSend's holder guard dropped (the send runs keyed).
  test("a recipient whose live holder changed after the plan misses before the insert, and the exclusive body sends", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await leaseInstance(db.url);
    const p = await leasePrincipal(x, db.sql);
    await bound(x, p, "root-s1", "s1"); await bound(x, p, "root-a", "fe");
    const planned = gate(), arrived = gate();
    const plan = x.application.sendPlan;
    x.application.sendPlan = async (...a) => { const out = await plan(...a); arrived.open(); await planned.wait; return out; };
    const d = toolDelta();
    const sent = dm(x, p, "root-s1", `${ME}/fe`, "to a new holder");
    await arrived.wait;
    const wakes = { n: 0 };
    let lease;
    try {
      lease = await x.delivery.open(p, ctx(p, "root-a"), { changed: () => { wakes.n++; } });
      x.delivery.accept(lease);
    } finally { planned.open(); }
    expect(await sent).toMatchObject({ delivered_now: true });
    expect(d()).toEqual({ keyed: 0, miss: 1, skipped: 0 });
    await until(() => wakes.n > 0, 10_000, "the new lease woke for the DM");
    expect((await db.sql`SELECT count(*)::int AS n FROM messages`)[0].n).toBe(1);
  });

  // A plan whose recipient the body resolves differently misses before anything is written (the store's refusal of a
  // keyed insert without its `dm:` key is the backstop). Mutation: handleSend's recipient check dropped (the insert
  // refuses with a plain error and the send rejects).
  test("a plan whose recipient the body resolves differently misses, and the exclusive body sends", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await leaseInstance(db.url);
    const p = await leasePrincipal(x, db.sql);
    await bound(x, p, "root-s1", "s1"); await bound(x, p, "root-r1", "r1");
    const plan = x.application.sendPlan;
    x.application.sendPlan = async (...a) => { const out = await plan(...a); return out && { ...out, to: `${ME}/elsewhere` }; };
    const d = toolDelta();
    expect(await dm(x, p, "root-s1", `${ME}/r1`, "one")).toMatchObject({ delivered_now: false });
    expect(d()).toEqual({ keyed: 0, miss: 1, skipped: 0 });
    expect((await db.sql`SELECT recipient FROM messages`).map((r: { recipient: string }) => r.recipient)).toEqual([`${ME}/r1`]);
  });

  // A Slack-bridge human's session never plans keyed (its bodies share one afterRollback), nor runs sendKeyed; a send to
  // a human holder (the bridge's registered session) plans none either. Mutation: sendPlan's or sendKeyed's
  // `session.human` check dropped; sendPlan's human-holder check dropped.
  test("a human sender's send, or one to a human holder, has no keyed plan, and sendKeyed refuses a human as a miss", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await leaseInstance(db.url);
    const p = await leasePrincipal(x, db.sql);
    await bound(x, p, "root-r1", "r1");
    const { session: human } = await x.application.attachHuman(p.authed, { deliver() {}, closed() {} });
    expect(await x.application.sendPlan(human, `${ME}/r1`)).toBeUndefined();
    const agent = new AppSession(x.application, x.repo, p.authed, "s1", { bind: { create: true } });
    await agent.connect();
    try {
      expect(await x.application.sendPlan(agent.session, `${ME}/r1`)).toMatchObject({ to: `${ME}/r1` });
      expect(await x.application.sendPlan(agent.session, `${ME}/human`)).toBeUndefined();
    } finally { agent.close(); }
    const plan = { from: human.primary, to: `${ME}/r1`, live: undefined, holder: null };
    await expect(x.repo.writeKeyedSend!([`root:none`, `dm:${ME}/r1`], tx => x.application.sendKeyed(tx, human, plan, `${ME}/r1`, "hi"))).rejects.toBeInstanceOf(KeyedSendMiss);
    expect((await db.sql`SELECT count(*)::int AS n FROM messages`)[0].n).toBe(0);
  });

  // The enforcement (D4): a keyed body without the recipient's `dm:` key refuses messages.insert before any statement;
  // writeKeyedSend takes only a root and exactly one stream, and lets its afterCommit effects run where a plain keyed
  // body refuses them. Mutation: writeKeyedSend's key check dropped (the malformed key sets run).
  test("a keyed insert without its dm: key refuses; writeKeyedSend takes a root and exactly one stream, and runs its effects", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await leaseInstance(db.url);
    const p = await leasePrincipal(x, db.sql);
    await bound(x, p, "root-r1", "r1");
    const insert = (tx: Tx) => x.repo.messages.insert(tx, `${ME}/s`, "user", `${ME}/r1`, "x", null);
    await expect(x.repo.writeKeyed(["root:a"], insert)).rejects.toThrow(`without the key dm:${ME}/r1`);
    await expect(x.repo.writeKeyedSend!(["root:a", `dm:${ME}/r2`], insert)).rejects.toThrow(`without the key dm:${ME}/r1`);
    for (const keys of [[`dm:${ME}/r1`], ["root:a"], ["root:a", `dm:${ME}/r1`, `dm:${ME}/r2`], ["root:", `dm:${ME}/r1`], ["root:a", "dm:"]]) {
      await expect(x.repo.writeKeyedSend!(keys, insert)).rejects.toThrow("writeKeyedSend: a keyed send names a root and exactly one recipient stream");
    }
    let ran = 0;
    await expect(x.repo.writeKeyed(["root:a"], async tx => { tx.afterCommit(() => { ran++; }); })).rejects.toThrow("afterCommit effect refused in a keyed write body");
    await x.repo.writeKeyedSend!(["root:a", `dm:${ME}/r1`], async tx => { await insert(tx); tx.afterCommit(() => { ran++; }); });
    expect(ran).toBe(1);
    expect((await db.sql`SELECT count(*)::int AS n FROM messages`)[0].n).toBe(1);
  });

  // A normal exchange: the selection's verdict, then dm_send reusing it (withPrior), keyed in its tool body: counted as
  // the tool site's dm_send keyed, the prior's tool keyed, and one keyed body at the queue's `tool` site. The body's
  // statements are pinned so a later cut changes them on purpose (#1537 C6 among them): to a same-user recipient with
  // no live holder (isAuthorized stubbed, so fence's authorization reads nothing; fence takes no grant lock), 17
  // statements in 13 round trips: BEGIN; fence's store.lock (the root probe, then the row FOR UPDATE; rootOf reuses
  // them); sendKeyed's disabled read; the recipient's alias find (memoized: aliasHidden and the wake reuse it); dedup's
  // SAVEPOINT, prune and first claim (one flight); isHuman; the insert; lastSeen and the undelivered count (one
  // flight); the receipt upsert; RELEASE; the hosted.write audit and the auth-mark read (one flight); COMMIT.
  test("dm_send in a normal exchange runs keyed, counted by method, with a pinned statement count", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await leaseInstance(db.url);
    const p = await leasePrincipal(x, db.sql);
    await bound(x, p, "root-s1", "s1"); await bound(x, p, "root-r1", "r1");
    const c = ctx(p, "root-s1");
    await dm(x, p, "root-s1", `${ME}/r1`, "warm");
    const at = statementTotals("tool"), prior = gateCount("prior", "keyed", "tool"), d = toolDelta(), method = gateCount("tool", "keyed", "dm_send");
    const { verdict } = await x.hosted.snapshot(p, c, false);
    await x.hosted.dmSend(p, c, `${ME}/r1`, "in an exchange", {}, undefined, verdict);
    const now = statementTotals("tool");
    expect(d()).toEqual({ keyed: 1, miss: 0, skipped: 0 });
    expect(gateCount("tool", "keyed", "dm_send") - method).toBe(1);
    expect(gateCount("prior", "keyed", "tool") - prior).toBe(1);
    expect({ bodies: now.bodies - at.bodies, statements: now.statements - at.statements, roundTrips: now.roundTrips - at.roundTrips }).toEqual({ bodies: 1, statements: 17, roundTrips: 13 });
  });
});

describePg("keyed dm_send rows (Postgres)", () => {
  // The sender's binding changed after the call's gate (its root's bind_gen moved while the call waits at
  // hosted:tool:in-gate): the keyed body's fence refuses it unbound, a miss with nothing written, and the exclusive
  // body's fence refuses it again. Mutation: runTool's keyed body without its fence (the send commits keyed).
  test("a sender whose binding changed after the gate is refused unbound, keyed attempt and exclusive body alike", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await leaseInstance(db.url);
    const p = await leasePrincipal(x, db.sql);
    await bound(x, p, "root-s1", "s1"); await bound(x, p, "root-r1", "r1");
    const d = toolDelta();
    const out = await hostedPause("hosted:tool:in-gate", () => dm(x, p, "root-s1", `${ME}/r1`, "after rebind"), async () => {
      const bumped = await db.sql`UPDATE hosted_sessions SET bind_gen = bind_gen + 1 WHERE source_session_id = 'root-s1' AND root_session_id IS NULL RETURNING session_id`;
      expect(bumped).toHaveLength(1);
    }).then(r => `sent ${JSON.stringify(r)}`, (e: { code?: string; message?: string }) => `refused ${e.code}: ${e.message}`);
    expect(out).toBe("refused unbound: session binding changed; select the current binding again");
    expect(d()).toEqual({ keyed: 0, miss: 1, skipped: 0 });
    expect((await db.sql`SELECT count(*)::int AS n FROM messages`)[0].n).toBe(0);
  });

  // One script on two databases, keyed tool bodies on and off: keyed sends (plain, a replay, a resend, pending, a reply,
  // to a live holder), misses (a policy deny, whose authz.decision row the exclusive body writes once; a missing
  // alias's refusal; a disabled user, whose session the exclusive body terminates) and a skip (a send with files). Every row matches, message ids included (no keyed attempt
  // allocated one). Mutations: runTool's miss path skipping the exclusive body (the deny row and refusal differ);
  // the keyed attempt's refusal rows flushed as well as the exclusive body's (two deny rows).
  test("keyed sends and miss-then-exclusive write the same rows as the exclusive bodies alone", async () => {
    const script = async (x: LeaseInstance, sql: Awaited<ReturnType<typeof pgDatabase>>["sql"]) => {
      const p = await leasePrincipal(x, sql);
      const other = await seed(x.repo, async tx => {
        const u = await x.repo.users.upsertByEmail(tx, "other@example.com", null);
        await x.repo.aliases.create(tx, { scope_kind: "person", scope_ref: u.email, name: "human" }, u.email);
        return u;
      });
      await bound(x, p, "root-s1", "s1"); await bound(x, p, "root-r1", "r1");
      await leased(x, p, "root-a", "fe");
      const d = toolDelta();
      // The replay's note and first_at, and last_seen's age, carry the wall clock the two runs don't share.
      const outcome = (q: Promise<unknown>) => q.then(r => JSON.stringify(r), (e: { code?: string; message?: string }) => `refused ${e.code}: ${e.message}`)
        .then(t => t.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<time>").replace(/-?\d+[smhd] ago/g, "<ago>"));
      const out: string[] = [];
      const step = async (q: Promise<unknown>) => { out.push(await outcome(q)); x.advance(10); };
      await step(dm(x, p, "root-s1", `${ME}/r1`, "one"));
      await step(dm(x, p, "root-s1", `${ME}/r1`, "one"));
      await step(dm(x, p, "root-s1", `${ME}/r1`, "one", { resend: true }));
      await step(dm(x, p, "root-s1", `${ME}/r1`, "owe me", { pending: true }));
      const parent = Number((await sql`SELECT min(id) AS id FROM messages`)[0].id);
      await step(dm(x, p, "root-r1", `${ME}/s1`, "reply", { parent_id: parent }));
      await step(dm(x, p, "root-s1", `${ME}/fe`, "to the holder"));
      await step(dm(x, p, "root-s1", `${other.email}/human`, "denied"));
      await step(dm(x, p, "root-s1", `${ME}/nobody`, "missing"));
      await step(dm(x, p, "root-s1", `${ME}/r1`, "with files", { attachment_ids: [999] }));
      // Last: the user's row marked disabled after the call's gate, before its tool body, by a bare UPDATE (users.setDisabled
      // would also end the sessions, which fence then refuses first; isAuthorized is stubbed, so fence passes): the keyed
      // body misses on its own user read, and the exclusive body's valid() terminates the session and refuses.
      await step(hostedPause("hosted:tool:in-gate", () => dm(x, p, "root-s1", `${ME}/r1`, "disabled"),
        async () => { await sql`UPDATE users SET disabled_at = ${x.clock} WHERE id = ${p.authed.user_id}`; }));
      await atSite("other", () => x.repo.write(() => {}));
      return { counts: d(), out };
    };
    const dump = async (sql: Awaited<ReturnType<typeof pgDatabase>>["sql"]) => {
      const out: Record<string, string[]> = {};
      // Receipts' `at`, holds' bound_at, a replay's first_at and last_seen's age are the wall clock, which the runs don't share.
      for (const [table, drop] of [["messages", []], ["write_receipts", ["at"]], ["mailbox_cursors", []], ["access_log", ["id"]], ["hosted_sessions", []], ["binding_events", ["id"]], ["ids", []], ["alias_holds", ["bound_at"]]] as const) {
        const rows: Array<Record<string, unknown>> = await sql.unsafe(`SELECT * FROM ${table}`);
        out[table] = rows.map(r => JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => !(drop as readonly string[]).includes(k)).sort(([a], [b]) => a < b ? -1 : 1)), (_k, v) => typeof v === "bigint" ? String(v) : v)
          .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<time>").replace(/-?\d+[smhd] ago/g, "<ago>")).sort();
      }
      return out;
    };
    await using fastDb = await pgDatabase({ max: 2 });
    await using refDb = await pgDatabase({ max: 2 });
    let fastRows: Record<string, string[]>, refRows: Record<string, string[]>, fast: Awaited<ReturnType<typeof script>>, ref: Awaited<ReturnType<typeof script>>;
    { await using x = await leaseInstance(fastDb.url, { side: "fast" }); fast = await script(x, fastDb.sql); fastRows = await dump(fastDb.sql); }
    { await using x = await leaseInstance(refDb.url, { side: "ref", keyedTools: false }); ref = await script(x, refDb.sql); refRows = await dump(refDb.sql); }
    expect(fast.out).toEqual(ref.out);
    expect(fast.counts).toEqual({ keyed: 6, miss: 3, skipped: 1 });
    expect(ref.counts).toEqual({ keyed: 0, miss: 0, skipped: 10 });
    expect(fast.out.at(-1)).toMatch(/^refused/);
    expect(fastRows).toEqual(refRows);
    expect(fastRows.access_log!.filter(r => r.includes('"authz.decision"'))).toHaveLength(1);
    expect(fastRows.access_log!.filter(r => r.includes('"request.replayed"'))).toHaveLength(1);
    expect(fastRows.access_log!.filter(r => r.includes('"request.resent"'))).toHaveLength(1);
  });
});

// board_post keyed (#1537 PR 6, D4): a keyed post is held after its insert (its id allocated, its row and FK locks
// taken), or after its outbox insert (its last write), by a gate on the boards store, with the timer's bodies deferred
// meanwhile; every wait has a deadline. A held post counts in x.state.held, so an exclusive body that starts beside it
// is marked startedHeld. Results and mutation killers: p1537/c6/result.md.
const boardTool = (x: LeaseInstance, p: OAuthPrincipal, source: string, name: string, args: Record<string, unknown>) =>
  x.hosted.run(p, ctx(p, source), name, (session, tx) => x.application.call(tx, session, name, args));
const post = (x: LeaseInstance, p: OAuthPrincipal, source: string, args: Record<string, unknown>) => x.hosted.boardPost(p, ctx(p, source), args);
const postId = (r: unknown) => (r as { post_id: number }).post_id;
function holdPosts(x: LeaseInstance, at: "insert" | "outbox" = "insert") {
  const posts = { hold: undefined as Gate | undefined, held: 0, entered: [] as string[] };
  const wait = async (what: string) => {
    posts.entered.push(what); posts.held++; x.state.held++;
    try { await posts.hold!.wait; } finally { posts.held--; x.state.held--; }
  };
  if (at === "insert") {
    const insertPost = x.repo.boards.insertPost;
    x.repo.boards.insertPost = (async (tx: Tx, row: Parameters<typeof insertPost>[1]) => {
      const out = await insertPost(tx, row);
      if (keyedTx(tx) && currentSite() === "tool" && posts.hold) await wait(`${row.author} > #${row.board}`);
      return out;
    }) as typeof insertPost;
  } else {
    const insertOutbox = x.repo.boards.insertOutbox;
    x.repo.boards.insertOutbox = (async (tx: Tx, id: number, targets: Parameters<typeof insertOutbox>[2]) => {
      await insertOutbox(tx, id, targets);
      if (keyedTx(tx) && currentSite() === "tool" && posts.hold) await wait(`post ${id}`);
    }) as typeof insertOutbox;
  }
  return posts;
}
const subscribe = (x: LeaseInstance, handle: string, board: string, mode: "push" | "digest" | "off" = "push") =>
  seed(x.repo, tx => x.repo.boards.setSubscription(tx, handle, board, mode));

describePg("keyed board_post (Postgres)", () => {
  // Two posts on one board (from different roots) run one at a time on its key; a post on another board enters beside
  // the held one. Ids then commit in allocation order per board, where every reader's cursor is. Mutation: the
  // `board:` key dropped from boardPost's keys (writeKeyedPost refuses the key set; with its check gone too, the second
  // post on b1 enters beside the first).
  test("two posts on one board never overlap; a post on another board overlaps them", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await leaseInstance(db.url);
    const p = await leasePrincipal(x, db.sql);
    for (const [s, n] of [["root-s1", "s1"], ["root-s2", "s2"], ["root-s3", "s3"], ["root-o", "owner"]]) await bound(x, p, s!, n!);
    await boardTool(x, p, "root-o", "board_create", { name: "b1", purpose: "one" });
    await boardTool(x, p, "root-o", "board_create", { name: "b2", purpose: "two" });
    const posts = holdPosts(x);
    const d = toolDelta();
    posts.hold = gate(); x.state.defer = gate();
    const first = post(x, p, "root-s1", { board: "b1", body: "one" });
    await until(() => posts.held === 1, 10_000, "s1's post on b1 held after its insert");
    const second = post(x, p, "root-s2", { board: "b1", body: "two" });
    try {
      await until(() => callWaiting(x) === 1 || posts.held > 1, 10_000, "s2's post on b1 queued");
      expect(posts.held).toBe(1);
      const other = post(x, p, "root-s3", { board: "b2", body: "three" });
      await until(() => posts.held === 2, 10_000, "s3's post on b2 entered beside s1's on b1");
      posts.hold.open();
      await Promise.all([first, second, other]);
    } finally { posts.hold.open(); x.state.defer?.open(); }
    expect(posts.entered).toEqual([`${ME}/s1 > #b1`, `${ME}/s3 > #b2`, `${ME}/s2 > #b1`]);
    const b1 = await db.sql`SELECT body FROM posts WHERE board = 'b1' ORDER BY id`;
    expect(b1.map((r: { body: string }) => r.body)).toEqual(["one", "two"]);
    expect(d()).toEqual({ keyed: 3, miss: 0, skipped: 0 });
  });

  // Two posts of one root run one at a time, whatever their boards. Mutation: the poster's `root:` key dropped (the
  // second enters beside the first; writeKeyedPost's check refuses first, so with that check gone too).
  test("two posts of one root run one at a time", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await leaseInstance(db.url);
    const p = await leasePrincipal(x, db.sql);
    await bound(x, p, "root-s1", "s1");
    await boardTool(x, p, "root-s1", "board_create", { name: "b1", purpose: "one" });
    await boardTool(x, p, "root-s1", "board_create", { name: "b2", purpose: "two" });
    const posts = holdPosts(x);
    posts.hold = gate(); x.state.defer = gate();
    const first = post(x, p, "root-s1", { board: "b1", body: "one" });
    await until(() => posts.held === 1, 10_000, "the first post held");
    const second = post(x, p, "root-s1", { board: "b2", body: "two" });
    try {
      await until(() => callWaiting(x) === 1 || posts.held > 1, 10_000, "the second post queued on the root");
      expect(posts.held).toBe(1);
    } finally { posts.hold.open(); x.state.defer?.open(); }
    await Promise.all([first, second]);
    expect(posts.entered).toEqual([`${ME}/s1 > #b1`, `${ME}/s1 > #b2`]);
  });

  // A push subscriber's drain whose read lands mid-burst (a session binding the address, held after its first board
  // read) loses nothing: posts committed before come through that drain, posts committed while it's held through the
  // wakes (the keyed body's afterCommit effects), each once, in id order. Mutation: the keyed body without effects
  // (the posts reject: an effect refused in a keyed write body).
  test("a subscriber's drain in the middle of a burst of keyed posts loses nothing and delivers in id order", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await leaseInstance(db.url);
    const p = await leasePrincipal(x, db.sql);
    await bound(x, p, "root-s1", "s1"); await bound(x, p, "root-s2", "s2");
    await boardTool(x, p, "root-s1", "board_create", { name: "b1", purpose: "one" });
    await subscribe(x, `${ME}/rx`, "b1");
    const first = new AppSession(x.application, x.repo, p.authed, "rx", { key: "rx-key", bind: { create: true } });
    await first.connect();
    first.close();
    const d = toolDelta();
    const ids: number[] = [];
    const burst = async (tag: string) => {
      const out = await Promise.all([post(x, p, "root-s1", { board: "b1", body: `${tag} s1` }), post(x, p, "root-s2", { board: "b1", body: `${tag} s2` })]);
      ids.push(...out.map(postId));
    };
    await burst("before");
    const rx = new AppSession(x.application, x.repo, p.authed, "rx", { key: "rx-key", bind: { create: true } });
    try {
      await hostedPause("server:drain-boards:before-read", () => rx.connect(), async () => { await burst("during"); });
      await burst("after");
      const got = () => rx.events.filter(e => e.kind === "board").map(e => ((e as { item: { post?: { id: number } } }).item.post?.id));
      await until(() => got().length >= ids.length, 10_000, "every post delivered to rx");
      expect(got()).toEqual([...ids].sort((a, b) => a - b));
    } finally { rx.close(); }
    expect(d().keyed).toBe(6);
  });

  // Post against a bind, a subscribe and an unsubscribe (each exclusive: a gate body, two tool bodies), queued while the
  // post is held: none starts until it commits, so a subscribe queued after it misses it (its cursor is at the tip) and
  // an unsubscribe queued after it still got it; the next post sees both changes. Mutation: the scheduler letting an
  // exclusive body start beside a keyed one (store/queue.ts startNext): each starts while the post is held.
  test("a bind, a subscribe and an unsubscribe queued behind a held post start after it commits", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await leaseInstance(db.url);
    const p = await leasePrincipal(x, db.sql);
    for (const [s, n] of [["root-s1", "s1"], ["root-s2", "s2"], ["root-s3", "s3"]]) await bound(x, p, s!, n!);
    await x.hosted.run(p, ctx(p, "root-r"), "whoami", () => null);
    await boardTool(x, p, "root-s1", "board_create", { name: "b1", purpose: "one" });
    await boardTool(x, p, "root-s3", "board_subscribe", { board: "b1", mode: "push" });
    const posts = holdPosts(x);
    const d = toolDelta();
    x.state.exclusive = [];
    posts.hold = gate(); x.state.defer = gate();
    const held = post(x, p, "root-s1", { board: "b1", body: "first" });
    let bind, sub, unsub;
    try {
      await until(() => posts.held === 1, 10_000, "the post held");
      bind = x.hosted.bind(p, ctx(p, "root-r"), { name: "rx", create: true });
      sub = boardTool(x, p, "root-s2", "board_subscribe", { board: "b1", mode: "push" });
      unsub = boardTool(x, p, "root-s3", "board_subscribe", { board: "b1", mode: "off" });
      // One body of each call, not counting the timer's: where each waits depends on where it met the first exclusive
      // waiter (a subscribe's keyed gate body or its tool body; the bind's prior touch, keyed gate or owning body), and
      // each call has at most one body queued at a time.
      const calls = () => x.q.waiting - x.q.waitingAt("heartbeat") - x.q.waitingAt("sweep") - x.q.waitingAt("reconcile");
      await until(() => calls() >= 3, 10_000, "a body of the bind and of both subscribes queued");
      expect(x.state.exclusive.filter(b => b.startedHeld)).toEqual([]);
    } finally { posts.hold.open(); x.state.defer?.open(); }
    const firstId = postId(await held);
    await Promise.all([bind, sub, unsub]);
    expect(x.state.exclusive.filter(b => b.startedHeld)).toEqual([]);
    const second = postId(await post(x, p, "root-s1", { board: "b1", body: "second" }));
    const outbox = async (id: number) => (await db.sql`SELECT handle FROM outbox WHERE post_id = ${id} ORDER BY handle`).map((r: { handle: string }) => r.handle);
    expect(await outbox(firstId)).toEqual([`${ME}/s3`]);
    expect(await outbox(second)).toEqual([`${ME}/s2`]);
    expect(Number((await db.sql`SELECT cursor FROM subscriptions WHERE board = 'b1' AND handle = ${`${ME}/s2`}`)[0].cursor)).toBeGreaterThanOrEqual(firstId);
    expect(d()).toEqual({ keyed: 2, miss: 0, skipped: 0 });
  });

  // A post with a push subscriber beside a dm_send to that subscriber: disjoint keys (board and poster root; the DM's
  // stream and sender root), so the DM commits while the post is held, and the subscriber gets both.
  test("a dm_send to a post's subscriber commits while the post is held", async () => {
    await using db = await pgDatabase({ max: 3 });
    await using x = await leaseInstance(db.url);
    const p = await leasePrincipal(x, db.sql);
    for (const [s, n] of [["root-s1", "s1"], ["root-s2", "s2"], ["root-r1", "r1"]]) await bound(x, p, s!, n!);
    await boardTool(x, p, "root-s1", "board_create", { name: "b1", purpose: "one" });
    await boardTool(x, p, "root-r1", "board_subscribe", { board: "b1", mode: "push" });
    const posts = holdPosts(x, "outbox");
    const d = toolDelta();
    posts.hold = gate(); x.state.defer = gate();
    const held = post(x, p, "root-s1", { board: "b1", body: "news" });
    try {
      await until(() => posts.held === 1, 10_000, "the post held after its outbox insert");
      expect(await dm(x, p, "root-s2", `${ME}/r1`, "meanwhile")).toMatchObject({ message_id: expect.any(Number) });
      expect(posts.held).toBe(1);
      expect(await lockWaiters(db.sql)).toBe(0);
    } finally { posts.hold.open(); x.state.defer?.open(); }
    const id = postId(await held);
    expect((await db.sql`SELECT handle FROM outbox WHERE post_id = ${id}`).map((r: { handle: string }) => r.handle)).toEqual([`${ME}/r1`]);
    expect((await db.sql`SELECT count(*)::int AS n FROM messages WHERE recipient = ${`${ME}/r1`}`)[0].n).toBe(1);
    expect(d()).toEqual({ keyed: 2, miss: 0, skipped: 0 });
  });

  // A on b1 beside B on b2, each subscribed to the other's board (each post writes an outbox row for the other's
  // address), then each replying in the other's thread (the parent FOR KEY SHARE): both held after their last write at
  // once, neither waits on a lock, and both commit, with no 40P01.
  test("crossed posts and crossed replies held at once commit with no lock wait and no deadlock", async () => {
    await using db = await pgDatabase({ max: 3 });
    await using x = await leaseInstance(db.url);
    const p = await leasePrincipal(x, db.sql);
    await bound(x, p, "root-a", "fa"); await bound(x, p, "root-b", "fb");
    await boardTool(x, p, "root-a", "board_create", { name: "b1", purpose: "one" });
    await boardTool(x, p, "root-b", "board_create", { name: "b2", purpose: "two" });
    await boardTool(x, p, "root-a", "board_subscribe", { board: "b2", mode: "push" });
    await boardTool(x, p, "root-b", "board_subscribe", { board: "b1", mode: "push" });
    const posts = holdPosts(x, "outbox");
    const d = toolDelta();
    const pair = async (a: Record<string, unknown>, b: Record<string, unknown>) => {
      posts.hold = gate(); x.state.defer = gate();
      const pa = post(x, p, "root-a", a), pb = post(x, p, "root-b", b);
      try {
        await until(() => posts.held === 2, 10_000, "both posts held after their outbox inserts");
        expect(await lockWaiters(db.sql)).toBe(0);
      } finally { posts.hold.open(); x.state.defer?.open(); }
      return (await Promise.all([pa, pb])).map(postId);
    };
    const [onB1, onB2] = await pair({ board: "b1", body: "a on b1" }, { board: "b2", body: "b on b2" });
    await pair({ board: "b2", body: "a replies", parent_id: onB2 }, { board: "b1", body: "b replies", parent_id: onB1 });
    expect(d()).toEqual({ keyed: 4, miss: 0, skipped: 0 });
    expect((await db.sql`SELECT count(*)::int AS n FROM posts`)[0].n).toBe(4);
  });

  // A plan whose board the body resolves differently misses before the insert, and the exclusive body posts. Mutation:
  // handleBoardPost's board check dropped (insertPost's refuseKeyed throws, which fails the call as a fault).
  test("a plan whose board the body resolves differently misses, and the exclusive body posts", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await leaseInstance(db.url);
    const p = await leasePrincipal(x, db.sql);
    await bound(x, p, "root-s1", "s1");
    await boardTool(x, p, "root-s1", "board_create", { name: "b1", purpose: "one" });
    const plan = x.application.postPlan;
    x.application.postPlan = async (...a) => { const out = await plan(...a); return out && { board: "elsewhere" }; };
    const d = toolDelta();
    expect(await post(x, p, "root-s1", { board: "b1", body: "one" })).toMatchObject({ board: "b1" });
    expect(d()).toEqual({ keyed: 0, miss: 1, skipped: 0 });
    expect((await db.sql`SELECT board FROM posts`).map((r: { board: string }) => r.board)).toEqual(["b1"]);
  });

  // A queue board's post planned keyed anyway (the plan stubbed) misses in the body, before the insert, and the
  // exclusive body posts and rotates it; so does the lane's reply, which acks its claim (a thread post, not the queue
  // branch, but a claim_events write all the same). Mutation: handleBoardPost's queue check dropped (claim_events'
  // refuseKeyed fails the call as a fault), or narrowed to the queue branch (the reply fails).
  test("a queue board's post and its lane's reply miss in the body, and the exclusive body rotates and acks", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await leaseInstance(db.url);
    const p = await leasePrincipal(x, db.sql);
    await bound(x, p, "root-s1", "s1"); await bound(x, p, "root-l", "lane");
    await boardTool(x, p, "root-s1", "board_create", { name: "q1", purpose: "queue", kind: "queue" });
    await boardTool(x, p, "root-l", "board_subscribe", { board: "q1", mode: "push" });
    expect(await x.application.postPlan((await x.application.attachHuman(p.authed, { deliver() {}, closed() {} })).session, { board: "q1", body: "x" })).toBeUndefined();
    x.application.postPlan = async () => ({ board: "q1" });
    const d = toolDelta();
    const job = postId(await post(x, p, "root-s1", { board: "q1", body: "job" }));
    expect(d()).toEqual({ keyed: 0, miss: 1, skipped: 0 });
    const events = async () => (await db.sql`SELECT count(*)::int AS n FROM claim_events`)[0].n;
    expect(await events()).toBe(1);
    await post(x, p, "root-l", { board: "q1", body: "done", parent_id: job });
    expect(d()).toEqual({ keyed: 0, miss: 2, skipped: 0 });
    expect(await events()).toBeGreaterThan(1);
  });

  // The plan leaves each exclusive case out: a Slack-bridge human's session, files, `attachments`, an `@id:` mention, a
  // queue board (a reply there too: a lane's reply acks its claim), a service's board, a human address, a missing board. Mutations: each of postPlan's checks dropped
  // (that case plans a board).
  test("postPlan has no plan for the exclusive cases", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await leaseInstance(db.url);
    const p = await leasePrincipal(x, db.sql);
    await bound(x, p, "root-s1", "s1"); await bound(x, p, "root-h", "hum");
    await boardTool(x, p, "root-s1", "board_create", { name: "b1", purpose: "one" });
    await boardTool(x, p, "root-s1", "board_create", { name: "q1", purpose: "queue", kind: "queue" });
    await db.sql`INSERT INTO boards (name, purpose, scope, created_by, created_at) VALUES ('svc-b', 'service', 'service:svc', ${`${ME}/s1`}, 0)`;
    await db.sql`UPDATE aliases SET human = true WHERE name = 'hum'`;
    const { session: human } = await x.application.attachHuman(p.authed, { deliver() {}, closed() {} });
    const agent = new AppSession(x.application, x.repo, p.authed, "s1", { push: false });
    await agent.connect();
    const hum = new AppSession(x.application, x.repo, p.authed, "hum", { push: false });
    await hum.connect();
    try {
      const plan = (args: Record<string, unknown>, s = agent.session) => x.application.postPlan(s, args);
      expect(await plan({ board: "b1", body: "ok @s1" })).toEqual({ board: "b1" });
      expect(await plan({ board: "b1", body: "ok", attachment_ids: [] })).toEqual({ board: "b1" });
      expect(await plan({ board: "b1", body: "ok" }, human)).toBeUndefined();
      expect(await plan({ board: "b1", body: "files", attachment_ids: [1] })).toBeUndefined();
      expect(await plan({ board: "b1", body: "files", attachments: [] })).toBeUndefined();
      expect(await plan({ board: "b1", body: `hi @${agent.id}` })).toBeUndefined();
      expect(await plan({ board: "q1", body: "job" })).toBeUndefined();
      expect(await plan({ board: "q1", body: "done", parent_id: 1 })).toBeUndefined();
      expect(await plan({ board: "svc-b", body: "invoke" })).toBeUndefined();
      expect(await plan({ board: "b1", body: "as a human" }, hum.session)).toBeUndefined();
      expect(await plan({ board: "nowhere", body: "missing" })).toBeUndefined();
    } finally { agent.close(); hum.close(); }
  });

  // The enforcement (D4): a keyed body without the board's key refuses boards.insertPost before any statement;
  // writeKeyedPost takes exactly one root and one board, and lets its afterCommit effects run where a plain keyed body
  // refuses them. Mutation: writeKeyedPost's key check dropped (the malformed key sets run).
  test("a keyed post insert without its board: key refuses; writeKeyedPost takes one root and one board, and runs its effects", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await leaseInstance(db.url);
    const p = await leasePrincipal(x, db.sql);
    await bound(x, p, "root-s1", "s1");
    await boardTool(x, p, "root-s1", "board_create", { name: "b1", purpose: "one" });
    const insert = (tx: Tx) => x.repo.boards.insertPost(tx, { board: "b1", author: `${ME}/s1`, body: "x", parentId: null, now: x.clock, expiresAt: null, authorId: null, via: null, authorUser: null, human: false });
    await expect(x.repo.writeKeyed(["root:a"], insert)).rejects.toThrow("without the key board:b1");
    await expect(x.repo.writeKeyedPost!(["root:a", "board:b2"], insert)).rejects.toThrow("without the key board:b1");
    for (const keys of [["board:b1"], ["root:a"], ["root:a", "root:b", "board:b1"], ["root:a", "board:b1", "board:b2"], ["root:a", "board:b1", "dm:x"], ["root:", "board:b1"], ["root:a", "board:"]]) {
      await expect(x.repo.writeKeyedPost!(keys, insert)).rejects.toThrow("writeKeyedPost: a keyed post names one root and one board");
    }
    let ran = 0;
    await x.repo.writeKeyedPost!(["root:a", "board:b1"], async tx => { await insert(tx); tx.afterCommit(() => { ran++; }); });
    expect(ran).toBe(1);
    expect((await db.sql`SELECT count(*)::int AS n FROM posts`)[0].n).toBe(1);
  });

  // A normal exchange: the selection's verdict, then board_post reusing it (withPrior), keyed in its tool body. The
  // body's statements are pinned so a later cut changes them on purpose: a top-level post with one push subscriber
  // besides its author (isAuthorized stubbed), 31 statements in 28 round trips, the exclusive body's count for the same
  // post (measured with keyedTools off): keying adds and removes none.
  test("board_post in a normal exchange runs keyed, counted by method, with a pinned statement count", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await leaseInstance(db.url);
    const p = await leasePrincipal(x, db.sql);
    await bound(x, p, "root-s1", "s1"); await bound(x, p, "root-r1", "r1");
    await boardTool(x, p, "root-s1", "board_create", { name: "b1", purpose: "one" });
    await boardTool(x, p, "root-r1", "board_subscribe", { board: "b1", mode: "push" });
    const c = ctx(p, "root-s1");
    await post(x, p, "root-s1", { board: "b1", body: "warm" });
    const at = statementTotals("tool"), prior = gateCount("prior", "keyed", "tool"), d = toolDelta(), method = gateCount("tool", "keyed", "board_post");
    const { verdict } = await x.hosted.snapshot(p, c, false);
    await x.hosted.boardPost(p, c, { board: "b1", body: "in an exchange" }, undefined, verdict);
    const now = statementTotals("tool");
    expect(d()).toEqual({ keyed: 1, miss: 0, skipped: 0 });
    expect(gateCount("tool", "keyed", "board_post") - method).toBe(1);
    expect(gateCount("prior", "keyed", "tool") - prior).toBe(1);
    expect({ bodies: now.bodies - at.bodies, statements: now.statements - at.statements, roundTrips: now.roundTrips - at.roundTrips }).toEqual({ bodies: 1, statements: 31, roundTrips: 28 });
  });
});

describePg("keyed board_post rows (Postgres)", () => {
  // One script on two databases, keyed tool bodies on and off: keyed posts (plain, a replay, a resend, a reply, a
  // mention), skips (a queue board's post, an `@id:` mention, files, a missing board, a service's board whose deny the
  // exclusive body records once, a human address) and misses (an archived board's refusal; a disabled user, whose
  // session the exclusive body terminates). Every row matches, post ids included (no keyed attempt allocated one).
  // Mutations: runTool's miss path skipping the exclusive body (the refusals and rows differ); the keyed attempt's
  // refusal rows flushed as well as the exclusive body's.
  test("keyed posts and miss-then-exclusive write the same rows as the exclusive bodies alone", async () => {
    const script = async (x: LeaseInstance, sql: Awaited<ReturnType<typeof pgDatabase>>["sql"]) => {
      const p = await leasePrincipal(x, sql);
      for (const [s, n] of [["root-s1", "s1"], ["root-s2", "s2"], ["root-r1", "r1"], ["root-h", "hum"]]) await bound(x, p, s!, n!);
      await boardTool(x, p, "root-s1", "board_create", { name: "b1", purpose: "one" });
      await boardTool(x, p, "root-s1", "board_create", { name: "b2", purpose: "two" });
      await boardTool(x, p, "root-s1", "board_create", { name: "q1", purpose: "queue", kind: "queue" });
      await boardTool(x, p, "root-r1", "board_subscribe", { board: "b1", mode: "push" });
      await boardTool(x, p, "root-r1", "board_subscribe", { board: "q1", mode: "push" });
      await boardTool(x, p, "root-s1", "board_archive", { board: "b2" });
      await sql`INSERT INTO boards (name, purpose, scope, created_by, created_at) VALUES ('svc-b', 'service', 'service:svc', ${`${ME}/s1`}, 0)`;
      await sql`UPDATE aliases SET human = true WHERE name = 'hum'`;
      const d = toolDelta();
      const outcome = (q: Promise<unknown>) => q.then(r => JSON.stringify(r), (e: { code?: string; message?: string }) => `refused ${e.code}: ${e.message}`)
        .then(t => t.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<time>").replace(/-?\d+[smhd] ago/g, "<ago>"));
      const out: string[] = [];
      const step = async (q: Promise<unknown>) => { out.push(await outcome(q)); x.advance(10); };
      await step(post(x, p, "root-s1", { board: "b1", body: "one" }));
      await step(post(x, p, "root-s1", { board: "b1", body: "one" }));
      await step(post(x, p, "root-s1", { board: "b1", body: "one", resend: true }));
      const parent = Number((await sql`SELECT min(id) AS id FROM posts`)[0].id);
      await step(post(x, p, "root-s2", { board: "b1", body: "a reply", parent_id: parent }));
      await step(post(x, p, "root-s2", { board: "b1", body: "look @r1" }));
      await step(post(x, p, "root-s1", { board: "q1", body: "job" }));
      await step(post(x, p, "root-s1", { board: "b1", body: `hi @${idOf(p, "root-r1")}` }));
      await step(post(x, p, "root-s1", { board: "b1", body: "with files", attachment_ids: [999] }));
      await step(post(x, p, "root-s1", { board: "nowhere", body: "missing" }));
      await step(post(x, p, "root-s1", { board: "svc-b", body: "invoke" }));
      await step(post(x, p, "root-h", { board: "b1", body: "as a human" }));
      await step(post(x, p, "root-s1", { board: "b2", body: "archived" }));
      // Last: the user's row marked disabled after the call's gate, before its tool body (dm_send's rows test's step).
      await step(hostedPause("hosted:tool:in-gate", () => post(x, p, "root-s1", { board: "b1", body: "disabled" }),
        async () => { await sql`UPDATE users SET disabled_at = ${x.clock} WHERE id = ${p.authed.user_id}`; }));
      await atSite("other", () => x.repo.write(() => {}));
      return { counts: d(), out };
    };
    const dump = async (sql: Awaited<ReturnType<typeof pgDatabase>>["sql"]) => {
      const out: Record<string, string[]> = {};
      for (const [table, drop] of [["posts", []], ["outbox", []], ["subscriptions", []], ["claim_events", ["id"]], ["write_receipts", ["at"]], ["access_log", ["id"]], ["hosted_sessions", []], ["boards", []], ["alias_holds", ["bound_at"]]] as const) {
        const rows: Array<Record<string, unknown>> = await sql.unsafe(`SELECT * FROM ${table}`);
        out[table] = rows.map(r => JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => !(drop as readonly string[]).includes(k)).sort(([a], [b]) => a < b ? -1 : 1)), (_k, v) => typeof v === "bigint" ? String(v) : v)
          .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<time>").replace(/-?\d+[smhd] ago/g, "<ago>")).sort();
      }
      return out;
    };
    await using fastDb = await pgDatabase({ max: 2 });
    await using refDb = await pgDatabase({ max: 2 });
    let fastRows: Record<string, string[]>, refRows: Record<string, string[]>, fast: Awaited<ReturnType<typeof script>>, ref: Awaited<ReturnType<typeof script>>;
    { await using x = await leaseInstance(fastDb.url, { side: "fast" }); fast = await script(x, fastDb.sql); fastRows = await dump(fastDb.sql); }
    { await using x = await leaseInstance(refDb.url, { side: "ref", keyedTools: false }); ref = await script(x, refDb.sql); refRows = await dump(refDb.sql); }
    expect(fast.out).toEqual(ref.out);
    expect(fast.counts).toEqual({ keyed: 5, miss: 2, skipped: 6 });
    expect(ref.counts).toEqual({ keyed: 0, miss: 0, skipped: 13 });
    expect(fast.out.at(-1)).toMatch(/^refused/);
    expect(fast.out.at(-2)).toMatch(/^refused/);
    expect(fastRows).toEqual(refRows);
    expect(fastRows.access_log!.filter(r => r.includes('"authz.decision"'))).toHaveLength(1);
    expect(fastRows.access_log!.filter(r => r.includes('"request.replayed"'))).toHaveLength(1);
    expect(fastRows.claim_events).toHaveLength(1);
  });
});

describePg("timer bodies (Postgres)", () => {
  // The heartbeat is keyed on its one row (#1537 PR 6): it commits while a keyed post is held. Mutation: the heartbeat
  // back to an exclusive write (it waits for the held post, and the stamp never lands while it's held).
  test("a heartbeat commits beside a held keyed post", async () => {
    await using db = await pgDatabase({ max: 3 });
    await using x = await leaseInstance(db.url);
    const p = await leasePrincipal(x, db.sql);
    await bound(x, p, "root-s1", "s1");
    await boardTool(x, p, "root-s1", "board_create", { name: "b1", purpose: "one" });
    const posts = holdPosts(x);
    posts.hold = gate(); x.state.defer = gate();
    const held = post(x, p, "root-s1", { board: "b1", body: "one" });
    try {
      await until(() => posts.held === 1, 10_000, "the post held");
      x.advance(5_000);
      const stamp = x.clock;
      await until(async () => Number((await db.sql`SELECT value FROM server_state WHERE key = 'alive_at'`)[0]?.value ?? 0) >= stamp, 10_000, "a heartbeat stamped while the post is held");
      expect(posts.held).toBe(1);
    } finally { posts.hold.open(); x.state.defer?.open(); }
    await held;
  });

  // The timer's sweep reads the pool first and queues no exclusive body while nothing is due. Mutation: timerSweep
  // queueing the body without the check (a sweep body per tick).
  test("the timer queues no sweep body while nothing is due", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await leaseInstance(db.url);
    const p = await leasePrincipal(x, db.sql);
    await bound(x, p, "root-s1", "s1");
    let reads = 0;
    const expired = x.repo.hosted.expired;
    x.repo.hosted.expired = (r, t) => { if (!isTx(r)) reads++; return expired(r, t); };
    x.state.exclusive = [];
    await until(() => reads >= 4, 10_000, "four timer ticks' pool checks");
    expect(x.state.exclusive.filter(b => b.site === "sweep")).toEqual([]);
  });

  // Each thing a sweep ends brings the timer's body back: a lapsed lease (every tick), an idle unbound root and a
  // disabled user's root (the full pass, every IDLE_EVERY ticks). Mutations: sweepDue without its expired, idle or
  // disabled read (that case is never swept).
  for (const due of ["expired", "idle", "disabled"] as const) test(`the timer sweeps when the pool finds a row due: ${due}`, async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await leaseInstance(db.url);
    const p = await leasePrincipal(x, db.sql);
    let id: string;
    if (due === "expired") {
      id = (await leased(x, p, "root-a", "fe")).id;
      x.advance(x.hosted.leaseTtl + 1_000);
    } else if (due === "idle") {
      await x.hosted.run(p, ctx(p, "root-b"), "whoami", () => null);
      id = idOf(p, "root-b");
      x.advance(24 * 3600_000);
    } else {
      const other = await seed(x.repo, tx => x.repo.users.upsertByEmail(tx, "other@example.com", null));
      await db.sql`INSERT INTO oauth_grants (id, user_id, expires_at, data) VALUES ('G2', ${other.id}, ${Number.MAX_SAFE_INTEGER}, '{}'::jsonb)`;
      const q: OAuthPrincipal = { ...p, authed: { ...p.authed, user_id: other.id, user_email: other.email }, grantId: "G2" };
      await x.hosted.run(q, ctx(q, "root-o"), "whoami", () => null);
      id = idOf(q, "root-o");
      await db.sql`UPDATE users SET disabled_at = ${x.clock} WHERE id = ${other.id}`;
    }
    x.state.exclusive = [];
    await until(async () => (await x.repo.hosted.get(x.repo.read, id)) === undefined, 15_000, `the ${due} root ended by the timer's sweep`);
    expect(x.state.exclusive.filter(b => b.site === "sweep").length).toBeGreaterThanOrEqual(1);
  });
});

describePg("the backstop reconcile (Postgres)", () => {
  // #1572: the full pass reads every watched row in one statement on its Tx, so its body's statements don't grow with
  // the watched sessions. Pinned at 6: BEGIN; the watched rows (getMany); holdsByOwner; store.all; the auth-mark read;
  // COMMIT. The roots are unbound (no holds), so no build runs. Mutation: readAll back to one store.get per ID (2
  // watched: 7; 6 watched: 11).
  test("a full reconcile body's statements don't grow with the watched sessions (#1572)", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await gateInstance(db.url, { oauth: true });
    const { p } = await issued(x);
    const watched = new Set<string>();
    const unwatch = x.hosted.watchRows({ ids: () => watched, apply() {} });
    const measured = async () => {
      const at = statementTotals("reconcile");
      await x.hosted.reconcile();
      const now = statementTotals("reconcile");
      return { bodies: now.bodies - at.bodies, statements: now.statements - at.statements, roundTrips: now.roundTrips - at.roundTrips };
    };
    try {
      for (const s of ["r-1", "r-2"]) { await whoami(x, p, s); watched.add(idOf(p, s)); }
      await x.hosted.reconcile();
      const two = await measured();
      for (const s of ["r-3", "r-4", "r-5", "r-6"]) { await whoami(x, p, s); watched.add(idOf(p, s)); }
      await x.hosted.reconcile();
      expect(await measured()).toEqual(two);
      expect(two).toEqual({ bodies: 1, statements: 6, roundTrips: 6 });
    } finally { unwatch(); }
  });

  // #1572: each watcher gets its own IDs' rows, as the per-ID reads gave them: a live row, undefined for an ended
  // session and for an ID that never had a row, an ID two watchers share in both, and nothing for a watcher with none.
  // Mutations: the fan-out handing every watcher every row read (a watcher sees IDs it doesn't watch); found.get
  // dropped for a lookup that skips missing IDs (the ended and never-seen IDs vanish from the map).
  test("a full reconcile hands each watcher its own rows: live, ended, missing, shared (#1572)", async () => {
    await using db = await pgDatabase({ max: 2 });
    await using x = await gateInstance(db.url, { oauth: true });
    const { p } = await issued(x);
    for (const s of ["w-a", "w-b", "w-c"]) await whoami(x, p, s);
    const [a, b, c] = ["w-a", "w-b", "w-c"].map(s => idOf(p, s)) as [string, string, string];
    await x.hosted.release(b, "closed");
    const seen = new Map<string, Map<string, string | undefined>[]>();
    const watcher = (name: string, ids: string[]) => x.hosted.watchRows({
      ids: () => ids,
      apply(rows) { seen.set(name, [...seen.get(name) ?? [], new Map([...rows].map(([id, row]) => [id, row?.session_id]))]); },
    });
    const off = [watcher("one", [a, b, "never-a-session"]), watcher("two", [b, c, a]), watcher("none", [])];
    try {
      await x.hosted.reconcile();
      expect(Object.fromEntries(seen)).toEqual({
        one: [new Map([[a, a], [b, undefined], ["never-a-session", undefined]])],
        two: [new Map([[b, undefined], [c, c], [a, a]])],
        none: [new Map()],
      });
    } finally { for (const f of off) f(); }
  });
});
