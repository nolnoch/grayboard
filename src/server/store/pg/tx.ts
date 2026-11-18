// The Postgres store's transaction handles and write path (#807 P3 C2, docs/future/postgres-server.md D2, D4, D6): a
// `Read` is the pool, a `Tx` one transaction's connection, both over tx_base.ts's backend-neutral contract, and
// `write`/`post` run through the same write queue (store/queue.ts) as SQLite's. A store function takes a handle and
// runs its statements on `pgOf(handle)`, which sends each as it's built (PgSql).
//
// What differs from SQLite (tx.ts, db.ts `queued`/`posted`):
// - Every commit is async: no synchronous body exists, and `post` never runs now (it returns false). A post from the
//   queue's holder (its committed callback, its afterCommit flush) queues behind any body already waiting.
// - A Bun query is lazy: an `await` alone sends it a microtask later. pgOf's statements are sent as they're built, and
//   every one is awaited (to see its error).
// - Savepoints are raw SAVEPOINT/RELEASE/ROLLBACK TO with a frame stack per transaction, never Bun's
//   `tx.savepoint`: Bun releases an outer savepoint while an un-awaited inner one is open and then commits the inner
//   one's rows although its body threw. On Postgres the stack carries weight: RELEASE or ROLLBACK TO naming a
//   savepoint an enclosing statement already destroyed fails 3B001 and aborts the whole transaction, so a frame an
//   enclosing ROLLBACK TO or RELEASE ended (or its transaction's end) sends nothing.
// - Writer ownership (D4): the pool is read-only (default_transaction_read_only), each BEGIN says `read write`, a `Tx`
//   dies with its body, and pgOf's handle has no begin, reserve or savepoint. There is no shared writer connection to
//   guard per statement; SQL text that changes a pooled session's settings is caught only in review.
// - An error a body catches without a savepoint aborts the transaction; the failure surfaces later as 25P02 or a
//   rolled-back COMMIT, and the write rejects with TxAborted, which names the cause.
//
// Runtime imports stay off bun:sqlite (pg/isolation.test.ts): tx_base.ts, queue.ts and request_context.ts import
// nothing that reaches it.
import { SQL } from "bun";
import { errorDiagnostic } from "../../diagnostics.ts";
import { detached, inRequest, requestOrigin } from "../../request_context.ts";
import { queueFor, type WriteQueue } from "../queue.ts";
import { BaseRead, BaseTx, flushEffect, isThenable, type Read, type SavepointFrame, type Tx } from "../tx_base.ts";
import { pgFailure } from "./errors.ts";
import { openPg, type PgOptions } from "./sql.ts";

type Effect = () => void | Promise<void>;

// The store's state the handles share: its pool, its queue, and the root Tx of the transaction in progress.
type Store = { readonly sql: SQL; readonly queue: WriteQueue; open: PgTx | undefined };

// One transaction's savepoint bookkeeping: its connection, the open frames innermost last, and a counter for names.
// A frame missing from `stack` is dead: its transaction ended, or an enclosing ROLLBACK TO or RELEASE ended it.
type Txn = { readonly conn: SQL; readonly stack: object[]; n: number; ended: boolean };

const READ_REFUSAL = "repo.read inside the caller's own transaction: pass the body's Tx (#807 D2)";

// 25P02 or a rolled-back COMMIT: a statement failed inside the transaction (or a savepoint) and the body caught it
// without a savepoint, so the transaction was already aborted. The statement that failed is gone by then; this names
// the bug. `code` and `errno` are copied as own data properties for the diagnostics (diagnostics.ts reads no cause).
export class TxAborted extends Error {
  override readonly name = "TxAbortedError";
  readonly code: string;
  readonly errno: string | undefined;
  constructor(cause: InstanceType<typeof SQL.PostgresError>) {
    super("transaction aborted: a statement error was caught without a savepoint; wrap the statement that may fail in tx.savepoint (#807 D6)", { cause });
    this.code = cause.code;
    this.errno = cause.errno;
  }
  // The error to reject with: a TxAborted for an aborted transaction, anything else unchanged.
  static wrap(e: unknown): unknown {
    return pgFailure(e)?.kind === "aborted" ? new TxAborted(e as InstanceType<typeof SQL.PostgresError>) : e;
  }
}

