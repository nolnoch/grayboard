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
