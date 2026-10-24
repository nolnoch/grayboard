import { Client, StreamableHTTPClientTransport, type AuthProvider } from "@modelcontextprotocol/client";
import type { Configuration } from "./model.js";

export class LeaseUnavailable extends Error {}

export class Wire {
  readonly client = new Client({ name: "grayboard-opencode", version: "1.10.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  capability?: string;
  constructor(configuration: Configuration, authProvider: AuthProvider, readonly signal: AbortSignal) {
    const endpoint = new URL(configuration.url);
    const transport = new StreamableHTTPClientTransport(endpoint, {
      authProvider, onInsufficientScope: "throw", requestInit: { redirect: "error" },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.url !== endpoint.href) throw new Error("Unexpected subscriber destination");
        const headers = new Headers(request.headers);
        headers.set("X-Grayboard-Identity", configuration.identity);
        headers.set("X-Grayboard-Client", "subscriber");
        if (this.capability) headers.set("X-Grayboard-Lease", this.capability);
        return fetch(request, { headers, redirect: "error", signal: AbortSignal.any([request.signal, this.signal]) });
      },
    });
    this.connect = () => this.client.connect(transport, { signal, timeout: 10_000 });
  }
  readonly connect: () => Promise<void>;
  options() { return { signal: this.signal, timeout: 10_000 }; }
  async read(uri: string): Promise<unknown> {
    const value = await this.client.readResource({ uri }, this.options());
    if (value.contents.length !== 1 || !("text" in value.contents[0]!)) throw new Error("Invalid resource response");
    return JSON.parse(value.contents[0]!.text as string);
  }
  async call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const value = await this.client.callTool({ name, arguments: args }, this.options());
    if (value.isError) {
      if (name === "delivery_renew" && value.content.some(c => c.type === "text" && c.text === "error: delivery lease or item not found")) throw new LeaseUnavailable("Delivery lease no longer exists");
      throw new Error("Delivery operation refused");
    }
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
