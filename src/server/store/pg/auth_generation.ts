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
// Not yet (C9b2): the heartbeat that turns the cache off when a silently dead connection stops delivering, retrying a
// first LISTEN that failed (Bun retries only after a connection it had; until then the cache stays off), and tying
// callbacks to the instance they came from once a heartbeat can replace it. `openListener` is their seam too.
import { SQL } from "bun";
import { errorDiagnostic } from "../../diagnostics.ts";
import type { AuthGenerationSource } from "../auth_cache.ts";
import type { PgTransactions } from "./tx.ts";

export const AUTH_CHANNEL = "gb_auth";

// The part of a Bun.SQL instance the source uses, in Bun's shapes, so a test can stand in for it.
export type PgListener = Pick<SQL, "listen" | "close">;
// Opens a listener instance; `onclose` runs whenever its connection closes.
export type OpenListener = (onclose: (error: Error | null) => void) => PgListener;

// The production listener: one connection, labelled in pg_stat_activity.
export function openPgListener(url: string, applicationName = "grayboard-auth-listen"): OpenListener {
  return onclose => new SQL({ url, max: 1, connection: { application_name: applicationName }, onclose });
}

export type PgAuthGeneration = AuthGenerationSource & {
  // The write path's bump (makePgTransactions' ownAuthCommit).
  ownCommit(): void;
  // Opens the listener and resolves once its first LISTEN is acknowledged (the cache on) or refused (the cache off,
  // logged). Call after migrate, before serving.
  start(): Promise<void>;
  close(): Promise<void>;
};

export function makePgAuthGeneration({ url, transactions, openListener = openPgListener(url) }: {
  url: string;
  transactions: Pick<PgTransactions, "inTransaction" | "queue">;
  openListener?: OpenListener;
}): PgAuthGeneration {
  let n = 0, on = false, closed = false;
  let inst: PgListener | undefined;
  const onclose = (error: Error | null) => {
    // Logged once per off period.
    if (on) console.error("[grayboard] auth LISTEN connection closed; the auth cache is off until it listens again:", error && errorDiagnostic(error));
    on = false;
    n++;
  };
  const onNotify = () => { n++; };
  const onListen = () => {
    if (closed) return;
    n++;
    on = true;
  };
  return {
    read: () => on ? String(n) : undefined,
    // Its task holds the store's open transaction: the pool can't see what the body wrote.
    ownsTx: () => transactions.inTransaction() && transactions.queue.mine,
    // An outside write's notification can be in flight, so equal generations don't mean no auth commit between them.
    commit: () => undefined,
    ownCommit() { n++; },
    async start() {
      if (closed || inst) throw new Error("auth generation already started");
      const i = inst = openListener(onclose);
      try {
        await i.listen(AUTH_CHANNEL, onNotify, onListen);
      } catch (error) {
        console.error("[grayboard] auth LISTEN failed; the auth cache stays off:", errorDiagnostic(error));
        inst = undefined;
        await i.close({ timeout: 0 }).catch(() => {});
      }
    },
    async close() {
      closed = true;
      on = false;
      const i = inst;
      inst = undefined;
      await i?.close();
    },
  };
}
