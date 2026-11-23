// The SQLite store as an admin-contract backend (admin.contract.ts), registered by db.test.ts: the Repo's admin group,
// with fixture inserts on its connection.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db.ts";
import { scratchDbPath } from "../../../tests/support/scratch_db.ts";
import type { AdminBackend, AdminHarness } from "./admin.contract.ts";
import { sqliteOf } from "./tx.ts";

export const sqliteAdminBackend: AdminBackend = {
  kind: "sqlite",
  async open(): Promise<AdminHarness> {
    const { repo } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
    return {
      admin: repo.admin,
      read: repo.read,
      insert: (table, row) => repo.write(async tx => {
        const cols = Object.keys(row);
        const r = sqliteOf(tx).query<{ id: number } | null, (string | number | null)[]>(
          `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) RETURNING rowid AS id`,
        ).get(...Object.values(row));
        return table === "boards" || table === "claims" ? 0 : r!.id;
      }),
      close: () => repo.close(),
    };
  },
};
