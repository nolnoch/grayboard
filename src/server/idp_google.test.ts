import { expect, test } from "bun:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { DomainRefused } from "./idp.ts";
import { verifyGoogleIdToken } from "./idp_google.ts";

test("Google JWT verification preserves issuer/audience/domain and requires verified typed email and bound nonce", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const keyResolver = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: "test" }] });
  const claims: JWTPayload = { iss: "https://accounts.google.com", aud: "client", sub: "subject", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60,
    hd: "example.com", email: "YOU@example.com", email_verified: true, nonce: "nonce", name: "You" };
  const sign = (payload: JWTPayload) => new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid: "test" }).sign(privateKey);
  expect(await verifyGoogleIdToken(await sign(claims), "client", "example.com", { expectedNonce: "nonce", keyResolver })).toEqual({ email: "you@example.com", displayName: "You", subject: "subject" });
  for (const patch of [{ iss: "https://evil.example" }, { aud: "wrong" }, { hd: "wrong" }, { email_verified: false }, { email_verified: "true" }, { email: 12 }, { email: "" }, { nonce: "wrong" }, { nonce: undefined }, { exp: 1 }, { exp: undefined }, { sub: undefined }]) {
    await expect(verifyGoogleIdToken(await sign({ ...claims, ...patch }), "client", "example.com", { expectedNonce: "nonce", keyResolver })).rejects.toThrow();
  }
});

// #928 step 3: with the CLI's direct exchange gone, every check is in the exchange and none is optional (D1).
test("Google JWT verification refuses a missing nonce, and an email off the org domain as a DomainRefused", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const keyResolver = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: "test" }] });
  const claims: JWTPayload = { iss: "https://accounts.google.com", aud: "client", sub: "subject", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60,
    hd: "example.com", email: "you@example.com", email_verified: true, nonce: "nonce" };
  const sign = (payload: JWTPayload) => new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid: "test" }).sign(privateKey);
  // No nonce in the token, or none expected: both refused.
  await expect(verifyGoogleIdToken(await sign({ ...claims, nonce: undefined }), "client", "example.com", { expectedNonce: "nonce", keyResolver })).rejects.toThrow("invalid Google nonce");
  await expect(verifyGoogleIdToken(await sign(claims), "client", "example.com", { expectedNonce: "", keyResolver })).rejects.toThrow("invalid Google nonce");
  // The Workspace (`hd`) matches but the address is another domain's: the email is the bus address.
  const offDomain = verifyGoogleIdToken(await sign({ ...claims, email: "you@elsewhere.example" }), "client", "example.com", { expectedNonce: "nonce", keyResolver });
  await expect(offDomain).rejects.toBeInstanceOf(DomainRefused);
  await expect(verifyGoogleIdToken(await sign({ ...claims, email: "you@sub.example.com" }), "client", "example.com", { expectedNonce: "nonce", keyResolver })).rejects.toBeInstanceOf(DomainRefused);
});
