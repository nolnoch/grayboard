import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { hashToken, mintToken, type AuthedUser } from "./auth.ts";
import { callbackPath, defaultProviders, DomainRefused, idpSignIn, type IdentityProvider, type UpstreamIdentity } from "./idp.ts";
import { checkIdpConfig, type Config } from "./config.ts";
import type { Repo } from "./db.ts";
import type { Read, Tx } from "./store/tx.ts";
import { BUILTIN_CLIENT_IDS, BUILTIN_CLIENTS, CLI_CLIENT, CLI_CLIENT_ID, LOGIN_SCOPE, matchesRedirect, oauthPublicUrl, OAUTH_SCOPES, OPENCODE_CLIENT, parseOAuthClients, sourceKeyFor, type OAuthClient } from "./oauth-config.ts";
import { OAUTH_TTL, type OAuthRequest, type OAuthAccess } from "./oauth-types.ts";
import { isValidEmail } from "../shared/addressing.ts";
import { CimdUnavailable, createCimdResolver, type CimdOptions } from "./oauth-cimd.ts";
import { userAgent, writeAudit, type AuditAction } from "./audit.ts";
import { RateLimiter, retrySecs, type RateLimit } from "./rate_limit.ts";
import { hostedFailure } from "./hosted-diagnostics.ts";
import { isTrustedOrigin } from "./origin.ts";
import { SITE_LIMIT_FACTOR } from "./auth_gate.ts";

