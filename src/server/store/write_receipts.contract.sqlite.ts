// The SQLite store as a write-receipts-contract backend (write_receipts.contract.ts), registered by db.test.ts: the
// Repo's writeReceipts group, with the harness's message and post fixtures on its connection.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db.ts";
import { scratchDbPath } from "../../../tests/support/scratch_db.ts";
import type { WriteReceiptsBackend, WriteReceiptsHarness } from "./write_receipts.contract.ts";
import { sqliteOf } from "./tx.ts";

export const sqliteWriteReceiptsBackend: WriteReceiptsBackend = {
  kind: "sqlite",
  async open(): Promise<WriteReceiptsHarness> {
    const { repo } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
    const id = (sql: string) => repo.write(async tx => sqliteOf(tx).query<{ id: number }, []>(sql).get()!.id);
    return {
      writeReceipts: repo.writeReceipts,
      write: fn => repo.write(fn),
      read: repo.read,
      message: () => id("INSERT INTO messages (sender, recipient_type, recipient, body, created_at) VALUES ('a@example.com/fe', 'user', 'b@example.com/be', 'm', 0) RETURNING id"),
      post: async () => {
        await repo.write(async tx => { sqliteOf(tx).run("INSERT OR IGNORE INTO boards (name, purpose, scope, created_by, created_at) VALUES ('e2e', '', NULL, 'a@example.com/fe', 0)"); });
        return id("INSERT INTO posts (board, author, body, created_at) VALUES ('e2e', 'a@example.com/fe', 'p', 0) RETURNING id");
      },
      drop: (kind, rowId) => repo.write(async tx => { sqliteOf(tx).run(`DELETE FROM ${kind === "message" ? "messages" : "posts"} WHERE id = ?`, [rowId]); }),
      close: () => repo.close(),
    };
  },
};
