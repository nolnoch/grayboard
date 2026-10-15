import { loadConfig } from "./config.ts";
import { startServer } from "./app.ts";

const { server, stop } = startServer(loadConfig());

console.log(`grayboard server listening on port ${server.port}`);

process.on("SIGINT",  () => { stop(); process.exit(0); });
process.on("SIGTERM", () => { stop(); process.exit(0); });
