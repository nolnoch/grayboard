import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isExplicitIdentity } from "../shared/identity.ts";
import { normalizeIdentityName } from "../shared/addressing.ts";
import { localDbPath, readConversationTitle } from "../local/open.ts";
import { freshRecord } from "../shared/namerecord.ts";
import { validSourceId } from "../shared/session_meta.ts";
import { sockDir } from "../shared/sockdir.ts";

export type SessionStartOutput = { hookSpecificOutput: { hookEventName: "SessionStart"; sessionTitle: string } };

// Called after the authoritative identity barrier, never as an independent hook.
// Selected snapshots suppress configured fallback; an acquired live primary is
// safe to title. No extra store and no bus/record mutations for a display name.
export function sessionStartOutput(stdin: string, env = process.env): SessionStartOutput | null {
  try {
    const input = JSON.parse(stdin) as { cwd?: unknown; session_id?: unknown };
    const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
    if (!isExplicitIdentity(env, cwd)) return null;
    const id = normalizeIdentityName(env.BUS_IDENTITY!);
    // Invalid configuration already refuses MCP startup; the title hook is silent.
    if (!id.ok) return null;
    const selected = validSourceId(input.session_id) ? readConversationTitle(input.session_id, env) : undefined;
    if (selected === null) return null;
    if (selected === undefined) {
      const pid = Number(env.CLAUDE_PID);
      const carry = Number.isSafeInteger(pid) && pid > 1 ? freshRecord(sockDir(env), pid, localDbPath(env), { prune: false }) : null;
      if (carry?.names.length && carry.names[0] !== id.name) return null;
    }
    return { hookSpecificOutput: { hookEventName: "SessionStart", sessionTitle: selected ?? id.name } };
  } catch {
    return null;
  }
}

type HookEntry = { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] };
type Settings = { hooks?: Record<string, HookEntry[]>; [k: string]: unknown };

// Recognize current commands and the old title-only command when replacing
// installed user settings; only the authoritative record hook is installed.
const OURS = /grayboard.*\s(session-start|hook claude [a-z-]+)$/;
// The PreToolUse entry, whose presence is what "installed" means to `grayboard mcp`.
const RECORD = /grayboard.*\shook claude pre-tool-use$/;
/** The tools whose calls the PreToolUse hook records: the user-scope `grayboard` entry's. */
export const LOCAL_TOOL_MATCHER = "mcp__grayboard__.*";

/** `s` quoted for a POSIX shell, bare where that's safe: Claude Code runs a hook command through one. */
export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export function claudeSettingsPath(env = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json");
}

/** SessionStart handles rotation and title together; clear runs only its identity barrier. */
export function claudeHooks(argv: string[]): Record<string, HookEntry[]> {
  const cli = argv.map(shellQuote).join(" ");
  const run = (event: string) => [{ type: "command", command: `${cli} hook claude ${event}`, timeout: 10 }];
  return {
    SessionStart: [{ matcher: "startup|resume|clear|fork", hooks: run("session-start") }],
    PreToolUse: [{ matcher: LOCAL_TOOL_MATCHER, hooks: run("pre-tool-use") }],
    SubagentStop: [{ hooks: run("subagent-stop") }],
    SessionEnd: [{ hooks: run("session-end") }],
  };
}

/**
 * Add (or replace) grayboard's hooks in Claude Code's user settings, leaving
 * every other hook and setting as it was. True when the file changed.
 */
export function installClaudeHooks(argv: string[], path = claudeSettingsPath()): boolean {
  const { cfg, kept, before } = withoutOurs(path);
  const ours = claudeHooks(argv);
  const hooks = { ...kept };
  for (const [event, entries] of Object.entries(ours)) hooks[event] = [...(hooks[event] ?? []), ...entries];
  cfg.hooks = hooks;
  const text = JSON.stringify(cfg, null, 2) + "\n";
  if (text === before) return false;
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return true;
}

/**
 * Remove grayboard's hooks, leaving every other hook and setting as it was;
 * true when the file changed. Server mode's plugin ships its own hooks, and
 * these would run the grayboard binary in a session that otherwise needs none.
 */
export function removeClaudeHooks(path = claudeSettingsPath()): boolean {
  const { cfg, kept, found } = withoutOurs(path);
  if (!found) return false;
  if (Object.keys(kept).length) cfg.hooks = kept;
  else delete cfg.hooks;
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
  return true;
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

function withoutOurs(path: string): { cfg: Settings; kept: Record<string, HookEntry[]>; found: boolean; before: string | undefined } {
  let cfg: Settings = {};
  let before: string | undefined;
  if (existsSync(path)) {
    before = readFileSync(path, "utf8");
    try { cfg = JSON.parse(before); } catch (e) {
      throw new Error(`can't parse ${path}: ${(e as Error).message}`);
    }
  }
  let found = false;
  const kept: Record<string, HookEntry[]> = {};
  for (const [event, entries] of Object.entries(cfg.hooks ?? {})) {
    if (!Array.isArray(entries)) { kept[event] = entries; continue; }
    const left = entries
      .map((m) => {
        const hooks = (m.hooks ?? []).filter((h) => !OURS.test(h.command));
        if (hooks.length !== (m.hooks ?? []).length) found = true;
        return { ...m, hooks };
      })
      .filter((m) => m.hooks.length > 0);
    // An event that held only ours goes; one the user left empty stays.
    if (left.length || !entries.length) kept[event] = left;
  }
  return { cfg, kept, found, before };
}
