// The agent-facing grayboard tools a harness adapter (pi, omp, Claude Code)
// registers: the server's native tools/list (the committed snapshot before
// login, the live list after), calls forwarded with the session's `_meta`,
// local attachments, and each session's instructions. Every `/mcp` request
// needs a bearer (src/server/mcp.ts), so before login the snapshot is all an
// adapter can register, and a call returns one error naming the login action.
import { SdkError, SdkErrorCode, SdkHttpError, UnauthorizedError, type AuthProvider, type CallToolResult, type Tool } from "@modelcontextprotocol/client";
import { z } from "zod";
import snapshot from "./native-tools.json" with { type: "json" };
import type { CallOutcome, Controller } from "./controller.js";
import type { Operation } from "./diagnostics.js";
import { AccessExpired, accessExpiry, same } from "./model.js";
import { InsufficientScope, NativeWire, ServerUnreachable, unreachable, type WireOptions } from "./wire.js";
import {
  ATTACHMENTS_PARAM, ATTACHMENT_GET_TOOL, DEFAULT_ATTACHMENT_LIMITS, attachRoots, checkAttachmentId, downloadAttachment, publishedLimits, readAttachmentFiles, saveTarget,
  sendWithUploads, SendLanded, serverBusDir, type AttachmentLimits, type AttachmentTransport,
} from "../../../src/shared/attachments.ts";
import { describeFetchError, HTTP_TIMEOUT_MS, transferTimeoutMs } from "../../../src/shared/http.ts";
import { canonicalEndpoint } from "../../../src/shared/endpoint.ts";

const NativeToolSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().optional(),
  inputSchema: z.looseObject({ type: z.literal("object"), properties: z.record(z.string(), z.unknown()).optional(), required: z.array(z.string()).optional() }),
  _meta: z.record(z.string(), z.unknown()).optional(),
});
// One tool as the server lists it, reduced to what a host registers.
export type NativeTool = z.infer<typeof NativeToolSchema>;
// The Controller's tool hooks (beforeCall/afterCall): the server's bind,
// unbind and `unbound` results drive its stop/prepare exactly as in OpenCode.
export type CallHooks = Pick<Controller, "beforeCall" | "afterCall">;
export type ProxyOptions = {
  // The hosted MCP endpoint (`url`), this harness's session key, client and
  // delivery declaration; NativeWire sends the last two in every `_meta`.
  wire: WireOptions;
  harness: string;      // "pi" | "omp" | "Claude Code", for the login error
  loginAction: string;  // how this harness signs in, e.g. "run /grayboard login"
  // The adapter's credential: token() is undefined (or throws AccessExpired)
  // until login; onUnauthorized runs once per 401, then the request is retried.
  auth: AuthProvider;
  hooks?: CallHooks;
  // A failure the call's result can't carry: an afterCall that threw
  // (`after`), or an upload a failed send couldn't release (it expires on its
  // own). Names from the diagnostics allowlist.
  report(operation: Extract<Operation, "after" | "release_upload">, error: unknown): void;
  // The tool list changed (a new native connection reached another server
  // version): the adapter re-registers.
  onTools?(tools: NativeTool[]): void;
  roots?: string[];                          // where attachments may come from and go, resolved as attachRoots() returns them; default attachRoots()
  env?: Record<string, string | undefined>;  // GRAYBOARD_ATTACHMENTS_DIR for attachment_get's default dir
};

export const ALWAYS_LOAD = "anthropic/alwaysLoad";
// omp extension tools default to "discoverable" (deferred behind search); an
// alwaysLoad tool (dm_inbox, dm_ack) must be "essential" there.
export const loadMode = (tool: NativeTool): "essential" | "discoverable" => tool._meta?.[ALWAYS_LOAD] === true ? "essential" : "discoverable";

// The fields a host registers, in a fixed order, so the snapshot and a live
// list compare equal.
export function nativeTool(tool: Tool): NativeTool {
  return NativeToolSchema.parse({ name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }), inputSchema: tool.inputSchema, ...(tool._meta ? { _meta: tool._meta } : {}) });
}
export const snapshotTools = (): NativeTool[] => z.array(NativeToolSchema).parse(snapshot);

// The local tool server mode serves too (src/plugin/tools.ts).
const ATTACHMENT_GET = NativeToolSchema.parse(ATTACHMENT_GET_TOOL);
// The tools a host registers: dm_send and board_post take local file paths
// (`attachments`) where the server takes uploaded ids, plus a local
// attachment_get, as server mode serves them.
export function hostTools(native: NativeTool[]): NativeTool[] {
  return [...native.map(tool => tool.name === "dm_send" || tool.name === "board_post" ? withPaths(tool) : tool), ATTACHMENT_GET];
}
function withPaths(tool: NativeTool): NativeTool {
  const properties = Object.fromEntries(Object.entries(tool.inputSchema.properties ?? {}).map(([key, value]) => key === "attachment_ids" ? ["attachments", ATTACHMENTS_PARAM] : [key, value]));
  const description = tool.description?.replace("attachment_ids?", "attachments?").replace(" Attachments are uploaded IDs, not paths.", " Attachments are local file paths.");
  return { ...tool, ...(description === undefined ? {} : { description }), inputSchema: { ...tool.inputSchema, properties } };
}

