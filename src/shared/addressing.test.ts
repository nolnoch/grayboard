import { describe, test, expect } from "bun:test";
import { formatDirectAddress, formatTeamAddress, isValidIdentityName, normalizeIdentityName } from "./addressing.ts";

describe("formatDirectAddress", () => {
  test("produces correct canonical string", () => {
    expect(formatDirectAddress("Alice@Example.com", "FE")).toBe("alice@example.com/fe");
  });

  test("rejects address with no TLD", () => {
    expect(() => formatDirectAddress("alice@localhost", "fe")).toThrow();
  });
});

describe("formatTeamAddress", () => {
  test("produces correct canonical string", () => {
    expect(formatTeamAddress("ENG")).toBe("team:eng");
  });

  test("rejects name with spaces", () => {
    expect(() => formatTeamAddress("my team")).toThrow();
  });
});

describe("isValidIdentityName", () => {
  test("valid names", () => {
    expect(isValidIdentityName("fe")).toBe(true);
    expect(isValidIdentityName("my-ide_1")).toBe(true);
    expect(isValidIdentityName("a".repeat(32))).toBe(true);
  });

  test("invalid names", () => {
    expect(isValidIdentityName("")).toBe(false);
    expect(isValidIdentityName("a".repeat(33))).toBe(false);
    expect(isValidIdentityName("MY NAME")).toBe(false);
    expect(isValidIdentityName("name@bad")).toBe(false);
  });
});

describe("normalizeIdentityName", () => {
  test("lowercases and keeps a valid name", () => {
    expect(normalizeIdentityName("Gray")).toEqual({ ok: true, name: "gray" });
    expect(normalizeIdentityName("be-stream")).toEqual({ ok: true, name: "be-stream" });
    expect(normalizeIdentityName("My_IDE_1")).toEqual({ ok: true, name: "my_ide_1" });
  });

  test("refuses what the server would, with the reason", () => {
    for (const raw of ["", "Gray!", "a".repeat(33), "my name"]) {
      const r = normalizeIdentityName(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain(`"${raw}"`);
    }
  });
});
