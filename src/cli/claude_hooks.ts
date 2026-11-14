import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isExplicitIdentity } from "../shared/identity.ts";
import { normalizeIdentityName } from "../shared/addressing.ts";
import { localDbPath, readConversationTitle } from "../local/open.ts";
import { freshRecord } from "../shared/namerecord.ts";
import { validSourceId } from "../shared/session_meta.ts";
import { sockDir } from "../shared/sockdir.ts";
import { claudeSettingsPath, LOCAL_TOOL_MATCHER } from "../shared/claude_settings.ts";

// The settings readers `grayboard mcp` uses live in src/shared (#555); re-exported for the CLI and tests.
export { claudeSettingsPath, hooksDisabledBy, LOCAL_TOOL_MATCHER, managedSettingsDir, recordHookInstalled } from "../shared/claude_settings.ts";

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

// Recognize current commands by their `hook claude <event>` tail, wherever the
// CLI lives (a from-source setup's path needn't contain "grayboard", #555), and
// the old title-only command when replacing installed user settings.
const OURS = /\shook claude [a-z-]+$|grayboard.*\ssession-start$/;

/** `s` quoted for a POSIX shell, bare where that's safe: Claude Code runs a hook command through one. */
export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * SessionStart handles rotation and title together; clear runs only its identity barrier.
 * No SubagentStop: locally a child ends with its root (#548), so it would only cost a
 * process start per subagent end (#555 item 12); an install drops one an older release wrote.
 */
export function claudeHooks(argv: string[]): Record<string, HookEntry[]> {
  const cli = argv.map(shellQuote).join(" ");
  const run = (event: string) => [{ type: "command", command: `${cli} hook claude ${event}`, timeout: 10 }];
  return {
    SessionStart: [{ matcher: "startup|resume|clear|fork", hooks: run("session-start") }],
    PreToolUse: [{ matcher: LOCAL_TOOL_MATCHER, hooks: run("pre-tool-use") }],
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
