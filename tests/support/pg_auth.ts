// The Postgres auth generation for tests (#807 P3 C9b): a "pod" (a transaction store, its generation over a listener
// the test controls, and store/auth_cache.ts over both) on a test database, composed as pg_repo.ts makePgRepo composes them.
//
// The listener is the real one (store/pg/auth_generation.ts openPgListener) behind a wrapper that can:
// - swallow markers: a payload starting "test:" (its own markers, a probe listener's) never reaches the generation (it
//   would bump it). `marker(sql)` sends a fresh one through `sql` and returns a wait, with a deadline, that only that
//   marker's receipt ends. A listener receives notifications in commit order, so every notification committed before
//   the marker has been handled by then.
// - queue: while `queueing`, payloads (markers included) wait in `queued` until `deliver(k)` hands the first k on in
//   order (the harness's own test steps delivery).
// - go deaf: while `deaf` (every instance) or an instance's own `deaf`, other notifications, heartbeats included, are
//   dropped (a lost notification, a silently dead connection, or a test that must see only the write path's bump).
//   An instance's `drop`, when set, drops only the payloads it matches (one ping lost, others delivered).
// - hold onlisten: while `holdingListen`, an acknowledged LISTEN's callback waits for `releaseListen()`.
// - refuse or hang LISTENs: the next `failListens` listen() calls reject at once (Bun's first-LISTEN failure), the next
//   `hangListens` stay pending until their instance is closed, which rejects them (as Bun does: "Connection closed").
//   While `holdingHung`, that rejection waits for `releaseHung()` instead, so a test can land it later.
// - keep each instance it opened (`instances`) with the callbacks the generation gave it, so a test can call an old
//   instance's callbacks after it was replaced; count closes, acknowledged LISTENs and heartbeats handed on, and run
//   `onClosed` right after the generation's own onclose.
//
// A pod's heartbeat and retry run on manual timers by default (`manualTimers`), so no heartbeat fires unless a test
// ticks it. A pod's `holdSends` holds the heartbeat's sends until `failHeldSends()` rejects them.
import type { SQL } from "bun";
import type { AuthCache } from "../../src/server/store/auth_cache.ts";
import { AUTH_CHANNEL, HEARTBEAT_PREFIX, makePgAuthCache, makePgAuthGeneration, openPgListener, realTimers, type AuthTimers, type OpenListener, type PgAuthGeneration } from "../../src/server/store/pg/auth_generation.ts";
import { makePgCursors } from "../../src/server/store/pg/cursors.ts";
import { makePgIdentity, type PgIdentity } from "../../src/server/store/pg/identity.ts";
import { makePgOAuth } from "../../src/server/store/pg/oauth.ts";
import { makePgTransactions, type PgTransactions } from "../../src/server/store/pg/tx.ts";
import type { OAuthStore } from "../../src/server/oauth-types.ts";
import type { PgDatabase } from "./pg.ts";
import { hostedRecorder } from "./pg_hosted.ts";
import { until } from "./until.ts";

const MARKER = "test:marker:";
let markers = 0;

