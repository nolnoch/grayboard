// Google's directory check (#930 A2b, docs/server-offboarding.md §3): IdentityProvider.status for the Google provider,
// asking the Admin SDK Directory API (users.get) whether the person a Google sign-in named is still active. The server
// acts as a service account that either holds a Workspace admin role itself or has domain-wide delegation and
// impersonates GRAYBOARD_GOOGLE_DIRECTORY_ADMIN (the JWT's `sub`). Three ways to be that service account:
// - "key": its JSON key (GRAYBOARD_GOOGLE_DIRECTORY_KEY), signing the OAuth 2.0 JWT-bearer assertion locally.
// - "metadata" (#1565): no key; on GKE with Workload Identity the metadata server hands out the bound service account's
//   token (GRAYBOARD_GOOGLE_DIRECTORY_SERVICE_ACCOUNT names it).
// - "federated" (#1565): no key; Workload Identity Federation elsewhere (EKS, a VM): GRAYBOARD_GOOGLE_DIRECTORY_KEY is an
//   `external_account` credential configuration, and the platform's OIDC token is exchanged at Google's STS.
// Keyless, the base token reaches the directory scope through IAM Credentials as the service account: generateAccessToken
// (admin role) or signJwt then the same JWT-bearer exchange (delegation, which needs a JWT with `sub`).
import { createPrivateKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { importPKCS8, SignJWT, type KeyLike } from "jose";
import { throttledWarn, tokenCache } from "./idp_directory.ts";

// Where a federated subject token comes from (AIP-4117 credential_source): a file (a projected service account token,
// rotated by the platform, so it's read on every mint) or a URL; `field` is format.subject_token_field_name when the
// source answers JSON.
export type SubjectSource = { file: string; field?: string } | { url: string; headers: Record<string, string>; field?: string };
export type GoogleDirectoryConfig =
  | { kind: "key"; clientEmail: string; privateKey: string; admin?: string }
  | { kind: "metadata"; serviceAccount: string; admin?: string }
  | { kind: "federated"; serviceAccount: string; audience: string; subjectTokenType: string; tokenUrl: string; source: SubjectSource; admin?: string };
// Test seams: where each request goes, and the fetch that sends them.
export type GoogleDirectoryOptions = { tokenUrl?: string; apiBase?: string; metadataUrl?: string; iamBase?: string; fetch?: typeof fetch; now?: () => number };

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_API_BASE = "https://admin.googleapis.com";
const METADATA_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const IAM_CREDENTIALS_BASE = "https://iamcredentials.googleapis.com";
export const DIRECTORY_SCOPE = "https://www.googleapis.com/auth/admin.directory.user.readonly";
// What a keyless base token needs to call IAM Credentials (AIP-4117: the STS token carries cloud-platform when the
// service account is impersonated after it).
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
// Google's error text (invalid_grant, unauthorized_client, "Not Authorized to access this resource") is what tells an
// operator which of key, delegation or role to fix; the audit row carries only the class, so it's logged (throttledWarn).

// The re-check audits a failure by its error's name (auth.idp_check_failed's error_class), so each kind an operator
// acts on differently has its own: the credential refused (fix the key, the federation, the role or the delegation),
// the directory refusing the lookup, anything else (an outage, a quota answer, a malformed body).
class DirectoryError extends Error {
  constructor(name: "google_token_refused" | "google_directory_refused" | "google_directory_error", message: string) { super(message); this.name = name; }
}

const VAR = "GRAYBOARD_GOOGLE_DIRECTORY_KEY";
const SA_VAR = "GRAYBOARD_GOOGLE_DIRECTORY_SERVICE_ACCOUNT";

// The credential as configured. Refused at startup when it isn't usable, naming the field, never the key: a server that
// would fail every check should not start. raw: GRAYBOARD_GOOGLE_DIRECTORY_KEY (a service account key or an
// external_account configuration); serviceAccount: GRAYBOARD_GOOGLE_DIRECTORY_SERVICE_ACCOUNT (GKE, no key).
export function parseDirectoryCredential(raw: string | undefined, serviceAccount: string | undefined, admin: string | undefined): GoogleDirectoryConfig {
  if (admin !== undefined && (admin === "" || !admin.includes("@") || /\s/.test(admin))) throw new Error("GRAYBOARD_GOOGLE_DIRECTORY_ADMIN must be an admin's email address");
  const delegated = admin ? { admin } : {};
  if (raw === undefined || raw === "") {
    if (serviceAccount === undefined) throw new Error(`set ${VAR} or ${SA_VAR}`);
    return { kind: "metadata", serviceAccount: serviceAccountEmail(serviceAccount, SA_VAR), ...delegated };
  }
  if (serviceAccount !== undefined) throw new Error(`set one of ${VAR} and ${SA_VAR}, not both`);
  let key: unknown;
  try { key = JSON.parse(raw); } catch { throw new Error(`${VAR} is not JSON (expected a service account key or an external_account credential configuration)`); }
  const k = key as Record<string, unknown>;
  if (typeof key === "object" && key !== null && k.type === "external_account") return { ...parseExternalAccount(k), ...delegated };
  if (typeof key !== "object" || key === null || k.type !== "service_account") throw new Error(`${VAR} must be a service account key ("type": "service_account") or an external_account credential configuration`);
  if (typeof k.client_email !== "string" || !k.client_email.includes("@")) throw new Error(`${VAR} has no client_email`);
  if (typeof k.private_key !== "string") throw new Error(`${VAR} has no private_key`);
  // jose's importPKCS8 takes only a PKCS#8 PEM from its first byte, as Google's key files are; a PKCS#1 key node would
  // parse would start the server and then fail every check.
  if (!k.private_key.startsWith("-----BEGIN PRIVATE KEY-----")) throw new Error(`${VAR}'s private_key is not a PKCS#8 RSA private key`);
  try {
    const parsed = createPrivateKey(k.private_key);
    if (parsed.asymmetricKeyType !== "rsa") throw new Error("not RSA");
  } catch { throw new Error(`${VAR}'s private_key is not a PKCS#8 RSA private key`); }
  return { kind: "key", clientEmail: k.client_email, privateKey: k.private_key, ...delegated };
}

// The service account key path, as before #1565.
export function parseDirectoryKey(raw: string, admin: string | undefined): GoogleDirectoryConfig {
  return parseDirectoryCredential(raw, undefined, admin);
}

function serviceAccountEmail(v: string, what: string): string {
  if (!/^[^\s@/:]+@[^\s@/:]+$/.test(v)) throw new Error(`${what} must be a service account's email address`);
  return v;
}

const SUBJECT_TOKEN_TYPES = ["urn:ietf:params:oauth:token-type:jwt", "urn:ietf:params:oauth:token-type:id_token"];
const WORKLOAD_AUDIENCE = /^\/\/iam\.googleapis\.com\/projects\/[^/]+\/locations\/[^/]+\/workloadIdentityPools\/[^/]+\/providers\/[^/]+$/;
const IMPERSONATION_URL = /^https:\/\/iamcredentials\.googleapis\.com\/v1\/projects\/-\/serviceAccounts\/([^/:]+):generateAccessToken$/;

// An external_account configuration (AIP-4117) as `gcloud iam workload-identity-pools create-cred-config` writes it,
// for a workload pool with an OIDC provider. The subject token goes to token_url, so that must be Google's (https, a
// googleapis.com host); service account impersonation is required, since only a service account can hold a Workspace
// admin role or delegation.
function parseExternalAccount(k: Record<string, unknown>): Extract<GoogleDirectoryConfig, { kind: "federated" }> {
  const where = `${VAR} (external_account)`;
  if (typeof k.audience !== "string" || !WORKLOAD_AUDIENCE.test(k.audience)) throw new Error(`${where}: audience must be a workload identity pool provider (//iam.googleapis.com/projects/…/workloadIdentityPools/…/providers/…)`);
  if (typeof k.subject_token_type !== "string" || !SUBJECT_TOKEN_TYPES.includes(k.subject_token_type)) throw new Error(`${where}: subject_token_type must be ${SUBJECT_TOKEN_TYPES.join(" or ")} (an OIDC token)`);
  let tokenUrl: URL;
  try { tokenUrl = new URL(typeof k.token_url === "string" ? k.token_url : ""); } catch { throw new Error(`${where}: token_url is not a URL`); }
  if (tokenUrl.protocol !== "https:" || !tokenUrl.hostname.endsWith(".googleapis.com")) throw new Error(`${where}: token_url must be Google's STS endpoint (https, a googleapis.com host)`);
  const impersonation = typeof k.service_account_impersonation_url === "string" ? IMPERSONATION_URL.exec(k.service_account_impersonation_url) : null;
  if (!impersonation) throw new Error(`${where}: service_account_impersonation_url must name the service account (https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/EMAIL:generateAccessToken)`);
  const serviceAccount = serviceAccountEmail(decodeURIComponent(impersonation[1]!), `${where}: service_account_impersonation_url's service account`);
  const cs = k.credential_source as Record<string, unknown> | undefined;
  if (typeof cs !== "object" || cs === null) throw new Error(`${where}: credential_source is missing`);
  if ("environment_id" in cs) throw new Error(`${where}: an AWS credential_source isn't supported; on EKS, point credential_source.file at the pod's projected service account token`);
  if ("executable" in cs || "certificate" in cs) throw new Error(`${where}: only a file or url credential_source is supported`);
  const format = cs.format as Record<string, unknown> | undefined;
  let field: string | undefined;
  if (format !== undefined) {
    if (typeof format !== "object" || format === null || (format.type !== undefined && format.type !== "text" && format.type !== "json")) throw new Error(`${where}: credential_source.format.type must be text or json`);
    if (format.type === "json") {
      if (typeof format.subject_token_field_name !== "string" || format.subject_token_field_name === "") throw new Error(`${where}: credential_source.format.subject_token_field_name is required for json`);
      field = format.subject_token_field_name;
    }
  }
  const fieldOpt = field === undefined ? {} : { field };
  let source: SubjectSource;
  if (typeof cs.file === "string" && cs.file !== "") source = { file: cs.file, ...fieldOpt };
  else if (typeof cs.url === "string" && cs.url !== "") {
    let u: URL;
    try { u = new URL(cs.url); } catch { throw new Error(`${where}: credential_source.url is not a URL`); }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`${where}: credential_source.url must be http or https`);
    const headers = cs.headers ?? {};
    if (typeof headers !== "object" || headers === null || Array.isArray(headers) || !Object.values(headers).every(v => typeof v === "string")) throw new Error(`${where}: credential_source.headers must map names to strings`);
    source = { url: cs.url, headers: headers as Record<string, string>, ...fieldOpt };
  } else throw new Error(`${where}: credential_source needs a file or a url`);
  return { kind: "federated", serviceAccount, audience: k.audience, subjectTokenType: k.subject_token_type, tokenUrl: tokenUrl.href, source };
}

