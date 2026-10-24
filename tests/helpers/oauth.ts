import { randomBytes } from "node:crypto";
import { hashToken, type AuthedUser } from "../../src/server/auth.ts";
import type { Repo } from "../../src/server/db.ts";
import { OAUTH_TTL, type OAuthResult } from "../../src/server/oauth-types.ts";

const random = () => randomBytes(32).toString("base64url");
const checked = <T>(result: OAuthResult<T>): T => {
  if (result.status !== "ok") throw new Error(`OAuth fixture issuance failed: ${result.status}`);
  return result.value;
};

// Trusted test-only issuance through the same atomic consent/code lifecycle as the AS.
export function issueOAuth(repo: Repo, resource: string, email = "alice@example.com", scopes = ["grayboard:tools"], now = Date.now()) {
  const user = repo.users.upsertByEmail(email, null);
  const binding = { clientId: "test-native", resource, scopes: [...scopes].sort(), redirectUri: "http://127.0.0.1/callback", codeChallenge: random() };
  const request = { ...binding, requestHash: hashToken(random()), browserHash: hashToken(random()), csrfHash: hashToken(random()), stateHash: hashToken(random()), consentSessionHash: null, createdAt: now, expiresAt: now + OAUTH_TTL.request };
  const sessionHash = hashToken(random());
  checked(repo.oauth.createBrowserSession({ sessionHash, userId: user.id, createdAt: now, expiresAt: now + OAUTH_TTL.browser }, now));
  checked(repo.oauth.createRequest(request, now));
  checked(repo.oauth.bindRequestSession(request.requestHash, request.browserHash, sessionHash, now));
  const code = { ...binding, codeHash: hashToken(random()), userId: user.id, createdAt: now, expiresAt: now + OAUTH_TTL.code };
  checked(repo.oauth.decideRequest({ requestHash: request.requestHash, browserHash: request.browserHash, csrfHash: request.csrfHash, sessionHash, approve: true, code }, now));
  const token = random(), refreshToken = random(), grantId = random();
  const tokens = { ...binding, accessHash: hashToken(token), refreshHash: hashToken(refreshToken), accessExpiresAt: now + OAUTH_TTL.access, refreshExpiresAt: now + OAUTH_TTL.refresh };
  checked(repo.oauth.redeemCode({ ...binding, codeHash: code.codeHash, grantId, grantExpiresAt: now + OAUTH_TTL.grant, tokens }, now));
  const authed: AuthedUser = { user_id: user.id, user_email: user.email, session_id: 0 };
  return { token, refreshToken, grantId, authed, tokens, binding, now };
}
