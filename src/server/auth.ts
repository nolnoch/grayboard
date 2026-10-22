import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Repo } from "./db.ts";
import type { Config, EntraConfig, GoogleConfig, IdpEndpoints } from "./config.ts";

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

export function extractBearer(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  return auth.slice(7).trim() || null;
}

// ── sign-in providers ────────────────────────────────────────────────────────

export type ProviderName = "google" | "entra";
export const PROVIDER_NAMES: readonly ProviderName[] = ["google", "entra"];
export const PROVIDER_LABEL: Record<ProviderName, string> = { google: "Google", entra: "Microsoft" };

// What a provider vouches for once its checks pass. subject is the stable
// account key (Google sub; Entra tid:oid), never the email. authoritative:
// the provider owns the address, so it may claim an existing user by email.
export type VerifiedLogin = {
  provider: ProviderName;
  subject: string;
  email: string;
  displayName: string | null;
  authoritative: boolean;
};

// The IdP vouched for an account that may not sign in here (403).
export class LoginRefused extends Error {
  constructor(message: string, readonly claimedEmail?: string) { super(message); }
}

// The IdP itself failed: the code didn't redeem, or it was unreachable (502).
export class IdpError extends Error {}

export type Provider = {
  name: ProviderName;
  clientId: string;
  authorizeUrl: string;
  // Google's account-chooser hint, sent only when there's no allowlist.
  hd?: string;
  // Redeems a loopback authorization code and checks its ID token.
  exchange(code: string, codeVerifier: string, redirectUri: string): Promise<VerifiedLogin>;
};

export type Providers = Partial<Record<ProviderName, Provider>>;

export function makeProviders(config: Config): Providers {
  return {
    ...(config.google ? { google: googleProvider(config.google) } : {}),
    ...(config.entra ? { entra: entraProvider(config.entra) } : {}),
  };
}

const GOOGLE_ENDPOINTS: IdpEndpoints = {
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
  token:     "https://oauth2.googleapis.com/token",
  jwks:      "https://www.googleapis.com/oauth2/v3/certs",
};
const GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];

function googleProvider(cfg: GoogleConfig): Provider {
  const endpoints = cfg.endpoints ?? GOOGLE_ENDPOINTS;
  // jose caches the key set and refetches on an unknown kid.
  const jwks = createRemoteJWKSet(new URL(endpoints.jwks));
  return {
    name: "google",
    clientId: cfg.clientId,
    authorizeUrl: endpoints.authorize,
    ...(cfg.orgDomain && !cfg.allowedEmails.length ? { hd: cfg.orgDomain } : {}),
    async exchange(code, codeVerifier, redirectUri) {
      const idToken = await redeemCode("Google", endpoints.token, cfg.clientId, cfg.clientSecret, code, codeVerifier, redirectUri);
      const payload = await verifyIdToken("Google", idToken, jwks, GOOGLE_ISSUERS, cfg.clientId);
      return checkGoogleClaims(payload, cfg);
    },
  };
}

// Google is authoritative for an address only in a Workspace domain (hd) or
// at @gmail.com; elsewhere email_verified may date from account creation.
export function checkGoogleClaims(p: JWTPayload, cfg: Pick<GoogleConfig, "orgDomain" | "allowedEmails">): VerifiedLogin {
  const email = typeof p["email"] === "string" ? p["email"].toLowerCase() : undefined;
  if (!email) throw new LoginRefused("the Google ID token has no email claim");
  if (p["email_verified"] !== true) throw new LoginRefused("Google hasn't verified this account's email", email);
  const hd = typeof p["hd"] === "string" ? p["hd"].toLowerCase() : undefined;
  const inDomain = cfg.orgDomain !== undefined && hd === cfg.orgDomain;
  if (!inDomain && !cfg.allowedEmails.includes(email)) {
    throw new LoginRefused(
      cfg.orgDomain ? `${email} isn't in @${cfg.orgDomain} or on this server's allowlist` : `${email} isn't on this server's allowlist`,
      email,
    );
  }
  if (typeof p.sub !== "string" || !p.sub) throw new LoginRefused("the Google ID token has no sub claim", email);
  return {
    provider: "google",
    subject: p.sub,
    email,
    displayName: typeof p["name"] === "string" ? p["name"] : null,
    authoritative: hd !== undefined || email.endsWith("@gmail.com"),
  };
}

const ENTRA_LOGIN = "https://login.microsoftonline.com";

// One tenant signs in at its own authority; several need the multitenant
// "organizations" one, and the issuer check narrows it back to the list.
export function entraAuthority(tenantIds: string[]): string {
  return tenantIds.length === 1 ? tenantIds[0]! : "organizations";
}

