// A real `grayboard mcp` behind a relay that stops reading while grayboard
// still runs and still holds its names (#580). `tools` runs the command it's
// given. Otherwise it starts grayboard from its args and relays stdio until it
// relays a line containing $BUS_TEST_STOP_READING_ON, the first time across
// runs ($BUS_TEST_STOP_READING names a marker file): then it closes its own
// stdin, so the adapter's next large write fails with EPIPE, while grayboard
// keeps running and its output keeps reaching the adapter. Once the marker
// exists, a start relays without stopping, as the replacement. SIGTERM or the
// adapter closing stdin ends grayboard through its stdin, as a closed adapter
// pipe would; after it stopped reading, SIGTERM does so a second later (under
// the adapter's 1.5 s SIGKILL), as a slow session end would, so a replacement
// started before the old process exits finds the name still held.
import { spawn } from "node:child_process";
import { closeSync, existsSync, writeFileSync } from "node:fs";

const [cmd, ...args] = process.argv.slice(2);
if (args.includes("tools")) {
  const r = Bun.spawnSync([cmd!, ...args], { stdout: "inherit", stderr: "inherit" });
  process.exit(r.exitCode ?? 1);
}
const marker = process.env.BUS_TEST_STOP_READING!;
const trigger = process.env.BUS_TEST_STOP_READING_ON!;
const child = spawn(cmd!, args, { stdio: ["pipe", "inherit", "inherit"] });
child.on("exit", (code) => process.exit(code ?? 1));
let stopped = false;
process.on("SIGTERM", () => setTimeout(() => child.stdin!.end(), stopped ? 1_000 : 0));
let stopping = existsSync(marker);
let buf = "";
process.stdin.on("end", () => child.stdin!.end());
process.stdin.setEncoding("utf8").on("data", (chunk: string) => {
  buf += chunk;
  for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
    const line = buf.slice(0, nl + 1);
    buf = buf.slice(nl + 1);
    child.stdin!.write(line);
    if (!stopping && line.includes(trigger)) {
      stopping = stopped = true;
      writeFileSync(marker, "");
      process.stdin.destroy();
      try { closeSync(0); } catch {}
      return;
    }
  }
});
