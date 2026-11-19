// #807 P3 C67b: the audit log's contract (audit.contract.ts) on Postgres: the same rows SQLite runs from db.test.ts,
// over makePgAudit, with pg/audit_row.ts insertAudit as the store-direct row and the raw reads on the database's own
// pool. Each row gets its own database. The races, a write the database refuses and the pin of `last`'s order are
// audit.pg.test.ts's. Without GRAYBOARD_TEST_PG_URL it skips (tests/support/pg.ts).
import { describePg, pgDatabase } from "../../../../tests/support/pg.ts";
import { auditContract, type AuditBackend, type AuditHarness, type AuditRawRow } from "../audit.contract.ts";
import { makePgAudit } from "./audit.ts";
import { insertAudit } from "./audit_row.ts";
import { int8, type AuditDetail } from "./sql.ts";
import { makePgTransactions, pgOf } from "./tx.ts";

const pgAuditBackend: AuditBackend = {
  kind: "postgres",
  async open(): Promise<AuditHarness> {
    const db = await pgDatabase({ max: 2 });
    const s = makePgTransactions(db.url, { max: 4, applicationName: "gb-test-audit" });
    return {
      audit: makePgAudit(),
      write: fn => s.write(fn),
      read: s.read,
      // The other groups' rows pass the object (AuditDetail). U9's rows have none: a null detail stores SQL NULL, as
      // SQLite's insertAudit stores it, through the same function.
      direct: (tx, r) => insertAudit(pgOf(tx), r.at, r.actor, r.action, r.target,
        (r.detail === null ? null : JSON.parse(r.detail)) as AuditDetail),
      // detail arrives parsed (jsonb); detail_type is the database's jsonb_typeof.
      rows: async () => (await db.sql`SELECT at, actor, action, target, detail, jsonb_typeof(detail) AS detail_type, ip, ua, client_id
          FROM access_log ORDER BY id`).map((r: Record<string, unknown>): AuditRawRow => ({ ...r, at: int8(r.at) } as AuditRawRow)),
      async close() {
        await s.close();
        await db[Symbol.asyncDispose]();
      },
    };
  },
};

describePg("audit contract (Postgres)", () => auditContract(pgAuditBackend));
