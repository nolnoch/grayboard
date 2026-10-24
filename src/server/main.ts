import { loadConfig } from "./config.ts";
import { startServer } from "./app.ts";

const { server, stop } = startServer(loadConfig());

console.log(`grayboard server listening on port ${server.port}`);

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
