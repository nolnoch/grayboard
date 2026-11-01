import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isExplicitIdentity } from "../shared/identity.ts";
import { normalizeIdentityName } from "../shared/addressing.ts";

// Claude Code's SessionStart hook: title the session with its grayboard
// handle, so the name Claude Code shows (and its ListAgents lists) is the one
// dm_send takes. Only an explicit BUS_IDENTITY binds at start (#182); any
// other session starts unbound, so there's no name to title it with yet.
// Any failure prints nothing: a hook must never block a session.
export function sessionStartOutput(stdin: string, env = process.env): string {
  try {
    const input = JSON.parse(stdin) as { cwd?: unknown };
    const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
    if (!isExplicitIdentity(env, cwd)) return "";
    const id = normalizeIdentityName(env.BUS_IDENTITY!);
    // An invalid explicit identity refuses `grayboard mcp` at startup; the
    // hook prints nothing rather than block the session (#181).
    if (!id.ok) return "";
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", sessionTitle: id.name } });
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
// other hook and setting as it was. Not on clear/compact: the title is
// already set, and a session that moved into a worktree would be retitled
// with a handle its running server doesn't hold.
export function installSessionStartHook(command: string, path = claudeSettingsPath()): void {
  const { cfg, kept } = withoutOurs(path);
  cfg.hooks = { ...cfg.hooks, SessionStart: [...kept, { matcher: "startup|resume|fork", hooks: [{ type: "command", command, timeout: 10 }] }] };
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
}

// Remove the hook, leaving every other hook and setting as it was; true when
// the file changed. Server mode's plugin binds no name at start, and the hook
// would run the grayboard binary in a session that otherwise needs none.
export function removeSessionStartHook(path = claudeSettingsPath()): boolean {
  const { cfg, kept, found } = withoutOurs(path);
  if (!found) return false;
  const { SessionStart: _, ...rest } = cfg.hooks!;
  cfg.hooks = kept.length ? { ...rest, SessionStart: kept } : rest;
  if (!Object.keys(cfg.hooks).length) delete cfg.hooks;
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
  return true;
}

function withoutOurs(path: string): { cfg: Settings; kept: HookEntry[]; found: boolean } {
  let cfg: Settings = {};
  if (existsSync(path)) {
    try { cfg = JSON.parse(readFileSync(path, "utf8")); } catch (e) {
      throw new Error(`can't parse ${path}: ${(e as Error).message}`);
    }
  }
  const all = cfg.hooks?.SessionStart ?? [];
  const found = all.some((m) => m.hooks.some((h) => OURS.test(h.command)));
  const kept = all
    .map((m) => ({ ...m, hooks: m.hooks.filter((h) => !OURS.test(h.command)) }))
    .filter((m) => m.hooks.length > 0);
  return { cfg, kept, found };
}
