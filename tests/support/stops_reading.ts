// A real `grayboard mcp` behind a relay that stops reading while grayboard
// still runs and still holds its names (#580). `tools` runs the command it's
// given. Otherwise it starts grayboard from its args and relays stdio until it
// relays a line containing STOP_READING, the first time across runs
// (BUS_TEST_STOP_READING names a marker file): then it closes its own stdin, so
// the adapter's next large write fails with EPIPE, while grayboard keeps
// running and its output keeps reaching the adapter. Once the marker exists, a
// start relays without stopping, as the replacement. SIGTERM ends grayboard
// through its stdin, as a closed adapter pipe would.
import { spawn } from "node:child_process";
import { closeSync, existsSync, writeFileSync } from "node:fs";

// tests/support/omp.ts sends it as STOP_READING too.
const STOP_READING = "stop-reading-580";

const [cmd, ...args] = process.argv.slice(2);
if (args.includes("tools")) {
  const r = Bun.spawnSync([cmd!, ...args], { stdout: "inherit", stderr: "inherit" });
  process.exit(r.exitCode ?? 1);
}
const marker = process.env.BUS_TEST_STOP_READING!;
const child = spawn(cmd!, args, { stdio: ["pipe", "inherit", "inherit"] });
child.on("exit", (code) => process.exit(code ?? 1));
process.on("SIGTERM", () => child.stdin!.end());
let stopping = existsSync(marker);
let buf = "";
process.stdin.setEncoding("utf8").on("data", (chunk: string) => {
  buf += chunk;
  for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
    const line = buf.slice(0, nl + 1);
    buf = buf.slice(nl + 1);
    child.stdin!.write(line);
    if (!stopping && line.includes(STOP_READING)) {
      stopping = true;
      writeFileSync(marker, "");
      process.stdin.destroy();
      try { closeSync(0); } catch {}
      return;
    }
  }
});