// status(subject, signal): "inactive" when the directory says the user is suspended or archived, or answers 404 (no
// such user; Google doesn't document the status, so the re-check's prior-positive guard is what makes a wrong 404
// harmless). Anything else throws: a refused credential (401/403), a quota answer, a 5xx, a malformed body, a subject
// that isn't a Google user id (Google's `sub` is always digits; refusing anything else keeps `.` and `..` out of the path).
export function googleDirectoryStatus(config: GoogleDirectoryConfig, options: GoogleDirectoryOptions = {}) {
  const send = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const tokenUrl = options.tokenUrl ?? GOOGLE_TOKEN_URL;
  const apiBase = options.apiBase ?? GOOGLE_API_BASE;
  const metadataUrl = options.metadataUrl ?? METADATA_TOKEN_URL;
  const iamBase = options.iamBase ?? IAM_CREDENTIALS_BASE;
  let signingKey: Promise<KeyLike> | undefined;
  const refused = throttledWarn("Google directory check", now);

  // A 400/401/403 (and, for the steps naming a service account, 404) is the credential refused; the body names
  // Google's error code, which tells an operator what to fix, and carries no secret.
  async function check(res: Response, what: string, refusals: number[] = [400, 401, 403]): Promise<Record<string, unknown>> {
    if (refusals.includes(res.status)) throw refused(new DirectoryError("google_token_refused", `${what} failed (${res.status}): ${(await res.text()).slice(0, 200)}`));
    if (!res.ok) throw new DirectoryError("google_directory_error", `${what} failed (${res.status})`);
    return jsonObject(res, `${what} response`);
  }
  const malformed = (what: string) => new DirectoryError("google_directory_error", `${what} response is malformed`);

  // The JWT-bearer grant: an assertion for the service account (signed locally or by signJwt) for an access token.
  async function bearer(assertion: string, signal: AbortSignal): Promise<{ token: string; expiresIn: number }> {
    const res = await send(tokenUrl, {
      method: "POST", signal,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    });
    const body = await check(res, "Google Directory token request");
    if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") throw malformed("Google Directory token request");
    return { token: body.access_token, expiresIn: body.expires_in };
  }

  const claims = () => {
    const iat = Math.floor(now() / 1000);
    return { scope: DIRECTORY_SCOPE, aud: GOOGLE_TOKEN_URL, iat, exp: iat + 3600, ...(config.admin ? { sub: config.admin } : {}) };
  };

  async function subjectToken(source: SubjectSource, signal: AbortSignal): Promise<string> {
    let text: string;
    if ("file" in source) {
      try { text = await readFile(source.file, "utf8"); } catch (e) {
        throw refused(new DirectoryError("google_token_refused", `cannot read the federated subject token ${source.file}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`));
      }
    } else {
      const res = await send(source.url, { signal, headers: source.headers });
      if (!res.ok) throw refused(new DirectoryError("google_token_refused", `federated subject token request failed (${res.status})`));
      text = await res.text();
    }
    let token: unknown = text.trim();
    if (source.field !== undefined) {
      try { token = (JSON.parse(text) as Record<string, unknown> | null)?.[source.field]; } catch { token = undefined; }
    }
    if (typeof token !== "string" || token === "") throw refused(new DirectoryError("google_token_refused", "the federated subject token is empty or missing its field"));
    return token;
  }

  // Keyless: a token for calling IAM Credentials as (or on behalf of) the service account.
  async function baseToken(signal: AbortSignal): Promise<string> {
    if (config.kind === "metadata") {
      const res = await send(metadataUrl, { signal, headers: { "Metadata-Flavor": "Google" } });
      const body = await check(res, "GKE metadata server token request", [400, 401, 403, 404]);
      if (typeof body.access_token !== "string") throw malformed("GKE metadata server token request");
      return body.access_token;
    }
    if (config.kind !== "federated") throw new Error("unreachable");
    // RFC 8693 token exchange, form-encoded as Google's own client sends it.
    const res = await send(config.tokenUrl, {
      method: "POST", signal,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        audience: config.audience,
        scope: CLOUD_PLATFORM_SCOPE,
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
        subject_token: await subjectToken(config.source, signal),
        subject_token_type: config.subjectTokenType,
      }),
    });
    const body = await check(res, "Google STS token exchange");
    if (typeof body.access_token !== "string") throw malformed("Google STS token exchange");
    return body.access_token;
  }

  async function mint(signal: AbortSignal): Promise<{ token: string; expiresIn: number }> {
    if (config.kind === "key") {
      signingKey ??= importPKCS8(config.privateKey, "RS256");
      const c = claims();
      const jwt = new SignJWT({ scope: c.scope }).setProtectedHeader({ alg: "RS256", typ: "JWT" }).setIssuer(config.clientEmail).setAudience(c.aud).setIssuedAt(c.iat).setExpirationTime(c.exp);
      if (config.admin) jwt.setSubject(config.admin);
      return bearer(await jwt.sign(await signingKey), signal);
    }
    const base = await baseToken(signal);
    const account = `${iamBase}/v1/projects/-/serviceAccounts/${encodeURIComponent(config.serviceAccount)}`;
    const post = (method: string, body: unknown) => send(`${account}:${method}`, {
      method: "POST", signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${base}` },
      body: JSON.stringify(body),
    });
    if (config.admin) {
      // Delegation needs `sub`, which only a JWT-bearer assertion carries: IAM Credentials signs it as the service account.
      const body = await check(await post("signJwt", { payload: JSON.stringify({ iss: config.serviceAccount, ...claims() }) }), "IAM Credentials signJwt", [400, 401, 403, 404]);
      if (typeof body.signedJwt !== "string") throw malformed("IAM Credentials signJwt");
      return bearer(body.signedJwt, signal);
    }
    const body = await check(await post("generateAccessToken", { scope: [DIRECTORY_SCOPE], lifetime: "3600s" }), "IAM Credentials generateAccessToken", [400, 401, 403, 404]);
    const expires = typeof body.expireTime === "string" ? Date.parse(body.expireTime) : NaN;
    if (typeof body.accessToken !== "string" || Number.isNaN(expires)) throw malformed("IAM Credentials generateAccessToken");
    return { token: body.accessToken, expiresIn: Math.floor((expires - now()) / 1000) };
  }
  // One token request at a time: concurrent checks of different users share it.
  const tokens = tokenCache(mint, now);

  return async function status(subject: string, signal: AbortSignal): Promise<"active" | "inactive"> {
    if (!/^\d+$/.test(subject)) throw new DirectoryError("google_directory_error", "subject is not a Google user id");
    const token = await tokens.get(signal);
    const res = await send(`${apiBase}/admin/directory/v1/users/${encodeURIComponent(subject)}?fields=suspended,archived`, {
      signal, headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 404) return "inactive";
    if (res.status === 401) tokens.drop();
    if (res.status === 401 || res.status === 403) throw refused(new DirectoryError("google_directory_refused", `Google Directory users.get failed (${res.status}): ${(await res.text()).slice(0, 200)}`));
    if (!res.ok) throw new DirectoryError("google_directory_error", `Google Directory users.get failed (${res.status})`);
    const user = await jsonObject(res, "Google Directory user");
    if (typeof user.suspended !== "boolean" || (user.archived !== undefined && typeof user.archived !== "boolean")) throw new DirectoryError("google_directory_error", "Google Directory user is malformed");
    return user.suspended || user.archived === true ? "inactive" : "active";
  };
}

// A 200 whose body isn't a JSON object (a proxy's HTML page, `null`) is the directory misbehaving, classed as such.
async function jsonObject(res: Response, what: string): Promise<Record<string, unknown>> {
  let body: unknown;
  try { body = await res.json(); } catch (e) {
    if (e instanceof SyntaxError) throw new DirectoryError("google_directory_error", `${what} is not JSON`);
    throw e;
  }
  if (typeof body !== "object" || body === null) throw new DirectoryError("google_directory_error", `${what} is not a JSON object`);
  return body as Record<string, unknown>;
}
