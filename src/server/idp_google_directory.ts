// Google's directory check (#930 A2b, docs/server-offboarding.md §3): IdentityProvider.status for the Google provider,
// asking the Admin SDK Directory API (users.get) whether the person a Google sign-in named is still active. The server
// authenticates as a service account (GRAYBOARD_GOOGLE_DIRECTORY_KEY, its JSON key) with the OAuth 2.0 JWT-bearer
// grant: either the service account holds a Workspace admin role itself, or it has domain-wide delegation and
// impersonates GRAYBOARD_GOOGLE_DIRECTORY_ADMIN (the JWT's `sub`).
import { createPrivateKey } from "node:crypto";
import { importPKCS8, SignJWT, type KeyLike } from "jose";

export type GoogleDirectoryConfig = { clientEmail: string; privateKey: string; admin?: string };
// Test seams: where the token request and users.get go, and the fetch that sends them.
export type GoogleDirectoryOptions = { tokenUrl?: string; apiBase?: string; fetch?: typeof fetch; now?: () => number };

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_API_BASE = "https://admin.googleapis.com";
export const DIRECTORY_SCOPE = "https://www.googleapis.com/auth/admin.directory.user.readonly";
// An access token is reused until this long before Google's expires_in, so a call never carries one about to lapse.
const TOKEN_MARGIN_MS = 60_000;
// The token request is shared by every check waiting on it, so it runs on its own clock, never one caller's: a caller
// that gives up stops waiting, and the mint goes on for the others.
const MINT_TIMEOUT_MS = 10_000;
// Google's error text (invalid_grant, unauthorized_client, "Not Authorized to access this resource") is what tells an
// operator which of key, delegation or role to fix; the audit row carries only the class, so it's logged, each distinct
// text at most once in this window.
const LOG_EVERY_MS = 10 * 60_000;

// The re-check audits a failure by its error's name (auth.idp_check_failed's error_class), so each kind an operator
// acts on differently has its own: the credential refused (fix the key, the role or the delegation), the directory
// refusing the lookup, anything else (an outage, a quota answer, a malformed body).
class DirectoryError extends Error {
  constructor(name: "google_token_refused" | "google_directory_refused" | "google_directory_error", message: string) { super(message); this.name = name; }
}

// The service account's JSON key as Google issues it. Refused at startup when it isn't one, naming the field, never
// the key: a server that would fail every check should not start.
export function parseDirectoryKey(raw: string, admin: string | undefined): GoogleDirectoryConfig {
  let key: unknown;
  try { key = JSON.parse(raw); } catch { throw new Error("GRAYBOARD_GOOGLE_DIRECTORY_KEY is not JSON (expected a service account's key file)"); }
  const k = key as Record<string, unknown>;
  if (typeof key !== "object" || key === null || k.type !== "service_account") throw new Error('GRAYBOARD_GOOGLE_DIRECTORY_KEY must be a service account key ("type": "service_account")');
  if (typeof k.client_email !== "string" || !k.client_email.includes("@")) throw new Error("GRAYBOARD_GOOGLE_DIRECTORY_KEY has no client_email");
  if (typeof k.private_key !== "string") throw new Error("GRAYBOARD_GOOGLE_DIRECTORY_KEY has no private_key");
  // jose's importPKCS8 takes only a PKCS#8 PEM from its first byte, as Google's key files are; a PKCS#1 key node would
  // parse would start the server and then fail every check.
  if (!k.private_key.startsWith("-----BEGIN PRIVATE KEY-----")) throw new Error("GRAYBOARD_GOOGLE_DIRECTORY_KEY's private_key is not a PKCS#8 RSA private key");
  try {
    const parsed = createPrivateKey(k.private_key);
    if (parsed.asymmetricKeyType !== "rsa") throw new Error("not RSA");
  } catch { throw new Error("GRAYBOARD_GOOGLE_DIRECTORY_KEY's private_key is not a PKCS#8 RSA private key"); }
  if (admin !== undefined && (admin === "" || !admin.includes("@") || /\s/.test(admin))) throw new Error("GRAYBOARD_GOOGLE_DIRECTORY_ADMIN must be an admin's email address");
  return { clientEmail: k.client_email, privateKey: k.private_key, ...(admin ? { admin } : {}) };
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
  let signingKey: Promise<KeyLike> | undefined;
  let cached: { token: string; until: number } | undefined;
  // One token request at a time: concurrent checks of different users share it.
  let minting: Promise<string> | undefined;
  const logged = new Map<string, number>();
  function refused(error: DirectoryError): DirectoryError {
    const last = logged.get(error.message);
    if (last === undefined || now() - last >= LOG_EVERY_MS) {
      logged.set(error.message, now());
      console.warn(`[grayboard] Google directory check: ${error.name}: ${error.message}`);
    }
    return error;
  }

  async function mint(): Promise<string> {
    const signal = AbortSignal.timeout(MINT_TIMEOUT_MS);
    signingKey ??= importPKCS8(config.privateKey, "RS256");
    const jwt = new SignJWT({ scope: DIRECTORY_SCOPE })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(config.clientEmail)
      .setAudience(GOOGLE_TOKEN_URL)
      .setIssuedAt(Math.floor(now() / 1000))
      .setExpirationTime(Math.floor(now() / 1000) + 3600);
    if (config.admin) jwt.setSubject(config.admin);
    const assertion = await jwt.sign(await signingKey);
    const res = await send(tokenUrl, {
      method: "POST", signal,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    });
    // The body names Google's error code (invalid_grant, unauthorized_client), which tells an operator what to fix;
    // it carries no secret.
    if (res.status === 400 || res.status === 401 || res.status === 403)
      throw refused(new DirectoryError("google_token_refused", `Google Directory token request failed (${res.status}): ${(await res.text()).slice(0, 200)}`));
    if (!res.ok) throw new DirectoryError("google_directory_error", `Google Directory token request failed (${res.status})`);
    const body = await jsonObject(res, "Google Directory token response");
    if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") throw new DirectoryError("google_directory_error", "Google Directory token response is malformed");
    cached = { token: body.access_token, until: now() + body.expires_in * 1000 - TOKEN_MARGIN_MS };
    return body.access_token;
  }

  function accessToken(signal: AbortSignal): Promise<string> {
    if (cached && cached.until > now()) return Promise.resolve(cached.token);
    minting ??= mint().finally(() => { minting = undefined; });
    return abortable(minting, signal);
  }

  return async function status(subject: string, signal: AbortSignal): Promise<"active" | "inactive"> {
    if (!/^\d+$/.test(subject)) throw new DirectoryError("google_directory_error", "subject is not a Google user id");
    const token = await accessToken(signal);
    const res = await send(`${apiBase}/admin/directory/v1/users/${encodeURIComponent(subject)}?fields=suspended,archived`, {
      signal, headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 404) return "inactive";
    if (res.status === 401) cached = undefined;
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

// p, given up on (with the signal's reason) when the signal aborts first; p itself runs on.
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    p.then(v => { signal.removeEventListener("abort", stop); resolve(v); }, e => { signal.removeEventListener("abort", stop); reject(e); });
  });
}
