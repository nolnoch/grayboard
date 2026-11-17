// Transactions as explicit values (#807 D2, docs/future/postgres-server.md). A store function that only reads takes a
// `Read`; one that writes takes a `Tx`. On SQLite both wrap the server's one routed connection (core/sqlite.ts
// routeReads picks writer or reader per statement); on Postgres (P3) a `Read` is the pool and a `Tx` one transaction's
// connection, so a read passed the caller's `Tx` sees its uncommitted rows and a stray pool read can't run outside it.
//
// A `Tx` is live only while its transaction is open: used after its body settles (a timer or un-awaited promise the
// body started, D4) it throws rather than write into whichever transaction is open by then.
import { afterCommit, openSavepoint, ownsTx } from "../../core/sqlite.ts";

// The connection, opaque here so this file stays off bun:sqlite (db.test.ts: the Repo facade is the Postgres seam).
type Database = Parameters<typeof openSavepoint>[0];

declare const readBrand: unique symbol;
declare const txBrand: unique symbol;

export interface Read { readonly [readBrand]: true }

export interface Tx extends Read {
  readonly [txBrand]: true;
  // Runs after the outermost COMMIT resolves, in registration order; never on rollback (of the transaction, or of a
  // savepoint the effect was registered in). Its synchronous part runs before the write queue's next body (D4).
  // A savepoint its body didn't await (a D4 violation) is dropped with its effects when the transaction ends, though
  // the writes it made before then commit.
  afterCommit(effect: () => void | Promise<void>): void;
  // A nested transaction: fn's writes and effects roll back alone when it throws or rejects. Awaitable on every
  // store, so callers are written once for Postgres. Only an async write() body's Tx has it: a synchronous body
  // (a post from the queue's holder) can't await one, so its Tx refuses.
  savepoint<T>(fn: (tx: Tx) => T | Promise<T>): Promise<T>;
  // A hook run after the outermost body fulfils and before its COMMIT, on that transaction's root Tx, with the queue
  // still held (#807 P3 A7g): reads there see the transaction's final state, its commit lands right after them, and
  // no other body runs between. Once per `key` per transaction, in registration order; a hook may register another,
  // which runs before COMMIT too. Registered in a savepoint, it's dropped when that savepoint rolls back (as an
  // afterCommit effect is) unless the key was already registered outside it. A rejection rolls the transaction back
  // and rejects the write with it. Postgres runs the same hooks before its COMMIT on the transaction's connection.
  // Only a write() body's Tx has it: a synchronous body's (a post from the queue's holder) commits as it returns, so
  // it refuses.
  beforeCommit(key: object, hook: (tx: Tx) => Promise<void>): void;
}

class SqliteRead {
  constructor(readonly db: Database) {}
}

