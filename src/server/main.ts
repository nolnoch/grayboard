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

process.on("SIGINT",  () => { stop(); process.exit(0); });
process.on("SIGTERM", () => { stop(); process.exit(0); });
