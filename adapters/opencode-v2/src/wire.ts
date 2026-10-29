import { Client, SdkError, SdkErrorCode, SdkHttpError, StreamableHTTPClientTransport, type AuthProvider } from "@modelcontextprotocol/client";
import type { Configuration } from "./model.js";
import { setTimeout as sleep } from "node:timers/promises";

export class SubscriberError extends Error {
  constructor(readonly code: string, readonly known?: string[], readonly holder?: string) { super(`Subscriber refused (${code})${known?.length ? `; known names: ${known.join(", ")}` : ""}${holder ? `; held by ${holder}` : ""}`); }
}
// The server's holder is free text naming the account's other session; it is shown, so it must not carry control or bidi characters.
export const holderText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 2048 && !/[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/.test(value);
export class LeaseUnavailable extends SubscriberError {
  constructor(code: "not_found" | "unbound" = "not_found") { super(code); }
}
const domainCodes = new Set(["identity_unknown", "identity_in_use", "not_found", "unbound", "refused", "internal_error", "bad_request", "unauthenticated", "forbidden", "rate_limited", "receipt_capacity"]);
export function subscriberError(value: unknown, leaseOperation: boolean): SubscriberError {
  const code = (value as { code?: unknown } | undefined)?.code;
  const domain = typeof code === "string" && domainCodes.has(code) ? code : "invalid_response";
  const suggestions = (value as { known?: unknown } | undefined)?.known;
  const known = domain === "identity_unknown" && Array.isArray(suggestions) && suggestions.length <= 256 && suggestions.every(name => typeof name === "string" && /^[a-z0-9_-]{1,32}$/.test(name)) ? [...new Set(suggestions as string[])] : undefined;
  const holder = (value as { holder?: unknown } | undefined)?.holder;
  return leaseOperation && (domain === "not_found" || domain === "unbound") ? new LeaseUnavailable(domain) : new SubscriberError(domain, known, domain === "identity_in_use" && holderText(holder) ? holder : undefined);
}

// The server can't be reached right now (stopped, restarting, behind a
// failing gateway, or hung). Hosted leases don't count server downtime
// (#423), so the controller keeps retrying these without spending its budget.
export class ServerUnreachable extends Error {
  constructor(cause: unknown) { super("Server unreachable", { cause }); }
}
const networkCodes = new Set(["ECONNREFUSED", "ConnectionRefused", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "FailedToOpenSocket"]);
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

export class Wire {
  readonly client = new Client({ name: "grayboard-opencode", version: "1.10.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  capability?: string;
  admissionRetryAfterMs?: number;
  constructor(configuration: Configuration, authProvider: AuthProvider, readonly signal: AbortSignal, readonly sessionID: string, beforeRetry?: () => Promise<void>) {
    const endpoint = new URL(configuration.url);
    const transport = new StreamableHTTPClientTransport(endpoint, {
      authProvider, onInsufficientScope: "throw", requestInit: { redirect: "error" },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.url !== endpoint.href) throw new Error("Unexpected subscriber destination");
        const headers = new Headers(request.headers);
        headers.set("X-Grayboard-Client", "subscriber");
        if (this.capability) headers.set("X-Grayboard-Lease", this.capability);
        const signal = AbortSignal.any([request.signal, this.signal]);
        for (let attempt = 0; ; attempt++) {
          if (attempt) {
            await beforeRetry?.();
            const token = await authProvider.token();
            if (token) headers.set("Authorization", `Bearer ${token}`); else headers.delete("Authorization");
          }
          signal.throwIfAborted();
          const response = await fetch(request.clone(), { headers, redirect: "error", signal });
          if (response.status !== 429) return response;
          const body = await response.clone().json().catch(() => undefined) as { error?: { data?: { code?: string; retry_after_ms?: number } } } | undefined;
          const data = body?.error?.data;
          if (data?.code !== "rate_limited" || typeof data.retry_after_ms !== "number" || !Number.isFinite(data.retry_after_ms) || data.retry_after_ms <= 0) return response;
          this.admissionRetryAfterMs = data.retry_after_ms;
          if (attempt === 7) return response;
          await response.body?.cancel().catch(() => {});
          await sleep(Math.ceil(data.retry_after_ms), undefined, { signal });
        }
      },
    });
    const send = transport.send.bind(transport);
    transport.send = (message, options) => {
      if ("method" in message) message = { ...message, params: { ...message.params, _meta: { ...message.params?._meta, "ai.opencode/sessionID": this.sessionID } } };
      return send(message, options);
    };
    this.connect = () => this.reachable(this.client.connect(transport, { signal, timeout: 10_000 }));
  }
  readonly connect: () => Promise<void>;
  // An abort of this wire's own signal is the controller stopping, never an outage.
  private async reachable<T>(pending: Promise<T>): Promise<T> {
    try { return await pending; }
    catch (error) { throw !this.signal.aborted && !(error instanceof ServerUnreachable) && unreachable(error) ? new ServerUnreachable(error) : error; }
  }
  options() { return { signal: this.signal, timeout: 10_000 }; }
  async read(uri: string): Promise<unknown> {
    const value = await this.reachable(this.client.readResource({ uri, _meta: { "ai.opencode/sessionID": this.sessionID } }, this.options())).catch(error => {
      // The SDK reconstructs JSON-RPC errors with numeric code and domain data.code.
      if (error?.code === -32602 || error?.code === -32603) throw subscriberError(error.data, uri === "grayboard://inbox");
      throw error;
    });
    if (value.contents.length !== 1 || !("text" in value.contents[0]!)) throw new Error("Invalid resource response");
    return JSON.parse(value.contents[0]!.text as string);
  }
  async call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const value = await this.reachable(this.client.callTool({ name, arguments: args, _meta: { "ai.opencode/sessionID": this.sessionID } }, this.options()));
    if (value.isError) {
      throw subscriberError(value.structuredContent, name.startsWith("delivery_"));
    }
    if (value.structuredContent) return value.structuredContent;
    const content = value.content;
    if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== "text") throw new Error("Invalid delivery response");
    return JSON.parse(content[0].text as string);
  }
  async listen() {
    const subscription = await this.reachable(this.client.listen({ resourceSubscriptions: ["grayboard://inbox"] }, this.options()));
    if (!subscription.honoredFilter.resourceSubscriptions?.includes("grayboard://inbox")) {
      await subscription.close();
      throw new Error("Server did not acknowledge inbox subscription");
    }
    return subscription;
  }
  async close() { await this.client.close(); }
}