// While a savepoint is open its Tx is the only live one: the parent's statements and effects would land inside the
// savepoint (and roll back with it), and a second savepoint beside it would release out of order. Both throw.
class SqliteTx extends SqliteRead {
  // `root`: the transaction's outermost Tx, which holds the beforeCommit hooks; a savepoint's Tx points at its parent's.
  constructor(db: Database, readonly nests = true, root?: SqliteTx) { super(db); this.#root = root ?? this; }
  #live = true;
  #child: SqliteTx | undefined;
  readonly #root: SqliteTx;
  // On the root: the hooks by key, pending or run. On a savepoint's Tx: the keys it added, dropped if it rolls back.
  readonly #hooks = new Map<object, ((tx: Tx) => Promise<void>) | undefined>();
  readonly #added: object[] = [];
  // Closes its open savepoint's Tx too: a body that returned without awaiting one leaves nothing live behind it.
  close(): void { this.#live = false; this.#child?.close(); }
  get live(): boolean { return this.#live; }
  assertLive(): void {
    if (!this.#live) throw new Error("Tx used after its transaction settled: a body awaits only its own statements (#807 D4)");
    if (this.#child?.live) throw new Error("Tx used while its savepoint is open: use the savepoint's Tx");
  }
  afterCommit(effect: () => void | Promise<void>): void {
    this.assertLive();
    afterCommit(this.db, effect);
  }
  async savepoint<T>(fn: (tx: Tx) => T | Promise<T>): Promise<T> {
    this.assertLive();
    if (!this.nests) throw new Error("savepoint in a synchronous write body: only an async write() body can await one");
    const b = openSavepoint(this.db);
    const inner = new SqliteTx(this.db, true, this.#root);
    this.#child = inner;
    let value: T;
    try {
      value = await fn(inner as unknown as Tx);
    } catch (error) {
      this.#settle(inner, false);
      b.rollback();
      throw error;
    }
    try { b.commit(); } catch (error) { this.#settle(inner, false); throw error; }
    this.#settle(inner, true);
    return value;
  }
  // A settled savepoint's hook keys follow its frame (#1182 audit): kept, they move to this Tx (and so drop with an
  // enclosing rollback) only once its RELEASE succeeded; dropped, they leave the root. Keys a still-open descendant
  // (one the body didn't await, D4) registered drop either way, as its afterCommit effects do.
  #settle(inner: SqliteTx, kept: boolean): void {
    const open: object[] = [];
    for (let t = inner.#child; t; t = t.#child) open.push(...t.#added);
    inner.close();
    this.#child = undefined;
    const hooks = this.#root.#hooks;
    for (const key of open) hooks.delete(key);
    if (!kept) for (const key of inner.#added) hooks.delete(key);
    else if (this !== this.#root) this.#added.push(...inner.#added);
  }
  beforeCommit(key: object, hook: (tx: Tx) => Promise<void>): void {
    this.assertLive();
    if (!this.nests) throw new Error("beforeCommit in a synchronous write body: it commits as it returns");
    const hooks = this.#root.#hooks;
    if (hooks.has(key)) return;
    hooks.set(key, hook);
    if (this !== this.#root) this.#added.push(key);
  }
  get hasBeforeCommit(): boolean { return [...this.#hooks.values()].some(h => h !== undefined); }
  // The root's pending hooks, each once, until none is left: one a hook registers runs in the same pass.
  async runBeforeCommit(): Promise<void> {
    for (;;) {
      const next = [...this.#hooks].find(([, h]) => h !== undefined);
      if (!next) return;
      const [key, hook] = next;
      this.#hooks.set(key, undefined);
      await hook!(this as unknown as Tx);
    }
  }
}

// The store's read handle outside any transaction.
export function sqliteRead(db: Database): Read { return new SqliteRead(db) as unknown as Read; }

// A transaction's handle for a body; the caller closes it when the transaction (or savepoint) settles. `nests`:
// false for a synchronous body's, whose savepoint refuses.
export type RootTx = Tx & { close(): void; readonly hasBeforeCommit: boolean; runBeforeCommit(): Promise<void> };
export function sqliteTx(db: Database, nests = true): RootTx {
  return new SqliteTx(db, nests) as unknown as RootTx;
}

// Whether a handle is a transaction's: a function reached both inside a body and outside one writes on a `Tx` and
// posts its own write for a `Read` (writeAudit). A settled `Tx` still answers true; writing on it throws (D4).
export function isTx(h: Read): h is Tx { return h instanceof SqliteTx; }

// The connection a SQLite store function runs its statements on: refuses a closed `Tx`, and a handle from another
// store. It also refuses the store's `Read` from the task that holds the connection's open transaction (#807 P3 A7e2,
// D2): SQLite routes that read to the writer, so it would see the body's uncommitted rows, which a Postgres pool read
// never does. Such a caller passes its body's `Tx`. Another task's `Read`, while the holder awaits, reads committed
// state as before; so do a commit's `committed` callback and `afterCommit` effects, which run after it closes.
export function sqliteOf(r: Read): Database {
  if (!(r instanceof SqliteRead)) throw new Error("not a SQLite store handle");
  if (r instanceof SqliteTx) r.assertLive();
  else if (ownsTx(r.db)) throw new Error("repo.read inside the caller's own transaction: pass the body's Tx (#807 D2)");
  return r.db;
}

// An effect after the caller's commit: a `Tx`'s `afterCommit` (a settled one throws), or now for a `Read` (outside any body, nothing
// is pending). Lets a function reached both inside a body and outside one schedule its effect on the handle it holds.
export function afterCommitOf(h: Read, effect: () => void | Promise<void>): void {
  if (h instanceof SqliteTx) { h.afterCommit(effect); return; }
  if (!(h instanceof SqliteRead)) throw new Error("not a SQLite store handle");
  // As core's afterCommit outside a transaction: run synchronously, an error or rejection logged.
  try { void Promise.resolve(effect()).catch((error) => console.error("postcommit effect failed", error)); }
  catch (error) { console.error("postcommit effect failed", error); }
}
