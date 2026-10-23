import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig } from "./config.ts";

const KEYS = [
  "GRAYBOARD_DEV_AUTH", "GRAYBOARD_DB_PATH", "GRAYBOARD_PUBLIC_URL", "GRAYBOARD_ORG_DOMAIN",
  "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GRAYBOARD_ADMINS",
  "GRAYBOARD_ATTACHMENT_MAX_BYTES", "GRAYBOARD_ATTACHMENT_MAX_TOTAL_BYTES", "GRAYBOARD_ATTACHMENT_USER_QUOTA_BYTES", "GRAYBOARD_BLOB_DIR",
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

  test("GRAYBOARD_ADMINS is a trimmed, lowercased email list; unset means none", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    expect(loadConfig().admins).toEqual([]);
    process.env.GRAYBOARD_ADMINS = " Alice@Example.com, bob@example.com ,,";
    expect(loadConfig().admins).toEqual(["alice@example.com", "bob@example.com"]);
  });

  test("attachment bytes go in blobs/ beside the database unless GRAYBOARD_BLOB_DIR says otherwise", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    process.env.GRAYBOARD_DB_PATH = "/var/lib/grayboard/bus.db";
    expect(loadConfig().blobDir).toBe("/var/lib/grayboard/blobs");
    process.env.GRAYBOARD_BLOB_DIR = "/srv/blobs";
    expect(loadConfig().blobDir).toBe("/srv/blobs");
  });

  test("attachment limits default to local mode's; set, they must be byte counts with the file cap within the total", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    expect(loadConfig().attachmentLimits).toEqual({ file: 10 * 1024 * 1024, total: 25 * 1024 * 1024 });
    process.env.GRAYBOARD_ATTACHMENT_MAX_BYTES = "1000";
    process.env.GRAYBOARD_ATTACHMENT_MAX_TOTAL_BYTES = "3000";
    expect(loadConfig().attachmentLimits).toEqual({ file: 1000, total: 3000 });
    process.env.GRAYBOARD_ATTACHMENT_MAX_BYTES = "10MB";
    expect(() => loadConfig()).toThrow(/GRAYBOARD_ATTACHMENT_MAX_BYTES must be a positive number of bytes/);
    process.env.GRAYBOARD_ATTACHMENT_MAX_BYTES = "4000";
    expect(() => loadConfig()).toThrow(/can't exceed GRAYBOARD_ATTACHMENT_MAX_TOTAL_BYTES/);
  });

  test("attachment caps have ceilings, and the per-user quota holds at least one message", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    expect(loadConfig().attachmentUserQuota).toBe(1024 * 1024 * 1024);
    process.env.GRAYBOARD_ATTACHMENT_MAX_BYTES = String(100 * 1024 * 1024 + 1);
    process.env.GRAYBOARD_ATTACHMENT_MAX_TOTAL_BYTES = String(300 * 1024 * 1024);
    expect(() => loadConfig()).toThrow(/GRAYBOARD_ATTACHMENT_MAX_BYTES can be at most 104857600 bytes/);
    process.env.GRAYBOARD_ATTACHMENT_MAX_BYTES = "1000";
    expect(() => loadConfig()).toThrow(/GRAYBOARD_ATTACHMENT_MAX_TOTAL_BYTES can be at most 262144000 bytes/);
    process.env.GRAYBOARD_ATTACHMENT_MAX_TOTAL_BYTES = "3000";
    process.env.GRAYBOARD_ATTACHMENT_USER_QUOTA_BYTES = "2999";
    expect(() => loadConfig()).toThrow(/USER_QUOTA_BYTES can't be less than GRAYBOARD_ATTACHMENT_MAX_TOTAL_BYTES/);
    process.env.GRAYBOARD_ATTACHMENT_USER_QUOTA_BYTES = "5000";
    expect(loadConfig().attachmentUserQuota).toBe(5000);
  });
});
