import pkg from "../../package.json" with { type: "json" };
import { loadConfig } from "./config.ts";
import { startServer } from "./app.ts";

// Before loadConfig, which refuses to run without the server's env.
if (process.argv.includes("--version")) {
  console.log(pkg.version);
  process.exit(0);
}

const config = loadConfig();
const { server, stop } = startServer(config);

console.log(`grayboard server ${pkg.version} listening on port ${server.port}`);
// Write-capable hosted clients are an operator trust decision (#414); say which at every start.
const sourced = (config.oauthClients ?? []).filter(c => c.sessionSource).map(c => c.clientId);
console.log(`grayboard server: operator clients with sessionSource: ${sourced.length ? sourced.join(", ") : "none"}`);

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
