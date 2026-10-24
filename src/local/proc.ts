// Process facts the local bus keys liveness on (#182): a pid is alive only if
// it exists and started when the row says it did, so a reused pid never keeps
// a dead session's name. Linux reads /proc; macOS asks ps.
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

/** One ps call for many pids: `pid` → the rest of its line. */
function ps(column: string, pids: number[]): Map<number, string> {
  const out = new Map<number, string>();
  if (pids.length === 0) return out;
  try {
    // LC_ALL=C: lstart's text is locale-dependent, and it's compared as a string.
    const r = Bun.spawnSync(["ps", "-o", `pid=,${column}=`, "-p", pids.join(",")], { env: { ...process.env, LC_ALL: "C" } });
    for (const line of r.stdout.toString().split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (m) out.set(Number(m[1]), m[2]!.trim());
    }
  } catch {}
  return out;
}

/**
 * Each pid's start time, as an opaque string; pids that don't exist are
 * absent. Linux: field 22 (starttime, clock ticks since boot). macOS:
 * `ps -o lstart=`, one fork for the whole list.
 */
export function procStarts(pids: number[]): Map<number, string> {
  if (process.platform !== "linux") return ps("lstart", pids);
  const out = new Map<number, string>();
  for (const pid of pids) {
    // Fields after the command start at field 3, so field 22 is index 19.
    const start = statFields(pid)?.[19];
    if (start) out.set(pid, start);
  }
  return out;
}

export function procStart(pid: number): string | null {
  return procStarts([pid]).get(pid) ?? null;
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

/** Whether `pid` is still the process that started at `start`. */
export function isAlive(pid: number, start: string | null): boolean {
  if (!pidExists(pid)) return false;
  return start === null || procStart(pid) === start;
}

/** Which of `rows` are still their process, with one start-time read for all of them. */
export function aliveRows<T extends { pid: number; proc_start: string | null }>(rows: T[]): { alive: T[]; dead: T[] } {
  const present = rows.filter((r) => pidExists(r.pid));
  const starts = procStarts(present.map((r) => r.pid));
  const alive = present.filter((r) => r.proc_start === null || starts.get(r.pid) === r.proc_start);
  return { alive, dead: rows.filter((r) => !alive.includes(r)) };
}

function parentOf(pid: number): number | null {
  if (process.platform === "linux") {
    const ppid = Number(statFields(pid)?.[1]);
    return ppid > 0 ? ppid : null;
  }
  const ppid = Number(ps("ppid", [pid]).get(pid));
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
  const comm = ps("comm", [pid]).get(pid);
  return comm ? comm.split("/").pop() || null : null;
}
