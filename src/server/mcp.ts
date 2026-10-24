import { McpServer, createMcpHandler, fromJsonSchema, isLegacyRequest, WebStandardStreamableHTTPServerTransport, ProtocolError, ProtocolErrorCode, type ServerContext, type McpHttpHandler, type ServerEventBus } from "@modelcontextprotocol/server";
import { SubscriptionsListenRequestSchema, type CallToolResultSchema } from "@modelcontextprotocol/core";
import { z } from "zod";
import { boardTools, BOARD_INSTRUCTIONS, ownHumanInstruction } from "../core/tools.ts";
import { CoreError } from "../core/errors.ts";
import { DM_ACK_TOOL, DM_INBOX_TOOL, DM_RETRACT_TOOL, MAX_INBOX_DAYS, PENDING_PARAM, ackResult } from "../shared/inbox.ts";
import { HUMAN_NAME, isValidIdentityName } from "../shared/addressing.ts";
import { ApplicationError, type Application, type ApplicationSession, type IdentityInfo } from "./application.ts";
import type { createOAuthServer, OAuthPrincipal } from "./oauth.ts";
import { createResources, parseBoardResourceUri } from "./resources.ts";
import { createDelivery } from "./delivery.ts";
import { hostedRole, roleScopes, registerHostedResources, type HostedRole } from "./mcp-resources.ts";
import { forwardMcpStream, readMcpBody, type OwnedStream } from "./mcp-streams.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import pkg from "../../package.json" with { type: "json" };

export const MCP_PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18"];
type CallToolResult = z.infer<typeof CallToolResultSchema>;
const id = z.number().int().positive();
const ids = z.array(id);
const attachmentIds = ids.describe("IDs uploaded through the authenticated attachment HTTP API as this identity; never local file paths.");
const text = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
type Context = { request: Request; principal: OAuthPrincipal; role: HostedRole; session: ApplicationSession; info: IdentityInfo; finish(): void };
type Binding = { user: number; email: string; grant: string; role: HostedRole; identity: string };
type Legacy = { server: McpServer; transport: WebStandardStreamableHTTPServerTransport; binding: Binding; subscriptions: Map<string, string | null>; stream?: Live; posts: number; lastUsed: number; stopped: boolean };
type Live = { context: Context; uris: Map<string, string | null>; watches: string[]; stream?: OwnedStream; handler?: McpHttpHandler; legacy?: Legacy; stopped: boolean; hint(uri: string): void; stop(): void };

