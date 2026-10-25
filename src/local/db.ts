import { openLocalDb } from "./open.ts";
import { SqliteBlobs } from "./blobs.ts";
import { bindAttachments, dropAttachments, releaseUpload, storeAttachment, withAttachments } from "../core/attachments.ts";
import { DEFAULT_ATTACHMENT_LIMITS, type AttachmentFile, type AttachmentInfo } from "../shared/attachments.ts";
import { lastCoreAudit, writeCoreAudit } from "../core/audit.ts";

export const db = openLocalDb();
export const blobs = new SqliteBlobs(db);

// Stores files as `uploader`'s unbound uploads, then runs `send`, a write
// that binds them in its own transaction. If it throws, the uploads go again.
export async function withUploads<T>(uploader: string, files: AttachmentFile[], send: (ids: number[]) => T): Promise<T> {
  const ids: number[] = [];
  try {
    for (const f of files) ids.push((await storeAttachment(db, blobs, uploader, f)).id);
    return send(ids);
  } catch (e) {
    for (const id of ids) await releaseUpload(db, blobs, id, uploader);
    throw e;
  }
}

export type Message = {
  id: number;
  sender: string;
  recipient: string;
  body: string;
  parent_id: number | null;
  created_at: number;
  pending: number;
  // Present on reads when the message carries files.
  attachments?: AttachmentInfo[];
};

// A message's columns as readers see them. sender_id (#284) is the sending
// session's provenance, kept in the database and left out of reads.
const MSG_COLS = `id, sender, recipient, body, parent_id, created_at, pending`;
const M_MSG_COLS = `m.id, m.sender, m.recipient, m.body, m.parent_id, m.created_at, m.pending`;

// Stores the message from session `senderId` (null from a tools-only
// process, which has no session row) and binds the sender's uploads
// `ids` to it, in one transaction.
export function insertMessage(
  sender: string,
  senderId: string | null,
  recipient: string,
  body: string,
  parent_id: number | null,
  pending = false,
  ids: number[] = [],
): { id: number; attachments: AttachmentInfo[] } {
  return db.transaction(() => {
    const now = Date.now();
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO messages (sender, sender_id, recipient, body, parent_id, created_at, pending)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(sender, senderId, recipient, body, parent_id, now, pending ? 1 : 0);
    const id = Number(lastInsertRowid);
    return { id, attachments: bindAttachments(db, ids, sender, { message_id: id }, DEFAULT_ATTACHMENT_LIMITS) };
  }).immediate();
}

export function unreadFor(reader: string): Message[] {
  const cursor = getCursor(reader);
  return withAttachments(
    db,
    "message",
    db
      .prepare(
        `SELECT ${MSG_COLS} FROM messages
         WHERE recipient = ? AND id > ?
         ORDER BY id ASC`,
      )
      .all(reader, cursor) as Message[],
  );
}

export function getCursor(reader: string): number {
  const row = db
    .prepare(`SELECT last_seen_id FROM cursors WHERE reader = ?`)
    .get(reader) as { last_seen_id: number } | undefined;
  return row?.last_seen_id ?? 0;
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
  return db.prepare(`SELECT ${MSG_COLS} FROM messages WHERE id = ?`).get(id) as
    | Message
    | undefined;
}

// The whole thread containing message `id`: walk up to its root, then down.
export function getThread(id: number): Message[] {
  return withAttachments(db, "message", threadRows(id));
}

function threadRows(id: number): Message[] {
  return db
    .prepare(
      `WITH RECURSIVE up(id, parent_id) AS (
         SELECT id, parent_id FROM messages WHERE id = ?
         UNION ALL
         SELECT m.id, m.parent_id FROM messages m JOIN up ON m.id = up.parent_id
       ),
       thread AS (
         SELECT ${MSG_COLS} FROM messages WHERE id = (SELECT id FROM up WHERE parent_id IS NULL)
         UNION ALL
         SELECT ${M_MSG_COLS} FROM messages m
         JOIN thread t ON m.parent_id = t.id
       )
       SELECT * FROM thread ORDER BY id ASC`,
    )
    .all(id) as Message[];
}

