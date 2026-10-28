import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Repo } from "./db.ts";

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS  = ["accounts.google.com", "https://accounts.google.com"];

// jose handles JWKS caching internally (respects Cache-Control)
const googleJwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));

export type AuthedUser = {
  user_id: number;
  user_email: string;
  session_id: number;
};

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function mintToken(): string {
  return `gbrd_v1_${randomBytes(32).toString("base64url")}`;
}

// The deferred last-used touch below outlives the request that scheduled it.
// A touch that fires after stop() closed the database would be an unhandled
// crash (the CI failure this fixes), so stop() cancels what is pending. The
// queue is per-server: one startServer's stop() must not cancel a different
// live server's touches in the same process (two TestServers in one test run).
export type TouchQueue = {
  schedule(run: () => void): void;
  cancelAll(): void;
};

export function createTouchQueue(): TouchQueue {
  const pending = new Set<NodeJS.Immediate>();
  return {
    schedule(run: () => void): void {
      const t = setImmediate(() => {
        pending.delete(t);
        run();
      });
      pending.add(t);
    },
    cancelAll(): void {
      for (const t of pending) clearImmediate(t);
      pending.clear();
    },
  };
}

export type AuthLost = "token_revoked" | "user_disabled";

/** The one rule for a token: why a session row and its user row no longer authenticate, or null while they do (#351). Revoked wins over disabled. */
function lostOf(session: { revoked_at: number | null } | null | undefined, user: { disabled_at: number | null } | null | undefined): AuthLost | null {
  if (!session || session.revoked_at !== null) return "token_revoked";
  return !user || user.disabled_at !== null ? "user_disabled" : null;
}

export function verifySessionToken(raw: string, repo: Repo, touches: TouchQueue): AuthedUser | null {
  const hash = hashToken(raw);
  const session = repo.sessions.findByTokenHash(hash);
  if (!session) return null;
  const user = repo.users.findById(session.user_id);
  if (lostOf(session, user)) return null;
  // Off the request path: last-used is a stamp, not a result the caller waits on.
  touches.schedule(() => repo.sessions.touch(session.id, Date.now()));
  return { user_id: session.user_id, user_email: user!.email, session_id: session.id };
}

/** Why `authed`'s token no longer authenticates, or null while it does: verifySessionToken's rule, by session id. */
export function authLost(authed: AuthedUser, repo: Repo): AuthLost | null {
  return lostOf(repo.sessions.findById(authed.session_id), repo.users.findById(authed.user_id));
}

export async function verifyGoogleIdToken(
  idToken: string,
  clientId: string,
  allowedDomain: string,
  options: { expectedNonce?: string; keyResolver?: JWTVerifyGetKey } = {},
): Promise<{ email: string; displayName: string | null }> {
  const { payload } = await jwtVerify(idToken, options.keyResolver ?? googleJwks, {
    issuer: GOOGLE_ISSUERS,
    audience: clientId,
  });
  if (typeof payload.exp !== "number" || typeof payload.iat !== "number" || typeof payload.sub !== "string" || !payload.sub ||
      (payload.azp !== undefined && payload.azp !== clientId) ||
      (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)) throw new Error("invalid Google ID token claims");
  if (payload["hd"] !== allowedDomain) {
    throw new Error(`account must be from @${allowedDomain}`);
  }
  if (options.expectedNonce !== undefined && payload["nonce"] !== options.expectedNonce) throw new Error("invalid Google nonce");
  if (typeof payload["email"] !== "string" || !payload["email"].trim()) throw new Error("invalid Google email");
  if (payload["email_verified"] !== true) {
    throw new Error("email is not verified");
  }
  const email = (payload["email"] as string).toLowerCase();
  const displayName = typeof payload["name"] === "string" ? payload["name"] : null;
  return { email, displayName };
}

export async function exchangeGoogleCode(
  code: string,
  codeVerifier: string,
  redirectUri: string,
  clientId: string,
  clientSecret: string,
  allowedDomain: string,
  expectedNonce?: string,
): Promise<{ email: string; displayName: string | null }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(10_000),
    body: new URLSearchParams({
      client_id:     clientId,
      client_secret: clientSecret,
      code,
      code_verifier: codeVerifier,
      redirect_uri:  redirectUri,
      grant_type:    "authorization_code",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google token exchange failed (${res.status}): ${body}`);
  }
  const { id_token } = (await res.json()) as { id_token: string };
  return verifyGoogleIdToken(id_token, clientId, allowedDomain, { expectedNonce });
}

export function extractBearer(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  return auth.slice(7).trim() || null;
}
