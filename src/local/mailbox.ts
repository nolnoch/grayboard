// Local mode's mail tables as session end reaches them (core/session_end.ts).
// Takes the database rather than importing db.ts, which opens this process's
// bus on import: the opener-time end runs on any open.
import type { Database } from "bun:sqlite";

import type { MailPort } from "../core/session_end.ts";

// The reader's lowest undelivered DM between its cursor and an id (?2).
export const DM_GAP_SQL =
  `SELECT MIN(m.id) AS gap FROM messages m
   WHERE m.recipient = ?1 AND m.delivered_at IS NULL AND m.id < ?2
     AND m.id > COALESCE((SELECT last_seen_id FROM cursors WHERE reader = ?1), 0)`;

// The harness was handed DM `id` for `reader`: stamps its delivery time once
// and moves the reader's cursor, in one transaction. The cursor stops below
// any of the reader's undelivered DMs between it and `id`: a 1.x case merge
// (#216) can give the reader such a DM, with its cursor lowered to reach it,
// while a push of `id` is in flight; moving past it would skip it (#1192).
export function markDmDelivered(db: Database, reader: string, id: number, at = Date.now()): void {
  db.transaction(() => {
    db.prepare(`UPDATE messages SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL`).run(at, id);
    const row = db.prepare(DM_GAP_SQL).get(reader, id) as { gap: number | null };
    const to = row.gap === null ? id : row.gap - 1;
    db.prepare(
      `INSERT INTO cursors (reader, last_seen_id)
       VALUES (?, ?)
       ON CONFLICT(reader) DO UPDATE SET last_seen_id = excluded.last_seen_id
       WHERE excluded.last_seen_id > cursors.last_seen_id`,
    ).run(reader, to);
  }).immediate();
}

export function localMail(db: Database): MailPort {
  return {
    unread(id) {
      return db.prepare(
        `SELECT m.id, m.sender FROM messages m
         WHERE m.recipient = ?1 AND m.sender <> ?1
           AND m.id > COALESCE((SELECT last_seen_id FROM cursors WHERE reader = ?1), 0)
         ORDER BY m.id`,
      ).all(id) as { id: number; sender: string }[];
    },
    bounce(from, to, parentId, body, now) {
      db.prepare(
        `INSERT INTO messages (sender, sender_id, recipient, body, parent_id, created_at, pending, kind)
         VALUES (?1, ?1, ?2, ?3, ?4, ?5, 0, 'bounce')`,
      ).run(from, to, body, parentId, now);
    },
    dropReader(id) {
      db.prepare(`DELETE FROM cursors WHERE reader = ?`).run(id);
      db.prepare(`DELETE FROM dm_acks WHERE reader = ?`).run(id);
    },
  };
}
