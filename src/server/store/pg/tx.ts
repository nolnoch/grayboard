// The Postgres store's transaction handles and write path (#807 P3 C2, docs/future/postgres-server.md D2, D4, D6): a
// `Read` is the read pool, a `Tx` one transaction's connection from the write pool, both over tx_base.ts's
// backend-neutral contract, and `write`/`writeKeyed`/`post` run through the write scheduler (store/queue.ts), as
// SQLite's write and post do. A store function takes a handle and
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
// - Writer ownership (D4): both pools are read-only (default_transaction_read_only), each BEGIN says `read write`, a
//   `Tx` dies with its body, and pgOf's handle has no begin, reserve or savepoint. There is no shared writer connection to
//   guard per statement; SQL text that changes a pooled session's settings is caught only in review.
// - An error a body catches without a savepoint aborts the transaction; the failure surfaces later as 25P02 or a
//   rolled-back COMMIT, and the write rejects with TxAborted, which names the cause. A statement a store function sends
//   without awaiting (pg/audit.ts write) notes its failure on the transaction (eagerFailure), and TxAborted names that
//   first failure, since the later one only says the transaction was already aborted (#1302).
//
// Runtime imports stay off bun:sqlite (pg/isolation.test.ts): tx_base.ts, queue.ts and request_context.ts import
// nothing that reaches it.
import { SQL } from "bun";
import { errorDiagnostic } from "../../diagnostics.ts";
import { DEFAULT_DATABASE_WRITERS, WriteQueue } from "../queue.ts";
import { BaseRead, BaseTx, flushEffect, isThenable, ProbeWrite, type Read, type SavepointFrame, type Tx } from "../tx_base.ts";
import { pgFailure } from "./errors.ts";
import { openPg, type PgOptions } from "./sql.ts";

type Effect = () => void | Promise<void>;

// The store's state the handles share: its read pool, its scheduler, and each running body's root Tx while its
// transaction is open, keyed on the body's scheduler token (queue.token): bodies overlap once one is keyed (#1510), so
// "the open transaction" is the calling body's, never one slot for the store.
type Store = { readonly sql: SQL; readonly queue: WriteQueue; readonly open: WeakMap<object, PgTx> };

// The calling body's open root Tx: set from BEGIN until its `begin` settles, for the body and the tasks it started.
function openOf(store: Store): PgTx | undefined {
  const token = store.queue.token;
  return token === undefined ? undefined : store.open.get(token);
}

// One transaction's savepoint bookkeeping: its connection, the open frames innermost last, and a counter for names.
// A frame missing from `stack` is dead: its transaction ended, or an enclosing ROLLBACK TO or RELEASE ended it.
// `failed`: the first eager statement's failure that aborted it (eagerFailure), with the frames open when that statement
// was sent; a ROLLBACK TO of one of those frames undid the failure and clears it.
// `keys`: a keyed body's (writeKeyed), on the transaction rather than a Tx handle so its savepoints carry them too;
// undefined for an exclusive body. `effects`: a keyed body whose caller opted in to afterCommit effects and `committed`
// (writeKeyed's `effects`); without it they refuse. `notices`: the change notices (store/notices.ts, by op name) an
// opted-in body may queue; every other refuses. `probe`: set while readsOnly runs on the transaction, with the first
// statement it refused.
type Txn = {
  readonly conn: SQL; readonly stack: object[]; n: number; ended: boolean; readonly keys?: ReadonlySet<string>; readonly effects?: boolean;
  readonly notices?: ReadonlySet<string>;
  failed?: { error: unknown; frames: object[] }; probe?: { refused?: ProbeWrite };
};

const READ_REFUSAL = "repo.read inside the caller's own transaction: pass the body's Tx (#807 D2)";

