import { Client, StreamableHTTPClientTransport, type AuthProvider } from "@modelcontextprotocol/client";
import type { Configuration } from "./model.js";
import { setTimeout as sleep } from "node:timers/promises";

export class SubscriberError extends Error {
  constructor(readonly code: string) { super(`Subscriber refused (${code})`); }
}
export class LeaseUnavailable extends SubscriberError {
  constructor(code: "not_found" | "unbound" = "not_found") { super(code); }
}
const domainCodes = new Set(["identity_unknown", "identity_in_use", "not_found", "unbound", "refused", "internal_error", "bad_request", "unauthenticated", "forbidden", "rate_limited"]);
export function subscriberError(value: unknown, leaseOperation: boolean): SubscriberError {
  const code = (value as { code?: unknown } | undefined)?.code;
  const domain = typeof code === "string" && domainCodes.has(code) ? code : "invalid_response";
  return leaseOperation && (domain === "not_found" || domain === "unbound") ? new LeaseUnavailable(domain) : new SubscriberError(domain);
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
    this.connect = () => this.client.connect(transport, { signal, timeout: 10_000 });
  }
  readonly connect: () => Promise<void>;
  options() { return { signal: this.signal, timeout: 10_000 }; }
  async read(uri: string): Promise<unknown> {
    const value = await this.client.readResource({ uri, _meta: { "ai.opencode/sessionID": this.sessionID } }, this.options()).catch(error => {
      // The SDK reconstructs JSON-RPC errors with numeric code and domain data.code.
      if (error?.code === -32602 || error?.code === -32603) throw subscriberError(error.data, uri === "grayboard://inbox");
      throw error;
    });
    if (value.contents.length !== 1 || !("text" in value.contents[0]!)) throw new Error("Invalid resource response");
    return JSON.parse(value.contents[0]!.text as string);
  }
  async call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const value = await this.client.callTool({ name, arguments: args, _meta: { "ai.opencode/sessionID": this.sessionID } }, this.options());
    if (value.isError) {
      throw subscriberError(value.structuredContent, name.startsWith("delivery_"));
    }
    if (value.structuredContent) return value.structuredContent;
    const content = value.content;
    if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== "text") throw new Error("Invalid delivery response");
    return JSON.parse(content[0].text as string);
  }
  async listen() {
    const subscription = await this.client.listen({ resourceSubscriptions: ["grayboard://inbox"] }, this.options());
    if (!subscription.honoredFilter.resourceSubscriptions?.includes("grayboard://inbox")) {
      await subscription.close();
      throw new Error("Server did not acknowledge inbox subscription");
    }
    return subscription;
  }
  async close() { await this.client.close(); }
}
