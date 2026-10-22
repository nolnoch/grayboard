import { openDatabase } from "./db.ts";
import { createWsHandlers, type WsData, type WsOptions } from "./ws.ts";
import { handleHttp } from "./http.ts";
import { startRetentionJobs } from "./retention.ts";
import { verifySessionToken, extractBearer } from "./auth.ts";
import type { Config } from "./config.ts";
import { SlackBridge } from "./slack.ts";

export type StartOptions = WsOptions & {
  // Tests skip the nightly retention timer and heartbeat.
  background?: boolean;
};

export function startServer(config: Config, opts: StartOptions = {}) {
  const humanReach = config.humanReach ?? "team";
  const { db, repo } = openDatabase(config.dbPath, humanReach);
  const { handlers, startPing, revalidate, disconnectUser, stopExpiry, wake, fleetState, disconnectLane, disconnectIdentity } = createWsHandlers(repo, db, {
    humanReach, slackRunning: () => slack?.running ?? false, ...opts,
  });

  // Lane rows mirror live sessions; at boot none are connected, so they all
  // date from before this process (a crash or restart left them). Wipe them —
  // the roster's ghosts — rather than let them render as offline lanes.
  db.exec("DELETE FROM lanes");

  // A Slack outage or bad token mustn't take the bus down: log and run without it.
  const slack = config.slack ? new SlackBridge({
    repo, db, handlers, ...config.slack,
    ...(process.env.GRAYBOARD_SLACK_DEBUG ? { debug: (msg: string) => console.error(`[grayboard slack] debug: ${msg}`) } : {}),
  }) : undefined;
  const slackReady = slack?.start().catch((e) => {
    console.error(`[grayboard slack] not started: ${(e as Error).message}`);
    slack.stop();
  });

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
            lane: "main",
            pushWanted: false,
            joinedAt: 0,
            ready: false,
          },
        });
        if (upgraded) return;
        return new Response("WebSocket upgrade failed", { status: 500 });
      }

      return handleHttp(req, repo, db, config, wake, slack, disconnectUser, { fleetState, disconnectLane, disconnectIdentity });
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
    // The heartbeat's auth re-check, for tests that run without it.
    revalidate,
    // Settles once the Slack bridge is up, or has given up.
    slackReady: slackReady ?? Promise.resolve(),
    stop() {
      slack?.stop();
      for (const t of timers) clearInterval(t);
      stopExpiry();
      server.stop(true);
    },
  };
}
