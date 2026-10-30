import { McpServer, createMcpHandler, fromJsonSchema, isLegacyRequest, WebStandardStreamableHTTPServerTransport, ProtocolError, ProtocolErrorCode, type ServerContext, type McpHttpHandler, type ServerEventBus } from "@modelcontextprotocol/server";
import { SubscriptionsListenRequestSchema, type CallToolResultSchema } from "@modelcontextprotocol/core";
import { z } from "zod";
import { AS_PARAM, boardTools } from "../core/tools.ts";
import { CoreError } from "../core/errors.ts";
import { DELEGATE_TOOL } from "../core/delegation.ts";
import { DM_ACK_TOOL, DM_INBOX_TOOL, DM_RETRACT_TOOL, MAX_INBOX_DAYS, PENDING_PARAM, ackResult } from "../shared/inbox.ts";
import { HUMAN_NAME, isValidIdentityName } from "../shared/addressing.ts";
import { ApplicationError, type Application, type ApplicationSession, type IdentityInfo } from "./application.ts";
import type { createOAuthServer, OAuthPrincipal } from "./oauth.ts";
import { createResources, parseBoardResourceUri } from "./resources.ts";
import { createDelivery } from "./delivery.ts";
import { createHostedSessions, deliveryDeclaration, hostedBoundInstruction, hostedUnboundInstruction, sessionContext, type Delivery, type SessionContext, type HostedSessions } from "./hosted.ts";
import { hostedRole, roleScopes, registerHostedResources, type HostedRole } from "./mcp-resources.ts";
import { forwardMcpStream, readMcpBody, type OwnedStream } from "./mcp-streams.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { hostedFailure } from "./hosted-diagnostics.ts";
import { diagnosticOrigin, failureDiagnostic, type FailureSource } from "./diagnostics.ts";
import { RateLimiter } from "./rate_limit.ts";
import { DEFAULT_MCP_LIMITS, type McpLimits } from "./config.ts";
import { writeAudit } from "./audit.ts";
import pkg from "../../package.json" with { type: "json" };

export const MCP_PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18"];
type CallToolResult = z.infer<typeof CallToolResultSchema>;
const id = z.number().int().positive();
const ids = z.array(id);
const attachmentIds = ids.describe("IDs uploaded through the authenticated attachment HTTP API as this identity; never local file paths.");
const text = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
// `delivery`: the native request's declared delivery (#429), for text only.
type Context = { request: Request; principal: OAuthPrincipal; sessionContext: SessionContext; delivery?: Delivery; stamp?: { ownership: number; generation: number }; role: HostedRole; session: ApplicationSession; info: IdentityInfo; finish(): void };
type Binding = { user: number; email: string; grant: string; role: HostedRole; identity: string };
type Legacy = { meta?: unknown; server: McpServer; transport: WebStandardStreamableHTTPServerTransport; binding: Binding; principal: OAuthPrincipal; release(): void; subscriptions: Map<string, string | null>; stream?: Live; posts: number; lastUsed: number; stopped: boolean };
type Live = { context: Context; uris: Map<string, string | null>; watches: string[]; stream?: OwnedStream; handler?: McpHttpHandler; legacy?: Legacy; stopped: boolean; hint(uri: string): void; stop(): void };

