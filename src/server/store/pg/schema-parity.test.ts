// #807 P3 C1b: 0001_init.sql against the SQLite server schema it mirrors (docs/future/postgres-server.md D6, D7). Both
// sides are read from real databases: a SQLite server database as openDatabase leaves it (initSchema, initCoreSchema,
// migrateHostedHolds, every guarded ALTER) and a database cloned from the migrated Postgres template. The lists below
// are the only way the two may differ; a column, table, index or foreign key added to SQLite without its Postgres twin
// fails here, and each entry is a reviewed decision.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { openDatabase } from "../../db.ts";
import { scratchDbPath } from "../../../../tests/support/scratch_db.ts";
import { describePg, pgDatabase, type PgDatabase } from "../../../../tests/support/pg.ts";
import { PRINCIPAL_NAME_CONSTRAINTS, principalTaken } from "./errors.ts";
import { PrincipalTaken } from "../errors.ts";

// Tables a SQLite server database has that Postgres doesn't (D7 "Not carried").
const NOT_CARRIED = new Set([
  "identities", "cursors", // pre-#284 identity and read-point tables, replaced by aliases/ids and mailbox_cursors
  "handles", // the 1.x roster, read only by each mode's one-time alias seed
  "audit_log", // local mode's audit trail; the server audits to access_log (serverAuditSink)
  "sqlite_sequence", // SQLite's AUTOINCREMENT bookkeeping; identity columns keep their own sequences
]);
// Tables Postgres has that the SQLite server schema doesn't.
const PG_ONLY_TABLES = new Set(["schema_migrations"]); // migrate.ts's record, not 0001's

// Columns SQLite keeps only because its schema is additive (D7).
const DROPPED = new Set([
  "hosted_sessions.name", // vestigial since #451: holds are alias_holds rows; migrateHostedHolds clears it on open
  "ids.token_session", // unused since #282: nothing reads or writes it
  "team_members.role", // ownership moved to role_bindings (#927); read only by the one-time seed on SQLite
]);
// Columns Postgres adds: insertion order for the queries that tiebreak on SQLite's rowid (D6).
const ADDED = new Set([
  "ids.seq", // aliasUser's `ORDER BY …, started_at, rowid` (core/bindings.ts)
  "hosted_alias_lost.seq", // `ORDER BY at, rowid` (db.ts)
]);

// SQLite INTEGER 0/1 columns that are boolean in Postgres (D6). Every other INTEGER is bigint.
const BOOLEANS = new Set([
  "hosted_alias_lost.was_primary", "messages.pending", "ids.launcher", "ids.viewer", "ids.keyed", "ids.local_resume",
  "aliases.human", "aliases.queue_off", "outbox.wake",
]);
// SQLite TEXT columns that are jsonb in Postgres: queried by path or parsed on read (D6). Every other TEXT is text,
// write_receipts.result_json among them: it holds '' while a write is in flight (not valid jsonb) and is replayed
// byte for byte (jsonb would reorder its keys).
const JSONB = new Set([
  "oauth_requests.data", "oauth_browsers.data", "oauth_codes.data", "oauth_grants.data", "access_log.detail",
  "ids.held_aliases_json", "slack_progress.progress",
]);

type Column = { type: string; notNull: boolean; default: string | null; identity: boolean };
type Fk = string; // "from_cols -> table(to_cols) ON DELETE action"
type Index = { columns: string[]; unique: boolean; partial: boolean; predicate: string };
type Table = {
  columns: Map<string, Column>;
  pk: string[];
  uniques: Map<string, string[]>; // constraint name (Postgres default form) → columns, in order
  fks: Map<string, Fk>; // constraint name (Postgres default form) → definition
  indexes: Map<string, Index>; // explicitly created indexes, by name
  checks: number;
};
type Schema = Map<string, Table>;

const uniqueName = (table: string, cols: string[]) => `${table}_${cols.join("_")}_key`;
const fkName = (table: string, cols: string[]) => `${table}_${cols.join("_")}_fkey`;

// A default as both catalogs spell it for the values this schema uses: 'push'::text and 'push' → 'push'; false and
// 0 → 0 (booleans); true and 1 → 1.
function normDefault(d: string | null): string | null {
  if (d === null) return null;
  const s = d.replace(/::[a-z ]+$/, "");
  return s === "false" ? "0" : s === "true" ? "1" : s;
}

type SqliteDb = ReturnType<typeof openDatabase>["db"];

