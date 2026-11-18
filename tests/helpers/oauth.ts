import { randomBytes } from "node:crypto";
import { hashToken, type AuthedUser } from "../../src/server/auth.ts";
import { join, dirname } from "node:path";
import { openDatabase, type Repo } from "../../src/server/db.ts";
import { OAUTH_TTL, type OAuthResult } from "../../src/server/oauth-types.ts";
import { seed } from "../support/seed.ts";
import type { Tx } from "../../src/server/store/tx.ts";

const random = () => randomBytes(32).toString("base64url");
const checked = <T>(result: OAuthResult<T>): T => {
  if (result.status !== "ok") throw new Error(`OAuth fixture issuance failed: ${result.status}`);
  return result.value;
};

// Trusted test-only issuance through the same atomic consent/code lifecycle as the AS, in one queued body (#807 P1b-4f).
export function issueOAuth(repo: Repo, resource: string, email = "alice@example.com", scopes = ["grayboard:tools"], now = Date.now(), clientId = "test-native") {
  return seed(repo, tx => issueNow(repo, tx, resource, email, scopes, now, clientId));
}
export type IssuedOAuth = Awaited<ReturnType<typeof issueOAuth>>;

async function issueNow(repo: Repo, tx: Tx, resource: string, email: string, scopes: string[], now: number, clientId: string) {
  // A service principal (#270) has no sign-in, so upsertByEmail refuses its name: issue to the existing row, the
  // test-only stand-in for the credential grant a later step adds.
  const existing = await repo.users.findByEmail(tx, email);
  const user = existing?.kind === "service" ? existing : await repo.users.upsertByEmail(tx, email, null);
  const binding = { clientId, resource, scopes: [...scopes].sort(), redirectUri: "http://127.0.0.1/callback", codeChallenge: random() };
  const request = { ...binding, requestHash: hashToken(random()), browserHash: hashToken(random()), csrfHash: hashToken(random()), stateHash: hashToken(random()), consentSessionHash: null, createdAt: now, expiresAt: now + OAUTH_TTL.request };
  const sessionHash = hashToken(random());
  checked(await repo.oauth.createBrowserSession(tx, { sessionHash, userId: user.id, createdAt: now, expiresAt: now + OAUTH_TTL.browser }, now));
  checked(await repo.oauth.createRequest(tx, request, now));
  checked(await repo.oauth.bindRequestSession(tx, request.requestHash, request.browserHash, sessionHash, now));
  const code = { ...binding, codeHash: hashToken(random()), userId: user.id, createdAt: now, expiresAt: now + OAUTH_TTL.code };
  checked(await repo.oauth.decideRequest(tx, { requestHash: request.requestHash, browserHash: request.browserHash, csrfHash: request.csrfHash, sessionHash, approve: true, code }, now));
  const token = random(), refreshToken = random(), grantId = random();
  const tokens = { ...binding, accessHash: hashToken(token), refreshHash: hashToken(refreshToken), accessExpiresAt: now + OAUTH_TTL.access, refreshExpiresAt: now + OAUTH_TTL.refresh };
  checked(await repo.oauth.redeemCode(tx, { ...binding, codeHash: code.codeHash, grantId, grantExpiresAt: now + OAUTH_TTL.grant, tokens }, now));
  const authed: AuthedUser = { user_id: user.id, user_email: user.email, kind: user.kind, session_id: 0 };
  return { token, refreshToken, grantId, authed, tokens, binding, now };
}

/** Rotates `refreshToken` on the issued grant, as a client's refresh does; the new tokens' lifetimes start at `now`. */
export async function rotateOAuth(repo: Repo, grant: Pick<IssuedOAuth, "binding" | "tokens">, refreshToken: string, now = Date.now()) {
  const access = random(), refresh = random();
  const status = await seed(repo, async tx => (await repo.oauth.rotateRefresh(tx, { ...grant.binding, refreshHash: hashToken(refreshToken), tokens: {
    ...grant.tokens, accessHash: hashToken(access), refreshHash: hashToken(refresh), accessExpiresAt: now + OAUTH_TTL.access, refreshExpiresAt: now + OAUTH_TTL.refresh,
  } }, now)).status);
  return { access, refresh, status };
}

/** `issueOAuth` into the server database at `dbPath`, opened and closed here, for a server process started on it afterwards. */
export async function issueOAuthIn(dbPath: string, ...args: Parameters<typeof issueOAuth> extends [Repo, ...infer Rest] ? Rest : never) {
  const { db, repo } = openDatabase(dbPath, { blobDir: join(dirname(dbPath), "blobs") });
  try {
    return await issueOAuth(repo, ...args);
  } finally {
    db.close();
  }
}