// The tool's parsed result for afterCall: structuredContent, else the single
// text content parsed as JSON (or as is when it isn't JSON).
export function outputOf(result: CallToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const only = result.content.length === 1 ? result.content[0] : undefined;
  if (only?.type !== "text") return undefined;
  try { return JSON.parse(only.text); } catch { return only.text; }
}
const text = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const failure = (message: string): CallToolResult => ({ ...text(`error: ${message}`), isError: true });

// The attachment routes refused a request with the server's own code and message.
export class AttachmentRefused extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
// A forwarded call the server answered with isError: its uploads are released
// and its result returned as is.
class Refused extends Error {
  constructor(readonly result: CallToolResult) { super("tool call refused"); }
}
// The wire classified the failure as the transport's (a closed connection, a
// network error, a gateway 502-504), not a request that ran out of time on a
// working connection.
function broken(error: unknown): boolean {
  if (!(error instanceof ServerUnreachable)) return false;
  for (let e: unknown = error, depth = 0; e && depth < 8; e = e instanceof Error ? e.cause : undefined, depth++) {
    if (e instanceof SdkError && e.code === SdkErrorCode.RequestTimeout) return false;
  }
  return true;
}

export class ToolProxy {
  private current: NativeTool[];
  // The shared native connection (no session of its own), opened lazily and
  // replaced after a transport failure, so each reconnect re-lists the tools.
  private native?: { ready: Promise<NativeWire> };
  private readonly instructionsBySession = new Map<string, Promise<string | undefined>>();
  private readonly closing = new AbortController();
  private readonly roots: string[];
  private readonly resource: URL;
  constructor(readonly options: ProxyOptions) {
    const resource = canonicalEndpoint(options.wire.url);
    if (!resource) throw new Error("Grayboard MCP URL must be canonical HTTPS (or HTTP loopback), without credentials, query or fragment");
    this.current = hostTools(snapshotTools());
    this.roots = options.roots ?? attachRoots();
    this.resource = resource;
  }

  tools(): NativeTool[] { return this.current; }

  // A new native connection, which re-lists the tools: after login, or after
  // a credential change, which may also reach another account's instructions.
  // The server declares tools.listChanged false, so nothing else announces a
  // new list.
  async connect(): Promise<NativeTool[]> {
    this.drop(this.native);
    this.instructionsBySession.clear();
    await this.open().ready;
    return this.current;
  }

  // `name` with `args` for raw session `sessionID`. The server's result comes
  // back verbatim (content, structuredContent, isError, _meta); a transport
  // failure throws the wire's classified error. A call that needs a new login
  // (signed out, expired, insufficient scope) returns one error naming it.
  async call(name: string, args: Record<string, unknown>, sessionID: string): Promise<CallToolResult> {
    const signedOut = await this.signedOut();
    if (signedOut) return failure(signedOut.message);
    try { await this.options.hooks?.beforeCall({ sessionID, tool: name }); }
    catch (error) {
      const expired = this.loginNeeded(error);
      if (expired) return failure(expired.message);
      throw error;
    }
    let outcome: CallOutcome = { status: "error" };
    try {
      const result = await this.dispatch(name, args, sessionID);
      if (!result.isError) outcome = { status: "completed", output: outputOf(result) };
      return result;
    } catch (error) {
      const expired = this.loginNeeded(error);
      if (expired) return failure(expired.message);
      throw error;
    } finally {
      // A bind or unbind changes what the server's instructions say.
      if (name === "bind" || name === "unbind") this.instructionsBySession.delete(sessionID);
      try { await this.options.hooks?.afterCall({ sessionID, tool: name, result: outcome }); }
      catch (error) { this.options.report("after", error); }
    }
  }

  // The server's instructions for this session (its native initialize
  // instructions, composed for the declared delivery), cached until a bind or
  // unbind result for it or a new connection. Rejects with AccessExpired when
  // only a new login can fetch them.
  instructions(sessionID: string): Promise<string | undefined> {
    const cached = this.instructionsBySession.get(sessionID);
    if (cached) return cached;
    const fetched = this.fetchInstructions(sessionID);
    this.instructionsBySession.set(sessionID, fetched);
    fetched.catch(() => { if (this.instructionsBySession.get(sessionID) === fetched) this.instructionsBySession.delete(sessionID); });
    return fetched;
  }

