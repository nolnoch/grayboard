import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sessionIdentity } from "../shared/identity.ts";

// Claude Code's SessionStart hook: title the session with its grayboard
// handle, so the name Claude Code shows (and its ListAgents lists) is the one
// dm_send takes. Resolved as `grayboard mcp` resolves it, from the hook's cwd.
// Any failure prints nothing: a hook must never block a session.
export function sessionStartOutput(stdin: string, env = process.env): string {
  try {
    const input = JSON.parse(stdin) as { cwd?: unknown };
    const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
    const handle = sessionIdentity(env, cwd);
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", sessionTitle: handle } });
  } catch {
    return "";
  }
}

type HookEntry = { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] };
type Settings = { hooks?: Record<string, HookEntry[]>; [k: string]: unknown };

const OURS = /grayboard.*\ssession-start$/;

export function claudeSettingsPath(env = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json");
}

// Add (or replace) the hook in Claude Code's user settings, leaving every
// other hook and setting as it was.
export function installSessionStartHook(command: string, path = claudeSettingsPath()): void {
  let cfg: Settings = {};
  if (existsSync(path)) {
    try { cfg = JSON.parse(readFileSync(path, "utf8")); } catch (e) {
      throw new Error(`can't parse ${path}: ${(e as Error).message}`);
    }
  }
  const kept = (cfg.hooks?.SessionStart ?? [])
    .map((m) => ({ ...m, hooks: m.hooks.filter((h) => !OURS.test(h.command)) }))
    .filter((m) => m.hooks.length > 0);
  cfg.hooks = { ...cfg.hooks, SessionStart: [...kept, { hooks: [{ type: "command", command, timeout: 10 }] }] };
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
}
