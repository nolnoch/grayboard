// A hosted MCP session over HTTP, as a built-in hosted client runs one
// (#282): hosted-core's own wire (adapters/hosted-core/src/wire.ts), a
// NativeWire for the agent's tools and instructions and a subscriber Wire
// for the delivery lease and inbox, both naming one raw session ID in
// `_meta[GRAYBOARD_SESSION_META]` with a push delivery declaration.
// Deliveries are the lease's inbox items, read by polling grayboard://inbox.
import { expect } from "bun:test";
import { randomBytes } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { LeaseUnavailable, NativeWire, Wire, type WireOptions } from "../../adapters/hosted-core/src/wire.ts";
import type { DeliveryEvent } from "../../src/server/application.ts";
import type { PendingDelivery } from "../../src/server/delivery.ts";
import { BUILTIN_CLIENT_IDS } from "../../src/server/oauth-config.ts";
import { GRAYBOARD_SESSION_META } from "../../src/shared/session_meta.ts";
import { until } from "./until.ts";

export const HOSTED_CLIENT = "grayboard-pi";
export const HOSTED_SCOPES = ["grayboard:tools", "grayboard:delivery"];

// client: the built-in OAuth client the token is issued to, and the delivery
// declaration's source. scopes: the token's. sessionId: the raw session ID
// both wires send (random by default). create: bind's create (default true).
// receipt: "auto" receipts every item next()/none() read, as a harness does
// once it has delivered them; "manual" leaves that to receipt(). delivery:
// whether a lease opens whenever the session binds (default true; an unbound
// session can't hold one).
export type HostedOptions = {
  client?: string;
  scopes?: string[];
  sessionId?: string;
  create?: boolean;
  receipt?: "auto" | "manual";
  delivery?: boolean;
};

// One item of the lease's inbox: { id, actionable, event } and the lease
// stamp it was issued under.
export type InboxItem = PendingDelivery;

// A native tool's refusal. code, known and holder come from the result's
// structured content or its JSON text; a board or DM tool's refusal carries
// only its message (`error: …`), so code is unset there.
export class HostedToolError extends Error {
  readonly code?: string;
  readonly known?: string[];
  readonly holder?: string;
  constructor(readonly tool: string, readonly result: CallToolResult) {
    const text = textOf(result) ?? "";
    let json: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object") json = parsed as Record<string, unknown>;
    } catch {}
    const structured = result.structuredContent;
    const fields: Record<string, unknown> = { ...json, ...(structured && typeof structured === "object" ? structured : {}) };
    super(typeof fields.message === "string" ? fields.message : text.replace(/^error: /, ""));
    this.name = "HostedToolError";
    if (typeof fields.code === "string") this.code = fields.code;
    if (Array.isArray(fields.known)) this.known = fields.known.filter((k: unknown): k is string => typeof k === "string");
    if (typeof fields.holder === "string") this.holder = fields.holder;
  }
}

function textOf(result: CallToolResult): string | undefined {
  const first = result.content?.find((c) => c.type === "text");
  return first?.type === "text" ? first.text : undefined;
}

// What a delivery_open or delivery_renew answers that the driver keeps.
function leaseOf(value: unknown): { capability: string; expiresAt: number } {
  if (value && typeof value === "object" && "capability" in value && typeof value.capability === "string" && "expiresAt" in value && typeof value.expiresAt === "number") {
    return { capability: value.capability, expiresAt: value.expiresAt };
  }
  throw new Error(`not a delivery lease: ${JSON.stringify(value)}`);
}

export class HostedSession {
  readonly sessionId: string;
  readonly native: NativeWire;
  readonly subscriber: Wire;
  // Both wires' options: instructionsNow()'s wire and the attachment routes use them.
  private readonly wireOptions: WireOptions;
  private readonly abort = new AbortController();
  private lease?: { capability: string; expiresAt: number; ttl: number };
  // Items read and not yet taken by next(), oldest first; every ID read, so
  // an item still in the inbox is buffered once.
  private buffer: InboxItem[] = [];
  private seen = new Set<string>();
  private closing?: Promise<void>;

