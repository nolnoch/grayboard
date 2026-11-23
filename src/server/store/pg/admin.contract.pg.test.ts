// #1651: the admin reads' contract (admin.contract.ts) on Postgres: the same rows SQLite runs from db.test.ts, over
// makePgAdmin. Each row gets its own database. Without GRAYBOARD_TEST_PG_URL it skips (tests/support/pg.ts).
import { describePg, pgDatabase } from "../../../../tests/support/pg.ts";
import { adminContract, type AdminBackend, type AdminHarness } from "../admin.contract.ts";
import { makePgAdmin } from "./admin.ts";
import { int8 } from "./sql.ts";
import { makePgTransactions } from "./tx.ts";

const pgAdminBackend: AdminBackend = {
  kind: "postgres",
  async open(): Promise<AdminHarness> {
    const db = await pgDatabase({ max: 2 });
    const s = makePgTransactions(db.url, { max: 4, applicationName: "gb-test-admin" });
    const sql = db.sql;
    return {
      admin: makePgAdmin(),
      read: s.read,
      async insert(table, row) {
        // access_log.detail is jsonb: bind the parsed object, as the audit store does.
        const r = table === "access_log" && typeof row.detail === "string" ? { ...row, detail: JSON.parse(row.detail) } : row;
        if (table === "boards" || table === "claims") {
          await sql`INSERT INTO ${sql(table)} ${sql(r)}`;
          return 0;
        }
        const [got] = await sql`INSERT INTO ${sql(table)} ${sql(r)} RETURNING id`;
        return int8(got.id);
      },
      async close() {
        await s.close();
        await db[Symbol.asyncDispose]();
      },
    };
  },
};

describePg("admin contract (Postgres)", () => adminContract(pgAdminBackend));