class PgRead extends BaseRead {
  constructor(readonly store: Store) { super(); }
}

// Its effects wait in its own list: a savepoint's move to its parent once its RELEASE succeeded (settled), and the
// root's run after `begin` fulfils.
class PgTx extends BaseTx {
  readonly effects: Effect[] = [];
  constructor(readonly store: Store, readonly txn: Txn, root?: BaseTx) { super(true, root); }

  // SAVEPOINT is sent before this returns and fn starts (the base calls fn synchronously): statements fn issues
  // before its first await follow it in the connection's pipeline, as SQLite's do.
  protected openSavepoint(root: BaseTx): { frame: SavepointFrame; tx: BaseTx } {
    const txn = this.txn, { conn, stack } = txn;
    const name = `gb_sp_${++txn.n}`;
    const marker = {};
    const opened = conn.unsafe(`SAVEPOINT ${name}`).execute();
    // Awaited by commit() or rollback(); a failure also fails every statement after it, so nothing is lost here.
    opened.catch(() => {});
    stack.push(marker);
    let open = true;
    // Ends this frame and any left above it (a savepoint its body didn't await): ROLLBACK TO and RELEASE end those on
    // the server too. False when it was already dead.
    const end = () => { const i = stack.lastIndexOf(marker); if (i >= 0) stack.splice(i); return i >= 0; };
    const frame = {
      // Each sends its statements before its first await (SavepointFrame's rule).
      async commit(): Promise<void> {
        if (!open) throw new Error("savepoint already settled");
        if (!stack.includes(marker)) { open = false; throw new Error("savepoint outlived its transaction"); }
        // Rolled back rather than left open: the caller's later statements would otherwise land inside it.
        if (stack.at(-1) !== marker) { await frame.rollback(); throw new Error("savepoint commit out of order: an inner one is still open"); }
        open = false;
        end();
        const released = conn.unsafe(`RELEASE ${name}`).execute();
        try {
          await Promise.all([opened, released]);
        } catch (error) {
          // 25P02 when fn swallowed a statement error: the savepoint is still there, aborted; undo it so the
          // transaction can go on (unless it already ended), and reject with what the caller must fix.
          if (!txn.ended) await conn.unsafe(`ROLLBACK TO ${name}`).then(() => conn.unsafe(`RELEASE ${name}`)).catch(() => {});
          throw TxAborted.wrap(error);
        }
        // Its body returned without awaiting it (D4) and the transaction ended while RELEASE was in flight: dropped
        // with its effects and hooks, as one that settles after the end is.
        if (txn.ended) throw new Error("savepoint outlived its transaction");
      },
      async rollback(): Promise<void> {
        if (!open) return;
        open = false;
        if (!end()) return;
        const back = conn.unsafe(`ROLLBACK TO ${name}`).execute();
        const released = conn.unsafe(`RELEASE ${name}`).execute();
        // A SAVEPOINT that failed (25P02: the transaction was already aborted) fails the two after it: the cause is
        // the aborted transaction, named as TxAborted, as the write's own rejection would be.
        const [o, ...rest] = await Promise.allSettled([opened, back, released]);
        if (o.status === "rejected") throw TxAborted.wrap(o.reason);
        for (const r of rest) if (r.status === "rejected") throw r.reason;
      },
    };
    return { frame, tx: new PgTx(this.store, this.txn, root) };
  }

  protected deferEffect(effect: Effect): void { this.effects.push(effect); }

  protected override settled(inner: BaseTx, kept: boolean): void {
    const t = inner as PgTx;
    if (kept) this.effects.push(...t.effects);
    t.effects.length = 0;
  }
}

declare const fragmentBrand: unique symbol;
// A piece of a statement for a PgSql template (a column or table name, a clause). It is never sent on its own:
// awaiting one throws.
export type PgFragment = { readonly [fragmentBrand]: true };

