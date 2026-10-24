import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashToken, mintToken, verifySessionToken, verifyGoogleIdToken } from "./auth.ts";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { openDatabase, type Repo } from "./db.ts";

test("Google JWT verification preserves issuer/audience/domain and requires verified typed email and bound nonce", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const keyResolver = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: "test" }] });
  const claims: JWTPayload = { iss: "https://accounts.google.com", aud: "client", sub: "subject", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60,
    hd: "example.com", email: "YOU@example.com", email_verified: true, nonce: "nonce", name: "You" };
  const sign = (payload: JWTPayload) => new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid: "test" }).sign(privateKey);
  expect(await verifyGoogleIdToken(await sign(claims), "client", "example.com", { expectedNonce: "nonce", keyResolver })).toEqual({ email: "you@example.com", displayName: "You" });
  for (const patch of [{ iss: "https://evil.example" }, { aud: "wrong" }, { hd: "wrong" }, { email_verified: false }, { email_verified: "true" }, { email: 12 }, { email: "" }, { nonce: "wrong" }, { nonce: undefined }, { exp: 1 }, { exp: undefined }, { sub: undefined }]) {
    await expect(verifyGoogleIdToken(await sign({ ...claims, ...patch }), "client", "example.com", { expectedNonce: "nonce", keyResolver })).rejects.toThrow();
  }
  // Existing CLI calls do not supply a nonce; AS calls always do.
  expect((await verifyGoogleIdToken(await sign({ ...claims, nonce: undefined }), "client", "example.com", { keyResolver })).email).toBe("you@example.com");
});

describe("token helpers", () => {
  test("mintToken has gbrd_v1_ prefix", () => {
    expect(mintToken()).toMatch(/^gbrd_v1_/);
  });

  test("mintToken is unique", () => {
    expect(mintToken()).not.toBe(mintToken());
  });

  test("hashToken is deterministic", () => {
    const raw = "gbrd_v1_test";
    expect(hashToken(raw)).toBe(hashToken(raw));
  });

  test("hashToken different inputs produce different outputs", () => {
    expect(hashToken("a")).not.toBe(hashToken("b"));
  });
});

describe("verifySessionToken", () => {
  let repo: Repo;

  beforeEach(() => {
    const { repo: r } = openDatabase(":memory:", { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
    repo = r;
  });

  test("valid token returns authed user", () => {
    const u   = repo.users.upsertByEmail("wade@example.com", null);
    const raw = mintToken();
    repo.sessions.create(u.id, hashToken(raw), null);
    const authed = verifySessionToken(raw, repo);
    expect(authed).not.toBeNull();
    expect(authed!.user_email).toBe("wade@example.com");
  });

  test("missing token returns null", () => {
    expect(verifySessionToken("gbrd_v1_nonexistent", repo)).toBeNull();
  });

  test("revoked token returns null", () => {
    const u   = repo.users.upsertByEmail("wade@example.com", null);
    const raw = mintToken();
    const s   = repo.sessions.create(u.id, hashToken(raw), null);
    repo.sessions.revoke(s.id);
    expect(verifySessionToken(raw, repo)).toBeNull();
  });

  test("disabled user returns null", () => {
    const u   = repo.users.upsertByEmail("wade@example.com", null);
    const raw = mintToken();
    repo.sessions.create(u.id, hashToken(raw), null);
    repo.users.setDisabled(u.id, true);
    expect(verifySessionToken(raw, repo)).toBeNull();
  });

  test("re-enabled user returns authed user", () => {
    const u   = repo.users.upsertByEmail("wade@example.com", null);
    const raw = mintToken();
    repo.sessions.create(u.id, hashToken(raw), null);
    repo.users.setDisabled(u.id, true);
    repo.users.setDisabled(u.id, false);
    expect(verifySessionToken(raw, repo)).not.toBeNull();
  });
});
