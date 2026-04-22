import { describe, test, expect, beforeEach } from "bun:test";
import { Glob } from "bun";
import { openDatabase, type Repo } from "./db.ts";

// ── repository isolation ───────────────────────────────────────────────────────

test("bun:sqlite is only imported from src/server/db.ts", async () => {
  const offenders: string[] = [];
  const glob = new Glob("src/**/*.ts");
  // Match the import statement, not just the string (test files may reference it in assertions)
  const importPattern = /from\s+["']bun:sqlite["']/;
  for await (const file of glob.scan(".")) {
    if (file === "src/server/db.ts") continue;
    if (file.endsWith(".test.ts")) continue;
    const text = await Bun.file(file).text();
    if (importPattern.test(text)) offenders.push(file);
  }
  expect(offenders).toEqual([]);
});

// ── basic CRUD ────────────────────────────────────────────────────────────────

describe("Repo", () => {
  let repo: Repo;

  beforeEach(() => {
    // Use an in-memory DB for each test
    const { repo: r } = openDatabase(":memory:");
    repo = r;
  });

  test("upsertByEmail creates user on first call", () => {
    const u = repo.users.upsertByEmail("wade@example.com", "Wade");
    expect(u.email).toBe("wade@example.com");
    expect(u.display_name).toBe("Wade");
    expect(u.disabled_at).toBeNull();
  });

  test("upsertByEmail updates display_name on collision", () => {
    repo.users.upsertByEmail("wade@example.com", "Wade");
    const u = repo.users.upsertByEmail("wade@example.com", "Wade B");
    expect(u.display_name).toBe("Wade B");
  });

  test("sessions: create, findByTokenHash, revoke", () => {
    const u   = repo.users.upsertByEmail("wade@example.com", null);
    const s   = repo.sessions.create(u.id, "hash123", "test");
    const found = repo.sessions.findByTokenHash("hash123");
    expect(found?.id).toBe(s.id);
    repo.sessions.revoke(s.id);
    expect(repo.sessions.findByTokenHash("hash123")).toBeUndefined();
  });

  test("identities: create, list, remove", () => {
    const u  = repo.users.upsertByEmail("wade@example.com", null);
    repo.identities.create(u.id, "fe");
    repo.identities.create(u.id, "be");
    expect(repo.identities.listForUser(u.id)).toHaveLength(2);
    repo.identities.remove(u.id, "fe");
    expect(repo.identities.listForUser(u.id)).toHaveLength(1);
  });

  test("teams: create, join, leave, list members", () => {
    const u1 = repo.users.upsertByEmail("a@example.com", null);
    const u2 = repo.users.upsertByEmail("b@example.com", null);
    const t  = repo.teams.create("eng", u1.id);
    repo.teams.addMember(t.id, u1.id);
    repo.teams.addMember(t.id, u2.id);
    expect(repo.teams.listMembers(t.id)).toHaveLength(2);
    repo.teams.removeMember(t.id, u2.id);
    expect(repo.teams.listMembers(t.id)).toHaveLength(1);
  });

  test("messages: insert and thread", () => {
    const root  = repo.messages.insert("a@example.com/fe", "user", "b@example.com/be", "hello", null);
    const reply = repo.messages.insert("b@example.com/be", "user", "a@example.com/fe", "hi",    root.id);
    const thread = repo.messages.thread(root.id);
    expect(thread).toHaveLength(2);
    expect(thread[0].id).toBe(root.id);
    expect(thread[1].id).toBe(reply.id);
  });

  test("cursors: advance is idempotent and takes MAX", () => {
    const u = repo.users.upsertByEmail("wade@example.com", null);
    const i = repo.identities.create(u.id, "fe");
    repo.cursors.advance(i.id, "direct", "wade@example.com/fe", 10);
    repo.cursors.advance(i.id, "direct", "wade@example.com/fe", 5);  // lower — should not regress
    expect(repo.cursors.get(i.id, "direct", "wade@example.com/fe")).toBe(10);
    repo.cursors.advance(i.id, "direct", "wade@example.com/fe", 20);
    expect(repo.cursors.get(i.id, "direct", "wade@example.com/fe")).toBe(20);
  });

  test("unreadSince returns only messages after cursor", () => {
    const m1 = repo.messages.insert("a@example.com/fe", "user", "b@example.com/be", "msg1", null);
    const m2 = repo.messages.insert("a@example.com/fe", "user", "b@example.com/be", "msg2", null);
    const unread = repo.messages.unreadSince([{ type: "direct", ref: "b@example.com/be", since: m1.id }]);
    expect(unread).toHaveLength(1);
    expect(unread[0].id).toBe(m2.id);
  });

  test("audit.write and prune", () => {
    const oldTs = Date.now() - 100;
    repo.audit.write({ at: oldTs, actor: "wade@example.com", action: "auth.login", target: null, detail: null });
    repo.audit.prune(Date.now()); // prune everything older than now
    // No assertion on rows (no SELECT on audit in Repo) but prune should not throw
  });
});
