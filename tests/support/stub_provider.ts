// A stubbed upstream identity provider for OAuthOptions.providers (#928): the
// real Google authorize URL, so a test drives the same redirect and callback
// path, with the exchange replaced by a fixed identity or a function. It skips
// token verification by design; idp_google.test.ts covers that.
import type { ExchangeInput, IdentityProvider, UpstreamIdentity } from "../../src/server/idp.ts";
import { googleProvider } from "../../src/server/idp_google.ts";

// issuer defaults to the provider's.
export type StubIdentity = Omit<UpstreamIdentity, "issuer"> & { issuer?: string };

// `as`: another IdP behind Google's authorize URL: its id (the callback path), issuer (the stored key's half the AS
// passes) and label.
export function stubProvider(
  stub: StubIdentity | ((input: ExchangeInput) => Promise<StubIdentity>),
  upstream: { clientId: string; orgDomain: string } = { clientId: "stub-client", orgDomain: "example.com" },
  as: { id?: string; issuer?: string; label?: string } = {},
): IdentityProvider {
  const google = { ...googleProvider({ ...upstream, clientSecret: "" }), ...as };
  return { ...google, exchange: async input => ({ issuer: google.issuer, ...(typeof stub === "function" ? await stub(input) : stub) }) };
}
