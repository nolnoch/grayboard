import { readdirSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

/**
 * Whether Claude Code will show this MCP server's channel notifications, so a
 * session should take pushes (hold the delivery lease) only when they reach
 * the model. One rule serves local mode (`server:grayboard`) and the hosted
 * plugin (`plugin:grayboard@grayboard`).
 *
 * Mirrors Claude Code 2.1.316's channel gate and its per-notification check,
 * read from the binary on 2026-10-31, plus the managed-settings rules in
 * code.claude.com/docs/en/managed-settings. Bumping the E2E's Claude Code pin
 * includes re-checking this rule against the new binary.
 */

export type ChannelEntry = "server:grayboard" | "plugin:grayboard@grayboard";

/** The hosted plugin's id in Claude Code: `<plugin>@<marketplace>`. */
export const CLAUDE_PLUGIN = "grayboard@grayboard";

/** The check that turned channels off, in evaluation order. */
export type ChannelCheck = "provider" | "interactive" | "feature" | "org" | "policy" | "session" | "allowlist";

export type ChannelsVerdict =
  | { state: "on" }
  | { state: "off"; check: ChannelCheck; reason: string }
  | { state: "unknown"; reason: string };

/** What the rule reads from the host, injected so tests run against fixture dirs. */
export interface ClaudeFiles {
  platform: NodeJS.Platform;
  home: string;
  user: string;
  /** A file's text, or null when it's missing or unreadable. */
  read(path: string): string | null;
  /** A directory's entry names, or [] when it's missing or unreadable. */
  list(dir: string): string[];
  /** A plist converted to JSON text, or null when it's missing or unconvertible. */
  plist(path: string): string | null;
}

export function hostFiles(): ClaudeFiles {
  return {
    platform: process.platform,
    home: homedir(),
    user: userInfo().username,
    read: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    list: (d) => {
      try {
        return readdirSync(d);
      } catch {
        return [];
      }
    },
    plist: (p) => {
      try {
        const r = Bun.spawnSync(["plutil", "-convert", "json", "-o", "-", p], { stderr: "ignore" });
        return r.exitCode === 0 ? r.stdout.toString() : null;
      } catch {
        return null;
      }
    },
  };
}

/** Claude Code registers channels only for its first-party provider. */
const THIRD_PARTY = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_MANTLE",
];

const truthy = (v: string | undefined): boolean => /^(1|true|yes|on)$/i.test(v?.trim() ?? "");

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function parse(text: string | null): Json | null {
  if (text === null) return null;
  try {
    const v: unknown = JSON.parse(text);
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

const DEV_FLAG = "--dangerously-load-development-channels";
const CHANNELS_FLAG = "--channels";

/** The values of every occurrence of `flag` (`--flag a b` or `--flag=a b`), up to the next option. */
function flagValues(argv: string[], flag: string): string[] | null {
  let found = false;
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a !== flag && !a.startsWith(`${flag}=`)) continue;
    found = true;
    if (a !== flag) out.push(a.slice(flag.length + 1));
    while (i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) out.push(argv[++i]!);
  }
  return found ? out : null;
}

/** Keys that steer how managed sources combine; a source holding only these delivers no policy. */
const CONTROL_KEYS = new Set(["wslInheritsWindowsSettings", "managedSourcesBehavior"]);
const hasPolicy = (doc: Json): boolean => Object.keys(doc).some((k) => !CONTROL_KEYS.has(k));

/** Merges `later` over `base`: a later single value wins, lists union, objects merge key by key. */
function mergeOver(base: Json, later: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(later)) {
    const b = out[k];
    if (Array.isArray(b) && Array.isArray(v)) out[k] = unionList(b, v);
    else if (isObject(b) && isObject(v)) out[k] = mergeOver(b, v);
    else out[k] = v;
  }
  return out;
}

function unionList(a: unknown[], b: unknown[]): unknown[] {
  const seen = new Set(a.map((x) => JSON.stringify(x)));
  return [...a, ...b.filter((x) => !seen.has(JSON.stringify(x)))];
}

function managedDir(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode";
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode";
  return "/etc/claude-code";
}

type Managed = {
  /** The managed settings in force, or null when no admin source delivers a policy key. */
  settings: Json | null;
  /** False when an unreadable source (the Windows registry) could change `settings`. */
  complete: boolean;
};

/**
 * The managed settings Claude Code applies, from its admin sources highest
 * first: cached remote settings, the macOS MDM plists, then the managed
 * settings file merged with its `managed-settings.d/*.json` drop-ins
 * (alphabetical). The highest source that delivers a policy key wins, unless
 * the highest source deployed sets `managedSourcesBehavior: "merge"`; then
 * every source applies, a higher one's single value winning and lists
 * unioning. The Windows registry (HKLM above the files, HKCU below them) isn't
 * read, so on Windows only a remote-settings winner is complete.
 */
