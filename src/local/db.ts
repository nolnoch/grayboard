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
// pre-lanes rows are the default lane's, unchanged. A single range
// predicate (`>= id` and `< id$`, every identity char sorts above '$')
// matches the identity itself and every `identity#…` row and can use an
// index, unlike a substr prefix compare.
export function anyCursorFor(identity: string): number {
  const row = db
    .prepare(
      `SELECT MAX(last_seen_id) AS id FROM cursors
        WHERE reader >= ? AND reader < ? || '$'`,
    )
    .get(identity, identity) as { id: number | null } | undefined;
  return row?.id ?? 0;
}

// The pending-claim queries drive from dm_claims (CROSS JOIN pins the
// join order: a plain JOIN let the planner drive from messages and scan
// the recipient's whole history — ~5 ms at 100k messages). Driven from
// dm_claims, the partial index idx_dm_claims_pending bounds the clamp by
// the number of stuck claims instead (round-7 item 6; EXPLAIN-pinned in
// tests/integration/local.test.ts).
export const READ_POINT_SQL = `SELECT MIN(cl.message_id) AS id FROM dm_claims cl CROSS JOIN messages m ON m.id = cl.message_id
  WHERE cl.delivered_at IS NULL AND m.recipient = ?`;

/** The identity's read point, held back by any undelivered claim: a message
 * no agent has received must keep the read point before it, or a sibling's
 * later delivery would sync every lane past the stuck message and lose it
 * (D1). The clamp resolves itself: any draining lane takes an expired claim
 * over and delivers it. */
export function readPointFor(identity: string): number {
  const max = anyCursorFor(identity);
  const stuck = db.prepare(READ_POINT_SQL).get(identity) as { id: number | null } | undefined;
  return stuck?.id ? Math.min(max, stuck.id - 1) : max;
}

export const UNDELIVERED_BELOW_SQL = `SELECT 1 FROM dm_claims cl CROSS JOIN messages m ON m.id = cl.message_id
  WHERE cl.delivered_at IS NULL AND m.recipient = ? AND cl.message_id < ? LIMIT 1`;

/** True while an earlier message of `identity` is claimed but undelivered: a lane's cursor must not pass it (D1). */
export function undeliveredClaimBelow(identity: string, messageId: number): boolean {
  const row = db.prepare(UNDELIVERED_BELOW_SQL).get(identity, messageId);
  return !!row;
}

/** Whether a message carries a delivered claim (an agent received it, whatever the cursors say). */
export function hasDeliveredClaim(id: number): boolean {
  return !!db.prepare(`SELECT 1 FROM dm_claims WHERE message_id = ? AND delivered_at IS NOT NULL`).get(id);
}

/** Whether a message carries an undelivered claim (reserved, no agent has received it). */
export function hasUndeliveredClaim(id: number): boolean {
  return !!db.prepare(`SELECT 1 FROM dm_claims WHERE message_id = ? AND delivered_at IS NULL`).get(id);
}

