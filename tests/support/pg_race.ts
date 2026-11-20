// Two-store races on Postgres in T-P12's shape (src/server/store/pg/tx.pg.test.ts; #807 P3, postgres-server.md D9):
// two transaction stores on one test database, store A's body runs to a gate and holds its transaction open, store B's
// body starts, and the race waits until B is either blocked on a lock (pg_stat_activity) or settled, then releases A.
// A test asserts the end state first and `waited` after, so a race whose lock is gone fails on what it broke, and a
// passing race can't be a serial run. Every pair labels its B side gb-test-b, so the lock-wait poll reads only the
// pair's own database: another file's (or lane's) blocked B in the same cluster must not release A early.
import { expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Repo } from "../../src/server/db.ts";
import { makePgRepo } from "../../src/server/pg_repo.ts";
import type { Tx } from "../../src/server/store/tx_base.ts";
import { makePgTransactions, type PgTransactions } from "../../src/server/store/pg/tx.ts";
import { pgDatabase, type PgDatabase } from "./pg.ts";
import { until } from "./until.ts";

// `onDispose`: closes something opened on the pair's database (a Repo) before the stores and the drop, last first.
export type PgPair = { db: PgDatabase; a: PgTransactions; b: PgTransactions; onDispose(close: () => Promise<void>): void; [Symbol.asyncDispose](): Promise<void> };

// A fresh database with two stores on it, labelled gb-test-a and gb-test-b in pg_stat_activity.
export async function pgPair(): Promise<PgPair> {
  const db = await pgDatabase({ max: 2 });
  const a = makePgTransactions(db.url, { max: 2, applicationName: "gb-test-a" });
  const b = makePgTransactions(db.url, { max: 2, applicationName: "gb-test-b" });
  const closers: (() => Promise<void>)[] = [];
  return {
    db, a, b,
    onDispose(close) { closers.push(close); },
    async [Symbol.asyncDispose]() {
      for (const close of closers.splice(0).reverse()) await close();
      await a.close(); await b.close(); await db[Symbol.asyncDispose]();
    },
  };
}

// The pair's database as a Repo (pg_repo.ts makePgRepo, its own pool labelled gb-test-repo), closed with the pair. A
// race's bodies still run on the pair's stores, whose Tx each of the Repo's groups takes.
export async function pairRepo(p: PgPair, now: () => number = Date.now): Promise<Repo> {
  const blobDir = mkdtempSync(join(tmpdir(), "gb-pg-blobs-"));
  const repo = await makePgRepo(p.db.url, { blobDir, now, applicationName: "gb-test-repo", max: 2 });
  p.onDispose(async () => { await repo.close(); rmSync(blobDir, { recursive: true, force: true }); });
  return repo;
}

