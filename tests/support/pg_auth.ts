// The Postgres auth generation for tests (#807 P3 C9b): a "pod" (a transaction store, its generation over a listener
// the test controls, and store/auth_cache.ts over both) on a test database, as C11 will compose them.
//
// The listener is the real one (store/pg/auth_generation.ts openPgListener) behind a wrapper that can:
// - swallow markers: a payload starting "test:" (its own markers, a probe listener's) never reaches the generation (it
//   would bump it). `marker(sql)` sends a fresh one through `sql` and returns a wait, with a deadline, that only that
//   marker's receipt ends. A listener receives notifications in commit order, so every notification committed before
//   the marker has been handled by then.
// - queue: while `queueing`, payloads (markers included) wait in `queued` until `deliver(k)` hands the first k on in
//   order (the harness's own test steps delivery).
// - go deaf: while `deaf`, other notifications are dropped too (a lost notification, or a test that must see only the
//   write path's own bump).
// - hold onlisten: while `holdingListen`, an acknowledged LISTEN's callback waits for `releaseListen()`.
// - count closes and acknowledged LISTENs, and run `onClosed` right after the generation's own onclose.
import type { SQL } from "bun";
import { makeAuthCache, type AuthCache } from "../../src/server/store/auth_cache.ts";
import { AUTH_CHANNEL, makePgAuthGeneration, openPgListener, type OpenListener, type PgAuthGeneration } from "../../src/server/store/pg/auth_generation.ts";
import { makePgCursors } from "../../src/server/store/pg/cursors.ts";
import { makePgIdentity, type PgIdentity } from "../../src/server/store/pg/identity.ts";
import { makePgOAuth } from "../../src/server/store/pg/oauth.ts";
import { makePgTransactions, pgOf, type PgTransactions } from "../../src/server/store/pg/tx.ts";
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

export type TestListener = {
  openListener: OpenListener;
  deaf: boolean;
  holdingListen: boolean;
  releaseListen(): void;
  // An acknowledged LISTEN is waiting for releaseListen().
  readonly heldListen: boolean;
  readonly closes: number;
  readonly listens: number;
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
  let forward: (p: string) => void = () => {};
  const queued: string[] = [];
  const handle = (p: string) => {
    if (p.startsWith("test:")) { waiting.get(p)?.(); return; }
    if (!l.deaf) forward(p);
  };
  let closes = 0, listens = 0;
  const l: TestListener = {
    deaf: false,
    holdingListen: false,
    get heldListen() { return held !== undefined; },
    get closes() { return closes; },
    get listens() { return listens; },
    releaseListen() { const h = held; held = undefined; h?.(); },
    queueing: false,
    queued,
    deliver(k = queued.length) { for (const p of queued.splice(0, k)) handle(p); },
    openListener: onclose => {
      const inst = real(error => { closes++; onclose(error); l.onClosed?.(); });
      return {
        listen: ((channel: string, onnotify: (p: string) => void, onlisten?: () => void) => (forward = onnotify, inst.listen(channel,
          p => { if (l.queueing) queued.push(p); else handle(p); },
          () => {
            const go = () => { listens++; onlisten?.(); };
            if (l.holdingListen) held = go; else go();
          }))) as SQL["listen"],
        close: inst.close.bind(inst),
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

export type PgAuthPod = {
  name: string;
  tx: PgTransactions;
  gen: PgAuthGeneration;
  listener: TestListener;
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
export async function pgAuthPod(db: PgDatabase, name = "a", { txUrl = db.url }: { txUrl?: string } = {}): Promise<PgAuthPod> {
  const app = `gb-test-listen-${name}`;
  const listener = testListener(db.url, app);
  let gen!: PgAuthGeneration;
  const tx = makePgTransactions(txUrl, { max: 4, applicationName: `gb-test-${name}`, ownAuthCommit: () => gen.ownCommit() });
  gen = makePgAuthGeneration({ url: db.url, transactions: tx, openListener: listener.openListener });
  const hosted = hostedRecorder().port;
  const oauth = makePgOAuth({ hosted }), identity = makePgIdentity({ now: Date.now, hosted });
  const counts = { users: 0, accesses: 0 };
  const pod: PgAuthPod = {
    name, tx, gen, listener, oauth, identity, counts, cursors: makePgCursors(),
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
  pod.auth = makeAuthCache(gen, {
    findActiveAccess: (...a) => { counts.accesses++; return oauth.findActiveAccess(...a); },
    async userById(r, id) {
      counts.users++;
      const u = await identity.users.findById(r, id);
      await pod.afterUserRead?.();
      return u;
    },
    check: r => { pgOf(r); },
  });
  await gen.start();
  if (gen.read() === undefined) throw new Error(`pod ${name}: the auth cache is off after start()`);
  return pod;
}
