import { MAX_BODY_BYTES } from "../core/boards.ts";
import { openDatabase } from "./db.ts";
import { createWsHandlers, type WsData, type WsOptions } from "./ws.ts";
import { handleHttp, isJsonRequest, signInRoute } from "./http.ts";
import { AuthGate } from "./auth_gate.ts";
import { UploadGate } from "./uploads.ts";
import { startRetentionJobs } from "./retention.ts";
import { verifySessionToken, extractBearer, createTouchQueue } from "./auth.ts";
import type { Config } from "./config.ts";
import { SlackBridge } from "./slack.ts";

export type StartOptions = WsOptions & {
  // Tests skip the nightly retention timer and heartbeat.
  background?: boolean;
  // Test hook: ms until the first nightly retention run, instead of the next
  // UTC midnight — so a test can hold the timer pending across a stop().
  retentionFirstDelayMs?: number;
};

export function startServer(config: Config, opts: StartOptions = {}) {
  const humanReach = config.humanReach ?? "team";
  const { db, repo } = openDatabase(config.dbPath, { blobDir: config.blobDir, humanReach, attachmentLimits: config.attachmentLimits, attachmentUserQuota: config.attachmentUserQuota });
  const { handlers, startPing, revalidate, disconnectUser, stopExpiry, wake, sweepHellos } = createWsHandlers(repo, db, {
    humanReach, slackRunning: () => slack?.running ?? false, ...opts, helloLimit: config.helloLimit,
  });
  const authGate = new AuthGate(repo, {
    trustedProxies: config.trustedProxies,
    limit: config.authFailLimit,
    ...(opts.now ? { now: opts.now } : {}),
  });
  // Both limiters drop refilled buckets, ending their runs of refusals.
  const sweepLimits = () => {
    sweepHellos();
    authGate.sweep();
  };

  // The deferred session-touch queue this server owns; stop() cancels it
  // before closing the db (a fired-after-close touch is an unhandled crash).
  const touches = createTouchQueue();

  // A Slack outage or bad token mustn't take the bus down: log and run without it.
  const slack = config.slack ? new SlackBridge({
    repo, db, handlers, ...config.slack,
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

  const server = Bun.serve<WsData>({
    port: config.httpPort,
    idleTimeout: 75,
    // The largest body is an attachment upload (src/server/http.ts); the
    // margin covers a JSON request carrying a full message body.
    maxRequestBodySize: repo.attachmentLimits.file + MAX_BODY_BYTES,

    fetch(req, server) {
      // First, before anything reads the database (#240).
      const caller = authGate.caller(req, server.requestIP(req)?.address);
      const path = new URL(req.url).pathname;
      const limited = authGate.refuse(caller, path);
      if (limited) return limited;

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
      return handleHttp(req, repo, db, config, touches, uploads, wake, slack, disconnectUser, caller.ip).then((res) => authGate.chargeRefusedToken(caller, req, path, res));
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
  let stopped = false;
  if (opts.background !== false) {
    timers.push(startPing(), setInterval(sweepLimits, 30_000));
    stopRetention = startRetentionJobs(repo, db, config, opts.retentionFirstDelayMs !== undefined ? { firstDelayMs: opts.retentionFirstDelayMs } : undefined);
  }

  return {
    server,
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
    // The session-touch queue, for tests that schedule touches directly.
    touches,
    // Owns everything startServer opened: idempotent, closes the database
    // once the server and every user of it (bridge, timers, expiry) is down.
    stop() {
      if (stopped) return;
      stopped = true;
      slack?.stop();
      for (const t of timers) clearInterval(t);
      stopRetention?.();
      stopExpiry();
      touches.cancelAll();
      server.stop(true);
      db.close();
    },
  };
}
