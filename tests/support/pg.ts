// Postgres for tests (#807 P3 C1, docs/future/postgres-server.md D9). GRAYBOARD_TEST_PG_URL names an admin database on
// a cluster (…/postgres); without it every describePg block skips, and with GRAYBOARD_TEST_PG_REQUIRED=1 loading this
// file throws instead, so a lost service can't turn a suite silently green. Developer setup: AGENTS.md (docker line).
//
// Each test gets its own database, created from a template migrated once per migration set: `bun test --parallel`
// runs files in worker processes, so the template is built under a cross-process advisory lock and named by a hash of
// the migrations (several lanes can share one cluster; a 0001 edit gets a fresh template). Database per test rather
// than schema per test: advisory locks and NOTIFY channels are per database, so a test's locks are its own.
import { describe } from "bun:test";
import { createHash } from "node:crypto";
import type { SQL } from "bun";
import { migrate, MIGRATIONS, RECORD_TABLE_SQL, type Migration } from "../../src/server/store/pg/migrate.ts";
import { openPg } from "../../src/server/store/pg/sql.ts";

export const PG_URL = process.env.GRAYBOARD_TEST_PG_URL || undefined;
if (!PG_URL && process.env.GRAYBOARD_TEST_PG_REQUIRED === "1") {
  throw new Error("GRAYBOARD_TEST_PG_REQUIRED=1 but GRAYBOARD_TEST_PG_URL is unset: the Postgres tests would skip");
}

export const describePg = describe.skipIf(!PG_URL);

// The template build's session lock key (distinct from migrate's transaction lock, which runs inside the build).
const TEMPLATE_LOCK = "7454656d706c6174"; // "tTemplat"
// A killed run's databases older than this are dropped by the next template check.
const LEAK_AGE_SECONDS = 6 * 3600;
// Another migration set's template unused this long is dropped too (its COMMENT stamp, refreshed by each process that
// uses it). An unstamped one, built by a checkout from before stamps, is stamped on first sight and ages from there, so
// a concurrent older checkout never loses its template mid-run. One coming back to an aged-out template rebuilds it in
// about a second.
export const TEMPLATE_AGE_MS = 7 * 24 * 3600 * 1000;
const IDENT = /^[a-z0-9_]+$/;

export function pgUrl(database: string): string {
  if (!PG_URL) throw new Error("GRAYBOARD_TEST_PG_URL is unset");
  const u = new URL(PG_URL);
  u.pathname = `/${database}`;
  return u.toString();
}

const quoted = (name: string) => {
  if (!IDENT.test(name)) throw new Error(`not a test database name: ${name}`);
  return `"${name}"`;
};

let adminPool: SQL | undefined;
function admin(): SQL {
  if (!PG_URL) throw new Error("GRAYBOARD_TEST_PG_URL is unset");
  return adminPool ??= openPg(PG_URL, { max: 2, applicationName: "gb-test-admin" });
}

// The template's name for a migration set: any change to a version, name or text, or to the runner's record table,
// names a new template.
export function templateName(migrations: readonly Migration[] = MIGRATIONS, recordTable = RECORD_TABLE_SQL): string {
  const h = createHash("sha256").update(`${recordTable}\0`);
  for (const m of migrations) h.update(`${m.version}\0${m.name}\0${m.sql}\0`);
  return `gb_tpl_${h.digest("hex").slice(0, 12)}`;
}

const templates = new Map<string, Promise<{ name: string; built: boolean }>>();

// The migrated template for `migrations`, built by whichever process gets there first. `built` says this call built
// it (a test asserts a second process doesn't).
export function pgTemplate(migrations: readonly Migration[] = MIGRATIONS): Promise<{ name: string; built: boolean }> {
  const name = templateName(migrations);
  let t = templates.get(name);
  if (!t) {
    t = buildTemplate(name, migrations);
    templates.set(name, t);
    // A failed build isn't cached: the next caller retries it.
    t.catch(() => templates.delete(name));
  }
  return t;
}

