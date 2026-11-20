import { MAX_BODY_BYTES } from "../core/boards.ts";
import { openDatabase, type Repo } from "./db.ts";
import { sessionEndPort } from "./session_end.ts";
import { createApplication, type ApplicationOptions } from "./application.ts";
import { handleHttp, isJsonRequest, signInRoute } from "./http.ts";
import { AuthGate, type Caller } from "./auth_gate.ts";
import { userAgent } from "./audit.ts";
import { inRequest } from "./request_context.ts";
import { createHostedMcp } from "./mcp.ts";
import { createMcpAttachments } from "./mcp-attachments.ts";
import { createOAuthServer, type OAuthOptions } from "./oauth.ts";
import { UploadGate } from "./uploads.ts";
import { startRetentionJobs } from "./retention.ts";
import { createTouchQueue } from "./auth.ts";
import { writeAudit } from "./audit.ts";
import type { Config } from "./config.ts";
import { SlackBridge } from "./slack.ts";
import { serveMetrics, startLagSampler, type Gauges } from "./metrics.ts";
import { testPauseAsync } from "../shared/testpause.ts";
import { settleAll } from "./settle.ts";

export type StartOptions = ApplicationOptions & {
  hostname?: string;
  // Tests skip the nightly retention timer and the revalidate timer.
  background?: boolean;
  retentionFirstDelayMs?: number;
  // Trusted test dependency injection; never populated from configuration.
  oauth?: OAuthOptions;
  // The opened store to serve (openRepo in open_repo.ts, or a test's own makePgRepo); stop() closes it. Without one, startServer opens
  // config.store's SQLite file itself, which only tests rely on: they read the raw handle it exposes as `db`.
  repo?: Repo;
  // How long stop() waits for the requests in flight to finish before it closes the store anyway (#218).
  stopDrainMs?: number;
};

// stop()'s default drain deadline: inside a supervisor's usual stop grace (systemd's 90 s, Kubernetes' 30 s).
export const STOP_DRAIN_MS = 10_000;

// A start option overrides the config's limit; an explicit undefined one doesn't wipe it (#385 item 14).
export function startLimits(config: Pick<Config, "helloLimit" | "hostedRequestLimit" | "hostedSubscriberLimit" | "delegateLimit" | "delegateOpenCap" | "hostedCaps" | "aliasScopeCap" | "serviceLimits">, opts: StartOptions) {
  return {
    ...opts, helloLimit: opts.helloLimit ?? config.helloLimit, hostedRequestLimit: opts.hostedRequestLimit ?? config.hostedRequestLimit,
    hostedSubscriberLimit: opts.hostedSubscriberLimit ?? config.hostedSubscriberLimit, serviceLimits: opts.serviceLimits ?? config.serviceLimits,
    delegateLimit: opts.delegateLimit ?? config.delegateLimit, delegateOpenCap: opts.delegateOpenCap ?? config.delegateOpenCap,
    observerCap: opts.observerCap ?? config.hostedCaps?.watches.global,
    // The config's alone, no start option: HTTP's identity create reads the
    // config too, so the two would otherwise disagree (#347).
    aliasScopeCap: config.aliasScopeCap,
  };
}

function sqlitePath(store: Config["store"]): string {
  if (store.kind !== "sqlite") throw new Error("startServer: a Postgres store is opened with openRepo, then passed as `repo`");
  return store.path;
}

