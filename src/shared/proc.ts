// Process facts that bindings rows and name records key liveness on (#182):
// a pid is alive only if it exists and started when the row says it did, so a
// reused pid never keeps a dead session's name. Linux reads /proc; macOS asks ps.
import { readFileSync } from "node:fs";

/** /proc/<pid>/stat fields, after the parenthesized command (which may hold spaces). */
function statFields(pid: number): string[] | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  } catch {
    return null;
  }
}

/** One ps call for many pids: `pid` → the rest of its line. Null when ps itself failed. */
function ps(column: string, pids: number[]): Map<number, string> | null {
  const out = new Map<number, string>();
  if (pids.length === 0) return out;
  try {
    // LC_ALL=C: lstart's text is locale-dependent, and it's compared as a string.
    const r = Bun.spawnSync(["ps", "-o", `pid=,${column}=`, "-p", pids.join(",")], { env: { ...process.env, LC_ALL: "C" } });
    // Exit 1 only says some pid wasn't found; anything else is ps failing.
    if (r.exitCode !== 0 && r.exitCode !== 1) {
      warnOnce(`ps:${r.exitCode}`, `ps exited ${r.exitCode ?? r.signalCode}: ${r.stderr.toString().trim()}`);
      return null;
    }
    for (const line of r.stdout.toString().split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (m) out.set(Number(m[1]), m[2]!.trim());
    }
  } catch (e) {
    warnOnce("ps:spawn", `ps failed to run: ${(e as Error).message}`);
    return null;
  }
  return out;
}

const warned = new Set<string>();
function warnOnce(key: string, text: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.error(`[grayboard] ${text}`);
}

/**
 * Each pid's start time, as an opaque string: absent when the pid doesn't
 * exist or is a zombie (exited, not yet reaped by its parent: #331), null
 * when it does but its start time can't be read (an unknown, never evidence
 * that it's gone). Linux: field 22 (starttime, clock ticks since boot), after
 * the state in field 3. macOS: `ps -o stat=,lstart=`, one fork for the whole list.
 */
export function procStarts(pids: number[]): Map<number, string | null> {
  const out = new Map<number, string | null>();
  if (process.platform !== "linux") {
    const lines = ps("stat=,lstart", pids);
    for (const pid of pids) {
      const m = lines?.get(pid)?.match(/^(\S+)\s+(.*)$/);
      if (m && exited(m[1]!)) continue;
      if (m) out.set(pid, m[2]!);
      else if (pidExists(pid)) out.set(pid, null);
    }
    return out;
  }
  for (const pid of pids) {
    // Fields after the command start at field 3: the state is index 0 and
    // field 22 is index 19.
    const fields = statFields(pid);
    if (fields && exited(fields[0]!)) continue;
    const start = fields?.[19];
    if (start) out.set(pid, start);
    else if (pidExists(pid)) out.set(pid, null);
  }
  return out;
}

// A process state that means it has exited: a zombie (Z) or, on Linux, one
// being torn down (X). kill(pid, 0) still succeeds on both.
function exited(state: string): boolean {
  return state.startsWith("Z") || state.startsWith("X");
}

/** `pid`'s start time; undefined when it doesn't exist, null when it does but can't be read. */
export function procStart(pid: number): string | null | undefined {
  const starts = procStarts([pid]);
  return starts.has(pid) ? starts.get(pid)! : undefined;
}

/** Whether `pid` exists. EPERM means it does, under another user. */
export function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether a process recorded as `pid` started at `recorded` is still that
 * process, given `current`, its start time read now. Dead only on evidence:
 * the pid is gone, or both start times are known and differ. An unknown on
 * either side counts as alive, logged once per pid: a reused pid may then hold
 * a dead session's name, which is safer than reaping a live one.
 */
function judge(pid: number, recorded: string | null, current: string | null | undefined): boolean {
  if (current === undefined) return false;
  if (recorded !== null && current !== null) return current === recorded;
  warnOnce(
    `unknown:${pid}`,
    recorded === null
      ? `pid ${pid}'s row has no start time; treating it as alive while the pid exists`
      : `can't read pid ${pid}'s start time; treating it as alive`,
  );
  return true;
}

/** Whether `pid` is still the process that started at `start`. */
export function isAlive(pid: number, start: string | null): boolean {
  if (!pidExists(pid)) return false;
  return judge(pid, start, procStart(pid));
}

/** Which of `rows` are still their process, with one start-time read for all of them. */
export function aliveRows<T extends { pid: number; proc_start: string | null }>(rows: T[]): { alive: T[]; dead: T[] } {
  const present = rows.filter((r) => pidExists(r.pid));
  const starts = procStarts(present.map((r) => r.pid));
  const alive = present.filter((r) => judge(r.pid, r.proc_start, starts.has(r.pid) ? starts.get(r.pid)! : undefined));
  return { alive, dead: rows.filter((r) => !alive.includes(r)) };
}