function sqliteSchema(db: SqliteDb): Schema {
  const schema: Schema = new Map();
  const tables = db.query(`SELECT name, sql FROM sqlite_master WHERE type = 'table'`).all() as { name: string; sql: string }[];
  for (const { name, sql } of tables) {
    const cols = db.query(`PRAGMA table_info(${name})`).all() as { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }[];
    const autoincrement = /\bAUTOINCREMENT\b/i.test(sql);
    const columns = new Map<string, Column>();
    for (const c of cols) {
      columns.set(c.name, {
        type: c.type, notNull: c.notnull === 1, default: normDefault(c.dflt_value),
        identity: autoincrement && c.pk === 1 && c.type === "INTEGER",
      });
    }
    const pk = cols.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
    const uniques = new Map<string, string[]>();
    const indexes = new Map<string, Index>();
    const createSql = new Map((db.query(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`).all(name) as { name: string; sql: string | null }[]).map(r => [r.name, r.sql ?? ""]));
    for (const i of db.query(`PRAGMA index_list(${name})`).all() as { name: string; unique: number; origin: string; partial: number }[]) {
      const ic = (db.query(`PRAGMA index_info(${i.name})`).all() as { seqno: number; name: string }[]).sort((a, b) => a.seqno - b.seqno).map(x => x.name);
      if (i.origin === "u") uniques.set(uniqueName(name, ic), ic);
      if (i.origin === "c") {
        const where = /\bWHERE\b(.*)$/is.exec(createSql.get(i.name) ?? "")?.[1] ?? "";
        indexes.set(i.name, { columns: ic, unique: i.unique === 1, partial: i.partial === 1, predicate: where });
      }
    }
    const fkRows = db.query(`PRAGMA foreign_key_list(${name})`).all() as { id: number; seq: number; table: string; from: string; to: string; on_delete: string }[];
    const fks = new Map<string, Fk>();
    for (const id of new Set(fkRows.map(f => f.id))) {
      const parts = fkRows.filter(f => f.id === id).sort((a, b) => a.seq - b.seq);
      const from = parts.map(p => p.from);
      fks.set(fkName(name, from), `${from.join(",")} -> ${parts[0]!.table}(${parts.map(p => p.to).join(",")}) ON DELETE ${parts[0]!.on_delete}`);
    }
    schema.set(name, { columns, pk, uniques, fks, indexes, checks: (sql.match(/\bCHECK\s*\(/gi) ?? []).length });
  }
  return schema;
}

async function pgSchema(sql: PgDatabase["sql"]): Promise<Schema> {
  const schema: Schema = new Map();
  const table = (name: string) => schema.get(name) ?? schema.set(name, { columns: new Map(), pk: [], uniques: new Map(), fks: new Map(), indexes: new Map(), checks: 0 }).get(name)!;
  const tables: { table_name: string }[] = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
  for (const t of tables) table(t.table_name);
  const cols: { table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null; is_identity: string }[] =
    await sql`SELECT table_name, column_name, data_type, is_nullable, column_default, is_identity FROM information_schema.columns WHERE table_schema = 'public'`;
  for (const c of cols) {
    table(c.table_name).columns.set(c.column_name, { type: c.data_type, notNull: c.is_nullable === "NO", default: normDefault(c.column_default), identity: c.is_identity === "YES" });
  }
  // Constraints with their columns in key order, and FK targets with theirs.
  const cons: { table: string; name: string; type: string; cols: string[]; ref_table: string | null; ref_cols: string[] | null; deltype: string }[] = await sql`
    SELECT rel.relname AS table, c.conname AS name, c.contype AS type,
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(n, o) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n ORDER BY k.o) AS cols,
      ref.relname::text AS ref_table,
      CASE WHEN c.confkey IS NULL THEN NULL ELSE ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(n, o) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n ORDER BY k.o) END AS ref_cols,
      c.confdeltype AS deltype
    FROM pg_constraint c JOIN pg_class rel ON rel.oid = c.conrelid LEFT JOIN pg_class ref ON ref.oid = c.confrelid
    WHERE c.connamespace = 'public'::regnamespace`;
  const onDelete: Record<string, string> = { a: "NO ACTION", r: "RESTRICT", c: "CASCADE", n: "SET NULL", d: "SET DEFAULT" };
  for (const c of cons) {
    const t = table(c.table);
    if (c.type === "p") t.pk = c.cols;
    else if (c.type === "u") t.uniques.set(c.name, c.cols);
    else if (c.type === "f") t.fks.set(c.name, `${c.cols.join(",")} -> ${c.ref_table}(${c.ref_cols!.join(",")}) ON DELETE ${onDelete[c.deltype]}`);
    else if (c.type === "c") t.checks++;
  }
  // Indexes that back no constraint: the ones CREATE INDEX made.
  const idx: { table: string; name: string; cols: string[]; unique: boolean; predicate: string | null }[] = await sql`
    SELECT t.relname AS table, ic.relname AS name, i.indisunique AS unique,
      ARRAY(SELECT a.attname::text FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(n, o) JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.n ORDER BY k.o) AS cols,
      pg_get_expr(i.indpred, i.indrelid) AS predicate
    FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid
    WHERE t.relnamespace = 'public'::regnamespace AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid)`;
  for (const i of idx) table(i.table).indexes.set(i.name, { columns: i.cols, unique: i.unique, partial: i.predicate !== null, predicate: i.predicate ?? "" });
  return schema;
}

// The column names a partial index's predicate mentions, so a predicate moved to another column fails too.
const predicateColumns = (predicate: string, columns: Iterable<string>) => [...columns].filter(c => new RegExp(`\\b${c}\\b`).test(predicate)).sort();

let sqlite: Schema;
let pg: Schema;
let pgDb: PgDatabase | undefined;

describePg("0001_init.sql mirrors the SQLite server schema", () => {
  beforeAll(async () => {
    const path = scratchDbPath();
    const { db } = openDatabase(path, { blobDir: join(dirname(path), "blobs") });
    try { sqlite = sqliteSchema(db); } finally { db.close(); rmSync(dirname(path), { recursive: true, force: true }); }
    pgDb = await pgDatabase({ max: 2 });
    pg = await pgSchema(pgDb.sql);
  });
  afterAll(async () => { await pgDb?.[Symbol.asyncDispose](); });

  test("every exception names something that exists on its side", () => {
    // A stale entry would hide a later column of the same name.
    const sqliteCols = new Set([...sqlite].flatMap(([t, s]) => [...s.columns.keys()].map(c => `${t}.${c}`)));
    for (const t of NOT_CARRIED) expect(sqlite.has(t), `NOT_CARRIED ${t}`).toBe(true);
    for (const c of [...DROPPED, ...BOOLEANS, ...JSONB]) expect(sqliteCols.has(c), c).toBe(true);
    for (const c of BOOLEANS) expect(sqlite.get(c.split(".")[0]!)!.columns.get(c.split(".")[1]!)!.type, c).toBe("INTEGER");
    for (const c of JSONB) expect(sqlite.get(c.split(".")[0]!)!.columns.get(c.split(".")[1]!)!.type, c).toBe("TEXT");
    for (const c of ADDED) expect(sqliteCols.has(c), `ADDED ${c} is already a SQLite column`).toBe(false);
  });

  test("tables: SQLite's, less NOT_CARRIED", () => {
    const want = [...sqlite.keys()].filter(t => !NOT_CARRIED.has(t)).sort();
    const got = [...pg.keys()].filter(t => !PG_ONLY_TABLES.has(t)).sort();
    expect(got).toEqual(want);
  });

  test("columns: names, types, NOT NULL, defaults and identity, less DROPPED, plus ADDED", () => {
    for (const [name, s] of sqlite) {
      if (NOT_CARRIED.has(name)) continue;
      const p = pg.get(name);
      if (!p) throw new Error(`${name}: no Postgres table`);
      const want: Record<string, Column> = {};
      for (const [col, c] of s.columns) {
        const key = `${name}.${col}`;
        if (DROPPED.has(key)) continue;
        const type = c.type === "INTEGER" ? (BOOLEANS.has(key) ? "boolean" : "bigint")
          : c.type === "TEXT" ? (JSONB.has(key) ? "jsonb" : "text") : `unmapped SQLite type ${c.type}`;
        // A SQLite PRIMARY KEY column other than INTEGER may hold NULL (a SQLite quirk nothing relies on); a
        // Postgres one is NOT NULL.
        want[col] = { type, notNull: c.notNull || s.pk.includes(col), default: c.default, identity: c.identity };
      }
      for (const key of ADDED) {
        const [t, col] = key.split(".");
        if (t === name) want[col!] = { type: "bigint", notNull: true, default: null, identity: true };
      }
      expect(Object.fromEntries(p.columns), name).toEqual(want);
    }
  });

  test("keys: primary keys, UNIQUE constraints by name, foreign keys by name with ON DELETE, CHECK counts", () => {
    for (const [name, s] of sqlite) {
      if (NOT_CARRIED.has(name)) continue;
      const p = pg.get(name);
      if (!p) throw new Error(`${name}: no Postgres table`);
      expect(p.pk, `${name} primary key`).toEqual(s.pk);
      const uniques = new Map(s.uniques);
      for (const key of ADDED) if (key.startsWith(`${name}.`)) uniques.set(uniqueName(name, [key.split(".")[1]!]), [key.split(".")[1]!]);
      expect(Object.fromEntries(p.uniques), `${name} UNIQUE`).toEqual(Object.fromEntries(uniques));
      expect(Object.fromEntries(p.fks), `${name} foreign keys`).toEqual(Object.fromEntries(s.fks));
      expect(p.checks, `${name} CHECK constraints`).toBe(s.checks);
    }
  });

  test("indexes: by name, columns in order, uniqueness, partial-ness and the predicate's columns", () => {
    for (const [name, s] of sqlite) {
      if (NOT_CARRIED.has(name)) continue;
      const p = pg.get(name);
      if (!p) throw new Error(`${name}: no Postgres table`);
      const shape = (t: Table) => Object.fromEntries([...t.indexes].map(([n, i]) => [n, { columns: i.columns, unique: i.unique, partial: i.partial, on: predicateColumns(i.predicate, s.columns.keys()) }]));
      expect(shape(p), `${name} indexes`).toEqual(shape(s));
    }
  });

  test("every text column is COLLATE \"C\", and text orders byte-wise", async () => {
    // SQLite compares BINARY everywhere; the cluster default (en_US.utf8 in the docker image) orders a_b before aB.
    const loose: { c: string }[] = await pgDb!.sql`SELECT table_name || '.' || column_name || ' ' || coalesce(collation_name, 'default') AS c
      FROM information_schema.columns WHERE table_schema = 'public' AND data_type = 'text' AND collation_name IS DISTINCT FROM 'C'`;
    expect(loose.map(r => r.c)).toEqual([]);
    const [{ n }] = await pgDb!.sql`SELECT count(*)::int4 AS n FROM information_schema.columns WHERE table_schema = 'public' AND data_type = 'text'`;
    expect(n).toBeGreaterThan(100); // the check above read the schema's columns, not nothing
    await pgDb!.sql`INSERT INTO alias_holds (address, id, bound_at) VALUES ('a_b', 's1', 1), ('aB', 's2', 1), ('a-b', 's3', 1)`;
    const rows: { address: string }[] = await pgDb!.sql`SELECT address FROM alias_holds ORDER BY address`;
    expect(rows.map(r => r.address)).toEqual(["a-b", "aB", "a_b"]);
    await pgDb!.sql`DELETE FROM alias_holds`;
  });

  test("each constraint errors.ts classifies exists as a UNIQUE on its table's name column", async () => {
    const rows: { name: string; table: string; cols: string[] }[] = await pgDb!.sql`
      SELECT c.conname AS name, rel.relname AS table,
        ARRAY(SELECT a.attname::text FROM unnest(c.conkey) k(n) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n) AS cols
      FROM pg_constraint c JOIN pg_class rel ON rel.oid = c.conrelid
      WHERE c.contype = 'u' AND c.conname IN ${pgDb!.sql([...PRINCIPAL_NAME_CONSTRAINTS])}`;
    const got = Object.fromEntries(rows.map(r => [r.name, { table: r.table, cols: r.cols }]));
    expect(got).toEqual({ principals_name_key: { table: "principals", cols: ["name"] }, teams_name_key: { table: "teams", cols: ["name"] } });
    expect([...PRINCIPAL_NAME_CONSTRAINTS].sort()).toEqual(Object.keys(got).sort());
    // And a real duplicate classifies through them.
    await pgDb!.sql.begin(async tx => {
      await tx`INSERT INTO principals (kind, name, created_at) VALUES ('service', 'svc', 1)`;
      let err: unknown;
      try { await tx.savepoint(sp => sp`INSERT INTO principals (kind, name, created_at) VALUES ('service', 'svc', 2)`); } catch (e) { err = e; }
      expect(principalTaken(err, "svc")).toBeInstanceOf(PrincipalTaken);
      await tx`DELETE FROM principals`;
    });
  });

  test("partial indexes keep their predicates: idx_claim_events_take on event, idx_users_idp_identity unique among subjects", async () => {
    const rows: { name: string; unique: boolean; predicate: string | null }[] = await pgDb!.sql`
      SELECT ic.relname AS name, i.indisunique AS unique, pg_get_expr(i.indpred, i.indrelid) AS predicate
      FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid WHERE ic.relname IN ('idx_claim_events_take', 'idx_users_idp_identity')`;
    const by = Object.fromEntries(rows.map(r => [r.name, r]));
    expect(by.idx_claim_events_take?.unique).toBe(false);
    expect(by.idx_claim_events_take?.predicate).toMatch(/\bevent\b.*'take'/);
    expect(by.idx_users_idp_identity?.unique).toBe(true);
    expect(by.idx_users_idp_identity?.predicate).toMatch(/\bidp_subject IS NOT NULL\b/);
    // A full unique index would refuse what SQLite accepts: two subjectless users under one issuer.
    await pgDb!.sql`INSERT INTO users (email, created_at, idp_issuer) VALUES ('a@example.com', 1, 'https://idp.example'), ('b@example.com', 1, 'https://idp.example')`;
    await pgDb!.sql`DELETE FROM users`;
  });
});