  constructor(
    url: string,
    readonly token: string,
    // The name to bind at connect; null stays unbound (reads only).
    private readonly identity: string | null,
    private readonly opts: HostedOptions = {},
  ) {
    const client = opts.client ?? HOSTED_CLIENT;
    // The generic session key and the delivery declaration are read only for a built-in client (src/server/oauth-config.ts sourceKeyFor).
    if (!BUILTIN_CLIENT_IDS.includes(client)) throw new Error(`HostedSession: ${client} isn't a built-in hosted client (${BUILTIN_CLIENT_IDS.join(", ")})`);
    this.sessionId = opts.sessionId ?? `test-${randomBytes(8).toString("hex")}`;
    const options: WireOptions = { url, sessionKey: GRAYBOARD_SESSION_META, client: { name: client, version: "1.0.0" }, delivery: { mode: "push", source: client } };
    const auth = { token: async () => token };
    this.wireOptions = options;
    this.native = new NativeWire(options, auth, this.abort.signal, this.sessionId);
    this.subscriber = new Wire(options, auth, this.abort.signal, this.sessionId);
  }

  private get label(): string {
    return this.identity ?? this.sessionId;
  }

  // Both roles connected, the identity bound unless it's null, and its
  // lease open.
  async connect(): Promise<{ whoami: unknown; bind?: unknown }> {
    await Promise.all([this.native.connect(), this.subscriber.connect()]);
    const bind = this.identity === null ? undefined : await this.bind(this.identity);
    return { whoami: await this.call("whoami"), ...(bind === undefined ? {} : { bind }) };
  }

  // A native tool's result untouched: content, structuredContent, isError, _meta.
  callRaw(tool: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    return this.native.callTool(tool, args, this.sessionId);
  }

  // A native tool's result: its structured content, else its text parsed as
  // JSON (or the text itself when it isn't JSON). A refusal rejects with
  // HostedToolError. T is the shape the caller expects; nothing checks it.
  async call<T = unknown>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await this.callRaw(tool, args);
    if (result.isError) throw new HostedToolError(tool, result);
    if (result.structuredContent !== undefined) return result.structuredContent as T;
    const text = textOf(result);
    if (text === undefined) throw new Error(`${this.label}: ${tool} answered no text`);
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  // The server's instructions for this session, from the native initialize.
  instructions(): string | undefined {
    return this.native.instructions();
  }

  // The instructions a native connection opened now gets: initialize
  // composes them from the session's binding at that moment, as a harness
  // sees on reconnecting (instructions() is connect()'s, before its bind).
  async instructionsNow(): Promise<string | undefined> {
    const wire = new NativeWire(this.wireOptions, { token: async () => this.token }, this.abort.signal, this.sessionId);
    await wire.connect();
    try {
      return wire.instructions();
    } finally {
      await wire.close();
    }
  }

  // The hosted attachment routes (src/server/mcp-attachments.ts), as
  // hosted-core's proxy calls them: the session in X-Grayboard-Session, the
  // server acting as its bound name. upload answers the attachment's id.
  async upload(filename: string, data: Uint8Array<ArrayBuffer> | string): Promise<number> {
    const r = await this.attachment("POST", `?filename=${encodeURIComponent(filename)}`, typeof data === "string" ? new TextEncoder().encode(data) : data);
    const stored: unknown = await r.json();
    if (stored && typeof stored === "object" && "id" in stored && typeof stored.id === "number") return stored.id;
    throw new Error(`${this.label}: the attachment upload answered ${JSON.stringify(stored)}`);
  }

  async download(id: number): Promise<Uint8Array> {
    return new Uint8Array(await (await this.attachment("GET", `/${id}`)).arrayBuffer());
  }

  // An unsent upload withdrawn, as hosted-core's proxy releases a refused send's files.
  async release(id: number): Promise<void> {
    await (await this.attachment("DELETE", `/${id}`)).body?.cancel();
  }

  private async attachment(method: "POST" | "GET" | "DELETE", path: string, body?: Uint8Array<ArrayBuffer>): Promise<Response> {
    const headers = new Headers({ Authorization: `Bearer ${this.token}`, "X-Grayboard-Session": encodeURIComponent(this.sessionId) });
    if (body) headers.set("Content-Type", "application/octet-stream");
    const r = await fetch(`${this.wireOptions.url}/attachments${path}`, { method, headers, ...(body ? { body } : {}) });
    if (!r.ok) throw new Error(`${this.label}: ${method} attachments${path} answered ${r.status}: ${await r.text()}`);
    return r;
  }

