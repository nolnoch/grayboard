// The session end group's interface (#807 P3 C10d1, docs/future/postgres-server.md D2): a session's end and its ID's
// deliverability, which Repo (db.ts) composes and the Postgres store (pg/session_end.ts) implements. Type-only imports,
// so a module under pg/ may import it (pg/isolation.test.ts); db.ts re-exports every name.
import type { CoreAuditAction } from "../../core/audit.ts";
import type { EndedSession } from "../../core/session_end.ts";
import type { Undeliverable } from "../../core/undeliverable.ts";
import type { Tx } from "./tx_base.ts";

// The row-level step of a session's end (#807 P3 C10d2-a): the principal the ended row named (null: no row), the
// aliases it held, oldest hold first (HOLD_ORDER), and its unended children, by id.
export type EndedRow = { principal: string | null; held: string[]; children: string[] };

// Where a session end's id.ended row goes, awaited (#807 P3 C10 Q3): access_log on the end's Tx.
export type EndAuditSink = (action: CoreAuditAction, actor: string, target: string | null, detail?: Record<string, unknown>) => Promise<void>;

// A whole session end (src/server/session_end.ts endSessionServer, composed over the Repo's groups), as a port: what
// the hosted store ends a released child's ID through, on either backend, closing over the Repo and the board access
// so a store module imports no application code. It may wait on row locks held by in-flight writes for the ended IDs
// (claims, messages, aliases, attachments); on Postgres `lock_timeout` bounds the wait (c10-scope §7 Q9).
export type SessionEndPort = {
  end(tx: Tx, id: string, opts: { why: string; now: number; audit: EndAuditSink }): Promise<EndedSession>;
};

// A session's end and its ID's deliverability (#807 P3 B4a), on the caller's handle.
export interface SessionEndStore {
  // The end's row-level step, in the caller's transaction: locks `id`'s row and marks it ended at `now` with the
  // aliases it holds; null, writing nothing, when it had already ended. An ID with no row ends with nothing to mark
  // (principal null), as core endSession does. The rest of the end (bounces, claims, holds, children, audit) is the
  // server's composition over the other groups (src/server/session_end.ts), not the store's.
  end(tx: Tx, id: string, now: number): Promise<EndedRow | null>;
  // Why `id` can't receive a send or @mention (core undeliverableId), or null. On the send's Tx: on Postgres it reads
  // the ID's row FOR KEY SHARE, the send side of an end's race (D3): an end's FOR UPDATE waits for the send, a send
  // waits for an end in flight and then reads it ended, and a presence touch blocks neither.
  refusal(tx: Tx, id: string): Promise<Undeliverable | null>;
  // Deletes the ended ids rows ended before `olderThanMs`, leaving a tombstone for each keyed one (a re-prune of an
  // ID with a tombstone already replaces its times) and dropping tombstones older than the horizon (core
  // pruneEndedIds); returns how many ids rows it deleted.
  pruneEnded(tx: Tx, olderThanMs: number, now: number): Promise<number>;
}