export function createHostedMcp(application: Application, oauth: Pick<ReturnType<typeof createOAuthServer>, "authenticate" | "isAuthorized" | "isGrantActive" | "issuer" | "resource">, opts: { trustedOrigin: string; now?: () => number }) {
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
  let closed = false, posts = 0, modernReservations = 0, busListeners = 0;
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
    const principal = principals.get(session);
    return !closed && !!principal && oauth.isAuthorized(principal);
  } });
  const delivery = createDelivery(application, { isAuthorized: principal => oauth.isGrantActive(principal.grantId) });
  const exchanges = new AsyncLocalStorage<{ request: Request; refusal?: Response; context?: Context; legacy?: Legacy }>();
  const refuse = (response: Response): never => {
    const exchange = exchanges.getStore();
    if (exchange) exchange.refusal = response;
    throw new Error("unauthenticated");
  };
  function current(ctx?: ServerContext): Context {
    const exchange = exchanges.getStore();
    if (!exchange?.context || ctx && ctx.http?.req !== exchange.request) throw new Error("missing current MCP exchange");
    if (ctx?.mcpReq.signal.aborted) throw new ApplicationError("unauthenticated", "request cancelled");
    return exchange.context;
  }
  function authorize(context: Context, signal?: AbortSignal) {
    if (closed || context.request.signal.aborted || signal?.aborted) throw new ApplicationError("unauthenticated", "request cancelled");
    if (!oauth.isAuthorized(context.principal)) throw new ApplicationError("unauthenticated", "unauthenticated");
    application.revalidateSession(context.session);
  }
  async function select(request: Request): Promise<Context> {
    const role = hostedRole(request);
    const principal = oauth.authenticate(request, roleScopes(role));
    if (principal instanceof Response) return refuse(principal);
    const selected = await application.selectIdentity(principal.authed, request.headers.get("X-Grayboard-Identity")!,
      { deliver() {}, probe: async () => false, closed() {} },
      { push: false, where: request.headers.get("X-Grayboard-Where") ?? undefined, alive: () => !closed && !request.signal.aborted });
    const context: Context = { request, principal, role, ...selected, finish() {
      if (!contexts.delete(context)) return;
      principals.delete(context.session);
      application.close(context.session);
    } };
    contexts.add(context);
    principals.set(context.session, principal);
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
  function matches(a: Binding, b: Binding) { return a.user === b.user && a.email === b.email && a.grant === b.grant && a.role === b.role && a.identity === b.identity; }
  function watchable(context: Context, uri: string): string | null {
    authorize(context);
    if (context.role === "subscriber") {
      const cap = context.request.headers.get("X-Grayboard-Lease");
      if (uri !== "grayboard://inbox" || !cap || !/^[A-Za-z0-9_-]{43}$/.test(cap) ||
          delivery.describe(context.principal, cap).identity.identity_full !== context.session.identityFull) {
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
          else if (legacy) track(legacy.server.server.notification({ method: "notifications/resources/updated", params: { uri } }).catch(() => live.stop()));
        } catch { live.stop(); }
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
            } catch {}
          }
        }
        if (legacy?.stream === live) legacy.stream = undefined;
        // The SDK closes the source first; application.close releases its observer set.
        if (live.stream) track(live.stream.stop());
        if (handler) track(handler.close());
        if (legacy) { try { legacy.transport.closeStandaloneSSEStream(); } catch {} }
        try { context.finish(); } catch {}
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
      instructions: role === "subscriber" ? undefined : [
        `You are "${info.identity_full}" on grayboard. Poll dm_inbox and board_list for pending work.`,
        ...BOARD_INSTRUCTIONS.slice(1),
        ...(info.teams.length ? ["Team boards are private to their members: don't repeat their content where non-members can read it unless your user asks."] : []),
        ...(info.human.linked ? ownHumanInstruction(info.human.handle) : []), ...(info.notices ?? []),
      ].join(" "),
    });
    server.server.registerCapabilities({ resources: { subscribe: true } });
    registerHostedResources(server, {
      role, current, issuer: oauth.issuer, resource: oauth.resource, resources, delivery, leaseHooks,
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
    if (role !== "subscriber") registerNativeTools(server, application, ctx => { const context = current(ctx); authorize(context, ctx.mcpReq.signal); return context.session; });
    return server;
  }
  const modernFactory = async () => {
    const exchange = exchanges.getStore()!;
    if (exchange.context) {
      if (closed || exchange.request.signal.aborted) throw new Error("MCP request is closed");
      const principal = oauth.authenticate(exchange.request, roleScopes(exchange.context.role));
      if (principal instanceof Response) refuse(principal);
    }
    const context = exchange.context ??= await select(exchange.request);
    return makeServer(context);
  };
  const modern = createMcpHandler(modernFactory, { legacy: "reject", keepAliveMs: 5000 });
  function retire(legacy: Legacy) {
    if (legacy.stopped) return;
    legacy.stopped = true;
    legacyAll.delete(legacy);
    for (const [id, value] of legacySessions) if (value === legacy) legacySessions.delete(id);
    legacy.stream?.stop();
    legacy.subscriptions.clear();
    track(legacy.server.close());
    track(legacy.transport.close());
  }
  const timer = setInterval(() => {
    for (const live of [...lives]) { try { valid(live); } catch { live.stop(); } }
    for (const [stream, context] of streamContexts) { try { authorize(context); } catch { track(stream.stop()); } }
    for (const legacy of [...legacyAll]) if (!legacy.stream && legacy.posts === 0 && now() - legacy.lastUsed >= 60_000) retire(legacy);
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
    async fetch(original: Request): Promise<Response> {
      if (closed) return new Response("MCP endpoint is closed", { status: 503 });
      if (!permitsOrigin(original.headers.get("Origin"))) return Response.json({ code: "forbidden", message: "invalid origin" }, { status: 403 });
      let role: HostedRole;
      try { role = hostedRole(original); } catch { return Response.json({ code: "bad_request", message: "unknown X-Grayboard-Client role" }, { status: 400 }); }
      const post = original.method === "POST";
      let released = false, legacyPost: Legacy | undefined;
      const releasePost = () => {
        if (post && !released) { released = true; posts--; }
        if (legacyPost) { legacyPost.posts--; legacyPost.lastUsed = now(); legacyPost = undefined; }
      };
      if (post && posts >= 256) return new Response("MCP request capacity reached", { status: 429 });
      if (pendingRequests.size >= 512) return new Response("MCP exchange capacity reached", { status: 429 });
      if (post) posts++;
      let finishRequest!: () => void;
      const pendingRequest = new Promise<void>(resolve => { finishRequest = resolve; });
      pendingRequests.add(pendingRequest);
      try {
        const principal = oauth.authenticate(original, roleScopes(role));
        if (principal instanceof Response) { releasePost(); return principal; }
        const name = original.headers.get("X-Grayboard-Identity");
        if (!name || !isValidIdentityName(name.toLowerCase()) || name.toLowerCase() === HUMAN_NAME) {
          releasePost(); return Response.json({ code: "bad_request", message: "X-Grayboard-Identity must name your agent identity, not a full handle or human" }, { status: 400 });
        }
        const body = post ? await readBody(original) : { request: original, parsedBody: undefined };
        if (body instanceof Response) { releasePost(); return body; }
        const req = body.request;
        return await exchanges.run({ request: req }, async () => {
          const exchange = exchanges.getStore()!;
          let live: Live | undefined;
          let ownHandler: McpHttpHandler | undefined;
          let newLegacy: Legacy | undefined;
          let reserved = false;
          try {
            let response: Response;
            const modernMethod = req.method !== "POST" && (!req.headers.has("Mcp-Session-Id") || req.headers.get("Mcp-Protocol-Version") === "2026-07-28");
            // The SDK predicate clones unparsed POSTs. Invalid JSON has no envelope;
            // send its bounded rewind directly to the native SDK parser instead.
            const legacyRequest = !modernMethod && (req.method === "POST" && body.parsedBody === undefined || await isLegacyRequest(req, body.parsedBody));
            if (!legacyRequest) {
              const listen = SubscriptionsListenRequestSchema.safeParse(body.parsedBody);
              if (listen.success) {
                if (modernReservations >= 128) { releasePost(); return new Response("MCP listen capacity reached", { status: 429 }); }
                modernReservations++; reserved = true;
                const context = exchange.context = await select(req);
                const uris = listen.data.params.notifications.resourceSubscriptions ?? [];
                if (uris.length > 32) throw new ApplicationError("bad_request", "resource watch capacity reached");
                const authorized = new Map(uris.map(uri => [uri, watchable(context, uri)]));
                ownHandler = createMcpHandler(modernFactory, { legacy: "reject", keepAliveMs: 5000, bus: isolatedBus() });
                live = makeLive(context, authorized, ownHandler);
                response = await ownHandler.fetch(req, { parsedBody: body.parsedBody });
              } else response = await modern.fetch(req, { parsedBody: body.parsedBody });
            } else {
              const sid = req.headers.get("Mcp-Session-Id");
              let legacy = sid ? legacySessions.get(sid) : undefined;
              if (sid && !legacy) { releasePost(); return new Response("unknown MCP session", { status: 404 }); }
              const requestedBinding: Binding = { user: principal.authed.user_id, email: principal.authed.user_email, grant: principal.grantId, role, identity: `${principal.authed.user_email}/${name.toLowerCase()}` };
              if (legacy && !matches(legacy.binding, requestedBinding)) { releasePost(); return new Response("MCP session binding mismatch", { status: 403 }); }
              const context = exchange.context = await select(req);
              if (legacy && !matches(legacy.binding, binding(context))) { context.finish(); releasePost(); return new Response("MCP session binding mismatch", { status: 403 }); }
              if (!legacy) {
                if (req.method !== "POST") { context.finish(); releasePost(); return new Response("missing MCP session", { status: 400 }); }
                if (legacyAll.size >= 256) { context.finish(); releasePost(); return new Response("MCP session capacity reached", { status: 429 }); }
                legacy = { binding: binding(context), subscriptions: new Map(), posts: 0, lastUsed: now(), stopped: false } as Legacy;
                const created = legacy;
                legacy.transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), keepAliveMs: 5000,
                  onsessioninitialized(id) { legacySessions.set(id, created); }, onsessionclosed() { retire(created); } });
                legacy.server = makeServer(context, legacy);
                legacyAll.add(legacy);
                newLegacy = legacy;
                await legacy.server.connect(legacy.transport);
                if (closed || req.signal.aborted) throw new ApplicationError("unauthenticated", "request cancelled");
              }
              exchange.legacy = legacy;
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
              if (reserved) { reserved = false; modernReservations--; }
              releasePost(); return refusal;
            }
            const done = () => { if (reserved) { reserved = false; modernReservations--; } releasePost(); };
            return wrap(response, exchange.context, live, done);
          } catch (error) {
            if (newLegacy) retire(newLegacy);
            live?.stop();
            if (ownHandler) await ownHandler.close();
            exchange.context?.finish();
            if (reserved) { reserved = false; modernReservations--; }
            releasePost();
            if (exchange.refusal && !closed && !req.signal.aborted) return exchange.refusal;
            if (error instanceof ApplicationError && error.code !== "internal" || error instanceof CoreError) {
              const badRequest = error instanceof ApplicationError && error.code === "bad_request";
              return Response.json({ code: badRequest ? "bad_request" : "not_found", message: badRequest ? "invalid resource request" : "resource not found" }, { status: badRequest ? 400 : 404 });
            }
            return Response.json({ code: "internal", message: "internal error" }, { status: 500 });
          }
        });
      } catch { releasePost(); return Response.json({ code: "internal", message: "internal error" }, { status: 500 }); }
      finally { pendingRequests.delete(pendingRequest); finishRequest(); }
    },
    async close() {
      closed = true;
      clearInterval(timer);
      shutdown.abort();
      for (const live of [...lives]) live.stop();
      for (const legacy of [...legacyAll]) retire(legacy);
      await Promise.all([...forwarding].map(stream => stream.stop()));
      resources.close(); delivery.close();
      await modern.close();
      await Promise.allSettled([...bodyReads]);
      while (closing.size) await Promise.all([...closing]);
      for (const context of [...contexts]) context.finish();
    },
  };
}

