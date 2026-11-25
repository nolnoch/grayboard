// #807 P3 C1: the SQLSTATE classifier on constructed errors (errors.pg.test.ts checks the same fields on real ones).
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { PrincipalTaken } from "../errors.ts";
import { foreignKeyViolation, pgFailure, principalTaken, SERVICE_NAME_CONSTRAINTS, uniqueViolation } from "./errors.ts";

// Bun's own class in `code`, the SQLSTATE in `errno`, as Bun.SQL reports a server error.
const pgError = (errno: string | undefined, constraint?: string) =>
  new SQL.PostgresError("boom", { code: "ERR_POSTGRES_SERVER_ERROR", errno, constraint });

test("each SQLSTATE the store handles classifies by errno", () => {
  expect(pgFailure(pgError("23505", "aliases_address_key"))).toEqual({ kind: "unique", constraint: "aliases_address_key" });
  expect(pgFailure(pgError("23503", "posts_board_fkey"))).toEqual({ kind: "foreign_key", constraint: "posts_board_fkey" });
  expect(pgFailure(pgError("40001"))).toEqual({ kind: "conflict", sqlstate: "40001" });
  expect(pgFailure(pgError("40P01"))).toEqual({ kind: "conflict", sqlstate: "40P01" });
  expect(pgFailure(pgError("55P03"))).toEqual({ kind: "lock_unavailable" });
  expect(pgFailure(pgError("25P02"))).toEqual({ kind: "aborted" });
  expect(pgFailure(new SQL.PostgresError("rolled back", { code: "ERR_POSTGRES_COMMIT_ROLLED_BACK" }))).toEqual({ kind: "aborted" });
  expect(uniqueViolation(pgError("23505", "x_key"))).toBe("x_key");
  expect(foreignKeyViolation(pgError("23503", "y_fkey"))).toBe("y_fkey");
  expect(uniqueViolation(pgError("23503", "y_fkey"))).toBeUndefined();
});

test("nothing but a PostgresError with a known errno classifies", () => {
  // `code` holds a SQLSTATE-looking value and errno another class: a classifier reading `code` would say unique.
  expect(pgFailure(new SQL.PostgresError("x", { code: "23505", errno: "42P01" }))).toBeUndefined();
  expect(pgFailure(pgError(undefined, "x_key"))).toBeUndefined();
  // Duck typing on errno would take these.
  expect(pgFailure(Object.assign(new Error("dup"), { errno: "23505", constraint: "x_key" }))).toBeUndefined();
  let sqlite: unknown;
  const db = new Database(":memory:");
  db.run("CREATE TABLE t (a TEXT UNIQUE)");
  db.run("INSERT INTO t VALUES ('a')");
  try { db.run("INSERT INTO t VALUES ('a')"); } catch (e) { sqlite = e; }
  db.close();
  expect((sqlite as { code?: string }).code).toBe("SQLITE_CONSTRAINT_UNIQUE");
  expect(pgFailure(sqlite)).toBeUndefined();
});

test("a 23505 on a principal's name is PrincipalTaken; on any other constraint the caller rethrows", () => {
  for (const c of ["principals_name_key", "teams_name_key"]) {
    const t = principalTaken(pgError("23505", c), "eng");
    expect(t).toBeInstanceOf(PrincipalTaken);
    expect(t?.name).toBe("eng");
  }
  expect(principalTaken(pgError("23505", "aliases_address_key"), "eng")).toBeUndefined();
  expect(principalTaken(pgError("23503", "principals_name_key"), "eng")).toBeUndefined();
  // An email collision is a taken name only for the caller that passes the service set.
  expect(principalTaken(pgError("23505", "users_email_key"), "eng")).toBeUndefined();
  expect(principalTaken(pgError("23505", "users_email_key"), "ingest", SERVICE_NAME_CONSTRAINTS)).toBeInstanceOf(PrincipalTaken);
  expect(principalTaken(pgError("23505", "principals_name_key"), "ingest", SERVICE_NAME_CONSTRAINTS)).toBeInstanceOf(PrincipalTaken);
  expect(principalTaken(pgError("23505", "teams_name_key"), "ingest", SERVICE_NAME_CONSTRAINTS)).toBeUndefined();
});
