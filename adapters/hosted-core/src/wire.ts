import { Client, InsufficientScopeError, SdkError, SdkErrorCode, SdkHttpError, StreamableHTTPClientTransport, type AuthProvider, type CallToolResult, type Tool } from "@modelcontextprotocol/client";
import type { Delivery, SessionFacts } from "./port.js";
import { setTimeout as sleep } from "node:timers/promises";

export const DELIVERY_META = "io.github.nolnoch.grayboard/delivery";
export const LAUNCHER_META = "io.github.nolnoch.grayboard/launcher";
// The harness's current model and effort for a session (#364): the server keeps the latest each request reports.
export const MODEL_META = "io.github.nolnoch.grayboard/model";
export const EFFORT_META = "io.github.nolnoch.grayboard/effort";
// The name the harness would suggest for a session (#443, #522): the server keeps the first an ownership's requests carry.
export const SUGGESTED_META = "io.github.nolnoch.grayboard/suggested";
// `facts` is read per request, for the session that request names, so a change mid-session (a model switch) reaches the server on the next one.
// `suggested` too, on every wire: whichever request reaches the server first fixes the ownership's suggestion (#522).
export type WireOptions = { url: string; sessionKey: string; client: { name: string; version: string }; delivery?: Delivery; launcher?: true; facts?: (sessionID: string) => SessionFacts | undefined; suggested?: (sessionID: string) => string | undefined;
  // An ending-only wire (session_end, delivery_release): it names its session only in its tool calls' own `_meta`, so its
  // connect selects no session and the server admits none for it, an already-ended id included (#1099).
  ending?: true };

