import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTouchQueue, googleSignIn, hashToken, mintToken, verifySessionToken, verifyGoogleIdToken } from "./auth.ts";
import { accessAudits } from "../../tests/support/audit.ts";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { openDatabase, type Repo } from "./db.ts";

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

test("a touch scheduled after cancelAll never runs: stop() closed the queue (#385)", async () => {
  const touches = createTouchQueue();
  const ran: string[] = [];
  touches.schedule(() => ran.push("before"));
  touches.cancelAll();
  touches.schedule(() => ran.push("after"));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  expect(ran).toEqual([]);
});

describe("verifySessionToken", () => {
  let repo: Repo;
  const touches = createTouchQueue();

  beforeEach(() => {
    const { repo: r } = openDatabase(":memory:", { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
    repo = r;
  });

  test("valid token returns authed user", () => {
    const u   = repo.users.upsertByEmail("wade@example.com", null);
    const raw = mintToken();
    repo.sessions.create(u.id, hashToken(raw), null);
    const authed = verifySessionToken(raw, repo, touches);
    expect(authed).not.toBeNull();
    expect(authed!.user_email).toBe("wade@example.com");
  });

  test("missing token returns null", () => {
    expect(verifySessionToken("gbrd_v1_nonexistent", repo, touches)).toBeNull();
  });

  test("revoked token returns null", () => {
    const u   = repo.users.upsertByEmail("wade@example.com", null);
    const raw = mintToken();
    const s   = repo.sessions.create(u.id, hashToken(raw), null);
    repo.sessions.revoke(s.id);
    expect(verifySessionToken(raw, repo, touches)).toBeNull();
  });

  test("disabled user returns null", () => {
    const u   = repo.users.upsertByEmail("wade@example.com", null);
    const raw = mintToken();
    repo.sessions.create(u.id, hashToken(raw), null);
    repo.users.setDisabled(u.id, true);
    expect(verifySessionToken(raw, repo, touches)).toBeNull();
  });

  test("re-enabled user returns authed user", () => {
    const u   = repo.users.upsertByEmail("wade@example.com", null);
    const raw = mintToken();
    repo.sessions.create(u.id, hashToken(raw), null);
    repo.users.setDisabled(u.id, true);
    repo.users.setDisabled(u.id, false);
    expect(verifySessionToken(raw, repo, touches)).not.toBeNull();
  });
});

// Security audit F-13: each refusal says what the admin runs, and audits why.
test("googleSignIn refuses a reassigned or changed email with the admin's fix, and audits each outcome", () => {
  const { db, repo } = openDatabase(":memory:", { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  repo.users.upsertByEmail("old@example.com", null);
  expect(googleSignIn(repo, { email: "old@example.com", subject: "s-old", displayName: null }, { ip: "1.2.3.4" })).toMatchObject({ user: { email: "old@example.com" } });
  expect(accessAudits(db, "auth.subject_linked").map(r => [r.actor, r.detail])).toEqual([["old@example.com", { ip: "1.2.3.4" }]]);

  const mismatch = googleSignIn(repo, { email: "old@example.com", subject: "s-hire", displayName: null }, { ip: "1.2.3.4" });
  expect(mismatch).toEqual({ refused: expect.stringContaining("unlink-idp --email old@example.com") });
  const changed = googleSignIn(repo, { email: "new@example.com", subject: "s-old", displayName: null }, { ip: "1.2.3.4" });
  expect(changed).toEqual({ refused: expect.stringContaining("belongs to grayboard user old@example.com but now reports new@example.com") });
  expect(accessAudits(db, "auth.subject_refused").map(r => [r.actor, r.detail])).toEqual([
    ["old@example.com", { reason: "subject_mismatch", ip: "1.2.3.4" }],
    ["old@example.com", { reason: "email_changed", email: "new@example.com", ip: "1.2.3.4" }],
  ]);
});
