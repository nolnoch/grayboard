// Two-store races on Postgres in T-P12's shape (src/server/store/pg/tx.pg.test.ts; #807 P3, postgres-server.md D9):
// two transaction stores on one test database, store A's body runs to a gate and holds its transaction open, store B's
// body starts, and the race waits until B is either blocked on a lock (pg_stat_activity) or settled, then releases A.
// A test asserts the end state first and `waited` after, so a race whose lock is gone fails on what it broke, and a
// passing race can't be a serial run. Every pair labels its B side gb-test-b, so the lock-wait poll reads only the
// pair's own database: another file's (or lane's) blocked B in the same cluster must not release A early.
import { expect } from "bun:test";
import type { Tx } from "../../src/server/store/tx_base.ts";
import { makePgTransactions, type PgTransactions } from "../../src/server/store/pg/tx.ts";
import { pgDatabase, type PgDatabase } from "./pg.ts";
import { until } from "./until.ts";

export type PgPair = { db: PgDatabase; a: PgTransactions; b: PgTransactions; [Symbol.asyncDispose](): Promise<void> };

// A fresh database with two stores on it, labelled gb-test-a and gb-test-b in pg_stat_activity.
export async function pgPair(): Promise<PgPair> {
  const db = await pgDatabase({ max: 2 });
  const a = makePgTransactions(db.url, { max: 2, applicationName: "gb-test-a" });
  const b = makePgTransactions(db.url, { max: 2, applicationName: "gb-test-b" });
  return { db, a, b, async [Symbol.asyncDispose]() { await a.close(); await b.close(); await db[Symbol.asyncDispose](); } };
}

export function gate(): { wait: Promise<void>; open(): void } {
  let open!: () => void;
  const wait = new Promise<void>(r => { open = r; });
  return { wait, open };
}

export type Settled<T> = { ok: true; value: T } | { ok: false; error: any };
export const settle = <T>(p: Promise<T>): Promise<Settled<T>> => p.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));

// A settled call's value, or "threw <its error's class>: <message>".
export const outcome = (s: Settled<unknown>) => s.ok ? s.value : `threw ${s.error?.constructor?.name}: ${s.error?.message}`;

// How long a race waits for B to block or settle. Below bun's 5 s per-test default, so a lost lock wait fails on
// this message rather than on bun's bare timeout.
export const BLOCK_WAIT_MS = 3000;

// Polls until store B is blocked on a lock in this pair's database, or `settled()` says B finished. Returns the lock's
// kind (`transactionid`, `advisory`, `tuple`…), or null when B settled without being seen blocked.
export async function blockedOrSettled(p: PgPair, settled: () => boolean, what = "B blocked on a lock, or settled"): Promise<string | null> {
  let waitEvent: string | null = null;
  await until(async () => {
    const [w] = await p.db.sql`SELECT wait_event FROM pg_stat_activity
      WHERE datname = ${p.db.name} AND application_name = 'gb-test-b' AND wait_event_type = 'Lock'`;
    if (w) waitEvent = w.wait_event as string;
    return waitEvent !== null || settled();
  }, BLOCK_WAIT_MS, what);
  return waitEvent;
}

// `first` runs on store A and holds its transaction open after its body; `second` runs on store B. `waited`: B was
// seen blocked on a lock while A held, and `waitEvent` the lock's kind.
export async function race<TA, TB>(p: PgPair, first: (tx: Tx) => Promise<TA>, second: (tx: Tx) => Promise<TB>):
  Promise<{ a: Settled<TA>; b: Settled<TB>; waited: boolean; waitEvent: string | null }> {
  const held = gate(), release = gate();
  const a = settle(p.a.write(async tx => { const v = await first(tx); held.open(); await release.wait; return v; }));
  let b: Promise<Settled<TB>>, waitEvent: string | null;
  try {
    // A body that fails before holding settles A instead.
    await Promise.race([held.wait, a]);
    let done = false;
    b = settle(p.b.write(second)).finally(() => { done = true; });
    waitEvent = await blockedOrSettled(p, () => done);
  } finally {
    // Even when the poll times out: A's transaction must not stay open into the pair's dispose, which would wait on it
    // past bun's timeout and lose the poll's message.
    release.open();
  }
  return { a: await a, b: await b, waited: waitEvent !== null, waitEvent };
}

// The race's A side must have committed: its failure is the test's, not the race's.
export function committed<T>(s: Settled<T>): T {
  if (!s.ok) expect(outcome(s)).toBe("A committed");
  return (s as { value: T }).value;
}
