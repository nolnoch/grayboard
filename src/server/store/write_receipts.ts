// The write receipts' row types and group interface (#807 P3 C67a, docs/future/postgres-server.md D2): what an append
// write's first call made, so a repeat replays it (src/server/write_dedup.ts), which Repo (db.ts) composes and the
// Postgres store (pg/) implements. Type-only imports, so a module under pg/ may import it (pg/isolation.test.ts); db.ts
// re-exports every name.
import type { Read, Tx } from "./tx_base.ts";

// An append write's receipt (#254): which row the first call made and the result it answered. result_json is kept
// byte for byte as written (a replay answers it as stored); a claim's placeholder has ref_id 0 and result_json ''.
export type WriteReceipt = {
  session: string; sender: string; fp: string; tool: string;
  ref_kind: "message" | "post"; ref_id: number; result_json: string; at: number;
};
export type WriteReceiptKey = Pick<WriteReceipt, "session" | "sender" | "fp">;

// dedupWrite runs claim, write, upsert and its audit row in one savepoint, so a write that throws leaves no receipt.
export interface WriteReceiptsStore {
  // The receipt for (session, sender, fp) written after `since`.
  find(r: Read, session: string, sender: string, fp: string, since: number): Promise<WriteReceipt | undefined>;
  // Takes (session, sender, fp) for a write about to run, as a placeholder the write's `upsert` fills in the same
  // transaction; false when a receipt for it exists (D3: one statement, so of two identical calls one claims it).
  claim(tx: Tx, key: WriteReceiptKey, tool: string, at: number): Promise<boolean>;
  // Takes over the receipt for `key` only while it still names `stale` (a row since retracted or pruned, #306);
  // false when another call replaced it first.
  reclaim(tx: Tx, key: WriteReceiptKey, stale: { ref_kind: "message" | "post"; ref_id: number }, at: number): Promise<boolean>;
  // Replaces any receipt for the same (session, sender, fp).
  upsert(tx: Tx, r: WriteReceipt): Promise<void>;
  // Whether the row a receipt names still exists (a retract or retention removes it).
  refExists(r: Read, kind: "message" | "post", id: number): Promise<boolean>;
  // Deletes receipts written at or before `before`: one session's, or all. Returns how many.
  pruneSession(tx: Tx, session: string, before: number): Promise<number>;
  prune(tx: Tx, before: number): Promise<number>;
}
