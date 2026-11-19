// #807 P3 C67b: the write receipts' contract (write_receipts.contract.ts) on Postgres: the same rows SQLite runs from
// db.test.ts, over makePgWriteReceipts, with the message and post fixtures as raw SQL on the database's own pool. Each
// row gets its own database. The races are write_receipts.pg.test.ts's. Without GRAYBOARD_TEST_PG_URL it skips
// (tests/support/pg.ts).
import { describePg, pgDatabase } from "../../../../tests/support/pg.ts";
import { writeReceiptsContract, type WriteReceiptsBackend, type WriteReceiptsHarness } from "../write_receipts.contract.ts";
import { int8 } from "./sql.ts";
import { makePgTransactions } from "./tx.ts";
import { makePgWriteReceipts } from "./write_receipts.ts";

const pgWriteReceiptsBackend: WriteReceiptsBackend = {
  kind: "postgres",
  async open(): Promise<WriteReceiptsHarness> {
    const db = await pgDatabase({ max: 2 });
    const s = makePgTransactions(db.url, { max: 4, applicationName: "gb-test-receipts" });
    const sql = db.sql;
    const id = (rows: Record<string, unknown>[]) => int8(rows[0]!.id);
    return {
      writeReceipts: makePgWriteReceipts(),
      write: fn => s.write(fn),
      read: s.read,
      message: async () => id(await sql`INSERT INTO messages (sender, recipient_type, recipient, body, created_at)
        VALUES ('a@example.com/fe', 'user', 'b@example.com/be', 'm', 0) RETURNING id`),
      post: () => sql.begin(async t => {
        await t`INSERT INTO boards (name, purpose, scope, created_by, created_at) VALUES ('e2e', '', NULL, 'a@example.com/fe', 0) ON CONFLICT DO NOTHING`;
        return id(await t`INSERT INTO posts (board, author, body, created_at) VALUES ('e2e', 'a@example.com/fe', 'p', 0) RETURNING id`);
      }),
      async drop(kind, rowId) {
        if (kind === "message") await sql`DELETE FROM messages WHERE id = ${rowId}`;
        else await sql`DELETE FROM posts WHERE id = ${rowId}`;
      },
      async close() {
        await s.close();
        await db[Symbol.asyncDispose]();
      },
    };
  },
};

describePg("write receipts contract (Postgres)", () => writeReceiptsContract(pgWriteReceiptsBackend));
