import { MAX_BODY_BYTES } from "../core/boards.ts";
import { openDatabase } from "./db.ts";
import { createWsHandlers, type WsData, type WsOptions } from "./ws.ts";
import { createApplication } from "./application.ts";
import { createHostedMcp } from "./mcp.ts";
import { createOAuthServer, type OAuthOptions } from "./oauth.ts";
import { handleHttp } from "./http.ts";
import { UploadGate } from "./uploads.ts";
import { startRetentionJobs } from "./retention.ts";
import { verifySessionToken, extractBearer } from "./auth.ts";
import type { Config } from "./config.ts";
import { SlackBridge } from "./slack.ts";

export type StartOptions = WsOptions & {
  // Tests skip the nightly retention timer and heartbeat.
  background?: boolean;
  // Trusted test dependency injection; never populated from configuration.
  oauth?: OAuthOptions;
};

export function startServer(config: Config, opts: StartOptions = {}) {
  const humanReach = config.humanReach ?? "team";
  const { db, repo } = openDatabase(config.dbPath, { blobDir: config.blobDir, humanReach, attachmentLimits: config.attachmentLimits, attachmentUserQuota: config.attachmentUserQuota });
  const application = createApplication(repo, db, {
    humanReach, slackRunning: () => slack?.running ?? false, ...opts,
  });
  const { revalidate, disconnectUser, stopExpiry, wake } = application;
  const { handlers, startPing } = createWsHandlers(application);
  const oauth = createOAuthServer(repo, config, opts.oauth);
  const mcp = createHostedMcp(application, oauth, { trustedOrigin: new URL(config.publicUrl).origin });
  const mcpPath = new URL(oauth.resource).pathname;

  // A Slack outage or bad token mustn't take the bus down: log and run without it.
  const slack = config.slack ? new SlackBridge({
    repo, db, application, ...config.slack,
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
    // The largest body is an attachment upload (src/server/http.ts); the
    // margin covers a JSON request carrying a full message body.
    maxRequestBodySize: repo.attachmentLimits.file + MAX_BODY_BYTES,

    async fetch(req, server) {
      const address = server.requestIP(req)?.address;
      const response = await oauth.fetch(req, address ? { remoteAddress: address } : undefined);
      if (response) return response;
      const path = new URL(req.url).pathname;
      if (path === "/mcp" || path === mcpPath) return mcp.fetch(req);
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

      return handleHttp(req, repo, db, config, uploads, wake, slack, disconnectUser, application.boardsChanged);
    },

    websocket: handlers,

    // A route that throws something other than a refusal it maps itself. Bun's
    // default answer, without NODE_ENV=production, is a dev page carrying the
    // message (blob paths, errno text); the client gets a bare 500 instead.
    error(e) {
      console.error(`[grayboard] request failed: ${e.stack ?? e.message}`);
      return Response.json({ code: "internal", message: "internal error" }, { status: 500 });
    },
  });

  const timers: ReturnType<typeof setInterval>[] = [];
  if (opts.background !== false) {
    timers.push(startPing());
    startRetentionJobs(repo, db, config, application.boardsChanged);
  }

  return {
    server,
    mcp,
    oauth,
    repo,
    db,
    // The heartbeat's auth re-check, for tests that run without it.
    revalidate,
    // Settles once the Slack bridge is up, or has given up.
    slackReady: slackReady ?? Promise.resolve(),
    async stop() {
      slack?.stop();
      for (const t of timers) clearInterval(t);
      stopExpiry();
      server.stop(true);
      try { await mcp.close(); } finally { oauth.close(); }
    },
  };
}
