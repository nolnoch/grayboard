import { McpServer, createMcpHandler, fromJsonSchema, isLegacyRequest, PROTOCOL_VERSION_META_KEY, WebStandardStreamableHTTPServerTransport, ProtocolError, ProtocolErrorCode, type ServerContext, type McpHttpHandler, type ServerEventBus } from "@modelcontextprotocol/server";
import { SubscriptionsListenRequestSchema, type CallToolResultSchema } from "@modelcontextprotocol/core";
import { z } from "zod";
import { boardTools, DEFAULT_CHANNEL_SOURCE, dmTools, type ToolDef } from "../core/tools.ts";
import { BIND_TOOL, UNBIND_TOOL } from "../core/bindings.ts";
import { CoreError } from "../core/errors.ts";
import { DELEGATE_TOOL } from "../core/delegation.ts";
import { DM_ACK_TOOL, DM_INBOX_TOOL, DM_RETRACT_TOOL, MAX_INBOX_DAYS, ackResult, withNotices } from "../shared/inbox.ts";
import { HUMAN_NAME, isValidIdentityName } from "../shared/addressing.ts";
import { ATTACHMENT_LIMITS_CAPABILITY } from "../shared/attachments.ts";
import { GRAYBOARD_ALIAS_LOST_META } from "../shared/session_meta.ts";
import { testPauseAsync } from "../shared/testpause.ts";
import { ApplicationError, type Application, type ApplicationSession, type IdentityInfo } from "./application.ts";
import type { createOAuthServer, OAuthPrincipal } from "./oauth.ts";
import { setRequestClient } from "./request_context.ts";
import { createResources, parseBoardResourceUri } from "./resources.ts";
import { createDelivery } from "./delivery.ts";
import { createHostedSessions, deliveryDeclaration, hostedBoundInstruction, hostedChildInstruction, hostedUnboundInstruction, sessionContext, withoutFacts, type DeclaredDelivery, type SessionContext, type HostedSessions, type Verdict } from "./hosted.ts";
import type { HostedSession } from "./hosted-types.ts";
import { domainData, HOSTED_BIND_INPUT, HOSTED_UNBIND_INPUT, hostedRole, roleScopes, registerHostedResources, type HostedRole } from "./mcp-resources.ts";
import { forwardMcpStream, readMcpBody, type OwnedStream } from "./mcp-streams.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { hostedFailure } from "./hosted-diagnostics.ts";
import { diagnosticOrigin, failureDiagnostic, type FailureSource } from "./diagnostics.ts";
import { permitsOrigin } from "./origin.ts";
import { RateLimiter } from "./rate_limit.ts";
import { DEFAULT_HOSTED_CAPS, DEFAULT_MCP_LIMITS, type HostedCaps, type McpLimits } from "./config.ts";
import { writeAudit } from "./audit.ts";
import pkg from "../../package.json" with { type: "json" };
import { countRefusal, timeTool } from "./metrics.ts";
import type { Tx } from "./store/tx.ts";
import type { AuthPeek } from "./db.ts";

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
// A POST body the SDK's isLegacyRequest can only answer false for, decided without its zod parses (#940): a
// single message, not initialize, whose params' _meta carries the protocol-version key. The SDK documents that
// any request carrying that claim is modern (its ladder rejections included); initialize is left out because one
// with an invalid claim is legacy. isLegacyRequest costs four strict zod parses, and modern.fetch classifies again.
export function claimsModern(body: unknown): boolean {
  if (!isPlainObject(body) || typeof body.method !== "string" || body.method === "initialize" || !isPlainObject(body.params)) return false;
  const meta = body.params._meta;
  return isPlainObject(meta) && PROTOCOL_VERSION_META_KEY in meta;
}

// Subscriber calls that end a session: their selection admits no unknown ID (#1097).
const ENDING_CALLS = new Set<unknown>(["session_end", "delivery_release"]);
export const MCP_PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18"];
type CallToolResult = z.infer<typeof CallToolResultSchema>;
const id = z.number().int().positive();
const ids = z.array(id);
const text = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const LEGACY_GET_PRIME = ": keepalive\n\n";
// `declared`: the native request's declared delivery (#429), for text only.
// `instruction`: what the bound text reads from the ownership (its launcher flag and lease), read by `select` for a
// context makeServer may give the bound text (#807 P3 A7h2).
type Context = { request: Request; principal: OAuthPrincipal; sessionContext: SessionContext; declared?: DeclaredDelivery; stamp?: { ownership: number; generation: number; holding: boolean }; verdict?: Verdict; role: HostedRole; session: ApplicationSession; info: IdentityInfo; instruction?: { launcher: boolean; leased: boolean }; finish(): void };
type Binding = { user: number; email: string; grant: string; role: HostedRole; identity: string };
// A legacy session whose access token expired with its grant still active sleeps
// (#476): its admission is released, its sid stays, and the binding's next
// authenticated request re-admits it. `dormant` holds the separate dormant bound.
// `controls`: the tail of this protocol session's subscribe/unsubscribe chain; each runs after the previous settles (#431).
type Legacy = { ref: string; meta?: unknown; server: McpServer; transport: WebStandardStreamableHTTPServerTransport; binding: Binding; principal: OAuthPrincipal; release(): void; subscriptions: Map<string, string | null>; stream?: Live; posts: number; lastUsed: number; stopped: boolean; controls: Promise<unknown>; pruning?: Promise<void>; dormant?: { since: number; release(): void } };
// `seq`: the hosted notice number when the read began; a notice since naming one of its rows makes it stale (#807 P3
// A7h2, `moved`). `boards`: of the boards authorize was asked about, which the session may receive, read with it
// (#807 P3 B5a2); a sync judge reads them with no await since, and a board it wasn't asked about is refused.
type Checked = { row: HostedSession | undefined; root?: HostedSession; seq: number; boards?: Map<string, boolean> };
type Bound = { row: HostedSession | undefined; root?: HostedSession };
// `bound`: the binding's row and root as the last read or commit notice left them, which a notice judges (#807 P3
// A7h2). `rechecking`: the context a re-read of them is in flight for.
type Live = { context: Context; rows: Set<string>; bound: Bound; rechecking?: Context; uris: Map<string, string | null>; watches: string[]; stream?: OwnedStream; handler?: McpHttpHandler; legacy?: Legacy; stopped: boolean; hint(uri: string): void; stop(): void };

