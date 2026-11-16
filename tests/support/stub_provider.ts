// A stubbed upstream identity provider for OAuthOptions.providers (#928): the
// real Google authorize URL, so a test drives the same redirect and callback
// path, with the exchange replaced by a fixed identity or a function. It skips
// token verification by design; idp_google.test.ts covers that.
import type { ExchangeInput, IdentityProvider, UpstreamIdentity } from "../../src/server/idp.ts";
import { googleProvider } from "../../src/server/idp_google.ts";

// issuer defaults to Google's.
export type StubIdentity = Omit<UpstreamIdentity, "issuer"> & { issuer?: string };

export function stubProvider(
  stub: StubIdentity | ((input: ExchangeInput) => Promise<StubIdentity>),
  upstream: { clientId: string; orgDomain: string } = { clientId: "stub-client", orgDomain: "example.com" },
): IdentityProvider {
  const google = googleProvider({ ...upstream, clientSecret: "" });
  return { ...google, exchange: async input => ({ issuer: google.issuer, ...(typeof stub === "function" ? await stub(input) : stub) }) };
}
