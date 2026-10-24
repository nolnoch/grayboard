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
};
// scopes describes the access token only; refresh permission always remains the original grant scope.
export type OAuthTokenPair = OAuthBinding & {
  accessHash: string; refreshHash: string; accessExpiresAt: number; refreshExpiresAt: number;
};
export type OAuthFailure = { status: "invalid" | "not_found" | "replay" | "capacity" };
export type OAuthResult<T> = { status: "ok"; value: T } | OAuthFailure;
export interface OAuthStore {
  createRequest(input: OAuthRequest, now: number): OAuthResult<OAuthRequest>;
  findRequest(requestHash: string, browserHash: string, now: number): OAuthRequest | undefined;
  // Bind once after upstream login, before rendering consent; an account switch needs a new request.
  bindRequestSession(requestHash: string, browserHash: string, sessionHash: string, now: number): OAuthResult<OAuthRequest>;
  createBrowserSession(input: OAuthBrowserSession, now: number, replaceHash?: string): OAuthResult<OAuthBrowserSession>;
  findBrowserSession(sessionHash: string, now: number): OAuthBrowserSession | undefined;
  revokeBrowserSession(sessionHash: string): void;
  decideRequest(input: { requestHash: string; browserHash: string; csrfHash: string; sessionHash: string; approve: boolean; code: OAuthCode }, now: number): OAuthResult<OAuthCode | null>;
  // codeChallenge must be freshly computed from the submitted verifier (S256); bound reuse revokes the family.
  redeemCode(input: OAuthAuthorization & { codeHash: string; grantId: string; grantExpiresAt: number; tokens: OAuthTokenPair }, now: number): OAuthResult<{ grant: OAuthGrant; tokens: OAuthTokenPair }>;
  // Resolves original scopes for an omitted refresh scope; rotation rechecks everything atomically.
  findRefreshGrant(refreshHash: string, clientId: string, resource: string, now: number): OAuthGrant | undefined;
  // input.scopes requests nonempty canonical access scopes within the original grant; tokens.scopes must match.
  // Requested TTLs are validated then clamped to the persisted absolute grant deadline; use returned deadlines.
  rotateRefresh(input: OAuthBinding & { refreshHash: string; tokens: OAuthTokenPair }, now: number): OAuthResult<{ grant: OAuthGrant; tokens: OAuthTokenPair }>;
  revokeToken(tokenHash: string, clientId: string, now: number): void;
  findActiveAccess(tokenHash: string, resource: string, requiredScopes: string[], now: number): OAuthAccess | undefined;
  isGrantActive(grantId: string, now: number): boolean;
  cleanup(now: number): void;
}