function registerNativeTools(server: McpServer, application: Application, current: (ctx: ServerContext) => ApplicationSession) {
  const run = (ctx: ServerContext, call: (session: ApplicationSession) => unknown): CallToolResult => {
    try { return text(call(current(ctx)) ?? "ok"); }
    catch (e) {
      const message = e instanceof ApplicationError && e.code !== "internal" || e instanceof CoreError ? e.message : "internal error";
      return { ...text(`error: ${message}`), isError: true };
    }
  };
  for (const tool of boardTools({ teams: true })) {
    const properties = { ...tool.inputSchema.properties };
    if (tool.name === "board_post") { delete properties.attachments; properties.attachment_ids = z.toJSONSchema(attachmentIds); }
    server.registerTool(tool.name, {
      description: tool.name === "board_post" ? tool.description.replace("attachments?", "attachment_ids?") : tool.description,
      ...(tool._meta ? { _meta: tool._meta } : {}),
      inputSchema: fromJsonSchema<Record<string, unknown>>({ ...tool.inputSchema, properties, additionalProperties: false } as Parameters<typeof fromJsonSchema>[0]),
    }, (args, ctx) => run(ctx, session => application.call(session, tool.name, args)));
  }
  server.registerTool("dm_send", {
    description: "Message one peer by exact handle or bare identity name. Offline messages remain queued. Attachments are uploaded IDs, not paths.",
    inputSchema: z.strictObject({ to: z.string(), body: z.string(), parent_id: id.optional(), pending: z.boolean().describe(PENDING_PARAM.description).optional(), attachment_ids: attachmentIds.optional() }),
  }, (a, ctx) => run(ctx, session => application.send(session, a.to, a.body, a)));
  server.registerTool("dm_history", {
    description: "Recent direct messages, oldest first; optionally filter by peer or page before an ID.",
    inputSchema: z.strictObject({ peer: z.string().optional(), limit: z.number().optional(), before_id: id.optional() }),
  }, (a, ctx) => run(ctx, session => application.history(session, a)));
  server.registerTool("dm_thread", { description: "A whole direct-message thread you participate in.", inputSchema: z.strictObject({ thread: id }) },
    (a, ctx) => run(ctx, session => application.thread(session, a.thread)));
  server.registerTool(DM_INBOX_TOOL.name, { description: DM_INBOX_TOOL.description, _meta: DM_INBOX_TOOL._meta, inputSchema: z.strictObject({ days: z.number().positive().max(MAX_INBOX_DAYS).optional() }) },
    (a, ctx) => run(ctx, session => application.inbox(session, a.days)));
  server.registerTool(DM_ACK_TOOL.name, {
    description: DM_ACK_TOOL.description, _meta: DM_ACK_TOOL._meta, inputSchema: z.strictObject({ message_id: z.union([id, ids.min(1)]) }),
  }, (a, ctx) => {
    const acked: number[] = [], missing: number[] = [];
    const result = run(ctx, session => {
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
    (a, ctx) => run(ctx, session => application.retract(session, a.message_id)));
}
