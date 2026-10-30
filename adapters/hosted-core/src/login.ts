// Sign-in for an adapter-owned grant (pi, omp, Claude Code): loopback OAuth
// with PKCE S256 against the server's built-in client (#429), one token store
// per (resource, client id), and refresh single-flighted across processes
// under a kernel-released lock. The server revokes the whole grant on any
// reuse of a spent refresh token, with no grace window (src/server/db.ts
// rotateRefresh), so a refresh whose outcome is unknown is never retried:
// its token is revoked and a new sign-in is required.
import { createHash, randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { RecordStatus } from "./diagnostics.js";
import { acquire, LockTimeout, tryAcquire, type Lock } from "./lock.js";
import { AccessExpired, Refusal, RefreshInProgress, ServerOutdated, type AccessReason } from "./model.js";
import type { Configuration, CredentialPort, Enrollment } from "./port.js";
import { readJson, sha256, writeJsonAtomic } from "./storage.js";
import { ServerUnreachable } from "./wire.js";

export const SCOPES = "grayboard:tools grayboard:delivery";
const FLOW_MS = 10 * 60_000;       // the browser round trip's bound
const REFRESH_MARGIN_MS = 60_000;  // refresh once the access token has less left
const REFRESH_LOCK_MS = 15_000;    // waiters never take over; they give up
const WATCH_MS = 2_000;

export type LoginConfig = {
  resource: string;   // the hosted MCP URL
  clientId: string;   // the harness's built-in client, e.g. "grayboard-pi"
  stateDir: string;
  harness: string;    // "pi" | "omp" | "Claude Code", in messages
  loginAction: string; // how this harness signs in, e.g. "run /grayboard login", in AccessExpired
  present(url: string): void | Promise<void>; // open or show the authorization URL
  notify(message: string): void;              // a sign-in already running in another session of this harness
  diagnostic(record: Omit<RecordStatus, "time">): void;
};

// The browser round trip ended without a grant: denied, timed out, a
// mismatched issuer, a refused code exchange, or another session's sign-in
// that this one waited on ended without signing in.
export class LoginFailed extends Error {}

const Reason = z.enum(["invalid_grant", "refresh_outcome_unknown", "logged_out"]);
const Store = z.strictObject({
  version: z.literal(1),
  resource: z.string(),
  clientId: z.string(),
  epoch: z.string().min(1),     // minted per login and logout; part of configHash
  issuer: z.string().optional(),
  scope: z.string().optional(),
  access: z.string().optional(),
  accessExpiresAt: z.number().int().optional(),
  refresh: z.string().optional(),
  pending: z.number().int().optional(), // a refresh request is (or was, if its process died) in flight since this time
  loginRequired: z.strictObject({ reason: Reason }).optional(),
  revoke: z.array(z.string()).optional(), // refresh tokens still to revoke; the next login or refresh sends them
});
export type GrantStore = z.infer<typeof Store>;
type Live = GrantStore & { issuer: string; scope: string; access: string; accessExpiresAt: number; refresh: string };
const live = (s: GrantStore | undefined): s is Live =>
  !!s && !s.loginRequired && s.issuer !== undefined && s.scope !== undefined && s.access !== undefined && s.accessExpiresAt !== undefined && s.refresh !== undefined;

const ResourceMetadata = z.object({ resource: z.string(), authorization_servers: z.array(z.string()).min(1) });
const ServerMetadata = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  revocation_endpoint: z.string(),
  code_challenge_methods_supported: z.array(z.string()),
  authorization_response_iss_parameter_supported: z.boolean().optional(),
  grayboard_builtin_clients: z.array(z.string()).optional(),
});
type ServerMetadata = z.infer<typeof ServerMetadata>;
const Credential = z.string().regex(/^[\x21-\x7e]{1,4096}$/);
const TokenResponse = z.object({
  access_token: Credential,
  token_type: z.string().regex(/^bearer$/i),
  expires_in: z.number().int().positive(),
  scope: z.string(),
  refresh_token: Credential,
});
// Grayboard's own OAuth refusal body (oauth.ts `refusal`), as opposed to a
// gateway's or proxy's.
const OAuthRefusal = z.strictObject({ error: z.string() });

