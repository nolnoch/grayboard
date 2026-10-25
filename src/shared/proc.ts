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
 * exist, null when it does but its start time can't be read (an unknown, never
 * evidence that it's gone). Linux: field 22 (starttime, clock ticks since
 * boot). macOS: `ps -o lstart=`, one fork for the whole list.
 */
export function procStarts(pids: number[]): Map<number, string | null> {
  const out = new Map<number, string | null>();
  if (process.platform !== "linux") {
    const starts = ps("lstart", pids);
    for (const pid of pids) {
      const start = starts ? starts.get(pid) : null;
      if (start !== undefined) out.set(pid, start);
      else if (pidExists(pid)) out.set(pid, null);
    }
    return out;
  }
  for (const pid of pids) {
    // Fields after the command start at field 3, so field 22 is index 19.
    const start = statFields(pid)?.[19];
    if (start) out.set(pid, start);
    else if (pidExists(pid)) out.set(pid, null);
  }
  return out;
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
const LAUNCHERS = /(?:^|[\s/])(npx|bunx|pnpx|uvx|npm|pnpm|yarn)(?=\s|$)/;

/**
 * The launcher `pid` is (a shell, or a package runner such as npx or bunx),
 * or null if it looks like the harness itself. A package runner's command
 * name is often just "node", so its command line decides.
 */
export function launcherName(pid: number): string | null {
  const comm = commandName(pid);
  if (comm && SHELLS.has(comm)) return comm;
  const args = process.platform === "linux"
    ? (() => {
        try {
          return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
        } catch {
          return "";
        }
      })()
    : (ps("args", [pid])?.get(pid) ?? "");
  return LAUNCHERS.exec(args)?.[1] ?? null;
}
