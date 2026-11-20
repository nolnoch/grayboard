// A generic OpenID Connect provider behind the AS (#928, docs/architecture.md §3): Okta and `oidc` (#1418) are its
// configurations.
// Discovery is lazy and cached, never fetched at construction; the provider's own fetches refuse redirects, time out
// and bound the body; JWKS is jose's, with each verification capped by an overall deadline. `exchange` returns only
// after every check held (D1), the email's domain among them (D5).
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { LOOPBACK } from "../shared/endpoint.ts";
import { cappedBody } from "../shared/capped_body.ts";
import { DomainRefused, type IdentityProvider, type UpstreamIdentity } from "./idp.ts";

export type OidcProviderOptions = {
  id: string;
  label: string;
  issuer: string;                     // exact: discovery's and every ID token's `iss` must equal it
  clientId: string;
  // Absent: a public client (#1418), which authenticates to the token endpoint by PKCE alone and names itself by
  // client_id in the form (RFC 6749 §4.1.3). Present: client_secret_basic.
  clientSecret?: string;
  allowedDomains: readonly string[];  // the email domains this provider may sign in (D5)
  // Tests only: loopback http: endpoints (D6), jose's JWKS cooldown, the verification deadline, the discovery clock.
  allowLoopbackHttp?: boolean;
  cooldownDuration?: number;
  verifyDeadlineMs?: number;
  now?: () => number;
};

const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY = 256 * 1024;
const DISCOVERY_TTL_MS = 60 * 60_000;
const DISCOVERY_RETRY_MS = 30_000;
const VERIFY_DEADLINE_MS = 10_000;
// Asymmetric only: never `none`, never HS* (an HS256 token keyed by the client secret is the classic confusion).
const ASYMMETRIC = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"];
// jose error codes that mean the token failed a check, as opposed to the key set failing to load.
const TOKEN_CODES = /^(ERR_JW[ST]_|ERR_JWKS_(NO|MULTIPLE)_MATCHING_KEY|ERR_JOSE_ALG_NOT_ALLOWED$|ERR_JOSE_NOT_SUPPORTED$)/;
// OIDC Core §2: `sub` is at most 255 ASCII characters.
const MAX_SUBJECT = 255;

type Discovery = { authorization: URL; token: URL; userinfo: URL | null; jwksUri: string; algorithms: string[] };

// A refusal's class says which stage failed, since the AS's failure log keeps only the class (errorDiagnostic): the
// IdP's discovery, its token or userinfo endpoint, its signing keys (JWKS fetch or the verification deadline), or the
// identity itself (a token or claim that failed a check).
export class OidcError extends Error {}
export class OidcDiscoveryError extends OidcError { override name = "OidcDiscoveryError"; }
export class OidcEndpointError extends OidcError { override name = "OidcEndpointError"; }
export class OidcKeysError extends OidcError { override name = "OidcKeysError"; }
export class OidcIdentityError extends OidcError { override name = "OidcIdentityError"; }
type OidcErrorClass = new (message: string, options?: ErrorOptions) => OidcError;

// RFC 6749 §2.3.1: the client ID and secret are each form-encoded (application/x-www-form-urlencoded) before base64.
const formEncode = (s: string) => new URLSearchParams({ v: s }).toString().slice(2);
const basicAuthorization = (id: string, secret: string) => `Basic ${Buffer.from(`${formEncode(id)}:${formEncode(secret)}`).toString("base64")}`;

