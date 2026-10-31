import { CLI } from "./paths.ts";
import { until } from "./until.ts";

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

// Every grayboard process anywhere under `pid` (children, grandchildren, a
// detached process it spawned): this checkout's CLI, or a `grayboard` binary.
// A server-mode hosted extension runs none.
export function grayboardDescendants(pid: number): string[] {
  const r = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,command="]);
  const rows = r.stdout.toString().split("\n")
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! }));
  const found: string[] = [];
  for (let queue = [pid]; queue.length;) {
    const parent = queue.shift()!;
    for (const row of rows.filter((x) => x.ppid === parent)) {
      queue.push(row.pid);
      if (row.command.includes(CLI) || /(^|\/)grayboard(\s|$)/.test(row.command)) found.push(row.command);
    }
  }
  return found;
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