  // The agent's bind tool. A bind closes any open lease (its bind_gen
  // changes); like a hosted client, the session then opens a new one.
  async bind(name: string, { create = this.opts.create ?? true }: { create?: boolean } = {}): Promise<unknown> {
    this.lease = undefined;
    this.subscriber.capability = undefined;
    const result = await this.call("bind", { name, create });
    if (this.opts.delivery ?? true) {
      const lease = leaseOf(await this.subscriber.call("delivery_open"));
      this.subscriber.capability = lease.capability;
      this.lease = { ...lease, ttl: lease.expiresAt - Date.now() };
    }
    return result;
  }

  // session_end: ends this ownership, its lease and its name with it.
  async end(): Promise<void> {
    await this.subscriber.call("session_end");
    this.lease = undefined;
    this.subscriber.capability = undefined;
  }

  // The lease's inbox as it stands: a read, which acknowledges nothing.
  async inbox(): Promise<InboxItem[]> {
    if (!this.lease) throw new Error(`${this.label}: no delivery lease (unbound, or delivery: false)`);
    // Renewed past half its TTL, as a hosted client keeps it.
    if (this.lease.expiresAt - Date.now() < this.lease.ttl / 2) {
      this.lease = { ...this.lease, expiresAt: leaseOf(await this.subscriber.call("delivery_renew")).expiresAt };
    }
    const read = await this.subscriber.read("grayboard://inbox");
    if (!read || typeof read !== "object" || !("items" in read) || !Array.isArray(read.items)) throw new Error(`${this.label}: the inbox read answered ${JSON.stringify(read)}`);
    // The server's PendingDelivery[] (src/server/delivery.ts), as JSON.
    const items: InboxItem[] = read.items;
    return items;
  }

  async receipt(ids: string[]): Promise<void> {
    await this.subscriber.call("delivery_receipt", { ids });
  }

  // One inbox read: new items are buffered (and receipted, in auto mode).
  private async poll(): Promise<void> {
    if (this.closing) throw new Error(`${this.label}: closed`);
    const fresh = (await this.inbox()).filter((item) => !this.seen.has(item.id));
    for (const item of fresh) {
      this.seen.add(item.id);
      this.buffer.push(item);
    }
    if ((this.opts.receipt ?? "auto") === "auto" && fresh.length) await this.receipt(fresh.map((item) => item.id));
  }

  private take(pred: (e: DeliveryEvent) => boolean): InboxItem | undefined {
    const i = this.buffer.findIndex((item) => pred(item.event));
    return i < 0 ? undefined : this.buffer.splice(i, 1)[0];
  }

  // The first item whose event matches pred: one already read, or one the
  // inbox shows within ms.
  next<T extends DeliveryEvent>(pred: (e: DeliveryEvent) => e is T, ms?: number): Promise<InboxItem & { event: T }>;
  next(pred: (e: DeliveryEvent) => boolean, ms?: number): Promise<InboxItem>;
  async next(pred: (e: DeliveryEvent) => boolean, ms = 1000): Promise<InboxItem> {
    return this.take(pred) ?? until(async () => {
      await this.poll();
      return this.take(pred);
    }, ms, `${this.label}: an inbox item matching ${pred}`);
  }

  // No item whose event matches pred has been read, or shows within ms.
  async none(pred: (e: DeliveryEvent) => boolean, ms = 150): Promise<void> {
    const end = Date.now() + ms;
    await until(async () => {
      await this.poll();
      expect(this.buffer.filter((item) => pred(item.event))).toEqual([]);
      return Date.now() >= end;
    }, ms + 5000, `${this.label}: no inbox item matching ${pred} for ${ms} ms`);
  }

  // delivery_release when a lease is open (ending the ownership and freeing
  // its name), then both wires close. Idempotent.
  close(): Promise<void> {
    this.closing ??= (async () => {
      try {
        // A lease the server already closed (a rebind, an end) has nothing to release.
        if (this.lease) await this.subscriber.call("delivery_release").catch((e) => { if (!(e instanceof LeaseUnavailable)) throw e; });
      } finally {
        this.lease = undefined;
        await Promise.all([this.native.close(), this.subscriber.close()]);
        this.abort.abort();
      }
    })();
    return this.closing;
  }
}
