import type { Read, Tx } from "./store/tx.ts";

// All times are epoch milliseconds; capability inputs are SHA-256 hex digests, never secrets.
export const OAUTH_TTL = {
  access: 60 * 60_000, code: 5 * 60_000, request: 10 * 60_000,
  browser: 12 * 60 * 60_000, refresh: 30 * 24 * 60 * 60_000, grant: 90 * 24 * 60 * 60_000,
} as const;
export type OAuthBinding = { clientId: string; resource: string; scopes: string[] };
export type OAuthAuthorization = OAuthBinding & { redirectUri: string; codeChallenge: string };
export type OAuthRequest = OAuthAuthorization & {
  requestHash: string; browserHash: string; csrfHash: string; stateHash: string;
  consentSessionHash: string | null;
  createdAt: number; expiresAt: number;
};
export type OAuthBrowserSession = { sessionHash: string; userId: number; createdAt: number; expiresAt: number };
export type OAuthCode = OAuthAuthorization & { codeHash: string; userId: number; createdAt: number; expiresAt: number };
export type OAuthGrant = OAuthBinding & {
  id: string; userId: number; createdAt: number; expiresAt: number; revokedAt: number | null;
};
export type OAuthAccess = OAuthBinding & {
  tokenHash: string; grantId: string; userId: number; createdAt: number; expiresAt: number;
  // The grant's expiry: the access is live only while both are in the future (#853 caches on it).
  grantExpiresAt: number;
};
// scopes describes the access token only; refresh permission always remains the original grant scope.
export type OAuthTokenPair = OAuthBinding & {
  accessHash: string; refreshHash: string; accessExpiresAt: number; refreshExpiresAt: number;
};
export type OAuthFailure = { status: "invalid" | "not_found" | "replay" | "capacity" };
export type OAuthResult<T> = { status: "ok"; value: T } | OAuthFailure;
// Writes take the body's `Tx`, reads a `Read` (#807 D2): the caller's `Tx` inside a write body, `repo.read` outside one.
// Every method is async (#807 P3 A7c). The SQLite Repo also keeps synchronous forms of the two auth hot-path reads
// (`Repo.authNow`) for the hosted MCP callers that are still synchronous until A7d.
export interface OAuthStore {
  createRequest(tx: Tx, input: OAuthRequest, now: number): Promise<OAuthResult<OAuthRequest>>;
  findRequest(r: Read, requestHash: string, browserHash: string, now: number): Promise<OAuthRequest | undefined>;
  // Bind once after upstream login, before rendering consent; an account switch needs a new request.
  bindRequestSession(tx: Tx, requestHash: string, browserHash: string, sessionHash: string, now: number): Promise<OAuthResult<OAuthRequest>>;
  createBrowserSession(tx: Tx, input: OAuthBrowserSession, now: number, replaceHash?: string): Promise<OAuthResult<OAuthBrowserSession>>;
  findBrowserSession(r: Read, sessionHash: string, now: number): Promise<OAuthBrowserSession | undefined>;
  revokeBrowserSession(tx: Tx, sessionHash: string): Promise<void>;
  decideRequest(tx: Tx, input: { requestHash: string; browserHash: string; csrfHash: string; sessionHash: string; approve: boolean; code: OAuthCode }, now: number): Promise<OAuthResult<OAuthCode | null>>;
  // Resolves consented scopes without exposing the challenge; redemption still validates fresh PKCE atomically.
  findCodeScopes(r: Read, codeHash: string, clientId: string, resource: string, redirectUri: string, now: number): Promise<string[] | undefined>;
  // codeChallenge must be freshly computed from the submitted verifier (S256); bound reuse revokes the family.
  redeemCode(tx: Tx, input: OAuthAuthorization & { codeHash: string; grantId: string; grantExpiresAt: number; tokens: OAuthTokenPair }, now: number): Promise<OAuthResult<{ grant: OAuthGrant; tokens: OAuthTokenPair }>>;
  // A login code (scopes exactly LOGIN_SCOPE, #928 D8): consumes it and creates the CLI session in one transaction,
  // with redeemCode's client, redirect, verifier and active-user checks. A spent one presented again revokes its
  // session (replay). redeemCode refuses a login code, spent or not, and this refuses any other.
  redeemLoginCode(tx: Tx, input: OAuthAuthorization & { codeHash: string; tokenHash: string; label: string | null }, now: number): Promise<OAuthResult<{ sessionId: number; userId: number }>>;
  // Resolves original scopes for an omitted refresh scope; rotation rechecks everything atomically.
  findRefreshGrant(r: Read, refreshHash: string, clientId: string, resource: string, now: number): Promise<OAuthGrant | undefined>;
  // input.scopes requests nonempty canonical access scopes within the original grant; tokens.scopes must match.
  // Requested TTLs are validated then clamped to the persisted absolute grant deadline; use returned deadlines.
  rotateRefresh(tx: Tx, input: OAuthBinding & { refreshHash: string; tokens: OAuthTokenPair }, now: number): Promise<OAuthResult<{ grant: OAuthGrant; tokens: OAuthTokenPair }>>;
  revokeToken(tx: Tx, tokenHash: string, clientId: string, now: number): Promise<void>;
  findActiveAccess(r: Read, tokenHash: string, resource: string, requiredScopes: string[], now: number): Promise<OAuthAccess | undefined>;
  isGrantActive(r: Read, grantId: string, now: number): Promise<boolean>;
  // Once per database and `key` (#429: builtin_clients; #928: builtin_clients_cli): revokes every unrevoked
  // grant, and drops every unredeemed code, under `clientIds`, audits each grant, then records the cutover under
  // `key` so grants those clients issue later survive restarts. Returns the grants revoked; 0 after the first run.
  revokePreBuiltinGrants(tx: Tx, clientIds: readonly string[], now: number, key?: "builtin_clients" | "builtin_clients_cli"): Promise<number>;
  cleanup(tx: Tx, now: number): Promise<void>;
}