export class SubscriberError extends Error {
  constructor(readonly code: string, readonly known?: string[], readonly holder?: string) { super(`Subscriber refused (${code})${known?.length ? `; known names: ${known.join(", ")}` : ""}${holder ? `; held by ${holder}` : ""}`); }
}
// Server free text the host shows (an alias_held holder, an alias_lost reason): bounded, and no control or bidi characters.
export const shownText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 2048 && !/[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/.test(value);
// Server-supplied error text an agent reads (an HTTP error body, a refusal's message): at most
// SERVER_TEXT_LIMIT characters, with what was cut said, so a misbehaving server or a proxy's HTML
// page can't flood the agent's context (#276).
export const SERVER_TEXT_LIMIT = 512;
export const serverText = (text: string): string =>
  text.length <= SERVER_TEXT_LIMIT ? text : `${text.slice(0, SERVER_TEXT_LIMIT)}… (${text.length - SERVER_TEXT_LIMIT} more characters cut)`;
// Caps the message of every error on a cause chain in place: the SDK puts a failed POST's
// whole response body in its message, and a wrapper can repeat a cause's message.
export function capServerText(error: unknown): void {
  for (let e = error, depth = 0; e && depth < 8; e = (e as { cause?: unknown }).cause, depth++) {
    if (e instanceof Error && e.message.length > SERVER_TEXT_LIMIT) e.message = serverText(e.message);
  }
}
export class LeaseUnavailable extends SubscriberError {
  constructor(code: "not_found" | "unbound" = "not_found") { super(code); }
}
// The server's refusal codes hosted-core keeps; any other code reads invalid_response. session_register's own
// refusals are here so a degraded root's diagnostic names the real one (#1349).
const domainCodes = new Set(["identity_unknown", "alias_held", "not_found", "unbound", "refused", "internal_error", "bad_request", "unauthenticated", "forbidden", "rate_limited", "receipt_capacity", "child_bound", "child_registered_elsewhere", "has_children", "root_is_child", "invalid_registration"]);
export function subscriberError(value: unknown, leaseOperation: boolean): SubscriberError {
  const code = (value as { code?: unknown } | undefined)?.code;
  const domain = typeof code === "string" && domainCodes.has(code) ? code : "invalid_response";
  const suggestions = (value as { known?: unknown } | undefined)?.known;
  const known = domain === "identity_unknown" && Array.isArray(suggestions) && suggestions.length <= 256 && suggestions.every(name => typeof name === "string" && /^[a-z0-9_-]{1,32}$/.test(name)) ? [...new Set(suggestions as string[])] : undefined;
  const holder = (value as { holder?: unknown } | undefined)?.holder;
  return leaseOperation && (domain === "not_found" || domain === "unbound") ? new LeaseUnavailable(domain) : new SubscriberError(domain, known, domain === "alias_held" && shownText(holder) ? holder : undefined);
}
// The server refused the connection's first request (server/discover or
// initialize) with an HTTP status the SDK would report only as a failed
// version negotiation; `status` and `body` are the server's own, so a bad
// delivery declaration or session key is diagnosable (#430).
export class ConnectRefused extends SubscriberError {
  constructor(readonly status: number, readonly body: string) {
    let code: unknown;
    try { code = (JSON.parse(body) as { code?: unknown } | null)?.code; } catch {}
    super(typeof code === "string" && domainCodes.has(code) ? code : "invalid_response");
    this.message = `Server refused the connection (HTTP ${status}): ${serverText(body)}`;
  }
}

// The server can't be reached right now (stopped, restarting, behind a
// failing gateway, or hung). Hosted leases don't count server downtime
// (#423), so the controller keeps retrying these without spending its budget.
export class ServerUnreachable extends Error {
  constructor(cause: unknown) { super("Server unreachable", { cause }); }
}
// A connect (`server/discover`, `initialize`) still refused `rate_limited` when
// its retries or its timeout ran out (#1536): the server is up but at capacity. A ServerUnreachable,
// so every outage path retries it rather than reading the SDK's causeless
// version-negotiation failure the 429 would otherwise become.
// Its own message, so every warning that prints the raw error says capacity, not unreachable (#1553); a hint that
// isn't a positive finite number reads as one second, so no caller's wait floor can collapse to zero.
export class ServerBusy extends ServerUnreachable {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    const ms = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 1000;
    super(new Error(`server at capacity (rate_limited); retry after ${ms} ms`));
    this.retryAfterMs = ms;
    this.message = "Server at capacity";
  }
}
// A tool call's request left, then the transport failed (a reset, a gateway
// 502-504, a stream cut short, a timeout): the server may have run it, so the
// agent checks before calling again (#1345, the Rust SDK's OutcomeUnknown). A
// ServerUnreachable still, so every outage check (retry, drop) holds.
export class OutcomeUnknown extends ServerUnreachable {
  constructor(cause: unknown) {
    super(cause);
    this.message = "Server unreachable mid-call; it may have taken effect, so check (dm_history, board_read, claim_list) before calling it again";
  }
}
// The server closed the inbox stream: an outage, or a refusal (expired
// access, rebind, revocation) the reconnect will classify. Never itself
// proof of an outage (#423).
export class SubscriptionClosed extends Error {
  constructor() { super("Subscription closed"); }
}
// The server answered 403 insufficient_scope (the wire keeps the SDK's
// onInsufficientScope: "throw"): only a new sign-in with both scopes restores
// access, never a refresh. The Controller reports it as AccessExpired.
export class InsufficientScope extends Error {
  constructor(cause: unknown) { super("Grayboard access lacks a required scope", { cause }); }
}
// SDK 2.4.0 raises its own InsufficientScopeError for that 403, not an
// SdkHttpError, and wraps it in EraNegotiationFailed during connect.
function scopeRefusal(error: unknown): boolean {
  for (let e = error, depth = 0; e && depth < 8; e = (e as { cause?: unknown }).cause, depth++) {
    if (e instanceof InsufficientScopeError || e instanceof SdkHttpError && e.status === 403) return true;
  }
  return false;
}
const networkCodes = new Set(["ECONNREFUSED", "ConnectionRefused", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "FailedToOpenSocket"]);
// A failure to open the socket: no request left, so even a write is safe to call again.
const connectCodes = new Set(["ECONNREFUSED", "ConnectionRefused", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "FailedToOpenSocket"]);
const gatewayStatuses = new Set([502, 503, 504]);
// Walks the cause chain: the SDK rethrows fetch failures from requests, but
// wraps them during connect (SdkError EraNegotiationFailed {cause}).
export function unreachable(error: unknown): boolean {
  for (let e = error, depth = 0; e && depth < 8; e = (e as { cause?: unknown }).cause, depth++) {
    if (e instanceof ServerUnreachable) return true;
    if (e instanceof SdkHttpError && gatewayStatuses.has(e.status)) return true;
    if (e instanceof SdkError && (e.code === SdkErrorCode.RequestTimeout || e.code === SdkErrorCode.ConnectionClosed)) return true;
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && networkCodes.has(code)) return true;
  }
  return false;
}