function managedSettings(files: ClaudeFiles, configDir: string): Managed {
  const sources: Json[] = [];
  const remote = parse(files.read(join(configDir, "remote-settings.json")));
  if (remote) sources.push(remote);
  if (files.platform === "darwin") {
    for (const p of [
      `/Library/Managed Preferences/${files.user}/com.anthropic.claudecode.plist`,
      "/Library/Managed Preferences/com.anthropic.claudecode.plist",
    ]) {
      const doc = parse(files.plist(p));
      if (doc) {
        sources.push(doc);
        break;
      }
    }
  }
  const dir = managedDir(files.platform);
  const sep = files.platform === "win32" ? "\\" : "/";
  let fileDoc = parse(files.read(`${dir}${sep}managed-settings.json`));
  const dropins = files.list(`${dir}${sep}managed-settings.d`).filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort();
  for (const n of dropins) {
    const doc = parse(files.read(`${dir}${sep}managed-settings.d${sep}${n}`));
    if (doc) fileDoc = mergeOver(fileDoc ?? {}, doc);
  }
  if (fileDoc) sources.push(fileDoc);

  const policies = sources.filter(hasPolicy);
  const merge = sources[0]?.managedSourcesBehavior === "merge";
  const settings = !policies.length ? null : merge ? policies.reduceRight<Json>((acc, doc) => mergeOver(acc, doc), {}) : policies[0]!;
  const complete = files.platform !== "win32" || (!merge && policies[0] === remote && remote !== null);
  return { settings, complete };
}

const LAUNCH: Record<ChannelEntry, string> = {
  "server:grayboard": `claude ${DEV_FLAG} server:grayboard`,
  "plugin:grayboard@grayboard": `claude ${DEV_FLAG} plugin:grayboard@grayboard`,
};

/** The launch command that turns channels on for `entry`. */
export const launchCommand = (entry: ChannelEntry): string => LAUNCH[entry];

/**
 * Whether this is an interactive Claude Code session: the `cli` entrypoint
 * (Claude Code sets `sdk-cli` for -p and a non-TTY stdout, and an inherited
 * host value wins over it) and no -p/--print on its command line.
 */
export function interactiveClaude(env: Record<string, string | undefined>, parentCmd: string | null): boolean {
  const argv = parentCmd?.trim().split(/\s+/) ?? [];
  return env.CLAUDE_CODE_ENTRYPOINT === "cli" && !argv.some((a) => a === "-p" || a === "--print");
}

export type ChannelsInput = {
  env: Record<string, string | undefined>;
  /** Claude Code's command line, space-joined, or null if unreadable. */
  parentCmd: string | null;
  entry: ChannelEntry;
  files: ClaudeFiles;
};

export function claudeChannels({ env, parentCmd, entry, files }: ChannelsInput): ChannelsVerdict {
  const off = (check: ChannelCheck, reason: string): ChannelsVerdict => ({ state: "off", check, reason });

  const provider = THIRD_PARTY.find((k) => truthy(env[k]));
  if (provider) return off("provider", `Claude Code shows channels only on Anthropic's own API, and ${provider} is set`);

  const argv = parentCmd?.trim().split(/\s+/) ?? null;
  if (!interactiveClaude(env, parentCmd)) {
    return off("interactive", "a non-interactive Claude Code session (-p, the SDK or an IDE host) doesn't show channel messages");
  }

  const configDir = env.CLAUDE_CONFIG_DIR || join(files.home, ".claude");
  const global = parse(files.read(join(env.CLAUDE_CONFIG_DIR || files.home, ".claude.json")));
  const features = isObject(global?.cachedGrowthBookFeatures) ? global.cachedGrowthBookFeatures : {};
  if (features.tengu_harbor === false) return off("feature", "channels aren't currently available to this Claude Code account");

  const limits = parse(files.read(join(configDir, "policy-limits.json")));
  const restriction = isObject(limits?.restrictions) ? limits.restrictions.allow_channels : undefined;
  const taints = Array.isArray(limits?.compliance_taints) ? limits.compliance_taints : [];
  if ((isObject(restriction) && restriction.allowed === false) || taints.includes("hipaa")) {
    return off("org", "this account's organization doesn't allow channels");
  }

  const managed = managedSettings(files, configDir);
  let unknown: string | null = null;
  const account = isObject(global?.oauthAccount) ? global.oauthAccount : null;
  const claudeAi = account !== null && !env.ANTHROPIC_API_KEY;
  const policyApplies = claudeAi
    ? account.organizationType === "claude_team" || account.organizationType === "claude_enterprise"
    : managed.settings !== null || !managed.complete;
  if (policyApplies && (!managed.complete || managed.settings?.channelsEnabled !== true)) {
    if (!managed.complete) unknown = "a Windows registry policy, which grayboard can't read, decides whether channels are enabled";
    else return off("policy", "managed settings don't enable channels (an admin sets channelsEnabled: true)");
  }

  if (!argv) return { state: "unknown", reason: "Claude Code's command line can't be read" };
  const dev = flagValues(argv, DEV_FLAG) ?? [];
  if (!dev.includes(entry)) {
    const listed = flagValues(argv, CHANNELS_FLAG) ?? [];
    if (!listed.includes(entry)) return off("session", `the session wasn't started with \`${launchCommand(entry)}\` (restart it that way; --resume keeps the conversation)`);
    if (entry.startsWith("server:")) return off("session", `--channels doesn't load a server entry; start the session with ${launchCommand(entry)}`);
    const [plugin, marketplace] = entry.slice("plugin:".length).split("@");
    const org = managed.settings?.allowedChannelPlugins;
    const allow = Array.isArray(org) ? org : Array.isArray(features.tengu_harbor_ledger) ? features.tengu_harbor_ledger : [];
    if (!allow.some((a) => isObject(a) && a.plugin === plugin && a.marketplace === marketplace)) {
      if (!Array.isArray(org) && !managed.complete) unknown ??= "a Windows registry policy, which grayboard can't read, may list the plugin in allowedChannelPlugins";
      else return off("allowlist", `--channels loads only allowlisted plugins; an admin adds {"marketplace": "${marketplace}", "plugin": "${plugin}"} to allowedChannelPlugins, or start the session with ${launchCommand(entry)}`);
    }
  }
  return unknown ? { state: "unknown", reason: unknown } : { state: "on" };
}
