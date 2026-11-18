// Transactions as explicit values (#807 D2, docs/future/postgres-server.md). A store function that only reads takes a
// `Read`; one that writes takes a `Tx`. On SQLite both wrap the server's one routed connection (core/sqlite.ts
// routeReads picks writer or reader per statement); on Postgres (P3) a `Read` is the pool and a `Tx` one transaction's
// connection, so a read passed the caller's `Tx` sees its uncommitted rows and a stray pool read can't run outside it.
//
// A `Tx` is live only while its transaction is open: used after its body settles (a timer or un-awaited promise the
// body started, D4) it throws rather than write into whichever transaction is open by then. The handle types and that
// contract are backend-neutral (tx_base.ts); this file is SQLite's statements under them.
import { afterCommit, openSavepoint, ownsTx } from "../../core/sqlite.ts";
import { BaseRead, BaseTx, type Read, type RootTx, type SavepointFrame } from "./tx_base.ts";

// The neutral names, re-exported so a store module keeps importing its handles from here.
export { afterCommitOf, isTx, type Read, type RootTx, type Tx } from "./tx_base.ts";

// The connection, opaque here so this file stays off bun:sqlite (db.test.ts: the Repo facade is the Postgres seam).
type Database = Parameters<typeof openSavepoint>[0];

class SqliteRead extends BaseRead {
  constructor(readonly db: Database) { super(); }
}

// Its effects wait in core's per-connection frames (core/sqlite.ts afterCommit), which a savepoint's RELEASE hands to
// the enclosing frame, so the base's settle hook has nothing to move.
class SqliteTx extends BaseTx {
  constructor(readonly db: Database, nests = true, root?: BaseTx) { super(nests, root); }
  protected openSavepoint(root: BaseTx): { frame: SavepointFrame; tx: BaseTx } {
    const frame = openSavepoint(this.db);
    return { frame, tx: new SqliteTx(this.db, true, root) };
  }
  protected deferEffect(effect: () => void | Promise<void>): void { afterCommit(this.db, effect); }
}

// The store's read handle outside any transaction.
export function sqliteRead(db: Database): Read { return new SqliteRead(db) as unknown as Read; }

// A transaction's handle for a body; the caller closes it when the transaction (or savepoint) settles. `nests`:
// false for a synchronous body's, whose savepoint refuses.
export function sqliteTx(db: Database, nests = true): RootTx {
  return new SqliteTx(db, nests) as unknown as RootTx;
}

// The connection a SQLite store function runs its statements on: refuses a closed `Tx`, and a handle from another
// store. It also refuses the store's `Read` from the task that holds the connection's open transaction (#807 P3 A7e2,
// D2): SQLite routes that read to the writer, so it would see the body's uncommitted rows, which a Postgres pool read
// never does. Such a caller passes its body's `Tx`. Another task's `Read`, while the holder awaits, reads committed
// state as before; so do a commit's `committed` callback and `afterCommit` effects, which run after it closes.
export function sqliteOf(r: Read): Database {
  if (r instanceof SqliteTx) { r.assertLive(); return r.db; }
  if (!(r instanceof SqliteRead)) throw new Error("not a SQLite store handle");
  if (ownsTx(r.db)) throw new Error("repo.read inside the caller's own transaction: pass the body's Tx (#807 D2)");
  return r.db;
}