// The server's listen cap refused a listen (`src/server/mcp.ts` `reserve`): a plain-text 429 with this exact body and
// no `rate_limited` data, so the fetch wrapper hands it back unretried and the SDK raises it as an SdkHttpError. Only
// this body: another plain 429 is no listen-slot race (#1394).
export const LISTEN_CAPACITY = "MCP listen capacity reached";
export function listenCapacity(error: unknown): boolean {
  for (let e = error, depth = 0; e && depth < 8; e = (e as { cause?: unknown }).cause, depth++) {
    if (e instanceof SdkHttpError && e.status === 429 && e.data.text === LISTEN_CAPACITY) return true;
  }
  return false;
}

// A tool call's raw failure, before reachable() classifies it: an outage
// after its request may have left (anything but a socket that never opened)
// is OutcomeUnknown. A ServerUnreachable already is the credential's (a
// refresh before the request, or after a 401 or 429 the server refused it
// with), so nothing ran and it stays as it is.
function outcome(error: unknown): unknown {
  for (let e = error, depth = 0; e && depth < 8; e = (e as { cause?: unknown }).cause, depth++) {
    if (e instanceof ServerUnreachable) return error;
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && connectCodes.has(code)) return error;
  }
  return unreachable(error) ? new OutcomeUnknown(error) : error;
}

// Whether `error` is `signal`'s abort, by cause rather than timing (#1309): the reason itself, however deep a
// wrapper nested it (fetch and the SDK's requests rethrow it), or the SDK's restatement of it (an aborted wait
// or pre-check becomes a RequestTimeout SdkError carrying the reason's text).
export function abortOf(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  for (let e = error, depth = 0; e && depth < 8; e = (e as { cause?: unknown }).cause, depth++) {
    if (e === signal.reason || e instanceof SdkError && e.code === SdkErrorCode.RequestTimeout && e.message === String(signal.reason)) return true;
  }
  return false;
}

const connectMethods = new Set(["server/discover", "initialize"]);
async function methodOf(request: Request): Promise<string | undefined> {
  if (request.method !== "POST") return;
  const message = await request.clone().json().catch(() => undefined) as { method?: unknown } | undefined;
  return typeof message?.method === "string" ? message.method : undefined;
}

