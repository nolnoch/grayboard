// The messages store on Postgres (#807 P3 C5, docs/future/postgres-server.md D3, D6): store/messages.ts's
// MessagesStore, each method on its caller's handle through pgOf. The SQLite store (db.ts makeRepo's messages) is the
// reference; what differs, and why:
// - Under READ COMMITTED each statement sees a new snapshot, and one that waits on a row lock re-checks only that
//   row's WHERE. So every decision a write depends on is read under a lock on the message, or in a statement after it:
//   - insert locks a reply's parent FOR KEY SHARE before it writes and refuses MissingParent when it's gone (retracted
//     or pruned after the send's check), so a caller that catches the refusal and commits commits nothing (contract
//     M5). The insert's own FK check takes the same lock; a 23503 on messages_parent_id_fkey is classified too
//     (pg/errors.ts), as a backstop, though by then the transaction is aborted.
//   - files lock first (pg/attachment_rows.ts): the unsent rows FOR UPDATE, refused and tallied before the insert, so
//     a send that loses an upload to another send refuses before it writes.
//   - retract locks the message FOR UPDATE, reads delivered_at from the locked row, then reads the cursor and the
//     reply check in a later statement: a reply's FK or parent lock, an ack's FOR KEY SHARE and a delivery stamp each
//     make it wait. A reply or a stamp committed first answers "replied" or "read" instead of failing 23503 or
//     deleting past a stamp; an ack committed first is deleted with the message, and retract answers "retracted".
//   - ack inserts through FOR KEY SHARE of the message: an ack racing a retract either lands before the retract's
//     ack delete or finds no message, so no dm_acks row outlives its message (dm_acks has no FK).
//   - prune locks its batch FOR UPDATE, by id, first: a reply inserted under an old parent makes it wait, and its
//     null-the-children UPDATE then sees the reply. ORDER BY id is the lock order against another prune.
// - A cursor-only read racing a retract is an accepted window (D3): the reader reads the message, the retract commits,
//   then the reader's cursor moves past an id that no longer exists.
// - pending is boolean (MessageRow keeps 0/1); every int8 goes through the mappers; `+col` planner hints and CROSS
//   JOIN … ON are SQLite's and are dropped (D6).
// - retract's audit detail is the object (pg/audit_row.ts). No savepoints, and no generation bump (c5-scope §4).
//
// Runtime imports stay off bun:sqlite, db.ts and core/attachments.ts (pg/isolation.test.ts): the SQL is restated.
import type { AttachmentLimits } from "../../../shared/attachments.ts";
import { MissingParent } from "../errors.ts";
import type { MessageRow, MessagesStore, RetractResult, ServicePost } from "../messages.ts";
import { insertAudit } from "./audit_row.ts";
import { bindLocked, dropAttachments, lockUnsent, withAttachments } from "./attachment_rows.ts";
import { missingParent } from "./errors.ts";
import { int8, int8OrNull } from "./sql.ts";
import { pgOf, type PgSql } from "./tx.ts";

type Row = Record<string, unknown>;
const toMessage = (r: Row): MessageRow => ({
  id: int8(r.id), sender: r.sender as string, recipient_type: r.recipient_type as MessageRow["recipient_type"], recipient: r.recipient as string,
  body: r.body as string, parent_id: int8OrNull(r.parent_id), created_at: int8(r.created_at), delivered_at: int8OrNull(r.delivered_at),
  pending: r.pending === true ? 1 : 0, kind: r.kind as MessageRow["kind"], via: r.via as string | null,
});
const cols = (sql: PgSql) => sql.fragment`id, sender, recipient_type, recipient, body, parent_id, created_at, delivered_at, pending, kind, via`;
const mCols = (sql: PgSql) => sql.fragment`m.id, m.sender, m.recipient_type, m.recipient, m.body, m.parent_id, m.created_at, m.delivered_at, m.pending, m.kind, m.via`;
const rows = async (q: Promise<Row[]>) => (await q).map(toMessage);
// db.ts history's cap.
const HISTORY_CAP = 200;