// The request never reached the server: nothing was spent.
const connectCodes = new Set(["ECONNREFUSED", "ConnectionRefused", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "FailedToOpenSocket", "UND_ERR_CONNECT_TIMEOUT"]);
const tlsCode = /CERT|TLS|SSL|SELF_SIGNED|ISSUER|ALTNAME|HANDSHAKE/;
function connectFailure(error: unknown): boolean {
  for (let e = error, depth = 0; e && depth < 8; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && (connectCodes.has(code) || tlsCode.test(code))) return true;
  }
  return false;
}
function refusalOf(response: Response, text: string): string | undefined {
  if (!response.headers.get("content-type")?.includes("application/json")) return undefined;
  try { return OAuthRefusal.parse(JSON.parse(text)).error; } catch { return undefined; }
}
const printable = (text: string) => /^[\x20-\x7e]{1,128}$/.test(text) ? text : "unprintable";
const escapeHTML = (text: string) => text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const form = (fields: Record<string, string>) => ({ method: "POST", redirect: "error" as const, headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams(fields) });

export class Login {
  readonly resource: string;
  readonly path: string; // <stateDir>/grants/<sha256(resource + "\n" + clientId)>.json
  private refreshing?: Promise<string>;
  private signingIn?: Promise<void>;
  constructor(readonly config: LoginConfig) {
    this.resource = new URL(config.resource).href;
    this.path = join(config.stateDir, "grants", `${sha256(`${this.resource}\n${config.clientId}`)}.json`);
  }
  private get refreshLock() { return `${this.path}.refresh.lock`; }
  private expired(reason: AccessReason = "login_required") { return new AccessExpired(this.config.harness, this.config.loginAction, reason); }

  // The store as it is now; undefined before the first login. An unreadable
  // or foreign store reads as signed out, and the next login replaces it.
  async read(): Promise<GrantStore | undefined> {
    let raw: unknown;
    try { raw = await readJson(this.path); } catch (error) { if (error instanceof SyntaxError) return undefined; throw error; }
    const parsed = Store.safeParse(raw);
    return parsed.success && parsed.data.resource === this.resource && parsed.data.clientId === this.config.clientId ? parsed.data : undefined;
  }
  private async live(): Promise<Live> {
    const s = await this.read();
    if (!live(s)) throw this.expired(s?.loginRequired?.reason === "refresh_outcome_unknown" ? "refresh_outcome_unknown" : "login_required");
    return s;
  }
  private write(s: GrantStore) { return writeJsonAtomic(this.path, s); }
  // Signed out: the credentials are gone, the epoch stays (only a login or
  // logout mints one), and `revoke` keeps what still needs revoking.
  private signedOut(s: GrantStore, reason: z.infer<typeof Reason>, revoke: string[]): GrantStore {
    return { version: 1, resource: s.resource, clientId: s.clientId, epoch: s.epoch, ...(s.issuer ? { issuer: s.issuer } : {}), ...(s.scope ? { scope: s.scope } : {}), loginRequired: { reason }, ...(revoke.length ? { revoke } : {}) };
  }

  // ---- token and refresh ----

