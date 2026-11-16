import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTouchQueue, googleSignIn, hashToken, mintToken, verifySessionToken } from "./auth.ts";
import { accessAudits } from "../../tests/support/audit.ts";
import { openDatabase, type Repo } from "./db.ts";
import { scratchDbPath } from "../../tests/support/scratch_db.ts";

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
  let db: ReturnType<typeof openDatabase>["db"];
  const touches = createTouchQueue();

  beforeEach(() => {
    ({ repo, db } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) }));
  });

  test("valid token returns authed user", () => {
    const u   = repo.users.upsertByEmail("wade@example.com", null);
    const raw = mintToken();
    repo.sessions.create(u.id, hashToken(raw), null);
    const authed = verifySessionToken(raw, repo, touches, 0);
    expect(authed).not.toBeNull();
    expect(authed!.user_email).toBe("wade@example.com");
  });

  // Security audit F-14: idle, not age. A token used within the window keeps
  // working however old it is; one unused for longer is refused; 0 never expires.
  test("a token unused longer than idleDays is refused; use keeps it alive", () => {
    const u   = repo.users.upsertByEmail("wade@example.com", null);
    const raw = mintToken();
    const s   = repo.sessions.create(u.id, hashToken(raw), null);
    const day = 86_400_000;
    const idle = (days: number) => repo.sessions.touch(s.id, repo.now() - days * day);
    idle(29);
    expect(verifySessionToken(raw, repo, touches, 30)).not.toBeNull();
    idle(31);
    expect(verifySessionToken(raw, repo, touches, 30)).toBeNull();
    expect(verifySessionToken(raw, repo, touches, 0)).not.toBeNull();
    // Age doesn't count: a year-old token used yesterday works.
    db.run("UPDATE sessions SET created_at = ? WHERE id = ?", [repo.now() - 365 * day, s.id]);
    repo.sessions.touch(s.id, repo.now() - day);
    expect(verifySessionToken(raw, repo, touches, 30)).not.toBeNull();
  });

  test("missing token returns null", () => {
    expect(verifySessionToken("gbrd_v1_nonexistent", repo, touches, 0)).toBeNull();
  });

  test("revoked token returns null", () => {
    const u   = repo.users.upsertByEmail("wade@example.com", null);
    const raw = mintToken();
    const s   = repo.sessions.create(u.id, hashToken(raw), null);
    repo.sessions.revoke(s.id);
    expect(verifySessionToken(raw, repo, touches, 0)).toBeNull();
  });

  test("disabled user returns null", () => {
    const u   = repo.users.upsertByEmail("wade@example.com", null);
    const raw = mintToken();
    repo.sessions.create(u.id, hashToken(raw), null);
    repo.users.setDisabled(u.id, true);
    expect(verifySessionToken(raw, repo, touches, 0)).toBeNull();
  });

  // Security audit F-14: disable revokes the token, so enable doesn't revive it.
  test("re-enabled user's old token stays revoked; a new one works", () => {
    const u   = repo.users.upsertByEmail("wade@example.com", null);
    const raw = mintToken();
    repo.sessions.create(u.id, hashToken(raw), null);
    repo.users.setDisabled(u.id, true);
    repo.users.setDisabled(u.id, false);
    expect(verifySessionToken(raw, repo, touches, 0)).toBeNull();
    const fresh = mintToken();
    repo.sessions.create(u.id, hashToken(fresh), null);
    expect(verifySessionToken(fresh, repo, touches, 0)).not.toBeNull();
  });
});

// Security audit F-13: each refusal says what the admin runs, and audits why.
test("googleSignIn refuses a reassigned or changed email with the admin's fix, and audits each outcome", () => {
  const { db, repo } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
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
