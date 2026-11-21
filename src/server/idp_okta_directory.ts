// Okta's directory check (#1563, docs/server-offboarding.md §3): IdentityProvider.status for the `okta` provider,
// asking the Okta Users API (GET /api/v1/users/{id}) whether the person an Okta sign-in named is still active. The
// server authenticates as an API service app (client credentials, private_key_jwt: the only client authentication
// Okta offers for its API scopes) holding the `okta.users.read` grant and an admin role that can read every user.
// Okta turns on "Require DPoP" for new service apps, so every token request carries a DPoP proof (RFC 9449) from a
// per-process key, and an API call sends `Authorization: DPoP` with a proof whenever the token came back DPoP-bound.
import { createHash, createPrivateKey, randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, importPKCS8, SignJWT, type JWK, type KeyLike } from "jose";
import { cappedBody } from "../shared/capped_body.ts";
import { throttledWarn, tokenCache } from "./idp_directory.ts";

// orgUrl: the Okta org's origin (GRAYBOARD_OKTA_ISSUER's, whichever authorization server signs people in); the token
// endpoint is always the org authorization server's, the only one that mints okta.* scopes. privateKey: a PKCS#8 PEM
// as PKCS#8 PEM (parseOktaDirectoryKey converts a JWK or another PEM); alg follows from its type. keyId: the JWT
// header's `kid`, from the JWK or set.
export type OktaDirectoryConfig = { orgUrl: string; clientId: string; privateKey: string; alg: string; keyId?: string };
export type OktaDirectoryOptions = { fetch?: typeof fetch; now?: () => number };

const MAX_BODY = 256 * 1024;
export const OKTA_USERS_SCOPE = "okta.users.read";
// Okta refuses an assertion whose exp is more than an hour out; a few minutes keeps clear of that under clock skew.
const ASSERTION_TTL_S = 300;
// Okta user ids are `00u` and alphanumerics. The path also takes a login or its shortname, so anything else (an
// email-shaped subject would name whoever holds that login) is refused before a request.
const SUBJECT = /^00u[0-9A-Za-z]{1,252}$/;
// The statuses each answer stands for. LOCKED_OUT is a failed-password lockout and RECOVERY or PASSWORD_EXPIRED a
// password chore, none an offboarding. STAGED, PROVISIONED (also where a reactivated user lands) and anything Okta
// adds later are no answer at all.
const ACTIVE = new Set(["ACTIVE", "LOCKED_OUT", "RECOVERY", "PASSWORD_EXPIRED"]);
const INACTIVE = new Set(["SUSPENDED", "DEPROVISIONED"]);

// Each kind an operator acts on differently has its own name, the audit row's error_class: the token endpoint refused
// the app (its id, key, grant or DPoP), the Users API refused the token (the admin role), a status that is neither
// answer, anything else (a network failure or refused redirect among them).
type ErrorName = "okta_token_refused" | "okta_directory_refused" | "okta_status_unknown" | "okta_directory_error";
class DirectoryError extends Error {
  constructor(name: ErrorName, message: string, options?: ErrorOptions) { super(message, options); this.name = name; }
}

// The org's origin from an Okta issuer: the org authorization server (no path) or a custom one (/oauth2/<id>); null
// for anything else.
export function oktaOrgUrl(issuer: string): string | null {
  let url: URL;
  try { url = new URL(issuer); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && !/^\/oauth2\/[^/]+$/.test(url.pathname)) return null;
  return url.origin;
}

