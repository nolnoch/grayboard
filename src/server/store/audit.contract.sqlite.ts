// The SQLite store as an audit-contract backend (audit.contract.ts), registered by db.test.ts: the Repo's audit group,
// with db.ts insertAudit as the store-direct row and the raw reads on its connection.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertAudit, openDatabase } from "../db.ts";
import { scratchDbPath } from "../../../tests/support/scratch_db.ts";
import type { AuditBackend, AuditHarness, AuditRawRow } from "./audit.contract.ts";
import { sqliteOf } from "./tx.ts";

export const sqliteAuditBackend: AuditBackend = {
  kind: "sqlite",
  async open(): Promise<AuditHarness> {
    const { repo } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
    return {
      audit: repo.audit,
      write: fn => repo.write(fn),
      read: repo.read,
      direct: async (tx, r) => { insertAudit(sqliteOf(tx), r.at, r.actor, r.action, r.target, r.detail); },
      rows: async () => sqliteOf(repo.read).query<Omit<AuditRawRow, "detail"> & { detail: string | null }, []>(
        "SELECT at, actor, action, target, detail, json_type(detail) AS detail_type, ip, ua, client_id FROM access_log ORDER BY id").all()
        .map(r => ({ ...r, detail: r.detail === null ? null : JSON.parse(r.detail) as unknown })),
      close: () => repo.close(),
    };
  },
};
