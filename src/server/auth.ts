import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
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

export function verifySessionToken(raw: string, repo: Repo): AuthedUser | null {
  const hash = hashToken(raw);
  const session = repo.sessions.findByTokenHash(hash);
  if (!session) return null;
  const user = repo.users.findById(session.user_id);
  if (!user || user.disabled_at !== null) return null;
  setImmediate(() => repo.sessions.touch(session.id, Date.now()));
  return { user_id: user.id, user_email: user.email, session_id: session.id };
}

export async function verifyGoogleIdToken(
  idToken: string,
  clientId: string,
  allowedDomain: string,
): Promise<{ email: string; displayName: string | null }> {
  const { payload } = await jwtVerify(idToken, googleJwks, {
    issuer: GOOGLE_ISSUERS,
    audience: clientId,
  });
  if (payload["hd"] !== allowedDomain) {
    throw new Error(`account must be from @${allowedDomain}`);
  }
  if (!payload["email_verified"]) {
    throw new Error("email is not verified");
  }
  const email = (payload["email"] as string).toLowerCase();
  const displayName = (payload["name"] as string | undefined) ?? null;
  return { email, displayName };
}

export async function exchangeGoogleCode(
  code: string,
  codeVerifier: string,
  redirectUri: string,
  clientId: string,
  clientSecret: string,
  allowedDomain: string,
): Promise<{ email: string; displayName: string | null }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
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
  return verifyGoogleIdToken(id_token, clientId, allowedDomain);
}

export function extractBearer(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  return auth.slice(7).trim() || null;
}
