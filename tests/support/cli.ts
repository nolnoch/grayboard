// One `grayboard <args>` run, as a lane's shell runs it: env and cwd decide
// the handle. stdin is closed unless `holdStdin`, so `grayboard mcp` sees EOF
// and exits.
import { CLI } from "./paths.ts";

export type CliResult = { code: number; out: string; err: string };

export async function runCli(args: string[], o: { env: Record<string, string>; cwd?: string; holdStdin?: boolean }): Promise<CliResult> {
  const p = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: o.cwd,
    env: o.env,
    stdin: o.holdStdin ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code, out, err };
}
