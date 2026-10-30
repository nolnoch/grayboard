import pkg from "../../package.json" with { type: "json" };
import { loadConfig } from "./config.ts";
import { startServer } from "./app.ts";
import { BUILTIN_CLIENT_IDS } from "./oauth-config.ts";

// Before loadConfig, which refuses to run without the server's env.
if (process.argv.includes("--version")) {
  console.log(pkg.version);
  process.exit(0);
}

const config = loadConfig();
const { server, stop } = startServer(config);

// Handlers go in before the listening line: a supervisor (or test) that
// signals on seeing it must reach shutdown, not the default kill (#422).
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

console.log(`grayboard server ${pkg.version} listening on port ${server.port}`);
// Write-capable hosted clients are a trust decision (#414, #429); say which at every start.
const sourced = (config.oauthClients ?? []).filter(c => c.sessionSource).map(c => c.clientId);
console.log(`grayboard server: operator clients with sessionSource: ${sourced.length ? sourced.join(", ") : "none"}`);
console.log(`grayboard server: built-in clients: ${BUILTIN_CLIENT_IDS.join(", ")}`);