async function buildTemplate(name: string, migrations: readonly Migration[]): Promise<{ name: string; built: boolean }> {
  // A session lock (CREATE DATABASE can't run in a transaction block), so lock and unlock on one reserved connection;
  // a builder that dies closes its connection, which frees the lock.
  const conn = await admin().reserve();
  try {
    await conn.unsafe(`SELECT pg_advisory_lock(${BigInt("0x" + TEMPLATE_LOCK)})`);
    try {
      await sweepLeaks(conn, name);
      const [exists] = await conn`SELECT 1 FROM pg_database WHERE datname = ${name}`;
      if (exists) {
        await stampTemplate(conn, name);
        return { name, built: false };
      }
      // A builder that died mid-build left this behind.
      const build = `${name}_build`;
      await conn.unsafe(`DROP DATABASE IF EXISTS ${quoted(build)} WITH (FORCE)`);
      await conn.unsafe(`CREATE DATABASE ${quoted(build)} TEMPLATE template0`);
      const db = openPg(pgUrl(build), { max: 1, applicationName: "gb-test-template" });
      try { await migrate(db, migrations); } finally { await db.close(); }
      // Visible under its final name only when complete; no one may connect (a connected template refuses CREATE
      // DATABASE … TEMPLATE with 55006 under parallel workers).
      await conn.unsafe(`ALTER DATABASE ${quoted(build)} RENAME TO ${quoted(name)}`);
      await conn.unsafe(`ALTER DATABASE ${quoted(name)} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`);
      await stampTemplate(conn, name);
      return { name, built: true };
    } finally {
      await conn.unsafe(`SELECT pg_advisory_unlock(${BigInt("0x" + TEMPLATE_LOCK)})`);
    }
  } finally {
    conn.release();
  }
}

// The template's last use, for the sweep: COMMENT ON DATABASE works on a template no one may connect to.
async function stampTemplate(conn: SQL, name: string): Promise<void> {
  await conn.unsafe(`COMMENT ON DATABASE ${quoted(name)} IS '${Date.now()}'`);
}

// Under the template lock: a killed run's per-test databases, and other migration sets' templates (and dead builds)
// whose stamp is older than TEMPLATE_AGE_MS; an unstamped one is stamped instead. `current` is the caller's template,
// never dropped. A name this file couldn't have made (quoted() refuses it) isn't ours: it's left alone.
export async function sweepLeaks(conn: SQL, current: string): Promise<void> {
  const rows: { datname: string }[] = await conn`SELECT datname FROM pg_database WHERE datname LIKE 'gbt\_%'`;
  const cutoff = Math.floor(Date.now() / 1000) - LEAK_AGE_SECONDS;
  for (const { datname } of rows) {
    if (!IDENT.test(datname)) continue;
    const sec = Number(/^gbt_(\d+)_/.exec(datname)?.[1]);
    if (Number.isFinite(sec) && sec < cutoff) await conn.unsafe(`DROP DATABASE IF EXISTS ${quoted(datname)} WITH (FORCE)`);
  }
  const templates: { datname: string; stamp: string | null }[] =
    await conn`SELECT datname, shobj_description(oid, 'pg_database') AS stamp FROM pg_database WHERE datname LIKE 'gb\_tpl\_%'`;
  for (const { datname, stamp } of templates) {
    if (datname === current || !IDENT.test(datname)) continue;
    const at = stamp === null ? NaN : Number(stamp);
    if (!Number.isFinite(at)) {
      await stampTemplate(conn, datname);
      continue;
    }
    if (Date.now() - at < TEMPLATE_AGE_MS) continue;
    await conn.unsafe(`ALTER DATABASE ${quoted(datname)} WITH IS_TEMPLATE false`);
    await conn.unsafe(`DROP DATABASE IF EXISTS ${quoted(datname)} WITH (FORCE)`);
  }
}

export type PgDatabase = { name: string; url: string; sql: SQL; [Symbol.asyncDispose](): Promise<void> };

let serial = 0;
async function createDatabase(template: string, opts: { max?: number }): Promise<PgDatabase> {
  // The random part: bun test reloads this module per file in a worker, so `serial` restarts with the pid unchanged.
  const name = `gbt_${Math.floor(Date.now() / 1000)}_${process.pid}_${++serial}_${crypto.randomUUID().slice(0, 8)}`;
  await admin().unsafe(`CREATE DATABASE ${quoted(name)} TEMPLATE ${quoted(template)}`);
  const url = pgUrl(name);
  const sql = openPg(url, { max: opts.max ?? 4, applicationName: "gb-test" });
  return {
    name, url, sql,
    async [Symbol.asyncDispose]() {
      await sql.close();
      await admin().unsafe(`DROP DATABASE IF EXISTS ${quoted(name)} WITH (FORCE)`);
    },
  };
}

// A fresh database with the server schema: `await using db = await pgDatabase();`.
export async function pgDatabase(opts: { max?: number } = {}): Promise<PgDatabase> {
  return createDatabase((await pgTemplate()).name, opts);
}

// A fresh database with no schema at all, for the migration runner's own tests.
export function pgEmptyDatabase(opts: { max?: number } = {}): Promise<PgDatabase> {
  return createDatabase("template0", opts);
}
