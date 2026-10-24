import pkg from "../../package.json" with { type: "json" };
import { loadConfig } from "./config.ts";
import { startServer } from "./app.ts";

// Before loadConfig, which refuses to run without the server's env.
if (process.argv.includes("--version")) {
  console.log(pkg.version);
  process.exit(0);
}

const { server, stop } = startServer(loadConfig());

console.log(`grayboard server ${pkg.version} listening on port ${server.port}`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  try {
    await stop();
  } catch {
    console.error("grayboard server shutdown failed");
    process.exit(1);
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
