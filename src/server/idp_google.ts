import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Config } from "./config.ts";
import type { IdentityProvider } from "./idp.ts";

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

// Google behind the AS: the client pair the AS selected (mcpGoogle, else the
// primary), a nonce on every exchange, `hd` on the authorize URL. The AS
// re-checks the email's domain after the exchange (oauth.domain_refused).
export function googleProvider(google: { clientId: string; clientSecret: string; orgDomain: string }): IdentityProvider {
  return {
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

// The CLI's direct exchange (/api/auth/exchange): the primary client pair, no
// nonce (the CLI builds its own authorize URL) and `hd` alone. It isn't an
// IdentityProvider; #928 step 3 deletes it with the route.
export function exchangeGoogleCliCode(
  config: Pick<Config, "googleClientId" | "googleClientSecret" | "orgDomain">,
  input: { code: string; verifier: string; redirectUri: string },
): Promise<GoogleIdentity> {
  return exchangeGoogleCode(input.code, input.verifier, input.redirectUri, config.googleClientId, config.googleClientSecret, config.orgDomain);
}
