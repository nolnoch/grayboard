// Claude Code settings that `grayboard mcp` reads (#551, #555): whether the
// record hook is installed, and what disables user hooks. Here rather than in
// src/cli so src/local imports nothing from the CLI; src/cli/claude_hooks.ts
// writes the hooks and re-exports these.
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Settings = { hooks?: Record<string, { matcher?: string; hooks?: { command?: string }[] }[]> };

/** The tools whose calls the PreToolUse hook records: the user-scope `grayboard` entry's. */
export const LOCAL_TOOL_MATCHER = "mcp__grayboard__.*";
// The PreToolUse entry, whose presence is what "installed" means to `grayboard mcp`;
// matched by its tail, wherever the CLI lives (#555).
const RECORD = /\shook claude pre-tool-use$/;

export function claudeSettingsPath(env = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json");
}

/**
 * Whether user settings hold grayboard's PreToolUse record hook, read by
 * `grayboard mcp` once at start (#551). Only user settings: the one layer setup
 * writes. Unreadable settings count as installed, so calls fail visibly with
 * the missing-record error rather than silently act as the root.
 */
export function recordHookInstalled(path = claudeSettingsPath()): boolean {
  let cfg: Settings;
  try { cfg = JSON.parse(readFileSync(path, "utf8")); } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ENOENT";
  }
  return (cfg?.hooks?.PreToolUse ?? []).some((m) => m?.matcher === LOCAL_TOOL_MATCHER && m.hooks?.some((h) => RECORD.test(h?.command ?? "")));
}

/** Claude Code's managed-settings directory (2.1.316: macOS and Linux; others have none here). */
export function managedSettingsDir(platform = process.platform): string | null {
  return platform === "darwin" ? "/Library/Application Support/ClaudeCode" : platform === "linux" ? "/etc/claude-code" : null;
}

/**
 * The first settings file that stops user hooks from running in a session in
 * `cwd` (`disableAllHooks`, or managed `allowManagedHooksOnly`), or null. Read
 * only when a record is missing, to name the cause (#551 §3): managed
 * settings and their drop-ins, then user settings, then the project's local
 * and shared settings.
 */
export function hooksDisabledBy(cwd: string, managed = managedSettingsDir(), user: string | null = claudeSettingsPath()): string | null {
  const files: string[] = [];
  if (managed) {
    files.push(join(managed, "managed-settings.json"));
    try {
      const d = join(managed, "managed-settings.d");
      files.push(...readdirSync(d).filter((f) => f.endsWith(".json")).sort().map((f) => join(d, f)));
    } catch { /* no drop-ins */ }
  }
  if (user) files.push(user);
  files.push(join(cwd, ".claude", "settings.local.json"), join(cwd, ".claude", "settings.json"));
  for (const f of files) {
    let cfg: { disableAllHooks?: unknown; allowManagedHooksOnly?: unknown } | null;
    try { cfg = JSON.parse(readFileSync(f, "utf8")); } catch { continue; }
    if (cfg?.disableAllHooks === true) return `${f} sets disableAllHooks`;
    if (managed && f.startsWith(managed) && cfg?.allowManagedHooksOnly === true) return `${f} sets allowManagedHooksOnly`;
  }
  return null;
}
