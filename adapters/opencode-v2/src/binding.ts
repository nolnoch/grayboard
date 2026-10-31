import { createHash } from "node:crypto";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { MCPEditor } from "@opencode/plugin/promise/mcp";
import { AccessExpired, Refusal, same, type Configuration } from "./core/model.js";
import type { CredentialPort } from "./core/port.js";
import type { OpenCodeEnrollment } from "./approval.js";

export const SIGN_IN = "reconnect or sign in using OpenCode";
type Expected = Pick<OpenCodeEnrollment, "configuration" | "integrationID" | "connectionID">;
const fingerprint = (token: string) => createHash("sha256").update(token).digest("hex");
// OpenCode's native MCP grant as the Controller's credential: the plugin reads
// the host's current access token and never refreshes it. `drift` latches every
// root when the endpoint, account or grant behind an enrollment changed.
export class Binding implements CredentialPort<OpenCodeEnrollment> {
  constructor(readonly ctx: Context, readonly name: string, readonly drift: () => void, readonly issuer?: string) {}
  private endpoint(c: ReturnType<MCPEditor["get"]>) {
    if (!c || c.type !== "remote" || c.oauth === false || c.disabled) return;
    const headers = new Headers(c.headers);
    if (["Authorization", "X-Grayboard-Identity", "X-Grayboard-Lease", "X-Grayboard-Client"].some(key => headers.has(key))) return;
    const url = new URL(c.url);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) return;
    const oauth = c.oauth || undefined;
    const configHash = createHash("sha256").update(JSON.stringify([url.href, [...headers.entries()].sort(), oauth?.client_id, oauth?.scope, oauth?.auth_server_metadata_url])).digest("hex");
    return { type: "remote" as const, url: url.href, configHash };
  }
  async watch(expected: Expected, drift = this.drift) {
    let active = true;
    const registration = await this.ctx.mcp.transform(editor => {
      const check = () => {
        if (!active) return;
        try {
          if (!same(this.endpoint(editor.get(this.name)), { type: expected.configuration.type, url: expected.configuration.url, configHash: expected.configuration.configHash })) drift();
        } catch { drift(); }
      };
      check();
      // Later synchronous transforms can still mutate this editor.
      queueMicrotask(check);
    });
    return { async dispose() { active = false; await registration.dispose(); } };
  }
  async configuration() {
    let result: ReturnType<Binding["endpoint"]>;
    const observer = await this.ctx.mcp.transform(editor => { result = this.endpoint(editor.get(this.name)); });
    await observer.dispose();
    if (!result) throw new Refusal("binding", "Configure an enabled native OAuth HTTPS MCP entry without static authority headers");
    return result;
  }
  private mismatch(): never {
    this.drift();
    throw new Refusal("binding", "Native endpoint, grant or account changed; explicitly enroll again");
  }
  async selection(expected?: Pick<OpenCodeEnrollment, "integrationID" | "connectionID">) {
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
  private async project(selected: Awaited<ReturnType<Binding["selection"]>>, endpoint: Awaited<ReturnType<Binding["configuration"]>>) {
    const credential = await this.ctx.integration.connection.resolve(selected.connection);
    if (credential?.type !== "oauth" || !credential.access) throw new Refusal("auth", "Native access unavailable; reconnect or sign in using OpenCode");
    if (credential.expires <= Date.now()) throw new AccessExpired("OpenCode", SIGN_IN);
    const m = credential.metadata as { serverUrl?: unknown; issuer?: unknown; scope?: unknown; client?: { client_id?: unknown } } | undefined;
    if (!m || m.serverUrl !== endpoint.url || typeof m.issuer !== "string" || typeof m.scope !== "string" || typeof m.client?.client_id !== "string") throw new Refusal("auth", "Native OAuth projection lacks server, issuer, client or scopes; reconnect using native MCP");
    const issuer = new URL(m.issuer);
    if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.search || issuer.hash) throw new Refusal("identity", "Native issuer must be HTTPS");
    const scope = [...new Set(m.scope.split(/\s+/).filter(Boolean))].sort();
    if (!scope.includes("grayboard:tools") || !scope.includes("grayboard:delivery")) throw new Refusal("auth", "Native grant needs both Grayboard scopes");
    const configuration: Configuration = { ...endpoint, issuer: m.issuer, clientID: m.client.client_id, scope: scope.join(" ") };
    return { configuration, access: credential.access };
  }
  private async projection(expected?: Expected) {
    const endpoint = await this.configuration();
    if (expected && !same(endpoint, { type: expected.configuration.type, url: expected.configuration.url, configHash: expected.configuration.configHash })) this.mismatch();
    const selected = await this.selection(expected);
    const projected = await this.project(selected, endpoint);
    if (expected && !same(projected.configuration, expected.configuration)) this.mismatch();
    const again = await this.selection(expected ?? selected);
    if (again.connectionID !== selected.connectionID || !same(await this.configuration(), endpoint)) this.mismatch();
    return { configuration: projected.configuration, integrationID: selected.integrationID, connectionID: selected.connectionID };
  }
  async capture(sessionID: string): Promise<OpenCodeEnrollment> {
    const captured = await this.projection();
    if (this.issuer && captured.configuration.issuer !== this.issuer) throw new Refusal("identity", "Native issuer does not match the pinned issuer");
    return { version: 2, sessionID, mcpName: this.name, ...captured };
  }
  async check(expected: Expected) { await this.projection(expected); }
  async access(expected: Expected) {
    await this.check(expected);
    const endpoint = await this.configuration();
    if (!same(endpoint, { type: expected.configuration.type, url: expected.configuration.url, configHash: expected.configuration.configHash })) this.mismatch();
    const selected = await this.selection(expected);
    const projected = await this.project(selected, endpoint);
    if (!same(projected.configuration, expected.configuration)) this.mismatch();
    await this.check(expected);
    return projected.access;
  }
  private rejected(e: Expected) { return `rejectedAccess:${e.integrationID}:${e.connectionID}`; }
  async token(e: OpenCodeEnrollment) {
    const token = await this.access(e);
    if (await this.ctx.storage.get(this.rejected(e)) === fingerprint(token)) throw new Refusal("auth", "Native access was rejected; restore native authentication before resuming");
    return token;
  }
  async unauthorized(e: OpenCodeEnrollment, token: string) {
    if (token) await this.ctx.storage.set(this.rejected(e), fingerprint(token));
    throw new Refusal("auth", "Restore authentication through native MCP; the plugin never refreshes credentials");
  }
}
