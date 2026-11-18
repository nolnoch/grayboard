// SQLSTATE classification for the Postgres store (#807 P3 C1, docs/future/postgres-server.md D6). A classifier, not a
// policy: the store group that catches an error decides what a constraint means, as db.ts does for SQLite's.
// Bun.SQL puts the SQLSTATE in `errno`; `code` is Bun's own class (ERR_POSTGRES_SERVER_ERROR), so nothing here reads
// `code` but for Bun's rolled-back COMMIT, which carries no SQLSTATE, and only a real PostgresError is classified.
import { SQL } from "bun";
import { PrincipalTaken } from "../errors.ts";

export type PgFailure =
  | { kind: "unique"; constraint: string }          // 23505
  | { kind: "foreign_key"; constraint: string }     // 23503
  | { kind: "conflict"; sqlstate: "40001" | "40P01" } // serialization failure, deadlock
  | { kind: "lock_unavailable" }                    // 55P03
  | { kind: "aborted" };                            // 25P02, or COMMIT rolled back: a body swallowed an error without a savepoint

export function pgFailure(e: unknown): PgFailure | undefined {
  if (!(e instanceof SQL.PostgresError)) return undefined;
  // A body that swallowed an error and ran nothing after it: the server answers COMMIT with ROLLBACK, and Bun rejects
  // with its own code and no SQLSTATE.
  if (e.code === "ERR_POSTGRES_COMMIT_ROLLED_BACK") return { kind: "aborted" };
  const constraint = e.constraint ?? "";
  switch (e.errno) {
    case "23505": return { kind: "unique", constraint };
    case "23503": return { kind: "foreign_key", constraint };
    case "40001": case "40P01": return { kind: "conflict", sqlstate: e.errno };
    case "55P03": return { kind: "lock_unavailable" };
    case "25P02": return { kind: "aborted" };
    default: return undefined;
  }
}

// The constraint a 23505 names, or undefined for any other error (db.ts's uniqueViolation names the column instead).
export function uniqueViolation(e: unknown): string | undefined {
  const f = pgFailure(e);
  return f?.kind === "unique" ? f.constraint : undefined;
}

export function foreignKeyViolation(e: unknown): string | undefined {
  const f = pgFailure(e);
  return f?.kind === "foreign_key" ? f.constraint : undefined;
}

// The two UNIQUE constraints on a principal's name: a team or user created in a race for a taken name.
export const PRINCIPAL_NAME_CONSTRAINTS: ReadonlySet<string> = new Set(["principals_name_key", "teams_name_key"]);

// PrincipalTaken for a 23505 on a principal's name, else undefined (the caller rethrows `e`).
export function principalTaken(e: unknown, name: string): PrincipalTaken | undefined {
  const c = uniqueViolation(e);
  return c !== undefined && PRINCIPAL_NAME_CONSTRAINTS.has(c) ? new PrincipalTaken(name) : undefined;
}
