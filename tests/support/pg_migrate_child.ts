// Fixture migrations for migrate.ts's tests, and (run as a script) one boot of the runner in its own process:
// `bun tests/support/pg_migrate_child.ts <database url> <count>` migrates the first <count> fixtures and prints the
// result as JSON. A BUS_TEST_PAUSE of "pg:migrate:applied" holds it inside the transaction, lock held.
import type { Migration } from "../../src/server/store/pg/migrate.ts";
import { migrate } from "../../src/server/store/pg/migrate.ts";
import { openPg } from "../../src/server/store/pg/sql.ts";

export const FIXTURES: readonly Migration[] = [
  { version: 1, name: "0001_one", sql: "CREATE TABLE one (id int4 PRIMARY KEY);\nCREATE INDEX one_id ON one (id);" },
  { version: 2, name: "0002_two", sql: "CREATE TABLE two (id int4 PRIMARY KEY);" },
  { version: 3, name: "0003_three", sql: "ALTER TABLE two ADD COLUMN v text;" },
];

if (import.meta.main) {
  const [url, count] = process.argv.slice(2);
  const sql = openPg(url!, { max: 1, applicationName: "gb-migrate-child" });
  try {
    console.log(JSON.stringify(await migrate(sql, FIXTURES.slice(0, Number(count)))));
  } finally {
    await sql.close();
  }
}
