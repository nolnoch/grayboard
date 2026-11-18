// #807 P3 C1: the Postgres migration runner, on fixture migrations (0001_init's own test is schema parity, C1b).
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describePg, pgEmptyDatabase } from "../../../../tests/support/pg.ts";
import { FIXTURES } from "../../../../tests/support/pg_migrate_child.ts";
import { transactionProcess } from "../../../../tests/support/transaction-process.ts";
import { until } from "../../../../tests/support/until.ts";
import { checksum, migrate, validateMigrations, type Migration } from "./migrate.ts";
import { openPg } from "./sql.ts";

const recorded = async (sql: Bun.SQL) =>
  (await sql`SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version`) as { version: number; name: string; checksum: string; applied_at: string }[];
const table = async (sql: Bun.SQL, name: string) => (await sql`SELECT to_regclass(${name}) AS r`)[0].r as string | null;

test("a migration list must run 1, 2, 3… with names starting with their version", () => {
  expect(() => validateMigrations(FIXTURES)).not.toThrow();
  expect(() => validateMigrations([FIXTURES[0]!, FIXTURES[0]!])).toThrow("version 1 at position 2");
  expect(() => validateMigrations([FIXTURES[1]!, FIXTURES[0]!])).toThrow("version 2 at position 1");
  expect(() => validateMigrations([FIXTURES[0]!, FIXTURES[2]!])).toThrow("version 3 at position 2");
  expect(() => validateMigrations([{ ...FIXTURES[0]!, name: "0002_one" }])).toThrow('name "0002_one"');
});

describePg("migrate", () => {
  test("a fresh database gets every migration, in order, each recorded with its checksum", async () => {
    await using db = await pgEmptyDatabase();
    const order: string[] = [];
    // Each fixture records its own position: order is the runner's, not the list's coincidence.
    const tracked: Migration[] = FIXTURES.map(m => ({ ...m, sql: `${m.sql}\nCREATE TABLE IF NOT EXISTS seen (n serial, v int4); INSERT INTO seen (v) VALUES (${m.version});` }));
    const r = await migrate(db.sql, tracked, { now: () => 1234 });
    expect(r).toEqual({ applied: [1, 2, 3], ahead: [] });
    for (const row of await db.sql`SELECT v FROM seen ORDER BY n`) order.push(String(row.v));
    expect(order).toEqual(["1", "2", "3"]);
    expect(await recorded(db.sql)).toEqual(tracked.map(m => ({ version: m.version, name: m.name, checksum: checksum(m), applied_at: "1234" })));
    expect(checksum(tracked[0]!)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a second run applies nothing; a new migration applies alone", async () => {
    await using db = await pgEmptyDatabase();
    expect(await migrate(db.sql, FIXTURES.slice(0, 2))).toEqual({ applied: [1, 2], ahead: [] });
    expect(await migrate(db.sql, FIXTURES.slice(0, 2))).toEqual({ applied: [], ahead: [] });
    expect(await migrate(db.sql, FIXTURES)).toEqual({ applied: [3], ahead: [] });
    expect((await recorded(db.sql)).map(r => r.version)).toEqual([1, 2, 3]);
    expect(await table(db.sql, "two")).toBe("two");
  });

  test("a failing statement rolls back the whole run: no table, no record", async () => {
    await using db = await pgEmptyDatabase();
    const broken: Migration[] = [FIXTURES[0]!, { version: 2, name: "0002_two", sql: "CREATE TABLE two (id int4);\nCREATE TABLE two (id int4);" }];
    await expect(migrate(db.sql, broken)).rejects.toThrow("already exists");
    expect(await table(db.sql, "one")).toBeNull();
    expect(await table(db.sql, "two")).toBeNull();
    expect(await table(db.sql, "schema_migrations")).toBeNull();
  });

  test("a migration edited after it was applied refuses the boot, naming it", async () => {
    await using db = await pgEmptyDatabase();
    await migrate(db.sql, FIXTURES.slice(0, 2));
    const edited = [FIXTURES[0]!, { ...FIXTURES[1]!, sql: FIXTURES[1]!.sql + "\n-- edited" }, FIXTURES[2]!];
    await expect(migrate(db.sql, edited)).rejects.toThrow("migration 0002_two was edited after this database applied it");
    // Refused before applying 3.
    expect((await recorded(db.sql)).map(r => r.version)).toEqual([1, 2]);
  });

  test("versions this binary doesn't know are reported, not refused (rolling deploy, N-1)", async () => {
    await using db = await pgEmptyDatabase();
    await migrate(db.sql, FIXTURES);
    await db.sql`INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (99, '0099_future', 'x', 1)`;
    expect(await migrate(db.sql, FIXTURES.slice(0, 2))).toEqual({ applied: [], ahead: [3, 99] });
  });

  test("two concurrent boots apply each migration once: the second waits on the lock", async () => {
    await using db = await pgEmptyDatabase();
    const dir = mkdtempSync(join(tmpdir(), "gb-migrate-"));
    const release = join(dir, "go");
    const a = transactionProcess("tests/support/pg_migrate_child.ts", [db.url, "3"], "pg:migrate:applied", release);
    const b = openPg(db.url, { max: 1, applicationName: "gb-migrate-b" });
    try {
      await a.wait("test pause hit: pg:migrate:applied");
      const second = migrate(b, FIXTURES);
      await until(async () => (await db.sql`SELECT 1 FROM pg_stat_activity WHERE application_name = 'gb-migrate-b' AND wait_event_type = 'Lock' AND wait_event = 'advisory'`).length > 0, 10_000, "boot B waiting on the advisory lock");
      writeFileSync(release, "");
      expect(await a.proc.exited).toBe(0);
      await a.done;
      expect(JSON.parse(a.output().trim())).toEqual({ applied: [1, 2, 3], ahead: [] });
      expect(await second).toEqual({ applied: [], ahead: [] });
      expect((await recorded(db.sql)).map(r => r.version)).toEqual([1, 2, 3]);
    } finally {
      await b.close();
      await a.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