export function makePgMessages({ clock, attachmentLimits }: { clock: () => number; attachmentLimits: AttachmentLimits }): MessagesStore {
  const att = (sql: PgSql, list: MessageRow[]) => withAttachments(sql, "message", list);
  return {
    async insert(tx, sender, recipientType, recipient, body, parentId, pending = false, files, senderId = null, via = null, senderUser = null, human = false) {
      const sql = pgOf(tx);
      // Every refusal before the first write (decision 5, 8): the transaction stays usable when the caller catches it.
      if (parentId !== null && (await sql`SELECT id FROM messages WHERE id = ${parentId} FOR KEY SHARE`).length === 0) throw new MissingParent(parentId);
      const locked = files ? await lockUnsent(sql, files.ids, files.uploader, attachmentLimits) : [];
      let row: MessageRow;
      try {
        [row] = await rows(sql`INSERT INTO messages (sender, sender_id, recipient_type, recipient, body, parent_id, created_at, pending, via, sender_user, human)
          VALUES (${sender}, ${senderId}, ${recipientType}, ${recipient}, ${body}, ${parentId}, ${clock()}, ${pending}, ${via}, ${senderUser}, ${human})
          RETURNING ${cols(sql)}`) as [MessageRow];
      } catch (e) {
        throw (parentId !== null && missingParent(e, parentId)) || e;
      }
      if (files) await bindLocked(sql, "message", row.id, locked, files.uploader);
      return locked.length ? { ...row, attachments: locked } : row;
    },
    async getById(r, id) {
      const sql = pgOf(r);
      return (await rows(sql`SELECT ${cols(sql)} FROM messages WHERE id = ${id}`))[0];
    },
    async writerUsers(r, messageIds, postIds) {
      const sql = pgOf(r);
      const pairs = async (q: Promise<Row[]>) => new Map((await q).map(x => [int8(x.id), x.user as string] as const));
      const messages = await pairs(messageIds.length ? sql`SELECT id, sender_user AS user FROM messages WHERE id = ANY(${messageIds}::int8[]) AND sender_user IS NOT NULL` : Promise.resolve([]));
      const posts = await pairs(postIds.length ? sql`SELECT id, author_user AS user FROM posts WHERE id = ANY(${postIds}::int8[]) AND author_user IS NOT NULL` : Promise.resolve([]));
      const service: Row[] = postIds.length ? await sql`SELECT p.id, p.author, p.board, b.scope FROM posts p JOIN boards b ON b.name = p.board
          WHERE p.id = ANY(${postIds}::int8[]) AND b.scope LIKE 'service:%'` : [];
      const servicePosts = new Map(service.map(x => [int8(x.id), { author: x.author, board: x.board, scope: x.scope } as ServicePost] as const));
      return { messages, posts, servicePosts };
    },
    // db.ts's window and its reason; EXISTS keeps the messages-first drive SQLite's CROSS JOIN fixes, and
    // idx_access_log_action_target serves the probe.
    async delegationIds(r, messageIds) {
      if (messageIds.length === 0) return new Set();
      const found: Row[] = await pgOf(r)`SELECT m.id FROM messages m WHERE m.id = ANY(${messageIds}::int8[])
        AND EXISTS (SELECT 1 FROM access_log a WHERE a.action = 'delegation.requested' AND a.target = m.recipient
          AND a.at BETWEEN m.created_at - 60000 AND m.created_at + 60000 AND (a.detail->>'message_id')::int8 = m.id)`;
      return new Set(found.map(x => int8(x.id)));
    },
    async bouncesFrom(r, id, since = 0) {
      const sql = pgOf(r);
      return rows(sql`SELECT ${cols(sql)} FROM messages WHERE sender = ${id} AND kind = 'bounce' AND created_at >= ${since} ORDER BY id`);
    },
    async history(r, addresses, peer, limit = 20, beforeId) {
      const sql = pgOf(r);
      const before = beforeId ?? Number.MAX_SAFE_INTEGER;
      const cap = Math.min(limit, HISTORY_CAP);
      return att(sql, await rows(peer
        ? sql`SELECT ${cols(sql)} FROM messages
            WHERE ((sender = ANY(${addresses}::text[]) AND recipient = ${peer}) OR (sender = ${peer} AND recipient = ANY(${addresses}::text[])))
              AND recipient_type = 'user' AND id < ${before}
            ORDER BY id DESC LIMIT ${cap}`
        : sql`SELECT ${cols(sql)} FROM messages
            WHERE (sender = ANY(${addresses}::text[]) OR (recipient = ANY(${addresses}::text[]) AND recipient_type = 'user')) AND id < ${before}
            ORDER BY id DESC LIMIT ${cap}`));
    },
    // The whole thread containing message `id`: walk up to its root, then down.
    async thread(r, id) {
      const sql = pgOf(r);
      return att(sql, await rows(sql`
        WITH RECURSIVE up(id, parent_id) AS (
          SELECT id, parent_id FROM messages WHERE id = ${id}
          UNION ALL
          SELECT m.id, m.parent_id FROM messages m JOIN up ON m.id = up.parent_id
        ),
        tree(id) AS (
          SELECT id FROM up WHERE parent_id IS NULL
          UNION ALL
          SELECT m.id FROM messages m JOIN tree t ON m.parent_id = t.id
        )
        SELECT ${mCols(sql)} FROM messages m JOIN tree t ON m.id = t.id ORDER BY m.id ASC`));
    },
    // One query per stream, as SQLite's: the stream count is small.
    async unreadSince(r, streams) {
      const sql = pgOf(r);
      if (streams.length === 0) return [];
      const all: MessageRow[] = [];
      for (const s of streams) {
        all.push(...await rows(sql`SELECT ${cols(sql)} FROM messages
          WHERE recipient_type = ${s.type === "direct" ? "user" : "team"} AND recipient = ${s.ref} AND id > ${s.since} ORDER BY id ASC`));
      }
      all.sort((a, b) => a.id - b.id);
      return att(sql, all);
    },
    async queuedTo(r, recipients) {
      const found: Row[] = await pgOf(r)`SELECT m.recipient, count(*) AS n FROM messages m
        WHERE m.recipient_type = 'user' AND m.recipient = ANY(${recipients}::text[]) AND m.recipient != m.sender
          AND m.id > COALESCE((SELECT c.last_seen_id FROM mailbox_cursors c WHERE c.address = m.recipient AND c.stream_type = 'direct' AND c.stream_ref = m.recipient), 0)
        GROUP BY m.recipient`;
      return new Map(found.map(x => [x.recipient as string, int8(x.n)]));
    },
    async undeliveredFrom(r, senders, olderThan = Number.MAX_SAFE_INTEGER) {
      const found: Row[] = await pgOf(r)`SELECT m.recipient, count(*) AS n, min(m.id) AS oldest_id FROM messages m
          LEFT JOIN mailbox_cursors c ON c.address = m.recipient AND c.stream_type = 'direct' AND c.stream_ref = m.recipient
        WHERE m.sender = ANY(${senders}::text[]) AND m.recipient_type = 'user' AND m.recipient != m.sender
          AND m.id > COALESCE(c.last_seen_id, 0) AND m.delivered_at IS NULL AND m.created_at < ${olderThan}
        GROUP BY m.recipient ORDER BY m.recipient`;
      return found.map(x => ({ recipient: x.recipient as string, n: int8(x.n), oldest_id: int8(x.oldest_id) }));
    },
    async receivedUnacked(r, readers, since) {
      const sql = pgOf(r);
      return att(sql, await rows(sql`SELECT ${mCols(sql)} FROM messages m
        WHERE m.recipient_type = 'user' AND m.recipient = ANY(${readers}::text[]) AND m.sender != m.recipient AND m.created_at >= ${since}
          AND NOT EXISTS (SELECT 1 FROM dm_acks a WHERE a.reader = m.recipient AND a.message_id = m.id)
        ORDER BY m.id ASC`));
    },
    async sentPending(r, senders, since) {
      const sql = pgOf(r);
      return att(sql, await rows(sql`SELECT ${mCols(sql)} FROM messages m
        WHERE m.recipient_type = 'user' AND m.sender = ANY(${senders}::text[]) AND m.pending AND m.created_at >= ${since}
          AND NOT EXISTS (SELECT 1 FROM dm_acks a WHERE a.reader = m.sender AND a.message_id = m.id)
        ORDER BY m.id ASC`));
    },
    // Through FOR KEY SHARE of the message: a retract holding it FOR UPDATE makes this wait, then find no row.
    async ack(tx, reader, id) {
      await pgOf(tx)`INSERT INTO dm_acks (reader, message_id, acked_at)
        SELECT ${reader}, m.id, ${clock()} FROM messages m WHERE m.id = ${id} FOR KEY SHARE OF m
        ON CONFLICT DO NOTHING`;
    },
    async markDelivered(tx, id, at) {
      await pgOf(tx)`UPDATE messages SET delivered_at = ${at} WHERE id = ${id} AND delivered_at IS NULL`;
    },
    async retract(tx, sender, id, by): Promise<RetractResult> {
      const sql = pgOf(tx);
      // The lock first, and delivered_at from the locked row: a stamp committed while this waited is seen.
      const [m] = await sql`SELECT recipient, delivered_at FROM messages WHERE id = ${id} AND sender = ${sender} AND recipient_type = 'user' FOR UPDATE`;
      if (!m) return "gone";
      if (m.delivered_at !== null) return "read";
      // A new statement, so a new snapshot: the cursor and any reply committed before the lock was granted.
      const [s] = await sql`SELECT COALESCE((SELECT last_seen_id FROM mailbox_cursors
          WHERE address = ${m.recipient} AND stream_type = 'direct' AND stream_ref = ${m.recipient}), 0) AS seen,
        EXISTS (SELECT 1 FROM messages r WHERE r.parent_id = ${id}) AS replied`;
      if (id <= int8(s.seen)) return "read";
      if (s.replied) return "replied";
      await dropAttachments(sql, "message", [id]);
      await sql`DELETE FROM dm_acks WHERE message_id = ${id}`;
      await sql`DELETE FROM messages WHERE id = ${id}`;
      await insertAudit(sql, clock(), by.actor, "message.retracted", `message:${id}`, { message_id: id, sender, recipient: m.recipient as string, session: by.session });
      return "retracted";
    },
    // Replies outlive pruned parents as roots; parent_id is a foreign key.
    async prune(tx, olderThanMs) {
      const sql = pgOf(tx);
      await sql`SELECT count(*) FROM (SELECT id FROM messages WHERE created_at < ${olderThanMs} ORDER BY id FOR UPDATE) batch`;
      const old = () => sql.fragment`SELECT id FROM messages WHERE created_at < ${olderThanMs}`;
      await sql`DELETE FROM dm_acks WHERE message_id IN (${old()})`;
      await sql`UPDATE messages SET parent_id = NULL WHERE parent_id IN (${old()})`;
      await dropAttachments(sql, "message", old());
      await sql`DELETE FROM messages WHERE created_at < ${olderThanMs}`;
    },
    // A session end's (#807 P3 C10d2-a); its row lock (sessionEnd.end, C10d2-b) is what orders it against a send. The
    // rows FOR KEY SHARE, locked in id order (the lock sits above the sort), as messages.prune locks its batch: the
    // end's bounces then lock their parents in sender order holding them all already, so they can't deadlock against
    // a prune (session_end.ts's lock order). A retract holding one makes this wait, and its row is then gone.
    async unreadFor(tx, id) {
      const list = await pgOf(tx)`SELECT m.id, m.sender FROM messages m
        WHERE m.recipient_type = 'user' AND m.recipient = ${id} AND m.sender <> ${id}
          AND m.id > COALESCE((SELECT last_seen_id FROM mailbox_cursors
                                WHERE address = ${id} AND stream_type = 'direct' AND stream_ref = ${id}), 0)
        ORDER BY m.id FOR KEY SHARE OF m`;
      return list.map((r: Row) => ({ id: int8(r.id), sender: r.sender as string }));
    },
    // The parent FOR KEY SHARE first, as insert's reply does: a retract that committed first leaves no parent, and the
    // bounce writes nothing (null) rather than fail 23503 and abort the end's transaction.
    async bounce(tx, from, to, parentId, body, now) {
      const sql = pgOf(tx);
      if ((await sql`SELECT id FROM messages WHERE id = ${parentId} FOR KEY SHARE`).length === 0) return null;
      const [row] = await rows(sql`INSERT INTO messages (sender, sender_id, recipient_type, recipient, body, parent_id, created_at, pending, kind, human)
        VALUES (${from}, ${from}, 'user', ${to}, ${body}, ${parentId}, ${now}, false, 'bounce', false)
        RETURNING ${cols(sql)}`);
      return row!;
    },
    async dropReader(tx, id) {
      const sql = pgOf(tx);
      await sql`DELETE FROM mailbox_cursors WHERE address = ${id}`;
      await sql`DELETE FROM dm_acks WHERE reader = ${id}`;
    },
  };
}