function entraProvider(cfg: EntraConfig): Provider {
  const base = `${ENTRA_LOGIN}/${entraAuthority(cfg.tenantIds)}`;
  const endpoints = cfg.endpoints ?? {
    authorize: `${base}/oauth2/v2.0/authorize`,
    token:     `${base}/oauth2/v2.0/token`,
    jwks:      `${base}/discovery/v2.0/keys`,
  };
  const jwks = createRemoteJWKSet(new URL(endpoints.jwks));
  const issuers = cfg.tenantIds.map(entraIssuer);
  return {
    name: "entra",
    clientId: cfg.clientId,
    authorizeUrl: endpoints.authorize,
    async exchange(code, codeVerifier, redirectUri) {
      const idToken = await redeemCode("Microsoft", endpoints.token, cfg.clientId, cfg.clientSecret, code, codeVerifier, redirectUri);
      const payload = await verifyIdToken("Microsoft", idToken, jwks, issuers, cfg.clientId);
      return checkEntraClaims(payload, cfg);
    },
  };
}

export function entraIssuer(tenantId: string): string {
  return `${ENTRA_LOGIN}/${tenantId}/v2.0`;
}

// Entra's email claim is unverified and mutable: the account key is tid:oid,
// and the email counts only when xms_edov says the tenant owns its domain.
export function checkEntraClaims(p: JWTPayload, cfg: Pick<EntraConfig, "tenantIds">): VerifiedLogin {
  if (p["ver"] !== "2.0") throw new LoginRefused(`expected a v2.0 Microsoft ID token, not ver ${JSON.stringify(p["ver"])}`);
  const tid = typeof p["tid"] === "string" ? p["tid"].toLowerCase() : undefined;
  if (!tid || !cfg.tenantIds.includes(tid)) throw new LoginRefused(`tenant ${tid ?? "(none)"} isn't allowed on this server`);
  if (p.iss !== entraIssuer(tid)) throw new LoginRefused("the Microsoft ID token's issuer doesn't match its tenant");
  const oid = typeof p["oid"] === "string" ? p["oid"].toLowerCase() : undefined;
  if (!oid) throw new LoginRefused("the Microsoft ID token has no oid claim");
  const claimed = typeof p["email"] === "string" ? p["email"].toLowerCase() : undefined;
  if (p["acct"] === undefined) {
    throw new LoginRefused("the Microsoft ID token has no acct claim: add the acct optional claim to the app registration", claimed);
  }
  if (p["acct"] !== 0) throw new LoginRefused("guest accounts can't sign in: use an account that's a member of an allowed tenant", claimed);
  if (!claimed) {
    throw new LoginRefused("the Microsoft ID token has no email claim: add the email optional claim, and give the account an email address");
  }
  if (p["xms_edov"] === undefined) {
    throw new LoginRefused("the Microsoft ID token has no xms_edov claim: add the xms_edov optional claim to the app registration", claimed);
  }
  if (p["xms_edov"] !== true) {
    throw new LoginRefused(`Microsoft hasn't verified that the tenant owns ${claimed}'s domain (xms_edov is ${JSON.stringify(p["xms_edov"])})`, claimed);
  }
  return {
    provider: "entra",
    subject: `${tid}:${oid}`,
    email: claimed,
    displayName: typeof p["name"] === "string" ? p["name"] : null,
    authoritative: true,
  };
}

async function redeemCode(
  idp: string, tokenUrl: string, clientId: string, clientSecret: string,
  code: string, codeVerifier: string, redirectUri: string,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(tokenUrl, {
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
  } catch (e) {
    throw new IdpError(`${idp} token endpoint unreachable: ${(e as Error).message}`);
  }
  if (!res.ok) throw new IdpError(`${idp} token exchange failed (${res.status}): ${await res.text()}`);
  const { id_token } = (await res.json()) as { id_token?: string };
  if (!id_token) throw new IdpError(`${idp} token response has no id_token (is the openid scope missing?)`);
  return id_token;
}

async function verifyIdToken(
  idp: string, idToken: string, jwks: ReturnType<typeof createRemoteJWKSet>, issuers: string[], clientId: string,
): Promise<JWTPayload> {
  try {
    const { payload } = await jwtVerify(idToken, jwks, { issuer: issuers, audience: clientId, algorithms: ["RS256"] });
    return payload;
  } catch (e) {
    // The token's fault: its signature, claims or key id. Anything else (key
    // set fetch failed, timed out or was malformed) is the IdP's.
    const code = (e as { code?: string }).code ?? "";
    if (/^ERR_JW[TS]_/.test(code) || code === "ERR_JWKS_NO_MATCHING_KEY" || code === "ERR_JOSE_ALG_NOT_ALLOWED") {
      throw new LoginRefused(`${idp} ID token rejected: ${(e as Error).message}`);
    }
    throw new IdpError(`${idp} signing keys unavailable: ${(e as Error).message}`);
  }
}