// One HTTP MCP connection to the hosted endpoint: the 429 retry, the
// unreachable classification and the connect-refusal capture both roles share.
abstract class Connection {
  readonly client: Client;
  admissionRetryAfterMs?: number;
  readonly connect: () => Promise<void>;
  private refusal?: ConnectRefused;
  private busy?: ServerBusy;
  protected constructor(protected readonly wireOptions: WireOptions, authProvider: AuthProvider, readonly signal: AbortSignal, beforeRetry?: () => Promise<void>) {
    this.client = new Client(wireOptions.client, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const endpoint = new URL(wireOptions.url);
    const transport = new StreamableHTTPClientTransport(endpoint, {
      authProvider, onInsufficientScope: "throw", requestInit: { redirect: "error" },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.url !== endpoint.href) throw new Error("Unexpected hosted destination");
        const outgoing = new Headers(request.headers);
        this.decorate(outgoing);
        const signal = AbortSignal.any([request.signal, this.signal]);
        const method = await methodOf(request);
        const connecting = method !== undefined && connectMethods.has(method);
        for (let attempt = 0; ; attempt++) {
          if (attempt) {
            // A guard's refusal or a credential's failure between tries is its own error, not the capacity wait's.
            try {
              await beforeRetry?.();
              const token = await authProvider.token();
              if (token) outgoing.set("Authorization", `Bearer ${token}`); else outgoing.delete("Authorization");
            } catch (error) { if (connecting) this.busy = undefined; throw error; }
          }
          signal.throwIfAborted();
          const response = await fetch(request.clone(), { headers: outgoing, redirect: "error", signal });
          if (connecting && !response.ok && ![401, 403, 429].includes(response.status) && !gatewayStatuses.has(response.status)) {
            this.refusal = new ConnectRefused(response.status, (await response.clone().text().catch(() => "")).slice(0, 4096));
          }
          const body = response.status === 429 ? await response.clone().json().catch(() => undefined) as { error?: { data?: { code?: string; retry_after_ms?: number } } } | undefined : undefined;
          const data = body?.error?.data;
          if (data?.code !== "rate_limited" || typeof data.retry_after_ms !== "number" || !Number.isFinite(data.retry_after_ms) || data.retry_after_ms <= 0) {
            if (connecting) this.busy = undefined;
            return response;
          }
          this.admissionRetryAfterMs = data.retry_after_ms;
          // Recorded on every refusal, not only the last: a wire whose own timeout fires mid-wait still fails as busy.
          if (connecting) this.busy = new ServerBusy(data.retry_after_ms);
          if (attempt === 7) return response;
          await response.body?.cancel().catch(() => {});
          await sleep(Math.ceil(data.retry_after_ms), undefined, { signal });
        }
      },
    });
    const send = transport.send.bind(transport);
    transport.send = (message, sendOptions) => {
      if ("method" in message) message = { ...message, params: { ...message.params, _meta: { ...this.meta(), ...message.params?._meta } } };
      return send(message, sendOptions);
    };
    this.connect = async () => {
      try { await this.reachable(this.client.connect(transport, { signal, timeout: 10_000 })); }
      // This wire's own timeout (AbortSignal.timeout) aborting a capacity wait is still the server's capacity; a stop is not.
      catch (error) { throw this.refusal ?? (!this.signal.aborted || (this.signal.reason as { name?: unknown } | undefined)?.name === "TimeoutError" ? this.busy : undefined) ?? error; }
    };
  }
  // Role headers and the `_meta` every request carries unless it names its own.
  protected abstract decorate(headers: Headers): void;
  protected abstract meta(): Record<string, unknown>;
  protected declaration(): Record<string, unknown> {
    return { ...(this.wireOptions.delivery ? { [DELIVERY_META]: this.wireOptions.delivery } : {}), ...(this.wireOptions.launcher ? { [LAUNCHER_META]: true } : {}) };
  }
  // The session's facts as `_meta`: a non-empty string as itself, `null` as an empty string (the server clears it, #558),
  // anything else as nothing; a provider that throws sends none (absence never clears on the server). HostedClient's
  // provider says its own failures; this guard keeps any other host's from failing the request. Its suggested name
  // rides with them, a non-empty string or nothing.
  protected facts(sessionID: string): Record<string, string> {
    let f: SessionFacts | undefined, suggested: unknown;
    try { f = this.wireOptions.facts?.(sessionID); } catch { f = undefined; }
    try { suggested = this.wireOptions.suggested?.(sessionID); } catch { suggested = undefined; }
    const wire = (v: unknown) => v === null ? "" : typeof v === "string" && v ? v : undefined;
    const model = wire(f?.model), effort = wire(f?.effort);
    return { ...(model === undefined ? {} : { [MODEL_META]: model }), ...(effort === undefined ? {} : { [EFFORT_META]: effort }),
      ...(typeof suggested === "string" && suggested ? { [SUGGESTED_META]: suggested } : {}) };
  }
  // An abort of this wire's own signal is the controller stopping, never an outage.
  protected async reachable<T>(pending: Promise<T>): Promise<T> {
    try { return await pending; }
    catch (error) {
      capServerText(error);
      if (!(error instanceof ConnectRefused) && scopeRefusal(error)) throw new InsufficientScope(error);
      throw !this.signal.aborted && !(error instanceof ServerUnreachable) && unreachable(error) ? new ServerUnreachable(error) : error;
    }
  }
  // `signal`: a caller's own abort (one tool call), on top of this wire's.
  options(signal?: AbortSignal) { return { signal: signal ? AbortSignal.any([this.signal, signal]) : this.signal, timeout: 10_000 }; }
  async close() { await this.client.close(); }
}

