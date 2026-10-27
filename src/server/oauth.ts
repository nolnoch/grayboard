import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { exchangeGoogleCode, hashToken, type AuthedUser } from "./auth.ts";
import type { Config } from "./config.ts";
import type { Repo } from "./db.ts";
import { matchesRedirect, oauthPublicUrl, OAUTH_SCOPES, parseOAuthClients, type OAuthClient } from "./oauth-config.ts";
import { OAUTH_TTL, type OAuthRequest } from "./oauth-types.ts";
import { isValidEmail } from "../shared/addressing.ts";
import { CimdUnavailable, createCimdResolver, type CimdOptions } from "./oauth-cimd.ts";

export type OAuthPrincipal = {
  authed: AuthedUser; grantId: string; clientId: string; scopes: string[]; accessHash: string; accessExpiry: number;
};
export type OAuthOptions = {
  now?: () => number;
  cimd?: CimdOptions;
  // Trusted dependency injection, never populated from HTTP or operator client metadata.
  exchangeGoogle?: (input: { code: string; verifier: string; redirectUri: string; nonce: string }) => Promise<{ email: string; displayName: string | null }>;
};
export type OAuthNetworkContext = { remoteAddress: string };
const random = () => randomBytes(32).toString("base64url");
const challenge = (s: string) => createHash("sha256").update(s).digest("base64url");
const escapeHTML = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const secret = (s: string | null): s is string => s !== null && /^[A-Za-z0-9_-]{43}$/.test(s);
class OAuthError extends Error {
  constructor(readonly error: string, readonly status = 400) { super(error); }
}
function fail(error = "invalid_request", status = 400): never { throw new OAuthError(error, status); }
const headers = { "Cache-Control": "no-store", Pragma: "no-cache", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
const json = (data: unknown, status = 200, extra: Record<string, string> = {}) => Response.json(data, { status, headers: { ...headers, ...extra } });
const html = (body: string, status = 200, callbackOrigin?: string) => new Response(`<!doctype html><html><meta charset="utf-8"><title>Grayboard authorization</title><body>${body}</body></html>`, {
  status, headers: { ...headers, ...(callbackOrigin ? { "Referrer-Policy": "same-origin" } : {}), "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'${callbackOrigin ? " " + callbackOrigin : ""}`, "X-Frame-Options": "DENY" },
});
const redirect = (url: string) => new Response(null, { status: 303, headers: { ...headers, Location: url } });

function parameters(raw: string, allowed?: string[]): URLSearchParams {
  if (raw.length > 16_384 || /%(?![a-fA-F0-9]{2})/.test(raw)) fail();
  const p = new URLSearchParams(raw);
  const seen = new Set<string>();
  for (const [k, v] of p) {
    if (seen.has(k) || (allowed && !allowed.includes(k)) || /[\x00-\x1f\x7f\ufffd]/.test(k + v) || v.length > 4096) fail();
    seen.add(k);
  }
  return p;
}
const required = (p: URLSearchParams, key: string) => p.get(key) || fail();
const optional = (p: URLSearchParams, key: string) => p.get(key) || null;
const recognized = (p: URLSearchParams, keys: string[]) => new URLSearchParams([...p].filter(([k]) => keys.includes(k)));
const withoutEmpty = (p: URLSearchParams) => new URLSearchParams([...p].filter(([, v]) => v !== ""));
function scopes(raw: string | null, defaults?: string[]): string[] {
  if (raw === null && defaults) return [...defaults];
  if (!raw || !/^[a-zA-Z0-9:_-]+(?: [a-zA-Z0-9:_-]+)*$/.test(raw)) fail("invalid_scope");
  const list = raw!.split(" ");
  if (new Set(list).size !== list.length || list.some(s => !(OAUTH_SCOPES as readonly string[]).includes(s))) fail("invalid_scope");
  return list.sort();
}
async function form(req: Request): Promise<URLSearchParams> {
  if (req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/x-www-form-urlencoded") fail();
  const length = req.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > 16_384)) fail();
  const reader = req.body?.getReader();
  if (!reader) fail();
  let size = 0;
  const chunks: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = async () => {
      while (true) {
        const { value, done } = await reader!.read();
        if (done) return;
        size += value.byteLength;
        if (size > 16_384) fail();
        chunks.push(value);
      }
    };
    await Promise.race([read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new OAuthError("invalid_request")), 5000); })]);
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); } catch { fail(); }
    return parameters(text);
  } finally {
    clearTimeout(timer);
    void reader!.cancel().catch(() => {});
  }
}

