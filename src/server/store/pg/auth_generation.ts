// The Postgres auth generation (#807 P3 C9b; docs/future/postgres-server.md D5): the source store/auth_cache.ts keys its
// caches on. An in-process counter `n` that only ever grows, so a value seen before an off period never comes back:
// - this process's own auth commits bump it through `ownCommit`, which store/pg/tx.ts calls after COMMIT and before the
//   queue's next body (the gb.auth_touched mark 0001's triggers set);
// - every process's auth commits bump it again when their `NOTIFY gb_auth` arrives on this process's LISTEN, which is
//   how an outside write (another pod, psql, a seeding script) reaches the caches;
// - while that LISTEN isn't acknowledged the generation is undefined, so nothing is cached or answered from a cache: a
//   notification lost while it was down can't leave a revoked token cached. Each acknowledged LISTEN bumps, then turns
//   the cache on.
//
// The LISTEN has a Bun.SQL instance of its own that runs nothing else: Bun reports a dropped listen connection only
// through the instance's `onclose`, which fires for every connection of the instance, so on a shared pool an idle read
// connection's close would read as a lost LISTEN. Bun reconnects and re-listens by itself (onclose, then onlisten).
//
// Two drops Bun doesn't handle (c9-scope §2.3-2.4):
// - A silently dead connection (a NAT or security-group idle drop, a hung backend) gives no event at all. Every
//   `heartbeatMs` the source sends `hb:<nonce>:<seq>` through the store's pool; a listener receives notifications in
//   commit order, so a ping that arrived proves every notification committed before it did. If the last ping hasn't
//   arrived by the next tick, or its send failed, the cache turns off and the instance is closed and replaced (each
//   callback acts only while its instance is the current one, so the old one's change nothing). A silent drop is
//   therefore bounded at 2 x heartbeatMs. `hb:` payloads, other pods' included, never bump.
// - A first LISTEN that fails is never retried by Bun (it retries only after a connection it had). The source retries
//   it at 1 s doubling to 30 s, with the cache off meanwhile; an attempt still unanswered after a full heartbeat
//   interval counts as failed. `start()` waits at most `startTimeoutMs` for the first.
// - A drop Bun reports (onclose) whose re-LISTEN never completes would leave the cache off for good: no heartbeat is
//   sent while off. The ticks go on counting, and a re-LISTEN still unacknowledged after a full heartbeat interval
//   counts as a failed attempt: the instance is closed and a new one opened on the same backoff (#1354).
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { errorDiagnostic } from "../../diagnostics.ts";
import { makeAuthCache, type AuthCache, type AuthGenerationSource } from "../auth_cache.ts";
import type { OAuthStore } from "../../oauth-types.ts";
import type { UsersStore } from "../identity.ts";
import { pgOf, type PgTransactions } from "./tx.ts";

export const AUTH_CHANNEL = "gb_auth";
export const HEARTBEAT_PREFIX = "hb:";
export const RETRY_FIRST_MS = 1000, RETRY_MAX_MS = 30_000;

// The part of a Bun.SQL instance the source uses, in Bun's shapes, so a test can stand in for it.
export type PgListener = Pick<SQL, "listen" | "close">;
// Opens a listener instance; `onclose` runs whenever its connection closes.
export type OpenListener = (onclose: (error: Error | null) => void) => PgListener;

// The source's clocks: the heartbeat's interval and the retry's delay, each returning its cancel. A test drives them
// by hand; the real ones don't keep the process alive.
export type AuthTimers = {
  every(ms: number, fn: () => void): () => void;
  after(ms: number, fn: () => void): () => void;
};
export const realTimers: AuthTimers = {
  every(ms, fn) { const t = setInterval(fn, ms); t.unref(); return () => clearInterval(t); },
  after(ms, fn) { const t = setTimeout(fn, ms); t.unref(); return () => clearTimeout(t); },
};

// The production listener: one connection, labelled in pg_stat_activity.
export function openPgListener(url: string, applicationName = "grayboard-auth-listen"): OpenListener {
  return onclose => new SQL({ url, max: 1, connection: { application_name: applicationName }, onclose });
}

export type PgAuthGeneration = AuthGenerationSource & {
  // The write path's bump (makePgTransactions' ownAuthCommit).
  ownCommit(): void;
  // Opens the listener and starts the heartbeat. Resolves once the first LISTEN is acknowledged (the cache on), has
  // failed (the cache off, logged, retried), or after startTimeoutMs (the attempt carries on). Call after migrate,
  // before serving.
  start(): Promise<void>;
  // Stops the heartbeat and any retry, turns the cache off and closes the listener.
  close(): Promise<void>;
};

