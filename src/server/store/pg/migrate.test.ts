// #807 P3 C1: the Postgres migration runner, on fixture migrations (0001_init's own test is schema parity, C1b).
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describePg, pgEmptyDatabase } from "../../../../tests/support/pg.ts";
import { FIXTURES } from "../../../../tests/support/pg_migrate_child.ts";
import { transactionProcess } from "../../../../tests/support/transaction-process.ts";
import { until } from "../../../../tests/support/until.ts";
import { checksum, migrate, MIGRATIONS, validateMigrations, type Migration } from "./migrate.ts";
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

// Shipped migrations are append-only (D7): a kept database records each file's checksum, and a boot refuses an edited
// file, so an in-place edit (a comment counts) would stop every pilot server's boot. Pinned here so CI fails first. A new
// migration adds its line; an existing line never changes.
test("shipped migrations keep their checksums", () => {
  expect(MIGRATIONS.map(m => [m.name, checksum(m)])).toEqual([
    ["0001_init", "0608ca7efd3ccc27a69189776a99aeb9de5ba20ebf410c79c7b08a3a2b840fa1"],
    ["0002_posts_author_root", "9659b2bf7ee83ee72f81db01951b90cc660644283dff75d580f73b4e9cdee9e4"],
  ]);
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

  test("a list out of order is refused by migrate itself, before touching the database", async () => {
    await using db = await pgEmptyDatabase();
    await expect(migrate(db.sql, [FIXTURES[1]!, FIXTURES[0]!])).rejects.toThrow("version 2 at position 1");
    expect(await table(db.sql, "schema_migrations")).toBeNull();
  });

  test("a pending migration below a recorded one is refused, not applied out of order", async () => {
    await using db = await pgEmptyDatabase();
    await migrate(db.sql, FIXTURES.slice(0, 1));
    // Version 3 recorded without 2 (a branch's database, or a hand edit).
    await db.sql`INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (3, '0003_three', ${checksum(FIXTURES[2]!)}, 1)`;
    await expect(migrate(db.sql, FIXTURES)).rejects.toThrow("migration 0002_two is not applied but version 3 is");
    expect(await table(db.sql, "two")).toBeNull();
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
      second.catch(() => {}); // asserted below; a failure before then must not surface as an unhandled rejection
      await until(async () => (await db.sql`SELECT 1 FROM pg_stat_activity WHERE datname = ${db.name} AND application_name = 'gb-migrate-b' AND wait_event_type = 'Lock' AND wait_event = 'advisory'`).length > 0, 10_000, "boot B waiting on the advisory lock");
      writeFileSync(release, "");
      expect(await a.proc.exited).toBe(0);
      await a.done;
      expect(JSON.parse(a.output().trim())).toEqual({ applied: [1, 2, 3], ahead: [] });
      expect(await second).toEqual({ applied: [], ahead: [] });
      expect((await recorded(db.sql)).map(r => r.version)).toEqual([1, 2, 3]);
    } finally {
      // A first: B may be waiting on A, and close() waits for B's query.
      await a.stop();
      await b.close({ timeout: 0 });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// #930: 0003 starts every user's IdP clock at the upgrade, unlinked ones included (pg twin of the SQLite open's stamp, db.ts).
describePg("0003_users_idp_checked_at", () => {
  test("stamps every row, with an issuer or without", async () => {
    await using db = await pgEmptyDatabase();
    const v3 = MIGRATIONS.findIndex(m => m.version === 3);
    await migrate(db.sql, MIGRATIONS.slice(0, v3));
    await db.sql`INSERT INTO users (email, created_at, idp_issuer, idp_subject) VALUES ('linked@example.com', 1, 'https://idp.example', 's-1'), ('dev@example.com', 1, NULL, NULL)`;
    const before = Date.now();
    await migrate(db.sql, MIGRATIONS.slice(0, v3 + 1));
    const rows = await db.sql`SELECT email, idp_checked_at FROM users ORDER BY email` as { email: string; idp_checked_at: string | number | null }[];
    expect(Number(rows[0]!.idp_checked_at)).toBeGreaterThanOrEqual(before);
    expect(Number(rows[1]!.idp_checked_at)).toBeGreaterThanOrEqual(before);
  });
});
