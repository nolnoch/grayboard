import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
import { openDatabase, PrincipalTaken, QUEUED_TO_SQL, RETRACTABLE_SQL, UNDELIVERED_FROM_SQL, type Repo } from "./db.ts";

const person = (email: string, name: string) => ({ scope_kind: "person" as const, scope_ref: email, name });

// ── repository isolation ───────────────────────────────────────────────────────

test("bun:sqlite is only imported from src/server/db.ts (within the v1 server tree)", async () => {
  // src/local/ is the sanctioned same-machine mode (v0 preserved); it owns its own
  // SQLite layer by design. The migration seam this test guards is the v1 backend —
  // src/server, src/plugin, src/shared, src/cli — so src/local is excluded.
  // src/core/ (boards + claims, shared by both modes) takes a Database handle and
  // is part of the seam: a Postgres port reimplements it alongside db.ts.
  // src/bridge/ keeps a client-side file of its own (the Slack bridge's thread
  // map and outbox), never a backend store, so it's excluded like src/local.
  const offenders: string[] = [];
  const glob = new Glob("src/**/*.ts");
  const importPattern = /from\s+["']bun:sqlite["']/;
  for await (const file of glob.scan(".")) {
    if (file === "src/server/db.ts") continue;
    if (file.startsWith("src/local/")) continue;
    if (file.startsWith("src/core/")) continue;
    if (file.startsWith("src/bridge/")) continue;
    if (file.endsWith(".test.ts")) continue;
    const text = await Bun.file(file).text();
    if (importPattern.test(text)) offenders.push(file);
  }
  expect(offenders).toEqual([]);
});

test("an existing pre-OAuth database opens additively without losing old data", () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-old-db-"));
  const path = join(dir, "db.sqlite");
  const opts = { blobDir: join(dir, "blobs") };
  const old = openDatabase(path, opts);
  const user = old.repo.users.upsertByEmail("you@example.com", "You");
  const session = old.repo.sessions.create(user.id, "old-session-hash", "old client");
  old.repo.aliases.create({ scope_kind: "person", scope_ref: user.email, name: "fe" }, user.email);
  old.repo.messages.insert("you@example.com/fe", "user", "peer@example.com/be", "preserved", null);
  for (const table of ["oauth_tokens", "oauth_grants", "oauth_codes", "oauth_browsers", "oauth_requests"]) old.db.exec(`DROP TABLE ${table}`);
  old.db.close();
  const reopened = openDatabase(path, opts);
  try {
    expect(reopened.repo.users.findById(user.id)?.display_name).toBe("You");
    expect(reopened.repo.sessions.findByTokenHash("old-session-hash")?.id).toBe(session.id);
    expect(reopened.repo.aliases.listForScope("person", user.email).map(i => i.name)).toEqual(["fe"]);
    expect(reopened.repo.messages.history(["you@example.com/fe"])[0]?.body).toBe("preserved");
    expect(reopened.repo.oauth.isGrantActive("missing", Date.now())).toBe(false);
    expect(reopened.db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'oauth_%'").all()).toHaveLength(5);
  } finally {
    reopened.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── basic CRUD ────────────────────────────────────────────────────────────────

// auto_vacuum applies only before the file's first page is written (#170).
test("a new database file gets auto_vacuum=INCREMENTAL", () => {
  const { db } = openDatabase(join(mkdtempSync(join(tmpdir(), "gb-db-")), "bus.db"), { blobDir: join(tmpdir(), "gb-db-blobs") });
  expect(db.prepare("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 2 });
  expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
  db.close();
});

describe("Repo", () => {
  let repo: Repo;

  beforeEach(() => {
    // Use an in-memory DB for each test
    const { repo: r } = openDatabase(":memory:", { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
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
    // By row, a revoked one still reads, with its revoked_at.
    expect(repo.sessions.findById(s.id)?.revoked_at).not.toBeNull();
    expect(repo.sessions.findById(s.id + 100)).toBeUndefined();
  });

  test("aliases: create, list, remove", () => {
    repo.users.upsertByEmail("you@example.com", null);
    expect(repo.aliases.create(person("you@example.com", "fe"), "you@example.com").address).toBe("you@example.com/fe");
    repo.aliases.create(person("you@example.com", "be"), "you@example.com");
    expect(repo.aliases.listForScope("person", "you@example.com").map((a) => a.name)).toEqual(["be", "fe"]);
    repo.cursors.advance("you@example.com/fe", "direct", "you@example.com/fe", 7);
    repo.aliases.remove("you@example.com/fe");
    expect(repo.aliases.listForScope("person", "you@example.com")).toHaveLength(1);
    // Its read point goes with it: a new alias of the name starts from scratch.
    expect(repo.cursors.directFor("you@example.com/fe")).toBe(0);
  });

  // #284 S9: aliases are keyed by address in any scope.
  test("aliases: a team scope's alias is its own address, listed under its scope", () => {
    const u = repo.users.upsertByEmail("you@example.com", null);
    repo.teams.create("eng", u.id);
    repo.aliases.create(person("you@example.com", "be"), "you@example.com");
    const team = repo.aliases.create({ scope_kind: "team", scope_ref: "eng", name: "be" }, "you@example.com");
    expect(team).toMatchObject({ address: "eng/be", scope_kind: "team", scope_ref: "eng", name: "be" });
    expect(repo.aliases.find("eng/be")?.id).toBe(team.id);
    expect(repo.aliases.find("eng/fe")).toBeUndefined();
    expect(repo.aliases.listForScope("team", "eng").map((a) => a.address)).toEqual(["eng/be"]);
    expect(repo.aliases.listForScope("person", "you@example.com").map((a) => a.address)).toEqual(["you@example.com/be"]);
    expect(repo.aliases.listForScope("person", "eng")).toEqual([]);
    expect(repo.aliases.findAllByName("be").map((a) => a.address)).toEqual(["eng/be", "you@example.com/be"]);
  });

  test("principals: findByName reads users and teams", () => {
    const u = repo.users.upsertByEmail("you@example.com", null);
    const eng = repo.teams.create("eng", u.id);
    expect(repo.principals.findByName("you@example.com")).toMatchObject({ kind: "user", user_id: u.id, team_id: null });
    expect(repo.principals.findByName("eng")).toMatchObject({ kind: "team", user_id: null, team_id: eng.id });
    expect(repo.principals.findByName("ops")).toBeUndefined();
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
    expect(repo.messages.thread(reply.id).map(m => m.id)).toEqual([root.id, reply.id]);
  });

  test("cursors: advance is idempotent and takes MAX", () => {
    repo.cursors.advance("you@example.com/fe", "direct", "you@example.com/fe", 10);
    repo.cursors.advance("you@example.com/fe", "direct", "you@example.com/fe", 5);  // lower — should not regress
    expect(repo.cursors.get("you@example.com/fe", "direct", "you@example.com/fe")).toBe(10);
    repo.cursors.advance("you@example.com/fe", "direct", "you@example.com/fe", 20);
    expect(repo.cursors.directFor("you@example.com/fe")).toBe(20);
  });

  test("unreadSince returns only messages after cursor", () => {
    const m1 = repo.messages.insert("a@example.com/fe", "user", "b@example.com/be", "msg1", null);
    const m2 = repo.messages.insert("a@example.com/fe", "user", "b@example.com/be", "msg2", null);
    const unread = repo.messages.unreadSince([{ type: "direct", ref: "b@example.com/be", since: m1.id }]);
    expect(unread).toHaveLength(1);
    expect(unread[0].id).toBe(m2.id);
  });

  // #284 S8: a session reads as every address it has, its ID and its alias.
  test("history, undeliveredFrom, receivedUnacked and sentPending take an address set", () => {
    const [id, alias, peer, other] = ["id:s1", "a@example.com/fe", "b@example.com/be", "c@example.com/qa"];
    const toId = repo.messages.insert(peer, "user", id, "to the id", null);
    const fromAlias = repo.messages.insert(alias, "user", peer, "from the alias", null, true);
    const toAlias = repo.messages.insert(peer, "user", alias, "to the alias", null);
    const fromId = repo.messages.insert(id, "user", other, "from the id", null, true);
    repo.messages.insert(peer, "user", other, "not ours", null);
    const set = [id, alias];
    const ids = (rows: { id: number }[]) => rows.map((m) => m.id);

    expect(ids(repo.messages.history(set))).toEqual([fromId.id, toAlias.id, fromAlias.id, toId.id]);
    expect(ids(repo.messages.history(set, peer))).toEqual([toAlias.id, fromAlias.id, toId.id]);
    expect(ids(repo.messages.history(set, peer, 20, toAlias.id))).toEqual([fromAlias.id, toId.id]);
    expect(ids(repo.messages.history([alias]))).toEqual([toAlias.id, fromAlias.id]);

    expect(repo.messages.undeliveredFrom(set)).toEqual([
      { recipient: peer, n: 1, oldest_id: fromAlias.id },
      { recipient: other, n: 1, oldest_id: fromId.id },
    ]);
    expect(ids(repo.messages.receivedUnacked(set, 0))).toEqual([toId.id, toAlias.id]);
    expect(ids(repo.messages.sentPending(set, 0))).toEqual([fromAlias.id, fromId.id]);
    // An ack counts for the address the row names, not any address of the set.
    repo.messages.ack(alias, toId.id);
    expect(ids(repo.messages.receivedUnacked(set, 0))).toEqual([toId.id, toAlias.id]);
    repo.messages.ack(id, toId.id);
    repo.messages.ack(id, fromId.id);
    expect(ids(repo.messages.receivedUnacked(set, 0))).toEqual([toAlias.id]);
    expect(ids(repo.messages.sentPending(set, 0))).toEqual([fromAlias.id]);
  });

  // #284 S5: the MailPort core endSession runs on the server.
  test("mail: unread is the ID's unread direct mail from others; bounce and dropReader", () => {
    const [id, peer] = ["id:s1", "b@example.com/be"];
    const read = repo.messages.insert(peer, "user", id, "read", null);
    const unread = repo.messages.insert(peer, "user", id, "unread", null);
    repo.messages.insert(id, "user", id, "to itself", null);
    repo.messages.insert(peer, "team", id, "a team stream of the same name", null);
    repo.messages.insert(peer, "user", "a@example.com/fe", "to someone else", null);
    repo.cursors.advance(id, "direct", id, read.id);
    expect(repo.mail.unread(id)).toEqual([{ id: unread.id, sender: peer }]);

    repo.mail.bounce(id, peer, unread.id, "returned", 1234);
    const [bounce] = repo.messages.history([peer]).filter((m) => m.kind === "bounce");
    expect(bounce).toMatchObject({ sender: id, recipient_type: "user", recipient: peer, body: "returned", parent_id: unread.id, created_at: 1234, pending: 0, kind: "bounce" });
    expect(repo.messages.getById(unread.id)?.kind).toBeNull();

    repo.messages.ack(id, unread.id);
    repo.messages.ack(peer, bounce!.id);
    repo.mail.dropReader(id);
    expect(repo.cursors.directFor(id)).toBe(0);
    expect(repo.messages.receivedUnacked([id], 0).map((m) => m.id)).toEqual([read.id, unread.id]);
    expect(repo.messages.receivedUnacked([peer], 0)).toEqual([]);
  });

  test("audit.write and prune", () => {
    const oldTs = Date.now() - 100;
    repo.audit.write({ at: oldTs, actor: "wade@example.com", action: "auth.login", target: null, detail: null });
    repo.audit.prune(Date.now()); // prune everything older than now
    // No assertion on rows (no SELECT on audit in Repo) but prune should not throw
  });
});

// #284 decision 5: users, teams and service principals share one namespace.
test("principals: a sign-in and a team create insert one; a team can't take another principal's name", () => {
  const { db, repo } = openDatabase(":memory:", { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  const u = repo.users.upsertByEmail("a@example.com", null);
  repo.users.upsertByEmail("a@example.com", "A");
  const eng = repo.teams.create("eng", u.id);
  // Service principals arrive with #270; the namespace guard is here now.
  db.prepare(`INSERT INTO principals (kind, name, created_at) VALUES ('service', 'ingest', 0)`).run();
  expect(() => repo.teams.create("ingest", u.id)).toThrow(PrincipalTaken);
  expect(repo.teams.findByName("ingest")).toBeUndefined();
  expect(db.prepare(`SELECT kind, name, user_id, team_id FROM principals ORDER BY id`).all()).toEqual([
    { kind: "user", name: "a@example.com", user_id: u.id, team_id: null },
    { kind: "team", name: "eng", user_id: null, team_id: eng.id },
    { kind: "service", name: "ingest", user_id: null, team_id: null },
  ]);
});

// ── #130: the undeliveredFrom plan ────────────────────────────────────────────

test("undeliveredFrom looks each read point up by its key, never a mailbox_cursors scan", () => {
  const { db, repo } = openDatabase(":memory:", { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  repo.users.upsertByEmail("a@example.com", null);
  repo.aliases.create(person("a@example.com", "fe"), "a@example.com");
  repo.users.upsertByEmail("b@example.com", null);
  repo.aliases.create(person("b@example.com", "be"), "b@example.com");
  repo.messages.insert("a@example.com/fe", "user", "b@example.com/be", "hello", null);
  repo.cursors.advance("b@example.com/be", "direct", "b@example.com/be", 1);
  const plan = db.prepare("EXPLAIN QUERY PLAN " + UNDELIVERED_FROM_SQL)
    .all(JSON.stringify(["a@example.com/fe"]), Number.MAX_SAFE_INTEGER) as { detail: string }[];
  const detail = plan.map(p => p.detail).join(" ");
  expect(detail).toContain("SEARCH c USING INDEX sqlite_autoindex_mailbox_cursors_1");
  expect(detail).not.toContain("SCAN c");
});

// #284 audit: queuedTo and retract read the read point by its key too.
test("queuedTo and retract look the read point up by its key, never a mailbox_cursors scan", () => {
  const { db, repo } = openDatabase(":memory:", { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  repo.users.upsertByEmail("a@example.com", null);
  repo.aliases.create(person("a@example.com", "fe"), "a@example.com");
  repo.users.upsertByEmail("b@example.com", null);
  repo.aliases.create(person("b@example.com", "be"), "b@example.com");
  repo.messages.insert("a@example.com/fe", "user", "b@example.com/be", "hello", null);
  repo.cursors.advance("b@example.com/be", "direct", "b@example.com/be", 1);
  const detail = (sql: string, ...args: (string | number)[]) =>
    (db.prepare("EXPLAIN QUERY PLAN " + sql).all(...args) as { detail: string }[]).map((p) => p.detail).join(" ");
  const queued = detail(QUEUED_TO_SQL, JSON.stringify(["b@example.com/be"]));
  expect(queued).toContain("SEARCH c USING INDEX sqlite_autoindex_mailbox_cursors_1");
  expect(queued).not.toContain("SCAN c");
  const retract = detail(RETRACTABLE_SQL, 1, "a@example.com/fe");
  expect(retract).toContain("SEARCH mailbox_cursors USING INDEX sqlite_autoindex_mailbox_cursors_1");
  expect(retract).not.toContain("SCAN mailbox_cursors");
});