export function makePgAuthGeneration({ url, transactions, heartbeatMs = 5000, startTimeoutMs = 2000, openListener = openPgListener(url), timers = realTimers }: {
  url: string;
  // `notify` sends the heartbeat through the store's pool (read-only is fine: pg_notify isn't a write).
  transactions: Pick<PgTransactions, "inTransaction" | "queue" | "notify">;
  heartbeatMs?: number;
  startTimeoutMs?: number;
  openListener?: OpenListener;
  timers?: AuthTimers;
}): PgAuthGeneration {
  let n = 0, on = false, closed = false, started = false;
  // The current instance: a callback from any other is stale and changes nothing.
  let inst: PgListener | undefined;
  // The current instance's first LISTEN while unanswered, and the ticks it has waited.
  let attempt: { i: PgListener; ticks: number } | undefined;
  // The current instance after Bun reported its connection closed, until its re-LISTEN is acknowledged, and the ticks
  // it has waited.
  let dropped: { i: PgListener; ticks: number } | undefined;
  // The outstanding heartbeat token: sent, not yet received.
  let hb: string | undefined;
  let seq = 0;
  const nonce = randomUUID();
  let retryMs = RETRY_FIRST_MS;
  let cancelRetry: (() => void) | undefined, stopHeartbeat: (() => void) | undefined;
  // Logged once per off period, and once per run of failed attempts.
  let offLogged = false, failLogged = false;

  const off = (why: string, error?: unknown) => {
    if (!offLogged) {
      offLogged = true;
      console.error(`[grayboard] auth LISTEN ${why}; the auth cache is off until it listens again`, ...(error ? [errorDiagnostic(error)] : []));
    }
    on = false;
    hb = undefined;
    n++;
  };

  // A new instance and its LISTEN. Resolves when that attempt is acknowledged or has failed.
  function open(): Promise<void> {
    cancelRetry?.();
    cancelRetry = undefined;
    const i: PgListener = openListener(error => {
      if (i !== inst || closed) return;
      off("connection closed", error);
      if (dropped?.i !== i) dropped = { i, ticks: 0 };
    });
    inst = i;
    attempt = { i, ticks: 0 };
    return i.listen(AUTH_CHANNEL, p => {
      if (i !== inst || closed) return;
      if (p.startsWith(HEARTBEAT_PREFIX)) { if (p === hb) hb = undefined; return; }
      n++;
    }, () => {
      if (i !== inst || closed) return;
      dropped = undefined;
      n++;
      on = true;
      offLogged = failLogged = false;
      retryMs = RETRY_FIRST_MS;
    }).then(() => { if (attempt?.i === i) attempt = undefined; }, error => failed(i, error));
  }

  // The attempt on `i` failed: drop it and retry after the backoff.
  function failed(i: PgListener, error: unknown) {
    if (i !== inst || closed) return;
    if (!failLogged) {
      failLogged = true;
      console.error("[grayboard] auth LISTEN failed; the auth cache stays off and the LISTEN is retried:", errorDiagnostic(error));
    }
    on = false;
    hb = inst = attempt = undefined;
    i.close({ timeout: 0 }).catch(() => {});
    const ms = retryMs;
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
    cancelRetry = timers.after(ms, () => { cancelRetry = undefined; if (!closed && !inst) void open(); });
  }

  // Closes a silent or unreachable instance and opens another.
  function replace(why: string, error?: unknown) {
    off(why, error);
    const i = inst;
    inst = attempt = undefined;
    i?.close({ timeout: 0 }).catch(() => {});
    void open();
  }

  function tick() {
    if (closed) return;
    if (attempt && ++attempt.ticks >= 2) failed(attempt.i, new Error(`LISTEN not acknowledged within ${heartbeatMs} ms`));
    if (dropped && dropped.i !== inst) dropped = undefined;
    if (dropped && ++dropped.ticks >= 2) failed(dropped.i, new Error(`re-LISTEN after a dropped connection not acknowledged within ${heartbeatMs} ms`));
    if (hb !== undefined) replace("heartbeat never arrived");
    if (!on) return;
    const token = hb = `${HEARTBEAT_PREFIX}${nonce}:${++seq}`;
    transactions.notify(AUTH_CHANNEL, token).catch(error => { if (hb === token && !closed) replace("heartbeat send failed", error); });
  }

  return {
    read: () => on ? String(n) : undefined,
    // Its task holds the store's open transaction: the pool can't see what the body wrote.
    ownsTx: () => transactions.inTransaction() && transactions.queue.mine,
    // An outside write's notification can be in flight, so equal generations don't mean no auth commit between them.
    commit: () => undefined,
    ownCommit() { n++; },
    async start() {
      if (closed || started) throw new Error("auth generation already started");
      started = true;
      stopHeartbeat = timers.every(heartbeatMs, tick);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<void>(resolve => { timer = setTimeout(resolve, startTimeoutMs); timer.unref(); });
      try { await Promise.race([open(), late]); } finally { clearTimeout(timer); }
    },
    async close() {
      closed = true;
      on = false;
      hb = attempt = undefined;
      stopHeartbeat?.();
      cancelRetry?.();
      stopHeartbeat = cancelRetry = undefined;
      const i = inst;
      inst = undefined;
      await i?.close({ timeout: 0 });
    },
  };
}

// The Postgres auth cache (#807 P3 C11a): store/auth_cache.ts over this generation and the stores' uncached reads, as
// pg_repo.ts makePgRepo composes it (and tests/support/pg_auth.ts's pods, over counting wrappers of the same reads).
// `pgOf` resolves the handle, so a kept Tx is refused on a cache hit too.
export function makePgAuthCache(gen: AuthGenerationSource, oauth: Pick<OAuthStore, "findActiveAccess">, users: Pick<UsersStore, "findById">): AuthCache {
  return makeAuthCache(gen, {
    findActiveAccess: (...a) => oauth.findActiveAccess(...a),
    userById: (r, id) => users.findById(r, id),
    check: r => { pgOf(r); },
  });
}
