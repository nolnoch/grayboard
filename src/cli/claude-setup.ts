// Claude Code's step of `grayboard setup` and `refresh-adapters` (#281).
// Local mode: the user-scope `grayboard mcp` entry and the SessionStart hook,
// as before; an installed hosted plugin is disabled (its grant is kept for a
// switch back). Server mode: the hosted plugin from this repo's marketplace,
// with no grayboard process at runtime, so the entry (which would run a
// second server in the same session) and the hook go.
//
// Measured against Claude Code 2.1.316 in a scratch CLAUDE_CONFIG_DIR:
// `plugin marketplace add` of an added marketplace exits 0 with "already on
// disk" and no fetch; `plugin install` of an installed plugin exits 0, rewrites
// its userConfig and re-enables a disabled one; `plugin disable` of a
// disabled or absent plugin exits 1; `mcp remove` of an absent entry exits 1.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CLAUDE_PLUGIN, launchCommand } from "../shared/claude_channels.ts";
import { canonicalEndpoint } from "../shared/endpoint.ts";
import { claudeSettingsPath, installSessionStartHook, removeSessionStartHook } from "./session_start.ts";
import { REPO } from "./update.ts";

const MARKETPLACE = CLAUDE_PLUGIN.split("@")[1]!;
const BUN_HINT = "the grayboard Claude Code plugin runs on Bun; install it (https://bun.sh: curl -fsSL https://bun.sh/install | bash), then run `grayboard setup` again";

type Spawned = { exitCode: number; out: string };
export type ClaudeCli = (args: string[], show?: boolean) => Spawned;

/** How long one `claude` command may run: a marketplace fetch is a git fetch, which a stalled network would hang. */
export const CLAUDE_TIMEOUT_MS = 120_000;

/** Run `claude` with `args`: shown on this process's stdout/stderr, or captured. A command past `timeoutMs` is killed and fails, saying so. */
export function claudeCli(claude: string, timeoutMs = CLAUDE_TIMEOUT_MS): ClaudeCli {
  return (args, show = false) => {
    const r = Bun.spawnSync([claude, ...args], { stdin: "ignore", stdout: show ? "inherit" : "pipe", stderr: show ? "inherit" : "pipe", timeout: timeoutMs });
    const out = show ? "" : `${r.stdout?.toString() ?? ""}${r.stderr?.toString() ?? ""}`.trim();
    if (r.exitedDueToTimeout) return { exitCode: 1, out: [`timed out after ${timeoutMs / 1000}s`, out].filter(Boolean).join(": ") };
    return { exitCode: r.exitCode ?? 1, out };
  };
}

const quote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a));
const shown = (args: string[]) => `claude ${args.map(quote).join(" ")}`;

/** The hosted MCP URL the plugin's `server_url` takes, or a throw naming the rule (never the URL: it may hold credentials). */
export function pluginServerUrl(server: string): string {
  let url: string | undefined;
  try { url = canonicalEndpoint(new URL(server.replace(/\/+$/, "") + "/mcp").href)?.href; } catch {}
  if (!url) throw new Error("the Claude Code plugin needs a canonical HTTPS (or loopback HTTP) server URL, without credentials, query or fragment, so nothing was changed for Claude Code");
  return url;
}

/** The commands server mode runs, for printing where `claude` isn't installed. */
export function pluginCommands(server: string): string[][] {
  return [
    ["plugin", "marketplace", "add", REPO],
    ["plugin", "marketplace", "update", MARKETPLACE],
    ["plugin", "install", CLAUDE_PLUGIN, "--config", `server_url=${pluginServerUrl(server)}`],
    ["mcp", "remove", "--scope", "user", "grayboard"],
  ];
}

export const printable = (cmds: string[][]) => cmds.map(shown).join("\n  ");

/**
 * Install (or reconfigure and re-enable) the hosted plugin for `server`, then
 * remove the local registration. Returns what changed. Throws before any
 * change when Bun is missing or the URL isn't canonical, and on a failed
 * `claude` command, leaving the local registration in place, so a failed
 * install never leaves Claude Code without grayboard.
 */
export function installClaudePlugin(run: ClaudeCli, server: string, which: (cmd: string) => string | null = Bun.which): string[] {
  if (!which("bun")) throw new Error(BUN_HINT);
  const [add, refresh, install, remove] = pluginCommands(server);
  // `add` doesn't re-fetch an added marketplace, whose cached catalog may
  // predate the release pin; `update` fetches the current one.
  for (const args of [add!, refresh!, install!]) {
    const r = run(args);
    if (r.exitCode !== 0) throw new Error(`\`${shown(args)}\` failed${r.out ? `: ${r.out}` : ""}`);
  }
  const notes = [`Installed the Claude Code plugin ${CLAUDE_PLUGIN} for ${pluginServerUrl(server)}`];
  if (run(remove!).exitCode === 0) notes.push("Removed the user-scope grayboard MCP entry (the plugin serves the tools)");
  if (removeSessionStartHook()) notes.push(`Removed grayboard's SessionStart hook from ${claudeSettingsPath()}`);
  return notes;
}

/**
 * Server mode, plugin installed and enabled: fetch the marketplace's current
 * catalog, update the plugin to it, and compare the installed plugin's
 * version with this grayboard's (`version`). Returns `claude plugin update`'s
 * own report and that comparison; throws on a failed `claude` command or a
 * plugin list without the user-scope plugin. A running session keeps the old
 * plugin until restarted. The catalog's pin moves only when a release's
 * `plugin-pin` PR merges, after the release publishes: a plugin older than
 * this grayboard right after an update means that PR hasn't merged yet, and
 * running the update again later picks the pin up (#511).
 */
