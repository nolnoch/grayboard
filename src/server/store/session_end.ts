// The session end group's interface (#807 P3 C10d1, docs/future/postgres-server.md D2): a session's end and its ID's
// deliverability, which Repo (db.ts) composes and the Postgres store (pg/session_end.ts) implements. Type-only imports,
// so a module under pg/ may import it (pg/isolation.test.ts); db.ts re-exports every name.
import type { AuditSink } from "../../core/audit.ts";
import type { EndedSession } from "../../core/session_end.ts";
import type { Undeliverable } from "../../core/undeliverable.ts";
import type { Tx } from "./tx_base.ts";

// A session's end and its ID's deliverability (#807 P3 B4a), on the caller's handle.
export interface SessionEndStore {
  // Ends `id` and its children in the caller's transaction (core endSession over the server's mail, #284 decision 4):
  // holds and claims released, unread mail bounced, cursors and acks dropped. One method: its claim releases post
  // through core under the synchronous Access seam until B5b. SQLite only until C10d2 composes the end at the server:
  // the Postgres store's throws.
  end(tx: Tx, id: string, opts: { why: string; now: number; audit?: AuditSink }): Promise<EndedSession>;
  // Why `id` can't receive a send or @mention (core undeliverableId), or null. On the send's Tx: on Postgres it reads
  // the ID's row FOR KEY SHARE, the send side of an end's race (D3): an end's FOR UPDATE waits for the send, a send
  // waits for an end in flight and then reads it ended, and a presence touch blocks neither.
  refusal(tx: Tx, id: string): Promise<Undeliverable | null>;
  // Deletes the ended ids rows ended before `olderThanMs`, leaving a tombstone for each keyed one (a re-prune of an
  // ID with a tombstone already replaces its times) and dropping tombstones older than the horizon (core
  // pruneEndedIds); returns how many ids rows it deleted.
  pruneEnded(tx: Tx, olderThanMs: number, now: number): Promise<number>;
}