// Holds `group.method`: each call past the first `skip` waits for `open()` before it runs (`after`: runs, then waits
// before returning). `reached` settles when the first held call arrives. Restore with `undo()`.
export function holdCall<G extends object, K extends keyof G>(group: G, method: K, { skip = 0, after = false }: { skip?: number; after?: boolean } = {}) {
  const orig = group[method] as unknown as (...a: unknown[]) => Promise<unknown>;
  let calls = 0, opened = false;
  let open!: () => void, hit!: () => void;
  const released = new Promise<void>(r => { open = () => { opened = true; r(); }; });
  const reached = new Promise<void>(r => { hit = r; });
  const held = () => calls++ >= skip && !opened;
  (group as Record<K, unknown>)[method] = async (...a: unknown[]) => {
    if (after) {
      const out = await orig.apply(group, a);
      if (held()) { hit(); await released; }
      return out;
    }
    if (held()) { hit(); await released; }
    return orig.apply(group, a);
  };
  return { reached, open, undo() { (group as Record<K, unknown>)[method] = orig; } };
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

// Polls until store B (or `side`'s store) is blocked on a lock in this pair's database, or `settled()` says it finished.
// Returns the lock's kind (`transactionid`, `advisory`, `tuple`…), or null when it settled without being seen blocked.
export async function blockedOrSettled(p: Pick<PgPair, "db">, settled: () => boolean, what = "B blocked on a lock, or settled", side: "a" | "b" = "b"): Promise<string | null> {
  let waitEvent: string | null = null;
  await until(async () => {
    const [w] = await p.db.sql`SELECT wait_event FROM pg_stat_activity
      WHERE datname = ${p.db.name} AND application_name = ${`gb-test-${side}`} AND wait_event_type = 'Lock'`;
    if (w) waitEvent = w.wait_event as string;
    return waitEvent !== null || settled();
  }, BLOCK_WAIT_MS, what);
  return waitEvent;
}

// `first` runs on store A and holds its transaction open after its body; `second` runs on store B. `waited`: B was
// seen blocked on a lock while A held, and `waitEvent` the lock's kind. `whileHeld`: run once B is blocked or settled,
// before A is released (a third connection's look at what B holds while it waits); its result is `seen`. `then`: A's
// body goes on after its release, on the same transaction, with `first`'s value, and A's value is its result: for a
// write whose two halves straddle B (a gate read and its insert, a lock and the statement that deadlocks on B).
export type RaceOptions<TA, TS, TT> = { whileHeld?: () => Promise<TS>; then?: (tx: Tx, held: TA) => Promise<TT> };
export async function race<TA, TB, TS = undefined, TT = TA>(p: PgPair, first: (tx: Tx) => Promise<TA>, second: (tx: Tx) => Promise<TB>,
  opts?: (() => Promise<TS>) | RaceOptions<TA, TS, TT>):
  Promise<{ a: Settled<TT>; b: Settled<TB>; waited: boolean; waitEvent: string | null; seen?: TS }> {
  const { whileHeld, then } = typeof opts === "function" ? { whileHeld: opts, then: undefined } : (opts ?? {});
  const held = gate(), release = gate();
  const a = settle(p.a.write(async tx => {
    const v = await first(tx);
    held.open();
    await release.wait;
    return then ? then(tx, v) : (v as unknown as TT);
  }));
  let b: Promise<Settled<TB>>, waitEvent: string | null, seen: TS | undefined;
  try {
    // A body that fails before holding settles A instead.
    await Promise.race([held.wait, a]);
    let done = false;
    b = settle(p.b.write(second)).finally(() => { done = true; });
    waitEvent = await blockedOrSettled(p, () => done);
    if (whileHeld) seen = await whileHeld();
  } finally {
    // Even when the poll times out: A's transaction must not stay open into the pair's dispose, which would wait on it
    // past bun's timeout and lose the poll's message.
    release.open();
  }
  return { a: await a, b: await b, waited: waitEvent !== null, waitEvent, seen };
}

// race() with a server request as B (#807 P3 C11a): A, a store on the server's database (`a`, labelled anything but
// gb-test-b), holds its body open at the gate while `request` (a call into a pg_server.ts server whose pool is labelled
// gb-test-b) runs until it blocks on a lock or settles. A's body may run the server's own composed code over its Repo on
// A's Tx; the request goes through the server's queue and pool.
export async function raceRequest<TA, TB>(p: { db: PgDatabase; a: PgTransactions }, first: (tx: Tx) => Promise<TA>, request: () => Promise<TB>):
  Promise<{ a: Settled<TA>; b: Settled<TB>; waited: boolean; waitEvent: string | null }> {
  const held = gate(), release = gate();
  const a = settle(p.a.write(async tx => {
    const v = await first(tx);
    held.open();
    await release.wait;
    return v;
  }));
  let b: Promise<Settled<TB>>, waitEvent: string | null;
  try {
    await Promise.race([held.wait, a]);
    let done = false;
    b = settle(request()).finally(() => { done = true; });
    waitEvent = await blockedOrSettled(p, () => done);
  } finally {
    release.open();
  }
  return { a: await a, b: await b, waited: waitEvent !== null, waitEvent };
}

// The race's A side must have committed: its failure is the test's, not the race's.
export function committed<T>(s: Settled<T>): T {
  if (!s.ok) expect(outcome(s)).toBe("A committed");
  return (s as { value: T }).value;
}
