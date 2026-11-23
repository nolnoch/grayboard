/// <reference path="./sql-modules.d.ts" />
// The Postgres schema runner (#807 P3 C1, docs/future/postgres-server.md D7). Unlike SQLite's additive schema step,
// several pods of possibly different versions share one database: migrations are numbered files, applied once, in
// order, recorded in schema_migrations, under a lock, and a release must run against the next one's schema (N-1).
//
// One transaction does everything: the advisory lock (transaction-scoped, so COMMIT or ROLLBACK releases it whatever
// the body did; a session lock on a pooled connection could outlive an error path), the record table (its CREATE
// races without the lock: two fresh boots fail 23505 on pg_type), the checks and every pending file. Postgres DDL is
// transactional, so a boot moves the schema to this binary's version or leaves it as it was.
import { createHash } from "node:crypto";
import type { SQL } from "bun";
import { testPauseAsync } from "../../../shared/testpause.ts";
import init from "./migrations/0001_init.sql" with { type: "text" };
import postsAuthorRoot from "./migrations/0002_posts_author_root.sql" with { type: "text" };
import usersIdpCheckedAt from "./migrations/0003_users_idp_checked_at.sql" with { type: "text" };
import adminIndexes from "./migrations/0004_admin_indexes.sql" with { type: "text" };

export type Migration = { version: number; name: string; sql: string };

// Each file imported `with { type: "text" }`, so `bun build --compile` embeds it.
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "0001_init", sql: init },
  { version: 2, name: "0002_posts_author_root", sql: postsAuthorRoot },
  { version: 3, name: "0003_users_idp_checked_at", sql: usersIdpCheckedAt },
  { version: 4, name: "0004_admin_indexes", sql: adminIndexes },
];

// pg_advisory_xact_lock's key: any constant; advisory locks are per database.
export const MIGRATE_LOCK = 0x67626d6967726174n; // "gbmigrat"

// The record table. Part of every migrated database's shape, so tests/support/pg.ts hashes it into the template name.
export const RECORD_TABLE_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version int4 PRIMARY KEY,
  name text COLLATE "C" NOT NULL,
  checksum text COLLATE "C" NOT NULL,
  applied_at int8 NOT NULL
)`;

export function checksum(m: Migration): string {
  return createHash("sha256").update(m.sql).digest("hex");
}

// Refuses a list whose versions aren't 1, 2, 3… in order, or whose names don't start with their zero-padded version.
export function validateMigrations(migrations: readonly Migration[]): void {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`migration ${m.name}: version ${m.version} at position ${i + 1}; versions run 1, 2, 3… in order`);
    if (!new RegExp(`^${String(m.version).padStart(4, "0")}_[a-z0-9_]+$`).test(m.name)) throw new Error(`migration ${m.version}: name "${m.name}" must be its 4-digit version, "_", then lowercase words`);
  });
}

validateMigrations(MIGRATIONS);

export type MigrateResult = {
  // Versions this run applied, in order.
  applied: number[];
  // Recorded versions this binary doesn't know: a newer release migrated, and this one runs on its schema (N-1).
  ahead: number[];
};

export async function migrate(sql: SQL, migrations: readonly Migration[] = MIGRATIONS, opts: { now?: () => number } = {}): Promise<MigrateResult> {
  validateMigrations(migrations);
  const now = opts.now ?? Date.now;
  return sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(${MIGRATE_LOCK.toString()}::int8)`;
    await tx.unsafe(RECORD_TABLE_SQL);
    const rows: { version: number; checksum: string }[] = await tx`SELECT version, checksum FROM schema_migrations ORDER BY version`;
    const known = new Map(migrations.map(m => [m.version, m]));
    const recorded = new Set<number>();
    const ahead: number[] = [];
    for (const r of rows) {
      recorded.add(r.version);
      const m = known.get(r.version);
      if (!m) { ahead.push(r.version); continue; }
      if (r.checksum !== checksum(m)) {
        throw new Error(`migration ${m.name} was edited after this database applied it (recorded checksum ${r.checksum.slice(0, 12)}, file ${checksum(m).slice(0, 12)}); a development database: drop and recreate it`);
      }
    }
    // A pending version below the highest recorded one would run out of order (recorded 1 and 3, this binary adds 2):
    // migrations are written against every earlier one, so refuse rather than guess.
    const highest = rows.length ? rows[rows.length - 1]!.version : 0;
    const gap = migrations.find(m => !recorded.has(m.version) && m.version < highest);
    if (gap) throw new Error(`migration ${gap.name} is not applied but version ${highest} is: refusing to apply it out of order`);
    const applied: number[] = [];
    for (const m of migrations) {
      if (recorded.has(m.version)) continue;
      await tx.unsafe(m.sql);
      await tx`INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (${m.version}, ${m.name}, ${checksum(m)}, ${now()})`;
      applied.push(m.version);
    }
    await testPauseAsync("pg:migrate:applied");
    return { applied, ahead };
  });
}
