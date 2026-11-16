import { expect, test } from "bun:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
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
  // Existing CLI calls do not supply a nonce; AS calls always do.
  expect((await verifyGoogleIdToken(await sign({ ...claims, nonce: undefined }), "client", "example.com", { keyResolver })).email).toBe("you@example.com");
});