// 25P02 or a rolled-back COMMIT: a statement failed inside the transaction (or a savepoint) and the body caught it
// without a savepoint, so the transaction was already aborted. The statement that failed is gone by then; this names
// the bug. When that statement was an eager one (eagerFailure), its error is `first`, the message names its class,
// code and SQLSTATE (never its text, which can quote row values), and `code` and `errno` are its: the cause, 25P02 or
// the rolled-back COMMIT, says only that the transaction was already aborted (#1302). `code` and `errno` are copied as
// own data properties for the diagnostics (diagnostics.ts reads no cause).
export class TxAborted extends Error {
  override readonly name = "TxAbortedError";
  readonly code: string;
  readonly errno: string | undefined;
  readonly first: unknown;
  constructor(cause: InstanceType<typeof SQL.PostgresError>, first?: unknown) {
    const d = first === undefined ? undefined : errorDiagnostic(first);
    const named = d ? [d.class, d.code, d.sqlstate].filter(Boolean).join(" ") : "";
    super(named
      ? `transaction aborted by an earlier statement's failure (${named}) that no savepoint caught; wrap the statement that may fail in tx.savepoint (#807 D6)`
      : "transaction aborted: a statement error was caught without a savepoint; wrap the statement that may fail in tx.savepoint (#807 D6)", { cause });
    const own = first instanceof SQL.SQLError ? first as { code?: unknown; errno?: unknown } : undefined;
    this.code = typeof own?.code === "string" ? own.code : cause.code;
    this.errno = own ? (typeof own.errno === "string" ? own.errno : undefined) : cause.errno;
    this.first = first;
  }
  // The error to reject with: a TxAborted for an aborted transaction, naming `txn`'s first eager failure when it has
  // one; anything else unchanged.
  static wrap(e: unknown, txn?: Txn): unknown {
    return pgFailure(e)?.kind === "aborted" ? new TxAborted(e as InstanceType<typeof SQL.PostgresError>, txn?.failed?.error) : e;
  }
}

// The keyed-body guard (#1510, docs/future/postgres-server.md D4): a store function whose work a keyed body must not do
// calls it before its first statement. On a keyed body's Tx (or a savepoint of one) it throws unless the body holds
// `needs`; with no `needs`, always. An exclusive body's Tx, a Read and a SQLite handle pass. So a body misclassified as
// keyed fails in the first test that reaches the call, instead of reordering ids or racing a lock in production:
// messages.insert needs `dm:<recipient>` and boards.insertPost `board:<name>` (id commit order, G1), and
// hosted.lockCapacity is refused outright (the capacity paths stay exclusive).
// Inside a readsOnly probe the refusal is the probe's (a ProbeWrite, a miss for its caller), since what it refuses is a
// write or a lock only an exclusive body takes.
export function refuseKeyed(h: Read, op: string, needs?: string): void {
  if (!(h instanceof PgTx)) return;
  const keys = h.txn.keys;
  if (keys === undefined || (needs !== undefined && keys.has(needs))) return;
  if (h.txn.probe) probeRefusal(h.txn, op);
  throw new Error(keyedRefusal(op, keys, needs));
}
// A change notice's guard (store/notices.ts, pg_repo.ts): refuseKeyed, except that a keyed body whose caller opted in
// to `op`'s notice (writeKeyed's `notices`, D4) queues it for a row of its own root: one whose `root:<id>` the body
// holds. `op`: the wrapped write's name (`hosted.update`), undefined for a bare notice, which no body opts in to;
// `label`: the refusal's text; `id`: the row the notice names, null for any row (never opted in). A probe refuses
// every notice.
export function refuseKeyedNotice(h: Read, op: string | undefined, label: string, id: string | null = null): void {
  const opted = h instanceof PgTx && op !== undefined && h.txn.notices?.has(op) === true;
  if (opted && !h.txn.probe && id !== null && h.txn.keys?.has(`root:${id}`)) return;
  refuseKeyed(h, opted ? `${label} for ${id ?? "any row"}, not this body's root` : label);
}
const keyedRefusal = (op: string, keys: ReadonlySet<string>, needs?: string) =>
  `${op} refused in a keyed write body (keys ${[...keys].join(", ")})${needs === undefined ? "" : ` without the key ${needs}`}: it runs in an exclusive body (write) (docs/future/postgres-server.md D4)`;

// A read-only probe's refusal: noted on the transaction (so a caller that swallows it still misses) and thrown.
function probeRefusal(txn: Txn, op: string): never {
  const refused = new ProbeWrite(`${op} refused in a read-only probe${txn.keys ? ` (keys ${[...txn.keys].join(", ")})` : ""}: the probed code would write (docs/future/postgres-server.md D4)`);
  txn.probe!.refused ??= refused;
  throw refused;
}

