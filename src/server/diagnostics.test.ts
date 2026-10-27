import { expect, test } from "bun:test";
import { diagnosticOrigin, failureDiagnostic, type FailureSource } from "./diagnostics.ts";

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
