import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig } from "./config.ts";

const KEYS = [
  "GRAYBOARD_DEV_AUTH", "GRAYBOARD_DB_PATH", "GRAYBOARD_PUBLIC_URL", "GRAYBOARD_ORG_DOMAIN",
  "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GRAYBOARD_ADMINS",
  "GRAYBOARD_ATTACHMENT_MAX_BYTES", "GRAYBOARD_ATTACHMENT_MAX_TOTAL_BYTES", "GRAYBOARD_ATTACHMENT_USER_QUOTA_BYTES", "GRAYBOARD_BLOB_DIR",
  "GRAYBOARD_MESSAGE_RETENTION_DAYS", "GRAYBOARD_AUDIT_RETENTION_DAYS", "GRAYBOARD_HTTP_PORT",
  "GRAYBOARD_HELLO_BURST", "GRAYBOARD_HELLO_PER_SEC",
  "GRAYBOARD_AUTH_FAIL_BURST", "GRAYBOARD_AUTH_FAIL_PER_SEC", "GRAYBOARD_TRUSTED_PROXIES",
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
    expect(() => loadConfig()).toThrow(/GRAYBOARD_ATTACHMENT_MAX_BYTES must be a positive whole number of bytes/);
    process.env.GRAYBOARD_ATTACHMENT_MAX_BYTES = "4000";
    expect(() => loadConfig()).toThrow(/can't exceed GRAYBOARD_ATTACHMENT_MAX_TOTAL_BYTES/);
  });

  test("the hello limit defaults to 60 and 1/s; set, the burst is a whole number up to 10000 and the rate at least 0.1/s", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    expect(loadConfig().helloLimit).toEqual({ burst: 60, perSec: 1 });
    process.env.GRAYBOARD_HELLO_BURST = "10";
    process.env.GRAYBOARD_HELLO_PER_SEC = "0.5";
    expect(loadConfig().helloLimit).toEqual({ burst: 10, perSec: 0.5 });
    process.env.GRAYBOARD_HELLO_BURST = "";
    process.env.GRAYBOARD_HELLO_PER_SEC = "";
    expect(loadConfig().helloLimit).toEqual({ burst: 60, perSec: 1 });
    for (const bad of ["0", "1.5", "-3", "ten"]) {
      process.env.GRAYBOARD_HELLO_BURST = bad;
      expect(() => loadConfig()).toThrow(/GRAYBOARD_HELLO_BURST must be a positive whole number/);
    }
    process.env.GRAYBOARD_HELLO_BURST = "10001";
    expect(() => loadConfig()).toThrow(/GRAYBOARD_HELLO_BURST can be at most 10000/);
    process.env.GRAYBOARD_HELLO_BURST = "";
    // Below 0.1/s, one token's wait outlasts a client's startup window.
    for (const bad of ["0", "0.0", "0.05", "-1", "1e3", "fast"]) {
      process.env.GRAYBOARD_HELLO_PER_SEC = bad;
      expect(() => loadConfig()).toThrow(/GRAYBOARD_HELLO_PER_SEC must be a number of at least 0.1/);
    }
    process.env.GRAYBOARD_HELLO_PER_SEC = "0.1";
    expect(loadConfig().helloLimit).toEqual({ burst: 60, perSec: 0.1 });
  });

  test("the auth-failure limit parses like the hello limit, under its own names", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    expect(loadConfig().authFailLimit).toEqual({ burst: 60, perSec: 1 });
    process.env.GRAYBOARD_AUTH_FAIL_BURST = "20";
    process.env.GRAYBOARD_AUTH_FAIL_PER_SEC = "0.25";
    expect(loadConfig().authFailLimit).toEqual({ burst: 20, perSec: 0.25 });
    expect(loadConfig().helloLimit).toEqual({ burst: 60, perSec: 1 });
    process.env.GRAYBOARD_AUTH_FAIL_BURST = "0";
    expect(() => loadConfig()).toThrow(/GRAYBOARD_AUTH_FAIL_BURST must be a positive whole number of failures/);
    process.env.GRAYBOARD_AUTH_FAIL_BURST = "10001";
    expect(() => loadConfig()).toThrow(/GRAYBOARD_AUTH_FAIL_BURST can be at most 10000/);
    process.env.GRAYBOARD_AUTH_FAIL_BURST = "";
    process.env.GRAYBOARD_AUTH_FAIL_PER_SEC = "0.01";
    expect(() => loadConfig()).toThrow(/GRAYBOARD_AUTH_FAIL_PER_SEC must be a number of at least 0.1/);
  });

  test("trusted proxies: unset or empty is loopback, \"none\" is nobody, a list replaces the default and must parse", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    expect(loadConfig().trustedProxies).toEqual(["127.0.0.0/8", "::1/128"]);
    process.env.GRAYBOARD_TRUSTED_PROXIES = " ";
    expect(loadConfig().trustedProxies).toEqual(["127.0.0.0/8", "::1/128"]);
    process.env.GRAYBOARD_TRUSTED_PROXIES = "none";
    expect(loadConfig().trustedProxies).toEqual([]);
    process.env.GRAYBOARD_TRUSTED_PROXIES = "127.0.0.1, 10.0.0.0/8,fd00::/8";
    expect(loadConfig().trustedProxies).toEqual(["127.0.0.1/32", "10.0.0.0/8", "fd00::/8"]);
    for (const bad of ["10.0.0.0/33", "caddy", "127.0.0.1,", "none,10.0.0.1"]) {
      process.env.GRAYBOARD_TRUSTED_PROXIES = bad;
      expect(() => loadConfig()).toThrow(/^GRAYBOARD_TRUSTED_PROXIES: ".*" is not an IP address or CIDR/);
    }
  });

  test("retention days and the port parse strictly: garbage refuses to start, unset and empty mean the defaults", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    // Unset: the server's defaults.
    expect(loadConfig()).toMatchObject({ messageRetentionDays: 90, auditRetentionDays: 90, httpPort: 8080 });
    // Set and valid, including port 0 (an ephemeral port).
    process.env.GRAYBOARD_MESSAGE_RETENTION_DAYS = "30";
    process.env.GRAYBOARD_AUDIT_RETENTION_DAYS = "365";
    process.env.GRAYBOARD_HTTP_PORT = "0";
    expect(loadConfig()).toMatchObject({ messageRetentionDays: 30, auditRetentionDays: 365, httpPort: 0 });
    // Empty string is unset, like local mode's BUS_RETENTION_DAYS.
    process.env.GRAYBOARD_MESSAGE_RETENTION_DAYS = "";
    process.env.GRAYBOARD_AUDIT_RETENTION_DAYS = "";
    process.env.GRAYBOARD_HTTP_PORT = "";
    expect(loadConfig()).toMatchObject({ messageRetentionDays: 90, auditRetentionDays: 90, httpPort: 8080 });
    // NaN would make every `created_at < cutoff` false and silently prune nothing.
    process.env.GRAYBOARD_MESSAGE_RETENTION_DAYS = "abc";
    expect(() => loadConfig()).toThrow(/GRAYBOARD_MESSAGE_RETENTION_DAYS must be a whole number of days, not "abc"/);
    process.env.GRAYBOARD_MESSAGE_RETENTION_DAYS = "30";
    process.env.GRAYBOARD_AUDIT_RETENTION_DAYS = "0";
    expect(() => loadConfig()).toThrow(/GRAYBOARD_AUDIT_RETENTION_DAYS must be a whole number of days, not "0"/);
    process.env.GRAYBOARD_AUDIT_RETENTION_DAYS = "365";
    process.env.GRAYBOARD_HTTP_PORT = "notaport";
    expect(() => loadConfig()).toThrow(/GRAYBOARD_HTTP_PORT must be a port between 0 and 65535, not "notaport"/);
    process.env.GRAYBOARD_HTTP_PORT = "70000";
    expect(() => loadConfig()).toThrow(/GRAYBOARD_HTTP_PORT must be a port between 0 and 65535, not "70000"/);
    // Number() would accept these; the digit gate refuses them like local's day rule.
    for (const weird of ["1e3", "0x1F90", " 8080 ", "8080.0", "+8080", "-1"]) {
      process.env.GRAYBOARD_HTTP_PORT = weird;
      expect(() => loadConfig()).toThrow(/GRAYBOARD_HTTP_PORT must be a port between 0 and 65535/);
    }
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
