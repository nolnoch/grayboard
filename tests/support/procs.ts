import { CLI } from "./paths.ts";
import { until } from "./until.ts";

// The line tests/support/stops_reading.ts stops reading after (its
// $BUS_TEST_STOP_READING_ON), for the omp and pi scenarios that use it.
export const STOP_READING = "stop-reading-580";

// The grayboard processes whose parent is `pid` (this checkout's CLI, or
// `bin`): an adapter's session runs exactly one, as its own child (#182
// decision 13).
export function grayboardChildren(pid: number, bin?: string): string[] {
  const r = Bun.spawnSync(["ps", "-A", "-o", "ppid=,command="]);
  const marker = bin ?? CLI;
  return r.stdout.toString().split("\n")
    .map((l) => l.trim().match(/^(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => !!m && Number(m[1]) === pid && m[2]!.includes(marker))
    .map((m) => m[2]!);
}

// The pids of the grayboard processes whose parent is `pid` (this checkout's CLI).
export function grayboardChildPids(pid: number): number[] {
  const r = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,command="]);
  return r.stdout.toString().split("\n")
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => !!m && Number(m[2]) === pid && m[3]!.includes(CLI))
    .map((m) => Number(m[1]));
}

// The grayboard children an adapter started itself: they share the harness's
// process group. pi's own MCP client starts each server as a group leader
// (pi-mcp's stdio transport spawns detached), so an enabled grayboard entry's
// process isn't counted here.
export function adapterChildren(pid: number, bin?: string): string[] {
  const pgid = (p: number) => Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(p)]).stdout.toString().trim();
  const group = pgid(pid);
  const r = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,pgid=,command="]);
  const marker = bin ?? CLI;
  return r.stdout.toString().split("\n")
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => !!m && Number(m[2]) === pid && m[3] === group && m[4]!.includes(marker))
    .map((m) => m[4]!);
}

export type ProcessDescendant = { pid: number; ppid: number; command: string };

// Includes a failed stdio child's exec'd sleeper, which has no CLI marker.
export function processDescendants(pid: number): ProcessDescendant[] {
  const r = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,command="]);
  const rows = r.stdout.toString().split("\n")
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! }));
  const found: ProcessDescendant[] = [];
  for (let queue = [pid]; queue.length;) {
    const parent = queue.shift()!;
    for (const row of rows.filter((x) => x.ppid === parent)) {
      queue.push(row.pid);
      found.push(row);
    }
  }
  return found;
}

// Every grayboard descendant: this checkout's CLI, or a grayboard binary.
// A server-mode hosted extension runs none.
export function grayboardDescendants(pid: number): string[] {
  return processDescendants(pid)
    .filter((p) => p.command.includes(CLI) || /(^|\/)grayboard(\s|$)/.test(p.command))
    .map((p) => p.command);
}

// SIGKILL `pid` and wait until it's gone: the signal is asynchronous, and a
// test that starts the next process at once races the dying one.
export async function sigkill(pid: number): Promise<void> {
  process.kill(pid, "SIGKILL");
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
}