// The subscriber role: one session's lease, inbox and subscriber tools.
export class Wire extends Connection {
  capability?: string;
  constructor(options: WireOptions, authProvider: AuthProvider, signal: AbortSignal, readonly sessionID: string, beforeRetry?: () => Promise<void>) {
    super(options, authProvider, signal, beforeRetry);
  }
  protected decorate(headers: Headers) {
    headers.set("X-Grayboard-Client", "subscriber");
    if (this.capability) headers.set("X-Grayboard-Lease", this.capability);
  }
  // The `_meta` every request carries by default: none on an ending-only wire, whose connect then names no session.
  protected meta() { return this.wireOptions.ending ? {} : this.named(); }
  // The `_meta` that names this wire's session: its reads and tool calls carry it explicitly. An ending-only
  // wire's carries the session key alone: no facts or declaration for a session it is ending.
  private named() { return this.wireOptions.ending ? { [this.wireOptions.sessionKey]: this.sessionID } : { [this.wireOptions.sessionKey]: this.sessionID, ...this.declaration(), ...this.facts(this.sessionID) }; }
  async read(uri: string): Promise<unknown> {
    const value = await this.reachable(this.client.readResource({ uri, _meta: this.named() }, this.options())).catch(error => {
      // The SDK reconstructs JSON-RPC errors with numeric code and domain data.code.
      if (error?.code === -32602 || error?.code === -32603) throw subscriberError(error.data, uri === "grayboard://inbox");
      throw error;
    });
    if (value.contents.length !== 1 || !("text" in value.contents[0]!)) throw new Error("Invalid resource response");
    return JSON.parse(value.contents[0]!.text as string);
  }
  async call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const value = await this.reachable(this.client.callTool({ name, arguments: args, _meta: this.named() }, this.options()));
    if (value.isError) {
      throw subscriberError(value.structuredContent, name.startsWith("delivery_"));
    }
    if (value.structuredContent) return value.structuredContent;
    const content = value.content;
    if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== "text") throw new Error("Invalid delivery response");
    return JSON.parse(content[0].text as string);
  }
  // Whether this server's `tool` takes `arg`: an older server's strict schema refuses an argument it lacks.
  async takes(tool: string, arg: string): Promise<boolean> {
    let cursor: string | undefined;
    do {
      const page = await this.reachable(this.client.listTools(cursor === undefined ? {} : { cursor }, this.options()));
      const found = page.tools.find(t => t.name === tool);
      if (found) return Object.hasOwn(found.inputSchema.properties ?? {}, arg);
      cursor = page.nextCursor;
    } while (cursor);
    return false;
  }
  async listen() {
    const subscription = await this.reachable(this.client.listen({ resourceSubscriptions: ["grayboard://inbox"] }, this.options()));
    if (!subscription.honoredFilter.resourceSubscriptions?.includes("grayboard://inbox")) {
      await subscription.close();
      throw new Error("Server did not acknowledge inbox subscription");
    }
    return subscription;
  }
}

// The native role (no subscriber header): the agent-facing tool surface. Each
// call names its session in `_meta`; `sessionID`, when given, names the
// session for the connection's own requests (initialize, tools/list), so the
// server composes that session's instructions.
export class NativeWire extends Connection {
  constructor(options: WireOptions, authProvider: AuthProvider, signal: AbortSignal, readonly sessionID?: string, beforeRetry?: () => Promise<void>) {
    super(options, authProvider, signal, beforeRetry);
  }
  protected decorate() {}
  protected meta() { return { ...(this.sessionID === undefined ? {} : { [this.wireOptions.sessionKey]: this.sessionID, ...this.facts(this.sessionID) }), ...this.declaration() }; }
  instructions(): string | undefined { return this.client.getInstructions(); }
  async listTools(): Promise<Tool[]> {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.reachable(this.client.listTools(cursor === undefined ? {} : { cursor }, this.options()));
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }
  // The server's result untouched: content, structuredContent, isError, _meta.
  // Called on a connected wire, so an outage here may have come after the
  // request left: OutcomeUnknown unless the socket never opened.
  async callTool(name: string, args: Record<string, unknown>, sessionID: string, signal?: AbortSignal): Promise<CallToolResult> {
    const call = this.client.callTool({ name, arguments: args, _meta: { [this.wireOptions.sessionKey]: sessionID, ...this.declaration(), ...this.facts(sessionID) } }, this.options(signal));
    return this.reachable(call.catch(error => { throw this.signal.aborted ? error : outcome(error); }));
  }
}
