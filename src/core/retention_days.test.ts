import { describe, expect, test } from "bun:test";

import { DEFAULT_RETENTION_DAYS, parseRetentionDays } from "./boards.ts";
// Both modes must go through the shared rule: if either re-types it locally, the
// shapes below diverge and this test names the side that drifted (#151).
import { retentionDays as localRetentionDays } from "../local/retention.ts";

// The server's wrapper lives in config.ts (not exported); exercise it through
// its own module to prove the same rule, not a re-typed copy.
import { loadConfig } from "../server/config.ts";

const CASES: [string | undefined, number | null][] = [
  [undefined, DEFAULT_RETENTION_DAYS],
  ["", DEFAULT_RETENTION_DAYS],
  ["1", 1],
  ["30", 30],
  ["365", 365],
  // Not a positive whole number of days.
  ["0", null],
  ["-1", null],
  ["1.5", null],
  ["30d", null],
  [" 7", null],
  ["1e2", null],
  ["0x10", null],
  ["+7", null],
];

describe("parseRetentionDays (the one rule, shared by both modes)", () => {
  test("unset/empty means the fallback; otherwise a positive whole number of days, or null", () => {
    for (const [raw, expected] of CASES) expect(parseRetentionDays(raw, 90)).toBe(expected);
  });

  test("local mode's BUS_RETENTION_DAYS follows the same shape", () => {
    for (const [raw, expected] of CASES) {
      expect(localRetentionDays({ BUS_RETENTION_DAYS: raw ?? "" })).toBe(expected);
    }
  });
});

describe("the server parses GRAYBOARD_* through the same rule", () => {
  const KEYS = ["GRAYBOARD_DEV_AUTH", "GRAYBOARD_DB_PATH", "GRAYBOARD_PUBLIC_URL", "GRAYBOARD_MESSAGE_RETENTION_DAYS"];

  function withEnv(values: Record<string, string | undefined>): () => void {
    const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    process.env.GRAYBOARD_DB_PATH = ":memory:";
    process.env.GRAYBOARD_PUBLIC_URL = "https://grayboard.example.com";
    Object.assign(process.env, values);
    return () => {
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    };
  }

  test("set and valid parses; unset means the default", () => {
    const restore = withEnv({ GRAYBOARD_DEV_AUTH: "1" });
    try {
      expect(loadConfig().messageRetentionDays).toBe(DEFAULT_RETENTION_DAYS);
      process.env.GRAYBOARD_MESSAGE_RETENTION_DAYS = "30";
      expect(loadConfig().messageRetentionDays).toBe(30);
    } finally {
      restore();
    }
  });

  test("every value the shared rule refuses makes the server refuse to start", () => {
    for (const [raw, expected] of CASES) {
      if (expected !== null) continue;
      const restore = withEnv({ GRAYBOARD_DEV_AUTH: "1", GRAYBOARD_MESSAGE_RETENTION_DAYS: raw });
      try {
        expect(() => loadConfig()).toThrow(`GRAYBOARD_MESSAGE_RETENTION_DAYS must be a whole number of days, not "${raw}"`);
      } finally {
        restore();
      }
    }
  });
});
