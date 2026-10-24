import type { Context } from "@opencode/plugin/promise/plugin";
import { Refusal, same, type Configuration, type Enrollment } from "./model.js";

export class Binding {
  constructor(readonly ctx: Context, readonly name: string, readonly drift: () => void) {}
  async configuration(): Promise<Configuration> {
    let result: Configuration | undefined;
    const observer = await this.ctx.mcp.transform(editor => {
      const c = editor.get(this.name);
      if (!c || c.type !== "remote" || !c.oauth || c.disabled) return;
      const headers = new Headers(c.headers);
      const identity = headers.get("X-Grayboard-Identity");
      const scopes = [...new Set(c.oauth.scope?.split(/\s+/).filter(Boolean))].sort();
      if (!identity || !c.oauth.client_id || !scopes.includes("grayboard:tools") || !scopes.includes("grayboard:delivery") || headers.has("Authorization") || headers.has("X-Grayboard-Lease") || headers.has("X-Grayboard-Client")) return;
      const url = new URL(c.url);
      if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) return;
      let metadata = c.oauth.auth_server_metadata_url;
      if (metadata === undefined) {
        const rawPath = /^https:\/\/[^/?#]+(\/[^?#]*)?$/.exec(c.url)?.[1];
        if (rawPath !== url.pathname || !url.pathname.endsWith("/mcp") || url.pathname.includes("//") || /%(?:2e|2f|5c)/i.test(url.pathname)) return;
        metadata = url.origin + "/.well-known/oauth-authorization-server" + url.pathname.slice(0, -4);
      }
      const discovery = new URL(metadata);
      if (discovery.protocol !== "https:" || discovery.username || discovery.password || discovery.hash) return;
      result = { type: "remote", url: url.href, identity, clientID: c.oauth.client_id, scope: scopes.join(" "), discovery: discovery.href };
    });
    await observer.dispose();
    if (!result) throw new Refusal("binding", "Configure an enabled native OAuth HTTP MCP entry with identity, client ID, both Grayboard scopes and a canonical /mcp endpoint or explicit HTTPS discovery URL");
    return result;
  }
  async selection(expected?: Pick<Enrollment, "integrationID" | "connectionID">) {
    const entry = (await this.ctx.mcp.list()).data.find(e => e.name === this.name);
    if (entry?.integrationID && expected && entry.integrationID !== expected.integrationID) this.mismatch();
    if (!entry?.integrationID) throw new Refusal("auth", "Sign in using OpenCode's native MCP interface");
    const connection = await this.ctx.integration.connection.active(entry.integrationID);
    if (connection?.type === "credential" && expected && connection.id !== expected.connectionID) this.mismatch();
    if (!connection || connection.type !== "credential") throw new Refusal("auth", "Sign in using OpenCode's native MCP interface");
    const projected = (await this.ctx.integration.get({ integrationID: entry.integrationID })).data?.connections.find(c => c.type === "credential" && c.id === connection.id);
    if (!projected || projected.status) throw new Refusal("auth", "Native MCP connection requires authentication");
    return { integrationID: entry.integrationID, connectionID: connection.id, connection };
  }
  async capture(expected?: Pick<Enrollment, "configuration" | "integrationID" | "connectionID">) {
    const configuration = await this.configuration();
    if (expected && !same(configuration, expected.configuration)) this.mismatch();
    const selected = await this.selection(expected);
    return { configuration, integrationID: selected.integrationID, connectionID: selected.connectionID };
  }
  private mismatch(): never {
    this.drift();
    throw new Refusal("binding", "Native endpoint, identity or account changed; explicitly enroll again");
  }
  async check(expected: Pick<Enrollment, "configuration" | "integrationID" | "connectionID">) {
    const current = await this.capture(expected);
    if (!same(current, { configuration: expected.configuration, integrationID: expected.integrationID, connectionID: expected.connectionID })) this.mismatch();
  }
  async access(expected: Pick<Enrollment, "configuration" | "integrationID" | "connectionID">) {
    await this.check(expected);
    const selected = await this.selection(expected);
    if (selected.integrationID !== expected.integrationID || selected.connectionID !== expected.connectionID) this.mismatch();
    if (!same(await this.configuration(), expected.configuration)) this.mismatch();
    const credential = await this.ctx.integration.connection.resolve(selected.connection);
    if (credential?.type !== "oauth" || credential.expires <= Date.now() || !credential.access) throw new Refusal("auth", "Native access expired; reconnect or sign in using OpenCode");
    const access = credential.access;
    await this.check(expected);
    return access;
  }
}