export function createHostedMcp(application: Application, oauth: Pick<ReturnType<typeof createOAuthServer>, "authenticate" | "isAuthorized" | "isGrantActive" | "issuer" | "resource">, opts: { trustedOrigin: string; now?: () => number; limits?: McpLimits }) {
  const now = opts.now ?? Date.now;
  const trustedOrigin = new URL(opts.trustedOrigin).origin;
  const permitsOrigin = (origin: string | null): boolean => {
    if (origin === null) return true;
    if (!/^https?:\/\/[^\s/@?#,\\]+$/.test(origin)) return false;
    try {
      const parsed = new URL(origin);
      const serialized = origin.replace(parsed.protocol === "https:" ? /:443$/ : /:80$/, "");
      return serialized === parsed.origin && parsed.origin === trustedOrigin;
    } catch { return false; }
  };
  let closed = false, posts = 0, busListeners = 0;
  const limits = opts.limits ?? DEFAULT_MCP_LIMITS;
  const capacity = { listen: new Map<number, number>(), legacy: new Map<number, number>(), post: new Map<number, number>() };
  const used = { listen: 0, legacy: 0, post: 0 };
  function reserve(kind: keyof McpLimits, principal: OAuthPrincipal): (() => void) | undefined {
    const counts = capacity[kind], user = principal.authed.user_id;
    const count = counts.get(user) ?? 0;
    const scope = used[kind] >= limits[kind].global ? "global" : count >= limits[kind].perUser ? "user" : undefined;
    if (scope) {
      writeAudit(application.repo, "hosted.capacity_refused", principal.authed.user_email, null, { kind, scope, client_id: principal.clientId });
      return undefined;
    }
    used[kind]++; counts.set(user, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true; used[kind]--;
      const remaining = counts.get(user)! - 1;
      if (remaining) counts.set(user, remaining); else counts.delete(user);
    };
  }
  function isolatedBus(): ServerEventBus {
    const listeners = new Set<Parameters<ServerEventBus["subscribe"]>[0]>();
    return {
      publish(event) { for (const listener of [...listeners]) listener(event); },
      subscribe(listener) {
        listeners.add(listener); busListeners++;
        return () => { if (listeners.delete(listener)) busListeners--; };
      },
    };
  }
  const contexts = new Set<Context>();
  const shutdown = new AbortController();
  const pendingRequests = new Set<Promise<void>>();
  const bodyReads = new Set<Promise<unknown>>();
  async function readBody(request: Request) {
    const reading = readMcpBody(request, shutdown.signal);
    bodyReads.add(reading);
    try { return await reading; } finally { bodyReads.delete(reading); }
  }
  const principals = new Map<ApplicationSession, OAuthPrincipal>();
  const legacySessions = new Map<string, Legacy>();
  const legacyAll = new Set<Legacy>();
  const lives = new Set<Live>();
  const forwarding = new Set<OwnedStream>();
  const streamContexts = new Map<OwnedStream, Context>();
  const closing = new Set<Promise<unknown>>();
  const track = (promise: Promise<unknown>) => {
    const settled = promise.catch(() => {}).finally(() => closing.delete(settled));
    closing.add(settled);
  };
  const resources = createResources(application, { isAuthorized: session => {
    const principal = principals.get(session) ?? exchanges.getStore()?.context?.principal;
    return !closed && !!principal && session.authed.user_id === principal.authed.user_id && oauth.isAuthorized(principal);
  } });
  const hosted = createHostedSessions(application, { now, isAuthorized: principal => oauth.isAuthorized(principal) });
  const delivery = createDelivery(hosted, { isAuthorized: principal => oauth.isAuthorized(principal), now });
  type Exchange = { request: Request; address: string; protocol: string; principal?: number; identity?: string; session?: string; tool?: string; logged?: boolean; failure?: ApplicationError; meta?: unknown; id?: string | number | null; refusal?: Response; context?: Context; legacy?: Legacy };
  const exchanges = new AsyncLocalStorage<Exchange>();
  const refusalLogs = new RateLimiter({ burst: 1, perSec: 0.1 }, { start() {}, end() {} }, now, 4096);
  const report = (error: unknown, source: FailureSource = "hosted-sdk", exchange = exchanges.getStore()) => {
    if (error instanceof ApplicationError || error instanceof CoreError || exchange?.failure || exchange?.refusal || exchange?.logged) return;
    if (exchange) exchange.logged = true;
    console.error(`[grayboard] hosted MCP failed: ${JSON.stringify({ principal: exchange?.principal, identity: exchange?.identity, session: exchange?.session, tool: exchange?.tool, protocol: exchange?.protocol, ...failureDiagnostic(source, error) })}`);
  };
  const logRefusal = (reason: string, exchange: Exchange) => {
    refusalLogs.sweep();
    if (refusalLogs.size >= 4096 || !refusalLogs.take(exchange.address).ok) return;
    console.error(`[grayboard] hosted MCP refused: ${JSON.stringify({ reason, address: exchange.address, origin: diagnosticOrigin(exchange.request.headers.get("Origin")), public_origin: trustedOrigin, principal: exchange.principal, identity: exchange.identity, protocol: exchange.protocol })}`);
  };
  const refuse = (response: Response): never => {
    const exchange = exchanges.getStore();
    if (exchange) exchange.refusal = response;
    throw new Error("unauthenticated");
  };
  function current(ctx?: ServerContext): Context {
    const exchange = exchanges.getStore();
    if (!exchange?.context || ctx && ctx.http?.req !== exchange.request) throw new Error("missing current MCP exchange");
    if (exchange.legacy?.stopped) throw new ApplicationError("unauthenticated", "MCP session is closed");
    if (ctx?.mcpReq.signal.aborted) throw new ApplicationError("unauthenticated", "request cancelled");
    return exchange.context;
  }
  function authorize(context: Context, signal?: AbortSignal) {
    if (closed || context.request.signal.aborted || signal?.aborted) throw new ApplicationError("unauthenticated", "request cancelled");
    if (!oauth.isAuthorized(context.principal)) throw new ApplicationError("unauthenticated", "unauthenticated");
    application.revalidateSession(context.session, true);
    if ("id" in context.sessionContext) {
      const row = hosted.row(context.sessionContext.id);
      const root = row && hosted.rootOf(row);
      if (root && root.lease_deadline !== null && root.lease_deadline <= now()) hosted.sweep();
    }
  }
  async function select(request: Request): Promise<Context> {
    const role = hostedRole(request);
    const principal = oauth.authenticate(request, roleScopes(role));
    if (principal instanceof Response) return refuse(principal);
    const meta = exchanges.getStore()?.meta;
    const routing = sessionContext(principal, meta);
    let delivery: Delivery | undefined;
    // Native requests only, before admission: the subscriber role ignores the declaration.
    try { delivery = role === "native" ? deliveryDeclaration(principal, meta) : undefined; }
    catch (error) {
      if (!(error instanceof ApplicationError)) throw error;
      const exchange = exchanges.getStore();
      if (exchange) logRefusal("delivery_declaration", exchange);
      return refuse(Response.json({ code: error.code, message: error.message }, { status: 400 }));
    }
    let selected: Awaited<ReturnType<typeof hosted.snapshot>>;
    try {
      application.admitHosted(principal.authed, "id" in routing ? routing.id : null);
      selected = await hosted.snapshot(principal, routing);
    } catch (error) {
      const exchange = exchanges.getStore();
      if (exchange && error instanceof ApplicationError && error.code === "rate_limited" && typeof error.extra.retry_after_ms === "number" && Number.isFinite(error.extra.retry_after_ms) && error.extra.retry_after_ms > 0) {
        const retryAfterMs = error.extra.retry_after_ms;
        exchange.refusal = Response.json({ jsonrpc: "2.0", id: exchange.id ?? null,
          error: { code: -32000, message: "too many connections; retry after the indicated delay", data: { code: "rate_limited", retry_after_ms: retryAfterMs } },
        }, { status: 429, headers: { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) } });
      }
      if (error instanceof ApplicationError && error.code === "rate_limited" && !exchange?.refusal) throw new ApplicationError("internal", "internal error");
      if (!closed && !request.signal.aborted && error instanceof ApplicationError && error.code === "unauthenticated") {
        const refusal = oauth.authenticate(request, roleScopes(role));
        if (refusal instanceof Response) refuse(refusal);
        refuse(Response.json({ code: "unauthenticated", message: "invalid or missing token" }, { status: 401 }));
      }
      report(error, "hosted-admission");
      throw error;
    }
    const context: Context = { request, principal, sessionContext: routing, delivery, role, ...selected, finish() {
      if (!contexts.delete(context)) return;
      principals.delete(context.session);
      application.close(context.session);
    } };
    contexts.add(context);
    principals.set(context.session, principal);
    const exchange = exchanges.getStore();
    if (exchange) { exchange.principal = principal.authed.user_id; exchange.identity = context.session.identityName; exchange.session = context.session.sessionId; }
    try {
      if (closed || request.signal.aborted) throw new Error("MCP request is closed");
      if (!oauth.isAuthorized(principal)) {
        const refusal = oauth.authenticate(request, roleScopes(role));
        if (refusal instanceof Response) refuse(refusal);
        throw new Error("unauthenticated");
      }
      return context;
    } catch (error) { context.finish(); throw error; }
  }
  function binding(context: Context): Binding {
    return { user: context.principal.authed.user_id, email: context.principal.authed.user_email, grant: context.principal.grantId, role: context.role, identity: context.session.identityFull };
  }
  function matches(a: Binding, b: Binding) { return a.user === b.user && a.email === b.email && a.grant === b.grant && a.role === b.role; }
  function bindingLive(context: Context) {
    if (!("id" in context.sessionContext)) return false;
    const row = hosted.row(context.sessionContext.id);
    if (!row) return false;
    const root = hosted.rootOf(row);
    return !!root.name && root.ownership_id === context.stamp?.ownership && root.bind_gen === context.stamp.generation;
  }
  const unlistenHosted = hosted.listen(() => {
    for (const live of [...lives]) {
      try { if (!bindingLive(live.context)) live.stop(); }
      catch (e) { hostedFailure("mcp.binding", e); live.stop(); }
    }
  });
  function watchable(context: Context, uri: string): string | null {
    authorize(context);
    if (!bindingLive(context)) throw new ApplicationError("unbound", "ownership changed; subscribe again with current session context");
    if (context.role === "subscriber") {
      const cap = context.request.headers.get("X-Grayboard-Lease");
      if (uri !== "grayboard://inbox" || !cap || !/^[A-Za-z0-9_-]{43}$/.test(cap) ||
          delivery.describe(context.principal, context.sessionContext, cap).identity.identity_full !== context.session.identityFull) {
        throw new ApplicationError("not_found", "resource not found");
      }
      return cap;
    }
    const board = parseBoardResourceUri(uri);
    if (!application.canReceiveBoard(context.session, board)) throw new ApplicationError("not_found", "resource not found");
    return null;
  }
  function valid(live: Live) {
    authorize(live.context);
    for (const [uri, cap] of live.uris) if (watchable(live.context, uri) !== cap) throw new ApplicationError("not_found", "resource not found");
  }
  function addWatch(live: Live, uri: string) {
    if (live.context.role === "native") live.watches.push(resources.watch(live.context.session, uri, {
      changed: () => live.hint(uri), closed: () => live.stop(),
    }));
  }
  function makeLive(context: Context, uris: Map<string, string | null>, handler?: McpHttpHandler, legacy?: Legacy): Live {
    const live: Live = { context, uris, watches: [], handler, legacy, stopped: false,
      hint(uri) {
        if (live.stopped || !live.uris.has(uri)) return;
        try {
          valid(live);
          if (handler) handler.notify.resourceUpdated(uri);
          else if (legacy) track(legacy.server.server.notification({ method: "notifications/resources/updated", params: { uri } }).catch(e => { hostedFailure("mcp.hint", e); live.stop(); }));
        } catch (e) { hostedFailure("mcp.hint", e); live.stop(); }
      },
      stop() {
        if (live.stopped) return;
        live.stopped = true;
        lives.delete(live);
        if (legacy && context.role === "native") {
          // A lost board must not poison every later GET on this protocol session.
          // Access rotation alone preserves registrations that remain visible.
          for (const uri of live.uris.keys()) {
            try {
              if (!application.canReceiveBoard(context.session, parseBoardResourceUri(uri))) legacy.subscriptions.delete(uri);
            } catch (e) { hostedFailure("mcp.stream", e); }
          }
        }
        if (legacy?.stream === live) legacy.stream = undefined;
        // The SDK closes the source first; application.close releases its observer set.
        if (live.stream) track(live.stream.stop());
        if (handler) track(handler.close());
        if (legacy) { try { legacy.transport.closeStandaloneSSEStream(); } catch (e) { hostedFailure("mcp.stream", e); } }
        try { context.finish(); } catch (e) { hostedFailure("mcp.stream", e); }
      },
    };
    lives.add(live);
    try { for (const uri of uris.keys()) addWatch(live, uri); }
    catch (error) { live.stop(); throw error; }
    return live;
  }
  function leaseHooks() {
    let capability: string | undefined;
    return {
      bind(cap: string) { capability = cap; },
      changed() {
        if (!capability) return;
        for (const live of [...lives]) if (live.uris.get("grayboard://inbox") === capability) live.hint("grayboard://inbox");
      },
      closed() {
        if (!capability) return;
        for (const live of [...lives]) if (live.uris.get("grayboard://inbox") === capability) live.stop();
        for (const legacy of legacyAll) if (legacy.subscriptions.get("grayboard://inbox") === capability) legacy.subscriptions.delete("grayboard://inbox");
      },
    };
  }
  function makeServer(context: Context, legacy?: Legacy) {
    const { role, info } = context;
    const server = new McpServer({ name: "grayboard", version: pkg.version }, {
      supportedProtocolVersions: legacy ? MCP_PROTOCOL_VERSIONS.slice(1) : MCP_PROTOCOL_VERSIONS,
      capabilities: { tools: { listChanged: false } },
      cacheHints: { "resources/list": { ttlMs: 0, cacheScope: "private" }, "resources/read": { ttlMs: 0, cacheScope: "private" } },
      instructions: role === "subscriber" ? undefined : context.session.readOnly ? hostedUnboundInstruction(info.candidates ?? []) : hostedBoundInstruction(info, context.delivery),
    });
    server.server.onerror = error => report(error);
    server.server.registerCapabilities({ resources: { subscribe: true } });
    registerHostedResources(server, {
      role, current, issuer: oauth.issuer, resource: oauth.resource, resources, delivery, hosted, leaseHooks,
      authorize() { authorize(current()); },
    });
    if (legacy) {
      const control = (uri: string, ctx: ServerContext, subscribe: boolean) => {
        const context = current(ctx);
        try {
          authorize(context, ctx.mcpReq.signal);
          if (subscribe) {
            if (!legacy.subscriptions.has(uri) && legacy.subscriptions.size >= 32) throw new ApplicationError("bad_request", "resource watch capacity reached");
            const cap = watchable(context, uri);
            const previous = sessionContext(context.principal, legacy.meta);
            if (legacy.subscriptions.size && (!("id" in previous) || !("id" in context.sessionContext) || previous.id !== context.sessionContext.id)) {
              throw new ApplicationError("bad_request", "legacy subscriptions require one session context per protocol session");
            }
            const stream = legacy.stream;
            if (stream) {
              let compatible: boolean;
              try {
                compatible = watchable(stream.context, uri) === cap && (!stream.uris.has(uri) || stream.uris.get(uri) === cap);
              } catch (error) {
                if (!(error instanceof ApplicationError) || error.code !== "unauthenticated" && error.code !== "not_found") throw error;
                compatible = false;
              }
              if (compatible) {
                // Publish registration only after observer installation succeeds.
                if (!stream.uris.has(uri)) { addWatch(stream, uri); stream.uris.set(uri, cap); }
              } else {
                // The current POST owns registration; an incompatible GET must recover
                // with fresh credentials rather than inherit this request's snapshot.
                stream.stop();
              }
            }
            legacy.meta = exchanges.getStore()?.meta;
            legacy.subscriptions.set(uri, cap);
          } else {
            watchable(context, uri);
            legacy.subscriptions.delete(uri);
            if (legacy.stream?.uris.has(uri)) {
              // Retire the stream and its watches; SDK recovery gets the remaining registrations.
              legacy.stream.stop();
            }
          }
          return {};
        } catch (error) {
          const expected = error instanceof ApplicationError && error.code !== "internal" || error instanceof CoreError;
          throw new ProtocolError(expected ? ProtocolErrorCode.InvalidParams : ProtocolErrorCode.InternalError, expected ? "resource not found" : "internal error");
        }
      };
      server.server.setRequestHandler("resources/subscribe", (req, ctx) => control(req.params.uri, ctx, true));
      server.server.setRequestHandler("resources/unsubscribe", (req, ctx) => control(req.params.uri, ctx, false));
    }
    if (role !== "subscriber") registerNativeTools(server, application, hosted, ctx => { const context = current(ctx); authorize(context, ctx.mcpReq.signal); return context; }, (error, tool) => { const exchange = exchanges.getStore(); if (exchange) exchange.tool = tool; report(error, "hosted-tool"); }, code => { const exchange = exchanges.getStore(); if (exchange) logRefusal(code, exchange); });
    return server;
  }
  const modernFactory = async () => {
    try {
    const exchange = exchanges.getStore()!;
    if (exchange.context) {
      if (closed || exchange.request.signal.aborted) throw new Error("MCP request is closed");
      const principal = oauth.authenticate(exchange.request, roleScopes(exchange.context.role));
      if (principal instanceof Response) refuse(principal);
    }
    const context = exchange.context ??= await select(exchange.request);
    return makeServer(context);
    } catch (error) {
      const exchange = exchanges.getStore();
      if (error instanceof ApplicationError && exchange) exchange.failure = error;
      report(error, "hosted-factory");
      throw new Error("internal error");
    }
  };
  const modern = createMcpHandler(modernFactory, { legacy: "reject", keepAliveMs: 5000, onerror: error => report(error) });
  function retire(legacy: Legacy, failed = false) {
    if (legacy.stopped) return;
    let reported = false;
    const report = () => { if (!reported) { reported = true; hostedFailure("mcp.legacy"); } };
    if (failed) report();
    legacy.stopped = true;
    legacy.release();
    legacyAll.delete(legacy);
    for (const [id, value] of legacySessions) if (value === legacy) legacySessions.delete(id);
    if (legacy.stream?.stream) streamContexts.delete(legacy.stream.stream);
    try { legacy.stream?.stop(); } catch { report(); }
    legacy.subscriptions.clear();
    track(Promise.resolve().then(() => legacy.server.close()).catch(report));
    track(Promise.resolve().then(() => legacy.transport.close()).catch(report));
  }
  const timer = setInterval(() => {
    for (const legacy of [...legacyAll]) {
      try {
        if (!oauth.isAuthorized(legacy.principal) || !legacy.stream && legacy.posts === 0 && now() - legacy.lastUsed >= 60_000) retire(legacy);
      } catch { retire(legacy, true); }
    }
    for (const live of [...lives]) { try { valid(live); } catch (e) { hostedFailure("mcp.stream", e); live.stop(); } }
    for (const [stream, context] of streamContexts) { try { authorize(context); } catch (e) { hostedFailure("mcp.stream", e); track(stream.stop()); } }
  }, 1000);
  timer.unref();
  function wrap(response: Response, context: Context | undefined, live?: Live, done?: () => void) {
    response.headers.set("Cache-Control", "private, no-store");
    if (!response.body || !response.headers.get("Content-Type")?.includes("text/event-stream") || !context) {
      live?.stop(); context?.finish(); done?.(); return response;
    }
    const wrapped = forwardMcpStream(response, context.request.signal, () => {
      forwarding.delete(wrapped.stream);
      streamContexts.delete(wrapped.stream);
      live?.stop(); context.finish(); done?.();
    });
    forwarding.add(wrapped.stream);
    streamContexts.set(wrapped.stream, context);
    if (live) { live.stream = wrapped.stream; if (live.stopped) track(wrapped.stream.stop()); }
    return wrapped.response;
  }
  return {
    sessions: hosted,
    delivery,
    get activeContexts() { return contexts.size; },
    get activeLeases() { return delivery.activeLeaseCount; },
    get activeResourceContexts() { return principals.size; },
    get activeStreams() { return forwarding.size; },
    get activeWatches() { return resources.activeWatchCount; },
    get activeBusListeners() { return busListeners; },
    get activeListens() { return [...lives].filter(l => !l.legacy).length; },
    get activeGetStreams() { return [...lives].filter(l => !!l.legacy).length; },
    get activeInboxListeners() { return [...lives].filter(l => l.uris.has("grayboard://inbox")).length; },
    get activeLegacySessions() { return legacyAll.size; },
    get activePosts() { return posts; },
    async fetch(original: Request, address = "unknown"): Promise<Response> {
      const boundary: Exchange = { request: original, address, protocol: MCP_PROTOCOL_VERSIONS.includes(original.headers.get("Mcp-Protocol-Version") ?? "") ? original.headers.get("Mcp-Protocol-Version")! : "unspecified" };
      if (closed) return new Response("MCP endpoint is closed", { status: 503 });
      if (!permitsOrigin(original.headers.get("Origin"))) { logRefusal("origin", boundary); return Response.json({ code: "forbidden", message: "invalid origin" }, { status: 403 }); }
      let role: HostedRole;
      try { role = hostedRole(original); } catch { return Response.json({ code: "bad_request", message: "unknown X-Grayboard-Client role" }, { status: 400 }); }
      const post = original.method === "POST";
      let principal: OAuthPrincipal;
      let postReservation: (() => void) | undefined;
      try {
        const authenticated = oauth.authenticate(original, roleScopes(role));
        if (authenticated instanceof Response) return authenticated;
        principal = authenticated;
        boundary.principal = principal.authed.user_id;
        postReservation = post ? reserve("post", principal) : undefined;
      } catch (error) { report(error, "hosted-fetch", boundary); return Response.json({ code: "internal", message: "internal error" }, { status: 500 }); }
      if (post && !postReservation) return new Response("MCP request capacity reached", { status: 429 });
      let released = false, legacyPost: Legacy | undefined;
      const releasePost = () => {
        if (post && !released) { released = true; posts--; postReservation!(); }
        if (legacyPost) { legacyPost.posts--; legacyPost.lastUsed = now(); legacyPost = undefined; }
      };
      if (post) posts++;
      if (pendingRequests.size >= 512) { releasePost(); return new Response("MCP exchange capacity reached", { status: 429 }); }
      let finishRequest!: () => void;
      const pendingRequest = new Promise<void>(resolve => { finishRequest = resolve; });
      pendingRequests.add(pendingRequest);
      try {
        const body = post ? await readBody(original) : { request: original, parsedBody: undefined };
        if (body instanceof Response) { releasePost(); return body; }
        const req = body.request;
        const parsed = body.parsedBody as { id?: string | number | null; params?: { _meta?: unknown } } | undefined;
        return await exchanges.run({ ...boundary, request: req, meta: parsed?.params?._meta, id: parsed?.id }, async () => {
          const exchange = exchanges.getStore()!;
          let live: Live | undefined;
          let ownHandler: McpHttpHandler | undefined;
          let newLegacy: Legacy | undefined;
          let releaseListen: (() => void) | undefined;
          try {
            let response: Response;
            const modernMethod = req.method !== "POST" && (!req.headers.has("Mcp-Session-Id") || req.headers.get("Mcp-Protocol-Version") === "2026-07-28");
            // The SDK predicate clones unparsed POSTs. Invalid JSON has no envelope;
            // send its bounded rewind directly to the native SDK parser instead.
            const legacyRequest = !modernMethod && (req.method === "POST" && body.parsedBody === undefined || await isLegacyRequest(req, body.parsedBody));
            if (!legacyRequest) {
              const listen = SubscriptionsListenRequestSchema.safeParse(body.parsedBody);
              if (listen.success) {
                releaseListen = reserve("listen", principal);
                if (!releaseListen) { releasePost(); return new Response("MCP listen capacity reached", { status: 429 }); }
                const context = exchange.context = await select(req);
                const uris = listen.data.params.notifications.resourceSubscriptions ?? [];
                if (uris.length > 32) throw new ApplicationError("bad_request", "resource watch capacity reached");
                const authorized = new Map(uris.map(uri => [uri, watchable(context, uri)]));
                ownHandler = createMcpHandler(modernFactory, { legacy: "reject", keepAliveMs: 5000, bus: isolatedBus(), onerror: error => report(error) });
                live = makeLive(context, authorized, ownHandler);
                response = await ownHandler.fetch(req, { parsedBody: body.parsedBody });
              } else {
                exchange.context = await select(req);
                response = await modern.fetch(req, { parsedBody: body.parsedBody });
              }
            } else {
              const sid = req.headers.get("Mcp-Session-Id");
              let legacy = sid ? legacySessions.get(sid) : undefined;
              if (sid && !legacy) { releasePost(); return new Response("unknown MCP session", { status: 404 }); }
              if (req.method !== "POST" && legacy) exchange.meta = legacy.meta;
              const context = exchange.context = await select(req);
              if (legacy && !matches(legacy.binding, binding(context))) { context.finish(); releasePost(); return new Response("MCP session binding mismatch", { status: 403 }); }
              if (!legacy) {
                if (req.method !== "POST") { context.finish(); releasePost(); return new Response("missing MCP session", { status: 400 }); }
                const release = reserve("legacy", principal);
                if (!release) { context.finish(); releasePost(); return new Response("MCP session capacity reached", { status: 429 }); }
                legacy = { meta: exchange.meta, binding: binding(context), principal, release, subscriptions: new Map(), posts: 0, lastUsed: now(), stopped: false } as Legacy;
                const created = legacy;
                newLegacy = legacy;
                legacy.transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), keepAliveMs: 5000,
                  onsessioninitialized(id) { legacySessions.set(id, created); }, onsessionclosed() { retire(created); } });
                legacy.server = makeServer(context, legacy);
                legacyAll.add(legacy);
                await legacy.server.connect(legacy.transport);
                if (closed || req.signal.aborted) throw new ApplicationError("unauthenticated", "request cancelled");
              }
              exchange.legacy = legacy;
              legacy.principal = principal;
              legacy.lastUsed = now();
              if (req.method === "GET") {
                if (legacy.stream) { context.finish(); releasePost(); return new Response("MCP GET already active", { status: 409 }); }
                const uris = new Map<string, string | null>();
                for (const [uri, cap] of legacy.subscriptions) {
                  if (watchable(context, uri) !== cap) throw new ApplicationError("not_found", "resource not found");
                  uris.set(uri, cap);
                }
                live = makeLive(context, uris, undefined, legacy);
                legacy.stream = live;
              }
              if (post) { legacyPost = legacy; legacy.posts++; }
              response = await legacy.transport.handleRequest(req, { parsedBody: body.parsedBody });
              if (!sid && !legacy.transport.sessionId) retire(legacy);
            }
            const refusal = exchange.refusal;
            if (refusal && !closed && !req.signal.aborted) {
              await response.body?.cancel(); live?.stop(); exchange.context?.finish();
              releaseListen?.();
              releasePost(); return refusal;
            }
            const done = () => { releaseListen?.(); releasePost(); };
            return wrap(response, exchange.context, live, done);
          } catch (error) {
            report(error, "hosted-fetch");
            if (newLegacy) retire(newLegacy);
            live?.stop();
            if (ownHandler) await ownHandler.close();
            exchange.context?.finish();
            releaseListen?.();
            releasePost();
            if (exchange.refusal && !closed && !req.signal.aborted) return exchange.refusal;
            if (error instanceof ApplicationError && error.code !== "internal" || error instanceof CoreError) {
              const badRequest = error instanceof ApplicationError && error.code === "bad_request";
              return Response.json({ code: badRequest ? "bad_request" : "not_found", message: badRequest ? "invalid resource request" : "resource not found" }, { status: badRequest ? 400 : 404 });
            }
            return Response.json({ code: "internal", message: "internal error" }, { status: 500 });
          }
        });
      } catch (error) { report(error, "hosted-fetch", boundary); releasePost(); return Response.json({ code: "internal", message: "internal error" }, { status: 500 }); }
      finally { pendingRequests.delete(pendingRequest); finishRequest(); }
    },
    async close() {
      closed = true;
      clearInterval(timer);
      shutdown.abort();
      for (const live of [...lives]) live.stop();
      for (const legacy of [...legacyAll]) retire(legacy);
      // A failed drain or lease detach mustn't skip the final heartbeat or leave
      // the hosted timer running against a closed database (#423).
      try { await Promise.all([...forwarding].map(stream => stream.stop())); }
      finally { try { unlistenHosted(); resources.close(); delivery.close(); } finally { hosted.close(); } }
      await modern.close();
      await Promise.allSettled([...bodyReads]);
      while (closing.size) await Promise.all([...closing]);
      for (const context of [...contexts]) context.finish();
    },
  };
}

