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
  // The touch gate: a touch UPDATE in a keyed body (its transaction carries keys) waits on `hold` while it's set.
  // `defer`: while set, a hosted exclusive body (the timer's sweep or heartbeat) waits on it before it queues, so none
  // lands between two touches a test has released into the queue together.
  const state = { hold: undefined as Gate | undefined, defer: undefined as Gate | undefined, held: 0, entered: [] as string[] };
  const touch = store.touch.bind(store);
  store.touch = async (tx: Tx, id: string, t: number) => {
    const keyed = (tx as unknown as { txn?: { keys?: ReadonlySet<string> } }).txn?.keys !== undefined;
    if (keyed && state.hold) {
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
      // The other call's touch waits under the same key, beside the calls' close touches (application.ts close, keyed
      // by the same root).
      await until(() => x.state.held === 1 && x.q.waitingAt("touch") >= 1, 10_000, "one touch held, its root's other queued");
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