  // Re-reads the store on every call (another process may have rotated it);
  // throws AccessExpired when only a new sign-in helps.
  async token(): Promise<string> {
    const s = await this.live();
    if (s.accessExpiresAt - Date.now() > REFRESH_MARGIN_MS) return s.access;
    return this.refresh();
  }
  // A 401 for `token`: one forced refresh unless another call already rotated
  // it. Returns when the next token() may succeed, else throws.
  async unauthorized(token: string): Promise<void> {
    const s = await this.live();
    if (s.access !== token) return;
    await this.refresh(token);
  }
  // Single-flight in this process; `stale` forces a refresh of that token.
  private refresh(stale?: string): Promise<string> {
    this.refreshing ??= this.refreshLocked(stale).finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  private async refreshLocked(stale: string | undefined): Promise<string> {
    let lock: Lock;
    try { lock = await acquire(this.refreshLock, { deadlineMs: REFRESH_LOCK_MS }); }
    catch (error) {
      if (!(error instanceof LockTimeout)) throw error;
      const s = await this.live();
      if (s.access !== stale && s.accessExpiresAt > Date.now()) return s.access;
      throw new RefreshInProgress(this.config.harness);
    }
    try {
      const s = await this.live();
      // The previous holder died mid-request: its outcome is unknown.
      if (s.pending !== undefined) return await this.unknown(s, undefined);
      if (stale === undefined ? s.accessExpiresAt - Date.now() > REFRESH_MARGIN_MS : s.access !== stale) return s.access;
      // Preflight: an unreachable server spends nothing.
      let meta: ServerMetadata;
      try { meta = await this.serverMetadata(s.issuer, 5_000); }
      catch (error) { throw error instanceof ServerUnreachable ? error : new ServerUnreachable(error); }
      await this.write({ ...s, pending: Date.now() });
      let response: Response, text: string;
      try {
        response = await fetch(meta.token_endpoint, { ...form({ grant_type: "refresh_token", client_id: this.config.clientId, refresh_token: s.refresh, resource: this.resource }), signal: AbortSignal.timeout(10_000) });
      } catch (error) {
        if (!connectFailure(error)) return await this.unknown(s, meta);
        await this.write(s);
        throw new ServerUnreachable(error);
      }
      try { text = await response.text(); } catch { return await this.unknown(s, meta); }
      if (response.status === 200) {
        let issued: z.infer<typeof TokenResponse>;
        try { issued = TokenResponse.parse(JSON.parse(text)); } catch { return await this.unknown(s, meta); }
        await this.write({ ...s, access: issued.access_token, accessExpiresAt: Date.now() + issued.expires_in * 1000, refresh: issued.refresh_token, scope: issued.scope });
        return issued.access_token;
      }
      const refusal = refusalOf(response, text);
      if (refusal === "invalid_grant") {
        await this.write(this.signedOut(s, "invalid_grant", s.revoke ?? []));
        throw this.expired("login_required");
      }
      if (refusal === "invalid_client") { await this.write(s); throw new ServerOutdated(this.config.harness); }
      // Refused before the token transaction: closed (503, oauth.ts:217,263)
      // or rate limited (429, oauth.ts:178,266).
      if (refusal === "temporarily_unavailable" && (response.status === 503 || response.status === 429)) {
        await this.write(s);
        throw new ServerUnreachable(new Error(`token endpoint answered HTTP ${response.status}`));
      }
      return await this.unknown(s, meta);
    } finally { lock.release(); }
  }
  // The server may have committed the rotation (it marks the token spent
  // before replying), and any reuse revokes the grant as a replay. So the
  // token is never sent again: it is queued and revoked (audited
  // `oauth.revoked`), and a new sign-in is required.
  private async unknown(s: Live, meta: ServerMetadata | undefined): Promise<never> {
    const next = this.signedOut(s, "refresh_outcome_unknown", [...(s.revoke ?? []), s.refresh]);
    await this.write(next);
    this.config.diagnostic({ state: "paused", message: `Token refresh outcome unknown; its grant is revoked; ${this.config.loginAction}`, operation: "refresh", code: "refresh_outcome_unknown" });
    try { await this.revokeQueued(next, meta ?? await this.serverMetadata(s.issuer, 5_000)); } catch {}
    throw this.expired("refresh_outcome_unknown");
  }
  // Revokes every queued refresh token (revoking a refresh token, spent or
  // not, revokes its grant); a failure stays queued. Holds the refresh lock.
  private async revokeQueued(s: GrantStore, meta: ServerMetadata): Promise<void> {
    if (!s.revoke?.length) return;
    const remaining = await this.revokeTokens(s.revoke, meta);
    const { revoke: _, ...rest } = s;
    await this.write(remaining.length ? { ...rest, revoke: remaining } : rest);
  }
  // The tokens the server didn't confirm revoked.
  private async revokeTokens(tokens: string[], meta: ServerMetadata): Promise<string[]> {
    const remaining: string[] = [];
    for (const token of tokens) {
      try {
        const response = await fetch(meta.revocation_endpoint, { ...form({ token, token_type_hint: "refresh_token", client_id: this.config.clientId }), signal: AbortSignal.timeout(10_000) });
        await response.body?.cancel();
        if (response.status !== 200) remaining.push(token);
      } catch { remaining.push(token); }
    }
    return remaining;
  }

  // ---- discovery ----

  private async getJson(url: string, timeoutMs: number): Promise<unknown> {
    let response: Response;
    try { response = await fetch(url, { headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(timeoutMs) }); }
    catch (error) { throw new ServerUnreachable(error); }
    if (response.status >= 500) { await response.body?.cancel(); throw new ServerUnreachable(new Error(`${url} answered HTTP ${response.status}`)); }
    if (response.status !== 200) { await response.body?.cancel(); throw new Error(`${url} answered HTTP ${response.status}`); }
    return response.json();
  }
  // RFC 8414 metadata for `issuer`, from the resource's origin like every
  // grayboard endpoint (a resource never sends its tokens elsewhere).
  private async serverMetadata(issuer: string, timeoutMs: number): Promise<ServerMetadata> {
    const at = new URL(issuer), origin = new URL(this.resource).origin;
    if (at.origin !== origin) throw new Error(`OAuth issuer ${issuer} is not on ${origin}`);
    const meta = ServerMetadata.parse(await this.getJson(`${at.origin}/.well-known/oauth-authorization-server${at.pathname === "/" ? "" : at.pathname}`, timeoutMs));
    if (meta.issuer !== issuer) throw new Error(`OAuth metadata names issuer ${meta.issuer}, expected ${issuer}`);
    for (const endpoint of [meta.authorization_endpoint, meta.token_endpoint, meta.revocation_endpoint]) {
      if (new URL(endpoint).origin !== origin) throw new Error(`OAuth endpoint ${endpoint} is not on ${origin}`);
    }
    return meta;
  }
  // RFC 9728 protected-resource metadata, then the first authorization
  // server's metadata; refuses a server that lacks this harness's client.
  private async discover(): Promise<ServerMetadata> {
    const r = new URL(this.resource);
    const prm = ResourceMetadata.parse(await this.getJson(`${r.origin}/.well-known/oauth-protected-resource${r.pathname === "/" ? "" : r.pathname}`, 10_000));
    if (prm.resource !== this.resource) throw new Error(`Protected resource metadata names ${prm.resource}, expected ${this.resource}`);
    const meta = await this.serverMetadata(prm.authorization_servers[0]!, 10_000);
    if (!meta.code_challenge_methods_supported.includes("S256")) throw new Error("OAuth server does not support PKCE S256");
    if (!meta.grayboard_builtin_clients?.includes(this.config.clientId)) throw new ServerOutdated(this.config.harness);
    return meta;
  }

  // ---- login and logout ----

  // One flow at a time per store across processes: a call that finds
  // another session signing in waits for it and shares its grant.
  login(signal?: AbortSignal): Promise<void> {
    this.signingIn ??= this.signIn(signal).finally(() => { this.signingIn = undefined; });
    return this.signingIn;
  }
  private async signIn(signal: AbortSignal | undefined): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const before = (await this.read())?.epoch;
    const lockPath = `${this.path}.login.lock`;
    let lock = tryAcquire(lockPath);
    const waited = !lock;
    if (!lock) {
      this.config.notify(`sign-in in progress in another ${this.config.harness} session`);
      lock = await acquire(lockPath, { deadlineMs: FLOW_MS + 60_000, ...(signal ? { signal } : {}) });
    }
    try {
      const now = await this.read();
      if (now?.epoch !== before && live(now)) return;
      if (waited) throw new LoginFailed(`sign-in in another ${this.config.harness} session ended without signing in`);
      await this.flow(signal);
    } finally { lock.release(); }
  }
  private async flow(outer: AbortSignal | undefined): Promise<void> {
    const meta = await this.discover();
    await this.drain(meta);
    const signal = AbortSignal.any([AbortSignal.timeout(FLOW_MS), ...(outer ? [outer] : [])]);
    const verifier = randomBytes(32).toString("base64url"), state = randomBytes(16).toString("base64url");
    const callback = await this.callback(state, signal);
    let params: URLSearchParams;
    try {
      const url = new URL(meta.authorization_endpoint);
      url.search = new URLSearchParams({ response_type: "code", client_id: this.config.clientId, redirect_uri: callback.redirectUri, scope: SCOPES, resource: this.resource, state,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).toString();
      await this.config.present(url.href);
      params = await callback.result;
    } finally { callback.close(); }
    // RFC 9207: the response names its issuer, so a mix-up can't land here.
    const iss = params.get("iss");
    if ((meta.authorization_response_iss_parameter_supported || iss !== null) && iss !== meta.issuer) throw new LoginFailed("sign-in response came from an unexpected issuer");
    const error = params.get("error");
    if (error !== null) throw new LoginFailed(error === "access_denied" ? "sign-in was denied" : `sign-in failed (${printable(error)})`);
    const code = params.get("code");
    if (!code) throw new LoginFailed("sign-in response carried no code");
    let response: Response;
    try {
      response = await fetch(meta.token_endpoint, { ...form({ grant_type: "authorization_code", client_id: this.config.clientId, code, code_verifier: verifier, redirect_uri: callback.redirectUri, resource: this.resource }), signal: AbortSignal.timeout(10_000) });
    } catch (error) { throw new ServerUnreachable(error); }
    const text = await response.text();
    if (response.status !== 200) {
      const refusal = refusalOf(response, text);
      if (refusal === "invalid_client") throw new ServerOutdated(this.config.harness);
      throw new LoginFailed(`token request refused (HTTP ${response.status}${refusal ? `: ${printable(refusal)}` : ""})`);
    }
    const issued = TokenResponse.parse(JSON.parse(text));
    await this.commit(meta, issued);
  }
  // Writes the new grant under the refresh lock, so a refresh in flight
  // can't overwrite it, and revokes the grant it replaces.
  private async commit(meta: ServerMetadata, issued: z.infer<typeof TokenResponse>): Promise<void> {
    let lock: Lock;
    try { lock = await acquire(this.refreshLock, { deadlineMs: REFRESH_LOCK_MS }); }
    catch (error) {
      await this.revokeTokens([issued.refresh_token], meta);
      throw error instanceof LockTimeout ? new RefreshInProgress(this.config.harness) : error;
    }
    try {
      const old = await this.read();
      const revoke = [...(old?.revoke ?? []), ...(old?.refresh ? [old.refresh] : [])];
      const next: GrantStore = { version: 1, resource: this.resource, clientId: this.config.clientId, epoch: randomBytes(16).toString("base64url"), issuer: meta.issuer, scope: issued.scope,
        access: issued.access_token, accessExpiresAt: Date.now() + issued.expires_in * 1000, refresh: issued.refresh_token, ...(revoke.length ? { revoke } : {}) };
      await this.write(next);
      await this.revokeQueued(next, meta);
    } finally { lock.release(); }
  }
  // The queue a failed revoke left goes out before a new flow starts.
  private async drain(meta: ServerMetadata): Promise<void> {
    const s = await this.read();
    if (!s?.revoke?.length) return;
    let lock: Lock;
    try { lock = await acquire(this.refreshLock, { deadlineMs: REFRESH_LOCK_MS }); }
    catch (error) { if (error instanceof LockTimeout) return; throw error; }
    try { const current = await this.read(); if (current) await this.revokeQueued(current, meta); }
    finally { lock.release(); }
  }
  // The loopback redirect target (RFC 8252): 127.0.0.1 on a free port. Only
  // a response carrying this flow's state settles it.
  private callback(state: string, signal: AbortSignal): Promise<{ redirectUri: string; result: Promise<URLSearchParams>; close(): void }> {
    return new Promise((ready, failed) => {
      let settle!: (params: URLSearchParams) => void, reject!: (error: unknown) => void;
      const result = new Promise<URLSearchParams>((resolve, rejectResult) => { settle = resolve; reject = rejectResult; });
      result.catch(() => {});
      const harness = escapeHTML(this.config.harness);
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (req.method !== "GET" || url.pathname !== "/callback") { res.writeHead(404).end(); return; }
        if (url.searchParams.get("state") !== state) { res.writeHead(400, { "Content-Type": "text/plain" }).end("Unknown sign-in"); return; }
        const ok = url.searchParams.has("code") && !url.searchParams.has("error");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
          .end(ok ? `<h1>Signed in to grayboard</h1><p>Return to ${harness}.</p>` : `<h1>Grayboard sign-in did not complete</h1><p>Return to ${harness}.</p>`);
        settle(url.searchParams);
      });
      const abort = () => reject(new LoginFailed(signal.reason instanceof DOMException && signal.reason.name === "TimeoutError" ? "sign-in timed out" : "sign-in cancelled"));
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
      const close = () => { signal.removeEventListener("abort", abort); server.close(); server.closeAllConnections(); };
      server.once("error", failed);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") { close(); failed(new Error("loopback callback has no port")); return; }
        ready({ redirectUri: `http://127.0.0.1:${address.port}/callback`, result, close });
      });
    });
  }
  // Revokes the grant and signs every session of this store out: other
  // processes see the new epoch and pause with the login notice.
  async logout(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const lock = await acquire(this.refreshLock, { deadlineMs: REFRESH_LOCK_MS });
    try {
      const s = await this.read();
      const revoke = [...(s?.revoke ?? []), ...(s?.refresh ? [s.refresh] : [])];
      const next: GrantStore = { version: 1, resource: this.resource, clientId: this.config.clientId, epoch: randomBytes(16).toString("base64url"), loginRequired: { reason: "logged_out" }, ...(revoke.length ? { revoke } : {}) };
      await this.write(next);
      if (revoke.length) {
        let meta: ServerMetadata | undefined;
        try { meta = s?.issuer ? await this.serverMetadata(s.issuer, 5_000) : await this.discover(); } catch {}
        if (meta) await this.revokeQueued(next, meta);
      }
    } finally { lock.release(); }
  }

  // ---- the adapter's credential port ----

  private configuration(s: GrantStore | undefined): Configuration | undefined {
    if (!s?.issuer || !s.scope) return undefined;
    return { type: "remote", url: this.resource, issuer: s.issuer, clientID: this.config.clientId, scope: s.scope, configHash: sha256(JSON.stringify([this.resource, this.config.clientId, s.issuer, s.epoch])) };
  }
  // Calls `changed` whenever the store's epoch changes (a login or logout in
  // any process); also how an adapter learns that a sign-in elsewhere ended
  // a root's login pause before it has an enrollment.
  watch(changed: () => void, intervalMs = WATCH_MS): { dispose(): void } {
    let last: Promise<string | undefined> = this.read().then(s => s?.epoch, () => undefined);
    const timer = setInterval(() => {
      last = last.then(async previous => {
        const epoch = await this.read().then(s => s?.epoch, () => previous);
        if (epoch !== previous) changed();
        return epoch;
      });
    }, intervalMs);
    timer.unref?.();
    return { dispose: () => clearInterval(timer) };
  }
  credential(): CredentialPort<Enrollment> {
    const hash = async () => this.configuration(await this.read())?.configHash;
    const check = async (e: Enrollment) => {
      if (await hash() !== e.configuration.configHash) throw new Refusal("binding", `Grayboard sign-in changed in ${this.config.harness}`);
    };
    return {
      capture: async sessionID => {
        const s = await this.live();
        return { version: 2, sessionID, configuration: this.configuration(s)! };
      },
      check,
      watch: async (e, drift) => {
        const watcher = this.watch(() => { void hash().then(h => { if (h !== e.configuration.configHash) drift(); }, () => drift()); });
        return { dispose: async () => watcher.dispose() };
      },
      token: async e => { await check(e); return this.token(); },
      unauthorized: async (e, token) => { await check(e); await this.unauthorized(token); },
    };
  }
}
