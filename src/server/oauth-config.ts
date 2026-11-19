import { SESSION_FACT_MAX } from "../shared/protocol.ts";
import { GRAYBOARD_SESSION_META } from "../shared/session_meta.ts";
import type { CredentialSource, ServiceCredential } from "./oauth-types.ts";

export const OAUTH_SCOPES = ["grayboard:delivery", "grayboard:tools"] as const;
// The scope that mints a CLI session (#928 D8, R3). Never a member of OAUTH_SCOPES: every built-in, every CIMD
// client, operator validation, scopes_supported and the 401 hint are drawn from that list, so adding it there
// would hand session minting to all of them. Only CLI_CLIENT's scope list holds it.
export const LOGIN_SCOPE = "grayboard:login";

export type OAuthClient = {
  clientId: string;
  name: string;
  redirectUris: string[];
  scopes: string[];
  tokenEndpointAuthMethod: "none" | "client_secret_basic";
  clientSecretHash?: string;
  allowRefresh?: boolean;
  // Operator opt-in to the generic hosted session source key; never set for a CIMD client.
  sessionSource?: boolean;
  // A service credential's client (#270 D2), read from the store: its live secrets, and once client authentication
  // has matched one, its ID (the secret a run token is minted with). Only such a client runs client_credentials.
  credential?: ServiceCredential & { secretId?: number };
};
// A service credential's client ID: this prefix and 32 hex digits, generated, never configured (#270 D2).
export const SERVICE_CLIENT_PREFIX = "svc_";
export const isServiceClientId = (id: string) => id.startsWith(SERVICE_CLIENT_PREFIX);
// The server's hosted MCP resource identifier: what every grant is bound to and findActiveAccess matches. One place,
// for the AS and for the admin route that writes a credential's grant.
export const mcpResource = (publicUrl: string, devAuth: boolean) => new URL(oauthPublicUrl(publicUrl, devAuth) + "/mcp").href;

// Hosted session source mapping (#414): the `_meta` key that carries a client's raw
// session source, and the harness its sessions show in peer_list. OpenCode's CIMD client
// keeps its own key; the built-in clients and an operator client with `sessionSource` map
// the generic key (GRAYBOARD_SESSION_META, src/shared/session_meta.ts); every other
// client is unmapped (reads only).
export const OPENCODE_CLIENT = "https://opencode.ai/oauth/opencode/client.json";
export const OPENCODE_SESSION_META = "ai.opencode/sessionID";
// Built-in native clients (#429): the hosted adapters ship these IDs as constants, so every
// server accepts them with no operator registration and no outbound fetch, and none can be
// disabled per server. Loopback-only redirects keep a consent-phished code on the victim's
// own machine, the same bound OpenCode's metadata document gives; fixed in code, they are
// stronger than a fetched document. Operator config can't reuse their IDs.
const BUILTINS = [
  { clientId: "grayboard-pi", harness: "pi", name: "Grayboard for pi" },
  { clientId: "grayboard-omp", harness: "omp", name: "Grayboard for omp" },
  { clientId: "grayboard-claude-code", harness: "claude-code", name: "Grayboard for Claude Code" },
] as const;
const builtinHarness = new Map<string, string>(BUILTINS.map(b => [b.clientId, b.harness]));
export const BUILTIN_CLIENT_IDS: readonly string[] = BUILTINS.map(b => b.clientId);
export const BUILTIN_CLIENTS: readonly OAuthClient[] = BUILTINS.map(({ clientId, name }) => ({
  clientId, name, redirectUris: ["http://127.0.0.1/callback", "http://[::1]/callback"], scopes: [...OAUTH_SCOPES], tokenEndpointAuthMethod: "none", allowRefresh: true,
}));
// `grayboard login` (#928 D8): its own constant, not a BUILTINS row, which would get both scopes, refresh and the
// generic source key. Public, the built-ins' loopback redirects, PKCE, no refresh, exactly the login scope, no
// source key and no harness. Operator config can't reuse its ID.
export const CLI_CLIENT_ID = "grayboard-cli";
export const CLI_CLIENT: OAuthClient = {
  clientId: CLI_CLIENT_ID, name: "Grayboard for the CLI", redirectUris: ["http://127.0.0.1/callback", "http://[::1]/callback"],
  scopes: [LOGIN_SCOPE], tokenEndpointAuthMethod: "none", allowRefresh: false,
};
// `source`: a service credential's (#270 D3), carried on the access read; it decides alone for such a client.
export function sourceKeyFor(clientId: string, clients: ReadonlyMap<string, OAuthClient>, source: CredentialSource | null = null): string | null {
  if (source !== null) return source === "opencode" ? OPENCODE_SESSION_META : GRAYBOARD_SESSION_META;
  if (clientId === OPENCODE_CLIENT) return OPENCODE_SESSION_META;
  if (builtinHarness.has(clientId)) return GRAYBOARD_SESSION_META;
  return clients.get(clientId)?.sessionSource === true ? GRAYBOARD_SESSION_META : null;
}
// Only a mapped client registers sessions; a built-in shows its harness, and the parser
// keeps an opted-in operator ID within SESSION_FACT_MAX, so that label is the exact ID. A service credential's
// opencode source shows opencode; its generic one, its client ID (svc_ and 32 hex digits, within the limit).
export const harnessFor = (clientId: string, source: CredentialSource | null = null) =>
  clientId === OPENCODE_CLIENT || source === "opencode" ? "opencode" : builtinHarness.get(clientId) ?? clientId;
