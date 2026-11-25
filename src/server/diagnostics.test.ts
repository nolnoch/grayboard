import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { SQL } from "bun";
import { diagnosticOrigin, errorDiagnostic, failureDiagnostic, type FailureSource } from "./diagnostics.ts";
import { S3StoreError } from "./s3_blobs.ts";
import { TxAborted } from "./store/pg/tx.ts";

const thrown = (fn: () => unknown) => { try { fn(); } catch (e) { return e; } throw new Error("did not throw"); };

test("diagnostic provenance comes only from fixed catch-site identifiers", () => {
  expect(failureDiagnostic("hosted-tool")).toEqual({ source: "src/server/mcp.ts", operation: "tool", category: "unexpected" });
  expect(failureDiagnostic("slack-bus")).toEqual({ source: "src/server/slack.ts", operation: "bus.call", category: "unexpected" });
  expect(failureDiagnostic("secret.ts:1:2" as FailureSource)).toEqual({ source: "server", operation: "unknown", category: "unexpected" });
  expect(failureDiagnostic("__proto__" as FailureSource)).toEqual({ source: "server", operation: "unknown", category: "unexpected" });
  const untrusted = { toString() { throw new Error("must not inspect diagnostic inputs"); } };
  expect(failureDiagnostic(untrusted as unknown as FailureSource)).toEqual({ source: "server", operation: "unknown", category: "unexpected" });
  expect(diagnosticOrigin("https://user:password@example.com/auth?access_token=secret#secret")).toBe("https://example.com");
  expect(diagnosticOrigin("Bearer secret")).toBe("[invalid origin]");
});

test("error diagnostics carry only the class and an allowlisted code, from data descriptors", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE t (x PRIMARY KEY)"); db.run("INSERT INTO t VALUES (1)");
  expect(errorDiagnostic(thrown(() => db.run("INSERT INTO t VALUES (1)")))).toEqual({ class: "SQLiteError", code: "SQLITE_CONSTRAINT_PRIMARYKEY" });
  expect(errorDiagnostic(thrown(() => readFileSync("/nonexistent/secret")))).toEqual({ class: "Error", code: "ENOENT" });
  expect(errorDiagnostic(new TypeError("Bearer secret"))).toEqual({ class: "TypeError" });
  expect(errorDiagnostic(undefined)).toEqual({});
  expect(errorDiagnostic("Bearer secret")).toEqual({ class: "non-error" });
  expect(errorDiagnostic(Object.assign(new Error(), { name: "Bearer secret", code: "Bearer secret" }))).toEqual({ class: "[unrecognized]" });
  expect(errorDiagnostic(Object.assign(new Error(), { name: "secretvalue", code: "SQLITE_BUSY secret" }))).toEqual({ class: "[unrecognized]" });
  expect(errorDiagnostic(Object.assign(new Error(), { code: 13 }))).toEqual({ class: "Error" });
  // #1608: S3's codes only on the S3 classes, bounded.
  expect(errorDiagnostic(new S3StoreError("S3 put on s3://b/: InternalError: secret", "InternalError"))).toEqual({ class: "S3StoreError", code: "InternalError" });
  expect(errorDiagnostic(Object.assign(new Error("x"), { name: "S3Error", code: "NoSuchBucket" }))).toEqual({ class: "S3Error", code: "NoSuchBucket" });
  expect(errorDiagnostic(Object.assign(new Error(), { code: "InternalError" }))).toEqual({ class: "Error" });
  expect(errorDiagnostic(new S3StoreError("x", "Bearer secret"))).toEqual({ class: "S3StoreError" });
  expect(errorDiagnostic(new S3StoreError("x", "A".repeat(49)))).toEqual({ class: "S3StoreError" });
  let reads = 0;
  const getters = new Error();
  for (const key of ["name", "code", "message", "stack", "cause"]) Object.defineProperty(getters, key, { get() { reads++; return "ENOENT"; } });
  expect(errorDiagnostic(getters)).toEqual({ class: "Error" });
  const trap = () => { reads++; throw new Error("secret"); };
  expect(errorDiagnostic(new Proxy(new Error(), { get: trap, getOwnPropertyDescriptor: trap }))).toEqual({ class: "[unrecognized]" });
  expect(errorDiagnostic(new Proxy({}, { getPrototypeOf: trap }))).toEqual({ class: "[unrecognized]" });
  expect(reads).toBe(2);
});

// #807 P3 C2: Bun.SQL's class code and the SQLSTATE it keeps in `errno`, both bounded; a TxAborted carries its cause's.
test("Postgres errors carry Bun's code and a bounded SQLSTATE; a forged errno doesn't", () => {
  const unique = new SQL.PostgresError("duplicate key value violates unique constraint \"secret\"", { code: "ERR_POSTGRES_SERVER_ERROR", errno: "23505" });
  expect(errorDiagnostic(unique)).toEqual({ class: "PostgresError", code: "ERR_POSTGRES_SERVER_ERROR", sqlstate: "23505" });
  expect(errorDiagnostic(new SQL.PostgresError("x", { code: "ERR_POSTGRES_SERVER_ERROR", errno: "Bearer secret" })))
    .toEqual({ class: "PostgresError", code: "ERR_POSTGRES_SERVER_ERROR" });
  expect(errorDiagnostic(Object.assign(new Error(), { code: "ERR_POSTGRES_Bearer secret", errno: "235050" }))).toEqual({ class: "Error" });
  // A Node system error's errno is a number: file errors keep today's shape.
  expect(errorDiagnostic(thrown(() => readFileSync("/nonexistent/secret")))).toEqual({ class: "Error", code: "ENOENT" });
  const aborted = new SQL.PostgresError("current transaction is aborted", { code: "ERR_POSTGRES_SERVER_ERROR", errno: "25P02" });
  expect(errorDiagnostic(TxAborted.wrap(aborted))).toEqual({ class: "TxAbortedError", code: "ERR_POSTGRES_SERVER_ERROR", sqlstate: "25P02" });
  const rolledBack = new SQL.PostgresError("COMMIT was rolled back", { code: "ERR_POSTGRES_COMMIT_ROLLED_BACK" });
  expect(errorDiagnostic(TxAborted.wrap(rolledBack))).toEqual({ class: "TxAbortedError", code: "ERR_POSTGRES_COMMIT_ROLLED_BACK" });
});
