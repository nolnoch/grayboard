// The Postgres pool and the row mappers every Postgres store group uses (#807 P3 C1, docs/future/postgres-server.md
// D6). Bun.SQL is the driver: it ships with the pinned Bun, so a signed, compiled release gains no dependency.
// Bun.SQL has no per-type parsers: int8 (bigint, count(*), GREATEST over int8) comes back as a string, so a store
// group maps every int8 column through int8()/int8OrNull() rather than trusting Number().
import { SQL } from "bun";

export type PgOptions = {
  // Pool size (Bun's default is 10).
  max?: number;
  // Labels the pool's connections in pg_stat_activity (a test finds a waiter by it).
  applicationName?: string;
  // Seconds; Bun's defaults otherwise.
  idleTimeout?: number;
  connectionTimeout?: number;
  // Startup parameters (GUCs) every connection of the pool sets, beside application_name: the transaction store's
  // read-only default and lock_timeout (store/pg/tx.ts).
  connection?: Record<string, string | number | boolean>;
};

export function openPg(url: string, opts: PgOptions = {}): SQL {
  return new SQL({
    url,
    max: opts.max,
    idleTimeout: opts.idleTimeout,
    connectionTimeout: opts.connectionTimeout,
    connection: opts.applicationName === undefined && opts.connection === undefined ? undefined
      : { ...opts.connection, ...(opts.applicationName === undefined ? {} : { application_name: opts.applicationName }) },
  });
}

// The TLS mode Bun.SQL resolved from a URL, for the startup line: it reads `sslmode`, `ssl` and `tls` in any case; the
// environment's `PGSSLMODE` (or `PG_SSLMODE`) applies only when the URL sets none, `TLS_DATABASE_URL` or
// `TLS_POSTGRES_DATABASE_URL` set forces TLS, and none of these means none at all. `options.sslMode` is Bun's internal
// enum (src/js/internal/sql/shared.ts), so sql.test.ts pins it: a Bun upgrade that moves it fails there. `prefer` falls
// back to plaintext silently.
const PG_TLS_MODES = ["no TLS", "TLS if offered (prefer: may be plaintext)", "TLS, certificate unchecked (require)", "TLS, CA checked (verify-ca)", "TLS, verified (verify-full)"];
export function pgTlsMode(url: string): string {
  try {
    const sql = new SQL({ url }); // the object form, as openPg uses, so env-derived TLS resolves the same
    const mode = (sql as unknown as { options?: { sslMode?: unknown } }).options?.sslMode;
    sql.close().catch(() => {});
    return typeof mode === "number" && PG_TLS_MODES[mode] ? PG_TLS_MODES[mode]! : "TLS mode unknown";
  } catch { return "TLS mode unknown"; }
}

// An int8 column as a number. Throws on null and on a value a double can't hold exactly: ids, times and counts in
// this schema stay far below 2^53, so one that doesn't is corruption, not data to round.
export function int8(v: unknown): number {
  if (v === null || v === undefined) throw new Error("int8: unexpected null");
  return safe(v);
}

export function int8OrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : safe(v);
}

function safe(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n)) throw new Error(`int8: ${String(v)} is not a safe integer`);
  return n;
}

// A jsonb parameter. A string bound to `$1::jsonb` is stored as a JSON string scalar, not parsed (probed), so the type
// refuses one at the top: pass the value itself and let the driver serialize it. Strings inside an array or object
// are values like any other.
type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [k: string]: JsonValue | undefined };
export type JsonParam = Exclude<JsonValue, string>;
// An access_log row's detail: an object, never a top-level scalar. Bound uncast, a number or boolean fails the jsonb
// column's type check (42804) and null stores SQL NULL, which no `detail->>` read tells from a missing row.
export type AuditDetail = { readonly [k: string]: JsonValue | undefined };
