import { describe, test, expect } from "bun:test";
import { parseAddress, formatDirectAddress, formatTeamAddress, isValidIdentityName } from "./addressing.ts";

describe("parseAddress — valid inputs", () => {
  test("direct address", () => {
    const a = parseAddress("alice@example.com/fe");
    expect(a).toEqual({ kind: "user", full: "alice@example.com/fe", email: "alice@example.com", name: "fe" });
  });

  test("team address", () => {
    const a = parseAddress("team:eng");
    expect(a).toEqual({ kind: "team", full: "team:eng", name: "eng" });
  });

  test("normalizes to lowercase", () => {
    const a = parseAddress("Alice@Example.COM/FE") as { kind: "user"; full: string };
    expect(a.full).toBe("alice@example.com/fe");
    const b = parseAddress("team:ENG") as { kind: "team"; name: string };
    expect(b.name).toBe("eng");
  });

  test("accepts any valid domain", () => {
    expect(parseAddress("a@corp.io/fe").kind).toBe("user");
    expect(parseAddress("a@mail.co.uk/fe").kind).toBe("user");
  });

  test("underscore and hyphen in identity name", () => {
    expect(parseAddress("a@example.com/my_identity-1").kind).toBe("user");
  });

  test("max length identity name (32 chars)", () => {
    expect(parseAddress(`b@example.com/${"a".repeat(32)}`).kind).toBe("user");
  });
});

describe("parseAddress — invalid inputs", () => {
  test("missing identity name", () => {
    expect(() => parseAddress("alice@example.com/")).toThrow();
  });

  test("identity name too long (33 chars)", () => {
    expect(() => parseAddress(`a@example.com/${"x".repeat(33)}`)).toThrow();
  });

  test("team name with space", () => {
    expect(() => parseAddress("team:my team")).toThrow();
  });

  test("bare email without /name", () => {
    expect(() => parseAddress("alice@example.com")).toThrow();
  });

  test("unknown scheme", () => {
    expect(() => parseAddress("channel:foo")).toThrow();
  });

  test("missing TLD", () => {
    expect(() => parseAddress("a@localhost/fe")).toThrow();
  });
});

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
