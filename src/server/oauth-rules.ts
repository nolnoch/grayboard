// The OAuth store's input rules (#807 P3 C4a): the pure checks an OAuthStore backend runs before it touches a row,
// the whitelists of what it stores, and the capacity limits its counts are held to. One copy, imported by both stores
// (db.ts oauthOps, store/pg/oauth.ts). A check missing from both backends is one no contract row can catch, and two
// copies drift.
// What stays in each backend's SQL, because it reads rows the statement itself locks or writes: user, grant, token and
// secret liveness (the joins), the counts the limits below bound, and a run token's expiry clamp (mintServiceToken
// computes it from the credential row inside its INSERT ... SELECT, so the clamp and the bucket see one snapshot).
// Nothing here reads a database; nothing it imports at runtime reaches bun:sqlite or db.ts (store/pg/isolation.test.ts).
import { LOGIN_SCOPE, OAUTH_SCOPES } from "./oauth-config.ts";
import { CREDENTIAL_SOURCES, OAUTH_TTL, SERVICE_TOKEN_MIN_SECONDS, type CredentialSource, type OAuthAuthorization, type OAuthBinding,
  type OAuthBrowserSession, type OAuthCode, type OAuthGrant, type OAuthRequest, type OAuthTokenPair, type ServiceTokenLimits } from "./oauth-types.ts";

// A capability input: a SHA-256 hex digest, never the secret itself.
export const hash = (s: string) => /^[a-f0-9]{64}$/.test(s);
export const time = (n: number) => Number.isSafeInteger(n) && n >= 0;

// Capacity, each counted in the write that admits it: pending consent requests per browser and in all, live browser
// sessions, live secrets per service credential (#270 D2), and the window of a credential's mint bucket (the
// shortest run-token lifetime, so cleanup never deletes a token the window still counts).
export const REQUESTS_PER_BROWSER = 10;
export const REQUESTS_TOTAL = 1000;
export const BROWSER_SESSIONS = 10_000;
export const LIVE_SECRETS = 2;
export const MINT_WINDOW_MS = SERVICE_TOKEN_MIN_SECONDS * 1000;

// Entry guards: what a lookup or a revoke checks of its arguments before it reads anything.
// A lookup by capability hash at a valid time (a request, browser session, code, token).
export const lookup = (h: string, now: number) => time(now) && hash(h);
// findActiveAccess: a lookup whose required scopes are an array (an empty one requires nothing).
export const accessLookup = (h: string, requiredScopes: string[], now: number) => lookup(h, now) && Array.isArray(requiredScopes);
// A service credential named by client ID, and a secret by its id.
export const clientLookup = (clientId: string, now: number) => time(now) && typeof clientId === "string";
export const secretLookup = (secretId: number, now: number) => time(now) && Number.isSafeInteger(secretId);
// A record created now that expires after now and within its lifetime.
export const deadline = (created: number, expiry: number, now: number, ttl: number) =>
  time(now) && created === now && time(expiry) && expiry > now && expiry <= now + ttl;
// Canonical scopes: nonempty, bounded, each well formed, sorted and without repeats.
export const scopes = (s: string[]) => Array.isArray(s) && s.length > 0 && s.length <= 16 &&
  s.every(v => typeof v === "string" && /^[a-zA-Z0-9:_-]{1,100}$/.test(v)) &&
  JSON.stringify(s) === JSON.stringify([...new Set(s)].sort());
export const binding = (b: OAuthBinding) => typeof b.clientId === "string" && b.clientId.length > 0 && b.clientId.length <= 512 &&
  typeof b.resource === "string" && b.resource.length > 0 && b.resource.length <= 2048 && scopes(b.scopes);
// `b` is a valid binding equal to `a`.
export const same = (a: OAuthBinding, b: OAuthBinding) => binding(b) && a.clientId === b.clientId && a.resource === b.resource &&
  JSON.stringify(a.scopes) === JSON.stringify(b.scopes);
// A binding with a redirect and an S256 challenge's shape (43 base64url characters).
export const authorization = (b: OAuthAuthorization) => binding(b) && typeof b.redirectUri === "string" &&
  b.redirectUri.length > 0 && b.redirectUri.length <= 2048 && /^[A-Za-z0-9_-]{43}$/.test(b.codeChallenge);
export const sameAuthorization = (a: OAuthAuthorization, b: OAuthAuthorization) => same(a, b) &&
  a.redirectUri === b.redirectUri && a.codeChallenge === b.codeChallenge;
// A login code's scopes: exactly LOGIN_SCOPE (#928 D8).
export const isLogin = (c: OAuthBinding) => c.scopes.length === 1 && c.scopes[0] === LOGIN_SCOPE;
export const grantId = (id: string) => /^[A-Za-z0-9_-]{16,128}$/.test(id);
// A service credential's client ID (#270 D2): generated, never configured.
export const serviceClientId = (id: string) => /^svc_[a-f0-9]{32}$/.test(id);

// What each table's `data` holds: the named fields only, so a caller's extra field (a raw secret) is never stored.
export const authorizationData = (a: OAuthAuthorization): OAuthAuthorization => ({ clientId: a.clientId,
  resource: a.resource, scopes: a.scopes, redirectUri: a.redirectUri, codeChallenge: a.codeChallenge });
export const requestData = (r: OAuthRequest): OAuthRequest => ({ ...authorizationData(r),
  requestHash: r.requestHash, browserHash: r.browserHash, csrfHash: r.csrfHash, stateHash: r.stateHash,
  consentSessionHash: null, createdAt: r.createdAt, expiresAt: r.expiresAt });