const httpsId = (id: string) => { try { return new URL(id).protocol === "https:"; } catch { return false; } };

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
    if (expected.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(expected.hostname)) return false;
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
    if (Object.keys(v).some(k => !["clientId", "name", "redirectUris", "scopes", "tokenEndpointAuthMethod", "clientSecretHash", "allowRefresh", "sessionSource"].includes(k)) ||
      typeof v.clientId !== "string" || !/^[\x21-\x7e]{1,512}$/.test(v.clientId) || ids.has(v.clientId) ||
      typeof v.name !== "string" || !v.name.trim() || v.name.length > 200 || /[\x00-\x1f\x7f]/.test(v.name) ||
      !Array.isArray(v.redirectUris) || !v.redirectUris.length || v.redirectUris.length > 16 ||
      !Array.isArray(v.scopes) || !v.scopes.length || v.scopes.some(s => !(OAUTH_SCOPES as readonly unknown[]).includes(s)) ||
      new Set(v.scopes).size !== v.scopes.length ||
      !["none", "client_secret_basic"].includes(String(v.tokenEndpointAuthMethod)) ||
      (v.allowRefresh !== undefined && typeof v.allowRefresh !== "boolean") ||
      (v.sessionSource !== undefined && typeof v.sessionSource !== "boolean")) throw new Error("invalid OAuth client configuration");
    if (builtinHarness.has(v.clientId)) throw new Error(`OAuth client ID ${v.clientId} is reserved for a built-in client; rename that GRAYBOARD_OAUTH_CLIENTS entry`);
    if (v.clientId === CLI_CLIENT_ID) throw new Error(`OAuth client ID ${v.clientId} is reserved for the CLI's client; rename that GRAYBOARD_OAUTH_CLIENTS entry`);
    // The startup map wins over the store, so a configured svc_ ID would shadow a service's credential (#270 D2).
    if (isServiceClientId(v.clientId)) throw new Error(`OAuth client ID ${v.clientId} is under the prefix ${SERVICE_CLIENT_PREFIX}, reserved for service credentials; rename that GRAYBOARD_OAUTH_CLIENTS entry`);
    // CIMD resolves only https: identifiers and grants keep only the client ID string, so an
    // https: ID never maps the generic key: a grant consented under a metadata document can't
    // turn write-capable because the operator later registers the same ID.
    if (v.sessionSource === true && httpsId(v.clientId)) throw new Error("sessionSource is refused on an https: client ID");
    // peer_list shows an opted-in client's ID as its sessions' harness; a longer ID would be cut.
    if (v.sessionSource === true && v.clientId.length > SESSION_FACT_MAX) throw new Error(`sessionSource needs a client ID of at most ${SESSION_FACT_MAX} characters`);
    if (v.tokenEndpointAuthMethod === "none" ? v.clientSecretHash !== undefined :
      typeof v.clientSecretHash !== "string" || !/^[a-f0-9]{64}$/.test(v.clientSecretHash)) throw new Error("invalid OAuth client authentication configuration");
    for (const uri of v.redirectUris) validateRedirect(uri);
    if (new Set(v.redirectUris).size !== v.redirectUris.length) throw new Error("duplicate OAuth redirect");
    ids.add(v.clientId);
    return { clientId: v.clientId, name: v.name, redirectUris: [...v.redirectUris], scopes: [...v.scopes].sort(),
      tokenEndpointAuthMethod: v.tokenEndpointAuthMethod, ...(v.clientSecretHash ? { clientSecretHash: v.clientSecretHash } : {}),
      allowRefresh: v.allowRefresh === true, sessionSource: v.sessionSource === true } as OAuthClient;
  });
}
