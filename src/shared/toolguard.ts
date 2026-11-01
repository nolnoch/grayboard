import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { type ClaudeFiles, claudeChannels, hostFiles } from "./claude_channels.ts";

type Tool = { name: string; inputSchema: { properties: Record<string, unknown>; required?: string[] } };

/** "dm_send(to, body, parent_id?)" from a tool's schema. */
function signature(t: Tool): string {
  const req = new Set(t.inputSchema.required ?? []);
  const params = Object.keys(t.inputSchema.properties).map((k) => (req.has(k) ? k : `${k}?`));
  return `${t.name}(${params.join(", ")})`;
}

/**
 * An error naming the expected arguments if `args` is missing a required one
 * or has one the tool doesn't take, else null. Catches a guessed or renamed
 * argument (recipient → to) with a message the agent can act on.
 */
export function checkArgs(tools: Tool[], name: string, args: Record<string, unknown>): string | null {
  const t = tools.find((x) => x.name === name);
  if (!t) return null;
  const missing = (t.inputSchema.required ?? []).filter((k) => args[k] === undefined);
  const unknown = Object.keys(args).filter((k) => !(k in t.inputSchema.properties));
  if (!missing.length && !unknown.length) return null;
  const parts = [missing.length && `missing ${missing.join(", ")}`, unknown.length && `unknown ${unknown.join(", ")}`];
  return `${signature(t)}: ${parts.filter(Boolean).join("; ")}.`;
}

/**
 * For an installed binary: a function that returns a notice once the binary on
 * disk has been replaced since this process started (a reinstall), else null.
 * Checked on each tool call; there's no watcher. From source, always null.
 */
export function updateNotice(): () => string | null {
  if (/^bun(\.exe)?$/.test(basename(process.execPath))) return () => null;
  const id = (): string | null => {
    try {
      const s = statSync(process.execPath);
      return `${s.ino}:${s.mtimeMs}`;
    } catch {
      return null;
    }
  };
  const start = id();
  return () => {
    const now = id();
    return start && now && now !== start
      ? "Note: grayboard was updated after this session started, so these tools may be out of date. Ask the user to reconnect it (/mcp → grayboard → reconnect)."
      : null;
  };
}

/** The warning a tools-only Claude Code session gets, naming why its channels are off. */
export function channelsOffNotice(reason: string): string {
  return `Warning: this Claude Code session is tools-only: grayboard can't push messages or board posts to it, because ${reason}, and peers see it as offline. Tell the user; what's pending arrives once a session with channels on holds this name. Until then, check dm_inbox and board_read yourself.`;
}

/**
 * Why Claude Code won't show this local-mode server's channel notifications
 * (the shared rule, `claudeChannels`), or null when it will or can't tell.
 * Only a child of Claude Code itself is checked: CLAUDECODE=1 is inherited by
 * anything Claude Code launches, so the parent must also be `claude`. Unknown
 * (no parent command line, or an unreadable policy) counts as on.
 */
export function channelsOff(env: Record<string, string | undefined>, parentCmd: string | null, files: ClaudeFiles = hostFiles()): string | null {
  if (env.CLAUDECODE !== "1" || !parentCmd) return null;
  const argv0 = parentCmd.trim().split(/\s+/)[0] ?? "";
  if (basename(argv0) !== "claude") return null;
  const v = claudeChannels({ env, parentCmd, entry: "server:grayboard", files });
  return v.state === "off" ? v.reason : null;
}

/** The parent process's command line, space-joined, or null if unreadable. */
export function parentCommandLine(): string | null {
  try {
    if (process.platform === "linux") {
      return readFileSync(`/proc/${process.ppid}/cmdline`, "utf8").split("\0").join(" ").trim() || null;
    }
    const r = Bun.spawnSync(["ps", "-o", "args=", "-p", String(process.ppid)]);
    return r.exitCode === 0 ? r.stdout.toString().trim() || null : null;
  } catch {
    return null;
  }
}