export function createHostedMcp(application: Application, oauth: Pick<ReturnType<typeof createOAuthServer>, "authenticate" | "isAuthorized" | "peekAuthorized" | "isGrantActive" | "issuer" | "resource">, opts: { trustedOrigin: string; now?: () => number; limits?: McpLimits; caps?: HostedCaps; idleSeconds?: number; streamRecheckMs?: number }) {
  const now = opts.now ?? Date.now;
  const trustedOrigin = new URL(opts.trustedOrigin).origin;
  let closed = false, posts = 0, busListeners = 0;
  const limits = opts.limits ?? DEFAULT_MCP_LIMITS, caps = opts.caps ?? DEFAULT_HOSTED_CAPS;
  // Dormant legacy sessions hold no admission; their own bound reuses the legacy limits (#476).
  type CapacityKind = keyof McpLimits | "dormant";
  const capacity: Record<CapacityKind, Map<number, number>> = { listen: new Map(), legacy: new Map(), post: new Map(), dormant: new Map() };
  const used: Record<CapacityKind, number> = { listen: 0, legacy: 0, post: 0, dormant: 0 };
  // `detail` adds to the refusal row; a dormant session's rehydration names its `ref` (#494).
  function reserve(kind: CapacityKind, principal: OAuthPrincipal, detail: Record<string, unknown> = {}): (() => void) | undefined {
    const counts = capacity[kind], user = principal.authed.user_id, limit = limits[kind === "dormant" ? "legacy" : kind];
    const count = counts.get(user) ?? 0;
    const scope = used[kind] >= limit.global ? "global" : count >= limit.perUser ? "user" : undefined;
    if (scope) {
      countRefusal(`mcp_${kind}`);
      writeAudit(application.repo, application.repo.read, "hosted.capacity_refused", principal.authed.user_email, null, { kind, scope, client_id: principal.clientId, ...detail });
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
  // In-flight handlers (a listen stream's ends when its response starts): kept above the POST cap it contains.
  const exchangeCap = Math.max(512, 2 * limits.post.global);
  const bodyReads = new Set<Promise<unknown>>();
  async function readBody(request: Request) {
    const reading = readMcpBody(request, shutdown.signal);
    bodyReads.add(reading);
    try { return await reading; } finally { bodyReads.delete(reading); }
  }
  const principals = new Map<ApplicationSession, OAuthPrincipal>();
  const legacySessions = new Map<string, Legacy>();
  const legacyAll = new Set<Legacy>();
  const legacyDormant = new Set<Legacy>();
  const lives = new Set<Live>();
  // Indexes over `lives` (#939), so a lease's inbox change and a hosted row's commit touch only the lives they
  // concern, not every live: by inbox capability (`live.uris`' inbox entry), and by binding row (`live.rows`),
  // with the lives that read no row in `rowless`, which every commit checks. Kept by `index`/`unindex` wherever
  // `lives`, `live.uris` or `live.rows` change.
  const byInbox = new Map<string, Set<Live>>();
  const byRow = new Map<string, Set<Live>>();
  const rowless = new Set<Live>();
  const put = <K>(map: Map<K, Set<Live>>, key: K, live: Live) => { let set = map.get(key); if (!set) map.set(key, set = new Set()); set.add(live); };
  const unput = <K>(map: Map<K, Set<Live>>, key: K, live: Live) => { const set = map.get(key); if (set?.delete(live) && !set.size) map.delete(key); };
  function indexInbox(live: Live) { const cap = live.uris.get("grayboard://inbox"); if (cap) put(byInbox, cap, live); }
  function indexRows(live: Live) { if (!live.rows.size) rowless.add(live); for (const row of live.rows) put(byRow, row, live); }
  function unindexRows(live: Live) { rowless.delete(live); for (const row of live.rows) unput(byRow, row, live); }
  function unindex(live: Live) { const cap = live.uris.get("grayboard://inbox"); if (cap) unput(byInbox, cap, live); unindexRows(live); }
  const forwarding = new Set<OwnedStream>();
  const streamContexts = new Map<OwnedStream, Context>();
  const closing = new Set<Promise<unknown>>();
  const track = (promise: Promise<unknown>) => {
    const settled = promise.catch(() => {}).finally(() => closing.delete(settled));
    closing.add(settled);
  };
  // A resource session's principal: its context's, or the exchange's; undefined once closed or for another user.
  const resourcePrincipal = (session: ApplicationSession) => {
    const principal = principals.get(session) ?? exchanges.getStore()?.context?.principal;
    return !closed && principal && session.authed.user_id === principal.authed.user_id ? principal : undefined;
  };
  // The principal is resolved before the token read: the exchange store is the caller's, read synchronously. Closed
  // while the read awaited: refused (#807 P3 A7d2c).
  const resources = createResources(application, { caps: caps.watches, isCurrent: session => !!resourcePrincipal(session), isAuthorized: async (session, r) => {
    const principal = resourcePrincipal(session);
    return !!principal && await oauth.isAuthorized(principal, r) && !closed;
  } });
  const hosted = createHostedSessions(application, { now, caps: caps.sessions, ...(opts.idleSeconds ? { idleSeconds: opts.idleSeconds } : {}), isAuthorized: (principal, r) => oauth.isAuthorized(principal, r) });
  const delivery = createDelivery(hosted, { isAuthorized: (principal, r) => oauth.isAuthorized(principal, r), now, caps: caps.leases });
  type Exchange = { request: Request; address: string; protocol: string; principal?: number; identity?: string; session?: string; tool?: string; logged?: boolean; failure?: ApplicationError; meta?: unknown; id?: string | number | null; method?: unknown; call?: unknown; refusal?: Response; context?: Context; legacy?: Legacy };
  const exchanges = new AsyncLocalStorage<Exchange>();
  const refusalLogs = new RateLimiter({ burst: 1, perSec: 0.1 }, { start() {}, end() {} }, now, 4096);
  const report = (error: unknown, source: FailureSource = "hosted-sdk", exchange = exchanges.getStore()) => {
    if (error instanceof ApplicationError || error instanceof CoreError || exchange?.failure || exchange?.refusal || exchange?.logged) return;
    if (exchange) exchange.logged = true;
    console.error(`[grayboard] hosted MCP failed: ${JSON.stringify({ principal: exchange?.principal, identity: exchange?.identity, session: exchange?.session, tool: exchange?.tool, protocol: exchange?.protocol, ...failureDiagnostic(source, error) })}`);
  };
  const logRefusal = (reason: string, exchange: Exchange, detail: Record<string, unknown> = {}) => {
    refusalLogs.sweep();
    if (refusalLogs.size >= 4096 || !refusalLogs.take(exchange.address).ok) return;
    console.error(`[grayboard] hosted MCP refused: ${JSON.stringify({ reason, address: exchange.address, origin: diagnosticOrigin(exchange.request.headers.get("Origin")), public_origin: trustedOrigin, principal: exchange.principal, identity: exchange.identity, protocol: exchange.protocol, ...detail })}`);
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
  // Returns the context's row as it stands after any settle, so a caller needn't read it again (#853): the row is read
  // after the auth checks' awaits, so the caller's synchronous continuation is the reuse window (#807 P3 A7d).
  // The grant and user checks share one auth-generation read (#902). `withRow: false` (a native tool, whose hosted
  // gate reads and settles the row itself) skips the row.
  // `root`: the row's root as read, when no settle wrote since (#899).
  // `uris`: the resources the caller will judge with the result; a native session's board visibility for them is
  // read first, before the row, so the row's synchronous reuse window stays the last (#807 P3 B5a2).
  async function authorize(context: Context, signal?: AbortSignal, withRow?: true, uris?: Iterable<string>): Promise<Checked>;
  async function authorize(context: Context, signal: AbortSignal | undefined, withRow: false): Promise<void>;
  async function authorize(context: Context, signal?: AbortSignal, withRow = true, uris: Iterable<string> = []): Promise<Checked | void> {
    await authCheck(context, signal);
    if (!withRow) return;
    const boards = await boardFacts(context, uris);
    if (cancelled(context, signal)) throw new ApplicationError("unauthenticated", "request cancelled");
    const checked = await rowCheck(context);
    if (cancelled(context, signal)) throw new ApplicationError("unauthenticated", "request cancelled");
    return { ...checked, boards };
  }
  // A native session's boards among `uris` (a uri that names none is refused by `capability` itself).
  function boardsOf(context: Context, uris: Iterable<string>): string[] {
    if (context.role !== "native") return [];
    const out: string[] = [];
    for (const uri of uris) { try { out.push(parseBoardResourceUri(uri)); } catch { /* capability refuses it */ } }
    return out;
  }
  // Their visibility for the session's addresses as they stand at the call; `capability` checks the session itself.
  async function boardFacts(context: Context, uris: Iterable<string>): Promise<Map<string, boolean>> {
    const boards = boardsOf(context, uris);
    return boards.length ? application.boardsVisibleTo(application.repo.read, [...context.session.addresses], boards) : new Map();
  }
  // authorize for a set of uris read after its awaits (a live's, a legacy session's registrations), which a control
  // may grow meanwhile: read again while a board the set names went unread, up to three times; past that the
  // unread board is refused, as `capability` refuses one it wasn't asked about.
  async function authorizeFor(context: Context, uris: () => Iterable<string>, signal?: AbortSignal): Promise<Checked> {
    for (let attempt = 1; ; attempt++) {
      const checked = await authorize(context, signal, true, uris());
      if (attempt >= 3 || boardsOf(context, uris()).every(b => checked.boards!.has(b))) return checked;
    }
  }
  // authorize's hosted-row part, also a live's recheck (#807 P3 A7h2). The row and root are two pool reads: a commit
  // between them leaves a mixed pair, which `bindingLive` refuses unless the root still names the row's ownership,
  // and a notice for either since `seq` makes a live re-read them (`adopt`). The lease deadline is checked against
  // the root as read, the newer of the two.
  async function rowCheck(context: Context): Promise<Checked> {
    const start = seq;
    if (!("id" in context.sessionContext)) return { row: undefined, seq: start };
    const row = await hosted.readRow(context.sessionContext.id);
    const root = row && await hosted.readRoot(row);
    if (!root || root.lease_deadline === null || root.lease_deadline > now()) return { row, root, seq: start };
    // The settle's body is async (#807 P3 A6e2) and nothing waits for it: the request answers no row, failing
    // closed. It goes through the write queue, not post: authorize also runs from the queue's holder (a board
    // commit's afterCommit hint), where an async post throws; a write queues behind the holder. The settle judges
    // the root when it runs, which may find a body it waited behind renewed the lease.
    void application.repo.write(tx => hosted.settle(tx, root.session_id)).catch(e => hostedFailure("hosted.settle", e));
    return { row: undefined, seq: start };
  }
  // authorize's checks that read no hosted row: the request, the token and grant, the session and its user. The
  // request is checked again after the awaits: a close or cancel that landed meanwhile refuses (#807 P3 A7d).
  const cancelled = (context: Context, signal?: AbortSignal) => closed || context.request.signal.aborted || !!signal?.aborted;
  async function authCheck(context: Context, signal?: AbortSignal) {
    if (cancelled(context, signal)) throw new ApplicationError("unauthenticated", "request cancelled");
    await application.repo.authRead(async () => {
      if (!await oauth.isAuthorized(context.principal)) throw new ApplicationError("unauthenticated", "unauthenticated");
      await application.revalidateSession(context.session, true);
    });
    if (cancelled(context, signal)) throw new ApplicationError("unauthenticated", "request cancelled");
  }
  // authCheck from the auth cache alone, for the timer's phase A: true or a throw as authCheck, or undefined on a
  // cache miss, which phase B checks in full.
  function authPeekCheck(context: Context, peek: AuthPeek): true | undefined {
    if (closed || context.request.signal.aborted) throw new ApplicationError("unauthenticated", "request cancelled");
    const ok = oauth.peekAuthorized(context.principal, peek);
    if (ok === undefined) return undefined;
    if (!ok) throw new ApplicationError("unauthenticated", "unauthenticated");
    // Sync (#807 P3 A7u1): peekAuthorized's cached user answered for a disabled one.
    application.revalidateNow(context.session, true);
    return true;
  }
  // `admit: false` skips hosted admission, for a re-selection the prompting request already paid for (#431).
  async function select(request: Request, admit = true): Promise<Context> {
    const role = hostedRole(request);
    const principal = await oauth.authenticate(request, roleScopes(role));
    if (principal instanceof Response) return refuse(principal);
    setRequestClient(principal.clientId);
    const meta = exchanges.getStore()?.meta;
    // A malformed `_meta` field is the client's bug: refused with its own message and logged, so it's diagnosable.
    const metaRefusal = (reason: string, error: unknown): never => {
      if (!(error instanceof ApplicationError)) throw error;
      const exchange = exchanges.getStore();
      if (exchange) {
        exchange.principal = principal.authed.user_id;
        logRefusal(reason, exchange, { client_id: principal.clientId });
      }
      return refuse(Response.json({ code: error.code, message: error.message }, { status: 400 }));
    };
    let routing: SessionContext;
    try { routing = sessionContext(principal, meta); }
    catch (error) { return metaRefusal("session_meta", error); }
    let declared: DeclaredDelivery | undefined;
    // Native requests only, before admission: the subscriber role ignores the declaration.
    try { declared = role === "native" ? deliveryDeclaration(principal, meta) : undefined; }
    catch (error) { return metaRefusal("delivery_declaration", error); }
    let selected: Awaited<ReturnType<typeof hosted.snapshot>>;
    try {
      if (admit) application.admitHosted(principal.authed, "id" in routing ? routing.id : null, role);
      // A native tool call's end is touched by its tool's gate, which also reuses this selection's verdict (#907). A
      // subscriber's ending call admits no unknown ID (#1097): ending must never start a session.
      const exchange = exchanges.getStore();
      selected = await hosted.snapshot(principal, routing, !(role === "native" && exchange?.method === "tools/call"), !(role === "subscriber" && ENDING_CALLS.has(exchange?.call)));
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
        const refusal = await oauth.authenticate(request, roleScopes(role));
        if (refusal instanceof Response) refuse(refusal);
        refuse(Response.json({ code: "unauthenticated", message: "invalid or missing token" }, { status: 401 }));
      }
      report(error, "hosted-admission");
      throw error;
    }
    const context: Context = { request, principal, sessionContext: routing, declared, role, ...selected, finish() {
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
      // The bound text's facts, for a context makeServer would give it (boundInstruction): read here, since the
      // server's instructions are built synchronously. The selection read the root moments ago (#907).
      if (role !== "subscriber" && !context.session.via && !context.session.readOnly && "id" in routing) {
        const row = context.verdict ? undefined : await hosted.readRow(routing.id);
        const root = context.verdict?.root ?? (row && await hosted.readRoot(row));
        context.instruction = { launcher: await application.hostedLauncher(routing.id), leased: root?.lease_deadline != null };
      }
      if (!await oauth.isAuthorized(principal)) {
        const refusal = await oauth.authenticate(request, roleScopes(role));
        if (refusal instanceof Response) refuse(refusal);
        throw new Error("unauthenticated");
      }
      // Closed or cancelled while the check awaited: the context is finished below, never handed out.
      if (closed || request.signal.aborted) throw new Error("MCP request is closed");
      return context;
    } catch (error) { context.finish(); throw error; }
  }
  function binding(context: Context): Binding {
    return { user: context.principal.authed.user_id, email: context.principal.authed.user_email, grant: context.principal.grantId, role: context.role, identity: context.session.identityFull };
  }
  function matches(a: Binding, b: Binding) { return a.user === b.user && a.email === b.email && a.grant === b.grant && a.role === b.role; }
  // Judged from rows already read (a Checked, or a live's `bound`): the pair must be the row and the root it names,
  // under one ownership (the readRoot check), so a pair a commit split is refused. Whether the root holds a name is
  // the stamp's (#807 P3 B1b), read with it: it stands while the root's generation matches the stamp's.
  function bindingLive(context: Context, bound: Bound) {
    if (!("id" in context.sessionContext)) return false;
    const { row, root } = bound;
    if (!row || !root || root.session_id !== (row.root_session_id ?? row.session_id) || root.ownership_id !== row.ownership_id) return false;
    return (context.stamp?.holding || root.writes_as !== null) && root.ownership_id === context.stamp?.ownership && root.bind_gen === context.stamp.generation;
  }
  // The rows a live's binding reads: its own and its root's (from `row`, its own as its creator read it), fixed at
  // creation (#399). A commit names the one row it changed, so only the lives reading it are checked.
  function bindingRows(context: Context, row: HostedSession | undefined): Set<string> {
    if (!("id" in context.sessionContext)) return new Set();
    return new Set([context.sessionContext.id, ...(row?.root_session_id ? [row.root_session_id] : [])]);
  }
  // The stream timer re-reads a context's hosted rows only when they could have changed (#899): a commit notice
  // naming one (`changedAt`, every context, idle lives too), a null notice (`allAt`), a moved auth generation (which
  // another connection's commit also moves), a lease deadline passing, or `recheckMs` since its last full check.
  // `seq` numbers the notices; a stamp keeps the one current when its check began.
  let seq = 0, allAt = 0, prunedAt = now(), prunedThrough = 0;
  const changedAt = new Map<string, number>();
  type Stamp = { gen: string; seq: number; at: number; recheckAt: number; rows: string[]; row: HostedSession | undefined };
  const stamps = new WeakMap<Context, Stamp>();
  const recheckMs = opts.streamRecheckMs ?? 30_000;
  function stamp(context: Context, gen: string | undefined, at: number, start: number, checked: Checked) {
    if (gen === undefined) { stamps.delete(context); return; }
    const id = "id" in context.sessionContext ? context.sessionContext.id : undefined, { row, root } = checked;
    const deadlines = [row?.lease_deadline, root?.lease_deadline].filter((d): d is number => d !== null && d !== undefined);
    // A settle that wrote leaves no root: checked again next tick.
    const recheckAt = id === undefined ? Infinity : root ? Math.min(Infinity, ...deadlines) : at;
    const rows = id === undefined ? [] : [id, ...(row?.root_session_id ? [row.root_session_id] : [])];
    stamps.set(context, { gen, seq: start, at, recheckAt, rows, row });
  }
  function fresh(context: Context, gen: string | undefined, t: number): Stamp | undefined {
    const s = stamps.get(context);
    if (!s || gen === undefined || s.gen !== gen || allAt > s.seq || t >= s.recheckAt || t - s.at >= recheckMs) return undefined;
    for (const id of s.rows) if ((changedAt.get(id) ?? 0) > s.seq) return undefined;
    return s;
  }
  // A notice for a row since `since`, or one for every row (null), or one the prune may have dropped: a read begun
  // at `since` may be older than the commit.
  function moved(rows: Iterable<string>, since: number) {
    if (allAt > since || prunedThrough > since) return true;
    for (const id of rows) if ((changedAt.get(id) ?? 0) > since) return true;
    return false;
  }
  // Every commit to a hosted row notifies, so a read no notice for its rows followed is the committed state: the live
  // keeps it. One a notice raced is read again, as is a re-read a notice raced in turn.
  function adopt(live: Live, checked: Checked) {
    if (live.stopped) return;
    if (moved(live.rows, checked.seq)) return recheck(live);
    live.bound = { row: checked.row, root: checked.root };
  }
  function recheck(live: Live) {
    const context = live.context;
    if (live.rechecking === context) return;
    live.rechecking = context;
    track(rowCheck(context).then(checked => {
      if (live.rechecking === context) live.rechecking = undefined;
      if (live.stopped || live.context !== context) return;
      adopt(live, checked);
      judge(live);
    }, e => {
      if (live.rechecking === context) live.rechecking = undefined;
      if (live.stopped || live.context !== context) return;
      if (!(e instanceof ApplicationError)) hostedFailure("mcp.binding", e);
      live.stop();
    }));
  }
  function judge(live: Live) {
    if (live.stopped) return;
    try { if (!idle(live) && !bindingLive(live.context, live.bound)) live.stop(); }
    catch (e) { hostedFailure("mcp.binding", e); live.stop(); }
  }
  // A row from a commit (null: gone) into a live's bound: its own, its root's, or both for a root.
  function note(live: Live, id: string, row: HostedSession | undefined) {
    const own = "id" in live.context.sessionContext ? live.context.sessionContext.id : undefined;
    const rootId = [...live.rows].find(r => r !== own) ?? own;
    if (id === own) live.bound.row = row;
    if (id === rootId) live.bound.root = row;
  }
  // A notice carrying its row (#807 P3 A7h2) updates the lives reading that row and judges them in the commit's
  // flush, as before; the lives with no row are judged on every notice. A notice without one (null, or a commit whose
  // facts read failed) leaves the lives to the full pass it requested: `watchRows` reads their rows on its Tx and
  // judges them before the queue's next body. Until then a live a revoke unbound may take a hint, whose own
  // authorize reads the rows and refuses.
  const unlistenHosted = hosted.listen((changed, row) => {
    seq++;
    if (changed === null) allAt = seq; else changedAt.set(changed, seq);
    // A snapshot: stop() unindexes as it goes.
    const affected = [...rowless];
    if (changed !== null && row !== undefined) for (const live of byRow.get(changed) ?? []) { note(live, changed, row ?? undefined); affected.push(live); }
    for (const live of affected) judge(live);
  });
  const unwatchHosted = hosted.watchRows({
    ids: () => byRow.keys(),
    apply(rows) {
      const affected = new Set<Live>();
      for (const [id, row] of rows) for (const live of byRow.get(id) ?? []) { note(live, id, row); affected.add(live); }
      for (const live of affected) judge(live);
    },
  });
  // `checked`: authorize's result for this context, awaited by the caller with no await since (#853).
  function watchable(context: Context, uri: string, checked: Checked): string | null {
    if (!bindingLive(context, checked)) throw new ApplicationError("unbound", "ownership changed; subscribe again with current session context");
    return capability(context, uri, checked);
  }
  // watchable's check of the resource itself, past the binding: a subscriber's lease (in memory, against
  // `checked.row`), a native session's board access (`checked.boards`, read with the row).
  function capability(context: Context, uri: string, checked: Checked): string | null {
    if (context.role === "subscriber") {
      const cap = context.request.headers.get("X-Grayboard-Lease");
      if (uri !== "grayboard://inbox" || !cap || !/^[A-Za-z0-9_-]{43}$/.test(cap) ||
          delivery.identityFull(context.principal, context.sessionContext, cap, checked) !== context.session.identityFull) {
        throw new ApplicationError("not_found", "resource not found");
      }
      return cap;
    }
    const board = parseBoardResourceUri(uri);
    application.revalidateNow(context.session);
    if (checked.boards?.get(board) !== true) throw new ApplicationError("not_found", "resource not found");
    return null;
  }
  // One authorize for the live's every uri: watchable and describe reuse its row (#853). The uris are read after
  // the awaits, as they stand then (#807 P3 A7d).
  async function valid(live: Live): Promise<Checked> {
    const checked = validChecked(live, await authorizeFor(live.context, () => live.uris.keys()));
    adopt(live, checked);
    return checked;
  }
  function validChecked(live: Live, checked: Checked): Checked {
    for (const [uri, cap] of live.uris) if (watchable(live.context, uri, checked) !== cap) throw new ApplicationError("not_found", "resource not found");
    return checked;
  }
  // valid for a live whose stamp is fresh (#899), from the auth cache (phase A): every check but the binding's row,
  // root and holds reads, which nothing could have changed; the lease is checked against the stamped row, unchanged
  // since. Undefined on an auth cache miss, which phase B checks in full. "boards": a native live, whose board
  // visibility no stamp covers (membership writes move no generation and send no notice), so phase B reads it alone
  // (`checkBoards`, #807 P3 B5a2), as the sync read here did each tick.
  function validStamped(live: Live, s: Stamp, peek: AuthPeek): true | "boards" | undefined {
    if (!authPeekCheck(live.context, peek)) return undefined;
    if (live.context.role === "native" && live.uris.size) return "boards";
    for (const [uri, cap] of live.uris) if (capability(live.context, uri, { row: s.row, seq: s.seq }) !== cap) throw new ApplicationError("not_found", "resource not found");
    return true;
  }
  function addWatch(live: Live, uri: string, checked: Checked) {
    // Every caller has just authorized live.context, with no read since (makeLive's callers, the legacy control).
    if (live.context.role === "native") live.watches.push(resources.watch(live.context.session, uri, {
      changed: () => live.hint(uri), closed: () => live.stop(),
    }, checked.boards?.get(parseBoardResourceUri(uri)) === true));
  }
  // A legacy GET with no watched resource carries nothing a binding governs, so it stays
  // open (idle) across bind changes until a resource subscription attaches it (#431).
  // It receives nothing, so peer_list doesn't show its session (`ApplicationSession.listed`).
  const idle = (live: Live) => !!live.legacy && live.uris.size === 0;
  // Re-selects an idle legacy GET's context from the subscribing POST: its `_meta` routes the
  // stream and its headers carry the current token and any lease; the GET's signal keeps the
  // lifetime. An idle GET is re-authorized by a POST under the same binding; a GET watching
  // resources keeps its own credentials. Hosted admission isn't charged again: the POST paid it.
  // A refusal, or a GET closed meanwhile, is `unauthenticated`; anything else is a fault.
  async function attach(live: Live, via: Request) {
    const start = seq;
    const request = new Request(via.url, { method: "GET", headers: via.headers, signal: live.context.request.signal });
    const exchange: Exchange = { ...exchanges.getStore()!, request, refusal: undefined, context: undefined, failure: undefined, logged: false };
    let next: Context;
    try { next = await exchanges.run(exchange, () => select(request, false)); }
    catch (error) {
      if (error instanceof ApplicationError) throw error;
      if (exchange.refusal || closed || request.signal.aborted) throw new ApplicationError("unauthenticated", "unauthenticated");
      throw error;
    }
    if (live.stopped || !idle(live)) { next.finish(); return; }
    const previous = live.context;
    unindexRows(live);
    live.context = next; live.rows = bindingRows(next, next.verdict?.row);
    indexRows(live);
    // The selection's rows, read after `start`.
    adopt(live, { row: next.verdict?.row, root: next.verdict?.root, seq: start });
    if (live.stream) streamContexts.set(live.stream, next);
    previous.finish();
  }
  // `checked`: the authorize its caller judged the uris with.
  function makeLive(context: Context, checked: Checked, uris: Map<string, string | null>, handler?: McpHttpHandler, legacy?: Legacy): Live {
    const live: Live = { context, rows: bindingRows(context, checked.row), bound: { row: undefined }, uris, watches: [], handler, legacy, stopped: false,
      // A hint arrives from a commit's afterCommit, inside the queue's holder: nothing waits for its check, and a
      // live stopped, or a uri dropped, while the check awaited gets no notification (#807 P3 A7d).
      hint(uri) {
        if (live.stopped || !live.uris.has(uri)) return;
        track(valid(live).then(() => {
          if (live.stopped || !live.uris.has(uri)) return;
          if (handler) handler.notify.resourceUpdated(uri);
          else if (legacy) track(legacy.server.server.notification({ method: "notifications/resources/updated", params: { uri } }).catch(e => { hostedFailure("mcp.hint", e); live.stop(); }));
        }).catch(e => { hostedFailure("mcp.hint", e); live.stop(); }));
      },
      stop() {
        if (live.stopped) return;
        live.stopped = true;
        lives.delete(live);
        unindex(live);
        const context = live.context;
        if (legacy && context.role === "native" && live.uris.size) {
          // A lost board must not poison every later GET on this protocol session: its registration goes. Access
          // rotation alone preserves registrations that remain visible. The read awaits (#807 P3 B5a2), for the
          // addresses as they stand now; the next GET waits for it (`pruning`). A failed read prunes nothing.
          const addresses = [...context.session.addresses], uris = [...live.uris.keys()];
          const prune = (async () => {
            const seen = await application.boardsVisibleTo(application.repo.read, addresses, uris.flatMap(uri => { try { return [parseBoardResourceUri(uri)]; } catch { return []; } }));
            await testPauseAsync("mcp:legacy:pruned");
            for (const uri of uris) { try { if (seen.get(parseBoardResourceUri(uri)) === false) legacy.subscriptions.delete(uri); } catch { /* not a board */ } }
          })().catch(e => hostedFailure("mcp.stream", e));
          const pruning: Promise<void> = Promise.all([legacy.pruning, prune]).then(() => {});
          legacy.pruning = pruning;
          track(pruning.finally(() => { if (legacy.pruning === pruning) legacy.pruning = undefined; }));
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
    indexInbox(live); indexRows(live);
    adopt(live, checked);
    try { for (const uri of uris.keys()) addWatch(live, uri, checked); }
    catch (error) { live.stop(); throw error; }
    return live;
  }
  function leaseHooks() {
    let capability: string | undefined;
    return {
      bind(cap: string) { capability = cap; },
      changed() {
        if (!capability) return;
        for (const live of [...(byInbox.get(capability) ?? [])]) live.hint("grayboard://inbox");
      },
      closed() {
        if (!capability) return;
        for (const live of [...(byInbox.get(capability) ?? [])]) live.stop();
        for (const legacy of [...legacyAll, ...legacyDormant]) if (legacy.subscriptions.get("grayboard://inbox") === capability) legacy.subscriptions.delete("grayboard://inbox");
      },
    };
  }
  // The bound text follows the ownership: its launcher flag, and (with no declaration) its lease (#531).
  function boundInstruction(context: Context): string {
    if (!("id" in context.sessionContext) || !context.instruction) return hostedBoundInstruction(context.info, context.declared);
    return hostedBoundInstruction(context.info, context.declared, context.instruction.launcher, context.instruction.leased);
  }
  function makeServer(context: Context, legacy?: Legacy) {
    const { role, info } = context;
    const server = new HostedMcpServer({ name: DEFAULT_CHANNEL_SOURCE, version: pkg.version }, {
      supportedProtocolVersions: legacy ? MCP_PROTOCOL_VERSIONS.slice(1) : MCP_PROTOCOL_VERSIONS,
      capabilities: { tools: { listChanged: false }, experimental: { [ATTACHMENT_LIMITS_CAPABILITY]: { ...application.repo.attachmentLimits } } },
      cacheHints: { "resources/list": { ttlMs: 0, cacheScope: "private" }, "resources/read": { ttlMs: 0, cacheScope: "private" } },
      instructions: role === "subscriber" ? undefined
        : context.session.via ? hostedChildInstruction(info, context.session.via, context.session.readOnly)
        : context.session.readOnly ? hostedUnboundInstruction(info.candidates ?? [])
        : boundInstruction(context),
    });
    server.server.onerror = error => report(error);
    server.server.registerCapabilities({ resources: { subscribe: true } });
    registerHostedResources(server, {
      role, current, issuer: oauth.issuer, resource: oauth.resource, resources, delivery, hosted, leaseHooks,
      authorize() { return authorize(current()); },
    });
    if (legacy) {
      const control = async (uri: string, ctx: ServerContext, subscribe: boolean) => {
        const context = current(ctx);
        try {
          const checked = await authorize(context, ctx.mcpReq.signal, true, [uri]);
          if (subscribe) {
            if (!legacy.subscriptions.has(uri) && legacy.subscriptions.size >= caps.watches.perSession) { countRefusal("resource_watch"); throw new ApplicationError("bad_request", "resource watch capacity reached"); }
            const cap = watchable(context, uri, checked);
            const previous = sessionContext(context.principal, legacy.meta);
            if (legacy.subscriptions.size && (!("id" in previous) || !("id" in context.sessionContext) || previous.id !== context.sessionContext.id)) {
              throw new ApplicationError("bad_request", "legacy subscriptions require one session context per protocol session");
            }
            const idleStream = legacy.stream && idle(legacy.stream) ? legacy.stream : undefined;
            if (idleStream) {
              // An expected refusal falls back to the incompatible path below: the GET ends and its
              // client recovers. A fault fails this registration rather than being masked as success.
              try { await attach(idleStream, context.request); }
              catch (error) {
                if (!(error instanceof ApplicationError) || error.code === "internal") throw error;
                const exchange = exchanges.getStore();
                if (exchange) logRefusal("legacy_attach", exchange, { code: error.code });
                streamClosed(idleStream.context, error);
                idleStream.stop();
              }
            }
            const stream = legacy.stream, streamContext = stream?.context;
            // The checks this registration is judged by, both in one last await (#807 P3 A7d, B5a2): this POST's
            // context again (an attach may have awaited since the first), and the stream's, whose answer decides
            // whether this uri joins it. Each is judged below with no await since.
            const expected = (error: unknown) => error instanceof ApplicationError && (error.code === "unauthenticated" || error.code === "not_found");
            const [final, streamChecked] = await Promise.all([
              authorize(context, ctx.mcpReq.signal, true, [uri]),
              streamContext ? authorize(streamContext, undefined, true, [uri]).catch(error => { if (expected(error)) return undefined; throw error; }) : undefined,
            ]);
            // A session retired or parked meanwhile takes no registration, and the capability is checked again, since
            // an inbox lease may have closed, or the board been lost, while the checks awaited.
            if (legacy.stopped || legacy.dormant) throw new ApplicationError("unauthenticated", "MCP session is closed");
            if (watchable(context, uri, final) !== cap) throw new ApplicationError("not_found", "resource not found");
            let compatible = false;
            if (stream && streamChecked && stream.context === streamContext) {
              try {
                compatible = watchable(streamContext, uri, streamChecked) === cap && (!stream.uris.has(uri) || stream.uris.get(uri) === cap);
              } catch (error) {
                if (!expected(error)) throw error;
              }
            }
            // A stream stopped or replaced while the check awaited is left alone: nothing to join or stop.
            if (!stream || legacy.stream !== stream || stream.stopped) {}
            else if (compatible) {
              // Publish registration only after observer installation succeeds.
              if (!stream.uris.has(uri)) { addWatch(stream, uri, streamChecked!); stream.uris.set(uri, cap); indexInbox(stream); }
            } else {
              // The current POST owns registration; an incompatible GET must recover
              // with fresh credentials rather than inherit this request's snapshot.
              stream.stop();
            }
            legacy.meta = exchanges.getStore()?.meta;
            legacy.subscriptions.set(uri, cap);
          } else {
            watchable(context, uri, checked);
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
      // One control at a time per protocol session: the one-session-context guard and the idle
      // GET's attach would otherwise interleave across the attach's await (#431).
      const serialized = (uri: string, ctx: ServerContext, subscribe: boolean) => {
        const run = legacy.controls.then(() => control(uri, ctx, subscribe));
        legacy.controls = run.catch(() => {});
        return run;
      };
      server.server.setRequestHandler("resources/subscribe", (req, ctx) => serialized(req.params.uri, ctx, true));
      server.server.setRequestHandler("resources/unsubscribe", (req, ctx) => serialized(req.params.uri, ctx, false));
    }
    if (role !== "subscriber") registerNativeTools(server, application, hosted, async ctx => { await authorize(current(ctx), ctx.mcpReq.signal, false); return current(ctx); }, (error, tool) => { const exchange = exchanges.getStore(); if (exchange) exchange.tool = tool; report(error, "hosted-tool"); }, code => { const exchange = exchanges.getStore(); if (exchange) logRefusal(code, exchange); });
    return server;
  }
  const modernFactory = async () => {
    try {
    const exchange = exchanges.getStore()!;
    if (exchange.context) {
      if (closed || exchange.request.signal.aborted) throw new Error("MCP request is closed");
      const principal = await oauth.authenticate(exchange.request, roleScopes(exchange.context.role));
      if (closed || exchange.request.signal.aborted) throw new Error("MCP request is closed");
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
    legacy.dormant?.release();
    legacyAll.delete(legacy);
    legacyDormant.delete(legacy);
    for (const [id, value] of legacySessions) if (value === legacy) legacySessions.delete(id);
    if (legacy.stream?.stream) streamContexts.delete(legacy.stream.stream);
    try { legacy.stream?.stop(); } catch { report(); }
    legacy.subscriptions.clear();
    track(Promise.resolve().then(() => legacy.server.close()).catch(report));
    track(Promise.resolve().then(() => legacy.transport.close()).catch(report));
  }
  // A hosted stream the 1 s timer stops is audited once with why (#472): the
  // access token's expiry (the hourly rollover), else the refusal's code. A
  // stream whose client already closed it isn't the server's stop: it goes unaudited.
  const auditedStreams = new WeakSet<Context>();
  function streamClosed(context: Context, error: unknown) {
    if (!("id" in context.sessionContext) || context.request.signal.aborted || auditedStreams.has(context)) return;
    auditedStreams.add(context);
    try {
      const reason = context.principal.accessExpiry <= now() ? "access_expired" : error instanceof ApplicationError ? error.code : "failed";
      hosted.auditAs(application.repo.read, context.sessionContext.id, "hosted.stream_closed", { reason, role: context.role, ...(context.stamp ? { ownership: context.stamp.ownership } : {}) }, context.principal);
    } catch (e) { hostedFailure("mcp.stream", e); }
  }
  // Legacy lifecycle transitions are audited with a per-session random ref, never the sid (#476).
  function legacyAudit(legacy: Legacy, action: "hosted.legacy_dormant" | "hosted.legacy_rehydrated" | "hosted.legacy_dropped", detail: Record<string, unknown>) {
    try {
      const context = sessionContext(legacy.principal, legacy.meta);
      writeAudit(application.repo, application.repo.read, action, legacy.principal.authed.user_email, "id" in context ? context.id : null, { ...detail, ref: legacy.ref, grant: legacy.principal.grantId, client_id: legacy.principal.clientId });
    } catch (e) { hostedFailure("mcp.legacy", e); }
  }
  function sleep(legacy: Legacy) {
    const hold = reserve("dormant", legacy.principal);
    if (!hold) {
      if (legacy.stream) streamClosed(legacy.stream.context, new ApplicationError("unauthenticated", "unauthenticated"));
      drop(legacy, "capacity");
      return;
    }
    legacy.release();
    legacyAll.delete(legacy);
    legacy.dormant = { since: now(), release: hold };
    legacyDormant.add(legacy);
    const stream = legacy.stream;
    if (stream) {
      if (stream.stream) streamContexts.delete(stream.stream);
      streamClosed(stream.context, new ApplicationError("unauthenticated", "unauthenticated"));
      stream.stop();
    }
    legacyAudit(legacy, "hosted.legacy_dormant", { subscriptions: legacy.subscriptions.size });
  }
  function drop(legacy: Legacy, reason: string, failed = false, detail: Record<string, unknown> = {}) {
    if (legacy.stopped) return;
    legacyAudit(legacy, "hosted.legacy_dropped", { reason, dormant_ms: legacy.dormant ? now() - legacy.dormant.since : 0, ...detail });
    retire(legacy, failed);
  }
  // Contexts and legacy sessions queued for or in a phase-B check: a tick skips them, so a slow check never overlaps
  // the next tick's on the same one (#807 P3 A7d). A tick marks each as it queues it, since phase B starts only a
  // bounded number at once; the check's finally unmarks it. `checking` keeps each check's notice number (the queuing
  // tick's, then the check's own at its start), which the prune below keeps notices for until the check stamps.
  const checking = new Map<Context, number>(), sweeping = new Set<Legacy>();
  const PHASE_B_PARALLEL = 16;
  // A worker never dies on a throw, so every queued item reaches the check whose finally unmarks it.
  async function bounded<T>(items: T[], fn: (item: T) => Promise<void>) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(PHASE_B_PARALLEL, items.length) }, async () => {
      while (next < items.length) { try { await fn(items[next++]!); } catch (e) { hostedFailure("mcp.stream", e); } }
    }));
  }
  // An access expiry or revoke is an expected close, audited by streamClosed; only other failures are logged (#494 item 10).
  const unexpected = (e: unknown) => { if (!(e instanceof ApplicationError && e.code === "unauthenticated")) hostedFailure("mcp.stream", e); };
  // A full check under one generation read, which its stamp keeps: a commit after the read moves the generation and
  // stales the stamp. The notice number is read before it, so a notice during the check stales it too.
  async function fullCheck(context: Context, rest: (checked: Checked) => Checked, uris: () => Iterable<string> = () => []): Promise<{ gen: string | undefined; start: number; checked: Checked }> {
    const start = seq;
    checking.set(context, start);
    try {
      // authRead reads the generation and pins it for the body, where authGeneration returns the pin. A failed read
      // there rejects authRead, and the caller closes the stream with reason `failed`: the check fails closed, as
      // its own token read would. An undefined generation (no pin) stamps nothing; the next tick checks in full.
      return await application.repo.authRead(async () => {
        const gen = application.repo.authGeneration();
        await testPauseAsync("mcp:stream:check");
        return { gen, start, checked: rest(await authorizeFor(context, uris)) };
      });
    } finally { checking.delete(context); }
  }
  // `context`: the live's as the tick queued it; an attach that re-selected it since leaves the answer unused.
  async function checkLive(live: Live, context: Context, t: number) {
    try {
      const { gen, start, checked } = await fullCheck(context, checked => validChecked(live, checked), () => live.uris.keys());
      // Stopped, or re-selected by an attach, while the check awaited: its answer is about a context the live no
      // longer has.
      if (closed || live.stopped || live.context !== context) return;
      stamp(context, gen, t, start, checked);
      adopt(live, checked);
    } catch (e) {
      if (closed || live.stopped || live.context !== context) return;
      stamps.delete(context); unexpected(e); streamClosed(context, e); live.stop();
    }
  }
  // Phase B's board check for a native live phase A passed (`validStamped`'s "boards"): its uris' visibility read
  // now, judged with no await since, as `capability` judges a full check's (#807 P3 B5a2). A uri a control added while
  // the read awaited waits for the next tick; a lost board stops the live.
  async function checkBoards(live: Live, context: Context) {
    checking.set(context, seq);
    try {
      const boards = await boardFacts(context, live.uris.keys());
      await testPauseAsync("mcp:board:checked");
      if (closed || live.stopped || live.context !== context) return;
      if (!boardsOf(context, live.uris.keys()).every(b => boards.has(b))) return;
      for (const [uri, cap] of live.uris) if (capability(context, uri, { row: live.bound.row, seq, boards }) !== cap) throw new ApplicationError("not_found", "resource not found");
    } catch (e) {
      if (closed || live.stopped || live.context !== context) return;
      stamps.delete(context); unexpected(e); streamClosed(context, e); live.stop();
    } finally { checking.delete(context); }
  }
  async function checkStream(stream: OwnedStream, context: Context, t: number) {
    const current = () => !closed && streamContexts.get(stream) === context;
    try {
      const { gen, start, checked } = await fullCheck(context, checked => checked);
      if (current()) stamp(context, gen, t, start, checked);
    } catch (e) {
      // A stream that ended while the check awaited still gets its close row: a stop that audits nothing (a resource
      // watch's close) leaves it to this check, and streamClosed skips a client's own close and a second row. One an
      // attach moved to another context is that context's to check.
      if (closed) return;
      const held = streamContexts.get(stream);
      if (held !== undefined && held !== context) return;
      stamps.delete(context); unexpected(e); streamClosed(context, e);
      if (held === context) track(stream.stop());
    }
  }
  // A legacy session's grant and token, checked after its awaits against the session as it then stands: one a POST
  // re-authorized meanwhile (a new principal) or that moved between active and dormant waits for the next tick.
  async function sweepLegacy(legacy: Legacy) {
    sweeping.add(legacy);
    const principal = legacy.principal, dormant = !!legacy.dormant;
    const same = () => !closed && !legacy.stopped && legacy.principal === principal && !!legacy.dormant === dormant;
    try {
      if (dormant) {
        const active = await oauth.isGrantActive(principal.grantId);
        if (!same()) return;
        if (!active) drop(legacy, "grant_ended");
        // An in-flight POST keeps its transport; idleness counts from dormancy or the last request, whichever is later.
        else if (legacy.posts === 0 && now() - Math.max(legacy.dormant!.since, legacy.lastUsed) >= 60_000) drop(legacy, "idle");
        return;
      }
      const authorized = await oauth.isAuthorized(principal);
      const sleeps = !authorized && principal.accessExpiry <= now() && await oauth.isGrantActive(principal.grantId);
      await testPauseAsync("mcp:legacy:sweep");
      if (!same()) return;
      // Its GET's close row is written here, as sleep writes it, so a revoke audits the stream whichever of this
      // sweep and the GET's own check settles first (streamClosed writes one row per context).
      if (!authorized) {
        if (sleeps) sleep(legacy);
        else { if (legacy.stream) streamClosed(legacy.stream.context, new ApplicationError("unauthenticated", "unauthenticated")); retire(legacy); }
      }
      else if (!legacy.stream && legacy.posts === 0 && now() - legacy.lastUsed >= 60_000) retire(legacy);
    } catch {
      if (!same()) return;
      if (dormant) drop(legacy, "failed", true); else retire(legacy, true);
    } finally { sweeping.delete(legacy); }
  }
  const timer = setInterval(() => {
    // A live's stream is in streamContexts too (wrap adds both): valid() just authorized its context (#853).
    // Phase A, synchronous, from the auth cache (#899, #807 P3 A7d): a fresh stamp's checks, which read no hosted row
    // and write nothing. A stale stamp or an auth cache miss waits for phase B's full check, whose settle may commit.
    const owned = new Set<Context>(), full: [Live, Context][] = [], boardsDue: [Live, Context][] = [], fullStreams: [OwnedStream, Context][] = [];
    const t = now();
    let peek: AuthPeek | undefined;
    // A failed generation read leaves every context to phase B, whose own checks close the ones that fail.
    try { peek = application.repo.authPeek(); } catch { peek = undefined; }
    for (const live of [...lives]) {
      if (live.stopped) continue;
      owned.add(live.context);
      if (checking.has(live.context)) continue;
      const s = peek && fresh(live.context, peek.generation, t);
      try {
        const v = s && validStamped(live, s, peek!);
        if (v === true) continue;
        if (v === "boards") { boardsDue.push([live, live.context]); checking.set(live.context, seq); continue; }
      }
      catch (e) { unexpected(e); streamClosed(live.context, e); live.stop(); continue; }
      full.push([live, live.context]); checking.set(live.context, seq);
    }
    for (const [stream, context] of streamContexts) {
      if (owned.has(context) || checking.has(context)) continue;
      try { if (peek && fresh(context, peek.generation, t) && authPeekCheck(context, peek)) continue; }
      catch (e) { unexpected(e); streamClosed(context, e); track(stream.stop()); continue; }
      fullStreams.push([stream, context]); checking.set(context, seq);
    }
    const legacies = [...legacyDormant, ...legacyAll].filter(legacy => !sweeping.has(legacy));
    for (const legacy of legacies) sweeping.add(legacy);
    // Phase B: the full checks and the legacy sweep, async; nothing waits for them but close, and a test that
    // drives the timer by hand, to which it's returned.
    const phaseB = Promise.all([
      bounded(full, ([live, context]) => checkLive(live, context, t)),
      bounded(boardsDue, ([live, context]) => checkBoards(live, context)),
      bounded(fullStreams, ([stream, context]) => checkStream(stream, context, t)),
      bounded(legacies, sweepLegacy),
    ]).then(() => {}, e => hostedFailure("mcp.stream", e));
    track(phaseB);
    // A notice older than every stamp can't make one stale.
    if (t - prunedAt >= recheckMs) {
      prunedAt = t;
      let oldest = seq;
      for (const live of lives) oldest = Math.min(oldest, stamps.get(live.context)?.seq ?? oldest);
      for (const context of streamContexts.values()) oldest = Math.min(oldest, stamps.get(context)?.seq ?? oldest);
      for (const start of checking.values()) oldest = Math.min(oldest, start);
      for (const [id, n] of changedAt) if (n <= oldest) changedAt.delete(id);
      prunedThrough = oldest;
    }
    return phaseB;
  }, 1000);
  timer.unref();
  function wrap(response: Response, context: Context | undefined, live?: Live, done?: () => void) {
    response.headers.set("Cache-Control", "private, no-store");
    if (!response.body || !response.headers.get("Content-Type")?.includes("text/event-stream") || !context) {
      live?.stop(); context?.finish(); done?.(); return response;
    }
    // A legacy GET's headers would otherwise wait for its first hint or the 5 s keepalive, and
    // omp abandons a GET whose headers take over 1 s (#431). No event store backs this transport,
    // so the first bytes are the SDK's keepalive comment, not an id-bearing priming event that
    // would invite a Last-Event-ID resumption it can't serve.
    const wrapped = forwardMcpStream(response, context.request.signal, () => {
      forwarding.delete(wrapped.stream);
      streamContexts.delete(wrapped.stream);
      live?.stop(); context.finish(); done?.();
    }, live?.legacy ? new TextEncoder().encode(LEGACY_GET_PRIME) : undefined);
    forwarding.add(wrapped.stream);
    streamContexts.set(wrapped.stream, context);
    if (live) { live.stream = wrapped.stream; if (live.stopped) track(wrapped.stream.stop()); }
    return wrapped.response;
  }
  return {
    sessions: hosted,
    delivery,
    get activeContexts() { return contexts.size; },
    // O(1) reads for the metrics scrape (#805): admissions held per capacity kind, exchanges in flight.
    get capacityUsed(): Readonly<Record<CapacityKind, number>> { return { ...used }; },
    get pendingExchanges() { return pendingRequests.size; },
    get activeLeases() { return delivery.activeLeaseCount; },
    get activeResourceContexts() { return principals.size; },
    get activeStreams() { return forwarding.size; },
    get activeWatches() { return resources.activeWatchCount; },
    get activeBusListeners() { return busListeners; },
    get activeListens() { return [...lives].filter(l => !l.legacy).length; },
    get activeGetStreams() { return [...lives].filter(l => !!l.legacy).length; },
    get activeInboxListeners() { return [...lives].filter(l => l.uris.has("grayboard://inbox")).length; },
    get activeLegacySessions() { return legacyAll.size; },
    get dormantLegacySessions() { return legacyDormant.size; },
    get activePosts() { return posts; },
    async fetch(original: Request, address = "unknown"): Promise<Response> {
      const boundary: Exchange = { request: original, address, protocol: MCP_PROTOCOL_VERSIONS.includes(original.headers.get("Mcp-Protocol-Version") ?? "") ? original.headers.get("Mcp-Protocol-Version")! : "unspecified" };
      if (closed) return new Response("MCP endpoint is closed", { status: 503 });
      if (!permitsOrigin(original.headers.get("Origin"), trustedOrigin)) { logRefusal("origin", boundary); return Response.json({ code: "forbidden", message: "invalid origin" }, { status: 403 }); }
      let role: HostedRole;
      try { role = hostedRole(original); } catch { return Response.json({ code: "bad_request", message: "unknown X-Grayboard-Client role" }, { status: 400 }); }
      const post = original.method === "POST";
      let principal: OAuthPrincipal;
      let postReservation: (() => void) | undefined;
      try {
        const authenticated = await oauth.authenticate(original, roleScopes(role));
        // Closed while the check awaited (#807 P3 A7c): the same answer as closed before it.
        if (closed) return new Response("MCP endpoint is closed", { status: 503 });
        if (authenticated instanceof Response) return authenticated;
        principal = authenticated;
        boundary.principal = principal.authed.user_id;
        postReservation = post ? reserve("post", principal) : undefined;
      } catch (error) { report(error, "hosted-fetch", boundary); return Response.json({ code: "internal", message: "internal error" }, { status: 500 }); }
      if (post && !postReservation) return new Response("MCP request capacity reached", { status: 429 }); // counted in reserve()
      let released = false, legacyPost: Legacy | undefined;
      const releasePost = () => {
        if (post && !released) { released = true; posts--; postReservation!(); }
        if (legacyPost) { legacyPost.posts--; legacyPost.lastUsed = now(); legacyPost = undefined; }
      };
      if (post) posts++;
      if (pendingRequests.size >= exchangeCap) { releasePost(); countRefusal("mcp_exchange"); return new Response("MCP exchange capacity reached", { status: 429 }); }
      let finishRequest!: () => void;
      const pendingRequest = new Promise<void>(resolve => { finishRequest = resolve; });
      pendingRequests.add(pendingRequest);
      try {
        const body = post ? await readBody(original) : { request: original, parsedBody: undefined };
        if (body instanceof Response) { releasePost(); return body; }
        const req = body.request;
        const parsed = body.parsedBody as { id?: string | number | null; method?: unknown; params?: { _meta?: unknown; name?: unknown } } | undefined;
        return await exchanges.run({ ...boundary, request: req, meta: parsed?.params?._meta, id: parsed?.id, method: parsed?.method, call: parsed?.method === "tools/call" ? parsed.params?.name : undefined }, async () => {
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
            const legacyRequest = !modernMethod && (req.method === "POST" && body.parsedBody === undefined || !(req.method === "POST" && claimsModern(body.parsedBody)) && await isLegacyRequest(req, body.parsedBody));
            if (!legacyRequest) {
              // Only a body naming the method can parse, so the schema's zod parse runs on listens alone (#940).
              const listen = isPlainObject(body.parsedBody) && body.parsedBody.method === "subscriptions/listen" ? SubscriptionsListenRequestSchema.safeParse(body.parsedBody) : undefined;
              if (listen?.success) {
                releaseListen = reserve("listen", principal);
                if (!releaseListen) { releasePost(); return new Response("MCP listen capacity reached", { status: 429 }); } // counted in reserve()
                const context = exchange.context = await select(req);
                const uris = listen.data.params.notifications.resourceSubscriptions ?? [];
                if (uris.length > caps.watches.perSession) { countRefusal("resource_watch"); throw new ApplicationError("bad_request", "resource watch capacity reached"); }
                const checked = await authorize(context, undefined, true, uris);
                const authorized = new Map(uris.map(uri => [uri, watchable(context, uri, checked)]));
                ownHandler = createMcpHandler(modernFactory, { legacy: "reject", keepAliveMs: 5000, bus: isolatedBus(), onerror: error => report(error) });
                live = makeLive(context, checked, authorized, ownHandler);
                response = await ownHandler.fetch(req, { parsedBody: body.parsedBody });
              } else {
                exchange.context = await select(req);
                response = await modern.fetch(req, { parsedBody: body.parsedBody });
              }
            } else {
              const sid = req.headers.get("Mcp-Session-Id");
              let legacy = sid ? legacySessions.get(sid) : undefined;
              if (sid && !legacy) { releasePost(); return new Response("unknown MCP session", { status: 404 }); }
              // A GET or DELETE replays the creating POST's `_meta` for routing; its model and effort are stale by then (#364).
              if (req.method !== "POST" && legacy) exchange.meta = withoutFacts(legacy.meta);
              const context = exchange.context = await select(req);
              // The timer may have dropped this sid while identity selection awaited.
              if (legacy?.stopped) { context.finish(); releasePost(); return new Response("unknown MCP session", { status: 404 }); }
              if (legacy?.dormant) {
                // A dormant sid is never resurrected for another binding: 404 tells its client to re-initialize (#476).
                // Only its own user under a new grant drops it; a stranger's guess leaves it to the idle reclaim.
                if (!matches(legacy.binding, binding(context))) {
                  const own = legacy.binding.user === principal.authed.user_id && legacy.binding.email === principal.authed.user_email;
                  if (own && legacy.binding.grant !== principal.grantId) drop(legacy, "grant_changed", false, { new_grant: principal.grantId });
                  context.finish(); releasePost(); return new Response("unknown MCP session", { status: 404 });
                }
                // Teardown needs no admission.
                if (req.method === "DELETE") { drop(legacy, "deleted"); context.finish(); releasePost(); return new Response(null, { status: 200 }); }
                const release = reserve("legacy", principal, { ref: legacy.ref });
                if (!release) { context.finish(); releasePost(); return new Response("MCP session capacity reached", { status: 429 }); } // counted in reserve()
                const since = legacy.dormant.since;
                legacy.dormant.release();
                legacy.dormant = undefined;
                legacyDormant.delete(legacy);
                legacy.release = release;
                legacy.principal = principal;
                legacyAll.add(legacy);
                legacyAudit(legacy, "hosted.legacy_rehydrated", { dormant_ms: now() - since });
              }
              if (legacy && !matches(legacy.binding, binding(context))) { context.finish(); releasePost(); return new Response("MCP session binding mismatch", { status: 403 }); }
              if (!legacy) {
                if (req.method !== "POST") { context.finish(); releasePost(); return new Response("missing MCP session", { status: 400 }); }
                const release = reserve("legacy", principal);
                if (!release) { context.finish(); releasePost(); return new Response("MCP session capacity reached", { status: 429 }); } // counted in reserve()
                legacy = { ref: crypto.randomUUID(), meta: exchange.meta, binding: binding(context), principal, release, subscriptions: new Map(), posts: 0, lastUsed: now(), stopped: false, controls: Promise.resolve() } as Legacy;
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
                // A stopped stream's prune of its lost boards first, so a lost board's registration doesn't refuse
                // this GET (#807 P3 B5a2).
                await legacy.pruning;
                const registered = legacy;
                const checked = await authorizeFor(context, () => registered.subscriptions.keys());
                await testPauseAsync("mcp:legacy:get-checked");
                // Another GET took the stream, or the timer retired or parked the session, while the check awaited (#807 P3 A7d).
                if (legacy.stopped || legacy.dormant) { context.finish(); releasePost(); return new Response("unknown MCP session", { status: 404 }); }
                if (legacy.stream) { context.finish(); releasePost(); return new Response("MCP GET already active", { status: 409 }); }
                const uris = new Map<string, string | null>();
                for (const [uri, cap] of legacy.subscriptions) {
                  if (watchable(context, uri, checked) !== cap) throw new ApplicationError("not_found", "resource not found");
                  uris.set(uri, cap);
                }
                live = makeLive(context, checked, uris, undefined, legacy);
                if (idle(live)) context.session.listed = false;
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
      for (const legacy of [...legacyDormant]) drop(legacy, "shutdown");
      for (const legacy of [...legacyAll]) retire(legacy);
      // A failed drain or lease detach mustn't skip the final heartbeat or leave
      // the hosted timer running against a closed database (#423).
      try { await Promise.all([...forwarding].map(stream => stream.stop())); }
      finally { try { unlistenHosted(); unwatchHosted(); resources.close(); delivery.close(); } finally { await hosted.close(); } }
      await modern.close();
      await Promise.allSettled([...bodyReads]);
      while (closing.size) await Promise.all([...closing]);
      for (const context of [...contexts]) context.finish();
    },
  };
}

// Built once per process, not per request (#811): `fromJsonSchema` compiles through the SDK's process-wide
// ajv validator, which caches by schema object identity and never evicts, so a fresh object per
// registration retained a compiled validator on every hosted request. The wrapper is stateless.
const sharedTool = (tool: ToolDef) => ({
  description: tool.description,
  ...(tool._meta ? { _meta: tool._meta } : {}),
  inputSchema: fromJsonSchema<Record<string, unknown>>({ ...tool.inputSchema, additionalProperties: false } as Parameters<typeof fromJsonSchema>[0]),
});
const NATIVE_BOARD_TOOLS = boardTools({ teams: true, attachments: "ids" }).map(tool => ({ name: tool.name, config: sharedTool(tool) }));
const NATIVE_DM_TOOLS = Object.fromEntries(dmTools({ attachments: "ids" }).map(t => [t.name, sharedTool(t)])) as Record<"dm_send" | "dm_history" | "dm_thread", ReturnType<typeof sharedTool>>;
const NATIVE_DELEGATE_INPUT = fromJsonSchema<{ persona: string; task: string; context?: string; to?: string }>({ ...DELEGATE_TOOL.inputSchema, additionalProperties: false } as Parameters<typeof fromJsonSchema>[0]);
const DM_INBOX_INPUT = z.strictObject({ days: z.number().positive().max(MAX_INBOX_DAYS).optional() });
const DM_ACK_INPUT = z.strictObject({ message_id: z.union([id, ids.min(1)]) });
const DM_RETRACT_INPUT = z.strictObject({ message_id: id });
const WHOAMI_INPUT = z.strictObject({});

// The SDK converts a tool's inputSchema to JSON Schema on every modern tools/call (its Mcp-Param header scan) and
// caches the result on the McpServer, which the modern entry builds per request, so the cache never hits (#950).
// Every inputSchema above is built once per process, so one conversion per schema object serves every server.
// `_registeredTools` is the SDK's private registry (pinned by mcp_schema_cache.test.ts); without it, or for a
// disabled tool, this defers to the SDK unchanged.
const INPUT_SCHEMA_JSON = new WeakMap<object, Record<string, unknown>>();
type RegisteredTools = Record<string, { enabled: boolean; inputSchema?: object } | undefined>;
export class HostedMcpServer extends McpServer {
  override toolInputSchemaJson(name: string): Record<string, unknown> | undefined {
    const tool = (this as unknown as { _registeredTools?: RegisteredTools })._registeredTools?.[name];
    if (!tool?.enabled || tool.inputSchema === undefined) return super.toolInputSchemaJson(name);
    let json = INPUT_SCHEMA_JSON.get(tool.inputSchema);
    if (json === undefined) {
      json = super.toolInputSchemaJson(name);
      if (json !== undefined) INPUT_SCHEMA_JSON.set(tool.inputSchema, json);
    }
    return json;
  }
}

function registerNativeTools(server: McpServer, application: Application, hosted: HostedSessions, current: (ctx: ServerContext) => Promise<Context>, report: (error: unknown, tool: string) => void, refuse: (code: string) => void) {
  // A pending alias_lost notice (#453) rides after the result, success or refusal, as the plugin's do; `_meta`
  // marks it, so a host caching this session's instructions fetches them again.
  const said = (result: CallToolResult, notice: string | undefined): CallToolResult => notice
    ? { ...withNotices(result, [notice]), _meta: { ...result._meta, [GRAYBOARD_ALIAS_LOST_META]: true } } : result;
  // Every tool error carries its code in structuredContent (#806), as the subscriber role's do; the text, which
  // the agent reads, stays `error: <message>`.
  const shown = (e: unknown) => e instanceof ApplicationError && e.code !== "internal" || e instanceof CoreError ? e.message : "internal error";
  const refusal = (e: unknown): CallToolResult => ({ ...text(`error: ${shown(e)}`), structuredContent: domainData(e), isError: true });
  const run = async (ctx: ServerContext, tool: string, call: (session: ApplicationSession, tx: Tx) => unknown): Promise<CallToolResult> => {
    let notice: string | undefined;
    try {
      return said(text(await timeTool(tool, async () => { const context = await current(ctx); return hosted.run(context.principal, context.sessionContext, tool, call, n => { notice = n; }, context.verdict); }) ?? "ok"), notice);
    }
    catch (e) {
      report(e, tool);
      return said(refusal(e), notice);
    }
  };
  server.registerTool("whoami", { description: "This request's current session binding, or unbound candidates.", inputSchema: WHOAMI_INPUT }, async (_, ctx) => {
    let notice: string | undefined;
    try {
      return said(text(await timeTool("whoami", async () => { const context = await current(ctx); return hosted.whoami(context.principal, context.sessionContext, n => { notice = n; }); })), notice);
    } catch (e) { report(e, "whoami"); return said(refusal(e), notice); }
  });
  // The JSON text names the same code as structuredContent (#843): `internal_error` for a fault, `refused` for a core refusal.
  const bindRefusal = (e: unknown, tool: string) => {
    report(e, tool);
    if (e instanceof ApplicationError && ["identity_unknown", "alias_held", "bad_request", "forbidden", "not_found"].includes(e.code)) refuse(e.code);
    const data = domainData(e);
    return { ...text({ code: data.code, message: shown(e), ...(e instanceof ApplicationError && e.code !== "internal" ? e.extra : {}) }), structuredContent: data, isError: true };
  };
  // The shared bind/unbind definitions (BIND_TOOL, UNBIND_TOOL), with the hosted input both roles take.
  server.registerTool(BIND_TOOL.name, { description: BIND_TOOL.description, _meta: BIND_TOOL._meta,
    inputSchema: HOSTED_BIND_INPUT }, async (args, ctx) => {
    try { return await timeTool("bind", async () => { const context = await current(ctx); return hosted.bind(context.principal, context.sessionContext, args, context.declared); }); }
    catch (e) { return bindRefusal(e, "bind"); }
  });
  server.registerTool(UNBIND_TOOL.name, { description: UNBIND_TOOL.description, inputSchema: HOSTED_UNBIND_INPUT }, async (args, ctx) => {
    try { return await timeTool("unbind", async () => { const context = await current(ctx); return hosted.unbind(context.principal, context.sessionContext, args, context.declared); }); }
    catch (e) { return bindRefusal(e, "unbind"); }
  });
  // The definitions local serves too (src/core/tools.ts), with files named by uploaded IDs (#385).
  for (const { name, config } of NATIVE_BOARD_TOOLS) {
    server.registerTool(name, config, (args, ctx) => run(ctx, name, (session, tx) => application.call(tx, session, name, args)));
  }
  const dm = NATIVE_DM_TOOLS;
  server.registerTool("dm_send", dm.dm_send,
    (a, ctx) => run(ctx, "dm_send", (session, tx) => application.send(tx, session, a.to as string, a.body as string, a as Parameters<typeof application.send>[4])));
  server.registerTool(DELEGATE_TOOL.name, {
    description: DELEGATE_TOOL.description,
    inputSchema: NATIVE_DELEGATE_INPUT,
  }, (a, ctx) => run(ctx, "delegate", (session, tx) => application.delegate(tx, session, a)));
  server.registerTool("dm_history", dm.dm_history,
    (a, ctx) => run(ctx, "dm_history", (session, tx) => application.history(tx, session, a as Parameters<typeof application.history>[2])));
  server.registerTool("dm_thread", dm.dm_thread, (a, ctx) => run(ctx, "dm_thread", (session, tx) => application.thread(tx, session, a.thread as number)));
  server.registerTool(DM_INBOX_TOOL.name, { description: DM_INBOX_TOOL.description, _meta: DM_INBOX_TOOL._meta, inputSchema: DM_INBOX_INPUT },
    (a, ctx) => run(ctx, "dm_inbox", (session, tx) => application.inbox(tx, session, a.days)));
  server.registerTool(DM_ACK_TOOL.name, {
    description: DM_ACK_TOOL.description, _meta: DM_ACK_TOOL._meta, inputSchema: DM_ACK_INPUT,
  }, async (a, ctx) => {
    const acked: number[] = [], missing: number[] = [];
    const result = await run(ctx, "dm_ack", async (session, tx) => {
      for (const n of new Set(Array.isArray(a.message_id) ? a.message_id : [a.message_id])) {
        try { await application.acknowledgeDm(tx, session, n); acked.push(n); } catch (e) {
          if (!(e instanceof ApplicationError) || e.code !== "not_found") throw e;
          missing.push(n);
        }
      }
      return ackResult(acked, missing).text;
    });
    return { ...result, ...(missing.length && !acked.length && !result.isError ? { structuredContent: { code: "not_found" }, isError: true } : {}) };
  });
  server.registerTool(DM_RETRACT_TOOL.name, { description: DM_RETRACT_TOOL.description, inputSchema: DM_RETRACT_INPUT },
    (a, ctx) => run(ctx, "dm_retract", (session, tx) => application.retract(tx, session, a.message_id)));
}
