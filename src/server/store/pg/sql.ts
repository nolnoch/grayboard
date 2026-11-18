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
};

export function openPg(url: string, opts: PgOptions = {}): SQL {
  return new SQL({
    url,
    max: opts.max,
    idleTimeout: opts.idleTimeout,
    connectionTimeout: opts.connectionTimeout,
    connection: opts.applicationName === undefined ? undefined : { application_name: opts.applicationName },
  });
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
// refuses one: pass the value itself and let the driver serialize it.
export type JsonParam = number | boolean | null | readonly JsonParam[] | { readonly [k: string]: JsonParam | undefined };