// What a probe lets through: a statement whose first word is SELECT and that names no advisory lock. Every write
// (INSERT, UPDATE, DELETE, a data-modifying WITH, DDL) and every statement whose text starts with any other
// interpolation refuses. A `sql.fragment` counts as its own text (statementText), so a statement that opens with a
// SELECT fragment (identity.ts userFrom) is judged by it, and an advisory lock inside a fragment still refuses. Row
// locks (FOR UPDATE, FOR SHARE) pass: the probed code takes the rows it reads.
const PROBE_READ = /^\s*select\b/i;
const PROBE_ADVISORY = /pg_advisory/i;
function probeCheck(txn: Txn, text: string): void {
  if (!txn.probe) return;
  if (!PROBE_READ.test(text) || PROBE_ADVISORY.test(text)) probeRefusal(txn, `the statement "${text.trim().split(/\s+/).slice(0, 3).join(" ")} …"`);
}

// Runs fn with `tx`'s transaction in a read-only probe (#1510, docs/future/postgres-server.md D4): every statement it
// sends on that transaction is checked as it's built (probeCheck), and refuseKeyed's refusals become the probe's. The
// first refusal rejects the probe, ProbeWrite, before anything it refused was sent, even if fn caught it and went on.
// Not nested; the probe ends when fn settles, so the caller's later statements write.
export async function readsOnly<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
  if (!(tx instanceof PgTx)) throw new Error("readsOnly needs a Postgres body's Tx");
  tx.assertLive();
  const txn = tx.txn;
  if (txn.probe) throw new Error("readsOnly nested in a probe");
  const probe: { refused?: ProbeWrite } = {};
  txn.probe = probe;
  let out: T;
  try { out = await fn(); }
  catch (error) { if (probe.refused) throw probe.refused; throw error; }
  finally { txn.probe = undefined; }
  if (probe.refused) throw probe.refused;
  return out;
}

// For a statement a store function sends on `tx` without awaiting it (pg/audit.ts write): call at send time, and pass
// the returned setter the statement's rejection. It notes the transaction's first such failure, with the savepoints open
// when the statement was sent, so the TxAborted the transaction later rejects with names it.
export function eagerFailure(tx: Tx): (error: unknown) => void {
  if (!(tx instanceof PgTx)) return () => {};
  const txn = tx.txn, frames = txn.stack.slice();
  return error => { txn.failed ??= { error, frames }; };
}

// A ROLLBACK TO `marker`'s savepoint succeeded: a noted failure sent inside it was undone with it.
function undone(txn: Txn, marker: object): void {
  if (txn.failed?.frames.includes(marker)) txn.failed = undefined;
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
          // transaction can go on (unless it already ended), and reject with what the caller must fix. Built before the
          // undo, which clears a failure it undid.
          const aborted = TxAborted.wrap(error, txn);
          if (!txn.ended) {
            await conn.unsafe(`ROLLBACK TO ${name}`).then(() => {
              undone(txn, marker);
              return conn.unsafe(`RELEASE ${name}`);
            }).catch(() => {});
          }
          throw aborted;
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
        const [o, b, ...rest] = await Promise.allSettled([opened, back, released]);
        if (o.status === "rejected") throw TxAborted.wrap(o.reason, txn);
        if (b.status === "fulfilled") undone(txn, marker);
        for (const r of [b, ...rest]) if (r.status === "rejected") throw r.reason;
      },
    };
    return { frame, tx: new PgTx(this.store, this.txn, root) };
  }

  // A keyed body's beforeCommit hooks refuse as its effects do (D4, #1510 chunk 3 audit L6): a hook runs other code at
  // the commit, in this body's context, while other keyed bodies run, and one registered in a readsOnly probe would
  // run after the probe ends, unchecked. In a probe the refusal is its ProbeWrite (refuseKeyed).
  override beforeCommit(key: object, hook: (tx: Tx) => Promise<void>): void {
    if (!this.txn.effects || this.txn.probe) refuseKeyed(this as unknown as Read, "a beforeCommit hook");
    super.beforeCommit(key, hook);
  }

  // A keyed body's effects refuse unless its caller opted in (D4): an effect runs other code at the commit, in this
  // body's context, while other keyed bodies run.
  protected deferEffect(effect: Effect): void {
    if (!this.txn.effects || this.txn.probe) refuseKeyed(this as unknown as Read, "afterCommit effect");
    this.effects.push(effect);
  }

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