// The service app's private key, refused at startup when it isn't one jose can sign with, naming the variable, never
// the key. RSA signs RS256, an EC key ES256/384/512 by its curve.
export function parseOktaDirectoryKey(raw: string, keyIdVar: string | undefined): { privateKey: string; alg: string; keyId?: string } {
  const name = "GRAYBOARD_OKTA_DIRECTORY_KEY";
  const trimmed = raw.trim();
  let jwk: Record<string, unknown> | undefined;
  if (trimmed.startsWith("{")) {
    try { jwk = JSON.parse(trimmed) as Record<string, unknown>; } catch { throw new Error(`${name} is not a JSON Web Key or a PEM private key`); }
    if (typeof jwk !== "object" || jwk === null || Array.isArray(jwk) || typeof jwk.d !== "string") throw new Error(`${name} is a JSON Web Key without its private part ("d")`);
  } else if (!/^-----BEGIN (RSA |EC )?PRIVATE KEY-----/.test(trimmed)) {
    throw new Error(`${name} is not a JSON Web Key or a PEM private key`);
  }
  let alg: string;
  let pkcs8: string;
  try {
    const key = jwk ? createPrivateKey({ key: jwk as never, format: "jwk" }) : createPrivateKey(trimmed);
    const curve = key.asymmetricKeyDetails?.namedCurve;
    alg = key.asymmetricKeyType === "rsa" ? "RS256"
      : key.asymmetricKeyType === "ec" && curve === "prime256v1" ? "ES256"
      : key.asymmetricKeyType === "ec" && curve === "secp384r1" ? "ES384"
      : key.asymmetricKeyType === "ec" && curve === "secp521r1" ? "ES512" : "";
    // jose's importPKCS8 takes PKCS#8 alone; a PKCS#1 (the Admin Console's PEM may be) or SEC1 key is converted here.
    pkcs8 = key.export({ type: "pkcs8", format: "pem" }) as string;
  } catch { throw new Error(`${name} is not a valid private key`); }
  if (!alg) throw new Error(`${name} must be an RSA or EC (P-256, P-384, P-521) private key`);
  const fromJwk = typeof jwk?.kid === "string" && jwk.kid ? jwk.kid : undefined;
  if (keyIdVar !== undefined && (keyIdVar === "" || /\s/.test(keyIdVar))) throw new Error("GRAYBOARD_OKTA_DIRECTORY_KEY_ID must be the key's id, without whitespace");
  if (keyIdVar !== undefined && fromJwk !== undefined && keyIdVar !== fromJwk) throw new Error("GRAYBOARD_OKTA_DIRECTORY_KEY_ID differs from GRAYBOARD_OKTA_DIRECTORY_KEY's kid");
  const keyId = keyIdVar ?? fromJwk;
  return { privateKey: pkcs8, alg, ...(keyId ? { keyId } : {}) };
}

