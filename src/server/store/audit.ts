// The audit log's row type and group interface (#807 P3 C67a, docs/future/postgres-server.md D2): access_log, which
// Repo (db.ts) composes and the Postgres store (pg/) implements. Type-only imports, so a module under pg/ may import it
// (pg/isolation.test.ts); db.ts re-exports every name.
import type { Read, Tx } from "./tx_base.ts";

// detail: the row's JSON object as text (writeAudit stringifies, `last`'s callers parse), or null. A store that keeps
// it as a JSON type returns its text; spacing and key order may differ from what was written.
export type AccessLogRow = { at: number; actor: string | null; action: string; target: string | null; detail: string | null };

export interface AuditStore {
  // Synchronous on every store (#807 P3 A6h): writeAudit and recordDecision call it at ~100 sites, many in
  // synchronous code inside a body. What a store guarantees, whatever its mechanism:
  // - the row lands inside tx's transaction in program order, among the store-direct audit rows other groups write;
  // - a savepoint's row rolls back with the savepoint, and a body that throws keeps none;
  // - `last` on the same tx sees it before the commit;
  // - a write that fails aborts the transaction, so the body's commit fails rather than commit without the row;
  // - the row carries the origin (requestOrigin) of the request writing it, read when it is written.
  // A store whose statements are async (Postgres) sends the insert on tx's connection at once without awaiting it,
  // so the database orders it; it is never buffered to the commit, nor sent after it.
  // A settled tx, or a parent while its savepoint is open, throws synchronously. NUL and lone UTF-16 surrogates in
  // actor, target and every string of detail are stored as U+FFFD (jsonSafe, store/json_safe.ts): refusing them would
  // fail the audited action.
  write(tx: Tx, row: AccessLogRow): void;
  // The most recent row for this action+target by (at, id), for dedup windows and
  // "has this happened recently" checks. Undefined when none exists.
  last(r: Read, action: string, target: string): Promise<AccessLogRow | undefined>;
  // Serializes a read of `last` and the write it decides, per (action, target), until the body ends (#807 P3 C7
  // decision 5): owedBridgeNotice and the Slack bridge's stop take it before they read the last bridge.notified. A
  // no-op on SQLite (the single writer); an advisory lock on Postgres. Never inside a savepoint that may roll back.
  lock(tx: Tx, action: string, target: string): Promise<void>;
  // Deletes rows written before olderThanMs.
  prune(tx: Tx, olderThanMs: number): Promise<void>;
}
