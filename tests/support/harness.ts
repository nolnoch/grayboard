// A harness stand-in (#182 decision 14): the one parent of a session's
// `grayboard mcp`, which runs on this process's inherited stdio as Claude
// Code or pi runs it. Each test session gets its own, as each real session
// has its own harness, so a name record never leaks between sessions.
// SIGUSR1 restarts the child the way `/mcp` reconnect does (SIGTERM, wait,
// respawn); SIGUSR2 SIGKILLs it first (a crash). Once the old child is gone
// and the new one spawned, it prints RESTARTED on stderr, and the test may
// start a new MCP handshake. Otherwise it exits with its child.
// With HARNESS_SIBLINGS set to a unix socket path, it also starts a sibling
// of that child for each connection there (#1381): the same command, under
// this same pid, with the env the connection's first line names (a JSON
// object; a null value unsets), its stdio relayed over the connection and its
// stderr on this process's. siblingSession (mcp.ts) is the other end.
export const RESTARTED = "[harness] restarted";
export const SIBLINGS = "HARNESS_SIBLINGS";
import { processDescendants } from "./procs.ts";
import { until } from "./until.ts";

if (import.meta.main) {
  const cmd = process.argv.slice(2);
  let restarting = false;
  const run = () => {
    const p = Bun.spawn(cmd, { stdio: ["inherit", "inherit", "inherit"] });
    p.exited.then((code) => {
      if (!restarting) process.exit(code ?? 1);
    });
    return p;
  };
  let child = run();
  const restart = async (signal: "SIGTERM" | "SIGKILL") => {
    if (restarting) return;
    restarting = true;
    // A launcher is not its MCP child. End the complete owned tree before
    // reusing inherited stdio, or an orphan can answer the new initialize.
    const descendants = processDescendants(child.pid).map(p => p.pid).reverse();
    for (const pid of descendants) { try { process.kill(pid, signal); } catch {} }
    child.kill(signal);
    await child.exited;
    await until(() => descendants.every(pid => {
      try { process.kill(pid, 0); return false; } catch { return true; }
    }), 10_000, "retiring MCP descendants to exit");
    restarting = false;
    child = run();
    process.stderr.write(`${RESTARTED}\n`);
  };
  const sock = process.env[SIBLINGS];
  if (sock) {
    type Conn = { proc?: Bun.Subprocess<"pipe", "pipe", "inherit">; head: string };
    const siblings = new Set<Bun.Subprocess>();
    const exit = () => { for (const p of siblings) p.kill("SIGTERM"); };
    process.on("exit", exit);
    Bun.listen<Conn>({
      unix: sock,
      socket: {
        open(s) { s.data = { head: "" }; },
        data(s, chunk) {
          const c = s.data;
          if (c.proc) { c.proc.stdin.write(chunk); c.proc.stdin.flush(); return; }
          c.head += chunk.toString();
          const nl = c.head.indexOf("\n");
          if (nl < 0) return;
          const env: Record<string, string> = { ...process.env } as Record<string, string>;
          delete env[SIBLINGS];
          for (const [k, v] of Object.entries(JSON.parse(c.head.slice(0, nl)) as Record<string, string | null>)) {
            if (v === null) delete env[k];
            else env[k] = v;
          }
          const p = Bun.spawn(cmd, { env, stdin: "pipe", stdout: "pipe", stderr: "inherit" });
          c.proc = p;
          siblings.add(p);
          const rest = c.head.slice(nl + 1);
          if (rest) { p.stdin.write(rest); p.stdin.flush(); }
          void (async () => {
            for await (const out of p.stdout) s.write(out);
            s.end();
          })();
          void p.exited.then(() => siblings.delete(p));
        },
        close(s) { s.data.proc?.stdin.end(); },
        error() {},
      },
    });
  }
  process.on("SIGUSR1", () => void restart("SIGTERM"));
  process.on("SIGUSR2", () => void restart("SIGKILL"));
}
