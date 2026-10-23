import { openDatabase } from "./db.ts";
import { createWsHandlers, type WsData, type WsOptions } from "./ws.ts";
import { handleHttp } from "./http.ts";
import { UploadGate } from "./uploads.ts";
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
  const { db, repo } = openDatabase(config.dbPath, { blobDir: config.blobDir, humanReach, attachmentLimits: config.attachmentLimits, attachmentUserQuota: config.attachmentUserQuota });
  const { handlers, startPing, revalidate, disconnectUser, stopExpiry, wake } = createWsHandlers(repo, db, {
    humanReach, slackRunning: () => slack?.running ?? false, ...opts,
  });

  // A Slack outage or bad token mustn't take the bus down: log and run without it.
  const slack = config.slack ? new SlackBridge({
    repo, db, handlers, ...config.slack,
    ...(process.env.GRAYBOARD_SLACK_DEBUG ? { debug: (msg: string) => console.error(`[grayboard slack] debug: ${msg}`) } : {}),
  }) : undefined;
  const slackReady = slack?.start().catch((e) => {
    console.error(`[grayboard slack] not started: ${(e as Error).message}`);
    slack.stop();
  });

  // Room for four messages' worth of upload bodies at once, one per user.
  const uploads = new UploadGate(4 * repo.attachmentLimits.total, repo.attachmentLimits.total);

  const server = Bun.serve<WsData>({
    port: config.httpPort,
    idleTimeout: 75,
    // The largest body is an attachment upload (src/server/http.ts).
    maxRequestBodySize: repo.attachmentLimits.file + 64 * 1024,

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

      return handleHttp(req, repo, db, config, uploads, wake, slack, disconnectUser);
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
