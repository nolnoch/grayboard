import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { DomainRefused, type IdentityProvider } from "./idp.ts";
import { googleDirectoryStatus, type GoogleDirectoryConfig, type GoogleDirectoryOptions } from "./idp_google_directory.ts";

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS  = ["accounts.google.com", "https://accounts.google.com"];
// The stored issuer: one constant whichever of GOOGLE_ISSUERS' spellings a token carried.
export const GOOGLE_ISSUER = "https://accounts.google.com";

// jose handles JWKS caching internally (respects Cache-Control)
const googleJwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));

// A verified Google account. subject: its `sub`, the ID Google never reuses,
// while an email can pass to another person (security audit F-13).
export type GoogleIdentity = { email: string; displayName: string | null; subject: string };

export async function verifyGoogleIdToken(
  idToken: string,
  clientId: string,
  allowedDomain: string,
  options: { expectedNonce: string; keyResolver?: JWTVerifyGetKey },
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
  // Required (#928 D1): every caller sent one on the authorize URL.
  if (typeof payload["nonce"] !== "string" || !options.expectedNonce || payload["nonce"] !== options.expectedNonce) throw new Error("invalid Google nonce");
  if (typeof payload["email"] !== "string" || !payload["email"].trim()) throw new Error("invalid Google email");
  if (payload["email_verified"] !== true) {
    throw new Error("email is not verified");
  }
  const email = (payload["email"] as string).toLowerCase();
  // `hd` is the Workspace's primary domain; the email is the bus address, so its domain is checked too (D5).
  if (email.split("@")[1] !== allowedDomain) throw new DomainRefused(`account must be from @${allowedDomain}`);
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
  expectedNonce: string,
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

// Google behind the AS: the client pair the AS selected (mcpGoogle, else the
// primary), a nonce on every exchange, `hd` on the authorize URL. The exchange
// refuses an email outside the org domain (DomainRefused). directory: the service account its status check asks the
// Directory API with (#930 A2b); without one it has no status, and its users stay on the re-auth clock.
export function googleProvider(
  google: { clientId: string; clientSecret: string; orgDomain: string }, directory?: GoogleDirectoryConfig, directoryOptions?: GoogleDirectoryOptions,
): IdentityProvider {
  return {
    ...(directory ? { status: googleDirectoryStatus(directory, directoryOptions) } : {}),
    id: "google",
    label: "Google",
    issuer: GOOGLE_ISSUER,
    callbackParams: ["code", "state", "error", "error_description", "scope", "authuser", "prompt", "hd", "iss"],
    async authorizeUrl({ redirectUri, state, nonce, challenge }) {
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.search = new URLSearchParams({ client_id: google.clientId, redirect_uri: redirectUri, response_type: "code",
        scope: "openid email profile", state, nonce, code_challenge: challenge, code_challenge_method: "S256", hd: google.orgDomain }).toString();
      return url.href;
    },
    async exchange({ code, verifier, redirectUri, nonce }) {
      const identity = await exchangeGoogleCode(code, verifier, redirectUri, google.clientId, google.clientSecret, google.orgDomain, nonce);
      return { issuer: GOOGLE_ISSUER, ...identity };
    },
  };
}