// The statement handle pgOf gives a store function: the only part of Bun.SQL a store function reaches. A tagged
// template or `unsafe` checks the handle and sends the statement at once (`.execute()`), so statements reach the
// connection in the order the code builds them. An `await` alone would send a Bun query a microtask later: a parent
// statement started beside `tx.savepoint` would then follow the SAVEPOINT and roll back with it, where SQLite runs it
// in the parent (D2). The other calls build what a template interpolates and send nothing: rows or a value list
// (`sql(obj)`, `sql(array)`), a name (`sql("col")`) and `fragment`. No begin, reserve, savepoint or close: a store
// function writes only in its queued transaction, and nests through `tx.savepoint`.
export interface PgSql {
  <T = any>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  (name: string): PgFragment;
  <T extends { [Key in PropertyKey]: unknown }, Keys extends keyof T = keyof T>(obj: T | T[] | readonly T[], ...columns: readonly Keys[]): SQL.Helper<Pick<T, Keys>>;
  <T>(value: T & {}): SQL.Helper<T>;
  unsafe<T = any>(text: string, values?: unknown[]): Promise<T>;
  fragment(strings: TemplateStringsArray, ...values: unknown[]): PgFragment;
}

const isTemplate = (v: unknown): v is TemplateStringsArray => Array.isArray(v) && Object.hasOwn(v, "raw");

// Bun nests a fragment by its Query class; its own `then` stops it being sent alone (Bun would run it as a statement).
function fragment(q: SQL.Query<unknown>): PgFragment {
  Object.defineProperty(q, "then", { value() { throw new Error("a PgSql fragment awaited: it goes inside a statement (pgOf)"); } });
  return q as unknown as PgFragment;
}

function statements(conn: SQL, check: () => void): PgSql {
  const sql = ((first: unknown, ...rest: unknown[]) => {
    if (isTemplate(first)) { check(); return conn(first, ...rest).execute(); }
    if (typeof first === "string") return fragment(conn(first));
    return (conn as unknown as (...a: unknown[]) => unknown)(first, ...rest);
  }) as PgSql;
  sql.unsafe = (text, values) => { check(); return conn.unsafe(text, values).execute(); };
  sql.fragment = (strings, ...values) => fragment(conn(strings, ...values));
  return sql;
}

// The statements of a Postgres store function: a live Tx's transaction, or the pool. Refuses a settled Tx (or one
// whose savepoint is open), a handle from another backend, and the store's Read from the task holding its open
// transaction: a pool read there sees none of the body's rows and, on a small pool, waits forever for the connection
// the transaction holds. Such a caller passes its body's Tx. Checked here and again as each statement is sent. The
// refusals read as SQLite's.
export function pgOf(r: Read): PgSql {
  if (r instanceof PgTx) { r.assertLive(); return statements(r.txn.conn, () => r.assertLive()); }
  if (!(r instanceof PgRead)) throw new Error("not a Postgres store handle");
  const { store } = r;
  const check = () => { if (store.open && store.queue.mine) throw new Error(READ_REFUSAL); };
  check();
  return statements(store.sql, check);
}

// What a failure log may carry. A Postgres error (or a TxAborted, whose cause is one) logs as its class, code and
// SQLSTATE only: its detail quotes row values (23505's "Key (email)=(…)"), and so can its message (22P02's input).
// Any other error logs whole, as SQLite's do.
function loggable(error: unknown): unknown {
  return error instanceof SQL.SQLError || error instanceof TxAborted ? errorDiagnostic(error) : error;
}

export type PgTransactions = {
  // A top-level write transaction through the store's queue: SQLite's Repo.write contract (db.ts `queued`). fn's
  // Tx is live until fn settles; the beforeCommit hooks run after it fulfils; COMMIT, then the afterCommit effects'
  // synchronous parts, then `committed`, all before the queue's next body. A synchronous fn commits async too.
  write<T, R = T>(fn: (tx: Tx) => T | PromiseLike<T>, committed?: (value: T) => R): Promise<Awaited<R>>;
  // A write no caller awaits: always queued, so always false. Refuses inside the caller's open transaction; a
  // failure, or a rejection of a promise `committed` returns, is logged as `what` failed.
  post<T>(fn: (tx: Tx) => T | PromiseLike<T>, committed?: (value: T) => unknown, what?: string): boolean;
  read: Read;
  queue: WriteQueue;
  // Whether the store's root transaction is open (from BEGIN until `begin` settles).
  inTransaction(): boolean;
  close(): Promise<void>;
};

