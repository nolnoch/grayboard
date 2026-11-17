// The upstream identity-provider seam (#928, docs/server-oauth.md §1). The
// OAuth authorization server (oauth.ts) owns everything that isn't
// provider-specific: upstream state, the PKCE verifier, the nonce, the binding
// cookie and the callback route. A provider builds its authorize URL and turns
// a callback's code into a verified identity.
import { writeAudit } from "./audit.ts";
import type { Config } from "./config.ts";
import type { Repo, User } from "./db.ts";
import type { Tx } from "./store/tx.ts";
import { googleProvider } from "./idp_google.ts";
import { oidcProvider } from "./idp_oidc.ts";

// issuer: half of the stored key, the provider's constant, never a token's `iss`.
export type UpstreamIdentity = { issuer: string; subject: string; email: string; displayName: string | null };

export type AuthorizeInput = { redirectUri: string; state: string; nonce: string; challenge: string };
export type ExchangeInput = { code: string; verifier: string; redirectUri: string; nonce: string };

export type IdentityProvider = {
  id: string;        // "google", "okta": config, the callback path (/oauth/<id>/callback), audit detail
  label: string;     // the chooser's link text
  issuer: string;    // a callback's `iss` parameter, when present, must equal it
  callbackParams: readonly string[];
  // Async: a provider may need discovery before it knows its endpoint.
  authorizeUrl(i: AuthorizeInput): Promise<string>;
  // Returns only once every check held (signature, issuer, audience, expiry,
  // nonce, verified email, domain), with the email lowercased. Verification
  // lives here so no caller can skip it.
  exchange(i: ExchangeInput): Promise<UpstreamIdentity>;
};

// A provider's refusal of a verified identity whose email is outside the org's domains (D5). The AS
// audits it as oauth.domain_refused rather than as a failed exchange.
export class DomainRefused extends Error {}

export const callbackPath = (p: Pick<IdentityProvider, "id">) => `/oauth/${p.id}/callback`;

// The providers a server signs in with when OAuthOptions.providers doesn't inject any, built from Config alone in
// GRAYBOARD_IDPS's order (#928 D6): Google with the client pair the AS uses (mcpGoogle, else the primary), Okta as
// the generic OIDC provider. loadConfig has checked the list (checkIdpConfig); nothing is fetched here (D2).
export function defaultProviders(config: Config): IdentityProvider[] {
  return (config.idps ?? ["google"]).map(id => {
    if (id === "okta") {
      if (!config.okta) throw new Error("GRAYBOARD_IDPS lists okta without its configuration");
      return oidcProvider({ id: "okta", label: "Okta", ...config.okta });
    }
    const googleClient = config.mcpGoogle ?? { clientId: config.googleClientId, clientSecret: config.googleClientSecret };
    return googleProvider({ ...googleClient, orgDomain: config.orgDomain });
  });
}

export type SignInProvider = Pick<IdentityProvider, "id" | "label" | "issuer">;

// Resolves a verified sign-in to its user by (issuer, subject) first (security
// audit F-13, #928 D4), and audits a first link or a refusal. The issuer is the
// provider's constant, never the token's. A refusal's text tells the person
// signing in what an admin can do and reaches the OAuth client as its error_description; `detail` joins each audit row, and `known`
// names the provider holding an email another issuer holds. Callers run it
// inside repo.write, passing its Tx.
export function idpSignIn(
  repo: Repo, tx: Tx, provider: SignInProvider, identity: Omit<UpstreamIdentity, "issuer">,
  detail: Record<string, unknown> = {}, known: readonly SignInProvider[] = [provider],
): { user: User } | { refused: string } {
  const r = repo.users.signIn(tx, provider.issuer, identity.subject, identity.email, identity.displayName);
  const audited = { provider: provider.id, issuer: provider.issuer, ...detail };
  const fix = (email: string) => `an admin runs grayboard admin unlink-idp --email ${email}`;
  if (r.status === "issuer_mismatch") {
    writeAudit(repo, tx, "auth.subject_refused", identity.email, null, { reason: r.status, holding_issuer: r.issuer, ...audited });
    // An unlisted holder isn't named by its issuer: this text reaches whichever client started the sign-in,
    // and the audit row above keeps the issuer.
    const holder = known.find(p => p.issuer === r.issuer)?.label;
    return { refused: `${identity.email} is linked to ${holder ? `a ${holder}` : "another provider's"} account, not ${provider.label}. If this ${provider.label} account should have it, ${fix(identity.email)}` };
  }
  if (r.status === "subject_mismatch") {
    writeAudit(repo, tx, "auth.subject_refused", identity.email, null, { reason: r.status, ...audited });
    return { refused: `${identity.email} is linked to a different ${provider.label} account. If this account should have it, ${fix(identity.email)}` };
  }
  if (r.status === "email_changed") {
    writeAudit(repo, tx, "auth.subject_refused", r.user.email, null, { reason: r.status, email: identity.email, ...audited });
    return { refused: `this ${provider.label} account belongs to grayboard user ${r.user.email} but now reports ${identity.email}. To sign in as ${identity.email} (a new account), ${fix(r.user.email)}` };
  }
  if (r.status === "ok" && r.linked) writeAudit(repo, tx, "auth.subject_linked", r.user.email, null, audited);
  return { user: r.user };
}
