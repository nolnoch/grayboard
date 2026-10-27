import { MAX_BODY_BYTES } from "../core/boards.ts";
import { openDatabase } from "./db.ts";
import { createWsHandlers, type WsData, type WsOptions } from "./ws.ts";
import { createApplication } from "./application.ts";
import { handleHttp, isJsonRequest, signInRoute } from "./http.ts";
import { AuthGate } from "./auth_gate.ts";
import { createHostedMcp } from "./mcp.ts";
import { createMcpAttachments } from "./mcp-attachments.ts";
import { createOAuthServer, type OAuthOptions } from "./oauth.ts";
import { UploadGate } from "./uploads.ts";
import { startRetentionJobs } from "./retention.ts";
import { verifySessionToken, extractBearer, createTouchQueue } from "./auth.ts";
import type { Config } from "./config.ts";
import { SlackBridge } from "./slack.ts";

export type StartOptions = WsOptions & {
  hostname?: string;
  // Tests skip the nightly retention timer and heartbeat.
  background?: boolean;
  retentionFirstDelayMs?: number;
  // Trusted test dependency injection; never populated from configuration.
  oauth?: OAuthOptions;
};

export function startServer(config: Config, opts: StartOptions = {}) {
  const humanReach = config.humanReach ?? "team";
  const { db, repo } = openDatabase(config.dbPath, { blobDir: config.blobDir, humanReach, attachmentLimits: config.attachmentLimits, attachmentUserQuota: config.attachmentUserQuota });
  let slack: SlackBridge | undefined;
  const application = createApplication(repo, db, {
    humanReach, slackRunning: () => slack?.running ?? false, helloLimit: config.helloLimit, hostedRequestLimit: config.hostedRequestLimit, ...opts,
  });
  const { revalidate, disconnectUser, stopExpiry, wake } = application;
  const { handlers, startPing } = createWsHandlers(application);

  const authGate = new AuthGate(repo, {
    trustedProxies: config.trustedProxies, limit: config.authFailLimit,
    ...(opts.now ? { now: opts.now } : {}),
  });
  const sweepLimits = () => { application.sweepHellos(); authGate.sweep(); };

  // The deferred session-touch queue this server owns; stop() cancels it
  // before closing the db (a fired-after-close touch is an unhandled crash).
  const touches = createTouchQueue();
  const oauth = createOAuthServer(repo, config, opts.oauth);
  const mcp = createHostedMcp(application, oauth, { trustedOrigin: new URL(config.publicUrl).origin, now: opts.now, limits: config.mcpLimits });
  const mcpPath = new URL(oauth.resource).pathname;

  // A Slack outage or bad token mustn't take the bus down: log and run without it.
  slack = config.slack ? new SlackBridge({
    repo, db, application, ...config.slack,
    ...(process.env.GRAYBOARD_SLACK_DEBUG ? { debug: (msg: string) => console.error(`[grayboard slack] debug: ${msg}`) } : {}),
  }) : undefined;
  const slackReady = slack?.start().catch((e) => {
    console.error(`[grayboard slack] not started: ${(e as Error).message}`);
    // A boot-time failure (bad bot token, Slack outage) is fatal, not
    // deliberate: every linked user's human is silently offline and must be
    // told. The stopped latch makes the subsequent onFatal stop a no-op.
    slack.stop({ fatal: true, detail: `not started: ${(e as Error).message}` });
  });

  // Room for four messages' worth of upload bodies at once, one per user.
  const uploads = new UploadGate(4 * repo.attachmentLimits.total, repo.attachmentLimits.total);
  const attachments = createMcpAttachments(repo, db, oauth, uploads, { trustedOrigin: new URL(config.publicUrl).origin, sessions: mcp.sessions });

  const server = Bun.serve<WsData>({
    hostname: opts.hostname,
    port: config.httpPort,
    idleTimeout: 75,
    // The largest body is an attachment upload (src/server/http.ts); the
    // margin covers a JSON request carrying a full message body.
    maxRequestBodySize: repo.attachmentLimits.file + MAX_BODY_BYTES,

    async fetch(req, server) {
      // First, before anything reads the database (#240).
      const caller = authGate.caller(req, server.requestIP(req)?.address);
      const path = new URL(req.url).pathname;
      const limited = authGate.refuse(caller, path);
      if (limited) return limited;

      const response = await oauth.fetch(req, { key: caller.key });
      if (response) return response;
      const attachmentResponse = attachments.fetch(req);
      if (attachmentResponse) return attachmentResponse;
      if (path === "/mcp" || path === mcpPath) return mcp.fetch(req, caller.ip ?? "unknown").then(res => authGate.chargeRefusedToken(caller, req, path, res));
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const raw = extractBearer(req);
        // No token costs nothing: a page can open a WebSocket cross-origin (auth_gate.ts).
        if (!raw) return Response.json({ code: "unauthenticated", message: "missing token" }, { status: 401 });
        const authed = verifySessionToken(raw, repo, touches);
        if (!authed) {
          authGate.charge(caller, req, path, "invalid token");
          return Response.json({ code: "unauthenticated", message: "invalid token" }, { status: 401 });
        }
        const upgraded = server.upgrade(req, {
          data: {
            authed,
            identityName: "",
            identityFull: "",
            ready: false,
          },
        });
        if (upgraded) return;
        return new Response("WebSocket upgrade failed", { status: 500 });
      }

      // A sign-in costs a token up front: the exchange awaits Google. Only a
      // JSON body is accepted, uncharged otherwise: a cross-origin page can
      // post a form without a preflight, but not application/json.
      if (signInRoute(req.method, path, config)?.charged) {
        if (!isJsonRequest(req)) return Response.json({ code: "unsupported_media_type", message: "sign-in takes Content-Type: application/json" }, { status: 415 });
        authGate.charge(caller, req, path, "sign-in");
      }
      return handleHttp(req, repo, db, config, touches, uploads, wake, slack, disconnectUser, caller.ip, application.boardsChanged).then((res) => authGate.chargeRefusedToken(caller, req, path, res));
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
  let stopRetention: (() => void) | undefined;
  let stopPromise: Promise<void> | undefined;
  if (opts.background !== false) {
    timers.push(startPing(), setInterval(sweepLimits, 30_000));
    stopRetention = startRetentionJobs(repo, db, config, opts.retentionFirstDelayMs !== undefined ? { firstDelayMs: opts.retentionFirstDelayMs } : undefined, application.boardsChanged);
  }

  return {
    server,
    application,
    mcp,
    oauth,
    repo,
    db,
    handlers,
    // Exposed for tests: the bridge instance, to drive fatal stops directly.
    slack,
    // The heartbeat's auth re-check and limiter sweep, for tests that run without it.
    revalidate,
    sweepLimits,
    authGate,
    // Settles once the Slack bridge is up, or has given up.
    slackReady: slackReady ?? Promise.resolve(),
    touches,
    stop() {
      if (stopPromise) return stopPromise;
      slack?.stop();
      for (const t of timers) clearInterval(t);
      stopRetention?.();
      stopExpiry();
      touches.cancelAll();
      server.stop(true);
      stopPromise = Promise.allSettled([mcp.close(), attachments.close()]).then(outcomes => {
        const failure = outcomes.find(outcome => outcome.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      }).finally(() => { oauth.close(); db.close(); });
      return stopPromise;
    },
  };
}
