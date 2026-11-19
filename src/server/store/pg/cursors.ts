// The read points on Postgres (#807 P3 C6, docs/future/postgres-server.md D3, D6): store/cursors.ts's CursorsStore,
// each method on its caller's handle through pgOf. The SQLite store (db.ts makeRepo's cursors) is the reference; what
// differs, and why:
// - advance is one INSERT … ON CONFLICT … DO UPDATE with GREATEST (SQLite's two-argument MAX). A second advance waits on
//   the first's row or uncommitted insert, then applies GREATEST to the committed row, so the read point never moves
//   back in either order. A read then a write in JS would fail 23505 on a first insert and regress on an update.
// - last_seen_id is int8, a string from Bun.SQL: the reads map it to a number (a caller compares it with `>=`).
// - No savepoints, no locks: the reads lock nothing (retract re-reads the cursor under its own lock, C5).
//
// Runtime imports stay off bun:sqlite and db.ts (pg/isolation.test.ts).
import type { CursorsStore } from "../cursors.ts";
import { int8 } from "./sql.ts";
import { pgOf } from "./tx.ts";

export function makePgCursors(): CursorsStore {
  return {
    async get(r, address, streamType, streamRef) {
      const [row] = await pgOf(r)`SELECT last_seen_id FROM mailbox_cursors
        WHERE address = ${address} AND stream_type = ${streamType} AND stream_ref = ${streamRef}`;
      return row ? int8(row.last_seen_id) : 0;
    },
    async directFor(r, address) {
      const [row] = await pgOf(r)`SELECT last_seen_id FROM mailbox_cursors
        WHERE address = ${address} AND stream_type = 'direct' AND stream_ref = ${address}`;
      return row ? int8(row.last_seen_id) : 0;
    },
    async advance(tx, address, streamType, streamRef, messageId) {
      await pgOf(tx)`INSERT INTO mailbox_cursors (address, stream_type, stream_ref, last_seen_id)
        VALUES (${address}, ${streamType}, ${streamRef}, ${messageId})
        ON CONFLICT (address, stream_type, stream_ref)
        DO UPDATE SET last_seen_id = GREATEST(excluded.last_seen_id, mailbox_cursors.last_seen_id)`;
    },
  };
}
