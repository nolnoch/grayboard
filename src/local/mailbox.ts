// Local mode's mail tables as session end reaches them (core/session_end.ts).
// Takes the database rather than importing db.ts, which opens this process's
// bus on import: the opener-time end runs on any open.
import type { Database } from "bun:sqlite";

import type { MailPort } from "../core/session_end.ts";

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
