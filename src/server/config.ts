import { dirname, join } from "node:path";

import type { HumanReach } from "./can_send.ts";
import { DEFAULT_AUTH_FAIL_LIMIT, DEFAULT_HELLO_LIMIT, type RateLimit } from "./rate_limit.ts";
import { DEFAULT_TRUSTED_PROXIES, parseCidr } from "./client_addr.ts";
import { DEFAULT_ATTACHMENT_LIMITS, DEFAULT_ATTACHMENT_USER_QUOTA, type AttachmentLimits } from "../shared/attachments.ts";
import { DEFAULT_RETENTION_DAYS, parseRetentionDays } from "../core/boards.ts";

export type Config = {
  dbPath: string;
  // Where attachment bytes are kept (src/server/blobs.ts); default blobs/ beside the database.
  blobDir: string;
  httpPort: number;
  googleClientId: string;
  googleClientSecret: string;
  orgDomain: string;
  publicUrl: string;
  messageRetentionDays: number;
  auditRetentionDays: number;
  devAuth: boolean;
  // Emails allowed to run admin commands. Empty means nobody can.
  admins: string[];
  // Who can reach another user's human; default "team".
  humanReach?: HumanReach;
  // Attachment size caps per file and per message; default local mode's.
  attachmentLimits?: AttachmentLimits;
  // The bytes of attachments one user may store, sent or not.
  attachmentUserQuota?: number;
  // Hellos per user: the burst, and the refill per second (#210).
  helloLimit?: RateLimit;
  // Authentication failures per client address (#240), and the proxies
  // whose X-Forwarded-For is believed (CIDRs; default loopback).
  authFailLimit?: RateLimit;
  trustedProxies?: string[];
  // The org Slack bridge (src/server/slack.ts); off unless both tokens are set.
  slack?: { appToken: string; botToken: string; apiUrl?: string };
};

export function loadConfig(): Config {
  const devAuth = process.env.GRAYBOARD_DEV_AUTH === "1";

  if (devAuth && process.env.GOOGLE_OAUTH_CLIENT_SECRET) {
    throw new Error(
      "GRAYBOARD_DEV_AUTH=1 must not be set alongside GOOGLE_OAUTH_CLIENT_SECRET (prevents prod misconfig)",
    );
  }

  const dbPath    = requireEnv("GRAYBOARD_DB_PATH");
  const publicUrl = requireEnv("GRAYBOARD_PUBLIC_URL");

  const googleClientId     = devAuth ? (process.env.GOOGLE_OAUTH_CLIENT_ID ?? "dev") : requireEnv("GOOGLE_OAUTH_CLIENT_ID");
  const googleClientSecret = devAuth ? "" : requireEnv("GOOGLE_OAUTH_CLIENT_SECRET");
  const orgDomain          = devAuth ? (process.env.GRAYBOARD_ORG_DOMAIN ?? "example.com") : requireEnv("GRAYBOARD_ORG_DOMAIN");

  return {
    dbPath,
    blobDir: process.env.GRAYBOARD_BLOB_DIR || join(dirname(dbPath), "blobs"),
    httpPort: parsePort(process.env.GRAYBOARD_HTTP_PORT),
    googleClientId,
    googleClientSecret,
    orgDomain,
    publicUrl: publicUrl.replace(/\/$/, ""),
    messageRetentionDays: retentionDays("GRAYBOARD_MESSAGE_RETENTION_DAYS", process.env.GRAYBOARD_MESSAGE_RETENTION_DAYS, DEFAULT_RETENTION_DAYS),
    auditRetentionDays:   retentionDays("GRAYBOARD_AUDIT_RETENTION_DAYS",   process.env.GRAYBOARD_AUDIT_RETENTION_DAYS,   90),
    devAuth,
    admins: parseList(process.env.GRAYBOARD_ADMINS),
    humanReach: parseReach(process.env.GRAYBOARD_SLACK_REACH),
    ...parseAttachmentLimits(process.env),
    helloLimit: parseRateLimit(process.env, "GRAYBOARD_HELLO", DEFAULT_HELLO_LIMIT, "hellos"),
    authFailLimit: parseRateLimit(process.env, "GRAYBOARD_AUTH_FAIL", DEFAULT_AUTH_FAIL_LIMIT, "failures"),
    trustedProxies: parseTrustedProxies(process.env.GRAYBOARD_TRUSTED_PROXIES),
    ...slackConfig(),
  };
}

// The most an operator may raise the caps to. An upload's body is held in
// memory while it's checked (src/server/uploads.ts bounds how many at once).
const MAX_FILE_CEILING = 100 * 1024 * 1024;
const MAX_TOTAL_CEILING = 250 * 1024 * 1024;