function parentOf(pid: number): number | null {
  if (process.platform === "linux") {
    const ppid = Number(statFields(pid)?.[1]);
    return ppid > 0 ? ppid : null;
  }
  const ppid = Number(ps("ppid", [pid])?.get(pid));
  return ppid > 0 ? ppid : null;
}

/** This process's ancestors, nearest first, up to (not including) pid 1. */
export function ancestors(pid = process.pid): number[] {
  const out: number[] = [];
  for (let p = parentOf(pid); p !== null && p > 1 && out.length < 64; p = parentOf(p)) out.push(p);
  return out;
}

/** The short command name of `pid` ("claude", "pi", "node"), or null. */
export function commandName(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      return readFileSync(`/proc/${pid}/comm`, "utf8").trim() || null;
    } catch {
      return null;
    }
  }
  const comm = ps("comm", [pid])?.get(pid);
  return comm ? comm.split("/").pop() || null : null;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish", "env"]);
const WRAPPERS = /(?:^|[\s/])(npx|bunx|pnpx|uvx|npm|pnpm|yarn)(?=\s|$)/;

/**
 * The wrapper `pid` is (a shell, or a package runner such as npx or bunx),
 * or null if it looks like the harness itself. A package runner's command
 * name is often just "node", so its command line decides.
 */
export function wrapperName(pid: number): string | null {
  const comm = commandName(pid);
  if (comm && SHELLS.has(comm)) return comm;
  return WRAPPERS.exec(commandLine(pid))?.[1] ?? null;
}

/** `pid`'s command line, space-joined, or "" when unreadable. */
function commandLine(pid: number): string {
  return argv(pid).join(" ").trim();
}

/**
 * `pid`'s argv. Linux splits /proc/<pid>/cmdline on NUL, so an argument
 * holding spaces stays whole. Elsewhere ps gives one space-joined line, which
 * can't be split back: it comes back as a single element.
 */
function argv(pid: number): string[] {
  if (process.platform !== "linux") {
    const line = ps("args", [pid])?.get(pid);
    return line ? [line] : [];
  }
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0$/, "");
    return raw ? raw.split("\0") : [];
  } catch {
    return [];
  }
}

/**
 * The harness this process runs under: its first ancestor that isn't a
 * wrapper (wrapperName), or null when every ancestor is one. Its parent
 * alone may be a shell or package runner that exits with it.
 */
export function harnessAncestor(pid = process.pid): number | null {
  return ancestors(pid).find((p) => wrapperName(p) === null) ?? null;
}

/**
 * Whether this process's harness (harnessAncestor) is Claude Code
 * (isClaudeCode). Null when that can't be read (no ancestors readable, as
 * where neither /proc nor ps exists, or every ancestor a wrapper): an unknown,
 * never evidence that it isn't. CLAUDECODE and CLAUDE_CODE_SESSION_ID are
 * inherited by anything Claude Code launches, harnesses included (#1403), so
 * only this tells a child of Claude Code from a grandchild.
 */
export function claudeIsHarness(pid = process.pid): boolean | null {
  const h = harnessAncestor(pid);
  if (h === null) return null;
  const comm = commandName(h);
  const args = argv(h);
  if (comm === null && !args.length) return null;
  // macOS: argv is ps's joined line, so its argv[0] is cut at the first space
  // (an install under "Application Support" loses it); comm there is the
  // executable's full path, whose basename (commandName) carries the match.
  const argv0 = process.platform === "linux" ? (args[0] ?? "") : (args[0]?.split(/\s+/)[0] ?? "");
  return isClaudeCode(comm, argv0, args.join(" "));
}

/**
 * Whether a process with command name `comm`, argv[0] `argv0` and
 * space-joined command line `args` is Claude Code: its comm is `claude`
 * (Claude Code sets process.title, which also gives "claude daemon"), its
 * argv[0]'s basename is `claude` or `claude.exe` (the npm package's
 * `bin/claude.exe` native binary), or it is an older npm install's `cli.js`
 * under node (current releases ship no cli.js; kept for installs that predate
 * the native binary).
 */
export function isClaudeCode(comm: string | null, argv0: string, args: string): boolean {
  if (comm !== null && /^claude(\.exe)?( |$)/.test(comm)) return true;
  if (/^claude(\.exe)?$/.test(argv0.split(/[\\/]/).pop() ?? "")) return true;
  return /[\\/]@anthropic-ai[\\/]claude-code[\\/]cli\.js(?:\s|$)/.test(args);
}
