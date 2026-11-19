import { createHash } from "node:crypto";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { MCPEditor } from "@opencode/plugin/promise/mcp";
import { AccessExpired, Refusal, same, type Configuration } from "./core/model.js";
import type { CredentialPort } from "./core/port.js";
import type { OpenCodeEnrollment } from "./approval.js";
import { ServerUnreachable, unreachable } from "./core/wire.js";

// A TimeoutError anywhere on the cause chain (AbortSignal.timeout's abort).
export function timedOut(error: unknown): boolean {
  for (let e = error, depth = 0; e && depth < 8; e = (e as { cause?: unknown }).cause, depth++) if ((e as { name?: unknown }).name === "TimeoutError") return true;
  return false;
}

export const SIGN_IN = "reconnect or sign in using OpenCode";
// Static mode's action for a refused or missing run token: only the launcher holds the credential (#270 D3).
export const NEW_RUN = "the launcher must start a new run with a fresh run token";
// Static service-credential mode (#270 D3), set only from the launcher's environment (lifecycle.ts `staticMode`):
// the pinned issuer and, optionally, the service the run token must belong to, or why the mode is refused. A refused
// mode never falls back to OAuth.
export type StaticMode = { issuer: string; principal?: string } | { refused: string };
// A static enrollment has no native integration or connection, and the run token doesn't carry its credential's
// client ID: these stand in for them, so the enrollment hash still covers every field.
export const STATIC_CONNECTION = "static", STATIC_CLIENT = "service-credential", STATIC_SCOPE = "grayboard:delivery grayboard:tools";
const AUTHORITY = ["Authorization", "X-Grayboard-Identity", "X-Grayboard-Lease", "X-Grayboard-Client"];
// A run token as the server issues it (an OAuth access token): one run of printable characters, no whitespace.
const BEARER = /^Bearer ([\x21-\x7e]{16,512})$/;
type Expected = Pick<OpenCodeEnrollment, "configuration" | "integrationID" | "connectionID">;
const fingerprint = (token: string) => createHash("sha256").update(token).digest("hex");
// A client stamps a token's `expires` when the token response arrives, so the
// server's own expiry precedes OpenCode's stored one by that response's
// latency (clock skew between the hosts cancels out). A 401 this close to the
// stored expiry is the hourly rollover, not a rejection (#472).
const EXPIRY_SKEW_MS = 5_000;
// A native call whose after hook never came (a host that drops it) stops
// counting as in flight this long after it began.
const CALL_STALE_MS = 10 * 60_000;
// How long a native call waits out a reconnect (#917) before it goes ahead anyway: a reload that never settles
// mustn't hang the agent's call.
const RECONNECT_WAIT_MS = 30_000;
// OpenCode's catalog timeout when the entry sets none (`core/dist/mcp/client.js`).
const CATALOG_TIMEOUT_MS = 30_000;
// OpenCode's native MCP grant as the Controller's credential: the plugin reads
// the host's current access token and never refreshes it itself; past expiry
// it can only make OpenCode reconnect the entry (`refresh`). `drift` latches
// every root when the endpoint, account or grant behind an enrollment changed.
export class Binding implements CredentialPort<OpenCodeEnrollment> {
  constructor(readonly ctx: Context, readonly name: string, readonly drift: () => void, readonly issuer?: string, readonly static_?: StaticMode) {}
  // Static mode: the resource URLs whose protected-resource metadata named the pinned issuer.
  private readonly vouched = new Set<string>();
  // Static auto-enroll (#270 audit F4): the configHash of the entry whose run token whoami checked, by root. The
  // enrollment's own capture must read the same entry, or a token swapped in between would be enrolled unchecked.
  private readonly checked = new Map<string, string>();
  expectChecked(sessionID: string, configHash?: string) {
    if (configHash === undefined) this.checked.delete(sessionID); else this.checked.set(sessionID, configHash);
  }
  // Native calls in flight in this location (by invocation ID, with their start).
  private readonly calls = new Map<string, number>();
  // The connection and stored expiry the last reconnect was for; how many reconnects; their transform.
  private nudged?: string;
  private flips = 0;
  private nudge?: Promise<{ dispose(): Promise<void> }>;
  // A native call waits out a reconnect in progress (#917): one that started
  // mid-reconnect would reach an entry OpenCode has stopped. It counts as in
  // flight first, so no new reconnect starts while it waits or after.
  // Says whether it waited, and whether the wait ran out with the reload unfinished.
  async calling(id: string): Promise<"none" | "waited" | "timeout"> {
    this.calls.set(id, Date.now());
    const deadline = Date.now() + RECONNECT_WAIT_MS;
    let waited = false;
    for (let r; (r = this.reconnecting); ) {
      if (Date.now() >= deadline) return "timeout";
      waited = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([r, new Promise<void>(done => { timer = setTimeout(done, deadline - Date.now()); })]);
      clearTimeout(timer);
    }
    return waited ? "waited" : "none";
  }
  private reconnecting?: Promise<void>;
  called(id: string) { this.calls.delete(id); }
  // The entry this mode accepts, as the type, URL and hash an enrollment pins. OAuth mode: a native OAuth entry with
  // no authority header. Static mode: exactly `oauth: false` and one `Authorization: Bearer <run token>`, no other
  // authority header; its hash covers a digest of the token, so a new run token is a new enrollment.
  private endpoint(c: ReturnType<MCPEditor["get"]>) {
    if (!c || c.type !== "remote" || c.disabled) return;
    const headers = new Headers(c.headers);
    const url = new URL(c.url);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) return;
    if (this.static_) {
      const token = this.bearer(c);
      if (c.oauth !== false || token === undefined) return;
      headers.delete("Authorization");
      if (AUTHORITY.some(key => headers.has(key))) return;
      const configHash = createHash("sha256").update(JSON.stringify(["static", url.href, [...headers.entries()].sort(), fingerprint(token)])).digest("hex");
      return { type: "remote" as const, url: url.href, configHash };
    }
    if (c.oauth === false || AUTHORITY.some(key => headers.has(key))) return;
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
    if (!result) throw new Refusal("binding", this.static_ ? "Configure an enabled HTTPS MCP entry with oauth: false and only an Authorization: Bearer header from the launcher's environment" : "Configure an enabled native OAuth HTTPS MCP entry without static authority headers");
    return result;
  }
  // Static mode: the entry's run token, from its one `Authorization: Bearer` header (OpenCode substitutes the
  // launcher's `{env:…}` into it). Read when a wire needs it and never kept.
  private bearer(c: ReturnType<MCPEditor["get"]>) {
    if (!c || c.type !== "remote") return;
    const values = Object.entries(c.headers ?? {}).filter(([key]) => key.toLowerCase() === "authorization");
    return values.length === 1 ? BEARER.exec(values[0]![1])?.[1] : undefined;
  }
  private pin(): string {
    if (!this.static_) throw new Refusal("identity", "Not in static mode");
    if ("refused" in this.static_) throw new Refusal("identity", this.static_.refused);
    return this.static_.issuer;
  }
  // Static mode has no OAuth metadata to name the issuer, so the pin is bound to the entry: same origin, and the
  // server's protected-resource metadata (RFC 9728) names this URL and the pinned issuer. It guards who can enroll a
  // root: the whoami that decides auto-enroll, and every plugin wire, reach only the pinned server. It doesn't protect
  // the token: OpenCode has sent it to whatever URL the entry names before any plugin code runs (#270 audit F5).
  private async vouch(url: string) {
    const issuer = this.pin();
    if (this.vouched.has(url)) return issuer;
    const resource = new URL(url);
    if (resource.origin !== new URL(issuer).origin) throw new Refusal("identity", "Native issuer does not match the pinned issuer");
    // An outage is not an answer (#1250): a network failure, the 10 s timeout, a 5xx or a 429 throws ServerUnreachable,
    // which callers treat as one (auto-enroll retries it; a wire's token reports it unreachable), and caches nothing.
    // A redirect, another 4xx, or a 2xx whose metadata doesn't name this URL and the pin is the identity refusal.
    let response: Response;
    try {
      response = await fetch(resource.origin + "/.well-known/oauth-protected-resource" + resource.pathname, { redirect: "error", signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      if (unreachable(error) || timedOut(error)) throw new ServerUnreachable(error);
      throw error;
    }
    if (response.status >= 500 || response.status === 429) { await response.body?.cancel().catch(() => {}); throw new ServerUnreachable(new Error(`Protected-resource metadata answered HTTP ${response.status}`)); }
    const metadata = await response.json().catch(() => undefined) as { resource?: unknown; authorization_servers?: unknown } | undefined;
    if (!response.ok || metadata?.resource !== url || !Array.isArray(metadata.authorization_servers) || !metadata.authorization_servers.includes(issuer)) throw new Refusal("identity", "Native issuer does not match the pinned issuer");
    this.vouched.add(url);
    return issuer;
  }
  private async entry() {
    let config: ReturnType<MCPEditor["get"]>;
    const observer = await this.ctx.mcp.transform(editor => { config = editor.get(this.name); });
    await observer.dispose();
    return config;
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
    return { configuration, access: credential.access, expires: credential.expires };
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
    if (this.static_) {
      this.pin();
      const endpoint = await this.configuration(), issuer = await this.vouch(endpoint.url);
      const checked = this.checked.get(sessionID);
      if (checked !== undefined && checked !== endpoint.configHash) throw new Refusal("binding", "Native binding changed during enrollment; explicitly enroll again");
      return { version: 2, sessionID, mcpName: this.name, configuration: { ...endpoint, issuer, clientID: STATIC_CLIENT, scope: STATIC_SCOPE }, integrationID: STATIC_CONNECTION, connectionID: STATIC_CONNECTION };
    }
    const captured = await this.projection();
    if (this.issuer && captured.configuration.issuer !== this.issuer) throw new Refusal("identity", "Native issuer does not match the pinned issuer");
    return { version: 2, sessionID, mcpName: this.name, ...captured };
  }
  async check(expected: Expected) {
    if (!this.static_) { await this.projection(expected); return; }
    const endpoint = await this.configuration();
    if (!same(endpoint, { type: expected.configuration.type, url: expected.configuration.url, configHash: expected.configuration.configHash })) this.mismatch();
    if (expected.configuration.issuer !== this.pin() || expected.integrationID !== STATIC_CONNECTION || expected.connectionID !== STATIC_CONNECTION) this.mismatch();
    await this.vouch(endpoint.url);
  }
  // The host's current access token for `expected`, with its stored expiry.
  private async stored(expected: Expected) {
    await this.check(expected);
    const endpoint = await this.configuration();
    if (!same(endpoint, { type: expected.configuration.type, url: expected.configuration.url, configHash: expected.configuration.configHash })) this.mismatch();
    const selected = await this.selection(expected);
    const projected = await this.project(selected, endpoint);
    if (!same(projected.configuration, expected.configuration)) this.mismatch();
    await this.check(expected);
    return projected;
  }
  async access(expected: Expected) { return (await this.stored(expected)).access; }
  // Static mode's token for `e`: the entry's current run token, once the entry still matches the enrollment.
  private async run(e: OpenCodeEnrollment) {
    await this.check(e);
    const token = this.bearer(await this.entry());
    if (token === undefined) this.mismatch();
    return token;
  }
  private rejected(e: Expected) { return `rejectedAccess:${e.integrationID}:${e.connectionID}`; }
  async token(e: OpenCodeEnrollment) {
    const token = this.static_ ? await this.run(e) : await this.access(e);
    if (await this.ctx.storage.get(this.rejected(e)) === fingerprint(token)) throw this.static_ ? this.runRefused() : new Refusal("auth", "Native access was rejected; restore native authentication before resuming");
    return token;
  }
  // The Controller finds an AccessExpired through the SDK's error wrapping (a plain Refusal thrown from a 401 handler
  // arrives wrapped and unnamed), and pauses on `login_required` with no retry and no refresh.
  private runRefused() { return new AccessExpired("OpenCode", NEW_RUN, "login_required"); }
  // #661: OpenCode 2.1.4 refreshes a native token only when a request draws a
  // 401, so with no native call in this location it never does. A reconnect of
  // the entry makes that request: OpenCode reconnects an entry whose config
  // changed, and a change to `timeout.catalog`, outside the endpoint hash,
  // drifts nothing. Each reconnect flips the value between the user's own
  // (untouched) and one more than it. A reconnect kills a native call in
  // flight, so it waits until there is none, and comes once per stored expiry.
  async refresh(e: OpenCodeEnrollment) {
    // A run token has no host refresh: the launcher mints one per run, so there is nothing to reconnect for.
    if (this.static_ || this.busy()) return false;
    const selected = await this.selection(e);
    const credential = await this.ctx.integration.connection.resolve(selected.connection);
    if (credential?.type !== "oauth" || credential.expires > Date.now()) return false;
    const key = `${selected.connectionID}:${credential.expires}`;
    if (this.nudged === key || this.busy() || this.reconnecting) return false;
    this.nudged = key;
    this.flips++;
    const reconnect = this.reconnect();
    this.reconnecting = reconnect.then(() => {}, () => {});
    try { await reconnect; } finally { this.reconnecting = undefined; }
    return true;
  }
  private async reconnect() {
    this.nudge ??= this.ctx.mcp.transform(editor => {
      if (this.flips % 2 === 0) return;
      editor.update(this.name, c => {
        if (c.type === "remote") c.timeout = { ...c.timeout, catalog: (c.timeout?.catalog ?? CATALOG_TIMEOUT_MS) + 1 };
      });
    });
    await this.nudge;
    await this.ctx.mcp.reload();
  }
  private busy() {
    const now = Date.now();
    for (const [id, at] of this.calls) if (now - at > CALL_STALE_MS) this.calls.delete(id);
    return this.calls.size > 0;
  }
  async dispose() { await (await this.nudge)?.dispose(); }
  // A 401 for `token`: returns when the host already replaced it (the SDK
  // retries with the new one); at its stored expiry it is the rollover
  // (AccessExpired, which the Controller waits out); otherwise the server
  // rejected it, recorded so token() refuses it until native auth changes.
  async unauthorized(e: OpenCodeEnrollment, token: string) {
    // Static mode: a 401 is terminal for the run. `login_required`, never `expired` (which waits for a host refresh
    // and retries), and never a return (which makes the SDK retry): the token's digest is recorded, so token()
    // refuses it before any request until the entry changes.
    if (this.static_) {
      await this.check(e);
      if (token) await this.ctx.storage.set(this.rejected(e), fingerprint(token));
      throw this.runRefused();
    }
    const stored = await this.stored(e);
    if (token && stored.access !== token) return;
    if (stored.expires - Date.now() <= EXPIRY_SKEW_MS) throw new AccessExpired("OpenCode", SIGN_IN);
    if (token) await this.ctx.storage.set(this.rejected(e), fingerprint(token));
    throw new Refusal("auth", "Restore authentication through native MCP; the plugin never refreshes credentials");
  }
}
