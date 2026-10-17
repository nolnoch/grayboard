// Slack bridge configuration: ~/.grayboard/slack.json, with env overrides for
// the tokens and paths. Everything personal lives here, never in the repo.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { isValidIdentityName } from "../shared/addressing.ts";
import { SLACK_API } from "./web.ts";

export type BridgeConfig = {
  appToken: string;
  botToken: string;
  /** The private channel's ID. */
  channel: string;
  /** The human's Slack member ID; only their messages are relayed. */
  owner: string;
  /** The human's grayboard handle. */
  handle: string;
  /** The bridge's own SQLite file. */
  dbPath: string;
  apiUrl: string;
};

export class ConfigError extends Error {}

export function configPath(env: Record<string, string | undefined> = process.env): string {
  return env.GRAYBOARD_SLACK_CONFIG ?? join(homedir(), ".grayboard", "slack.json");
}

export function loadConfig(env: Record<string, string | undefined> = process.env): BridgeConfig {
  const path = configPath(env);
  let file: Record<string, unknown> = {};
  if (existsSync(path)) {
    // Like ssh with a private key: tokens in a file others can read are refused.
    if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) {
      throw new ConfigError(`${path} is readable by other users; run: chmod 600 ${path}`);
    }
    try {
      file = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw new ConfigError(`${path} isn't valid JSON: ${(e as Error).message}`);
    }
  }
  const get = (key: string, envKey?: string): string => {
    const v = (envKey && env[envKey]) || file[key];
    if (typeof v !== "string" || !v.trim()) {
      throw new ConfigError(
        `missing "${key}" in ${path}${envKey ? ` (or ${envKey})` : ""}; see docs/slack-bridge-spec.md §9`,
      );
    }
    return v.trim();
  };
  const cfg: BridgeConfig = {
    appToken: get("app_token", "SLACK_APP_TOKEN"),
    botToken: get("bot_token", "SLACK_BOT_TOKEN"),
    channel: get("channel"),
    owner: get("owner"),
    handle: get("handle").toLowerCase(),
    dbPath: env.GRAYBOARD_SLACK_DB ?? join(homedir(), ".grayboard", "slack-bridge.db"),
    apiUrl: env.SLACK_API_URL ?? SLACK_API,
  };
  if (!cfg.appToken.startsWith("xapp-")) throw new ConfigError(`app_token should be an app-level token (xapp-…)`);
  if (!cfg.botToken.startsWith("xoxb-")) throw new ConfigError(`bot_token should be a bot token (xoxb-…)`);
  if (!isValidIdentityName(cfg.handle)) throw new ConfigError(`handle "${cfg.handle}" isn't a valid grayboard handle ([a-z0-9_-], 1-32 chars)`);
  return cfg;
}
