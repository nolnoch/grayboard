import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authLost, createTouchQueue, hashToken, mintToken, verifySessionToken } from "./auth.ts";
import { openDatabase, type Repo } from "./db.ts";

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

  // #351: why a connection's token stopped authenticating.
  test("authLost names why a token stopped authenticating, and clears with a re-enable", () => {
    const u = repo.users.upsertByEmail("wade@example.com", null);
    const s = repo.sessions.create(u.id, hashToken(mintToken()), null);
    const authed = { user_id: u.id, user_email: u.email, session_id: s.id };
    expect(authLost(authed, repo)).toBeNull();
    repo.users.setDisabled(u.id, true);
    expect(authLost(authed, repo)).toBe("user_disabled");
    repo.users.setDisabled(u.id, false);
    expect(authLost(authed, repo)).toBeNull();
    repo.sessions.revoke(s.id);
    expect(authLost(authed, repo)).toBe("token_revoked");
    expect(authLost({ ...authed, session_id: 0 }, repo)).toBe("token_revoked");
  });
});
