import { loadConfig } from "./config.ts";
import { openDatabase } from "./db.ts";
import { createWsHandlers, startPingInterval, type WsData } from "./ws.ts";
import { handleHttp } from "./http.ts";
import { startRetentionJobs } from "./retention.ts";
import { verifySessionToken, extractBearer } from "./auth.ts";

const config = loadConfig();
const { repo } = openDatabase(config.dbPath);
const wsHandlers = createWsHandlers(repo);

const server = Bun.serve<WsData>({
  port: config.httpPort,
  idleTimeout: 75,

  fetch(req, server) {
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const raw = extractBearer(req);
      if (!raw) {
        return Response.json({ code: "unauthenticated", message: "missing token" }, { status: 401 });
      }
      const authed = verifySessionToken(raw, repo);
      if (!authed) {
        return Response.json({ code: "unauthenticated", message: "invalid token" }, { status: 401 });
      }
      const upgraded = server.upgrade(req, {
        data: {
          authed,
          identityId: 0,
          identityName: "",
          identityFull: "",
          ready: false,
        },
      });
      if (upgraded) return;
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    return handleHttp(req, repo, config);
  },

  websocket: wsHandlers,
});

startPingInterval();
startRetentionJobs(repo, config);

console.log(`grayboard server listening on port ${server.port}`);

process.on("SIGINT",  () => { server.stop(); process.exit(0); });
process.on("SIGTERM", () => { server.stop(); process.exit(0); });
