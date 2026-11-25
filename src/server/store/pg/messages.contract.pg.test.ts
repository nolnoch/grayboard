// #807 P3 C5b: the messages contract (messages.contract.ts) on Postgres: the same rows SQLite runs from db.test.ts,
// over makePgMessages on a fixed clock with the contract's attachment caps. Each row gets its own database (the raw
// reads read whole tables). The races are messages.pg.test.ts's. Without GRAYBOARD_TEST_PG_URL it skips
// (tests/support/pg.ts).
import { describePg, pgDatabase } from "../../../../tests/support/pg.ts";
import { MESSAGE_LIMITS, messagesContract, type MessagesBackend, type MessagesHarness } from "../messages.contract.ts";
import { makePgMessages } from "./messages.ts";
import { int8, int8OrNull } from "./sql.ts";
import { makePgTransactions } from "./tx.ts";

const pgMessagesBackend: MessagesBackend = {
  kind: "postgres",
  async open(): Promise<MessagesHarness> {
    const db = await pgDatabase({ max: 2 });
    const s = makePgTransactions(db.url, { max: 4, applicationName: "gb-test-messages" });
    let now = 0;
    // Fixture writes and raw reads on the database's own read-write pool, each its own transaction.
    const sql = db.sql;
    let blob = 0;
    return {
      messages: makePgMessages({ clock: () => now, attachmentLimits: MESSAGE_LIMITS }),
      write: fn => s.write(fn),
      read: s.read,
      setNow: ms => { now = ms; },
      upload: (uploader, principal, size) => sql.begin(async t => {
        const sha = `sha-${++blob}`;
        await t`INSERT INTO attachment_blobs (sha256, size, created_at) VALUES (${sha}, ${size}, 0)`;
        const [r] = await t`INSERT INTO attachments (sha256, filename, type, size, uploader, uploader_principal, created_at)
          VALUES (${sha}, 'f.txt', 'text/plain', ${size}, ${uploader}, ${principal}, 0) RETURNING id`;
        return int8(r.id);
      }),
      async cursor(address, lastSeenId) {
        await sql`INSERT INTO mailbox_cursors (address, stream_type, stream_ref, last_seen_id) VALUES (${address}, 'direct', ${address}, ${lastSeenId})`;
      },
      post: (board, scope, author, authorUser) => sql.begin(async t => {
        await t`INSERT INTO boards (name, purpose, scope, created_by, created_at) VALUES (${board}, '', ${scope}, ${author}, 0) ON CONFLICT DO NOTHING`;
        const [r] = await t`INSERT INTO posts (board, author, body, created_at, author_user) VALUES (${board}, ${author}, 'p', 0, ${authorUser}) RETURNING id`;
        return int8(r.id);
      }),
      // The detail is the object, as delegate's audit row stores it (jsonb).
      async delegation(target, at, messageId) {
        await sql`INSERT INTO access_log (at, actor, action, target, detail) VALUES (${at}, NULL, 'delegation.requested', ${target}, ${{ message_id: messageId }})`;
      },
      async bounce(sender, recipient, parentId, at) {
        const [r] = await sql`INSERT INTO messages (sender, recipient_type, recipient, body, parent_id, created_at, kind)
          VALUES (${sender}, 'user', ${recipient}, 'bounced', ${parentId}, ${at}, 'bounce') RETURNING id`;
        return int8(r.id);
      },
      humanRows: async () => (await sql`SELECT id, human FROM messages ORDER BY id`).map((r: Record<string, unknown>) => ({ id: int8(r.id), human: r.human as boolean | null })),
      messageRows: async () => (await sql`SELECT id, parent_id FROM messages ORDER BY id`).map((r: Record<string, unknown>) => ({ id: int8(r.id), parent_id: int8OrNull(r.parent_id) })),
      ackRows: async () => (await sql`SELECT reader, message_id FROM dm_acks ORDER BY message_id, reader`).map((r: Record<string, unknown>) => ({ reader: r.reader as string, message_id: int8(r.message_id) })),
      attachmentRows: async () => (await sql`SELECT id, message_id FROM attachments ORDER BY id`).map((r: Record<string, unknown>) => ({ id: int8(r.id), message_id: int8OrNull(r.message_id) })),
      // detail arrives parsed (jsonb); detail_type is the database's jsonb_typeof.
      audits: async action => [...await sql`SELECT actor, target, detail, jsonb_typeof(detail) AS detail_type FROM access_log WHERE action = ${action} ORDER BY id`],
      async close() {
        await s.close();
        await db[Symbol.asyncDispose]();
      },
    };
  },
};

describePg("messages contract (Postgres)", () => messagesContract(pgMessagesBackend));
