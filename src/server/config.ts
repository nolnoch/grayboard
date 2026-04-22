export type Config = {
  dbPath: string;
  httpPort: number;
  googleClientId: string;
  googleClientSecret: string;
  orgDomain: string;
  publicUrl: string;
  messageRetentionDays: number;
  auditRetentionDays: number;
  devAuth: boolean;
};

export function loadConfig(): Config {
  const devAuth = process.env.GRAYBOARD_DEV_AUTH === "1";

  if (devAuth && process.env.GOOGLE_CLIENT_SECRET) {
    throw new Error(
      "GRAYBOARD_DEV_AUTH=1 must not be set alongside GOOGLE_CLIENT_SECRET (prevents prod misconfig)",
    );
  }

  const dbPath    = requireEnv("GRAYBOARD_DB_PATH");
  const publicUrl = requireEnv("GRAYBOARD_PUBLIC_URL");

  const googleClientId     = devAuth ? (process.env.GOOGLE_OAUTH_CLIENT_ID ?? "dev") : requireEnv("GOOGLE_OAUTH_CLIENT_ID");
  const googleClientSecret = devAuth ? "" : requireEnv("GOOGLE_OAUTH_CLIENT_SECRET");
  const orgDomain          = devAuth ? (process.env.GRAYBOARD_ORG_DOMAIN ?? "example.com") : requireEnv("GRAYBOARD_ORG_DOMAIN");

  return {
    dbPath,
    httpPort: parseInt(process.env.GRAYBOARD_HTTP_PORT ?? "8080", 10),
    googleClientId,
    googleClientSecret,
    orgDomain,
    publicUrl: publicUrl.replace(/\/$/, ""),
    messageRetentionDays: parseInt(process.env.GRAYBOARD_MESSAGE_RETENTION_DAYS ?? "90", 10),
    auditRetentionDays:   parseInt(process.env.GRAYBOARD_AUDIT_RETENTION_DAYS   ?? "90", 10),
    devAuth,
  };
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Required env var ${name} is not set`);
  return val;
}