function registerNativeTools(server: McpServer, application: Application, hosted: HostedSessions, current: (ctx: ServerContext) => Context, report: (error: unknown, tool: string) => void, refuse: (code: string) => void) {
  const run = async (ctx: ServerContext, tool: string, call: (session: ApplicationSession) => unknown): Promise<CallToolResult> => {
    try {
      const context = current(ctx);
      return text(await hosted.run(context.principal, context.sessionContext, tool, call) ?? "ok");
    }
    catch (e) {
      report(e, tool);
      const message = e instanceof ApplicationError && e.code !== "internal" || e instanceof CoreError ? e.message : "internal error";
      return { ...text(`error: ${message}`), isError: true };
    }
  };
  server.registerTool("whoami", { description: "This request's current session binding, or unbound candidates.", inputSchema: z.strictObject({}) }, async (_, ctx) => {
    const context = current(ctx);
    return text(await hosted.whoami(context.principal, context.sessionContext));
  });
  server.registerTool("bind", { description: "Take or change this session's name; unknown names require create:true.", inputSchema: z.strictObject({ name: z.string().max(32), create: z.boolean().optional(), where: z.string().max(1024).optional() }) }, async (args, ctx) => {
    try { const context = current(ctx); return await hosted.bind(context.principal, context.sessionContext, args, context.delivery); }
    catch (e) { report(e, "bind"); if (e instanceof ApplicationError && ["identity_unknown", "identity_in_use", "bad_request"].includes(e.code)) refuse(e.code); return { ...text({ code: e instanceof ApplicationError ? e.code : "internal", message: e instanceof ApplicationError ? e.message : "internal error", ...(e instanceof ApplicationError ? e.extra : {}) }), isError: true }; }
  });
  for (const tool of boardTools({ teams: true })) {
    const properties = { ...tool.inputSchema.properties };
    if (tool.name === "board_post") { delete properties.attachments; properties.attachment_ids = z.toJSONSchema(attachmentIds); }
    server.registerTool(tool.name, {
      description: tool.name === "board_post" ? tool.description.replace("attachments?", "attachment_ids?") : tool.description,
      ...(tool._meta ? { _meta: tool._meta } : {}),
      inputSchema: fromJsonSchema<Record<string, unknown>>({ ...tool.inputSchema, properties, additionalProperties: false } as Parameters<typeof fromJsonSchema>[0]),
    }, (args, ctx) => run(ctx, tool.name, session => application.call(session, tool.name, args)));
  }
  server.registerTool("dm_send", {
    description: "Message one peer by exact handle or bare identity name. Offline messages remain queued. Attachments are uploaded IDs, not paths.",
    inputSchema: z.strictObject({ to: z.string(), body: z.string(), parent_id: id.optional(), pending: z.boolean().describe(PENDING_PARAM.description).optional(), attachment_ids: attachmentIds.optional(), as: z.string().describe(AS_PARAM.description).optional() }),
  }, (a, ctx) => run(ctx, "dm_send", session => application.send(session, a.to, a.body, a)));
  server.registerTool(DELEGATE_TOOL.name, {
    description: DELEGATE_TOOL.description,
    inputSchema: fromJsonSchema<{ persona: string; task: string; context?: string; to?: string }>({ ...DELEGATE_TOOL.inputSchema, additionalProperties: false } as Parameters<typeof fromJsonSchema>[0]),
  }, (a, ctx) => run(ctx, "delegate", session => application.delegate(session, a)));
  server.registerTool("dm_history", {
    description: "Recent direct messages, oldest first; optionally filter by peer or page before an ID.",
    inputSchema: z.strictObject({ peer: z.string().optional(), limit: z.number().optional(), before_id: id.optional() }),
  }, (a, ctx) => run(ctx, "dm_history", session => application.history(session, a)));
  server.registerTool("dm_thread", { description: "A whole direct-message thread you participate in.", inputSchema: z.strictObject({ thread: id }) },
    (a, ctx) => run(ctx, "dm_thread", session => application.thread(session, a.thread)));
  server.registerTool(DM_INBOX_TOOL.name, { description: DM_INBOX_TOOL.description, _meta: DM_INBOX_TOOL._meta, inputSchema: z.strictObject({ days: z.number().positive().max(MAX_INBOX_DAYS).optional() }) },
    (a, ctx) => run(ctx, "dm_inbox", session => application.inbox(session, a.days)));
  server.registerTool(DM_ACK_TOOL.name, {
    description: DM_ACK_TOOL.description, _meta: DM_ACK_TOOL._meta, inputSchema: z.strictObject({ message_id: z.union([id, ids.min(1)]) }),
  }, async (a, ctx) => {
    const acked: number[] = [], missing: number[] = [];
    const result = await run(ctx, "dm_ack", session => {
      for (const n of new Set(Array.isArray(a.message_id) ? a.message_id : [a.message_id])) {
        try { application.acknowledgeDm(session, n); acked.push(n); } catch (e) {
          if (!(e instanceof ApplicationError) || e.code !== "not_found") throw e;
          missing.push(n);
        }
      }
      return ackResult(acked, missing).text;
    });
    return { ...result, ...(missing.length && !acked.length ? { isError: true } : {}) };
  });
  server.registerTool(DM_RETRACT_TOOL.name, { description: DM_RETRACT_TOOL.description, inputSchema: z.strictObject({ message_id: id }) },
    (a, ctx) => run(ctx, "dm_retract", session => application.retract(session, a.message_id)));
}
