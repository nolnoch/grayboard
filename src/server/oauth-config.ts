export const OAUTH_SCOPES = ["grayboard:delivery", "grayboard:tools"] as const;
export type OAuthClient = {
  clientId: string;
  name: string;
  redirectUris: string[];
  scopes: string[];
  tokenEndpointAuthMethod: "none" | "client_secret_basic";
  clientSecretHash?: string;
  allowRefresh?: boolean;
};

const unsafe = /[\x00-\x20\x7f\\]/;
export const isLoopback = (host: string) => ["localhost", "127.0.0.1", "[::1]"].includes(host);

function safeURL(raw: string, loopbackPort = false): URL {
  if (typeof raw !== "string" || raw.length > 2048 || unsafe.test(raw) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(raw)) throw new Error("invalid OAuth URL");
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("invalid OAuth URL"); }
  const comparable = loopbackPort ? raw.replace(/^(http:\/\/(?:127\.0\.0\.1|\[::1\])):80(?=\/)/, "$1") : raw;
  if (u.username || u.password || raw.includes("#") || u.href !== comparable) throw new Error("OAuth URLs must be canonical and have no credentials or fragment");
  return u;
}

export function oauthPublicUrl(raw: string, devAuth: boolean): string {
  // Preserve an explicitly configured default port in the issuer identifier.
  const normalizedPort = raw.replace(/^(https:\/\/[^/]+):443(?=\/|$)/, "$1").replace(/^(http:\/\/[^/]+):80(?=\/|$)/, "$1");
  const base = normalizedPort.replace(/\/$/, "");
  const u = safeURL(base + (new URL(base).pathname === "/" ? "/" : ""));
  if (u.search || (u.protocol !== "https:" && !(devAuth && u.protocol === "http:" && isLoopback(u.hostname)))) throw new Error("OAuth issuer requires HTTPS (or explicit loopback dev auth)");
  if (/%|\/\//.test(u.pathname)) throw new Error("invalid OAuth issuer path");
  return raw.replace(/\/$/, "");
}

export function validateRedirect(raw: string): URL {
  const u = safeURL(raw, true);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopback(u.hostname))) throw new Error("OAuth redirect requires HTTPS or loopback HTTP");
  if (/%(?:2f|5c|2e)/i.test(u.pathname)) throw new Error("ambiguous OAuth redirect path");
  const q = u.searchParams;
  for (const key of ["code", "state", "iss", "error", "error_description", "access_token", "client_secret"]) if (q.has(key)) throw new Error("reserved OAuth redirect parameter");
  return u;
}

export function matchesRedirect(client: OAuthClient, raw: string): boolean {
  let actual: URL;
  try { actual = validateRedirect(raw); } catch { return false; }
  return client.redirectUris.some(registered => {
    if (registered === raw) return true;
    const expected = new URL(registered);
    if (expected.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(expected.hostname)) return false;
    // RFC 8252's port exception does not permit hostname, path, or query aliases.
    return actual.protocol === expected.protocol && actual.hostname === expected.hostname &&
      actual.pathname === expected.pathname && actual.search === expected.search;
  });
}

export function parseOAuthClients(raw: string | undefined): OAuthClient[] {
  let value: unknown;
  try { value = raw === undefined ? [] : JSON.parse(raw); } catch { throw new Error("invalid OAuth client configuration"); }
  if (!Array.isArray(value) || value.length > 100) throw new Error("invalid OAuth client configuration");
  const ids = new Set<string>();
  return value.map((c: unknown) => {
    if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error("invalid OAuth client configuration");
    const v = c as Record<string, unknown>;
    if (Object.keys(v).some(k => !["clientId", "name", "redirectUris", "scopes", "tokenEndpointAuthMethod", "clientSecretHash", "allowRefresh"].includes(k)) ||
      typeof v.clientId !== "string" || !/^[\x21-\x7e]{1,512}$/.test(v.clientId) || ids.has(v.clientId) ||
      typeof v.name !== "string" || !v.name.trim() || v.name.length > 200 || /[\x00-\x1f\x7f]/.test(v.name) ||
      !Array.isArray(v.redirectUris) || !v.redirectUris.length || v.redirectUris.length > 16 ||
      !Array.isArray(v.scopes) || !v.scopes.length || v.scopes.some(s => !(OAUTH_SCOPES as readonly unknown[]).includes(s)) ||
      new Set(v.scopes).size !== v.scopes.length ||
      !["none", "client_secret_basic"].includes(String(v.tokenEndpointAuthMethod)) ||
      (v.allowRefresh !== undefined && typeof v.allowRefresh !== "boolean")) throw new Error("invalid OAuth client configuration");
    if (v.tokenEndpointAuthMethod === "none" ? v.clientSecretHash !== undefined :
      typeof v.clientSecretHash !== "string" || !/^[a-f0-9]{64}$/.test(v.clientSecretHash)) throw new Error("invalid OAuth client authentication configuration");
    for (const uri of v.redirectUris) validateRedirect(uri);
    if (new Set(v.redirectUris).size !== v.redirectUris.length) throw new Error("duplicate OAuth redirect");
    ids.add(v.clientId);
    return { clientId: v.clientId, name: v.name, redirectUris: [...v.redirectUris], scopes: [...v.scopes].sort(),
      tokenEndpointAuthMethod: v.tokenEndpointAuthMethod, ...(v.clientSecretHash ? { clientSecretHash: v.clientSecretHash } : {}),
      allowRefresh: v.allowRefresh === true } as OAuthClient;
  });
}
