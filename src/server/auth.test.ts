import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTouchQueue, hashToken, mintToken, verifySessionToken } from "./auth.ts";
import { openDatabase, type Repo } from "./db.ts";
import { scratchDbPath } from "../../tests/support/scratch_db.ts";
import { seed } from "../../tests/support/seed.ts";

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

  test("valid token returns authed user", async () => {
    const raw = mintToken();
    await seed(repo, async tx => {
      const u = await repo.users.upsertByEmail(tx, "wade@example.com", null);
      await repo.sessions.create(tx, u.id, hashToken(raw), null);
    });
    const authed = await verifySessionToken(raw, repo, touches, 0);
    expect(authed).not.toBeNull();
    expect(authed!.user_email).toBe("wade@example.com");
  });

  // Security audit F-14: idle, not age. A token used within the window keeps
  // working however old it is; one unused for longer is refused; 0 never expires.
  test("a token unused longer than idleDays is refused; use keeps it alive", async () => {
    const raw = mintToken();
    const s   = await seed(repo, async tx => repo.sessions.create(tx, (await repo.users.upsertByEmail(tx, "wade@example.com", null)).id, hashToken(raw), null));
    const day = 86_400_000;
    const idle = (days: number) => seed(repo, tx => repo.sessions.touch(tx, s.id, repo.now() - days * day));
    await idle(29);
    expect(await verifySessionToken(raw, repo, touches, 30)).not.toBeNull();
    await idle(31);
    expect(await verifySessionToken(raw, repo, touches, 30)).toBeNull();
    expect(await verifySessionToken(raw, repo, touches, 0)).not.toBeNull();
    // Age doesn't count: a year-old token used yesterday works.
    await seed(repo, async tx => {
      db.run("UPDATE sessions SET created_at = ? WHERE id = ?", [repo.now() - 365 * day, s.id]);
      await repo.sessions.touch(tx, s.id, repo.now() - day);
    });
    expect(await verifySessionToken(raw, repo, touches, 30)).not.toBeNull();
  });

  test("missing token returns null", async () => {
    expect(await verifySessionToken("gbrd_v1_nonexistent", repo, touches, 0)).toBeNull();
  });

  test("revoked token returns null", async () => {
    const raw = mintToken();
    await seed(repo, async tx => {
      const u = await repo.users.upsertByEmail(tx, "wade@example.com", null);
      const s = await repo.sessions.create(tx, u.id, hashToken(raw), null);
      await repo.sessions.revoke(tx, s.id);
    });
    expect(await verifySessionToken(raw, repo, touches, 0)).toBeNull();
  });

  test("disabled user returns null", async () => {
    const raw = mintToken();
    await seed(repo, async tx => {
      const u = await repo.users.upsertByEmail(tx, "wade@example.com", null);
      await repo.sessions.create(tx, u.id, hashToken(raw), null);
      await repo.users.setDisabled(tx, u.id, true);
    });
    expect(await verifySessionToken(raw, repo, touches, 0)).toBeNull();
  });

  // Security audit F-14: disable revokes the token, so enable doesn't revive it.
  test("re-enabled user's old token stays revoked; a new one works", async () => {
    const raw = mintToken();
    const u = await seed(repo, async tx => {
      const u = await repo.users.upsertByEmail(tx, "wade@example.com", null);
      await repo.sessions.create(tx, u.id, hashToken(raw), null);
      await repo.users.setDisabled(tx, u.id, true);
      await repo.users.setDisabled(tx, u.id, false);
      return u;
    });
    expect(await verifySessionToken(raw, repo, touches, 0)).toBeNull();
    const fresh = mintToken();
    await seed(repo, tx => repo.sessions.create(tx, u.id, hashToken(fresh), null));
    expect(await verifySessionToken(fresh, repo, touches, 0)).not.toBeNull();
  });
});
