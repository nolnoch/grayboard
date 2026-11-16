// The upstream identity-provider seam (#928, docs/future/okta-idp.md D1). The
// OAuth authorization server (oauth.ts) owns everything that isn't
// provider-specific: upstream state, the PKCE verifier, the nonce, the binding
// cookie and the callback route. A provider builds its authorize URL and turns
// a callback's code into a verified identity.

// issuer: half of the stored key, the provider's constant, never a token's `iss`.
export type UpstreamIdentity = { issuer: string; subject: string; email: string; displayName: string | null };

export type AuthorizeInput = { redirectUri: string; state: string; nonce: string; challenge: string };
export type ExchangeInput = { code: string; verifier: string; redirectUri: string; nonce: string };

export type IdentityProvider = {
  id: string;        // "google": the callback path (/oauth/<id>/callback)
  label: string;     // what a sign-in chooser would name it
  issuer: string;    // a callback's `iss` parameter, when present, must equal it
  callbackParams: readonly string[];
  // Async: a provider may need discovery before it knows its endpoint.
  authorizeUrl(i: AuthorizeInput): Promise<string>;
  // Returns only once every check held (signature, issuer, audience, expiry,
  // nonce, verified email, domain), with the email lowercased. Verification
  // lives here so no caller can skip it.
  exchange(i: ExchangeInput): Promise<UpstreamIdentity>;
};

export const callbackPath = (p: Pick<IdentityProvider, "id">) => `/oauth/${p.id}/callback`;
