import { expect, test } from "bun:test";
import { isTrustedOrigin, permitsOrigin } from "./origin.ts";

test("only the exact serialized trusted origin passes", () => {
  const trusted = "https://bus.example.com";
  expect(isTrustedOrigin("https://bus.example.com", trusted)).toBe(true);
  // An explicit default port is the same serialized origin.
  expect(isTrustedOrigin("https://bus.example.com:443", trusted)).toBe(true);
  for (const bad of ["https://bus.example.com/", "https://BUS.example.com", "https://u@bus.example.com", "http://bus.example.com", "https://evil.example.com", "null", "", "https://bus.example.com, https://evil.example.com"]) {
    expect(isTrustedOrigin(bad, trusted)).toBe(false);
  }
  expect(isTrustedOrigin("http://localhost:8080", "http://localhost:8080")).toBe(true);
  expect(isTrustedOrigin("http://localhost:80", "http://localhost")).toBe(true);
  expect(isTrustedOrigin("http://localhost:8081", "http://localhost:8080")).toBe(false);
});

test("a missing Origin header passes; a present one must match", () => {
  expect(permitsOrigin(null, "https://bus.example.com")).toBe(true);
  expect(permitsOrigin("https://evil.example.com", "https://bus.example.com")).toBe(false);
});
