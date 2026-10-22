import { openLocalDb } from "./open.ts";
import { MAIN_LANE } from "../core/boards.ts";

export const db = openLocalDb();

export type Message = {
  id: number;
  sender: string;
  recipient: string;
  body: string;
  parent_id: number | null;
  created_at: number;
  pending: number;
};

export function insertMessage(
  sender: string,
  recipient: string,
  body: string,
  parent_id: number | null,
  pending = false,
): number {
  const now = Date.now();
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO messages (sender, recipient, body, parent_id, created_at, pending)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(sender, recipient, body, parent_id, now, pending ? 1 : 0);
  return Number(lastInsertRowid);
}

// Messages for the reader's identity past ITS cursor. `reader` is the lane's
// stream key (the identity for the default lane, `identity#lane` otherwise:
// identities are [a-z0-9_-], so the first `#` splits them); the messages
// themselves route by the identity.
export function unreadFor(reader: string): Message[] {
  const identity = reader.split("#")[0]!;
  const cursor = getCursor(reader);
  return db
    .prepare(
      `SELECT * FROM messages
       WHERE recipient = ? AND id > ?
       ORDER BY id ASC`,
    )
    .all(identity, cursor) as Message[];
}

export function getCursor(reader: string): number {
  const row = db
    .prepare(`SELECT last_seen_id FROM cursors WHERE reader = ?`)
    .get(reader) as { last_seen_id: number } | undefined;
  return row?.last_seen_id ?? 0;
}

// How far an identity has received its DMs across every lane of its fleet
// (a lane reading is the identity reading). Lanes keep their own cursors
// (`identity` for the default lane, `identity#<lane>` for the rest); the
// pre-lanes rows are the default lane's, unchanged. The range predicate
// (`>= id#` and `< id$`, '#' < '$') matches every `identity#…` row and can
// use an index, unlike a substr prefix compare.
export function anyCursorFor(identity: string): number {
  const row = db
    .prepare(
      `SELECT MAX(last_seen_id) AS id FROM cursors
        WHERE reader = ? OR (reader >= ? || '#' AND reader < ? || '$')`,
    )
    .get(identity, identity, identity) as { id: number | null } | undefined;
  return row?.id ?? 0;
}

/** Which lanes of an identity have read (acked) past `messageId`. */
export function lanesReadPast(identity: string, messageId: number): string[] {
  const rows = db
    .prepare(
      `SELECT reader FROM cursors
        WHERE last_seen_id >= ? AND (reader = ? OR (reader >= ? || '#' AND reader < ? || '$'))`,
    )
    .all(messageId, identity, identity, identity) as { reader: string }[];
  return rows.map((r) => (r.reader === identity ? MAIN_LANE : r.reader.slice(identity.length + 1)));
}

export function setCursor(reader: string, last_seen_id: number): void {
  db.prepare(
    `INSERT INTO cursors (reader, last_seen_id)
     VALUES (?, ?)
     ON CONFLICT(reader) DO UPDATE SET last_seen_id = excluded.last_seen_id
     WHERE excluded.last_seen_id > cursors.last_seen_id`,
  ).run(reader, last_seen_id);
}

export function getMessage(id: number): Message | undefined {
  return db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as
    | Message
    | undefined;
}

// The whole thread containing message `id`: walk up to its root, then down.
export function getThread(id: number): Message[] {
  return db
    .prepare(
      `WITH RECURSIVE up(id, parent_id) AS (
         SELECT id, parent_id FROM messages WHERE id = ?
         UNION ALL
         SELECT m.id, m.parent_id FROM messages m JOIN up ON m.id = up.parent_id
       ),
       thread AS (
         SELECT * FROM messages WHERE id = (SELECT id FROM up WHERE parent_id IS NULL)
         UNION ALL
         SELECT m.* FROM messages m
         JOIN thread t ON m.parent_id = t.id
       )
       SELECT * FROM thread ORDER BY id ASC`,
    )
    .all(id) as Message[];
}

// Messages `sender` sent that haven't reached the recipient's session yet
// (past its cursor), per recipient. olderThan: only count those sent before it.
export function undeliveredFrom(
  sender: string,
  olderThan = Infinity,
): { recipient: string; n: number; oldest_id: number }[] {
  return db
    .prepare(
      `SELECT m.recipient, COUNT(*) AS n, MIN(m.id) AS oldest_id FROM messages m
        WHERE m.sender = ? AND m.recipient != m.sender
          AND m.id > COALESCE((SELECT MAX(c.last_seen_id) FROM cursors c
                                WHERE c.reader = m.recipient
                                   OR (c.reader >= m.recipient || '#' AND c.reader < m.recipient || '$')), 0)
          AND m.created_at < ?
        GROUP BY m.recipient ORDER BY m.recipient`,
    )
    .all(sender, Number.isFinite(olderThan) ? olderThan : Number.MAX_SAFE_INTEGER) as {
    recipient: string;
    n: number;
    oldest_id: number;
  }[];
}

