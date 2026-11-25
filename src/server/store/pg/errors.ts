// SQLSTATE classification for the Postgres store (#807 P3 C1, docs/future/postgres-server.md D6). A classifier, not a
// policy: the store group that catches an error decides what a constraint means, as db.ts does for SQLite's.
// Bun.SQL puts the SQLSTATE in `errno`; `code` is Bun's own class (ERR_POSTGRES_SERVER_ERROR), so nothing here reads
// `code` but for Bun's rolled-back COMMIT and its connection failures, which carry no SQLSTATE, and only a real
// PostgresError is classified.
import { SQL } from "bun";
import { MissingParent, PrincipalTaken } from "../errors.ts";

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
// A service's name is also its users row's email (#270 D1), so services.create maps users_email_key too. Only there:
// teams.create inserts no users row, and an email collision anywhere else is not a taken principal name.
export const SERVICE_NAME_CONSTRAINTS: ReadonlySet<string> = new Set(["principals_name_key", "users_email_key"]);

// PrincipalTaken for a 23505 on one of `constraints` (the caller's own name constraints), else undefined (the caller
// rethrows `e`).
export function principalTaken(e: unknown, name: string, constraints: ReadonlySet<string> = PRINCIPAL_NAME_CONSTRAINTS): PrincipalTaken | undefined {
  const c = uniqueViolation(e);
  return c !== undefined && constraints.has(c) ? new PrincipalTaken(name) : undefined;
}

// A message's parent_id foreign key (#807 P3 C5 decision 5).
export const MESSAGE_PARENT_CONSTRAINT = "messages_parent_id_fkey";

// MissingParent for a 23503 on the message parent's foreign key, else undefined (the caller rethrows `e`). A backstop:
// messages.insert locks the parent FOR KEY SHARE before it writes, so a missing parent refuses before any statement
// can fail; a failed insert has already aborted the transaction, and the caller's commit fails TxAborted.
export function missingParent(e: unknown, parentId: number): MissingParent | undefined {
  return foreignKeyViolation(e) === MESSAGE_PARENT_CONSTRAINT ? new MissingParent(parentId) : undefined;
}

// Bun's connection-level codes (refused, which includes a name that doesn't resolve; timed out; closed), and the
// SQLSTATEs of a server not taking connections yet: 57P03 cannot_connect_now (starting up, resuming), 53300
// too_many_connections, class 08 connection exceptions.
// The startup wait retries these (connect.ts, #1418).
export function transientConnectFailure(e: unknown): boolean {
  if (!(e instanceof SQL.PostgresError)) return false;
  if (e.code.startsWith("ERR_POSTGRES_CONNECTION_")) return true;
  const state = e.errno ?? "";
  return state === "57P03" || state === "53300" || state.startsWith("08");
}
