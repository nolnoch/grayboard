import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig } from "./config.ts";

const KEYS = [
  "GRAYBOARD_DEV_AUTH", "GRAYBOARD_DB_PATH", "GRAYBOARD_PUBLIC_URL", "GRAYBOARD_ORG_DOMAIN",
  "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET",
];

describe("loadConfig", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    process.env.GRAYBOARD_DB_PATH = ":memory:";
    process.env.GRAYBOARD_PUBLIC_URL = "https://grayboard.example.com";
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("dev auth refuses to start alongside a Google client secret", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "secret";
    expect(() => loadConfig()).toThrow(/GRAYBOARD_DEV_AUTH=1/);
  });

  test("dev auth starts without Google credentials", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    expect(loadConfig().devAuth).toBe(true);
  });
});