export function createOAuthServer(repo: Repo, config: Config, options: OAuthOptions = {}) {
  if (config.devAuth && (config.googleClientSecret || config.mcpGoogle?.clientSecret)) throw new Error("dev auth must not coexist with a Google client secret");
  const googleClient = config.mcpGoogle ?? { clientId: config.googleClientId, clientSecret: config.googleClientSecret };
  const issuer = oauthPublicUrl(config.publicUrl, config.devAuth);
  const base = new URL(issuer);
  const prefix = base.pathname === "/" ? "" : base.pathname;
  const resource = new URL(issuer + "/mcp").href;
  const endpoint = (path: string) => issuer + path;
  const metadataPath = "/.well-known/oauth-protected-resource" + prefix + "/mcp";
  const resourceMetadata = base.origin + metadataPath;
  const clients = new Map(parseOAuthClients(JSON.stringify(config.oauthClients ?? [])).map(c => [c.clientId, c]));
  const now = options.now ?? Date.now;
  const cimd = createCimdResolver({ ...options.cimd, now });
  const resolveClient = async (id: string) => {
    const manual = clients.get(id);
    if (manual) return manual;
    const client = await cimd.resolve(id);
    if (client?.redirectUris.some(uri => new URL(uri).origin === base.origin)) return undefined;
    return client;
  };
  const secure = base.protocol === "https:";
  const cookiePrefix = secure ? "__Secure-gb_oauth_" : "gb_oauth_";
  const cookiePath = prefix + "/oauth";
  const cookie = (name: string, value: string, seconds: number) => `${cookiePrefix}${name}=${value}; Path=${cookiePath}; Max-Age=${seconds}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  const cookies = (req: Request) => {
    const found = new Map<string, string>();
    const raw = req.headers.get("cookie") ?? "";
    if (raw.length > 8192) fail();
    for (const pair of raw.split(";")) {
      const [name, ...rest] = pair.trim().split("=");
      if (name !== cookiePrefix + "binding" && name !== cookiePrefix + "session") continue;
      if (found.has(name)) fail();
      const value = rest.join("=");
      if (!secret(value)) fail();
      found.set(name, value);
    }
    return { binding: found.get(cookiePrefix + "binding"), session: found.get(cookiePrefix + "session") };
  };
  type Flow = { client: OAuthClient; state: string; csrf: string; expiresAt: number; upstream?: { stateHash: string; verifier: string; nonce: string } };
  const flows = new Map<string, Flow>();
  const upstream = new Map<string, string>();
  const attempts = new Map<string, { start: number; n: number }>();
  let closed = false;
  const sweep = () => {
    const t = now();
    for (const [h, f] of flows) if (f.expiresAt <= t) { flows.delete(h); if (f.upstream) upstream.delete(f.upstream.stateHash); }
    for (const [k, a] of attempts) if (a.start + 60_000 <= t) attempts.delete(k);
    repo.oauth.cleanup(t);
  };
  // A failed housekeeping transaction is retried next tick, never treated as credential failure.
  const timer = setInterval(() => { try { sweep(); } catch {} }, 60_000);
  timer.unref();
  const rate = (context?: OAuthNetworkContext) => {
    const t = now();
    for (const [k, a] of attempts) if (a.start + 60_000 <= t) attempts.delete(k);
    for (const key of ["global", ...(context ? [hashToken(context.remoteAddress)] : [])]) {
      const entry = attempts.get(key) ?? { start: t, n: 0 };
      if (!attempts.has(key) && attempts.size >= 1000) fail("temporarily_unavailable", 429);
      attempts.set(key, entry);
      if (++entry.n > (key === "global" ? 600 : 60)) fail("temporarily_unavailable", 429);
    }
  };
  const sameOrigin = (req: Request, mandatory = false) => {
    const origin = req.headers.get("origin");
    if (origin === null && !mandatory) return;
    if (!origin || !/^https?:\/\/[^\s/@?#,\\]+$/.test(origin)) fail("invalid_request", 403);
    let parsed: URL;
    try { parsed = new URL(origin); } catch { fail("invalid_request", 403); }
    const serialized = origin.replace(parsed.protocol === "https:" ? /:443$/ : /:80$/, "");
    if (serialized !== parsed.origin || parsed.origin !== base.origin) fail("invalid_request", 403);
  };
  const getFlow = (req: Request, id: string) => {
    if (!secret(id)) fail();
    const h = hashToken(id);
    const f = flows.get(h);
    const c = cookies(req);
    if (!f || f.expiresAt <= now() || !c.binding) fail();
    const r = repo.oauth.findRequest(h, hashToken(c.binding!), now());
    if (!r) fail();
    return { h, f: f!, r: r!, c };
  };
  const clientAuth = async (req: Request, p: URLSearchParams): Promise<OAuthClient> => {
    if (p.has("client_secret")) fail("invalid_client", 401);
    const auth = req.headers.get("authorization");
    if (auth && auth.length > 8192) fail("invalid_client", 401);
    let id: string;
    let password: string | undefined;
    if (auth !== null) {
      if (p.has("client_id") || !/^Basic [A-Za-z0-9+/]+={0,2}$/i.test(auth)) fail("invalid_client", 401);
      const decoded = Buffer.from(auth!.slice(6), "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      if (colon < 0) fail("invalid_client", 401);
      try {
        id = decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, " "));
        password = decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, " "));
      } catch { return fail("invalid_client", 401); }
    } else id = p.get("client_id") ?? "";
    const c = await resolveClient(id!);
    if (closed) fail("temporarily_unavailable", 503);
    if (!c) fail("invalid_client", 401);
    if (c!.tokenEndpointAuthMethod === "none") {
      if (auth !== null) fail("invalid_client", 401);
    } else {
      if (password === undefined || !timingSafeEqual(Buffer.from(hashToken(password), "hex"), Buffer.from(c!.clientSecretHash!, "hex"))) fail("invalid_client", 401);
    }
    return c!;
  };
  const authorizationResponse = (redirectUri: string, state: string, fields: Record<string, string>) => {
    const url = new URL(redirectUri);
    for (const [k, v] of Object.entries({ ...fields, state, iss: issuer })) url.searchParams.set(k, v);
    return redirect(url.href);
  };
  const returnToClient = (r: OAuthRequest, f: Flow, fields: Record<string, string>) => authorizationResponse(r.redirectUri, f.state, fields);
  const consent = (req: Request, id: string): Response => {
    const { r, c } = getFlow(req, id);
    const sessionHash = c.session && hashToken(c.session);
    const b = sessionHash && repo.oauth.findBrowserSession(sessionHash, now());
    if (!b || !sessionHash) fail();
    const bound = repo.oauth.bindRequestSession(r.requestHash, r.browserHash, sessionHash!, now());
    if (bound.status !== "ok") fail();
    const user = repo.users.findById(b!.userId)!;
    const f = flows.get(r.requestHash)!;
    const client = f.client;
    const unverified = !clients.has(client.clientId) ? `<p>Unverified client: ${escapeHTML(new URL(client.clientId).host)}. The client name is self-declared.</p>` : "";
    return html(`<h1>Authorize ${escapeHTML(client.name)}</h1>${unverified}<p>Account: ${escapeHTML(user.email)}</p><p>Resource: ${escapeHTML(r.resource)}</p><p>Redirect: ${escapeHTML(r.redirectUri)}</p><p>Permissions: ${escapeHTML(r.scopes.join(" "))}</p>${new URL(r.redirectUri).protocol === "http:" ? "<p>Local callback: only approve if you started this client.</p>" : ""}<form method="post" action="${escapeHTML(endpoint("/oauth/consent"))}"><input type="hidden" name="request" value="${escapeHTML(id)}"><input type="hidden" name="csrf" value="${escapeHTML(f.csrf)}"><button name="decision" value="approve">Approve</button><button name="decision" value="deny">Deny</button></form>`, 200, new URL(r.redirectUri).origin);
  };
  const exchange = options.exchangeGoogle ?? (async (input: { code: string; verifier: string; redirectUri: string; nonce: string }) =>
    exchangeGoogleCode(input.code, input.verifier, input.redirectUri, googleClient.clientId, googleClient.clientSecret, config.orgDomain, input.nonce));

  async function route(req: Request, context?: OAuthNetworkContext): Promise<Response | undefined> {
    const u = new URL(req.url);
    // Explicit aliases support proxies that preserve or strip the configured public prefix.
    const path = prefix && u.pathname.startsWith(prefix + "/") ? u.pathname.slice(prefix.length) : u.pathname;
    const prm = [metadataPath, "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"];
    const as = "/.well-known/oauth-authorization-server" + prefix;
    if (req.method === "GET" && (prm.includes(u.pathname) || prm.includes(path))) return json({ resource, authorization_servers: [issuer], scopes_supported: OAUTH_SCOPES, bearer_methods_supported: ["header"] });
    if (req.method === "GET" && (u.pathname === as || (prefix && path === as))) return json({ issuer,
      authorization_endpoint: endpoint("/oauth/authorize"), token_endpoint: endpoint("/oauth/token"), revocation_endpoint: endpoint("/oauth/revoke"),
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], scopes_supported: OAUTH_SCOPES,
      code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
      revocation_endpoint_auth_methods_supported: ["none", "client_secret_basic"], client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true });
    if (!path.startsWith("/oauth/")) return undefined;
    if (closed) return json({ error: "temporarily_unavailable" }, 503);
    rate(context);
    if (u.search.length > 8192) fail();
    if (["access_token", "client_secret"].some(k => u.searchParams.getAll(k).some(v => v !== ""))) fail();
    if (path === "/oauth/authorize" && req.method === "GET") {
      const raw = parameters(u.search.slice(1));
      const p = recognized(withoutEmpty(raw), ["response_type", "client_id", "redirect_uri", "scope", "resource", "state", "code_challenge", "code_challenge_method"]);
      const client = await resolveClient(required(p, "client_id"));
      if (closed) fail("temporarily_unavailable", 503);
      const redirectUri = required(p, "redirect_uri");
      if (!client || !matchesRedirect(client, redirectUri)) fail();
      const state = required(p, "state");
      if (state.length > 1024) fail();
      let codeChallenge: string, selected: string[];
      try {
        if (required(p, "response_type") !== "code") fail("unsupported_response_type");
        if (raw.has("resource") && !raw.get("resource")) fail();
        if ((optional(p, "resource") ?? resource) !== resource) fail("invalid_target");
        if (required(p, "code_challenge_method") !== "S256") fail();
        codeChallenge = required(p, "code_challenge");
        if (!secret(codeChallenge) || Buffer.from(codeChallenge, "base64url").toString("base64url") !== codeChallenge) fail();
        selected = scopes(optional(p, "scope"));
        if (!selected.every(s => client.scopes.includes(s))) fail("invalid_scope");
      } catch (e) {
        if (e instanceof OAuthError) return authorizationResponse(redirectUri, state, { error: e.error });
        throw e;
      }
      sweep();
      if (flows.size >= 1000) fail("temporarily_unavailable", 429);
      const c = cookies(req);
      const binding = c.binding ?? random();
      const id = random(), csrf = random(), t = now();
      const request = repo.oauth.createRequest({ clientId: client.clientId, redirectUri, resource, scopes: selected, codeChallenge,
        requestHash: hashToken(id), browserHash: hashToken(binding), csrfHash: hashToken(csrf), stateHash: hashToken(state),
        consentSessionHash: null, createdAt: t, expiresAt: t + OAUTH_TTL.request }, t);
      if (request.status !== "ok") fail("temporarily_unavailable", 429);
      const f: Flow = { client, state, csrf, expiresAt: t + OAUTH_TTL.request };
      flows.set(hashToken(id), f);
      let response: Response;
      if (c.session && repo.oauth.findBrowserSession(hashToken(c.session), t)) {
        response = redirect(endpoint("/oauth/consent") + "?request=" + id);
      } else {
        const upstreamState = random(), verifier = random(), nonce = random();
        f.upstream = { stateHash: hashToken(upstreamState), verifier, nonce };
        upstream.set(f.upstream.stateHash, id);
        const google = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        google.search = new URLSearchParams({ client_id: googleClient.clientId, redirect_uri: endpoint("/oauth/google/callback"), response_type: "code",
          scope: "openid email profile", state: upstreamState, nonce, code_challenge: challenge(verifier), code_challenge_method: "S256", hd: config.orgDomain }).toString();
        response = redirect(google.href);
      }
      response.headers.append("Set-Cookie", cookie("binding", binding, OAUTH_TTL.browser / 1000));
      return response;
    }
    if (path === "/oauth/google/callback" && req.method === "GET") {
      const p = parameters(u.search.slice(1), ["code", "state", "error", "error_description", "scope", "authuser", "prompt", "hd", "iss"]);
      if (p.has("iss") && p.get("iss") !== "https://accounts.google.com") fail();
      const state = required(p, "state");
      if (!secret(state)) fail();
      const stateHash = hashToken(state), id = upstream.get(stateHash);
      if (!id) fail();
      const { f, r, c } = getFlow(req, id!);
      if (f.upstream?.stateHash !== stateHash) fail();
      const upstreamFlow = f.upstream!;
      upstream.delete(stateHash);
      delete f.upstream;
      if (p.has("error")) { flows.delete(r.requestHash); return returnToClient(r, f, { error: "access_denied" }); }
      let identity: { email: string; displayName: string | null };
      try { identity = await exchange({ code: required(p, "code"), verifier: upstreamFlow.verifier, nonce: upstreamFlow.nonce, redirectUri: endpoint("/oauth/google/callback") }); }
      catch { fail("access_denied", 403); }
      if (f.expiresAt <= now() || closed) fail();
      if (!isValidEmail(identity!.email) || identity!.email.split("@")[1] !== config.orgDomain) fail("access_denied", 403);
      const user = repo.users.upsertByEmail(identity!.email, identity!.displayName);
      if (user.disabled_at !== null) fail("access_denied", 403);
      const session = random(), t = now();
      const created = repo.oauth.createBrowserSession({ sessionHash: hashToken(session), userId: user.id, createdAt: t, expiresAt: t + OAUTH_TTL.browser }, t,
        c.session && hashToken(c.session));
      if (created.status !== "ok") fail("temporarily_unavailable", 503);
      const response = redirect(endpoint("/oauth/consent") + "?request=" + id);
      response.headers.append("Set-Cookie", cookie("session", session, OAUTH_TTL.browser / 1000));
      return response;
    }
    if (path === "/oauth/consent" && req.method === "GET") {
      const p = parameters(u.search.slice(1), ["request"]);
      return consent(req, required(p, "request"));
    }
    if (path === "/oauth/consent" && req.method === "POST") {
      sameOrigin(req, true);
      if (u.search) fail();
      const p = await form(req);
      if ([...p.keys()].some(k => !["request", "csrf", "decision"].includes(k))) fail();
      const { r, f, c } = getFlow(req, required(p, "request"));
      const decision = required(p, "decision");
      if (!["approve", "deny"].includes(decision) || !c.session) fail();
      const sessionHash = hashToken(c.session!);
      const b = repo.oauth.findBrowserSession(sessionHash, now());
      if (!b) fail();
      const code = random(), t = now();
      const result = repo.oauth.decideRequest({ requestHash: r.requestHash, browserHash: r.browserHash, sessionHash, csrfHash: hashToken(required(p, "csrf")),
        approve: decision === "approve", code: { ...r, codeHash: hashToken(code), userId: b!.userId, createdAt: t, expiresAt: t + OAUTH_TTL.code } }, t);
      if (result.status !== "ok") fail();
      flows.delete(r.requestHash);
      return returnToClient(r, f, decision === "approve" ? { code } : { error: "access_denied" });
    }
    if ((path === "/oauth/token" || path === "/oauth/revoke") && req.method === "POST") {
      sameOrigin(req);
      const query = parameters(u.search.slice(1));
      const body = await form(req);
      const securityFields = ["grant_type", "client_id", "client_secret", "access_token", "code", "code_verifier", "redirect_uri", "resource", "scope", "refresh_token", "token", "token_type_hint"];
      if ([...query].some(([k, v]) => v !== "" && securityFields.includes(k)) || [...query.keys()].some(k => body.has(k))) fail();
      if (body.has("resource") && !body.get("resource")) fail("invalid_grant");
      const submitted = withoutEmpty(body);
      if (submitted.has("access_token")) fail();
      const client = await clientAuth(req, submitted);
      if (path === "/oauth/revoke") {
        const p = recognized(submitted, ["token", "token_type_hint"]);
        repo.oauth.revokeToken(hashToken(required(p, "token")), client.clientId, now());
        return new Response(null, { status: 200, headers });
      }
      const p = recognized(submitted, ["grant_type", "client_id", "code", "code_verifier", "redirect_uri", "resource", "scope", "refresh_token"]);
      const grantType = required(p, "grant_type");
      if (!["authorization_code", "refresh_token"].includes(grantType)) fail("unsupported_grant_type");
      const allowed = grantType === "authorization_code" ? ["grant_type", "client_id", "code", "code_verifier", "redirect_uri", "resource", "scope"] : ["grant_type", "client_id", "refresh_token", "resource", "scope"];
      if ([...p].some(([k, v]) => v !== "" && !allowed.includes(k))) fail();
      if ((optional(p, "resource") ?? resource) !== resource) fail("invalid_grant");
      const t = now();
      const access = random(), refresh = random();
      let selected: string[];
      let result;
      const pair = (selected: string[]) => ({ clientId: client.clientId, resource, scopes: selected, accessHash: hashToken(access), refreshHash: hashToken(refresh),
        accessExpiresAt: t + OAUTH_TTL.access, refreshExpiresAt: t + OAUTH_TTL.refresh });
      if (grantType === "authorization_code") {
        const verifier = required(p, "code_verifier");
        if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) fail("invalid_grant");
        const codeHash = hashToken(required(p, "code")), redirectUri = required(p, "redirect_uri");
        selected = repo.oauth.findCodeScopes(codeHash, client.clientId, resource, redirectUri, t) ?? [];
        if (!selected.length) fail("invalid_grant");
        if (optional(p, "scope") !== null && JSON.stringify(scopes(optional(p, "scope"))) !== JSON.stringify(selected)) fail("invalid_scope");
        result = repo.oauth.redeemCode({ clientId: client.clientId, resource, scopes: selected, redirectUri, codeChallenge: challenge(verifier), codeHash,
          grantId: random(), grantExpiresAt: t + OAUTH_TTL.grant, tokens: pair(selected) }, t);
      } else {
        if (!client.allowRefresh) fail("invalid_grant");
        const refreshHash = hashToken(required(p, "refresh_token"));
        const grant = repo.oauth.findRefreshGrant(refreshHash, client.clientId, resource, t);
        if (!grant) fail("invalid_grant");
        selected = scopes(optional(p, "scope"), grant!.scopes);
        if (!selected.every(s => grant!.scopes.includes(s))) fail("invalid_scope");
        result = repo.oauth.rotateRefresh({ clientId: client.clientId, resource, scopes: selected, refreshHash, tokens: pair(selected) }, t);
      }
      if (result.status !== "ok") fail("invalid_grant");
      return json({ access_token: access, token_type: "Bearer", expires_in: Math.floor((result.value.tokens.accessExpiresAt - t) / 1000), scope: result.value.tokens.scopes.join(" "),
        ...(client.allowRefresh ? { refresh_token: refresh } : {}) });
    }
    if (path === "/oauth/callback/complete" && req.method === "GET") {
      const p = parameters(u.search.slice(1), ["code", "state", "iss", "error", "error_description"]);
      if (required(p, "iss") !== issuer || !p.has("state") || (p.has("code") === p.has("error"))) fail();
      // This is an ordinary registered HTTPS callback, not an OOB grant or code redeemer.
      return html(`<h1>Return to your client</h1><p>Paste this complete callback URL into the client that started authorization. Do not share it.</p><pre>${escapeHTML(endpoint("/oauth/callback/complete") + u.search)}</pre>`);
    }
    return json({ error: "invalid_request" }, 405);
  }
  const bearerError = (status: 401 | 403, error: string | undefined, requiredScopes: string[]) => json({ error: error ?? "unauthorized" }, status, {
    "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadata}", scope="${(status === 401 ? OAUTH_SCOPES : requiredScopes).join(" ")}"${error ? `, error="${error}"` : ""}`,
  });
  return {
    issuer, resource, resourceMetadata,
    async fetch(req: Request, context?: OAuthNetworkContext): Promise<Response | undefined> {
      try { return await route(req, context); }
      catch (e) {
        if (e instanceof CimdUnavailable) return json({ error: "temporarily_unavailable" }, 503, { "Retry-After": "30" });
        if (e instanceof OAuthError) return json({ error: e.error }, e.status, e.error === "invalid_client" ? { "WWW-Authenticate": "Basic realm=\"oauth\"" } : {});
        return json({ error: "server_error" }, 500);
      }
    },
    authenticate(req: Request, requiredScopes: string[] = ["grayboard:tools"]): OAuthPrincipal | Response {
      if (requiredScopes.some(s => !(OAUTH_SCOPES as readonly string[]).includes(s))) throw new Error("unknown required OAuth scope");
      const u = new URL(req.url), auth = req.headers.get("authorization");
      if (closed) return bearerError(401, "invalid_token", requiredScopes);
      if (u.searchParams.has("access_token") || !auth || !/^Bearer [A-Za-z0-9_-]{43}$/i.test(auth)) return bearerError(401, auth ? "invalid_token" : undefined, requiredScopes);
      const accessHash = hashToken(auth.slice(7));
      const access = repo.oauth.findActiveAccess(accessHash, resource, [], now());
      if (!access) return bearerError(401, "invalid_token", requiredScopes);
      if (!requiredScopes.every(s => access.scopes.includes(s))) return bearerError(403, "insufficient_scope", requiredScopes);
      const user = repo.users.findById(access.userId);
      if (!user || user.disabled_at !== null) return bearerError(401, "invalid_token", requiredScopes);
      return { authed: { user_id: user.id, user_email: user.email, session_id: 0 }, grantId: access.grantId, clientId: access.clientId,
        scopes: access.scopes, accessHash, accessExpiry: access.expiresAt };
    },
    isGrantActive(grantId: string): boolean { return !closed && repo.oauth.isGrantActive(grantId, now()); },
    isAuthorized(principal: OAuthPrincipal): boolean {
      if (closed || principal.accessExpiry <= now()) return false;
      const a = repo.oauth.findActiveAccess(principal.accessHash, resource, principal.scopes, now());
      return !!a && a.grantId === principal.grantId && a.userId === principal.authed.user_id && a.clientId === principal.clientId && a.expiresAt === principal.accessExpiry;
    },
    close() { closed = true; cimd.close(); clearInterval(timer); flows.clear(); upstream.clear(); attempts.clear(); },
  };
}
