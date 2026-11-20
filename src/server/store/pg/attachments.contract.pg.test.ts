// #807 P3 C10c: the attachments contract (attachments.contract.ts) on Postgres: the same rows SQLite runs from
// db.test.ts, over makePgAttachments. Each row gets its own database (the raw reads read whole tables). The races are
// attachments.pg.test.ts's. Without GRAYBOARD_TEST_PG_URL it skips (tests/support/pg.ts).
import { describePg, pgDatabase } from "../../../../tests/support/pg.ts";
import { attachmentsContract, type AttachmentsBackend, type AttachmentsHarness } from "../attachments.contract.ts";
import type { AttachmentRow } from "../attachments.ts";
import { makePgAttachments } from "./attachments.ts";
import { int8, int8OrNull } from "./sql.ts";
import { makePgTransactions } from "./tx.ts";

type Row = Record<string, unknown>;
const toRow = (r: Row): AttachmentRow => ({
  id: int8(r.id), sha256: r.sha256 as string, filename: r.filename as string, type: r.type as string, size: int8(r.size),
  uploader: r.uploader as string, uploader_principal: r.uploader_principal as string | null,
  message_id: int8OrNull(r.message_id), post_id: int8OrNull(r.post_id), created_at: int8(r.created_at),
});

const pgAttachmentsBackend: AttachmentsBackend = {
  kind: "postgres",
  async open(): Promise<AttachmentsHarness> {
    const db = await pgDatabase({ max: 2 });
    const s = makePgTransactions(db.url, { max: 4, applicationName: "gb-test-attachments" });
    // Fixture writes and raw reads on the database's own read-write pool, each its own transaction.
    const sql = db.sql;
    return {
      attachments: makePgAttachments(),
      write: fn => s.write(fn),
      read: s.read,
      async message() {
        const [r] = await sql`INSERT INTO messages (sender, recipient_type, recipient, body, created_at) VALUES ('a', 'user', 'b', 'm', 0) RETURNING id`;
        return int8(r.id);
      },
      async upload(u) {
        await sql`INSERT INTO attachment_blobs (sha256, size, created_at) VALUES (${u.sha256}, ${u.size}, ${u.created_at}) ON CONFLICT DO NOTHING`;
        const [r] = await sql`INSERT INTO attachments (sha256, filename, type, size, uploader, uploader_principal, message_id, created_at)
          VALUES (${u.sha256}, 'f.txt', 'text/plain', ${u.size}, ${u.uploader}, ${u.principal}, ${u.message_id ?? null}::int8, ${u.created_at}) RETURNING id`;
        return int8(r.id);
      },
      async blob(sha256, size, createdAt) { await sql`INSERT INTO attachment_blobs (sha256, size, created_at) VALUES (${sha256}, ${size}, ${createdAt})`; },
      rows: async () => (await sql`SELECT * FROM attachments ORDER BY id`).map(toRow),
      blobs: async () => (await sql`SELECT sha256, size, created_at FROM attachment_blobs ORDER BY sha256`)
        .map((r: Row) => ({ sha256: r.sha256 as string, size: int8(r.size), created_at: int8(r.created_at) })),
      async close() {
        await s.close();
        await db[Symbol.asyncDispose]();
      },
    };
  },
};

describePg("attachments contract (Postgres)", () => attachmentsContract(pgAttachmentsBackend));