// A statement's text for the probe: its literal pieces, with each `sql.fragment` value's own text (fragmentText) in
// its place; any other value is a gap.
const fragmentText = new WeakMap<object, string>();
const statementText = (strings: readonly string[], values: readonly unknown[]) =>
  strings.map((piece, i) => {
    const v = values[i];
    return i < values.length ? `${piece} ${typeof v === "object" && v !== null ? fragmentText.get(v) ?? "" : ""} ` : piece;
  }).join("");

// Bun nests a fragment by its Query class; its own `then` stops it being sent alone (Bun would run it as a statement).
function fragment(q: SQL.Query<unknown>): PgFragment {
  return Object.defineProperty(q, "then", { value() { throw new Error("a PgSql fragment awaited: it goes inside a statement (pgOf)"); } }) as unknown as PgFragment;
}

// `check` gets the statement's text (a template's literal pieces), before it's sent.
function statements(conn: SQL, check: (text: string) => void): PgSql {
  const sql = ((first: unknown, ...rest: unknown[]) => {
    if (isTemplate(first)) { check(statementText(first, rest)); return conn(first, ...rest).execute(); }
    if (typeof first === "string") return fragment(conn(first));
    return (conn as unknown as (...a: unknown[]) => unknown)(first, ...rest);
  }) as PgSql;
  sql.unsafe = (text, values) => { check(text); return conn.unsafe(text, values).execute(); };
  sql.fragment = (strings, ...values) => {
    const f = fragment(conn(strings, ...values));
    fragmentText.set(f, statementText(strings, values));
    return f;
  };
  return sql;
}

// The statements of a Postgres store function: a live Tx's transaction, or the read pool. Refuses a settled Tx (or one
// whose savepoint is open), a handle from another backend, and the store's Read from a body whose transaction is open
// (or a task it started): a pool read there sees none of the body's rows. Such a caller passes its body's Tx. Judged
// per body (openOf): another body's open transaction doesn't refuse this caller's read. Checked here and again as each
// statement is sent. The refusals read as SQLite's. A Tx's statement in a readsOnly probe is checked too (probeCheck).
export function pgOf(r: Read): PgSql {
  if (r instanceof PgTx) { r.assertLive(); return statements(r.txn.conn, text => { r.assertLive(); probeCheck(r.txn, text); }); }
  if (!(r instanceof PgRead)) throw new Error("not a Postgres store handle");
  const { store } = r;
  const check = () => { if (openOf(store)) throw new Error(READ_REFUSAL); };
  check();
  return statements(store.sql, check);
}

// What a failure log may carry. A Postgres error (or a TxAborted, whose cause is one) logs as its class, code and
// SQLSTATE only: its detail quotes row values (23505's "Key (email)=(…)"), and so can its message (22P02's input).
// Any other error logs whole, as SQLite's do.
function loggable(error: unknown): unknown {
  return error instanceof SQL.SQLError || error instanceof TxAborted ? errorDiagnostic(error) : error;
}

// `effects`: the keyed body may register afterCommit effects and pass `committed` (D4: a reviewed opt-in). `notices`:
// with `effects`, the change notices it may queue, by the wrapped op's name (store/notices.ts); none without.
export type KeyedOptions = { effects?: true; notices?: readonly string[] };

export type PgTransactions = {
  // A top-level write transaction through the store's scheduler, exclusive: SQLite's Repo.write contract (db.ts
  // `queued`). fn's Tx is live until fn settles; the beforeCommit hooks run after it fulfils; COMMIT, then the
  // afterCommit effects' synchronous parts, then `committed`, all before the scheduler's next body. A synchronous fn
  // commits async too.
  write<T, R = T>(fn: (tx: Tx) => T | PromiseLike<T>, committed?: (value: T) => R): Promise<Awaited<R>>;
  // write, keyed (store/queue.ts runKeyed, #1510): it overlaps running keyed bodies that share none of `keys`, on a
  // connection of its own. Its afterCommit effects and `committed` refuse (D4) unless `effects` opts in (no Repo caller
  // does yet); opted in, they still run before any body that conflicts with it starts.
  writeKeyed<T, R = T>(keys: readonly string[], fn: (tx: Tx) => T | PromiseLike<T>, committed?: (value: T) => R, opts?: KeyedOptions): Promise<Awaited<R>>;
  // A write no caller awaits: always queued, so always false. Refuses inside the caller's open transaction; a
  // failure, or a rejection of a promise `committed` returns, is logged as `what` failed.
  post<T>(fn: (tx: Tx) => T | PromiseLike<T>, committed?: (value: T) => unknown, what?: string): boolean;
  // post, keyed: its body runs as writeKeyed's, without `effects`.
  postKeyed<T>(keys: readonly string[], fn: (tx: Tx) => T | PromiseLike<T>, committed?: (value: T) => unknown, what?: string): boolean;
  // Repo.readsOnly: readsOnly above.
  readsOnly<T>(tx: Tx, fn: () => Promise<T>): Promise<T>;
  read: Read;
  queue: WriteQueue;
  // Whether the calling body's root transaction is open (from BEGIN until `begin` settles): false outside any body,
  // whatever other bodies have open.
  inTransaction(): boolean;
  // NOTIFY through the pool, outside any transaction (the auth generation's heartbeat, pg/auth_generation.ts).
  notify(channel: string, payload: string): Promise<void>;
  close(): Promise<void>;
};