// `sourceKey` is the `_meta` key that maps this client's hosted session source, or null
// (unmapped: reads only). A pure function of the client ID and the startup config.
export type OAuthPrincipal = {
  authed: AuthedUser; grantId: string; clientId: string; sourceKey: string | null; scopes: string[]; accessHash: string; accessExpiry: number;
};
export type OAuthOptions = {
  now?: () => number;
  cimd?: CimdOptions;
  // Trusted dependency injection, never populated from HTTP or operator client metadata.
  // Defaults to the providers config lists (defaultProviders). Config's own checks never read this list (#928 D6).
  providers?: IdentityProvider[];
};
// The auth gate's keys for the caller: its address (/64 for IPv6) and, for
// IPv6, its /48 (#274), else null.
export type OAuthNetworkContext = { key: string; site?: string | null };
const random = () => randomBytes(32).toString("base64url");
const challenge = (s: string) => createHash("sha256").update(s).digest("base64url");
const escapeHTML = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const secret = (s: string | null): s is string => s !== null && /^[A-Za-z0-9_-]{43}$/.test(s);
class OAuthError extends Error {
  constructor(readonly error: string, readonly status = 400) { super(error); }
}
function fail(error = "invalid_request", status = 400): never { throw new OAuthError(error, status); }
// error_description texts for a refusal after the request is bound (#928): fixed, since they reach any client.
export const REFUSED = {
  domain: "this account's domain isn't allowed on this server",
  provider: "sign-in with the provider failed",
  disabled: "this account is disabled on this server",
} as const;
// RFC 6749 §4.1.2.1: error_description is %x20-21 / %x23-5B / %x5D-7E.
const errorDescription = (text: string) => text.replace(/[^\x20-\x21\x23-\x5b\x5d-\x7e]/g, "?").slice(0, 300);
const headers = { "Cache-Control": "no-store", Pragma: "no-cache", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
const json = (data: unknown, status = 200, extra: Record<string, string> = {}) => Response.json(data, { status, headers: { ...headers, ...extra } });
const html = (body: string, status = 200, callbackOrigin?: string) => new Response(`<!doctype html><html><meta charset="utf-8"><title>Grayboard authorization</title><body>${body}</body></html>`, {
  status, headers: { ...headers, ...(callbackOrigin ? { "Referrer-Policy": "same-origin" } : {}), "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'${callbackOrigin ? " " + callbackOrigin : ""}`, "X-Frame-Options": "DENY" },
});
const cimdUnavailable = () => json({ error: "temporarily_unavailable" }, 503, { "Retry-After": "30" });
const refusal = (e: OAuthError) => json({ error: e.error }, e.status, e.error === "invalid_client" ? { "WWW-Authenticate": "Basic realm=\"oauth\"" } : {});
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
// LOGIN_SCOPE is recognized here and only alone (#928 D8, R3); the caller's per-client check
// (client.scopes.includes) then refuses it for every client but grayboard-cli.
function scopes(raw: string | null, defaults?: string[]): string[] {
  if (raw === null && defaults) return [...defaults];
  if (!raw || !/^[a-zA-Z0-9:_-]+(?: [a-zA-Z0-9:_-]+)*$/.test(raw)) fail("invalid_scope");
  const list = raw!.split(" ");
  if (new Set(list).size !== list.length || list.some(s => !(OAUTH_SCOPES as readonly string[]).includes(s) && s !== LOGIN_SCOPE)) fail("invalid_scope");
  if (list.includes(LOGIN_SCOPE) && list.length > 1) fail("invalid_scope");
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
  checkIdpConfig(config);
  const providers = options.providers ?? defaultProviders(config);
  if (!providers.length || new Set(providers.map(p => p.id)).size !== providers.length || providers.some(p => !/^[a-z0-9-]{1,32}$/.test(p.id)))
    throw new Error("identity providers need distinct, path-safe IDs");
  const providerById = new Map(providers.map(p => [p.id, p]));
  const providerByCallback = new Map(providers.map(p => [callbackPath(p), p]));
  const issuer = oauthPublicUrl(config.publicUrl, config.devAuth);
  const base = new URL(issuer);
  const prefix = base.pathname === "/" ? "" : base.pathname;
  const resource = new URL(issuer + "/mcp").href;
  const endpoint = (path: string) => issuer + path;
  const metadataPath = "/.well-known/oauth-protected-resource" + prefix + "/mcp";
  const resourceMetadata = base.origin + metadataPath;
  // Built-ins and the CLI first; parseOAuthClients refuses an operator entry that reuses one of their IDs.
  const clients = new Map([...BUILTIN_CLIENTS, CLI_CLIENT, ...parseOAuthClients(JSON.stringify(config.oauthClients ?? []))].map(c => [c.clientId, c]));
  const now = options.now ?? Date.now;
  // Before any request, and only once the config parsed: a grant an operator client issued
  // under a now-built-in ID (before #429) would otherwise act as a built-in's.
  const revoked = repo.writeNow(tx => repo.oauth.revokePreBuiltinGrants(tx, BUILTIN_CLIENT_IDS, now()));
  if (revoked) console.error(`[grayboard] revoked ${revoked} OAuth grant(s) issued under a built-in client ID (${BUILTIN_CLIENT_IDS.join(", ")}) before this server had built-in clients; those clients sign in again`);
  // The same once for grayboard-cli (#928 D8), under its own key: the cutover above already ran on most databases.
  const revokedCli = repo.writeNow(tx => repo.oauth.revokePreBuiltinGrants(tx, [CLI_CLIENT_ID], now(), "builtin_clients_cli"));
  if (revokedCli) console.error(`[grayboard] revoked ${revokedCli} OAuth grant(s) issued under ${CLI_CLIENT_ID} before this server reserved it for CLI sign-in`);
  const cimd = createCimdResolver({ ...options.cimd, now });
  // Only listed metadata documents are clients (F-16): any HTTPS URL could otherwise publish
  // redirects that authorize errors follow, and a name the consent page shows.
  const cimdClients = new Set(config.oauthCimdClients ?? [OPENCODE_CLIENT]);
  // defer: the token routes take the CIMD rows instead of their being written, and
  // write them with their refusal row while refusalRows has room (F-18, #933), so a
  // bogus-post flood, or token posts during a listed document's outage, can't write one each.
  type Row = readonly [action: AuditAction, detail?: Record<string, unknown>];
  const resolveClient = async (id: string, defer?: (row: Row) => void) => {
    const row = (r: Row) => { if (defer) defer(r); else writeAudit(repo, r[0], null, null, r[1]); };
    const manual = clients.get(id);
    if (manual) return manual;
    if (!cimdClients.has(id)) { row(["oauth.cimd_refused", { reason: "not_allowed" }]); return undefined; }
    let client: OAuthClient | undefined;
    try { client = await cimd.resolve(id); }
    catch (error) { row(["oauth.cimd_failed", { category: error instanceof CimdUnavailable ? "unavailable" : "unexpected" }]); throw error; }
    if (!client || client.redirectUris.some(uri => new URL(uri).origin === base.origin)) row(["oauth.cimd_refused"]);
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
  // `upstream.provider`: the provider this flow went to; only its callback path may complete it (#928 D7).
  type Flow = { client: OAuthClient; state: string; csrf: string; expiresAt: number; upstream?: { provider: string; stateHash: string; verifier: string; nonce: string } };
  const flows = new Map<string, Flow>();
  const upstream = new Map<string, string>();
  const limiter = (limit: RateLimit, scope: string, maxKeys: number) => new RateLimiter(limit, {
    start: (key, ctx, retryAfterMs) => {
      console.error(`[grayboard] OAuth ${scope} rate limit reached`);
      writeAudit(repo, "oauth.rate_limited", null, key, { scope, ...ctx, retry_after_ms: retryAfterMs });
    },
    end: (key, refused) => writeAudit(repo, "oauth.rate_limit_ended", null, key, { scope, refused }),
    full: (tracked, uncharged) => {
      console.error(`[grayboard] OAuth ${scope} rate limiter at key cap`);
      writeAudit(repo, "oauth.rate_limit_full", null, null, { scope, tracked, uncharged });
    },
  }, now, maxKeys);
  const globalLimit = limiter(config.oauthGlobalLimit ?? { burst: 600, perSec: 10 }, "global", 1);
  const addressRate = config.oauthLimit ?? { burst: 60, perSec: 1 };
  const addressLimit = limiter(addressRate, "address", 10_000);
  const tokenAddressLimit = limiter(addressRate, "token_address", 10_000);
  // The IPv6 /48 tier (#274), as on the auth gate: each address bucket has a
  // /48 sibling, SITE_LIMIT_FACTOR times its size with its own cap, checked
  // after it and spent with it. A new /64 bucket costs its /48 a token, so a
  // prefix rotating /64s holds a bounded number and can't fill the cap.
  const siteRate = { burst: addressRate.burst * SITE_LIMIT_FACTOR, perSec: addressRate.perSec * SITE_LIMIT_FACTOR };
  const siteLimit = limiter(siteRate, "site", 10_000);
  const tokenSiteLimit = limiter(siteRate, "token_site", 10_000);
  // Thins the audit rows of refused token posts org-wide (F-18, #931). It is
  // spent at the refusal and never checked before the work, so a flood of
  // bogus refreshes can't make a valid one wait; while it's empty a refusal
  // answers as usual but writes no row, and the streak's end row counts them.
  // Past the address limiter's key cap this is the only bound on those writes.
  const refusalRows = limiter(config.oauthGlobalLimit ?? { burst: 600, perSec: 10 }, "token_refusal", 1);
  let closed = false;
  const sweep = () => {
    const t = now();
    for (const [h, f] of flows) if (f.expiresAt <= t) { flows.delete(h); if (f.upstream) upstream.delete(f.upstream.stateHash); }
    globalLimit.sweep(); addressLimit.sweep(); tokenAddressLimit.sweep(); siteLimit.sweep(); tokenSiteLimit.sweep(); refusalRows.sweep();
    repo.post(tx => repo.oauth.cleanup(tx, t), undefined, "oauth cleanup");
  };
  // A failed housekeeping transaction is retried next tick, never treated as credential failure.
  const timer = setInterval(() => { try { sweep(); } catch (e) { hostedFailure("oauth.sweep", e); } }, 60_000);
  timer.unref();
  const routes = ["/oauth/authorize", "/oauth/upstream", "/oauth/token", "/oauth/revoke", ...providers.map(callbackPath), "/oauth/consent", "/oauth/complete"];
  const routeName = (path: string) => routes.includes(path) ? path : "/oauth/unknown";
  // Token and revocation posts have their own address bucket and are charged
  // only when they present grant material and are refused, or their listed
  // CIMD client's document is unavailable (#283, #933): a
  // cross-site form post reaches them, and must not lock an office NAT out of
  // token refresh. They never touch the global bucket (F-18, #931): refused
  // refreshes from a handful of addresses would otherwise drain it and block
  // every refresh and sign-in in the org, and a browser-route flood would
  // block refresh. Their work is indexed reads and an allowlisted, cached CIMD
  // client; their writes, the refusal audit rows, are thinned org-wide by
  // refusalRows. Every other route is charged on entry, against its address
  // and the global one. Either kind also spends its IPv6 /48 sibling (#274).
  type Buckets = readonly (readonly [RateLimiter, string])[];
  const buckets = (context: OAuthNetworkContext | undefined, token: boolean): Buckets => {
    const key = context?.key ?? "unknown";
    const site = context?.site;
    return token
      ? [[tokenAddressLimit, key], ...(site ? [[tokenSiteLimit, site] as const] : [])]
      : [[addressLimit, key], ...(site ? [[siteLimit, site] as const] : []), [globalLimit, "global"]];
  };
  const spend = (checks: Buckets, path: string) => { for (const [limit, key] of checks) limit.spend(key, { path: routeName(path) }); };
  const rate = (checks: Buckets, path: string): Response | undefined => {
    // The address goes first, then its /48, then the org-wide bucket, and
    // nothing is spent until all pass: a request its own address refuses
    // must not drain its /48's or the org-wide bucket.
    for (const [limit, key] of checks) {
      const result = limit.check(key, { path: routeName(path) });
      if (!result.ok) return json({ error: "temporarily_unavailable" }, 429, { "Retry-After": String(retrySecs(result.retryAfterMs)) });
    }
  };
  const sameOrigin = (req: Request, mandatory = false) => {
    const origin = req.headers.get("origin");
    if (origin === null && !mandatory) return;
    if (origin === null || !isTrustedOrigin(origin, base.origin)) fail("invalid_request", 403);
  };
  // r: the consent transaction's Tx when it runs inside one (GET /oauth/consent), else repo.read.
  const getFlow = (r: Read, req: Request, id: string) => {
    if (!secret(id)) fail();
    const h = hashToken(id);
    const f = flows.get(h);
    const c = cookies(req);
    if (!f || f.expiresAt <= now() || !c.binding) fail();
    const request = repo.oauth.findRequest(r, h, hashToken(c.binding!), now());
    if (!request) fail();
    return { h, f: f!, r: request!, c };
  };
  const clientAuth = async (req: Request, p: URLSearchParams, defer: (row: Row) => void): Promise<OAuthClient> => {
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
    const c = await resolveClient(id!, defer);
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
  // A fresh upstream state, verifier and nonce for this flow, bound to `provider` (#928 D7). Choosing again replaces
  // the flow's earlier upstream state, which then completes nothing. A provider that can't build its URL (the OIDC
  // provider's discovery failed) ends the flow back at the client as temporarily_unavailable, so a waiting
  // `grayboard login` reports it; the log keeps the error's class.
  const toUpstream = async (id: string, f: Flow, provider: IdentityProvider, redirectUri: string): Promise<Response> => {
    if (f.upstream) upstream.delete(f.upstream.stateHash);
    const upstreamState = random(), verifier = random(), nonce = random();
    f.upstream = { provider: provider.id, stateHash: hashToken(upstreamState), verifier, nonce };
    upstream.set(f.upstream.stateHash, id);
    try {
      return redirect(await provider.authorizeUrl({ redirectUri: endpoint(callbackPath(provider)), state: upstreamState, nonce, challenge: challenge(verifier) }));
    } catch (e) {
      hostedFailure("oauth.upstream", e);
      writeAudit(repo, "oauth.upstream_failed", null, null, { client_id: f.client.clientId, provider: provider.id });
      upstream.delete(f.upstream.stateHash);
      flows.delete(hashToken(id));
      return authorizationResponse(redirectUri, f.state, { error: "temporarily_unavailable" });
    }
  };
  // Several providers and no browser session: one link per provider, in config order, to /oauth/upstream.
  const chooser = (id: string) => html(`<h1>Sign in to Grayboard</h1><ul>${providers.map(p =>
    `<li><a href="${escapeHTML(endpoint("/oauth/upstream") + "?" + new URLSearchParams({ request: id, provider: p.id }))}">Sign in with ${escapeHTML(p.label)}</a></li>`).join("")}</ul>`);
  const consent = (tx: Tx, req: Request, id: string): Response => {
    const { r, c } = getFlow(tx, req, id);
    const sessionHash = c.session && hashToken(c.session);
    const b = sessionHash && repo.oauth.findBrowserSession(tx, sessionHash, now());
    if (!b || !sessionHash) fail();
    const bound = repo.oauth.bindRequestSession(tx, r.requestHash, r.browserHash, sessionHash!, now());
    if (bound.status !== "ok") fail();
    const user = repo.users.findById(b!.userId)!;
    const f = flows.get(r.requestHash)!;
    const client = f.client;
    // A metadata-document client is known by its host; the name in its document is its own claim.
    const host = clients.has(client.clientId) ? undefined : new URL(client.clientId).host;
    const headline = host ? `<h1>Authorize ${escapeHTML(host)}</h1><p>This client calls itself ${escapeHTML(client.name)}; that name is self-declared.</p>` : `<h1>Authorize ${escapeHTML(client.name)}</h1>`;
    // A login code mints a CLI token, not access to the resource it's stored with (#928 D8).
    const grants = r.scopes.includes(LOGIN_SCOPE) ? "<p>Grants: a grayboard CLI sign-in (an API token on this machine)</p>" : `<p>Resource: ${escapeHTML(r.resource)}</p>`;
    return html(`${headline}<p>Account: ${escapeHTML(user.email)}</p>${grants}<p>Redirect: ${escapeHTML(r.redirectUri)}</p><p>Permissions: ${escapeHTML(r.scopes.join(" "))}</p>${new URL(r.redirectUri).protocol === "http:" ? "<p>Local callback: only approve if you started this client.</p>" : ""}<form method="post" action="${escapeHTML(endpoint("/oauth/consent"))}"><input type="hidden" name="request" value="${escapeHTML(id)}"><input type="hidden" name="csrf" value="${escapeHTML(f.csrf)}"><button name="decision" value="approve">Approve</button><button name="decision" value="deny">Deny</button></form>`, 200, new URL(r.redirectUri).origin);
  };

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
      revocation_endpoint_auth_methods_supported: ["none", "client_secret_basic"], client_id_metadata_document_supported: cimdClients.size > 0, authorization_response_iss_parameter_supported: true,
      // RFC 8414 §2 extensions: an adapter (#429) or the CLI (#991) tells an older server apart before it opens a browser.
      grayboard_builtin_clients: BUILTIN_CLIENT_IDS, grayboard_cli_client: CLI_CLIENT_ID });
    if (!path.startsWith("/oauth/")) return undefined;
    if (closed) return json({ error: "temporarily_unavailable" }, 503);
    const tokenRoute = req.method === "POST" && (path === "/oauth/token" || path === "/oauth/revoke");
    // A browser GET that isn't a top-level navigation (an <img>, a no-cors
    // fetch from another site's page) is refused uncharged and unaudited,
    // before any client lookup (#404): every visitor behind one address could
    // otherwise drain its bucket and block that address's sign-ins. A client
    // that sends no Sec-Fetch-Mode (not a browser) is charged as before.
    const mode = req.headers.get("sec-fetch-mode");
    if (req.method === "GET" && mode !== null && mode !== "navigate") return json({ error: "invalid_request" }, 403);
    const checks = buckets(context, tokenRoute);
    const limited = rate(checks, path);
    if (limited) return limited;
    if (!tokenRoute) spend(checks, path);
    const strictQuery = () => {
      if (u.search.length > 8192) fail();
      if (["access_token", "client_secret"].some(k => u.searchParams.getAll(k).some(v => v !== ""))) fail();
    };
    if (!tokenRoute) strictQuery();
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
        if (e instanceof OAuthError) { writeAudit(repo, "oauth.authorize_refused", null, null, { code: e.error }); return authorizationResponse(redirectUri, state, { error: e.error }); }
        throw e;
      }
      sweep();
      if (flows.size >= 1000) fail("temporarily_unavailable", 429);
      const c = cookies(req);
      const binding = c.binding ?? random();
      const id = random(), csrf = random(), t = now();
      const request = await repo.write(tx => repo.oauth.createRequest(tx, { clientId: client.clientId, redirectUri, resource, scopes: selected, codeChallenge,
        requestHash: hashToken(id), browserHash: hashToken(binding), csrfHash: hashToken(csrf), stateHash: hashToken(state),
        consentSessionHash: null, createdAt: t, expiresAt: t + OAUTH_TTL.request }, t));
      if (request.status !== "ok") fail("temporarily_unavailable", 429);
      const f: Flow = { client, state, csrf, expiresAt: t + OAUTH_TTL.request };
      flows.set(hashToken(id), f);
      let response: Response;
      if (c.session && repo.oauth.findBrowserSession(repo.read, hashToken(c.session), t)) {
        response = redirect(endpoint("/oauth/consent") + "?request=" + id);
      } else if (providers.length === 1) {
        response = await toUpstream(id, f, providers[0]!, redirectUri);
      } else {
        response = chooser(id);
      }
      response.headers.append("Set-Cookie", cookie("binding", binding, OAUTH_TTL.browser / 1000));
      writeAudit(repo, "oauth.authorize", null, null, { client_id: client.clientId });
      return response;
    }
    if (path === "/oauth/upstream" && req.method === "GET") {
      // The chooser's link: the flow is found through the binding cookie, as consent's is.
      const p = parameters(u.search.slice(1), ["request", "provider"]);
      const id = required(p, "request");
      const provider = providerById.get(required(p, "provider"));
      if (!provider) fail();
      const { f, r } = getFlow(repo.read, req, id);
      return toUpstream(id, f, provider!, r.redirectUri);
    }
    const provider = req.method === "GET" ? providerByCallback.get(path) : undefined;
    if (provider) {
      const p = parameters(u.search.slice(1), [...provider.callbackParams]);
      if (p.has("iss") && p.get("iss") !== provider.issuer) fail();
      const state = required(p, "state");
      if (!secret(state)) fail();
      const stateHash = hashToken(state), id = upstream.get(stateHash);
      if (!id) fail();
      const { f, r, c } = getFlow(repo.read, req, id!);
      if (f.upstream?.stateHash !== stateHash) fail();
      const upstreamFlow = f.upstream!;
      upstream.delete(stateHash);
      delete f.upstream;
      // Each provider has its own redirect URI and the state names its provider (D7): a code that arrives on
      // another provider's path is refused before any exchange, and its state is spent.
      if (upstreamFlow.provider !== provider.id) fail();
      // From here the request is bound: a refusal goes back to the client (RFC 6749 §4.1.2.1), so `grayboard login` and
      // any other client can report it, with a fixed description per reason. The audit rows are as before.
      const refuse = (description?: string) => { flows.delete(r.requestHash); return returnToClient(r, f, description ? { error: "access_denied", error_description: errorDescription(description) } : { error: "access_denied" }); };
      if (p.has("error")) { writeAudit(repo, "oauth.upstream_denied", null, null, { client_id: r.clientId, provider: provider.id }); return refuse(); }
      let identity: UpstreamIdentity;
      try { identity = await provider.exchange({ code: required(p, "code"), verifier: upstreamFlow.verifier, nonce: upstreamFlow.nonce, redirectUri: endpoint(callbackPath(provider)) }); }
      catch (e) {
        // The provider checked the email's domain (D1, D5); its refusal is audited as such.
        if (e instanceof DomainRefused) { writeAudit(repo, "oauth.domain_refused", null, null, { client_id: r.clientId, provider: provider.id }); return refuse(REFUSED.domain); }
        // The log keeps the error's class, which names the failed stage for the OIDC provider (OidcDiscoveryError…).
        hostedFailure("oauth.exchange", e); writeAudit(repo, "oauth.upstream_failed", null, null, { client_id: r.clientId, provider: provider.id }); return refuse(REFUSED.provider);
      }
      if (f.expiresAt <= now() || closed) fail();
      if (!isValidEmail(identity!.email)) { writeAudit(repo, "oauth.domain_refused", null, null, { client_id: r.clientId, provider: provider.id }); return refuse(REFUSED.provider); }
      const signedIn = await repo.write(tx => idpSignIn(repo, tx, provider, identity!, { client_id: r.clientId }, providers));
      // idpSignIn's text names only the person's email(s), the provider labels and the admin's unlink-idp remedy.
      if ("refused" in signedIn) return refuse(signedIn.refused);
      const { user } = signedIn;
      if (user.disabled_at !== null) { writeAudit(repo, "oauth.user_refused", user.email, null, { client_id: r.clientId }); return refuse(REFUSED.disabled); }
      const session = random(), t = now();
      const created = await repo.write(tx => repo.oauth.createBrowserSession(tx, { sessionHash: hashToken(session), userId: user.id, createdAt: t, expiresAt: t + OAUTH_TTL.browser }, t,
        c.session && hashToken(c.session)));
      if (created.status !== "ok") fail("temporarily_unavailable", 503);
      const response = redirect(endpoint("/oauth/consent") + "?request=" + id);
      response.headers.append("Set-Cookie", cookie("session", session, OAUTH_TTL.browser / 1000));
      writeAudit(repo, "oauth.upstream_authenticated", user.email, null, { client_id: r.clientId, provider: provider.id });
      return response;
    }
    if (path === "/oauth/consent" && req.method === "GET") {
      const p = parameters(u.search.slice(1), ["request"]);
      // The session check and its bind are one transaction; a refusal binds nothing.
      return repo.write(tx => consent(tx, req, required(p, "request")));
    }
    if (path === "/oauth/consent" && req.method === "POST") {
      sameOrigin(req, true);
      if (u.search) fail();
      const p = await form(req);
      if ([...p.keys()].some(k => !["request", "csrf", "decision"].includes(k))) fail();
      const { r, f, c } = getFlow(repo.read, req, required(p, "request"));
      const decision = required(p, "decision");
      if (!["approve", "deny"].includes(decision) || !c.session) fail();
      const sessionHash = hashToken(c.session!);
      const code = random(), t = now();
      // The browser session is read in the decision's transaction, so it can't lapse between them.
      const { b, result } = await repo.write(tx => {
        const b = repo.oauth.findBrowserSession(tx, sessionHash, now());
        if (!b) fail();
        return { b: b!, result: repo.oauth.decideRequest(tx, { requestHash: r.requestHash, browserHash: r.browserHash, sessionHash, csrfHash: hashToken(required(p, "csrf")),
          approve: decision === "approve", code: { ...r, codeHash: hashToken(code), userId: b!.userId, createdAt: t, expiresAt: t + OAUTH_TTL.code } }, t) };
      });
      if (result.status !== "ok") fail();
      writeAudit(repo, decision === "approve" ? "oauth.consent_approved" : "oauth.consent_denied", repo.users.findById(b!.userId)?.email ?? null, null, { client_id: r.clientId });
      flows.delete(r.requestHash);
      return returnToClient(r, f, decision === "approve" ? { code } : { error: "access_denied" });
    }
    if (tokenRoute) {
      // Set once the request presents grant material: before that it is
      // refused uncharged and unaudited, since a cross-site form post can
      // reach that far (#283), and clientAuth's CIMD fetch is never reached.
      let material = false;
      const deferred: Row[] = [];
      try {
        sameOrigin(req);
        strictQuery();
        const query = parameters(u.search.slice(1));
        const body = await form(req);
        const securityFields = ["grant_type", "client_id", "client_secret", "access_token", "code", "code_verifier", "redirect_uri", "resource", "scope", "refresh_token", "token", "token_type_hint"];
        if ([...query].some(([k, v]) => v !== "" && securityFields.includes(k)) || [...query.keys()].some(k => body.has(k))) fail();
        if (body.has("resource") && !body.get("resource")) fail("invalid_grant");
        const submitted = withoutEmpty(body);
        if (submitted.has("access_token")) fail();
        if (!req.headers.has("authorization") && !(path === "/oauth/token" ? ["code", "refresh_token"] : ["token"]).some(k => submitted.has(k))) fail();
        material = true;
        const client = await clientAuth(req, submitted, r => { deferred.push(r); });
        if (path === "/oauth/revoke") {
          const p = recognized(submitted, ["token", "token_type_hint"]);
          const token = hashToken(required(p, "token"));
          await repo.write(tx => repo.oauth.revokeToken(tx, token, client.clientId, now()));
          writeAudit(repo, "oauth.revoke_requested", null, null, { client_id: client.clientId });
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
        let result;
        const pair = (selected: string[]) => ({ clientId: client.clientId, resource, scopes: selected, accessHash: hashToken(access), refreshHash: hashToken(refresh),
          accessExpiresAt: t + OAUTH_TTL.access, refreshExpiresAt: t + OAUTH_TTL.refresh });
        if (grantType === "authorization_code") {
          const verifier = required(p, "code_verifier");
          if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) fail("invalid_grant");
          const codeHash = hashToken(required(p, "code")), redirectUri = required(p, "redirect_uri");
          const sessionToken = mintToken();
          // The code's scopes are read in the redemption's transaction. A refusal before the redemption writes
          // nothing; the redemption's own (a replay revokes the grant or session) commits and is checked after.
          // The stored code's scopes alone pick the redemption: a login code becomes a CLI session (#928 D8).
          const redeemed = await repo.write(tx => {
            const selected = repo.oauth.findCodeScopes(tx, codeHash, client.clientId, resource, redirectUri, t) ?? [];
            if (!selected.length) fail("invalid_grant");
            if (optional(p, "scope") !== null && JSON.stringify(scopes(optional(p, "scope"))) !== JSON.stringify(selected)) fail("invalid_scope");
            const authorization = { clientId: client.clientId, resource, scopes: selected, redirectUri, codeChallenge: challenge(verifier), codeHash };
            if (selected.includes(LOGIN_SCOPE)) return { login: repo.oauth.redeemLoginCode(tx, { ...authorization, tokenHash: hashToken(sessionToken), label: userAgent(req) }, t) };
            return { grant: repo.oauth.redeemCode(tx, { ...authorization, grantId: random(), grantExpiresAt: t + OAUTH_TTL.grant, tokens: pair(selected) }, t) };
          });
          if (redeemed.login) {
            if (redeemed.login.status !== "ok") { if (redeemed.login.status === "replay") hostedFailure("oauth.replay", undefined, "warning"); fail("invalid_grant"); }
            // The CLI's API token (verifySessionToken), not an OAuth access token: no expiry, no refresh.
            return json({ access_token: sessionToken, token_type: "Bearer", scope: LOGIN_SCOPE });
          }
          result = redeemed.grant!;
        } else {
          if (!client.allowRefresh) fail("invalid_grant");
          const refreshHash = hashToken(required(p, "refresh_token"));
          // As the code above: the grant is read in the rotation's transaction.
          result = await repo.write(tx => {
            const grant = repo.oauth.findRefreshGrant(tx, refreshHash, client.clientId, resource, t);
            if (!grant) fail("invalid_grant");
            const selected = scopes(optional(p, "scope"), grant!.scopes);
            if (!selected.every(s => grant!.scopes.includes(s))) fail("invalid_scope");
            return repo.oauth.rotateRefresh(tx, { clientId: client.clientId, resource, scopes: selected, refreshHash, tokens: pair(selected) }, t);
          });
        }
        if (result.status !== "ok") { if (result.status === "replay") hostedFailure("oauth.replay", undefined, "warning"); fail("invalid_grant"); }
        return json({ access_token: access, token_type: "Bearer", expires_in: Math.floor((result.value.tokens.accessExpiresAt - t) / 1000), scope: result.value.tokens.scopes.join(" "),
          ...(client.allowRefresh ? { refresh_token: refresh } : {}) });
      } catch (e) {
        if (!material) { if (e instanceof OAuthError) return refusal(e); throw e; }
        const refused = e instanceof OAuthError && e.status < 500;
        // A listed client's document unavailable is charged as a refusal (#933): retrying posts spend their address,
        // so an office NAT's clients retrying through a long outage can drain it for that address's other token posts.
        if (refused || e instanceof CimdUnavailable) spend(checks, path);
        if (refused || deferred.length) {
          // One decision per refusal, after every await, for all its rows; the CIMD rows go with it. Only a refusal or
          // an outage answers here without a row; any other error (the shutdown 503) keeps fetch's own row.
          if (refusalRows.take("global", { path: routeName(path) }).ok) for (const [action, detail] of deferred) writeAudit(repo, action, null, null, detail);
          else if (refused) return refusal(e as OAuthError);
          else if (e instanceof CimdUnavailable) return cimdUnavailable();
        }
        throw e;
      }
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
  // A live access token and its user's email, by hash. Both reads are cached in the Repo on
  // authGeneration (#853), so the hot path skips the token-grant-user join, and share one read of it (#881).
  // `r`: the Tx of the body the check runs in (hosted's in-body checks, #998), read uncached; else the pool.
  function activeAccess(accessHash: string, r: Read = repo.read): { access: OAuthAccess; email: string } | undefined {
    return repo.authRead(() => {
      const access = repo.oauth.findActiveAccess(r, accessHash, resource, [], now());
      if (!access) return undefined;
      const email = repo.users.activeEmail(access.userId);
      return email === undefined ? undefined : { access, email };
    });
  }
  return {
    issuer, resource, resourceMetadata,
    async fetch(req: Request, context?: OAuthNetworkContext): Promise<Response | undefined> {
      try { return await route(req, context); }
      catch (e) {
        if (e instanceof CimdUnavailable) return cimdUnavailable();
        if (e instanceof OAuthError) { writeAudit(repo, "oauth.request_refused", null, null, { code: e.error, status: e.status }); return refusal(e); }
        hostedFailure("oauth.request", e);
        writeAudit(repo, "oauth.request_failed", null, null, { category: "unexpected" });
        return json({ error: "server_error" }, 500);
      }
    },
    authenticate(req: Request, requiredScopes: string[] = ["grayboard:tools"]): OAuthPrincipal | Response {
      if (requiredScopes.some(s => !(OAUTH_SCOPES as readonly string[]).includes(s))) throw new Error("unknown required OAuth scope");
      const u = new URL(req.url), auth = req.headers.get("authorization");
      if (closed) return bearerError(401, "invalid_token", requiredScopes);
      if (u.searchParams.has("access_token") || !auth || !/^Bearer [A-Za-z0-9_-]{43}$/i.test(auth)) return bearerError(401, auth ? "invalid_token" : undefined, requiredScopes);
      const accessHash = hashToken(auth.slice(7));
      const found = activeAccess(accessHash);
      if (!found) return bearerError(401, "invalid_token", requiredScopes);
      const { access, email } = found;
      if (!requiredScopes.every(s => access.scopes.includes(s))) return bearerError(403, "insufficient_scope", requiredScopes);
      return { authed: { user_id: access.userId, user_email: email, session_id: 0 }, grantId: access.grantId, clientId: access.clientId,
        sourceKey: sourceKeyFor(access.clientId, clients), scopes: [...access.scopes], accessHash, accessExpiry: access.expiresAt };
    },
    isGrantActive(grantId: string): boolean { return !closed && repo.oauth.isGrantActive(repo.read, grantId, now()); },
    isAuthorized(principal: OAuthPrincipal, r?: Read): boolean {
      if (closed || principal.accessExpiry <= now()) return false;
      const a = activeAccess(principal.accessHash, r)?.access;
      return !!a && principal.scopes.every(s => a.scopes.includes(s)) && a.grantId === principal.grantId && a.userId === principal.authed.user_id && a.clientId === principal.clientId && a.expiresAt === principal.accessExpiry;
    },
    close() { closed = true; cimd.close(); clearInterval(timer); flows.clear(); upstream.clear(); },
  };
}
