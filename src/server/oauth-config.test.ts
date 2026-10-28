import { expect, test } from "bun:test";
import { matchesRedirect, oauthPublicUrl, parseOAuthClients, validateRedirect, type OAuthClient } from "./oauth-config.ts";
const client: OAuthClient = { clientId: "native", name: "Native", redirectUris: ["http://127.0.0.1/callback?fixed=1", "http://[::1]/callback", "https://client.example/callback"], scopes: ["grayboard:tools"], tokenEndpointAuthMethod: "none" };
test("client registration is strict, bounded, hash-only, and opt-in for refresh", () => {
  expect(parseOAuthClients(undefined)).toEqual([]);
  expect(parseOAuthClients(JSON.stringify([client]))[0]?.allowRefresh).toBe(false);
  for (const patch of [{ clientId: "" }, { name: "\n" }, { scopes: ["offline_access"] }, { scopes: [] }, { scopes: ["grayboard:tools", "grayboard:tools"] }, { redirectUris: [] }, { clientSecretHash: "a".repeat(64) }, { tokenEndpointAuthMethod: "client_secret_post" }, { tokenEndpointAuthMethod: "client_secret_basic" }, { allowRefresh: "yes" }, { secret: "raw" }]) {
    expect(() => parseOAuthClients(JSON.stringify([{ ...client, ...patch }]))).toThrow();
  }
  expect(() => parseOAuthClients(JSON.stringify([client, client]))).toThrow();
  expect(parseOAuthClients(JSON.stringify([{ ...client, tokenEndpointAuthMethod: "client_secret_basic", clientSecretHash: "a".repeat(64) }]))).toHaveLength(1);
});
test("redirect matching is exact except a registered loopback HTTP port", () => {
  for (const url of ["http://127.0.0.1:45678/callback?fixed=1", "http://[::1]:45678/callback", "https://client.example/callback"]) expect(matchesRedirect(client, url)).toBe(true);
  for (const url of ["http://localhost:45678/callback", "http://127.0.0.2/callback?fixed=1", "http://127.0.0.1:45678/callback?fixed=2", "http://127.0.0.1:45678/callback/", "https://client.example/callback?x=1", "https://client.example:444/callback", "https://client.example/callback#", "http://2130706433/callback?fixed=1"]) expect(matchesRedirect(client, url)).toBe(false);
  const fixed = { ...client, redirectUris: ["http://localhost:8080/callback", "http://127.0.0.1:8080/callback?fixed=1", "http://[::1]:8080/callback?fixed=1"] };
  for (const uri of ["http://127.0.0.1:8081/callback?fixed=1", "http://[::1]:8081/callback?fixed=1", "http://127.0.0.1/callback?fixed=1", "http://[::1]/callback?fixed=1", "http://127.0.0.1:80/callback?fixed=1", "http://[::1]:80/callback?fixed=1", "http://127.0.0.1:65535/callback?fixed=1", "http://[::1]:1/callback?fixed=1"]) expect(matchesRedirect(fixed, uri)).toBe(true);
  expect(matchesRedirect(fixed, "http://localhost:8081/callback")).toBe(true);
  for (const uri of ["http://127.0.0.2:8081/callback?fixed=1", "http://[::2]:8081/callback?fixed=1", "http://127.0.0.1:8081/other?fixed=1", "http://[::1]:8081/callback?fixed=2", "https://127.0.0.1:8081/callback?fixed=1", "https://[::1]:8081/callback?fixed=1"]) expect(matchesRedirect(fixed, uri)).toBe(false);
  for (const url of ["javascript:alert(1)", "custom://callback/path", "http://remote.example/cb", "https://user@client.example/cb", "https://client.example/cb#fragment", "https://client.example/a/../cb", "https://client.example/%2fcb", "https://client.example/cb?code=x", "https://client.example/cb?x=%0a", "https://client.example\\evil/cb"]) expect(() => validateRedirect(url)).toThrow();
});
test("issuer is fixed and HTTPS, with explicit loopback-only development exemption", () => {
  expect(oauthPublicUrl("https://grayboard.example.com:443/hosted", false)).toBe("https://grayboard.example.com:443/hosted");
  for (const base of ["http://localhost:8080", "http://127.0.0.1:8080", "http://[::1]:8080"]) {
    expect(oauthPublicUrl(base, true)).toBe(base);
    expect(() => oauthPublicUrl(base, false)).toThrow();
  }
  for (const base of ["http://remote.example", "https://example.com?x=1", "https://example.com#", "https://user@example.com", "https://example.com/a/../b", "https://example.com/%2f", "https://example.com/a//b"]) expect(() => oauthPublicUrl(base, true)).toThrow();
});