// The Postgres store's transactions over two pools of its own: their settings are the store's invariants, so no
// caller can open one without them. Reads and NOTIFY go on the read pool (`max`); every write body's transaction on the
// write pool (`writers`, W, also the scheduler's cap, so a body that starts never waits for a connection: Bun releases
// a transaction's connection before its `begin` settles, and the scheduler releases the body's slot after that). Two
// Bun.SQL instances, because a pool shares nothing: Bun's pool serves its callers FIFO and a plain query behind as many
// waiting transactions as it has connections isn't served, so on one pool reads would queue behind writers (Bun
// v1.4.4 src/js/internal/sql/pool.ts #serveNext; `begin` queues a reservation there, src/js/bun/sql.ts). Each pool
// dials up to its max on first use (pool.ts #dial), so a store holds up to `max` + W connections. Read-only by default,
// with `read write` on each BEGIN: a pool statement that writes fails 25006 (the stand-in for SQLite's writer check).
// lock_timeout bounds a wait on a lock an outside writer (psql, a seeding script) holds: an exclusive body that waited
// without bound would stall every write behind it (55P03). Isolation is READ COMMITTED on every BEGIN, whatever the
// database default (D3, D6). No retries.
//
// `ownAuthCommit` (postgres-server.md D5; #807 P3 C9b): called once a transaction that wrote an auth table (users,
// oauth_grants, oauth_tokens, service_credential_secrets, service_credentials, principals) has committed (0001's
// triggers mark it gb.auth_touched; ROLLBACK TO undoes the mark), before the effects, `committed` and the queue's next
// body; also when such a COMMIT's outcome is unknown, since a bump is always safe. Set, it costs each write one round
// trip before COMMIT to read the mark.
//
// `writers` (W, default DEFAULT_DATABASE_WRITERS, production's): the write pool's size and the scheduler's cap. With
// every body exclusive, any W runs them one at a time, as the single queue did; W bounds only how many keyed bodies
// overlap. 1 is the single queue, the A/B control.
export function makePgTransactions(url: string, { ownAuthCommit, writers = DEFAULT_DATABASE_WRITERS, ...opts }: Omit<PgOptions, "connection"> & { ownAuthCommit?: () => void; writers?: number } = {}): PgTransactions {
  const connection = { default_transaction_read_only: "on", lock_timeout: "5000" };
  const queue = new WriteQueue(writers);
  const sql = openPg(url, { ...opts, connection });
  const writePool = openPg(url, { ...opts, max: writers, connection });
  const store: Store = { sql, queue, open: new WeakMap() };

  const write = <T, R = T>(fn: (tx: Tx) => T | PromiseLike<T>, committed?: (value: T) => R) => run(undefined, fn, committed);
  const writeKeyed = <T, R = T>(keys: readonly string[], fn: (tx: Tx) => T | PromiseLike<T>, committed?: (value: T) => R, opts?: KeyedOptions) => run(keys, fn, committed, opts?.effects === true, opts?.effects === true && opts.notices?.length ? new Set(opts.notices) : undefined);

  function run<T, R = T>(keys: readonly string[] | undefined, fn: (tx: Tx) => T | PromiseLike<T>, committed?: (value: T) => R, effects = false, notices?: ReadonlySet<string>): Promise<Awaited<R>> {
    if (openOf(store)) return Promise.reject(new Error("write() inside an open transaction: nested code calls its Tx's savepoint"));
    // A keyed body's keys, which its transaction carries (refuseKeyed); also the auth mark's refusal below.
    const held = keys === undefined ? undefined : new Set(keys);
    // `committed` runs other code at the release, in this body's context, while other keyed bodies run (D4).
    if (held && committed && !effects && Array.isArray(keys) && keys.length) return Promise.reject(new Error(keyedRefusal("a committed callback", held)));
    // fn and committed run as the work of the request that called write(), or of none (db.ts queued, #1042, #1408).
    return (keys === undefined ? queue.run(body) : queue.runKeyed(keys, body)).then(box => box.out) as Promise<Awaited<R>>;

    async function body(): Promise<{ out: R }> {
      // This body's identity for its own open transaction (openOf): the scheduler sets it before calling here.
      const token = queue.token!;
      let root: PgTx | undefined;
      let fulfilled = false, touched = false;
      let box: { v: T };
      try {
        box = await writePool.begin("isolation level read committed, read write", async conn => {
          const txn: Txn = { conn, stack: [], n: 0, ended: false, ...(held ? { keys: held, effects, ...(notices ? { notices } : {}) } : {}) };
          root = new PgTx(store, txn);
          store.open.set(token, root);
          try {
            const v = await fn(root as unknown as Tx);
            if (root.hasBeforeCommit) await root.runBeforeCommit();
            // After the beforeCommit hooks, defensively: no hook writes an auth table today, but one that did would
            // count. A keyed body reads the mark whether or not anyone listens for it: auth-table writers are exclusive
            // (G5: the generation bumps before the next body), so a keyed body that set it throws here, before COMMIT,
            // and rolls back.
            if (ownAuthCommit || held) {
              const marked = (await conn`SELECT current_setting('gb.auth_touched', true) = '1' AS t`)[0].t === true;
              if (marked && held) throw new Error(`a keyed write body (keys ${[...held].join(", ")}) wrote an auth table (gb.auth_touched): auth-table writers run in an exclusive body (write); rolled back (docs/future/postgres-server.md D4, D5)`);
              touched = marked;
            }
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
        store.open.delete(token);
        // The body fulfilled and COMMIT failed without a SQLSTATE (the connection lost): the server may have
        // committed. The effects don't run, so memory may lag the database until a restart.
        if (fulfilled && !(error instanceof SQL.PostgresError && (typeof error.errno === "string" || pgFailure(error)))) {
          console.error("[grayboard] commit outcome unknown:", loggable(error));
        }
        // The mark was read, so only COMMIT failed: one whose outcome is unknown may have landed, and a bump is harmless.
        if (touched) ownAuthCommit!();
        throw TxAborted.wrap(error, root?.txn);
      }
      if (touched) ownAuthCommit!();
      store.open.delete(token);
      for (const effect of root!.effects) flushEffect(effect);
      return { out: committed ? committed(box.v) : box.v as unknown as R };
    }
  }

  function post<T>(fn: (tx: Tx) => T | PromiseLike<T>, given?: (value: T) => unknown, what = "write", keys?: readonly string[]): boolean {
    if (openOf(store)) throw new Error(`post inside an open transaction (${what}): a body's write goes on its Tx`);
    // A keyed post takes no `committed` (writeKeyed's refusal, thrown to the caller, since nobody awaits a post).
    if (keys && given && Array.isArray(keys) && keys.length) throw new Error(keyedRefusal("a committed callback", new Set(keys)));
    // No caller awaits a post: a promise committed returns is caught and logged here (#1051), its throw by the
    // write's own catch, once either way.
    const committed = given && ((value: T) => {
      const r = given(value);
      if (isThenable(r)) Promise.resolve(r).catch(error => console.error(`[grayboard] ${what} failed:`, loggable(error)));
    });
    run(keys, fn, committed).catch(error => console.error(`[grayboard] ${what} failed:`, loggable(error)));
    return false;
  }

  return {
    write, writeKeyed, readsOnly,
    post: (fn, committed, what) => post(fn, committed, what),
    postKeyed: (keys, fn, committed, what) => post(fn, committed, what, keys),
    read: new PgRead(store) as unknown as Read,
    queue,
    inTransaction: () => openOf(store) !== undefined,
    notify: (channel, payload) => sql.notify(channel, payload),
    close: async () => { await Promise.all([sql.close(), writePool.close()]); },
  };
}