export const browserData = (b: OAuthBrowserSession): OAuthBrowserSession => ({ sessionHash: b.sessionHash,
  userId: b.userId, createdAt: b.createdAt, expiresAt: b.expiresAt });
export const codeData = (c: OAuthCode): OAuthCode => ({ ...authorizationData(c),
  codeHash: c.codeHash, userId: c.userId, createdAt: c.createdAt, expiresAt: c.expiresAt });

// createRequest: a fresh, unbound request with hashed capabilities.
export const requestInput = (r: OAuthRequest, now: number) => authorization(r) && r.consentSessionHash === null &&
  [r.requestHash, r.browserHash, r.csrfHash, r.stateHash].every(hash) && deadline(r.createdAt, r.expiresAt, now, OAUTH_TTL.request);
export const browserSessionInput = (b: OAuthBrowserSession, now: number) => hash(b.sessionHash) && deadline(b.createdAt, b.expiresAt, now, OAUTH_TTL.browser);
// decideRequest's approval: the code carries the request's authorization exactly, for the browser session's user.
export const codeInput = (r: OAuthRequest, c: OAuthCode, userId: number, now: number) => sameAuthorization(r, c) && c.userId === userId &&
  hash(c.codeHash) && deadline(c.createdAt, c.expiresAt, now, OAUTH_TTL.code);
// A token pair bound to `b`, fresh, hashed, within its lifetimes and no later than `cap`.
export const validPair = (p: OAuthTokenPair, b: OAuthBinding, now: number, cap: number) =>
  same(b, p) && hash(p.accessHash) && hash(p.refreshHash) && p.accessHash !== p.refreshHash &&
  deadline(now, p.accessExpiresAt, now, OAUTH_TTL.access) && p.accessExpiresAt <= cap &&
  deadline(now, p.refreshExpiresAt, now, OAUTH_TTL.refresh) && p.refreshExpiresAt <= cap;
// redeemCode's grant: its id, its absolute deadline, and a first pair inside it.
export const grantInput = (input: { grantId: string; grantExpiresAt: number; tokens: OAuthTokenPair }, c: OAuthCode, now: number) =>
  grantId(input.grantId) && deadline(now, input.grantExpiresAt, now, OAUTH_TTL.grant) && validPair(input.tokens, c, now, input.grantExpiresAt);
export const loginInput = (input: { tokenHash: string; label: string | null }) =>
  hash(input.tokenHash) && (input.label === null || typeof input.label === "string");
// rotateRefresh: the requested binding is the grant's, with scopes inside the original grant's.
export const rotationBinding = (g: OAuthGrant, input: OAuthBinding) => binding(input) && g.clientId === input.clientId &&
  g.resource === input.resource && input.scopes.every(s => g.scopes.includes(s));
// rotateRefresh's successor: a valid pair (deadlines checked, then clamped) that doesn't reuse the presented token.
export const successorInput = (input: OAuthBinding & { refreshHash: string; tokens: OAuthTokenPair }, now: number) =>
  validPair(input.tokens, input, now, Number.MAX_SAFE_INTEGER) && input.tokens.accessHash !== input.refreshHash && input.tokens.refreshHash !== input.refreshHash;
// A rotated pair never outlives its grant's absolute deadline.
export const clampPair = (p: OAuthTokenPair, grantExpiresAt: number): OAuthTokenPair =>
  ({ ...p, accessExpiresAt: Math.min(p.accessExpiresAt, grantExpiresAt), refreshExpiresAt: Math.min(p.refreshExpiresAt, grantExpiresAt) });
// findActiveAccess: an access token's stored scopes fit its grant, the resource is the grant's, and they cover what the caller needs.
export const accessFits = (g: OAuthGrant, accessScopes: string[], resource: string, requiredScopes: string[]) =>
  scopes(accessScopes) && accessScopes.every(s => g.scopes.includes(s)) && g.resource === resource && requiredScopes.every(s => accessScopes.includes(s));

// addServiceCredential (#270 D2): a generated client and grant id, a known source, a lifetime of at least the mint
// bucket's window, a future expiry, a hashed secret, and a grant binding for both OAUTH_SCOPES.
export const serviceCredentialInput = (input: { clientId: string; grantId: string; resource: string; source: CredentialSource; tokenSeconds: number; expiresAt: number; secretHash: string }, now: number) =>
  time(now) && hash(input.secretHash) && serviceClientId(input.clientId) && grantId(input.grantId) &&
  (CREDENTIAL_SOURCES as readonly string[]).includes(input.source) && Number.isSafeInteger(input.tokenSeconds) && input.tokenSeconds >= SERVICE_TOKEN_MIN_SECONDS &&
  time(input.expiresAt) && input.expiresAt > now && binding({ clientId: input.clientId, resource: input.resource, scopes: [...OAUTH_SCOPES] });
export const serviceSecretInput = (input: { clientId: string; secretHash: string }, now: number) =>
  clientLookup(input.clientId, now) && hash(input.secretHash);
// mintServiceToken: a hashed token, canonical scopes within OAUTH_SCOPES, and positive limits.
export const mintInput = (input: { secretId: number; tokenHash: string; scopes: string[]; limits: ServiceTokenLimits }, now: number) =>
  time(now) && hash(input.tokenHash) && Number.isSafeInteger(input.secretId) && scopes(input.scopes) &&
  input.scopes.every(s => (OAUTH_SCOPES as readonly string[]).includes(s)) &&
  [input.limits.maxSeconds, input.limits.mintsPerMinute, input.limits.unexpired].every(n => Number.isSafeInteger(n) && n > 0);
