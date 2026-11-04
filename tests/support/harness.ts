// A harness stand-in (#182 decision 14): the one parent of a session's
// `grayboard mcp`, which runs on this process's inherited stdio as Claude
// Code or pi runs it. Each test session gets its own, as each real session
// has its own harness, so a name record never leaks between sessions.
// SIGUSR1 restarts the child the way `/mcp` reconnect does (SIGTERM, wait,
// respawn); SIGUSR2 SIGKILLs it first (a crash). Once the old child is gone
// and the new one spawned, it prints RESTARTED on stderr, and the test may
// start a new MCP handshake. Otherwise it exits with its child.
export const RESTARTED = "[harness] restarted";
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
  process.on("SIGUSR1", () => void restart("SIGTERM"));
  process.on("SIGUSR2", () => void restart("SIGKILL"));
}
