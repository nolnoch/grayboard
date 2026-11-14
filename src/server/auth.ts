import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Repo, User } from "./db.ts";
import { writeAudit } from "./audit.ts";

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
// cancelAll also closes the queue: a request still in flight when stop() runs
// (one awaiting the OAuth handler, say) can verify a token after the cancel,
// and its touch must not run against the closed database either (#385).
export type TouchQueue = {
  schedule(run: () => void): void;
  cancelAll(): void;
};

export function createTouchQueue(): TouchQueue {
  const pending = new Set<NodeJS.Immediate>();
  let closed = false;
  return {
    schedule(run: () => void): void {
      if (closed) return;
      const t = setImmediate(() => {
        pending.delete(t);
        run();
      });
      pending.add(t);
    },
    cancelAll(): void {
      closed = true;
      for (const t of pending) clearImmediate(t);
      pending.clear();
    },
  };
}

export function verifySessionToken(raw: string, repo: Repo, touches: TouchQueue): AuthedUser | null {
  const hash = hashToken(raw);
  const session = repo.sessions.findByTokenHash(hash);
  if (!session) return null;
  const user = repo.users.findById(session.user_id);
  if (session.revoked_at !== null || !user || user.disabled_at !== null) return null;
  // Off the request path: last-used is a stamp, not a result the caller waits on.
  touches.schedule(() => repo.sessions.touch(session.id, repo.now()));
  return { user_id: session.user_id, user_email: user!.email, session_id: session.id };
}

// A verified Google account. subject: its `sub`, the ID Google never reuses,
// while an email can pass to another person (security audit F-13).
export type GoogleIdentity = { email: string; displayName: string | null; subject: string };

export async function verifyGoogleIdToken(
  idToken: string,
  clientId: string,
  allowedDomain: string,
  options: { expectedNonce?: string; keyResolver?: JWTVerifyGetKey } = {},
): Promise<GoogleIdentity> {
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
  return { email, displayName, subject: payload.sub };
}

export async function exchangeGoogleCode(
  code: string,
  codeVerifier: string,
  redirectUri: string,
  clientId: string,
  clientSecret: string,
  allowedDomain: string,
  expectedNonce?: string,
): Promise<GoogleIdentity> {
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

// Resolves a Google sign-in to its user, subject first (security audit F-13),
// and audits a first link or a refusal. A refusal's text tells the person
// signing in what an admin can do; `detail` joins each audit row.
export function googleSignIn(repo: Repo, identity: GoogleIdentity, detail: Record<string, unknown> = {}): { user: User } | { refused: string } {
  const r = repo.users.signIn(identity.email, identity.subject, identity.displayName);
  if (r.status === "subject_mismatch") {
    writeAudit(repo, "auth.subject_refused", identity.email, null, { reason: r.status, ...detail });
    return { refused: `${identity.email} is linked to a different Google account. If this account should have it, an admin runs grayboard admin unlink-idp --email ${identity.email}` };
  }
  if (r.status === "email_changed") {
    writeAudit(repo, "auth.subject_refused", r.user.email, null, { reason: r.status, email: identity.email, ...detail });
    return { refused: `this Google account belongs to grayboard user ${r.user.email} but now reports ${identity.email}. To sign in as ${identity.email} (a new account), an admin runs grayboard admin unlink-idp --email ${r.user.email}` };
  }
  if (r.status === "ok" && r.linked) writeAudit(repo, "auth.subject_linked", r.user.email, null, detail);
  return { user: r.user };
}

export function extractBearer(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  return auth.slice(7).trim() || null;
}