// Rows you sent carry delivered: whether they've reached the recipient's session.
export function getHistory(
  identity: string,
  peer: string | undefined,
  limit: number,
  beforeId: number | undefined,
): (Message & { delivered?: boolean })[] {
  const clauses: string[] = [];
  const args: (string | number)[] = [];

  if (peer) {
    clauses.push(
      `((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?))`,
    );
    args.push(identity, peer, peer, identity);
  } else {
    clauses.push(`(sender = ? OR recipient = ?)`);
    args.push(identity, identity);
  }

  if (beforeId !== undefined) {
    clauses.push(`id < ?`);
    args.push(beforeId);
  }

  const sql = `
    SELECT * FROM messages
    WHERE ${clauses.join(" AND ")}
    ORDER BY id DESC
    LIMIT ?
  `;
  args.push(limit);
  const rows = db.prepare(sql).all(...args) as Message[];
  return rows.reverse().map((m) =>
    m.sender === identity && m.recipient !== identity ? { ...m, delivered: anyCursorFor(m.recipient) >= m.id } : m,
  );
}

export function ackMessage(reader: string, id: number): void {
  db.prepare(`INSERT OR IGNORE INTO dm_acks (reader, message_id, acked_at) VALUES (?, ?, ?)`).run(reader, id, Date.now());
}

// How long an in-flight DM claim holds before another lane may take the
// message over (the claimer crashed mid-handle). Generous against a claimer
// that is merely slow or briefly SIGSTOPped; a takeover past it re-delivers,
// which is the safe direction.
export const DM_CLAIM_TTL_MS = 30_000;

// A delivered message's claim row stays as its delivery marker (it is never
// released on delivery: a sibling whose scan predates the winner's ack must
// still see "claimed" or it re-delivers). Rows outlive any conceivable
// concurrent scan by this much, then go — a lane this far behind has synced
// from the read point long since.
export const DM_CLAIM_RETENTION_MS = 24 * 3_600_000;

/**
 * Atomically claim DM `id` for `claimer` (a lane's stream key). True when
 * this caller now owns the delivery: the message was unclaimed, or its
 * previous claim is past the TTL (the claimer died mid-handle). False when a
 * live claim holds it — a sibling lane is delivering, skip without touching
 * the cursor (advancing past it would move the identity's read point before
 * the message has reached an agent). The row persists after delivery as the
 * marker that keeps slower siblings from re-delivering; see RETENTION.
 */
export function claimMessage(id: number, claimer: string, ttlMs = DM_CLAIM_TTL_MS): boolean {
  const now = Date.now();
  return db.transaction(() => {
    const r = db
      .prepare(`INSERT OR IGNORE INTO dm_claims (message_id, claimer, claimed_at) VALUES (?, ?, ?)`)
      .run(id, claimer, now);
    if (r.changes > 0) return true;
    const row = db.prepare(`SELECT claimer, claimed_at FROM dm_claims WHERE message_id = ?`).get(id) as
      | { claimer: string; claimed_at: number }
      | undefined;
    if (!row || now - row.claimed_at < ttlMs) return false;
    // Expired: take it over, compare-and-set on the row we read.
    const t = db
      .prepare(`UPDATE dm_claims SET claimer = ?, claimed_at = ? WHERE message_id = ? AND claimer = ? AND claimed_at = ?`)
      .run(claimer, now, id, row.claimer, row.claimed_at);
    return t.changes > 0;
  })();
}

/** Delivery-marker rows old enough that no live scan can still hold their message. */
export function pruneDmClaims(now = Date.now()): void {
  db.prepare(`DELETE FROM dm_claims WHERE claimed_at < ?`).run(now - DM_CLAIM_RETENTION_MS);
}

/**
 * The newest message before `beforeId` between `a` and `b` (either
 * direction), or 0 when this is their first. Message ids are global, so
 * "caught up to just before this message" must compare against the pair's
 * own previous id, not `beforeId - 1` (an unrelated pair may hold that one).
 */
export function previousBetween(a: string, b: string, beforeId: number): number {
  const row = db
    .prepare(
      `SELECT MAX(id) AS id FROM messages
        WHERE id < ?
          AND ((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?))`,
    )
    .get(beforeId, a, b, b, a) as { id: number | null } | undefined;
  return row?.id ?? 0;
}

// Messages to `reader` since `since` that it hasn't acked, oldest first.
export function receivedUnacked(reader: string, since: number): Message[] {
  return db
    .prepare(
      `SELECT * FROM messages m
        WHERE m.recipient = ? AND m.sender != m.recipient AND m.created_at >= ?
          AND NOT EXISTS (SELECT 1 FROM dm_acks a WHERE a.reader = m.recipient AND a.message_id = m.id)
        ORDER BY m.id ASC`,
    )
    .all(reader, since) as Message[];
}

// Messages `sender` sent pending since `since` that it hasn't acked, oldest first.
export function sentPending(sender: string, since: number): Message[] {
  return db
    .prepare(
      `SELECT * FROM messages m
        WHERE m.sender = ? AND m.pending = 1 AND m.created_at >= ?
          AND NOT EXISTS (SELECT 1 FROM dm_acks a WHERE a.reader = m.sender AND a.message_id = m.id)
        ORDER BY m.id ASC`,
    )
    .all(sender, since) as Message[];
}

// Deletes a message `sender` sent that the recipient's session hasn't received
// (it's past their cursor) and that has no reply, which would still point at
// it. False if any of that doesn't hold.
export function retractMessage(sender: string, id: number): boolean {
  return db.transaction(() => {
    const { changes } = db
      .prepare(
        `DELETE FROM messages WHERE id = ? AND sender = ?
           AND id > COALESCE((SELECT last_seen_id FROM cursors WHERE reader = messages.recipient), 0)
           AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.parent_id = messages.id)`,
      )
      .run(id, sender);
    if (changes) db.prepare(`DELETE FROM dm_acks WHERE message_id = ?`).run(id);
    return changes > 0;
  })();
}
