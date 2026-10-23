import { mkdirSync } from "node:fs";
import { join } from "node:path";

// Variables a developer's shell (or a grayboard-launched session) may carry
// that would point a test's child at real state or a real identity.
const INHERITED = [
  "BUS_IDENTITY", "BUS_HUMAN", "BUS_PUSH", "BUS_ATTACH_ROOTS", "BUS_DB_PATH", "BUS_SOCK_DIR",
  "GRAYBOARD_TOKEN", "GRAYBOARD_SERVER", "GRAYBOARD_CREDENTIALS", "GRAYBOARD_ATTACHMENTS_DIR",
  "GRAYBOARD_SLACK_CONFIG", "GRAYBOARD_SLACK_DB", "SLACK_APP_TOKEN", "SLACK_BOT_TOKEN", "SLACK_API_URL",
];

// This process's env without those, plus `extra`.
export function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  for (const k of INHERITED) delete env[k];
  return { ...env, ...extra };
}

// A local-mode child whose state all lives in `dir`, HOME included. HOME is a
// subdirectory, so a session whose cwd is `dir` isn't in its home directory
// (which would bar attaching from it). No credentials file exists there, so
// `grayboard mcp` picks local mode.
export function localEnv(dir: string, identity?: string, extra: Record<string, string> = {}): Record<string, string> {
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  return {
    ...cleanEnv(),
    HOME: home,
    BUS_DB_PATH: join(dir, "bus.db"),
    BUS_SOCK_DIR: dir,
    GRAYBOARD_CREDENTIALS: join(dir, "credentials"),
    GRAYBOARD_ATTACHMENTS_DIR: join(dir, "saved"),
    ...(identity ? { BUS_IDENTITY: identity } : {}),
    ...extra,
  };
}

// A server-mode child signed in with `token`. Test files live under the temp
// directory, declared as a scratch root for attachments.
export function serverEnv(
  base: string, token: string, identity: string, attachRoot: string, extra: Record<string, string> = {},
): Record<string, string> {
  return {
    ...cleanEnv(),
    GRAYBOARD_TOKEN: token,
    GRAYBOARD_SERVER: base,
    BUS_IDENTITY: identity,
    BUS_ATTACH_ROOTS: attachRoot,
    ...extra,
  };
}