// The Postgres store's transactions over a pool of its own: the pool's settings are the store's invariants, so no
// caller can open it without them. Read-only by default, with `read write` on each BEGIN: a pool statement that
// writes fails 25006 (the stand-in for SQLite's writer check). lock_timeout bounds a wait on a lock an outside writer
// (psql, a seeding script) holds: one queue serves every write, so an unbounded wait would stall them all (55P03).
// Isolation is READ COMMITTED on every BEGIN, whatever the database default (D3, D6). No retries.
export function makePgTransactions(url: string, opts: Omit<PgOptions, "connection"> = {}): PgTransactions {
  const sql = openPg(url, { ...opts, connection: { default_transaction_read_only: "on", lock_timeout: "5000" } });
  const store: Store = { sql, queue: queueFor(sql), open: undefined };
  const { queue } = store;

  function write<T, R = T>(fn: (tx: Tx) => T | PromiseLike<T>, committed?: (value: T) => R): Promise<Awaited<R>> {
    if (store.open && queue.mine) return Promise.reject(new Error("write() inside an open transaction: nested code calls its Tx's savepoint"));
    // fn and committed run as the work of the request that called write(), or of none (db.ts queued, #1042).
    const o = requestOrigin();
    return queue.run(() => o ? inRequest(o, body) : detached(body)).then(box => box.out) as Promise<Awaited<R>>;

    async function body(): Promise<{ out: R }> {
      let root: PgTx | undefined;
      let fulfilled = false;
      let box: { v: T };
      try {
        box = await sql.begin("isolation level read committed, read write", async conn => {
          const txn: Txn = { conn, stack: [], n: 0, ended: false };
          root = new PgTx(store, txn);
          store.open = root;
          try {
            const v = await fn(root as unknown as Tx);
            if (root.hasBeforeCommit) await root.runBeforeCommit();
            fulfilled = true;
            // Boxed: Bun's handling of a callback's array result can't touch the body's value.
            return { v };
          } finally {
            // The transaction ends here: its Tx and any savepoint left open die, and no frame sends a statement.
            root.close();
            txn.ended = true;
            txn.stack.length = 0;
          }
        });
      } catch (error) {
        root?.close();
        store.open = undefined;
        // The body fulfilled and COMMIT failed without a SQLSTATE (the connection lost): the server may have
        // committed. The effects don't run, so memory may lag the database until a restart.
        if (fulfilled && !(error instanceof SQL.PostgresError && (typeof error.errno === "string" || pgFailure(error)))) {
          console.error("[grayboard] commit outcome unknown:", loggable(error));
        }
        throw TxAborted.wrap(error);
      }
      store.open = undefined;
      for (const effect of root!.effects) flushEffect(effect);
      return { out: committed ? committed(box.v) : box.v as unknown as R };
    }
  }

  function post<T>(fn: (tx: Tx) => T | PromiseLike<T>, given?: (value: T) => unknown, what = "write"): boolean {
    if (store.open && queue.mine) throw new Error(`post inside an open transaction (${what}): a body's write goes on its Tx`);
    // No caller awaits a post: a promise committed returns is caught and logged here (#1051), its throw by the
    // write's own catch, once either way.
    const committed = given && ((value: T) => {
      const r = given(value);
      if (isThenable(r)) Promise.resolve(r).catch(error => console.error(`[grayboard] ${what} failed:`, loggable(error)));
    });
    write(fn, committed).catch(error => console.error(`[grayboard] ${what} failed:`, loggable(error)));
    return false;
  }

  return {
    write, post,
    read: new PgRead(store) as unknown as Read,
    queue,
    inTransaction: () => store.open !== undefined,
    close: () => sql.close(),
  };
}
