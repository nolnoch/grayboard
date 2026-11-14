import { describe, test, expect } from "bun:test";
import { formatDirectAddress, formatTeamAddress, isValidIdentityName, normalizeIdentityName } from "./addressing.ts";
import { normalizeAliasName } from "../core/addresses.ts";

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

test("a refused name is quoted without control characters and cut at 64 characters (#544 item 3)", () => {
  const raw = "bad\x1b[2J\nname\x07";
  for (const r of [normalizeIdentityName(raw), normalizeAliasName(raw)]) {
    expect(r.ok).toBe(false);
    const error = (r as { error: string }).error;
    expect(error).toStartWith('invalid identity name "bad[2Jname"');
    expect(error).not.toMatch(/\p{Cc}/u);
  }
  const long = normalizeIdentityName(`${"x".repeat(70)}!`);
  expect((long as { error: string }).error).toStartWith(`invalid identity name "${"x".repeat(64)}…"`);
});