export function oidcProvider(o: OidcProviderOptions): IdentityProvider {
  const now = o.now ?? Date.now;
  const domains = o.allowedDomains.map(d => d.toLowerCase());
  if (!domains.length) throw new Error(`${o.id}: allowedDomains is required`);
  const deadline = o.verifyDeadlineMs ?? VERIFY_DEADLINE_MS;

  const endpoint = (raw: unknown, what: string): URL => {
    let u: URL;
    try { u = new URL(raw as string); } catch { throw new OidcDiscoveryError(`${o.label} discovery: ${what} is not a URL`); }
    if (typeof raw !== "string" || !(u.protocol === "https:" || (o.allowLoopbackHttp && u.protocol === "http:" && LOOPBACK.has(u.hostname))))
      throw new OidcDiscoveryError(`${o.label} discovery: ${what} must be https`);
    return u;
  };

  // The provider's own requests: no redirects, a 10 s deadline (headers and body), a bounded body, JSON.
  async function json(url: URL, init: RequestInit, what: string, Refusal: OidcErrorClass): Promise<Record<string, unknown>> {
    let res: Response, body: Uint8Array | null;
    try {
      res = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      body = await cappedBody(res, MAX_BODY);
    } catch (error) { throw new Refusal(`${o.label} ${what} request failed`, { cause: error }); }
    if (body === null) throw new Refusal(`${o.label} ${what}: response over ${MAX_BODY} bytes`);
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder().decode(body)); } catch { parsed = undefined; }
    if (!res.ok) {
      const error = parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string" ? `: ${(parsed as { error: string }).error.slice(0, 100)}` : "";
      throw new Refusal(`${o.label} ${what} failed (HTTP ${res.status}${error})`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Refusal(`${o.label} ${what}: not a JSON object`);
    return parsed as Record<string, unknown>;
  }

  let cached: { doc: Discovery; until: number } | undefined;
  let failed: { error: unknown; until: number } | undefined;
  let pending: Promise<Discovery> | undefined;
  let jwks: { uri: string; get: JWTVerifyGetKey } | undefined;

  async function load(): Promise<Discovery> {
    const url = endpoint(`${o.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, "the discovery URL");
    const d = await json(url, { headers: { Accept: "application/json" } }, "discovery", OidcDiscoveryError);
    // Exact, no URL normalizing, as for the AS's own issuer.
    if (d.issuer !== o.issuer) throw new OidcDiscoveryError(`${o.label} discovery names another issuer`);
    for (const [k, v] of Object.entries(d)) if ((k.endsWith("_endpoint") || k === "jwks_uri") && v !== undefined) endpoint(v, k);
    if (!Array.isArray(d.code_challenge_methods_supported) || !d.code_challenge_methods_supported.includes("S256"))
      throw new OidcDiscoveryError(`${o.label} discovery doesn't offer PKCE S256`);
    const offered = Array.isArray(d.id_token_signing_alg_values_supported) ? d.id_token_signing_alg_values_supported : [];
    const algorithms = ASYMMETRIC.filter(a => offered.includes(a));
    if (!algorithms.length) throw new OidcDiscoveryError(`${o.label} discovery offers no asymmetric ID token algorithm`);
    return {
      authorization: endpoint(d.authorization_endpoint, "authorization_endpoint"),
      token: endpoint(d.token_endpoint, "token_endpoint"),
      userinfo: d.userinfo_endpoint === undefined ? null : endpoint(d.userinfo_endpoint, "userinfo_endpoint"),
      jwksUri: endpoint(d.jwks_uri, "jwks_uri").href,
      algorithms,
    };
  }

  // Lazy, cached an hour, a failure retried after 30 s, concurrent first uses sharing one fetch.
  function discovery(): Promise<Discovery> {
    const t = now();
    if (cached && cached.until > t) return Promise.resolve(cached.doc);
    if (failed && failed.until > t) return Promise.reject(failed.error);
    return pending ??= load().then(
      doc => { cached = { doc, until: now() + DISCOVERY_TTL_MS }; failed = undefined; return doc; },
      error => { failed = { error, until: now() + DISCOVERY_RETRY_MS }; throw error; },
    ).finally(() => { pending = undefined; });
  }

  // One key set per jwks_uri, kept across discovery refreshes so jose's cache and cooldown carry over.
  const keys = (d: Discovery): JWTVerifyGetKey => {
    if (jwks?.uri !== d.jwksUri)
      jwks = { uri: d.jwksUri, get: createRemoteJWKSet(new URL(d.jwksUri), o.cooldownDuration === undefined ? undefined : { cooldownDuration: o.cooldownDuration }) };
    return jwks.get;
  };

  // jwtVerify takes no signal, and jose coalesces JWKS reloads: one stalled JWKS body would hold every sign-in that
  // needs a reload until it settles. So each verification has its own overall deadline, its timer cleared on every
  // path, and a miss drops that key set: the next sign-in starts a fresh one rather than waiting on the stalled fetch
  // (one replacement per stall; the orphaned fetch ends at Bun's socket idle timeout).
  async function verify(idToken: string, d: Discovery): Promise<JWTPayload> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const get = keys(d);
    const verifying = jwtVerify(idToken, get, {
      issuer: o.issuer,
      audience: o.clientId,
      algorithms: d.algorithms,
      requiredClaims: ["exp", "iat", "sub"],
      clockTolerance: 60,
      maxTokenAge: 600,
    });
    verifying.catch(() => {});
    try {
      const { payload } = await Promise.race([verifying, new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          if (jwks?.get === get) jwks = undefined;
          reject(new OidcKeysError(`${o.label} ID token verification exceeded ${deadline} ms`));
        }, deadline);
      })]);
      return payload;
    } catch (error) {
      if (error instanceof OidcError) throw error;
      // jose's: a token that failed a check is the identity; anything else (a JWKS fetch's timeout, status, network
      // error or bad body) is the IdP's keys.
      const code = (error as { code?: unknown }).code;
      const Refusal = typeof code === "string" && TOKEN_CODES.test(code) ? OidcIdentityError : OidcKeysError;
      throw new Refusal(`${o.label} ID token refused: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally { clearTimeout(timer); }
  }

  return {
    id: o.id,
    label: o.label,
    issuer: o.issuer,
    // RFC 6749 §4.1.2 and §4.1.2.1, RFC 9207's `iss`, and OIDC Session Management's `session_state`.
    callbackParams: ["code", "state", "iss", "error", "error_description", "error_uri", "session_state"],
    async authorizeUrl({ redirectUri, state, nonce, challenge }) {
      const url = new URL((await discovery()).authorization);
      for (const [k, v] of Object.entries({ client_id: o.clientId, redirect_uri: redirectUri, response_type: "code", scope: "openid email profile",
        state, nonce, code_challenge: challenge, code_challenge_method: "S256" })) url.searchParams.set(k, v);
      return url.href;
    },
    async exchange({ code, verifier, redirectUri, nonce }): Promise<UpstreamIdentity> {
      const d = await discovery();
      const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier });
      const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
      if (o.clientSecret === undefined) form.set("client_id", o.clientId);
      else headers.Authorization = basicAuthorization(o.clientId, o.clientSecret);
      const tokens = await json(d.token, { method: "POST", headers, body: form }, "token exchange", OidcEndpointError);
      if (typeof tokens.id_token !== "string") throw new OidcEndpointError(`${o.label} token response has no id_token`);
      const claims = await verify(tokens.id_token, d);
      // Google's azp rules (verifyGoogleIdToken): a present azp is the client; several audiences need it.
      if ((claims.azp !== undefined && claims.azp !== o.clientId) || (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== o.clientId))
        throw new OidcIdentityError(`${o.label} ID token's azp is not this client`);
      if (typeof claims.nonce !== "string" || !nonce || claims.nonce !== nonce) throw new OidcIdentityError(`${o.label} ID token nonce mismatch`);
      const subject = claims.sub;
      if (typeof subject !== "string" || !subject || subject.length > MAX_SUBJECT) throw new OidcIdentityError(`${o.label} ID token sub is invalid`);

      // email and email_verified come from one document: the ID token when it has both, else userinfo.
      let source: Record<string, unknown> = claims;
      if (claims.email === undefined || claims.email_verified === undefined) {
        if (!d.userinfo) throw new OidcIdentityError(`${o.label} ID token lacks email claims and discovery has no userinfo_endpoint`);
        if (typeof tokens.access_token !== "string") throw new OidcEndpointError(`${o.label} token response has no access_token`);
        source = await json(d.userinfo, { headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: "application/json" } }, "userinfo", OidcEndpointError);
        // OIDC Core §5.3.2.
        if (source.sub !== subject) throw new OidcIdentityError(`${o.label} userinfo names another subject`);
      }
      if (typeof source.email !== "string" || !source.email.trim()) throw new OidcIdentityError(`${o.label} sent no email`);
      if (source.email_verified !== true) throw new OidcIdentityError(`${o.label} email is not verified`);
      const email = source.email.toLowerCase();
      const at = email.lastIndexOf("@");
      if (at < 1) throw new OidcIdentityError(`${o.label} sent an invalid email`);
      if (!domains.includes(email.slice(at + 1))) throw new DomainRefused(`account must be from one of ${domains.map(d => `@${d}`).join(", ")}`);
      const name = typeof claims.name === "string" ? claims.name : typeof source.name === "string" ? source.name : null;
      return { issuer: o.issuer, subject, email, displayName: name };
    },
  };
}
