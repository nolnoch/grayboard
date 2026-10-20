import { openDatabase } from "./db.ts";
import { createWsHandlers, type WsData, type WsOptions } from "./ws.ts";
import { handleHttp } from "./http.ts";
import { startRetentionJobs } from "./retention.ts";
import { verifySessionToken, extractBearer } from "./auth.ts";
import type { Config } from "./config.ts";

export type StartOptions = WsOptions & {
  // Tests skip the nightly retention timer and heartbeat.
  background?: boolean;
};

export function startServer(config: Config, opts: StartOptions = {}) {
  const { db, repo } = openDatabase(config.dbPath);
  const { handlers, startPing, stopExpiry, wake } = createWsHandlers(repo, db, opts);

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

      return handleHttp(req, repo, db, config, wake);
    },

    websocket: handlers,
  });

  const timers: ReturnType<typeof setInterval>[] = [];
  if (opts.background !== false) {
    timers.push(startPing());
    startRetentionJobs(repo, db, config);
  }

  return {
    server,
    repo,
    db,
    stop() {
      for (const t of timers) clearInterval(t);
      stopExpiry();
      server.stop(true);
    },
  };
}
