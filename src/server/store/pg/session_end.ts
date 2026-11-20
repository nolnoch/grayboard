// The session end store on Postgres (#807 P3 C10d1, docs/future/postgres-server.md D3, D6): store/session_end.ts's
// SessionEndStore, each method on its caller's handle through pgOf. The SQLite store (db.ts makeRepo's sessionEnd,
// over core/session_end.ts's undeliverableId and core/boards.ts's pruneEndedIds) is the reference; what differs, and
// why:
// - refusal reads the recipient's ids row FOR KEY SHARE, on the send's Tx: an end's SELECT … FOR UPDATE of that row
//   waits for the send (and its unread read then sees the message), and a send after the end waits for it and reads
//   it ended. KEY SHARE, not SHARE: a presence touch (UPDATE ids SET last_seen) takes FOR NO KEY UPDATE, which
//   conflicts with SHARE, so every send to an ID would wait behind its touches. The decision over the row is core's
//   (core/undeliverable.ts undeliverableFrom); a child's root primary is read unlocked.
// - pruneEnded is three statements on the caller's Tx with no nested transaction: a keyed row's tombstone is an
//   upsert (ON CONFLICT (id) DO UPDATE, SQLite's INSERT OR REPLACE), keyed and viewer are booleans, and the count is
//   the DELETE's. Its DELETE of an ended row waits on a send's KEY SHARE, and that send has read the ID ended.
// - end (the row-level step of the server's composed end, src/server/session_end.ts, #807 P3 C10d2-b) locks the ID's
//   row SELECT … FOR UPDATE first: a send's or take's FOR KEY SHARE (refusal, bindings.lockLive) conflicts with it, as
//   a plain UPDATE of ended_at (FOR NO KEY UPDATE) would not (probe B5), so the end waits for an in-flight send, take,
//   claim or child registration and then reads what it wrote, and one that comes after waits and reads the ID ended.
//   Then, each a statement of its own so each reads after the lock was granted: the holds, the guarded UPDATE (its
//   `ended_at IS NULL` is what makes a second end, waiting on the first's lock, return null), and the unended children
//   locked FOR UPDATE by id, so every ids row the end will write is locked before any other row it touches (the lock
//   order in session_end.ts's header). held_aliases_json is bound as text and cast, so it is a jsonb array.
//
// Runtime imports stay off bun:sqlite, db.ts and core's SQLite modules (pg/isolation.test.ts): the SQL is restated.
import { undeliverableFrom } from "../../../core/undeliverable.ts";
import type { SessionEndStore } from "../session_end.ts";
import { int8, int8OrNull } from "./sql.ts";
import { pgOf, type PgSql } from "./tx.ts";

// core/boards.ts TOMBSTONE_HORIZON_MS (#333): how long a pruned keyed ID's tombstone is kept. The Postgres contract test
// pins the two equal (pg/session_end.contract.pg.test.ts).
export const TOMBSTONE_HORIZON_MS = 365 * 24 * 60 * 60 * 1000;

type Row = Record<string, unknown>;

// core/session_end.ts rootPrimary: the root's oldest hold (core HOLD_ORDER), else its writes_as, else (once ended)
// the first alias it held, else its ID.
async function rootPrimary(sql: PgSql, root: string): Promise<string> {
  const [hold]: Row[] = await sql`SELECT address FROM alias_holds WHERE id = ${root} ORDER BY bound_at, address LIMIT 1`;
  if (hold) return hold.address as string;
  const [r]: Row[] = await sql`SELECT ended_at, held_aliases_json, writes_as FROM ids WHERE id = ${root}`;
  if (r?.writes_as) return r.writes_as as string;
  const held = r && r.ended_at !== null ? heldAliases(r.held_aliases_json) : [];
  return held[0] ?? root;
}

// held_aliases_json as the aliases an ended ID held: a jsonb array, else none (NULL, or any other jsonb value).
const heldAliases = (v: unknown): string[] => Array.isArray(v) ? v as string[] : [];

export function makePgSessionEnd(): SessionEndStore {
  return {
    async end(tx, id, now) {
      const sql = pgOf(tx);
      const [row]: Row[] = await sql`SELECT principal FROM ids WHERE id = ${id} FOR UPDATE`;
      const held = [...new Set((await sql`SELECT address FROM alias_holds WHERE id = ${id} ORDER BY bound_at, address COLLATE "C"` as Row[])
        .map(r => r.address as string))];
      // No row: nothing to mark, and the rest of the end runs as core's does (principal null).
      if (row && !(await sql`UPDATE ids SET ended_at = ${now}::int8, held_aliases_json = ${JSON.stringify(held)}::text::jsonb
          WHERE id = ${id} AND ended_at IS NULL RETURNING 1`).length) return null;
      const children = (await sql`SELECT id FROM ids WHERE root_id = ${id} AND ended_at IS NULL ORDER BY id FOR UPDATE` as Row[]).map(r => r.id as string);
      return { principal: (row?.principal as string | null | undefined) ?? null, held, children };
    },
    async refusal(tx, id) {
      const sql = pgOf(tx);
      const [r]: Row[] = await sql`SELECT ended_at, held_aliases_json, delivery, writes_as, viewer, root_id FROM ids WHERE id = ${id} FOR KEY SHARE`;
      const primary = r && !r.viewer && r.root_id !== null ? await rootPrimary(sql, r.root_id as string) : undefined;
      return undeliverableFrom(id, r ? {
        ended_at: int8OrNull(r.ended_at),
        held: () => heldAliases(r.held_aliases_json),
        delivery: r.delivery as string,
        writes_as: r.writes_as as string | null,
        viewer: r.viewer as boolean,
        root_id: r.root_id as string | null,
      } : null, () => primary!);
    },
    async pruneEnded(tx, olderThanMs, now) {
      const sql = pgOf(tx);
      await sql`INSERT INTO pruned_ids (id, ended_at, pruned_at) SELECT id, ended_at, ${now}::int8 FROM ids WHERE ended_at < ${olderThanMs}::int8 AND keyed
        ON CONFLICT (id) DO UPDATE SET ended_at = EXCLUDED.ended_at, pruned_at = EXCLUDED.pruned_at`;
      await sql`DELETE FROM pruned_ids WHERE pruned_at < ${now - TOMBSTONE_HORIZON_MS}::int8`;
      const res = await sql`DELETE FROM ids WHERE ended_at < ${olderThanMs}::int8`;
      return int8((res as { count: number }).count);
    },
  };
}