export function refreshClaudePlugin(run: ClaudeCli, version: string): string[] {
  if (!pluginEnabled()) return [];
  let report = "";
  for (const args of [["plugin", "marketplace", "update", MARKETPLACE], ["plugin", "update", CLAUDE_PLUGIN]]) {
    const r = run(args);
    if (r.exitCode !== 0) throw new Error(`\`${shown(args)}\` failed${r.out ? `: ${r.out}` : ""}`);
    report = r.out;
  }
  const plugin = installedPlugin(run);
  const notes = [`Claude Code plugin ${CLAUDE_PLUGIN}: ${report || "update reported nothing"}. Restart Claude Code sessions to load a new version.`];
  const order = Bun.semver.order(plugin, version);
  if (order < 0) notes.push(`The plugin is at ${plugin}, older than this grayboard (${version}): the plugin pin for v${version} hasn't merged into the marketplace yet. Run \`grayboard update\` again later.`);
  else if (order > 0) notes.push(`The plugin is at ${plugin}, newer than this grayboard (${version}).`);
  return notes;
}

/** The installed user-scope plugin's version, from `claude plugin list --json`. Throws when the command fails or lists no such plugin. */
function installedPlugin(run: ClaudeCli): string {
  const args = ["plugin", "list", "--json"];
  const r = run(args);
  if (r.exitCode !== 0) throw new Error(`\`${shown(args)}\` failed${r.out ? `: ${r.out}` : ""}`);
  let list: unknown;
  try { list = JSON.parse(r.out); } catch { throw new Error(`\`${shown(args)}\` printed something other than JSON`); }
  const entry = Array.isArray(list) ? list.find((p) => p?.id === CLAUDE_PLUGIN && p?.scope === "user") : undefined;
  if (typeof entry?.version !== "string") throw new Error(`\`${shown(args)}\` lists no user-scope ${CLAUDE_PLUGIN} with a version`);
  return entry.version;
}

/** Whether user settings enable the hosted plugin. Throws when the file can't be parsed. */
export const pluginEnabled = () => userJson<{ enabledPlugins?: Record<string, unknown> }>(claudeSettingsPath())?.enabledPlugins?.[CLAUDE_PLUGIN] === true;

/**
 * Warnings for `.mcp.json` files in `dir` and its ancestors that hold a
 * `grayboard` entry, which beside the hosted plugin runs a second grayboard
 * in a session started there. A file that can't be parsed is named, not
 * thrown: it belongs to some project, and a check that only warns must not
 * fail the run.
 */
export function projectEntryWarnings(dir: string): string[] {
  const warnings: string[] = [];
  for (let d = resolve(dir); ; d = dirname(d)) {
    const path = join(d, ".mcp.json");
    try {
      if (userJson<{ mcpServers?: Record<string, unknown> }>(path)?.mcpServers?.grayboard) warnings.push(`${path} has a grayboard entry, which runs a second grayboard beside the plugin in a session started there; remove it`);
    } catch {
      warnings.push(`${path} isn't valid JSON, so it wasn't checked for a grayboard entry`);
    }
    if (dirname(d) === d) return warnings;
  }
}

/**
 * Local mode: register `command args` at user scope, title sessions with the
 * SessionStart hook, and disable the hosted plugin if it's enabled. Returns
 * what changed; throws on a failed registration.
 */
export function registerClaudeLocal(run: ClaudeCli, command: string, args: string[], hook: string): string[] {
  run(["mcp", "remove", "--scope", "user", "grayboard"]);
  const add = ["mcp", "add", "--scope", "user", "grayboard", "--", command, ...args];
  const r = run(add, true);
  if (r.exitCode !== 0) throw new Error(`\`${shown(add)}\` failed`);
  // Title each session with its handle, so Claude Code's name for it is the
  // one dm_send takes.
  installSessionStartHook(hook);
  const notes = [`Sessions are titled with their grayboard handle (SessionStart hook in ${claudeSettingsPath()}).`];
  // `disable` fails on a plugin that's disabled or absent, so it runs only
  // where user settings enable it.
  if (pluginEnabled()) {
    const disable = ["plugin", "disable", CLAUDE_PLUGIN];
    const d = run(disable);
    if (d.exitCode !== 0) throw new Error(`\`${shown(disable)}\` failed${d.out ? `: ${d.out}` : ""}`);
    notes.push(`Disabled the Claude Code plugin ${CLAUDE_PLUGIN} (its sign-in is kept for a switch back to server mode)`);
  }
  return notes;
}

/** Whether Claude Code's user config holds the local-mode `grayboard` MCP entry. Throws when the file can't be parsed. */
export function hasUserEntry(env = process.env): boolean {
  return !!userJson<{ mcpServers?: Record<string, unknown> }>(join(env.CLAUDE_CONFIG_DIR || homedir(), ".claude.json"))?.mcpServers?.grayboard;
}

/** A Claude Code JSON file, or null when it's missing (or holds JSON null). Throws when it can't be parsed. */
function userJson<T>(path: string): T | null {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return null; }
  try { return JSON.parse(text) as T | null; } catch (e) {
    throw new Error(`Can't parse ${path}: ${(e as Error).message}`);
  }
}

/** The launch command for the mode. */
export const claudeLaunch = (server: boolean) => launchCommand(server ? `plugin:${CLAUDE_PLUGIN}` as const : "server:grayboard");
