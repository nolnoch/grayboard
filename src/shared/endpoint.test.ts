// The issuer pin rule (#1326): only what the server's own issuer rule can advertise passes, so a static-mode launcher's
// pin that `new URL` would rewrite is refused at launch, not at enrollment as a pin mismatch.
import { expect, test } from "bun:test";
import { canonicalEndpoint, issuerEndpoint } from "./endpoint.ts";
import { oauthPublicUrl } from "../server/oauth-config.ts";

// Every form the server keeps as its issuer: an explicit default port among them (oauthPublicUrl preserves it).
const kept = [
  "https://grayboard.example.com", "https://grayboard.example.com/", "https://grayboard.example.com/hosted", "https://grayboard.example.com/hosted/",
  "https://grayboard.example.com:443", "https://grayboard.example.com:443/hosted", "https://grayboard.example.com:8443/hosted", "http://127.0.0.1:9", "http://localhost:80",
];
test.each(kept)("the pin %s passes, as the server would advertise it", issuer => {
  expect(issuerEndpoint(issuer)?.href).toBe(canonicalEndpoint(issuer)!.href);
  // The server's own rule takes it too (loopback HTTP only under dev auth).
  expect(() => oauthPublicUrl(issuer, issuer.startsWith("http:"))).not.toThrow();
});

// Forms the endpoint rule accepts but `new URL` rewrites: the server refuses every one as its public URL, so no
// metadata can name it.
const rewritten = [
  "https:grayboard.example.com", "https:///grayboard.example.com", "https://@grayboard.example.com", "https://:@grayboard.example.com",
  "https://0x7f.1", "https://0177.0.0.1", "https://bücher.example", "HTTPS://grayboard.example.com", "https://GRAYBOARD.example.com", "HTTPS://grayboard.example.com:443",
  "https://grayboard.example.com:0443", "https://grayboard.example.com/a/../hosted", "https://grayboard.example.com/./hosted", "https://grayboard.example.com//hosted",
];
test.each(rewritten)("the pin %s is refused", issuer => {
  expect(canonicalEndpoint(issuer)).toBeDefined();
  expect(issuerEndpoint(issuer)).toBeUndefined();
  expect(() => oauthPublicUrl(issuer, false)).toThrow();
});

test("what the endpoint rule refuses, the issuer rule refuses", () => {
  for (const issuer of ["http://grayboard.example.com", "https://u:p@grayboard.example.com", "https://grayboard.example.com/?q", "https://grayboard.example.com/%7E", "not a url"]) {
    expect(issuerEndpoint(issuer)).toBeUndefined();
  }
});
