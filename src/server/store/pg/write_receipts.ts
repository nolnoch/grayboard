// The write receipts on Postgres (#807 P3 C6, docs/future/postgres-server.md D3 write dedup, D6): store/write_receipts.ts's
// WriteReceiptsStore, each method on its caller's handle through pgOf. The SQLite store (db.ts makeRepo's
// writeReceipts) is the reference, and its forms are already D3's (P2-2), so each holds without a lock:
// - claim is INSERT … ON CONFLICT DO NOTHING RETURNING: of two identical calls the second waits on the first's
//   uncommitted receipt, gets no row once it commits, and its find (a new statement) reads the filled receipt.
//   dedupWrite claims inside a savepoint, so a write that throws frees the key at ROLLBACK TO, not at the outer commit.
// - reclaim's UPDATE names the stale ref: a second reclaim waits, re-checks ref_id on the first's committed row and
//   matches nothing.
// - A prune racing a prune waits on the first's delete and then deletes nothing.
// What differs: every int8 (ref_id, at) maps through int8(); a DELETE's count is the result's `.count` (its row list is
// empty without RETURNING); result_json stays text, kept byte for byte (D6). No savepoints, and no 23505 can surface.
//
// Runtime imports stay off bun:sqlite and db.ts (pg/isolation.test.ts).
import type { WriteReceipt, WriteReceiptsStore } from "../write_receipts.ts";
import { int8 } from "./sql.ts";
import { pgOf } from "./tx.ts";

type Row = Record<string, unknown>;
const toReceipt = (r: Row): WriteReceipt => ({
  session: r.session as string, sender: r.sender as string, fp: r.fp as string, tool: r.tool as string,
  ref_kind: r.ref_kind as WriteReceipt["ref_kind"], ref_id: int8(r.ref_id), result_json: r.result_json as string, at: int8(r.at),
});

export function makePgWriteReceipts(): WriteReceiptsStore {
  return {
    async find(r, session, sender, fp, since) {
      const [row] = await pgOf(r)`SELECT session, sender, fp, tool, ref_kind, ref_id, result_json, at FROM write_receipts
        WHERE session = ${session} AND sender = ${sender} AND fp = ${fp} AND at > ${since}`;
      return row ? toReceipt(row) : undefined;
    },
    async claim(tx, key, tool, at) {
      // ref_id 0 names no row; ref_kind only satisfies the column's CHECK until `upsert` fills both.
      const rows: Row[] = await pgOf(tx)`INSERT INTO write_receipts (session, sender, fp, tool, ref_kind, ref_id, result_json, at)
        VALUES (${key.session}, ${key.sender}, ${key.fp}, ${tool}, 'message', 0, '', ${at})
        ON CONFLICT (session, sender, fp) DO NOTHING RETURNING 1 AS x`;
      return rows.length > 0;
    },
    async reclaim(tx, key, stale, at) {
      const rows: Row[] = await pgOf(tx)`UPDATE write_receipts SET ref_id = 0, result_json = '', at = ${at}
        WHERE session = ${key.session} AND sender = ${key.sender} AND fp = ${key.fp}
          AND ref_kind = ${stale.ref_kind} AND ref_id = ${stale.ref_id} RETURNING 1 AS x`;
      return rows.length > 0;
    },
    async upsert(tx, r) {
      await pgOf(tx)`INSERT INTO write_receipts (session, sender, fp, tool, ref_kind, ref_id, result_json, at)
        VALUES (${r.session}, ${r.sender}, ${r.fp}, ${r.tool}, ${r.ref_kind}, ${r.ref_id}, ${r.result_json}, ${r.at})
        ON CONFLICT (session, sender, fp) DO UPDATE SET
          tool = excluded.tool, ref_kind = excluded.ref_kind, ref_id = excluded.ref_id, result_json = excluded.result_json, at = excluded.at`;
    },
    async refExists(r, kind, id) {
      const sql = pgOf(r);
      const rows: Row[] = kind === "message"
        ? await sql`SELECT 1 AS x FROM messages WHERE id = ${id}`
        : await sql`SELECT 1 AS x FROM posts WHERE id = ${id}`;
      return rows.length > 0;
    },
    async pruneSession(tx, session, before) {
      const res = await pgOf(tx)`DELETE FROM write_receipts WHERE session = ${session} AND at <= ${before}`;
      return (res as { count: number }).count;
    },
    async prune(tx, before) {
      const res = await pgOf(tx)`DELETE FROM write_receipts WHERE at <= ${before}`;
      return (res as { count: number }).count;
    },
  };
}
