import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { diagnosticOrigin, errorDiagnostic, failureDiagnostic, type FailureSource } from "./diagnostics.ts";

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
  let reads = 0;
  const getters = new Error();
  for (const key of ["name", "code", "message", "stack", "cause"]) Object.defineProperty(getters, key, { get() { reads++; return "ENOENT"; } });
  expect(errorDiagnostic(getters)).toEqual({ class: "Error" });
  const trap = () => { reads++; throw new Error("secret"); };
  expect(errorDiagnostic(new Proxy(new Error(), { get: trap, getOwnPropertyDescriptor: trap }))).toEqual({ class: "[unrecognized]" });
  expect(errorDiagnostic(new Proxy({}, { getPrototypeOf: trap }))).toEqual({ class: "[unrecognized]" });
  expect(reads).toBe(2);
});