export function startServer(config: Config, opts: StartOptions = {}) {
  const humanReach = config.humanReach ?? "team";
  const { db: testDb, repo } = opts.repo
    // No SQLite handle behind an injected Repo: `db` (tests only) is undefined there, typed as SQLite's until C11c-d
    // move the tests that read it onto the Repo. The injected Repo's own attachment limits and session-end reach apply,
    // not config's: openRepo sets them from the same config.
    ? { db: undefined as unknown as ReturnType<typeof openDatabase>["db"], repo: opts.repo }
    : openDatabase(sqlitePath(config.store), { blobDir: config.blobDir, sessionEnd: sessionEndPort(humanReach), attachmentLimits: config.attachmentLimits, attachmentUserQuota: config.attachmentUserQuota, ...(opts.now ? { now: opts.now } : {}) });
  let slack: SlackBridge | undefined;
  // Dev sign-in mints tokens for any email; they must not outlive it (#805 F-04). A
  // server started without dev auth revokes them, so a re-enable doesn't revive them.
  // Queued first (#807 P3 A4), so it commits before any other startup write and any request.
  const devRevoked = config.devAuth ? Promise.resolve() : repo.write(async tx => {
    const revoked = await repo.sessions.revokeDev(tx);
    if (revoked > 0) writeAudit(repo, tx, "auth.dev_sessions_revoked", null, null, { count: revoked });
  });
  const application = createApplication(repo, { humanReach, slackRunning: () => slack?.running ?? false, ...startLimits(config, opts) });
  const { revalidate, disconnectUser, accessChanged, stopExpiry, wake } = application;

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
    repo, application, ...config.slack,
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
  const attachments = createMcpAttachments(repo, oauth, uploads, { trustedOrigin: new URL(config.publicUrl).origin, sessions: mcp.sessions });
  // The startup writes, each through the write queue in the order queued (#807 P3 A4): the dev-session revocation,
  // the leftover sessions' ends, OAuth's built-in client cutovers, and hosted's downtime credit and first sweep. The listener serves nothing until
  // all have settled; a failure then rejects it, and every request fails, so the caller (main.ts) exits on it.
  const ready: Promise<void> = settleAll([devRevoked, application.ready, oauth.ready, mcp.sessions.ready]).then(() => testPauseAsync("server:ready"));
  let started = false;
  ready.then(() => { started = true; }, () => {});

  // Every request the listener has taken and not yet answered, by its method and path (never the query: it can
  // carry a token). server.stop(true) closes their connections, but their handlers run on; stop() waits for them
  // before it closes the store, or one resumes from an await onto a closed database (#218).
  const inFlight = new Map<Promise<Response>, string>();
  const track = (what: string, response: Promise<Response>): Promise<Response> => {
    inFlight.set(response, what);
    void response.then(() => inFlight.delete(response), () => inFlight.delete(response));
    return response;
  };
  async function drain(ms: number): Promise<void> {
    if (inFlight.size === 0) return;
    const plural = (n: number) => `${n} request${n === 1 ? "" : "s"}`;
    console.error(`[grayboard] stopping: waiting for ${plural(inFlight.size)} in flight: ${[...inFlight.values()].join(", ")}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"expired">(resolve => { timer = setTimeout(() => resolve("expired"), ms); });
    try {
      while (inFlight.size) {
        if (await Promise.race([Promise.allSettled([...inFlight.keys()]), expired]) === "expired") {
          // Said here as well: main.ts redacts a failed stop's error, and a method and path carry no secret.
          const message = `stop: ${plural(inFlight.size)} never finished within ${ms} ms: ${[...inFlight.values()].join(", ")}`;
          console.error(`[grayboard] ${message}`);
          throw new Error(message);
        }
      }
    } finally { clearTimeout(timer); }
  }

  async function route(req: Request, caller: Caller): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    // A token already refused here gets the same 401 again, uncharged and
    // without a lookup, even from a limited address (#923).
    const replayed = authGate.replayRefused(req, url);
    if (replayed) return replayed;
    const limited = authGate.refuse(caller, path);
    if (limited) return limited;

    const response = await oauth.fetch(req, { key: caller.key, site: caller.site });
    if (response) return response;
    // The OAuth byte routes charge a refused bearer as /mcp does (#401).
    // The AS routes above authenticate clients by secret, not bearer, and
    // stay under the OAuth limiters alone.
    const attachmentResponse = attachments.fetch(req);
    if (attachmentResponse) return attachmentResponse.then(res => authGate.chargeRefusedToken(caller, req, path, res));
    if (path === "/mcp" || path === mcpPath) return mcp.fetch(req, caller.ip ?? "unknown").then(res => authGate.chargeRefusedToken(caller, req, path, res));

    // A sign-in costs a token up front, before its body is read. Only a
    // JSON body is accepted, uncharged otherwise: a cross-origin page can
    // post a form without a preflight, but not application/json.
    if (signInRoute(req.method, path, config)?.charged) {
      if (!isJsonRequest(req)) return Response.json({ code: "unsupported_media_type", message: "sign-in takes Content-Type: application/json" }, { status: 415 });
      authGate.charge(caller, req, path, "sign-in");
    }
    return handleHttp(req, repo, application.access, config, touches, wake, slack, { disconnectUser, accessChanged }, caller.ip, application.boardsChanged, url).then((res) => authGate.chargeRefusedToken(caller, req, path, res));
  }

  // Every value an O(1) getter (vision P13): no row count, no walk over sessions.
  const gauges = (): Gauges => {
    const used = mcp.capacityUsed;
    return {
      mcp_admissions: { help: "Hosted MCP admissions held, by capacity kind.", values: (["listen", "legacy", "post", "dormant"] as const).map(kind => ({ value: used[kind], labels: { kind } })) },
      mcp_exchanges_in_flight: { help: "Hosted MCP exchanges being handled.", values: [{ value: mcp.pendingExchanges }] },
      hosted_sessions_holding: { help: "Bound hosted sessions this process holds a name for.", values: [{ value: mcp.sessions.holderCount }] },
      delivery_leases: { help: "Open delivery leases.", values: [{ value: mcp.activeLeases }] },
      resource_watches: { help: "Open board resource watches.", values: [{ value: mcp.activeWatches }] },
      board_observers: { help: "Board observers server-wide (the resource watch global cap bounds them).", values: [{ value: application.observerCount }] },
      hosted_refusal_rows_lost: { help: "Refusal audit rows that failed to write.", values: [{ value: mcp.sessions.refusalRowsLost }] },
    };
  };

  const server = Bun.serve({
    hostname: opts.hostname,
    port: config.httpPort,
    idleTimeout: 75,
    // The largest body is an attachment upload (src/server/http.ts); the
    // margin covers a JSON request carrying a full message body.
    maxRequestBodySize: repo.attachmentLimits.file + MAX_BODY_BYTES,

    async fetch(req, server) {
      return track(`${req.method} ${new URL(req.url).pathname}`, (async () => {
        if (!started) await ready;
        // First, before anything reads the database (#240).
        const caller = authGate.caller(req, server.requestIP(req)?.address);
        // Every audit row this request writes carries where it came from (security audit F-19).
        return inRequest({ ip: caller.ip, ua: userAgent(req) }, () => route(req, caller));
      })());
    },

    // A route that throws something other than a refusal it maps itself. Bun's
    // default answer, without NODE_ENV=production, is a dev page carrying the
    // message (blob paths, errno text); the client gets a bare 500 instead.
    error(e) {
      console.error(`[grayboard] request failed: ${e.stack ?? e.message}`);
      return Response.json({ code: "internal", message: "internal error" }, { status: 500 });
    },
  });

  // Before the timers and the lag sampler: a metrics port in use fails startup with only the main listener to unwind.
  let metrics: ReturnType<typeof serveMetrics> | undefined;
  try { metrics = config.metricsAddr ? serveMetrics(config.metricsAddr, gauges) : undefined; }
  catch (e) { void server.stop(true); throw e; }

  const timers: ReturnType<typeof setInterval>[] = [];
  let stopRetention: (() => void) | undefined;
  let stopPromise: Promise<void> | undefined;
  if (opts.background !== false) {
    timers.push(setInterval(sweepLimits, 30_000), setInterval(() => {
      // A throw here would surface as an unhandled error every 30 s with no context; log it and let the next tick retry.
      // Async since #807 P3 A7u2: a rejection is logged the same way, never left unhandled (Bun exits on one).
      const failed = (e: unknown) => console.error(`[grayboard] revalidate failed: ${(e as Error).stack ?? e}`);
      try { revalidate().catch(failed); } catch (e) { failed(e); }
    }, 30_000));
    stopRetention = startRetentionJobs(repo, config, opts.retentionFirstDelayMs !== undefined ? { firstDelayMs: opts.retentionFirstDelayMs } : undefined, application.boardsChanged);
  }
  // The lag sampler runs with or without a listener: /healthz's lag gate reads it (#805).
  const stopLag = opts.background !== false ? startLagSampler() : undefined;

  return {
    server,
    application,
    mcp,
    oauth,
    repo,
    // Exposed for tests only (their spies read `db.inTransaction`): no server code holds the raw connection (#807 P1c-15c-2).
    db: testDb,
    // Exposed for tests: the bridge instance, to drive fatal stops directly.
    slack,
    // The auth re-check and limiter sweep, for tests that run without it.
    revalidate,
    sweepLimits,
    authGate,
    // Settles once the startup writes have committed (the listener waits for it); rejects when one failed.
    ready,
    // Settles once the Slack bridge is up, or has given up.
    slackReady: slackReady ?? Promise.resolve(),
    touches,
    // The metrics listener, when GRAYBOARD_METRICS_ADDR configured one.
    metrics,
    stop() {
      if (stopPromise) return stopPromise;
      slack?.stop();
      for (const t of timers) clearInterval(t);
      stopRetention?.();
      stopLag?.();
      void metrics?.stop(true);
      stopExpiry();
      touches.cancelAll();
      void server.stop(true);
      // After the startup writes settle: closing the database under a queued one would fail it mid-flight. Then the
      // requests still in flight, once hosted MCP and the attachment routes have refused theirs (#218).
      stopPromise = ready.catch(() => {}).then(() => Promise.allSettled([mcp.close(), attachments.close()])).then(async outcomes => {
        const drained = await drain(opts.stopDrainMs ?? STOP_DRAIN_MS).then(() => undefined, (error: unknown) => error);
        const failure = outcomes.find(outcome => outcome.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
        if (drained) throw drained;
      }).finally(async () => {
        // Awaited (#807 P3 C11a): a Postgres Repo's pool and LISTEN connection close over the network, and a caller
        // that exits once stop() settles would otherwise cut them off and leave its database in use. The Repo closes
        // even if oauth's close throws.
        try { oauth.close(); } finally { await repo.close(); }
      });
      return stopPromise;
    },
  };
}