/** Which lanes of an identity have read (acked) past `messageId`. */
export function lanesReadPast(identity: string, messageId: number): string[] {
  const rows = db
    .prepare(
      `SELECT reader FROM cursors
        WHERE last_seen_id >= ? AND (reader >= ? AND reader < ? || '$')`,
    )
    .all(messageId, identity, identity) as { reader: string }[];
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
// A message's claim decides when the cursors can't: an undelivered claim is
// reserved with no agent having received it (undelivered), a delivered claim
// reached an agent whatever a held-back cursor says (delivered).
export function undeliveredFrom(
  sender: string,
  olderThan = Infinity,
): { recipient: string; n: number; oldest_id: number }[] {
  return db
    .prepare(
      `SELECT m.recipient, COUNT(*) AS n, MIN(m.id) AS oldest_id FROM messages m
        WHERE m.sender = ? AND m.recipient != m.sender
          AND (
            (m.id > COALESCE((SELECT MAX(c.last_seen_id) FROM cursors c
                                WHERE c.reader >= m.recipient AND c.reader < m.recipient || '$'), 0)
             AND NOT EXISTS (SELECT 1 FROM dm_claims d WHERE d.message_id = m.id AND d.delivered_at IS NOT NULL))
            OR EXISTS (SELECT 1 FROM dm_claims d WHERE d.message_id = m.id AND d.delivered_at IS NULL)
          )
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
    m.sender === identity && m.recipient !== identity
      ? { ...m, delivered: (anyCursorFor(m.recipient) >= m.id || hasDeliveredClaim(m.id)) && !hasUndeliveredClaim(m.id) }
      : m,
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
// released on delivery: a sibling whose scan predates the winner's mark must
// still see it claimed or it re-delivers). DELIVERED rows outlive any
// conceivable concurrent scan by this much; then go — but only at or below
// the recipient's clamped read point (pruneDmClaims): above it they survive
// any age, held back with the read point by a stuck undelivered claim. An
// UNdelivered row is never pruned — it holds the identity's read point until
// a lane takes it over past its TTL and delivers it (D1).
export const DM_CLAIM_RETENTION_MS = 24 * 3_600_000;

export type ClaimOutcome = "claimed" | "skip" | "delivered";

/**
 * Atomically claim DM `id` for `claimer` (a lane's stream key).
 * - `"claimed"`: this caller now owns the delivery — the message was
 *   unclaimed, its previous claim is past the TTL (the claimer died
 *   mid-handle), or it was the caller's OWN lane's claim (a same-lane
 *   restart reclaims its unfinished work immediately).
 * - `"delivered"`: the message already reached an agent (delivered_at set) —
 *   don't notify, just catch the cursor up.
 * - `"skip"`: a live sibling claim holds it — don't touch the cursor
 *   (advancing past it would move the identity's read point before the
 *   message has reached an agent).
 */
export function claimDm(id: number, claimer: string, ttlMs = DM_CLAIM_TTL_MS): ClaimOutcome {
  const now = Date.now();
  return db.transaction(() => {
    const r = db
      .prepare(`INSERT OR IGNORE INTO dm_claims (message_id, claimer, claimed_at) VALUES (?, ?, ?)`)
      .run(id, claimer, now);
    if (r.changes > 0) return "claimed";
    const row = db.prepare(`SELECT claimer, claimed_at, delivered_at FROM dm_claims WHERE message_id = ?`).get(id) as
      | { claimer: string; claimed_at: number; delivered_at: number | null }
      | undefined;
    if (!row) return "claimed"; // pruned between the two statements: claim it
    if (row.delivered_at !== null) return "delivered";
    if (row.claimer === claimer) {
      // The caller's own lane restarts into its own stuck claim: reclaim it
      // now (a fresh TTL window for another crash), don't wait out a sibling
      // TTL for work this session already owns.
      db.prepare(`UPDATE dm_claims SET claimed_at = ? WHERE message_id = ?`).run(now, id);
      return "claimed";
    }
    if (now - row.claimed_at < ttlMs) return "skip";
    // Expired: take it over, compare-and-set on the row we read.
    const t = db
      .prepare(`UPDATE dm_claims SET claimer = ?, claimed_at = ? WHERE message_id = ? AND claimer = ? AND claimed_at = ?`)
      .run(claimer, now, id, row.claimer, row.claimed_at);
    return t.changes > 0 ? "claimed" : "skip";
  })();
}

/** The claim's message reached an agent (called after the notification). */
export function markClaimDelivered(id: number): void {
  db.prepare(`UPDATE dm_claims SET delivered_at = ? WHERE message_id = ? AND delivered_at IS NULL`).run(Date.now(), id);
}

/**
 * Delivered-marker rows no future scan can reach: past the retention
 * window AND at or below the recipient's clamped read point. Every drain
 * syncs its lane's cursor up to the read point before scanning, so no scan
 * starts below it — deleting below it is safe. A marker ABOVE the read
 * point survives any age: a stuck undelivered claim holds the read point
 * back, and the lane that later takes that claim over must still find the
 * later messages marked delivered, or it re-delivers them (round-6 item 1).
 */
export const PRUNE_DISTINCT_SQL = `SELECT DISTINCT m.recipient AS r FROM dm_claims d CROSS JOIN messages m ON m.id = d.message_id
  WHERE d.delivered_at IS NOT NULL AND d.claimed_at < ?`;

export function pruneDmClaims(now = Date.now()): void {
  const aged = now - DM_CLAIM_RETENTION_MS;
  const rows = db.prepare(PRUNE_DISTINCT_SQL).all(aged) as { r: string }[];
  for (const { r } of rows) {
    db.prepare(
      `DELETE FROM dm_claims WHERE delivered_at IS NOT NULL AND claimed_at < ?
         AND message_id IN (SELECT m.id FROM messages m WHERE m.recipient = ? AND m.id <= ?)`,
    ).run(aged, r, readPointFor(r));
  }
}

export const NEXT_EXPIRY_SQL = `SELECT MIN(cl.claimed_at) AS t FROM dm_claims cl CROSS JOIN messages m ON m.id = cl.message_id
  WHERE cl.delivered_at IS NULL AND m.recipient = ?`;

/**
 * The expiry moment of the identity's oldest undelivered claim — when a
 * drain that skipped the claim may take it over. The claimed row itself is
 * the pending signal, so the moment may already be in the past (the claimer
 * died, or the claim expired mid-drain); the caller clamps the wait to
 * >= 0, so an expired undelivered claim arms an immediate retry (round-8
 * N1: with the old `claimed_at > now - ttl` filter an expired claim read
 * null, and a first skip whose tail spanned the expiry armed nothing at
 * all). Null means no undelivered claim exists — nothing pending, so
 * clearing any armed retry is safe.
 */
export function nextClaimExpiry(identity: string, ttlMs = DM_CLAIM_TTL_MS): number | null {
  const row = db.prepare(NEXT_EXPIRY_SQL).get(identity) as { t: number | null } | undefined;
  return row?.t == null ? null : row.t + ttlMs;
}

/**
 * The newest message before `beforeId` that `a` sent to `b` — the previous
 * message ADDRESSED TO the recipient, not any message in the pair: a reply
 * from `b` sits above `b`'s receive cursor forever, so a bidirectional
 * compare hides the read state after the first back-and-forth (N4). Message
 * ids are global, so "caught up to just before this message" must compare
 * against the pair's own previous id, not `beforeId - 1` (an unrelated pair
 * may hold that one).
 */
export function previousBetween(a: string, b: string, beforeId: number): number {
  const row = db
    .prepare(
      `SELECT MAX(id) AS id FROM messages
        WHERE id < ? AND sender = ? AND recipient = ?`,
    )
    .get(beforeId, a, b) as { id: number | null } | undefined;
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
