// One `grayboard <args>` run, as a lane's shell runs it: env and cwd decide
// the handle. stdin is closed unless `holdStdin`, so `grayboard mcp` sees EOF
// and exits. A run that outlives `timeoutMs` is killed with its whole process
// group (install.sh's curl would otherwise hold the pipes open) and fails with
// what it printed. `bin` runs another executable instead of the source CLI: a
// compiled grayboard (a release), or /bin/bash for install.sh.
import { CLI } from "./paths.ts";

export type CliResult = { code: number; out: string; err: string };

export async function runCli(
  args: string[], o: { env: Record<string, string>; cwd?: string; holdStdin?: boolean; timeoutMs?: number; bin?: string },
): Promise<CliResult> {
  const p = Bun.spawn(o.bin ? [o.bin, ...args] : [process.execPath, CLI, ...args], {
    cwd: o.cwd,
    env: o.env,
    stdin: o.holdStdin ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-p.pid, "SIGKILL");
    } catch {
      p.kill("SIGKILL");
    }
  }, o.timeoutMs ?? 10_000);
  try {
    const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    if (timedOut) throw new Error(`grayboard ${args.join(" ")}: killed after ${o.timeoutMs ?? 10_000} ms\n--- stdout ---\n${out}\n--- stderr ---\n${err}`);
    return { code, out, err };
  } finally {
    clearTimeout(timer);
    if (o.holdStdin) (p.stdin as import("bun").FileSink).end();
  }
}
