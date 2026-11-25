// The read points' group interface (#807 P3 C67a, docs/future/postgres-server.md D2): how far each address has received
// a stream, which Repo (db.ts) composes and the Postgres store (pg/) implements. Type-only imports, so a module under
// pg/ may import it (pg/isolation.test.ts); db.ts re-exports every name.
import type { Read, Tx } from "./tx_base.ts";

export type CursorStream = "direct" | "team";

// Read points (#284), keyed by the reading address: how far it has received a stream (its direct messages,
// stream_ref = the address itself). Every read point is a number, 0 when absent.
export interface CursorsStore {
  get(r: Read, address: string, streamType: CursorStream, streamRef: string): Promise<number>;
  // How far an address has received its direct messages.
  directFor(r: Read, address: string): Promise<number>;
  // Moves the read point forward, never back: one upsert that keeps the larger id (D3), never a read then a write,
  // which two concurrent advances could interleave into a regression or a duplicate-key failure.
  advance(tx: Tx, address: string, streamType: CursorStream, streamRef: string, messageId: number): Promise<void>;
}