  async close() {
    this.closing.abort();
    const native = this.native;
    this.native = undefined;
    await native?.ready.then(wire => wire.close(), () => {});
  }

  private async fetchInstructions(sessionID: string): Promise<string | undefined> {
    const signedOut = await this.signedOut();
    if (signedOut) throw signedOut;
    const wire = new NativeWire(this.options.wire, this.options.auth, this.closing.signal, sessionID);
    try {
      await wire.connect();
      return wire.instructions();
    } catch (error) {
      throw this.loginNeeded(error) ?? error;
    } finally { await wire.close(); }
  }

  private async dispatch(name: string, args: Record<string, unknown>, sessionID: string): Promise<CallToolResult> {
    if (name === ATTACHMENT_GET_TOOL.name) return this.attachmentGet(args, sessionID);
    if ((name === "dm_send" || name === "board_post") && args.attachments !== undefined) return this.withUploads(name, args, sessionID);
    return this.forward(name, args, sessionID);
  }

  // Only a broken transport retires the shared connection, and only while it
  // is still the current one: a tool or JSON-RPC error, a request timeout, a
  // 429, a 401 or 403 leaves it to the other calls in flight on it, which
  // closing it would abort (a committed dm_send would then read as unreachable).
  private async forward(name: string, args: Record<string, unknown>, sessionID: string): Promise<CallToolResult> {
    const native = this.native ?? this.open();
    const wire = await native.ready;
    try { return await wire.callTool(name, args, sessionID); }
    catch (error) {
      if (broken(error)) this.drop(native);
      throw error;
    }
  }

  // The server's attachment caps, published as a capability of the shared
  // connection; a server older than #430 publishes none, and gets the
  // shared defaults its own config also starts from.
  private async limits(): Promise<AttachmentLimits> {
    const wire = await (this.native ?? this.open()).ready;
    return publishedLimits(wire.client.getServerCapabilities()?.experimental) ?? DEFAULT_ATTACHMENT_LIMITS;
  }

  // Reads and checks the files an agent named (all before any is sent), then
  // uploads them for this session and calls the tool with their ids.
  private async withUploads(name: string, args: Record<string, unknown>, sessionID: string): Promise<CallToolResult> {
    const { attachments, ...rest } = args;
    try {
      const files = await readAttachmentFiles(attachments, this.roots, { limits: await this.limits() });
      return await sendWithUploads(files, this.transport(sessionID), async ids => {
        const result = await this.forward(name, ids.length ? { ...rest, attachment_ids: ids } : rest, sessionID);
        if (result.isError) throw new Refused(result);
        return result;
      });
    } catch (error) {
      if (error instanceof Refused) return error.result;
      if (error instanceof SendLanded) return text({ sent: true, attachment_ids: error.attachments, note: error.message });
      if (this.transportFailure(error)) throw error;
      return failure((error as Error).message);
    }
  }

  // attachment_get(id, dir?): saves under the same roots and default
  // directory as server mode, after checking the server's sha256.
  private async attachmentGet(args: Record<string, unknown>, sessionID: string): Promise<CallToolResult> {
    try {
      const id = checkAttachmentId(args.id);
      const target = await saveTarget(args.dir, this.roots, serverBusDir(this.resource.href), this.options.env);
      return text(await downloadAttachment(id, target, (await this.limits()).file, this.transport(sessionID)));
    } catch (error) {
      if (this.transportFailure(error)) throw error;
      return failure((error as Error).message);
    }
  }

  // The hosted endpoint's attachment routes (src/server/mcp-attachments.ts):
  // the session rides in X-Grayboard-Session; the server acts as its bound name.
  private transport(sessionID: string): AttachmentTransport {
    const base = `${this.resource.href.replace(/\/$/, "")}/attachments`;
    return {
      upload: async file => {
        const response = await this.http("POST", `${base}?filename=${encodeURIComponent(file.filename)}`, sessionID, transferTimeoutMs(file.data.length), file.data);
        const stored = z.object({ id: z.number().int().positive() }).safeParse(await response.json().catch(() => undefined));
        if (!stored.success) throw new Error("Invalid attachment upload response");
        return stored.data.id;
      },
      release: async id => {
        try {
          const response = await this.http("DELETE", `${base}/${id}`, sessionID, HTTP_TIMEOUT_MS);
          await response.body?.cancel();
          return true;
        } catch (error) {
          if (error instanceof AttachmentRefused && error.status === 404) return false;
          throw error;
        }
      },
      download: async (id, maxBytes) => {
        const ms = transferTimeoutMs(maxBytes);
        const response = await this.http("GET", `${base}/${id}`, sessionID, ms);
        try { return { headers: response.headers, data: new Uint8Array(await response.arrayBuffer()) }; }
        catch (error) { throw this.fetchFailure(error, ms); }
      },
      unreleased: (id, error) => this.options.report("release_upload", new Error(`couldn't release upload ${id} (it expires in an hour): ${error.message}`, { cause: error })),
    };
  }

