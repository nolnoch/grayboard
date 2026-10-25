import { CLI } from "./paths.ts";

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