// Rejects with `what` when `p` hasn't settled within `ms`, so a lost wait fails readably, below bun's 5 s test timeout.
export function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms waiting for: ${what}`)), ms); });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

// One listener instance the generation opened, with the callbacks it gave.
export type ListenerInstance = {
  readonly index: number;
  deaf: boolean;
  // Drops the payloads it matches (after markers are swallowed), as `deaf` drops all.
  drop?: (payload: string) => boolean;
  // close() was called on it.
  readonly closed: boolean;
  readonly onclose: (error: Error | null) => void;
  readonly onnotify?: (payload: string) => void;
  readonly onlisten?: () => void;
};

export type TestListener = {
  openListener: OpenListener;
  deaf: boolean;
  holdingListen: boolean;
  releaseListen(): void;
  // An acknowledged LISTEN is waiting for releaseListen().
  readonly heldListen: boolean;
  readonly closes: number;
  readonly listens: number;
  // Heartbeat payloads handed on to the generation.
  readonly heartbeats: number;
  readonly instances: readonly ListenerInstance[];
  failListens: number;
  hangListens: number;
  holdingHung: boolean;
  // Rejects the held hung LISTENs, then waits out the microtasks their handlers run in.
  releaseHung(): Promise<void>;
  onClosed?: () => void;
  queueing: boolean;
  readonly queued: readonly string[];
  // Hands on the first k queued payloads (all by default), in order.
  deliver(k?: number): void;
  // Notifies a fresh marker through `sql` (committed when it resolves) and returns a wait for its receipt.
  marker(sql: Pick<SQL, "notify">): Promise<(what: string, ms?: number) => Promise<void>>;
};

export function testListener(url: string, applicationName: string): TestListener {
  const real = openPgListener(url, applicationName);
  const waiting = new Map<string, () => void>();
  let held: (() => void) | undefined;
  const heldHung: (() => void)[] = [];
  const queued: string[] = [], queuedFor: Inst[] = [];
  type Inst = ListenerInstance & { closed: boolean; onnotify?: (p: string) => void; onlisten?: () => void; hung?: () => void };
  const instances: Inst[] = [];
  const handle = (rec: Inst, p: string) => {
    if (p.startsWith("test:")) { waiting.get(p)?.(); return; }
    if (l.deaf || rec.deaf || rec.drop?.(p)) return;
    if (p.startsWith(HEARTBEAT_PREFIX)) heartbeats++;
    rec.onnotify?.(p);
  };
  let closes = 0, listens = 0, heartbeats = 0;
  const l: TestListener = {
    deaf: false,
    holdingListen: false,
    failListens: 0,
    hangListens: 0,
    holdingHung: false,
    async releaseHung() {
      for (const h of heldHung.splice(0)) h();
      // setImmediate runs after every pending microtask: the generation's rejection handlers have run by then.
      await new Promise(r => setImmediate(r));
    },
    get heldListen() { return held !== undefined; },
    get closes() { return closes; },
    get listens() { return listens; },
    get heartbeats() { return heartbeats; },
    instances,
    releaseListen() { const h = held; held = undefined; h?.(); },
    queueing: false,
    queued,
    deliver(k = queued.length) {
      const ps = queued.splice(0, k), rs = queuedFor.splice(0, k);
      ps.forEach((p, j) => handle(rs[j]!, p));
    },
    openListener: onclose => {
      const inst = real(error => { closes++; onclose(error); l.onClosed?.(); });
      const rec: Inst = { index: instances.length, deaf: false, closed: false, onclose };
      instances.push(rec);
      return {
        listen: ((channel: string, onnotify: (p: string) => void, onlisten?: () => void) => {
          rec.onnotify = onnotify;
          rec.onlisten = onlisten;
          if (l.failListens > 0) { l.failListens--; return Promise.reject(new Error("test: LISTEN refused")); }
          if (l.hangListens > 0) {
            l.hangListens--;
            return new Promise((_, reject) => { rec.hung = () => reject(new Error("test: Connection closed")); });
          }
          return inst.listen(channel,
            p => { if (l.queueing) { queued.push(p); queuedFor.push(rec); } else handle(rec, p); },
            () => {
              const go = () => { listens++; onlisten?.(); };
              if (l.holdingListen) held = go; else go();
            });
        }) as SQL["listen"],
        close: (options?: { timeout?: number }) => {
          rec.closed = true;
          const h = rec.hung;
          rec.hung = undefined;
          if (h) { if (l.holdingHung) heldHung.push(h); else h(); }
          return inst.close(options);
        },
      };
    },
    async marker(sql) {
      const m = `${MARKER}${process.pid}:${++markers}`;
      const got = new Promise<void>(resolve => waiting.set(m, resolve));
      await sql.notify(AUTH_CHANNEL, m);
      return (what, ms = 2000) => within(got, ms, `${what} (marker ${m} received by ${applicationName})`).finally(() => waiting.delete(m));
    },
  };
  return l;
}

// Timers a test drives: `tick()` runs the heartbeat, `fire()` the pending retries. `delays` lists every retry delay
// asked for, in order.
export type ManualTimers = AuthTimers & {
  tick(): void;
  fire(): number;
  readonly intervals: number;
  readonly pending: number;
  readonly delays: readonly number[];
};

export function manualTimers(): ManualTimers {
  const every = new Set<() => void>(), after = new Set<() => void>();
  const delays: number[] = [];
  return {
    every(_ms, fn) { const f = () => fn(); every.add(f); return () => { every.delete(f); }; },
    after(ms, fn) { delays.push(ms); const f = () => fn(); after.add(f); return () => { after.delete(f); }; },
    tick() { for (const f of [...every]) f(); },
    fire() { const fs = [...after]; after.clear(); for (const f of fs) f(); return fs.length; },
    get intervals() { return every.size; },
    get pending() { return after.size; },
    delays,
  };
}

export type PgAuthPod = {
  name: string;
  tx: PgTransactions;
  gen: PgAuthGeneration;
  listener: TestListener;
  // The generation's timers when manual (the default); undefined on real ones.
  timers: ManualTimers | undefined;
  // While set, the heartbeat's send through the pool rejects (the pool can't reach the database).
  notifyFails: boolean;
  // Every heartbeat payload the generation sent (or tried to), and a promise that settles when the last send does.
  sent: string[];
  lastSend: Promise<unknown> | undefined;
  // While set, the heartbeat's sends wait until failHeldSends() rejects them.
  holdSends: boolean;
  failHeldSends(): void;
  auth: AuthCache;
  oauth: OAuthStore;
  identity: PgIdentity;
  cursors: ReturnType<typeof makePgCursors>;
  // The uncached reads under the caches, counted.
  counts: { users: number; accesses: number };
  // Awaited inside the user cache's read, after the row is read and before the fill check.
  afterUserRead?: () => Promise<void>;
  // Resolves once every notification for writes committed before the call has reached this pod.
  settle(): Promise<void>;
  // The pod's listener backend's pid.
  listenerPid(): Promise<number>;
  close(): Promise<void>;
};

// A pod on `db`, its listener started (LISTEN acknowledged): its store labelled gb-test-<name>, its listener
// gb-test-listen-<name>. `txUrl`: where the store connects instead of db.url (a proxy); the listener connects directly.
// `timers`: "real" for the default ones (else manual). `allowOff`: start() may leave the cache off (a refused LISTEN).
// `prepare` runs on the listener before start().
export async function pgAuthPod(db: PgDatabase, name = "a", { txUrl = db.url, timers = "manual", heartbeatMs, startTimeoutMs, allowOff = false, prepare }: {
  txUrl?: string; timers?: "manual" | "real"; heartbeatMs?: number; startTimeoutMs?: number; allowOff?: boolean; prepare?: (l: TestListener) => void;
} = {}): Promise<PgAuthPod> {
  const app = `gb-test-listen-${name}`;
  const listener = testListener(db.url, app);
  prepare?.(listener);
  const manual = timers === "manual" ? manualTimers() : undefined;
  let gen!: PgAuthGeneration;
  const tx = makePgTransactions(txUrl, { max: 4, applicationName: `gb-test-${name}`, ownAuthCommit: () => gen.ownCommit() });
  const sent: string[] = [];
  const heldSends: ((error: Error) => void)[] = [];
  const transactions = {
    inTransaction: () => tx.inTransaction(),
    get queue() { return tx.queue; },
    notify(channel: string, payload: string) {
      sent.push(payload);
      const p = pod.notifyFails ? Promise.reject(new Error("test: notify refused"))
        : pod.holdSends ? new Promise<never>((_, reject) => { heldSends.push(reject); })
        : tx.notify(channel, payload);
      pod.lastSend = p.catch(() => {});
      return p;
    },
  };
  gen = makePgAuthGeneration({ url: db.url, transactions, openListener: listener.openListener, timers: manual ?? realTimers, heartbeatMs, startTimeoutMs });
  const hosted = hostedRecorder().port;
  const oauth = makePgOAuth({ hosted }), identity = makePgIdentity({ now: Date.now, hosted });
  const counts = { users: 0, accesses: 0 };
  const pod: PgAuthPod = {
    name, tx, gen, listener, oauth, identity, counts, cursors: makePgCursors(),
    timers: manual, notifyFails: false, sent, lastSend: undefined, holdSends: false,
    failHeldSends() { for (const r of heldSends.splice(0)) r(new Error("test: notify refused")); },
    auth: undefined as unknown as AuthCache,
    async settle() { await (await listener.marker(db.sql))(`pod ${name} to settle`); },
    async listenerPid() {
      const [row] = await until(async () => {
        const rows = await db.sql`SELECT pid FROM pg_stat_activity WHERE datname = ${db.name} AND application_name = ${app}`;
        return rows.length === 1 ? rows : undefined;
      }, 2000, `pod ${name}'s one listener backend in pg_stat_activity`);
      return row.pid as number;
    },
    async close() { await gen.close(); await tx.close(); },
  };
  // The production composition (pg/auth_generation.ts makePgAuthCache, as pg_repo.ts makePgRepo calls it), over counting
  // wrappers of the same uncached reads.
  pod.auth = makePgAuthCache(gen, {
    findActiveAccess: (...a) => { counts.accesses++; return oauth.findActiveAccess(...a); },
  }, {
    async findById(r, id) {
      counts.users++;
      const u = await identity.users.findById(r, id);
      await pod.afterUserRead?.();
      return u;
    },
  });
  await gen.start();
  if (!allowOff && gen.read() === undefined) {
    await pod.close();
    throw new Error(`pod ${name}: the auth cache is off after start()`);
  }
  return pod;
}
