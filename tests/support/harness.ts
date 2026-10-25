// A harness stand-in (#182 decision 14): the one parent of a session's
// `grayboard mcp`, which runs on this process's inherited stdio as Claude
// Code or pi runs it. Each test session gets its own, as each real session
// has its own harness, so a name record never leaks between sessions.
// SIGUSR1 restarts the child the way `/mcp` reconnect does (SIGTERM, wait,
// respawn); SIGUSR2 SIGKILLs it first (a crash). Once the old child is gone
// and the new one spawned, it prints RESTARTED on stderr, and the test may
// start a new MCP handshake. Otherwise it exits with its child.
export const RESTARTED = "[harness] restarted";

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
    child.kill(signal);
    await child.exited;
    restarting = false;
    child = run();
    process.stderr.write(`${RESTARTED}\n`);
  };
  process.on("SIGUSR1", () => void restart("SIGTERM"));
  process.on("SIGUSR2", () => void restart("SIGKILL"));
}
