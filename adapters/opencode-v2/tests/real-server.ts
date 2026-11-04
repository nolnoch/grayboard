// The real Grayboard server as its own process, for the hosted transaction races (#383). A pause inside one
// of its SQLite transactions is synchronous, so it stops this process only: host.ts's OpenCode host, its
// driver and a second writer (tests/support/hosted-operation.ts) keep running. The same OAuth seams as
// host.ts's in-process server: a fake Google exchange and the saved CIMD document.
// As a process: prints its port; a stdin line `pause <point> <file>` arms BUS_TEST_PAUSE (replacing any
// earlier point), answered on stdout. Stops on SIGTERM.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { startServer } from "../../../src/server/app.ts";
import type { Config } from "../../../src/server/config.ts";
import { OPENCODE_CLIENT } from "../../../src/server/oauth-config.ts";
import { transactionProcess } from "../../../tests/support/transaction-process.ts";
import { savedClientMetadata } from "./cimd-fixture.js";
import { bounded } from "./reload-state.ts";

// A held pause: `hit` resolves on the point's next hit after arming; `release` lets it go.
export interface HeldPause { hit(ms?: number): Promise<void>; release(): void }
export interface RealServer {
  port: number;
  // Arms `point` to hold until released.
  pause(point: string): Promise<HeldPause>;
  // Arms `point` already released: its hit line traces when a path reaches it, without holding it.
  trace(point: string): Promise<Pick<HeldPause, "hit">>;
  // Abandons any held pause, stops the server and copies its output into this process's log.
  stop(): Promise<void>;
}

// `dir` holds the pause files; deleting it abandons a held pause, so the server exits instead of hanging.
export async function spawnRealServer(config: Config, dir: string): Promise<RealServer> {
  mkdirSync(dir, { recursive: true });
  const child = transactionProcess("adapters/opencode-v2/tests/real-server.ts", [JSON.stringify(config)], "", "");
  await bounded(child.wait("REAL_SERVER_PORT "), 20_000, "Real server process listening");
  const port = Number(/REAL_SERVER_PORT (\d+)/.exec(child.output())![1]);
  const count = (text: string) => child.errors().split(text).length - 1;
  let files = 0, commands = 0;
  const command = async (line: string) => {
    child.proc.stdin.write(line + "\n"); child.proc.stdin.flush();
    await bounded(child.wait("REAL_SERVER_ARMED", ++commands), 10_000, "Real server answered " + line);
  };
  return {
    port,
    async pause(point: string) {
      const file = join(dir, `pause-${++files}`), text = `test pause hit: ${point}`, before = count(text);
      await command(`pause ${point} ${file}`);
      return {
        hit: (ms = 20_000) => bounded(child.wait(text, before + 1), ms, "Real server reached " + point),
        release: () => writeFileSync(file, "release"),
      };
    },
    // The file exists before arming, so a hit prints and passes straight through.
    async trace(point: string) {
      const file = join(dir, `pause-${++files}`), text = `test pause hit: ${point}`, before = count(text);
      writeFileSync(file, "release");
      await command(`pause ${point} ${file}`);
      return { hit: (ms = 20_000) => bounded(child.wait(text, before + 1), ms, "Real server traced " + point) };
    },
    async stop() {
      rmSync(dir, { recursive: true, force: true });
      child.proc.kill("SIGTERM"); await child.proc.exited; await child.done;
      for (const line of (child.output() + child.errors()).split("\n").filter(Boolean)) console.log("REAL_SERVER | " + line);
    },
  };
}

if (import.meta.main) {
  const config: Config = JSON.parse(process.argv[2]!);
  const app = startServer(config, { hostname: "127.0.0.1", background: false, oauth: {
    exchangeGoogle: async () => ({ email: "you@example.com", displayName: "Fixture" }),
    cimd: {
      resolve: async host => { if (host !== "opencode.ai") throw new Error("Unexpected CIMD host " + host); return [{ address: "93.184.216.34", family: 4 }]; },
      read: async url => { if (url.href !== OPENCODE_CLIENT) throw new Error("Unexpected CIMD URL"); return savedClientMetadata(url); },
    },
  } });
  process.on("SIGTERM", () => { void app.stop().finally(() => process.exit(0)); });
  console.log("REAL_SERVER_PORT " + app.server.port);
  for await (const line of createInterface({ input: process.stdin })) {
    const [command, point, file] = line.split(" ");
    if (command !== "pause" || !point || !file) throw new Error("real server: unknown command " + line);
    process.env.BUS_TEST_PAUSE = point; process.env.BUS_TEST_PAUSE_FILE = file;
    console.log("REAL_SERVER_ARMED " + line);
  }
}
