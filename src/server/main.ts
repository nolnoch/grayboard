import "./zod_config.ts";
import pkg from "../../package.json" with { type: "json" };
import { describeBlobs, describeReauth, describeStore, loadConfig } from "./config.ts";
import { startServer } from "./app.ts";
import { openRepo } from "./open_repo.ts";
import { BUILTIN_CLIENT_IDS } from "./oauth-config.ts";

// Before loadConfig, which refuses to run without the server's env.
if (process.argv.includes("--version")) {
  console.log(pkg.version);
  process.exit(0);
}

const config = loadConfig();
// The open migrates a Postgres store (#807 P3 C11b): a failure there is a failed startup, before anything listens.
let repo;
try {
  repo = await openRepo(config);
} catch (e) {
  console.error(`grayboard server: startup failed: opening ${describeStore(config.store)}: ${(e as Error).stack ?? e}`);
  process.exit(1);
}
const { server, stop, metrics, ready } = startServer(config, { repo });

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

// The listening line means ready: the startup writes have committed and requests are served (#807 P3 A4).
try {
  await ready;
} catch (e) {
  console.error(`grayboard server: startup failed: ${(e as Error).stack ?? e}`);
  await stop().catch(() => {});
  process.exit(1);
}
console.log(`grayboard server ${pkg.version} listening on port ${server.port}`);
console.log(`grayboard server: store ${describeStore(config.store, { writers: config.databaseWriters })}`);
console.log(`grayboard server: attachments ${describeBlobs(config)}`);
// An unauthenticated listener: say where it bound, every start.
console.log(`grayboard server: metrics ${metrics ? `on ${metrics.hostname}:${metrics.port}` : "off"}`);
// Write-capable hosted clients are a trust decision (#414, #429); say which at every start.
const sourced = (config.oauthClients ?? []).filter(c => c.sessionSource).map(c => c.clientId);
console.log(`grayboard server: operator clients with sessionSource: ${sourced.length ? sourced.join(", ") : "none"}`);
console.log(`grayboard server: built-in clients: ${BUILTIN_CLIENT_IDS.join(", ")}`);
// A provider with no directory check leaves an offboarded user's grants working until the re-auth window ends (#930).
console.log(`grayboard server: IdP re-auth: ${describeReauth(config)}`);
const cimdClients = config.oauthCimdClients ?? [];
console.log(`grayboard server: metadata-document clients: ${cimdClients.length ? cimdClients.join(", ") : "none"}`);

