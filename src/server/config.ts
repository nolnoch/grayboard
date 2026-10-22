import type { HumanReach } from "./can_send.ts";

// An IdP's endpoints. Unset in production, where each provider has fixed
// ones; tests point them at a local fake IdP.
export type IdpEndpoints = { authorize: string; token: string; jwks: string };

// Google sign-in: on iff GOOGLE_OAUTH_CLIENT_ID is set. A login passes on
// hd == orgDomain or an email in allowedEmails; at least one is set.
export type GoogleConfig = {
  clientId: string;
  clientSecret: string;
  orgDomain?: string;
  allowedEmails: string[];
  endpoints?: IdpEndpoints;
};

// Microsoft Entra ID sign-in: on iff ENTRA_CLIENT_ID is set. tenantIds are
// lowercase directory (tenant) ID GUIDs; several need a multitenant app.
export type EntraConfig = {
  clientId: string;
  clientSecret: string;
  tenantIds: string[];
  endpoints?: IdpEndpoints;
};

export type Config = {
  dbPath: string;
  httpPort: number;
  google?: GoogleConfig;
  entra?: EntraConfig;
  publicUrl: string;
  messageRetentionDays: number;
  auditRetentionDays: number;
  devAuth: boolean;
  // Emails allowed to run admin commands. Empty means nobody can.
  admins: string[];
  // Who can reach another user's human; default "team".
  humanReach?: HumanReach;
  // The org Slack bridge (src/server/slack.ts); off unless both tokens are set.
  slack?: { appToken: string; botToken: string; apiUrl?: string };
};

export function loadConfig(): Config {
  const devAuth = process.env.GRAYBOARD_DEV_AUTH === "1";

  for (const secret of ["GOOGLE_OAUTH_CLIENT_SECRET", "ENTRA_CLIENT_SECRET"]) {
    if (devAuth && process.env[secret]) {
      throw new Error(`GRAYBOARD_DEV_AUTH=1 must not be set alongside ${secret} (prevents prod misconfig)`);
    }
  }

  const dbPath    = requireEnv("GRAYBOARD_DB_PATH");
  const publicUrl = requireEnv("GRAYBOARD_PUBLIC_URL");

  const google = googleConfig();
  const entra  = entraConfig();
  if (!devAuth && !google && !entra) {
    throw new Error("no sign-in provider: set GOOGLE_OAUTH_CLIENT_ID (Google), ENTRA_CLIENT_ID (Microsoft Entra ID), or both");
  }

  return {
    dbPath,
    httpPort: parseInt(process.env.GRAYBOARD_HTTP_PORT ?? "8080", 10),
    ...(google ? { google } : {}),
    ...(entra ? { entra } : {}),
    publicUrl: publicUrl.replace(/\/$/, ""),
    messageRetentionDays: parseInt(process.env.GRAYBOARD_MESSAGE_RETENTION_DAYS ?? "90", 10),
    auditRetentionDays:   parseInt(process.env.GRAYBOARD_AUDIT_RETENTION_DAYS   ?? "90", 10),
    devAuth,
    admins: parseList(process.env.GRAYBOARD_ADMINS),
    humanReach: parseReach(process.env.GRAYBOARD_SLACK_REACH),
    ...slackConfig(),
  };
}

function parseReach(raw: string | undefined): HumanReach {
  if (raw === undefined || raw === "" || raw === "team") return "team";
  if (raw === "all") return "all";
  throw new Error(`GRAYBOARD_SLACK_REACH must be "team" or "all", not "${raw}"`);
}

// Half a configuration is a mistake, not "off": here and for Slack below.
function googleConfig(): GoogleConfig | undefined {
  const clientId      = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret  = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const orgDomain     = process.env.GRAYBOARD_ORG_DOMAIN?.trim().toLowerCase() || undefined;
  const allowedEmails = parseList(process.env.GRAYBOARD_ALLOWED_EMAILS);
  if (!clientId) {
    if (clientSecret) throw new Error("GOOGLE_OAUTH_CLIENT_SECRET is set without GOOGLE_OAUTH_CLIENT_ID");
    if (orgDomain || allowedEmails.length) {
      throw new Error("GRAYBOARD_ORG_DOMAIN and GRAYBOARD_ALLOWED_EMAILS are for Google sign-in; set GOOGLE_OAUTH_CLIENT_ID too, or unset them");
    }
    return undefined;
  }
  if (!clientSecret) throw new Error("GOOGLE_OAUTH_CLIENT_ID is set without GOOGLE_OAUTH_CLIENT_SECRET");
  if (!orgDomain && !allowedEmails.length) {
    throw new Error("Google sign-in needs GRAYBOARD_ORG_DOMAIN, GRAYBOARD_ALLOWED_EMAILS, or both, to say who may sign in");
  }
  return { clientId, clientSecret, ...(orgDomain ? { orgDomain } : {}), allowedEmails };
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function entraConfig(): EntraConfig | undefined {
  const clientId     = process.env.ENTRA_CLIENT_ID;
  const clientSecret = process.env.ENTRA_CLIENT_SECRET;
  const tenantIds    = parseList(process.env.ENTRA_TENANT_IDS);
  if (!clientId) {
    if (clientSecret || tenantIds.length) throw new Error("ENTRA_CLIENT_SECRET or ENTRA_TENANT_IDS is set without ENTRA_CLIENT_ID");
    return undefined;
  }
  if (!clientSecret) throw new Error("ENTRA_CLIENT_ID is set without ENTRA_CLIENT_SECRET");
  if (!tenantIds.length) throw new Error("ENTRA_CLIENT_ID is set without ENTRA_TENANT_IDS (the directory (tenant) IDs allowed to sign in)");
  for (const t of tenantIds) {
    if (!GUID.test(t)) throw new Error(`ENTRA_TENANT_IDS entries are directory (tenant) ID GUIDs, not "${t}"`);
  }
  return { clientId, clientSecret, tenantIds };
}

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
