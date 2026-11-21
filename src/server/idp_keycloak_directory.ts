// Keycloak's directory check (#1555, docs/server-offboarding.md §3): IdentityProvider.status for the generic `oidc`
// provider when its issuer is a Keycloak realm, asking the admin REST API whether the user a sign-in named is still
// enabled. The server authenticates as a confidential client's service account (client credentials) holding
// realm-management `view-users`; on Keycloak 26.8.2 and later that client also needs the `kc-admin-api` client scope,
// which carries the admin API's audience and scope.
import { cappedBody } from "../shared/capped_body.ts";
import { basicAuthorization } from "./idp_oidc.ts";
import { throttledWarn, tokenCache } from "./idp_directory.ts";

// baseUrl: Keycloak as this server reaches it, the part of a realm URL before `/realms/` (the issuer's, unless the
// operator names an internal one because the public hostname doesn't serve /admin).
export type KeycloakDirectoryConfig = { baseUrl: string; realm: string; clientId: string; clientSecret: string };
export type KeycloakDirectoryOptions = { fetch?: typeof fetch; now?: () => number };

const MAX_BODY = 256 * 1024;
// OIDC Core §2: `sub` is at most 255 ASCII characters.
const MAX_SUBJECT = 255;

// Each kind an operator acts on differently has its own name, the audit row's error_class: the token endpoint refused
// the client (its id, secret or service account), the admin API refused the token (the role or the kc-admin-api
// scope), the user is locked out by brute-force detection (not offboarded: never a disable), anything else.
class DirectoryError extends Error {
  constructor(name: "keycloak_token_refused" | "keycloak_directory_refused" | "keycloak_locked_out" | "keycloak_directory_error", message: string) { super(message); this.name = name; }
}

// The realm's issuer split into Keycloak's base URL and the realm, or null when it isn't a Keycloak realm URL.
export function keycloakRealm(issuer: string): { baseUrl: string; realm: string } | null {
  const m = /^(https?:\/\/[^/?#]+(?:\/[^?#]*?)?)\/realms\/([^/?#]+)\/?$/.exec(issuer);
  if (!m) return null;
  return { baseUrl: m[1]!, realm: decodeURIComponent(m[2]!) };
}

// status(subject, signal): "inactive" when Keycloak says the user is disabled (and not by brute-force lockout) or
// doesn't exist (404 "User not found"). Anything else throws.
export function keycloakDirectoryStatus(config: KeycloakDirectoryConfig, options: KeycloakDirectoryOptions = {}) {
  const send = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const realmPath = encodeURIComponent(config.realm);
  const tokenUrl = `${config.baseUrl}/realms/${realmPath}/protocol/openid-connect/token`;
  const adminBase = `${config.baseUrl}/admin/realms/${realmPath}`;
  const refused = throttledWarn("Keycloak directory check", now);

  // Every request: no redirects, a bounded body, parsed as JSON when it is (null otherwise).
  async function request(url: string, init: RequestInit): Promise<{ status: number; ok: boolean; body: unknown }> {
    const res = await send(url, { ...init, redirect: "error" });
    const raw = await cappedBody(res, MAX_BODY);
    if (raw === null) throw new DirectoryError("keycloak_directory_error", `Keycloak response over ${MAX_BODY} bytes`);
    let body: unknown = null;
    try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { /* not JSON */ }
    return { status: res.status, ok: res.ok, body };
  }
  const errorText = (body: unknown) => {
    const b = body as { error?: unknown; error_description?: unknown } | null;
    const text = [b?.error, b?.error_description].filter(v => typeof v === "string").map(v => (v as string).slice(0, 100)).join(": ");
    return text ? `: ${text}` : "";
  };
  const object = (body: unknown, what: string): Record<string, unknown> => {
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new DirectoryError("keycloak_directory_error", `${what} is not a JSON object`);
    return body as Record<string, unknown>;
  };

  // No `scope`: the client's default scopes (kc-admin-api among them) are what the token carries.
  const tokens = tokenCache(async signal => {
    const res = await request(tokenUrl, {
      method: "POST", signal,
      headers: { Authorization: basicAuthorization(config.clientId, config.clientSecret), "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    });
    // invalid_client, unauthorized_client: the id, the secret or the service account switch.
    if (res.status === 400 || res.status === 401)
      throw refused(new DirectoryError("keycloak_token_refused", `Keycloak token request failed (${res.status})${errorText(res.body)}`));
    if (!res.ok) throw new DirectoryError("keycloak_directory_error", `Keycloak token request failed (${res.status})`);
    const body = object(res.body, "Keycloak token response");
    if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") throw new DirectoryError("keycloak_directory_error", "Keycloak token response is malformed");
    return { token: body.access_token, expiresIn: body.expires_in };
  }, now);

  async function admin(path: string, signal: AbortSignal, what: string) {
    const token = await tokens.get(signal);
    const res = await request(`${adminBase}${path}`, { signal, headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (res.status === 401) tokens.drop();
    if (res.status === 401 || res.status === 403)
      throw refused(new DirectoryError("keycloak_directory_refused", `Keycloak ${what} failed (${res.status})${errorText(res.body)}`));
    return res;
  }

  return async function status(subject: string, signal: AbortSignal): Promise<"active" | "inactive"> {
    // `.` and `..` would move the path; anything else is encoded.
    if (!subject || subject === "." || subject === ".." || subject.length > MAX_SUBJECT) throw new DirectoryError("keycloak_directory_error", "subject is not a Keycloak user id");
    const id = encodeURIComponent(subject);
    const res = await admin(`/users/${id}`, signal, "user lookup");
    // Keycloak's own answer for an unknown id; any other 404 (a proxy, a wrong realm or base URL) is not "gone".
    if (res.status === 404) {
      if ((res.body as { error?: unknown } | null)?.error === "User not found") return "inactive";
      throw new DirectoryError("keycloak_directory_error", "Keycloak user lookup failed (404, not Keycloak's \"User not found\")");
    }
    if (!res.ok) throw new DirectoryError("keycloak_directory_error", `Keycloak user lookup failed (${res.status})`);
    const user = object(res.body, "Keycloak user");
    if (user.id !== subject) throw new DirectoryError("keycloak_directory_error", "Keycloak user lookup answered for another id");
    if (typeof user.enabled !== "boolean") throw new DirectoryError("keycloak_directory_error", "Keycloak user is malformed");
    if (user.enabled) return "active";
    // A permanent brute-force lockout also clears `enabled`: that's an attack on the account, not an offboarding.
    const lock = await admin(`/attack-detection/brute-force/users/${id}`, signal, "brute-force status");
    if (!lock.ok) throw new DirectoryError("keycloak_directory_error", `Keycloak brute-force status failed (${lock.status})`);
    const locked = object(lock.body, "Keycloak brute-force status").disabled;
    if (typeof locked !== "boolean") throw new DirectoryError("keycloak_directory_error", "Keycloak brute-force status is malformed");
    if (locked) throw new DirectoryError("keycloak_locked_out", "user is locked out by Keycloak's brute-force detection");
    return "inactive";
  };
}
