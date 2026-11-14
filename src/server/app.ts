import { MAX_BODY_BYTES } from "../core/boards.ts";
import { openDatabase } from "./db.ts";
import { createWsRefusal, type RefusalData } from "./ws_refusal.ts";
import { createApplication, type ApplicationOptions } from "./application.ts";
import { handleHttp, isJsonRequest, signInRoute } from "./http.ts";
import { AuthGate } from "./auth_gate.ts";
import { createHostedMcp } from "./mcp.ts";
import { createMcpAttachments } from "./mcp-attachments.ts";
import { createOAuthServer, type OAuthOptions } from "./oauth.ts";
import { UploadGate } from "./uploads.ts";
import { startRetentionJobs } from "./retention.ts";
import { createTouchQueue } from "./auth.ts";
import type { Config } from "./config.ts";
import { SlackBridge } from "./slack.ts";

export type StartOptions = ApplicationOptions & {
  hostname?: string;
  // Tests skip the nightly retention timer and the revalidate timer.
  background?: boolean;
  retentionFirstDelayMs?: number;
  // Trusted test dependency injection; never populated from configuration.
  oauth?: OAuthOptions;
};

// A start option overrides the config's limit; an explicit undefined one doesn't wipe it (#385 item 14).
export function startLimits(config: Pick<Config, "helloLimit" | "hostedRequestLimit" | "hostedCaps">, opts: StartOptions) {
  return { ...opts, helloLimit: opts.helloLimit ?? config.helloLimit, hostedRequestLimit: opts.hostedRequestLimit ?? config.hostedRequestLimit,
    observerCap: opts.observerCap ?? config.hostedCaps?.watches.global };
}

export function startServer(config: Config, opts: StartOptions = {}) {
  const humanReach = config.humanReach ?? "team";
  const { db, repo } = openDatabase(config.dbPath, { blobDir: config.blobDir, humanReach, attachmentLimits: config.attachmentLimits, attachmentUserQuota: config.attachmentUserQuota, ...(opts.now ? { now: opts.now } : {}) });
  let slack: SlackBridge | undefined;
  const application = createApplication(repo, db, { humanReach, slackRunning: () => slack?.running ?? false, ...startLimits(config, opts) });
  const { revalidate, disconnectUser, accessChanged, stopExpiry, wake } = application;
  const refusal = createWsRefusal();

  const authGate = new AuthGate(repo, {
    trustedProxies: config.trustedProxies, limit: config.authFailLimit,
    ...(opts.now ? { now: opts.now } : {}),
  });
  const sweepLimits = () => { application.sweepHellos(); authGate.sweep(); };

  // The deferred session-touch queue this server owns; stop() cancels it
  // before closing the db (a fired-after-close touch is an unhandled crash).
  const touches = createTouchQueue();
  const oauth = createOAuthServer(repo, config, opts.oauth);
  const mcp = createHostedMcp(application, oauth, { trustedOrigin: new URL(config.publicUrl).origin, now: opts.now, limits: config.mcpLimits, caps: config.hostedCaps, ...(config.hostedIdleSeconds ? { idleSeconds: config.hostedIdleSeconds } : {}) });
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

  const server = Bun.serve<RefusalData>({
    hostname: opts.hostname,
    port: config.httpPort,
    idleTimeout: 75,
    // The largest body is an attachment upload (src/server/http.ts); the
    // margin covers a JSON request carrying a full message body.
    maxRequestBodySize: repo.attachmentLimits.file + MAX_BODY_BYTES,

    async fetch(req, server) {
      // First, before anything reads the database (#240).
      const caller = authGate.caller(req, server.requestIP(req)?.address);
      const url = new URL(req.url);
      const path = url.pathname;
      const limited = authGate.refuse(caller, path);
      if (limited) return limited;

      const response = await oauth.fetch(req, { key: caller.key });
      if (response) return response;
      // The OAuth byte routes charge a refused bearer as /mcp does (#401).
      // The AS routes above authenticate clients by secret, not bearer, and
      // stay under the OAuth limiters alone.
      const attachmentResponse = attachments.fetch(req);
      if (attachmentResponse) return attachmentResponse.then(res => authGate.chargeRefusedToken(caller, req, path, res));
      if (path === "/mcp" || path === mcpPath) return mcp.fetch(req, caller.ip ?? "unknown").then(res => authGate.chargeRefusedToken(caller, req, path, res));
      // A pre-removal `grayboard mcp --mode server` (#282): no auth, no session; the handler answers its hello with a refusal.
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (!refusal.admit(caller.key)) return Response.json({ code: "rate_limited", message: "too many open connections from this address" }, { status: 429 });
        if (server.upgrade(req, { data: { key: caller.key } })) return;
        refusal.release(caller.key);
        return new Response("WebSocket upgrade failed", { status: 500 });
      }

      // A sign-in costs a token up front: the exchange awaits Google. Only a
      // JSON body is accepted, uncharged otherwise: a cross-origin page can
      // post a form without a preflight, but not application/json.
      if (signInRoute(req.method, path, config)?.charged) {
        if (!isJsonRequest(req)) return Response.json({ code: "unsupported_media_type", message: "sign-in takes Content-Type: application/json" }, { status: 415 });
        authGate.charge(caller, req, path, "sign-in");
      }
      return handleHttp(req, repo, db, config, touches, wake, slack, { disconnectUser, accessChanged }, caller.ip, application.boardsChanged, url).then((res) => authGate.chargeRefusedToken(caller, req, path, res));
    },

    websocket: refusal.handlers,

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
    timers.push(setInterval(sweepLimits, 30_000), setInterval(() => {
      // A throw here would surface as an unhandled error every 30 s with no context; log it and let the next tick retry.
      try { revalidate(); } catch (e) { console.error(`[grayboard] revalidate failed: ${(e as Error).stack ?? e}`); }
    }, 30_000));
    stopRetention = startRetentionJobs(repo, db, config, opts.retentionFirstDelayMs !== undefined ? { firstDelayMs: opts.retentionFirstDelayMs } : undefined, application.boardsChanged);
  }

  return {
    server,
    application,
    mcp,
    oauth,
    repo,
    db,
    refusal,
    // Exposed for tests: the bridge instance, to drive fatal stops directly.
    slack,
    // The auth re-check and limiter sweep, for tests that run without it.
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