  // One authorized request to an attachment route, retried once after the
  // credential's onUnauthorized, as the MCP transport does.
  private async http(method: "POST" | "GET" | "DELETE", url: string, sessionID: string, ms: number, body?: Uint8Array): Promise<Response> {
    const signal = AbortSignal.any([AbortSignal.timeout(ms), this.closing.signal]);
    for (let attempt = 0; ; attempt++) {
      const token = await this.options.auth.token();
      if (!token) throw new AccessExpired(this.options.harness, this.options.loginAction, "login_required");
      const headers = new Headers({ Authorization: `Bearer ${token}`, "X-Grayboard-Session": encodeURIComponent(sessionID) });
      if (body) headers.set("Content-Type", "application/octet-stream");
      let response: Response;
      try { response = await fetch(url, { method, headers, body: body ? new Uint8Array(body) : undefined, redirect: "error", signal }); }
      catch (error) { throw this.fetchFailure(error, ms); }
      if (response.ok) return response;
      if (response.status === 401 && attempt === 0 && this.options.auth.onUnauthorized) {
        await response.body?.cancel();
        await this.options.auth.onUnauthorized({ response, serverUrl: this.resource, fetchFn: fetch });
        continue;
      }
      if (response.status === 401 || response.status === 403 && /insufficient_scope/.test(response.headers.get("www-authenticate") ?? "")) {
        await response.body?.cancel();
        throw new AccessExpired(this.options.harness, this.options.loginAction, response.status === 401 ? "expired" : "login_required");
      }
      const refusal = z.object({ code: z.string(), message: z.string() }).safeParse(await response.json().catch(() => undefined));
      if (refusal.success) throw new AttachmentRefused(response.status, refusal.data.code, refusal.data.message);
      if ([502, 503, 504].includes(response.status)) throw new ServerUnreachable(new Error(`HTTP ${response.status}`));
      throw new Error(`grayboard server at ${this.resource.origin}: HTTP ${response.status}`);
    }
  }

  private fetchFailure(error: unknown, ms: number): Error {
    if (!this.closing.signal.aborted && unreachable(error)) return new ServerUnreachable(error);
    return new Error(`grayboard server at ${this.resource.origin}: ${describeFetchError(error, ms)}`, { cause: error });
  }

  private open(): { ready: Promise<NativeWire> } {
    const native: { ready: Promise<NativeWire> } = { ready: this.listed(new NativeWire(this.options.wire, this.options.auth, this.closing.signal), () => this.native === native) };
    this.native = native;
    return native;
  }

  // Connects and re-lists: a new connection may reach another server version.
  // Only the current connection's list replaces the tools.
  private async listed(wire: NativeWire, current: () => boolean): Promise<NativeWire> {
    try {
      await wire.connect();
      const listed = hostTools((await wire.listTools()).map(nativeTool));
      if (current() && !same(listed, this.current)) {
        this.current = listed;
        this.options.onTools?.(listed);
      }
      return wire;
    } catch (error) {
      if (current()) this.native = undefined;
      await wire.close().catch(() => {});
      throw error;
    }
  }

  private drop(native: { ready: Promise<NativeWire> } | undefined) {
    if (!native || this.native !== native) return;
    this.native = undefined;
    void native.ready.then(wire => wire.close(), () => {});
  }

  private async signedOut(): Promise<AccessExpired | undefined> {
    try {
      return await this.options.auth.token() ? undefined : new AccessExpired(this.options.harness, this.options.loginAction, "login_required");
    } catch (error) {
      const expired = accessExpiry(error);
      if (expired) return expired;
      throw error;
    }
  }

  // Only a new sign-in restores these: the credential's own AccessExpired, the
  // wire's InsufficientScope (403 insufficient_scope, never a refresh), or a
  // 401 the transport's onUnauthorized retry didn't fix (SdkHttpError 401, or
  // the SDK's UnauthorizedError for a credential without onUnauthorized).
  private loginNeeded(error: unknown): AccessExpired | undefined {
    for (let e = error, depth = 0; e && depth < 8; e = e instanceof Error ? e.cause : undefined, depth++) {
      if (e instanceof AccessExpired) return e;
      if (e instanceof InsufficientScope) return new AccessExpired(this.options.harness, this.options.loginAction, "login_required");
      if (e instanceof UnauthorizedError || e instanceof SdkHttpError && e.status === 401) return new AccessExpired(this.options.harness, this.options.loginAction, "expired");
    }
    return undefined;
  }

  private transportFailure(error: unknown): boolean {
    return error instanceof ServerUnreachable || !!this.loginNeeded(error);
  }
}