function parseAttachmentLimits(env: Record<string, string | undefined>): { attachmentLimits: AttachmentLimits; attachmentUserQuota: number } {
  const bytes = (name: string, fallback: number, ceiling = Infinity) => positiveInt(env, name, fallback, ceiling, "bytes");
  const file = bytes("GRAYBOARD_ATTACHMENT_MAX_BYTES", DEFAULT_ATTACHMENT_LIMITS.file, MAX_FILE_CEILING);
  const total = bytes("GRAYBOARD_ATTACHMENT_MAX_TOTAL_BYTES", DEFAULT_ATTACHMENT_LIMITS.total, MAX_TOTAL_CEILING);
  if (file > total) throw new Error("GRAYBOARD_ATTACHMENT_MAX_BYTES can't exceed GRAYBOARD_ATTACHMENT_MAX_TOTAL_BYTES");
  const quota = bytes("GRAYBOARD_ATTACHMENT_USER_QUOTA_BYTES", DEFAULT_ATTACHMENT_USER_QUOTA);
  if (quota < total) throw new Error("GRAYBOARD_ATTACHMENT_USER_QUOTA_BYTES can't be less than GRAYBOARD_ATTACHMENT_MAX_TOTAL_BYTES");
  return { attachmentLimits: { file, total }, attachmentUserQuota: quota };
}

// The rate's floor keeps the longest wait (one token, 1/perSec) inside a
// client's startup window (src/plugin/mcp.ts), so a limited session can still
// start; the burst's ceiling keeps a typo from switching the limit off.
const MIN_PER_SEC = 0.1;
const MAX_BURST = 10_000;

// `${prefix}_BURST` and `${prefix}_PER_SEC`.
function parseRateLimit(env: Record<string, string | undefined>, prefix: string, fallback: RateLimit, unit: string): RateLimit {
  const name = `${prefix}_PER_SEC`;
  const perSec = env[name];
  if (perSec !== undefined && perSec !== "" && !(/^[0-9]*\.?[0-9]+$/.test(perSec) && Number(perSec) >= MIN_PER_SEC)) {
    throw new Error(`${name} must be a number of at least ${MIN_PER_SEC}, not "${perSec}"`);
  }
  return {
    burst: positiveInt(env, `${prefix}_BURST`, fallback.burst, MAX_BURST, unit),
    perSec: perSec ? Number(perSec) : fallback.perSec,
  };
}

// Unset or empty: loopback. "none": nobody. Otherwise IPs or CIDRs, comma-separated.
function parseTrustedProxies(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return DEFAULT_TRUSTED_PROXIES;
  if (raw.trim() === "none") return [];
  return raw.split(",").map((c) => {
    try {
      return parseCidr(c);
    } catch (e) {
      throw new Error(`GRAYBOARD_TRUSTED_PROXIES: ${(e as Error).message}; give IPs or CIDRs, comma-separated, or "none"`);
    }
  });
}

// A positive whole-number setting: unset or empty takes the fallback.
// Plain digits only, so "1e3" and " 8" don't slip through Number().
function positiveInt(env: Record<string, string | undefined>, name: string, fallback: number, ceiling: number, unit: string): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be a positive whole number of ${unit}, not "${raw}"`);
  if (Number(raw) > ceiling) throw new Error(`${name} can be at most ${ceiling} ${unit}`);
  return Number(raw);
}

function parseReach(raw: string | undefined): HumanReach {
  if (raw === undefined || raw === "" || raw === "team") return "team";
  if (raw === "all") return "all";
  throw new Error(`GRAYBOARD_SLACK_REACH must be "team" or "all", not "${raw}"`);
}

// Half a configuration is a mistake, not "off".
function slackConfig(): { slack?: Config["slack"] } {
  const appToken = process.env.SLACK_APP_TOKEN;
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!appToken && !botToken) return {};
  if (!appToken || !botToken) throw new Error("set both SLACK_APP_TOKEN and SLACK_BOT_TOKEN to run the Slack bridge, or neither");
  if (!appToken.startsWith("xapp-")) throw new Error("SLACK_APP_TOKEN should be an app-level token (xapp-…)");
  if (!botToken.startsWith("xoxb-")) throw new Error("SLACK_BOT_TOKEN should be a bot token (xoxb-…)");
  return { slack: { appToken, botToken, ...(process.env.SLACK_API_URL ? { apiUrl: process.env.SLACK_API_URL } : {}) } };
}

function parseList(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Required env var ${name} is not set`);
  return val;
}

// Retention days parse through the shared rule (src/core/boards.ts's parseRetentionDays,
// the same one local mode's BUS_RETENTION_DAYS uses): a positive whole number of days, or
// unset for the default — refusing to start otherwise. NaN here would make every
// `created_at < cutoff` false and silently prune nothing.
function retentionDays(name: string, raw: string | undefined, fallback: number): number {
  const days = parseRetentionDays(raw, fallback);
  if (days === null) throw new Error(`${name} must be a whole number of days, not "${raw}"`);
  return days;
}

// Port 0 (an ephemeral port, what tests use) through 65535. Gated to plain digits so
// "1e3", "0x1F90" and " 8080 " don't slip through Number().
function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 8080;
  if (!/^\d+$/.test(raw) || Number(raw) > 65535) {
    throw new Error(`GRAYBOARD_HTTP_PORT must be a port between 0 and 65535, not "${raw}"`);
  }
  return Number(raw);
}