// Messages `sender` sent that haven't reached the recipient's session yet
// (past its read point), per recipient. olderThan: only count those sent before it.
// The read point is the last delivered-and-handled message id (cursors.last_seen_id);
// unread = `id > read point` — a message is counted undelivered iff `id > read point`.
// Exported so the EXPLAIN pin asserts the plan of the exact statement the code executes.
export const LOCAL_UNDELIVERED_FROM_SQL = `SELECT m.recipient, COUNT(*) AS n, MIN(m.id) AS oldest_id FROM messages m
        LEFT JOIN cursors c ON c.reader = m.recipient
        WHERE m.sender = ? AND m.recipient != m.sender
          AND m.id > COALESCE(c.last_seen_id, 0) AND m.created_at < ?
        GROUP BY m.recipient ORDER BY m.recipient`;
export function undeliveredFrom(
  sender: string,
  olderThan = Infinity,
): { recipient: string; n: number; oldest_id: number }[] {
  return db
    .prepare(LOCAL_UNDELIVERED_FROM_SQL)
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
    SELECT ${MSG_COLS} FROM messages
    WHERE ${clauses.join(" AND ")}
    ORDER BY id DESC
    LIMIT ?
  `;
  args.push(limit);
  const rows = withAttachments(db, "message", db.prepare(sql).all(...args) as Message[]);
  return rows.reverse().map((m) =>
    m.sender === identity && m.recipient !== identity ? { ...m, delivered: getCursor(m.recipient) >= m.id } : m,
  );
}

export function ackMessage(reader: string, id: number): void {
  db.prepare(`INSERT OR IGNORE INTO dm_acks (reader, message_id, acked_at) VALUES (?, ?, ?)`).run(reader, id, Date.now());
}

// Messages to `reader` since `since` that it hasn't acked, oldest first.
export function receivedUnacked(reader: string, since: number): Message[] {
  return withAttachments(db, "message", db
    .prepare(
      `SELECT ${M_MSG_COLS} FROM messages m
        WHERE m.recipient = ? AND m.sender != m.recipient AND m.created_at >= ?
          AND NOT EXISTS (SELECT 1 FROM dm_acks a WHERE a.reader = m.recipient AND a.message_id = m.id)
        ORDER BY m.id ASC`,
    )
    .all(reader, since) as Message[]);
}

// Messages `sender` sent pending since `since` that it hasn't acked, oldest first.
export function sentPending(sender: string, since: number): Message[] {
  return withAttachments(db, "message", db
    .prepare(
      `SELECT ${M_MSG_COLS} FROM messages m
        WHERE m.sender = ? AND m.pending = 1 AND m.created_at >= ?
          AND NOT EXISTS (SELECT 1 FROM dm_acks a WHERE a.reader = m.sender AND a.message_id = m.id)
        ORDER BY m.id ASC`,
    )
    .all(sender, since) as Message[]);
}

// Deletes a message `sender` sent that the recipient's session hasn't received
// (it's past their cursor) and that has no reply, which would still point at
// it. False if any of that doesn't hold. Audited as message.retracted in the
// same transaction: a repeated dm_retract is answered from that row (#254).
export function retractMessage(sender: string, id: number): boolean {
  return db.transaction(() => {
    const retractable = db
      .prepare(
        `SELECT recipient FROM messages WHERE id = ? AND sender = ?
           AND id > COALESCE((SELECT last_seen_id FROM cursors WHERE reader = messages.recipient), 0)
           AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.parent_id = messages.id)`,
      )
      .get(id, sender) as { recipient: string } | null;
    if (!retractable) return false;
    dropAttachments(db, "message", "?", id);
    db.prepare(`DELETE FROM messages WHERE id = ?`).run(id);
    db.prepare(`DELETE FROM dm_acks WHERE message_id = ?`).run(id);
    writeCoreAudit(db, "message.retracted", sender, retractedTarget(id), { message_id: id, recipient: retractable.recipient });
    return true;
  }).immediate();
}

const retractedTarget = (id: number) => `message:${id}`;

// When `sender` retracted message `id`, if it did.
export function retractedAt(sender: string, id: number): number | undefined {
  const row = lastCoreAudit(db, "message.retracted", retractedTarget(id));
  return row && row.actor === sender ? row.at : undefined;
}
