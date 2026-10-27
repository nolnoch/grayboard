import { expect, test } from "bun:test";
import { diagnosticOrigin, failureLocations } from "./diagnostics.ts";

test("diagnostics retain source locations, not error messages, credential properties or auth URLs", () => {
  const cause = new Error("client_secret=secret");
  const error = Object.assign(new Error("Bearer secret", { cause }), { access_token: "secret", authorization: "secret" });
  error.stack = "Error: Bearer secret\n    at query (/private/server/mcp.ts:12:34)\n    at auth (https://user:password@example.com/secret.ts:1:2)";
  cause.stack = "Error: client_secret=secret\n    at write (/private/server/db.ts:56:78)";
  cause.cause = error;
  expect(failureLocations(error)).toEqual(["mcp.ts:12:34", "db.ts:56:78"]);
  expect(failureLocations({ token: "secret" })).toEqual([]);
  expect(diagnosticOrigin("https://user:password@example.com/auth?access_token=secret#secret")).toBe("https://example.com");
  expect(diagnosticOrigin("Bearer secret")).toBe("[invalid origin]");
});