// status(subject, signal): "inactive" when Okta says the user is suspended or deactivated, or doesn't exist (404
// E0000007, Okta's own "Not found"). Anything else throws.
export function oktaDirectoryStatus(config: OktaDirectoryConfig, options: OktaDirectoryOptions = {}) {
  const send = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const tokenUrl = `${config.orgUrl}/oauth2/v1/token`;
  const usersUrl = `${config.orgUrl}/api/v1/users/`;
  const refused = throttledWarn("Okta directory check", now);
  let signingKey: Promise<KeyLike> | undefined;
  // The DPoP key: one per process, never stored; a restart mints tokens bound to a new one.
  let dpopKey: Promise<{ privateKey: KeyLike; jwk: JWK }> | undefined;
  // The token endpoint's last DPoP nonce, sent with every later mint (Okta keeps an old one valid for days).
  let nonce: string | undefined;

  // Every request: no redirects, a bounded body, parsed as JSON when it is (null otherwise).
  async function request(url: string, init: RequestInit): Promise<{ status: number; ok: boolean; headers: Headers; body: unknown }> {
    let res: Response;
    try { res = await send(url, { ...init, redirect: "error" }); } catch (error) {
      // The caller's abort stays itself, for the re-check's timeout.
      if (init.signal?.aborted) throw error;
      throw new DirectoryError("okta_directory_error", `Okta request failed: ${(error as Error).message}`, { cause: error });
    }
    const raw = await cappedBody(res, MAX_BODY);
    if (raw === null) throw new DirectoryError("okta_directory_error", `Okta response over ${MAX_BODY} bytes`);
    let body: unknown = null;
    try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { /* not JSON */ }
    return { status: res.status, ok: res.ok, headers: res.headers, body };
  }
  // The token endpoint answers OAuth's {error, error_description}, the Users API {errorCode, errorSummary}.
  const errorText = (body: unknown) => {
    const b = body as Record<string, unknown> | null;
    const text = [b?.error, b?.error_description, b?.errorCode, b?.errorSummary].filter(v => typeof v === "string").map(v => (v as string).slice(0, 100)).join(": ");
    return text ? `: ${text}` : "";
  };
  const object = (body: unknown, what: string): Record<string, unknown> => {
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new DirectoryError("okta_directory_error", `${what} is not a JSON object`);
    return body as Record<string, unknown>;
  };

  async function proof(htm: string, htu: string, extra: Record<string, string>): Promise<string> {
    dpopKey ??= generateKeyPair("ES256").then(async ({ privateKey, publicKey }) => {
      const { kty, crv, x, y } = await exportJWK(publicKey);
      return { privateKey, jwk: { kty, crv, x, y } };
    });
    const key = await dpopKey;
    return new SignJWT({ htm, htu, jti: randomUUID(), ...extra })
      .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk: key.jwk })
      .setIssuedAt(Math.floor(now() / 1000))
      .sign(key.privateKey);
  }
  async function assertion(): Promise<string> {
    signingKey ??= importPKCS8(config.privateKey, config.alg);
    const t = Math.floor(now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: config.alg, ...(config.keyId ? { kid: config.keyId } : {}) })
      .setIssuer(config.clientId).setSubject(config.clientId).setAudience(tokenUrl)
      .setIssuedAt(t).setExpirationTime(t + ASSERTION_TTL_S).setJti(randomUUID())
      .sign(await signingKey);
  }

  // A token and how to present it: `DPoP` when Okta bound it to the proof key, else `Bearer`.
  let scheme = "Bearer";
  const tokens = tokenCache(async signal => {
    let res;
    // The first proof without a current nonce earns 400 use_dpop_nonce with one; the retry signs a fresh assertion and
    // proof, since each jti is single-use.
    for (let attempt = 0; ; attempt++) {
      res = await request(tokenUrl, {
        method: "POST", signal,
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", DPoP: await proof("POST", tokenUrl, nonce ? { nonce } : {}) },
        body: new URLSearchParams({
          grant_type: "client_credentials", scope: OKTA_USERS_SCOPE,
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: await assertion(),
        }),
      });
      const fresh = res.headers.get("dpop-nonce");
      if (res.status === 400 && (res.body as { error?: unknown } | null)?.error === "use_dpop_nonce" && fresh && attempt === 0) { nonce = fresh; continue; }
      if (fresh) nonce = fresh;
      break;
    }
    // invalid_client, invalid_scope, invalid_dpop_proof, a second use_dpop_nonce: the app's id, key, grant or DPoP.
    if (res.status === 400 || res.status === 401 || res.status === 403)
      throw refused(new DirectoryError("okta_token_refused", `Okta token request failed (${res.status})${errorText(res.body)}`));
    if (!res.ok) throw new DirectoryError("okta_directory_error", `Okta token request failed (${res.status})`);
    const body = object(res.body, "Okta token response");
    const type = typeof body.token_type === "string" ? body.token_type.toLowerCase() : "";
    if (typeof body.access_token !== "string" || typeof body.expires_in !== "number" || (type !== "dpop" && type !== "bearer"))
      throw new DirectoryError("okta_directory_error", "Okta token response is malformed");
    scheme = type === "dpop" ? "DPoP" : "Bearer";
    return { token: body.access_token, expiresIn: body.expires_in };
  }, now);

  return async function status(subject: string, signal: AbortSignal): Promise<"active" | "inactive"> {
    if (!SUBJECT.test(subject)) throw new DirectoryError("okta_directory_error", "subject is not an Okta user id");
    const token = await tokens.get(signal);
    const url = `${usersUrl}${subject}`;
    const headers: Record<string, string> = { Authorization: `${scheme} ${token}`, Accept: "application/json" };
    if (scheme === "DPoP") headers.DPoP = await proof("GET", url, { ath: createHash("sha256").update(token).digest("base64url") });
    const res = await request(url, { signal, headers });
    if (res.status === 401) tokens.drop();
    if (res.status === 401 || res.status === 403)
      throw refused(new DirectoryError("okta_directory_refused", `Okta user lookup failed (${res.status})${errorText(res.body)}`));
    // Okta's own answer for an unknown id; any other 404 (a proxy, a wrong org URL) is not "gone".
    if (res.status === 404) {
      if ((res.body as { errorCode?: unknown } | null)?.errorCode === "E0000007") return "inactive";
      throw new DirectoryError("okta_directory_error", "Okta user lookup failed (404, not Okta's E0000007)");
    }
    if (!res.ok) throw new DirectoryError("okta_directory_error", `Okta user lookup failed (${res.status})`);
    const user = object(res.body, "Okta user");
    if (user.id !== subject) throw new DirectoryError("okta_directory_error", "Okta user lookup answered for another id");
    if (typeof user.status !== "string") throw new DirectoryError("okta_directory_error", "Okta user is malformed");
    if (ACTIVE.has(user.status)) return "active";
    if (INACTIVE.has(user.status)) return "inactive";
    throw new DirectoryError("okta_status_unknown", `Okta user status ${user.status.slice(0, 40)} is neither active nor offboarded`);
  };
}
