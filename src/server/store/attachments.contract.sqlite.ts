// The SQLite store as an attachments-contract backend (attachments.contract.ts), registered by db.test.ts: the Repo's
// attachments group (core's attachment SQL), with the harness's fixture writes and raw reads on its connection.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db.ts";
import { scratchDbPath } from "../../../tests/support/scratch_db.ts";
import type { AttachmentsBackend, AttachmentsHarness } from "./attachments.contract.ts";
import type { AttachmentRow } from "./attachments.ts";
import { sqliteOf } from "./tx.ts";

export const sqliteAttachmentsBackend: AttachmentsBackend = {
  kind: "sqlite",
  async open(): Promise<AttachmentsHarness> {
    const { repo } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
    const one = (sql: string, args: (string | number | null)[]) =>
      repo.write(async tx => sqliteOf(tx).query<{ id: number }, (string | number | null)[]>(sql).get(...args)!.id);
    const run = (sql: string, args: (string | number | null)[]) => repo.write(async tx => { sqliteOf(tx).run(sql, args); });
    const all = <T>(sql: string) => sqliteOf(repo.read).query<T, []>(sql).all();
    return {
      attachments: repo.attachments,
      write: fn => repo.write(fn),
      read: repo.read,
      message: () => one("INSERT INTO messages (sender, recipient_type, recipient, body, created_at) VALUES ('a', 'user', 'b', 'm', 0) RETURNING id", []),
      async upload(u) {
        await run("INSERT OR IGNORE INTO attachment_blobs (sha256, size, created_at) VALUES (?, ?, ?)", [u.sha256, u.size, u.created_at]);
        return one(`INSERT INTO attachments (sha256, filename, type, size, uploader, uploader_principal, message_id, created_at)
          VALUES (?, 'f.txt', 'text/plain', ?, ?, ?, ?, ?) RETURNING id`, [u.sha256, u.size, u.uploader, u.principal, u.message_id ?? null, u.created_at]);
      },
      blob: (sha256, size, createdAt) => run("INSERT INTO attachment_blobs (sha256, size, created_at) VALUES (?, ?, ?)", [sha256, size, createdAt]),
      rows: async () => all<AttachmentRow>("SELECT * FROM attachments ORDER BY id"),
      blobs: async () => all<{ sha256: string; size: number; created_at: number }>("SELECT sha256, size, created_at FROM attachment_blobs ORDER BY sha256"),
      close: () => repo.close(),
    };
  },
};
