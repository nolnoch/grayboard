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
// A service credential's session source (#270 D3): which `_meta` key carries its sessions' source.
export const CREDENTIAL_SOURCES = ["opencode", "generic"] as const;
export type CredentialSource = (typeof CREDENTIAL_SOURCES)[number];
export type OAuthAccess = OAuthBinding & {
  tokenHash: string; grantId: string; userId: number; createdAt: number; expiresAt: number;
  // The grant's expiry: the access is live only while both are in the future (#853 caches on it).
  grantExpiresAt: number;
  // A service credential's source (#270 D3), read in the same join; null for any other client. Immutable after
  // insert, so the cache may hold it.
  source: CredentialSource | null;
};
// A service credential's client (#270 D2): what client authentication and the mint need, read live.
export type ServiceCredential = {
  clientId: string; userId: number; grantId: string; source: CredentialSource; tokenSeconds: number;
  // Live secrets only: one, or two during a rotation.
  secrets: { id: number; hash: string }[];
};
// A credential's expiry when the admin gives none: past any token's lifetime, so the grant never lapses by time.
export const CREDENTIAL_NO_EXPIRY = 253_402_300_799_000; // 9999-12-31T23:59:59Z
// How a run token's mint is bounded (#270 D2, principle 13): its lifetime's ceiling, and per credential a bucket of
// mints in the last minute and a cap on unexpired tokens, both checked in the insert.
export type ServiceTokenLimits = { maxSeconds: number; mintsPerMinute: number; unexpired: number };
export const DEFAULT_SERVICE_TOKEN_LIMITS: ServiceTokenLimits = { maxSeconds: 24 * 60 * 60, mintsPerMinute: 60, unexpired: 1000 };
// The shortest run-token lifetime: the mint bucket's window, so cleanup never deletes a token the window still counts.
export const SERVICE_TOKEN_MIN_SECONDS = 60;
// scopes describes the access token only; refresh permission always remains the original grant scope.
export type OAuthTokenPair = OAuthBinding & {
  accessHash: string; refreshHash: string; accessExpiresAt: number; refreshExpiresAt: number;
};
// One live grant as the per-grant list shows it (#930): last used is its newest token's mint (a refresh or a run
// token), the grant's creation when it has none left. `credential`: a service credential's grant, listed read-only.
export type GrantSummary = { id: string; clientId: string; createdAt: number; expiresAt: number; lastUsedAt: number; credential: boolean };
// The most grants one list returns, newest use first: a user consents once per harness and machine, so far fewer.
export const GRANT_LIST_MAX = 500;
export type OAuthFailure = { status: "invalid" | "not_found" | "replay" | "capacity" };
export type OAuthResult<T> = { status: "ok"; value: T } | OAuthFailure;
// Writes take the body's `Tx`, reads a `Read` (#807 D2): the caller's `Tx` inside a write body, `repo.read` outside one.
// Every method is async (#807 P3 A7c).
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
  // The user behind an unspent, unrevoked, unexpired refresh token of a live grant bound to the client and resource,
  // else undefined (#930): the IdP re-check runs only for a token rotation could spend, so a replay still reaches
  // rotateRefresh's family revocation.
  findRefreshUser(r: Read, refreshHash: string, clientId: string, resource: string, now: number): Promise<number | undefined>;
  // input.scopes requests nonempty canonical access scopes within the original grant; tokens.scopes must match.
  // Requested TTLs are validated then clamped to the persisted absolute grant deadline; use returned deadlines.
  rotateRefresh(tx: Tx, input: OAuthBinding & { refreshHash: string; tokens: OAuthTokenPair }, now: number): Promise<OAuthResult<{ grant: OAuthGrant; tokens: OAuthTokenPair }>>;
  revokeToken(tx: Tx, tokenHash: string, clientId: string, now: number): Promise<void>;
  findActiveAccess(r: Read, tokenHash: string, resource: string, requiredScopes: string[], now: number): Promise<OAuthAccess | undefined>;
  isGrantActive(r: Read, grantId: string, now: number): Promise<boolean>;
  // The user's live grants (unrevoked, unexpired), newest use first, at most GRANT_LIST_MAX (#930).
  listGrants(r: Read, userId: number, now: number): Promise<GrantSummary[]>;
  // Revokes one of the user's live grants, ending its hosted sessions in this transaction (#930): not_found unless
  // the grant is userId's and live; invalid for a service credential's grant, whose own revoke keeps
  // service.credential_revoked. The caller audits (it knows the actor).
  revokeUserGrant(tx: Tx, userId: number, grantId: string, now: number): Promise<OAuthResult<{ clientId: string }>>;
  // Once per database and `key` (#429: builtin_clients; #928: builtin_clients_cli): revokes every unrevoked
  // grant, and drops every unredeemed code, under `clientIds`, audits each grant, then records the cutover under
  // `key` so grants those clients issue later survive restarts. Returns the grants revoked; 0 after the first run.
  revokePreBuiltinGrants(tx: Tx, clientIds: readonly string[], now: number, key?: "builtin_clients" | "builtin_clients_cli"): Promise<number>;
  cleanup(tx: Tx, now: number): Promise<void>;
  // Service credentials (#270 D2). Each write is one transaction with its audit row where the store writes one.
  // add: the credential, its grant (expiry = the credential's) and its first secret; invalid unless userId is an
  // enabled service. rotate: a second live secret; not_found unless the credential is live, capacity at two.
  // revoke: the grant, ending every session attached to it in the transaction. revokeSecret: the secret and its
  // tokens, not the grant; invalid when it is the credential's only live secret. find: a live credential.
  addServiceCredential(tx: Tx, input: { userId: number; clientId: string; grantId: string; resource: string; source: CredentialSource; tokenSeconds: number; expiresAt: number; secretHash: string }, now: number): Promise<OAuthResult<{ secretId: number }>>;
  rotateServiceCredential(tx: Tx, input: { clientId: string; secretHash: string }, now: number): Promise<OAuthResult<{ secretId: number; userId: number }>>;
  revokeServiceCredential(tx: Tx, clientId: string, now: number): Promise<OAuthResult<{ userId: number }>>;
  revokeServiceSecret(tx: Tx, secretId: number, now: number): Promise<OAuthResult<{ clientId: string; userId: number }>>;
  findServiceCredential(r: Read, clientId: string, now: number): Promise<ServiceCredential | undefined>;
  // One run token under a live credential's grant, minted with a live secret, in one INSERT that also checks the
  // bucket and the cap (capacity when either is spent); its expiry is the credential's lifetime clamped to
  // limits.maxSeconds and to the grant's expiry. Audited oauth.token_issued (client, secret_id, expiry).
  mintServiceToken(tx: Tx, input: { clientId: string; secretId: number; tokenHash: string; scopes: string[]; limits: ServiceTokenLimits }, now: number): Promise<OAuthResult<{ expiresAt: number }>>;
}
