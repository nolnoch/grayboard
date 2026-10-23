import { dirname, join } from "node:path";

import type { HumanReach } from "./can_send.ts";
import { DEFAULT_ATTACHMENT_LIMITS, type AttachmentLimits } from "../shared/attachments.ts";

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
    httpPort: parseInt(process.env.GRAYBOARD_HTTP_PORT ?? "8080", 10),
    googleClientId,
    googleClientSecret,
    orgDomain,
    publicUrl: publicUrl.replace(/\/$/, ""),
    messageRetentionDays: parseInt(process.env.GRAYBOARD_MESSAGE_RETENTION_DAYS ?? "90", 10),
    auditRetentionDays:   parseInt(process.env.GRAYBOARD_AUDIT_RETENTION_DAYS   ?? "90", 10),
    devAuth,
    admins: parseList(process.env.GRAYBOARD_ADMINS),
    humanReach: parseReach(process.env.GRAYBOARD_SLACK_REACH),
    attachmentLimits: parseAttachmentLimits(process.env),
    ...slackConfig(),
  };
}

function parseAttachmentLimits(env: Record<string, string | undefined>): AttachmentLimits {
  const bytes = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be a positive number of bytes, not "${raw}"`);
    return Number(raw);
  };
  const file = bytes("GRAYBOARD_ATTACHMENT_MAX_BYTES", DEFAULT_ATTACHMENT_LIMITS.file);
  const total = bytes("GRAYBOARD_ATTACHMENT_MAX_TOTAL_BYTES", DEFAULT_ATTACHMENT_LIMITS.total);
  if (file > total) throw new Error("GRAYBOARD_ATTACHMENT_MAX_BYTES can't exceed GRAYBOARD_ATTACHMENT_MAX_TOTAL_BYTES");
  return { file, total };
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
