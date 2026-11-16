import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
import { ACCESS_LOG_LAST_SQL, openDatabase, PrincipalTaken, QUEUED_TO_SQL, RETRACTABLE_SQL, SENT_PENDING_SQL, UNDELIVERED_FROM_SQL, type Repo } from "./db.ts";
import { scratchDbPath } from "../../tests/support/scratch_db.ts";
import { seed } from "../../tests/support/seed.ts";
import { GOOGLE_ISSUER } from "./idp_google.ts";

const person = (email: string, name: string) => ({ scope_kind: "person" as const, scope_ref: email, name });

// ── repository isolation ───────────────────────────────────────────────────────

test("bun:sqlite is only imported from src/server/db.ts (within the v1 server tree)", async () => {
  // src/local/ is the sanctioned same-machine mode (v0 preserved); it owns its own
  // SQLite layer by design. The migration seam this test guards is the v1 backend —
  // src/server, src/shared, src/cli — so src/local is excluded.
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

test("#807 P1b-3: the server reads on its read-only connection outside a transaction and on the writer inside one", () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-reader-"));
  const { db, repo } = openDatabase(join(dir, "db.sqlite"), { blobDir: join(dir, "blobs") });
  const on: Database[] = [];
  const query = Database.prototype.query;
  const spy = spyOn(Database.prototype, "query").mockImplementation(function (this: Database, sql: string) {
    if (sql === "SELECT 7 AS n") on.push(this);
    return query.call(this, sql);
  } as typeof query);
  try {
    expect(db.prepare<{ n: number }, []>("SELECT 7 AS n").get()?.n).toBe(7);
    repo.atomic(() => db.prepare<{ n: number }, []>("SELECT 7 AS n").get());
    expect(on.length).toBe(2);
    expect(on[0]).not.toBe(db);
    expect(on[1]).toBe(db);
  } finally { spy.mockRestore(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("an existing pre-OAuth database opens additively without losing old data", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-old-db-"));
  const path = join(dir, "db.sqlite");
  const opts = { blobDir: join(dir, "blobs") };
  const old = openDatabase(path, opts);
  const { user, session } = await seed(old.repo, () => {
    const user = old.repo.users.upsertByEmail("you@example.com", "You");
    const session = old.repo.sessions.create(user.id, "old-session-hash", "old client");
    old.repo.aliases.create({ scope_kind: "person", scope_ref: user.email, name: "fe" }, user.email);
    old.repo.messages.insert("you@example.com/fe", "user", "peer@example.com/be", "preserved", null);
    for (const table of ["oauth_tokens", "oauth_grants", "oauth_codes", "oauth_browsers", "oauth_requests"]) old.db.exec(`DROP TABLE ${table}`);
    return { user, session };
  });
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

// #523 audit 5: a hosted child registered before ids.root_id existed (or by an
// older release sharing the file) gets its root from its live source row when
// the file opens; a child whose source row is already gone, and a root, stay null.
test("opening a database from before ids.root_id backfills each live hosted child's root", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-root-db-"));
  const path = join(dir, "db.sqlite");
  const opts = { blobDir: join(dir, "blobs") };
  const old = openDatabase(path, opts);
  const now = Date.now();
  const [root, child, gone] = ["id:r000000000000", "id:c000000000000", "id:g000000000000"];
  await seed(old.repo, () => {
    const user = old.repo.users.upsertByEmail("you@example.com", null);
    for (const id of [root, child, gone]) old.db.prepare(`INSERT INTO ids (id, principal, started_at, last_seen) VALUES (?, ?, ?, ?)`).run(id, user.email, now, now);
    const ownership = old.db.prepare(`INSERT INTO hosted_ownerships (session_id, user_id, client_id, started_at) VALUES (?, ?, ?, ?) RETURNING id`).get(root, user.id, "grayboard-pi", now) as { id: number };
    const row = old.db.prepare(`INSERT INTO hosted_sessions (session_id, ownership_id, user_id, client_id, grant_id, source_session_id, root_session_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    row.run(root, ownership.id, user.id, "grayboard-pi", "G1", "root-run", null, now, now);
    row.run(child, ownership.id, user.id, "grayboard-pi", "G1", "child-run", root, now, now);
    old.db.exec(`DROP INDEX idx_ids_root; ALTER TABLE ids DROP COLUMN root_id`);
  });
  old.db.close();
  const reopened = openDatabase(path, opts);
  try {
    expect(reopened.db.query(`SELECT id, root_id FROM ids WHERE id IN (?, ?, ?) ORDER BY id`).all(root, child, gone)).toEqual([
      { id: child, root_id: root },
      { id: gone, root_id: null },
      { id: root, root_id: null },
    ]);
  } finally {
    reopened.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// #521 5: a server marks ids.launcher only for a live hosted root's ownership. Opening the file clears every other
// mark (a pre-upgrade WSS launcher's, an ended hosted root's from before #532, a child's) and audits each cleared ID
// once; a live root's mark survives, and a second open finds nothing to clear.
test("opening a database clears launcher marks no live hosted root holds, auditing each once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-launcher-db-"));
  const path = join(dir, "db.sqlite");
  const opts = { blobDir: join(dir, "blobs") };
  const old = openDatabase(path, opts);
  const now = Date.now();
  const [root, child, wss, ended, plain] = ["id:r000000000000", "id:c000000000000", "id:w000000000000", "id:e000000000000", "id:p000000000000"];
  const user = await seed(old.repo, () => {
    const user = old.repo.users.upsertByEmail("you@example.com", null);
    for (const id of [root, child, wss, ended, plain]) old.db.prepare(`INSERT INTO ids (id, principal, started_at, last_seen, launcher) VALUES (?, ?, ?, ?, ?)`).run(id, user.email, now, now, id === plain ? 0 : 1);
    const own = old.db.prepare(`INSERT INTO hosted_ownerships (session_id, user_id, client_id, started_at, ended_at) VALUES (?, ?, ?, ?, ?) RETURNING id`);
    const live = own.get(root, user.id, "grayboard-pi", now, null) as { id: number };
    own.get(ended, user.id, "grayboard-pi", now, now);
    const row = old.db.prepare(`INSERT INTO hosted_sessions (session_id, ownership_id, user_id, client_id, grant_id, source_session_id, root_session_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    row.run(root, live.id, user.id, "grayboard-pi", "G1", "root-run", null, now, now);
    row.run(child, live.id, user.id, "grayboard-pi", "G1", "child-run", root, now, now);
    return user;
  });
  old.db.close();
  const swept = () => openDatabase(path, opts);
  const first = swept();
  const audits = (db: typeof first.db) => db.query(`SELECT actor, target, detail FROM access_log WHERE action = 'handle.launcher_set' ORDER BY target`).all();
  try {
    expect(first.db.query(`SELECT id FROM ids WHERE launcher = 1`).all()).toEqual([{ id: root }]);
    const cleared = [child, ended, wss].map((target) => ({ actor: user.email, target, detail: JSON.stringify({ on: false, reason: "stale" }) }));
    expect(audits(first.db)).toEqual(cleared);
    first.db.close();
    const second = swept();
    try {
      expect(audits(second.db)).toEqual(cleared);
      expect(second.db.query(`SELECT id FROM ids WHERE launcher = 1`).all()).toEqual([{ id: root }]);
    } finally {
      second.db.close();
    }
  } finally {
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
    const { repo: r } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
    repo = r;
  });

  test("upsertByEmail creates user on first call", async () => {
    const u = await seed(repo, () => repo.users.upsertByEmail("wade@example.com", "Wade"));
    expect(u.email).toBe("wade@example.com");
    expect(u.display_name).toBe("Wade");
    expect(u.disabled_at).toBeNull();
  });

  test("upsertByEmail updates display_name on collision", async () => {
    await seed(repo, () => repo.users.upsertByEmail("wade@example.com", "Wade"));
    const u = await seed(repo, () => repo.users.upsertByEmail("wade@example.com", "Wade B"));
    expect(u.display_name).toBe("Wade B");
  });

  test("sessions: create, findByTokenHash, revoke", async () => {
    const s = await seed(repo, () => {
      const u = repo.users.upsertByEmail("wade@example.com", null);
      return repo.sessions.create(u.id, "hash123", "test");
    });
    const found = repo.sessions.findByTokenHash("hash123");
    expect(found?.id).toBe(s.id);
    await seed(repo, () => repo.sessions.revoke(s.id));
    expect(repo.sessions.findByTokenHash("hash123")).toBeUndefined();
    // By row, a revoked one still reads, with its revoked_at.
    expect(repo.sessions.findById(s.id)?.revoked_at).not.toBeNull();
    expect(repo.sessions.findById(s.id + 100)).toBeUndefined();
  });

  test("aliases: create, list, remove", async () => {
    const fe = await seed(repo, () => {
      repo.users.upsertByEmail("you@example.com", null);
      const fe = repo.aliases.create(person("you@example.com", "fe"), "you@example.com");
      repo.aliases.create(person("you@example.com", "be"), "you@example.com");
      return fe;
    });
    expect(fe.address).toBe("you@example.com/fe");
    expect(repo.aliases.listForScope("person", "you@example.com").map((a) => a.name)).toEqual(["be", "fe"]);
    await seed(repo, () => {
      repo.cursors.advance("you@example.com/fe", "direct", "you@example.com/fe", 7);
      repo.aliases.remove("you@example.com/fe");
    });
    expect(repo.aliases.listForScope("person", "you@example.com")).toHaveLength(1);
    // Its read point goes with it: a new alias of the name starts from scratch.
    expect(repo.cursors.directFor("you@example.com/fe")).toBe(0);
  });

  // #284 S9: aliases are keyed by address in any scope.
  test("aliases: a team scope's alias is its own address, listed under its scope", async () => {
    const team = await seed(repo, () => {
      const u = repo.users.upsertByEmail("you@example.com", null);
      repo.teams.create("eng", u.id);
      repo.aliases.create(person("you@example.com", "be"), "you@example.com");
      return repo.aliases.create({ scope_kind: "team", scope_ref: "eng", name: "be" }, "you@example.com");
    });
    expect(team).toMatchObject({ address: "eng/be", scope_kind: "team", scope_ref: "eng", name: "be" });
    expect(repo.aliases.find("eng/be")?.id).toBe(team.id);
    expect(repo.aliases.find("eng/fe")).toBeUndefined();
    expect(repo.aliases.listForScope("team", "eng").map((a) => a.address)).toEqual(["eng/be"]);
    expect(repo.aliases.listForScope("person", "you@example.com").map((a) => a.address)).toEqual(["you@example.com/be"]);
    expect(repo.aliases.listForScope("person", "eng")).toEqual([]);
    expect(repo.aliases.findAllByName("be").map((a) => a.address)).toEqual(["eng/be", "you@example.com/be"]);
  });

  test("principals: findByName reads users and teams", async () => {
    const { u, eng } = await seed(repo, () => {
      const u = repo.users.upsertByEmail("you@example.com", null);
      return { u, eng: repo.teams.create("eng", u.id) };
    });
    expect(repo.principals.findByName("you@example.com")).toMatchObject({ kind: "user", user_id: u.id, team_id: null });
    expect(repo.principals.findByName("eng")).toMatchObject({ kind: "team", user_id: null, team_id: eng.id });
    expect(repo.principals.findByName("ops")).toBeUndefined();
  });

  test("teams: create, join, leave, list members", async () => {
    const { u2, t } = await seed(repo, () => {
      const u1 = repo.users.upsertByEmail("a@example.com", null);
      const u2 = repo.users.upsertByEmail("b@example.com", null);
      const t  = repo.teams.create("eng", u1.id);
      repo.teams.addMember(t.id, u1.id);
      repo.teams.addMember(t.id, u2.id);
      return { u2, t };
    });
    expect(repo.teams.listMembers(t.id)).toHaveLength(2);
    await seed(repo, () => repo.teams.removeMember(t.id, u2.id));
    expect(repo.teams.listMembers(t.id)).toHaveLength(1);
  });

  test("messages: insert and thread", async () => {
    const { root, reply } = await seed(repo, () => {
      const root  = repo.messages.insert("a@example.com/fe", "user", "b@example.com/be", "hello", null);
      return { root, reply: repo.messages.insert("b@example.com/be", "user", "a@example.com/fe", "hi", root.id) };
    });
    const thread = repo.messages.thread(root.id);
    expect(thread).toHaveLength(2);
    expect(thread[0].id).toBe(root.id);
    expect(thread[1].id).toBe(reply.id);
    expect(repo.messages.thread(reply.id).map(m => m.id)).toEqual([root.id, reply.id]);
  });

  test("cursors: advance is idempotent and takes MAX", async () => {
    await seed(repo, () => repo.cursors.advance("you@example.com/fe", "direct", "you@example.com/fe", 10));
    await seed(repo, () => repo.cursors.advance("you@example.com/fe", "direct", "you@example.com/fe", 5));  // lower — should not regress
    expect(repo.cursors.get("you@example.com/fe", "direct", "you@example.com/fe")).toBe(10);
    await seed(repo, () => repo.cursors.advance("you@example.com/fe", "direct", "you@example.com/fe", 20));
    expect(repo.cursors.directFor("you@example.com/fe")).toBe(20);
  });

  test("unreadSince returns only messages after cursor", async () => {
    const [m1, m2] = await seed(repo, () => [
      repo.messages.insert("a@example.com/fe", "user", "b@example.com/be", "msg1", null),
      repo.messages.insert("a@example.com/fe", "user", "b@example.com/be", "msg2", null),
    ]);
    const unread = repo.messages.unreadSince([{ type: "direct", ref: "b@example.com/be", since: m1.id }]);
    expect(unread).toHaveLength(1);
    expect(unread[0].id).toBe(m2.id);
  });

  // #284 S8: a session reads as every address it has, its ID and its alias.
  test("history, undeliveredFrom, receivedUnacked and sentPending take an address set", async () => {
    const [id, alias, peer, other] = ["id:s1", "a@example.com/fe", "b@example.com/be", "c@example.com/qa"];
    const { toId, fromAlias, toAlias, fromId } = await seed(repo, () => {
      const toId = repo.messages.insert(peer, "user", id, "to the id", null);
      const fromAlias = repo.messages.insert(alias, "user", peer, "from the alias", null, true);
      const toAlias = repo.messages.insert(peer, "user", alias, "to the alias", null);
      const fromId = repo.messages.insert(id, "user", other, "from the id", null, true);
      repo.messages.insert(peer, "user", other, "not ours", null);
      return { toId, fromAlias, toAlias, fromId };
    });
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
    await seed(repo, () => repo.messages.ack(alias, toId.id));
    expect(ids(repo.messages.receivedUnacked(set, 0))).toEqual([toId.id, toAlias.id]);
    await seed(repo, () => {
      repo.messages.ack(id, toId.id);
      repo.messages.ack(id, fromId.id);
    });
    expect(ids(repo.messages.receivedUnacked(set, 0))).toEqual([toAlias.id]);
    expect(ids(repo.messages.sentPending(set, 0))).toEqual([fromAlias.id]);
  });

  // #284 S5: the MailPort core endSession runs on the server.
  test("mail: unread is the ID's unread direct mail from others; bounce and dropReader", async () => {
    const [id, peer] = ["id:s1", "b@example.com/be"];
    const { read, unread } = await seed(repo, () => {
      const read = repo.messages.insert(peer, "user", id, "read", null);
      const unread = repo.messages.insert(peer, "user", id, "unread", null);
      repo.messages.insert(id, "user", id, "to itself", null);
      repo.messages.insert(peer, "team", id, "a team stream of the same name", null);
      repo.messages.insert(peer, "user", "a@example.com/fe", "to someone else", null);
      repo.cursors.advance(id, "direct", id, read.id);
      return { read, unread };
    });
    expect(repo.mail.unread(id)).toEqual([{ id: unread.id, sender: peer }]);

    await seed(repo, () => repo.mail.bounce(id, peer, unread.id, "returned", 1234));
    const [bounce] = repo.messages.history([peer]).filter((m) => m.kind === "bounce");
    expect(bounce).toMatchObject({ sender: id, recipient_type: "user", recipient: peer, body: "returned", parent_id: unread.id, created_at: 1234, pending: 0, kind: "bounce" });
    expect(repo.messages.getById(unread.id)?.kind).toBeNull();

    await seed(repo, () => {
      repo.messages.ack(id, unread.id);
      repo.messages.ack(peer, bounce!.id);
      repo.mail.dropReader(id);
    });
    expect(repo.cursors.directFor(id)).toBe(0);
    expect(repo.messages.receivedUnacked([id], 0).map((m) => m.id)).toEqual([read.id, unread.id]);
    expect(repo.messages.receivedUnacked([peer], 0)).toEqual([]);
  });

  test("audit.write and prune", async () => {
    const oldTs = Date.now() - 100;
    await seed(repo, () => repo.audit.write({ at: oldTs, actor: "wade@example.com", action: "auth.login", target: null, detail: null }));
    await seed(repo, () => repo.audit.prune(Date.now())); // prune everything older than now
    // No assertion on rows (no SELECT on audit in Repo) but prune should not throw
  });
});

// #284 decision 5: users, teams and service principals share one namespace.
test("principals: a sign-in and a team create insert one; a team can't take another principal's name", async () => {
  const { db, repo } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  const { u, eng } = await seed(repo, () => {
    const u = repo.users.upsertByEmail("a@example.com", null);
    repo.users.upsertByEmail("a@example.com", "A");
    const eng = repo.teams.create("eng", u.id);
    // Service principals arrive with #270; the namespace guard is here now.
    db.prepare(`INSERT INTO principals (kind, name, created_at) VALUES ('service', 'ingest', 0)`).run();
    return { u, eng };
  });
  await expect(seed(repo, () => repo.teams.create("ingest", u.id))).rejects.toThrow(PrincipalTaken);
  expect(repo.teams.findByName("ingest")).toBeUndefined();
  expect(db.prepare(`SELECT kind, name, user_id, team_id FROM principals ORDER BY id`).all()).toEqual([
    { kind: "user", name: "a@example.com", user_id: u.id, team_id: null },
    { kind: "team", name: "eng", user_id: null, team_id: eng.id },
    { kind: "service", name: "ingest", user_id: null, team_id: null },
  ]);
});

// Security audit F-13, #928 D4: users are matched by (issuer, subject) first,
// so a reassigned email can't inherit an account, and one IdP's account never
// signs into another IdP's by email.
const G = GOOGLE_ISSUER, OKTA = "https://example.okta.com";
const fresh = () => openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
// Each write in a queued body, as the OAuth sign-in and the admin route run them (#807 P1b-4f).
const signIn = (repo: Repo, ...a: Parameters<Repo["users"]["signIn"]>) => seed(repo, () => repo.users.signIn(...a));
const upsert = (repo: Repo, email: string) => seed(repo, () => repo.users.upsertByEmail(email, null));

test("signIn D4 branch 1: this (issuer, subject)'s user signs in, or is refused when its email changed", async () => {
  const { repo } = fresh();
  const u = await signIn(repo, G, "s-1", "a@example.com", "A");
  expect(await signIn(repo, G, "s-1", "a@example.com", "A 2")).toMatchObject({ status: "ok", linked: false, user: { id: u.user.id, display_name: "A 2" } });
  // The same IdP account reporting another email is refused, and no user is created.
  expect(await signIn(repo, G, "s-1", "renamed@example.com", null)).toMatchObject({ status: "email_changed", user: { id: u.user.id } });
  expect(repo.users.findByEmail("renamed@example.com")).toBeUndefined();
});

test("signIn D4 branch 2: another subject under the same issuer is subject_mismatch, and nothing changes", async () => {
  const { repo } = fresh();
  const u = (await signIn(repo, G, "s-1", "a@example.com", null)).user;
  expect(await signIn(repo, G, "s-intruder", "a@example.com", null)).toEqual({ status: "subject_mismatch", user: u });
  expect(repo.users.findById(u.id)).toEqual(u);
});

test("signIn D4 branch 3: an email another issuer holds, with or without a subject, is issuer_mismatch naming the holder", async () => {
  const { db, repo } = fresh();
  const linked = (await signIn(repo, G, "s-1", "a@example.com", null)).user;
  expect(await signIn(repo, OKTA, "o-1", "a@example.com", null)).toEqual({ status: "issuer_mismatch", user: linked, issuer: G });
  // A pre-F-13 row: Google's issuer, no subject. Reserved for Google.
  const legacy = await upsert(repo, "old@example.com");
  await seed(repo, () => { db.run("UPDATE users SET idp_issuer = ? WHERE id = ?", [G, legacy.id]); });
  expect(await signIn(repo, OKTA, "o-2", "old@example.com", null)).toMatchObject({ status: "issuer_mismatch", user: { id: legacy.id, idp_subject: null }, issuer: G });
  expect(repo.users.findById(legacy.id)).toMatchObject({ idp_issuer: G, idp_subject: null });
});

test("signIn D4 branch 4: this issuer's subjectless row links", async () => {
  const { db, repo } = fresh();
  const legacy = await upsert(repo, "old@example.com");
  await seed(repo, () => { db.run("UPDATE users SET idp_issuer = ? WHERE id = ?", [G, legacy.id]); });
  expect(await signIn(repo, G, "s-old", "old@example.com", "Old")).toMatchObject({ status: "ok", linked: true, user: { id: legacy.id, idp_issuer: G, idp_subject: "s-old", display_name: "Old" } });
  expect(repo.users.findById(legacy.id)).toMatchObject({ idp_issuer: G, idp_subject: "s-old", display_name: "Old" });
});

test("signIn D4 branch 5: a row with neither links to whichever issuer signs in first, both columns set", async () => {
  const { repo } = fresh();
  const dev = await upsert(repo, "dev@example.com");
  expect(dev).toMatchObject({ idp_issuer: null, idp_subject: null });
  expect(await signIn(repo, OKTA, "o-1", "dev@example.com", null)).toMatchObject({ status: "ok", linked: true, user: { id: dev.id, idp_issuer: OKTA, idp_subject: "o-1" } });
  expect(repo.users.findById(dev.id)).toMatchObject({ idp_issuer: OKTA, idp_subject: "o-1" });
  expect(await signIn(repo, G, "s-1", "dev@example.com", null)).toMatchObject({ status: "issuer_mismatch", issuer: OKTA });
});

test("signIn D4 branch 6: no row creates the user with issuer and subject, and its principal", async () => {
  const { db, repo } = fresh();
  const r = await signIn(repo, G, "s-new", "new@example.com", "New");
  expect(r).toMatchObject({ status: "ok", linked: false, user: { email: "new@example.com", idp_issuer: G, idp_subject: "s-new", display_name: "New" } });
  expect(repo.users.findByEmail("new@example.com")).toMatchObject({ idp_issuer: G, idp_subject: "s-new" });
  expect(db.query("SELECT kind FROM principals WHERE name = 'new@example.com'").all()).toEqual([{ kind: "user" }]);
});

test("signIn: the same sub under two issuers is two users; one issuer can't hold a sub twice", async () => {
  const { db, repo } = fresh();
  const a = (await signIn(repo, G, "same", "a@example.com", null)).user;
  const b = (await signIn(repo, OKTA, "same", "b@example.com", null)).user;
  expect(a.id).not.toBe(b.id);
  expect(await signIn(repo, OKTA, "same", "b@example.com", null)).toMatchObject({ status: "ok", user: { id: b.id } });
  expect(await signIn(repo, G, "same", "a@example.com", null)).toMatchObject({ status: "ok", user: { id: a.id } });
  const c = await upsert(repo, "c@example.com");
  await expect(seed(repo, () => { db.run("UPDATE users SET idp_issuer = ?, idp_subject = 'same' WHERE id = ?", [G, c.id]); })).rejects.toThrow(/UNIQUE/);
});

test("signIn: clearSubject clears issuer and subject, so the next sign-in from any issuer takes the email", async () => {
  const { repo } = fresh();
  const u = (await signIn(repo, G, "s-1", "a@example.com", null)).user;
  await seed(repo, () => repo.users.clearSubject(u.id));
  expect(repo.users.findById(u.id)).toMatchObject({ idp_issuer: null, idp_subject: null });
  expect(await signIn(repo, OKTA, "o-1", "a@example.com", null)).toMatchObject({ status: "ok", linked: true, user: { id: u.id, idp_issuer: OKTA, idp_subject: "o-1" } });
});

// D3: the link is a conditional write. A trigger links the row to another
// account between signIn's read and its write (what a concurrent sign-in does
// on Postgres) and drops signIn's own update: signIn re-reads and refuses.
for (const [winner, status] of [[OKTA, "issuer_mismatch"], [G, "subject_mismatch"]] as const) {
  test(`signIn: a row linked between the read and the conditional write ends in ${status}, not a double link`, async () => {
    const { db, repo } = fresh();
    const u = await upsert(repo, "race@example.com");
    db.run(`CREATE TRIGGER race BEFORE UPDATE OF idp_subject ON users WHEN NEW.idp_subject = 's-mine' BEGIN
      UPDATE users SET idp_issuer = '${winner}', idp_subject = 's-theirs' WHERE id = OLD.id;
      SELECT RAISE(IGNORE);
    END`);
    expect(await signIn(repo, G, "s-mine", "race@example.com", null)).toMatchObject({ status, user: { id: u.id, idp_issuer: winner, idp_subject: "s-theirs" } });
    expect(repo.users.findById(u.id)).toMatchObject({ idp_issuer: winner, idp_subject: "s-theirs" });
  });
}

test("signIn: a disabled account without a subject isn't bound to whoever signs in", async () => {
  const { repo } = fresh();
  const departed = await upsert(repo, "gone@example.com");
  await seed(repo, () => repo.users.setDisabled(departed.id, true));
  expect(await signIn(repo, G, "s-hire", "gone@example.com", null)).toMatchObject({ status: "ok", linked: false, user: { id: departed.id } });
  expect(repo.users.findById(departed.id)).toMatchObject({ idp_issuer: null, idp_subject: null });
});

// #928 D3: the issuer column, its one-time stamp, the every-open repair and the index swap.
const usersV1 = `CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, display_name TEXT, created_at INTEGER NOT NULL, disabled_at INTEGER)`;
const identities = (path: string) => {
  const db = new Database(path, { readonly: true });
  try { return db.query("SELECT email, idp_issuer, idp_subject FROM users ORDER BY id").all(); } finally { db.close(); }
};
const indexes = (path: string) => {
  const db = new Database(path, { readonly: true });
  try { return (db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'users' AND name LIKE 'idx_%' ORDER BY name").all() as { name: string }[]).map(r => r.name); } finally { db.close(); }
};
const reopen = (path: string) => openDatabase(path, { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) }).db.close();

test("schema: a v1.0.0-shaped database (no idp_subject) comes out stamped with Google's issuer", () => {
  const path = scratchDbPath();
  const raw = new Database(path);
  raw.exec(usersV1);
  raw.run("INSERT INTO users (email, created_at) VALUES ('a@example.com', 0), ('b@example.com', 0)");
  raw.close();
  reopen(path);
  expect(identities(path)).toEqual([
    { email: "a@example.com", idp_issuer: G, idp_subject: null },
    { email: "b@example.com", idp_issuer: G, idp_subject: null },
  ]);
});

test("schema: a post-F-13 database (subject, no issuer) is stamped, its old index dropped; a later open doesn't re-stamp a cleared row", async () => {
  const path = scratchDbPath();
  const raw = new Database(path);
  raw.exec(usersV1);
  raw.exec("ALTER TABLE users ADD COLUMN idp_subject TEXT");
  raw.exec("CREATE UNIQUE INDEX idx_users_idp_subject ON users(idp_subject) WHERE idp_subject IS NOT NULL");
  raw.run("INSERT INTO users (email, created_at, idp_subject) VALUES ('linked@example.com', 0, 's-1'), ('legacy@example.com', 0, NULL)");
  raw.close();
  reopen(path);
  expect(identities(path)).toEqual([
    { email: "linked@example.com", idp_issuer: G, idp_subject: "s-1" },
    { email: "legacy@example.com", idp_issuer: G, idp_subject: null },
  ]);
  expect(indexes(path)).toEqual(["idx_users_idp_identity"]);
  const { repo, db } = openDatabase(path, { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  await seed(repo, () => repo.users.clearSubject(repo.users.findByEmail("linked@example.com")!.id));
  await seed(repo, () => repo.users.clearSubject(repo.users.findByEmail("legacy@example.com")!.id));
  db.close();
  reopen(path);
  expect(identities(path)).toEqual([
    { email: "linked@example.com", idp_issuer: null, idp_subject: null },
    { email: "legacy@example.com", idp_issuer: null, idp_subject: null },
  ]);
});

test("schema: what a rolled-back binary writes (a subject, no issuer; its old index) is repaired on the next open", async () => {
  const path = scratchDbPath();
  reopen(path);
  // The previous release on this database: it links a user with no issuer and recreates its index.
  const raw = new Database(path);
  raw.run("INSERT INTO users (email, created_at, idp_subject) VALUES ('back@example.com', 0, 's-back'), ('dev@example.com', 0, NULL)");
  raw.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_idp_subject ON users(idp_subject) WHERE idp_subject IS NOT NULL");
  raw.close();
  expect(indexes(path)).toEqual(["idx_users_idp_identity", "idx_users_idp_subject"]);
  reopen(path);
  expect(identities(path)).toEqual([
    { email: "back@example.com", idp_issuer: G, idp_subject: "s-back" },
    // No subject: a dev login's row, which the repair leaves with neither.
    { email: "dev@example.com", idp_issuer: null, idp_subject: null },
  ]);
  expect(indexes(path)).toEqual(["idx_users_idp_identity"]);
  const { repo, db } = openDatabase(path, { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  expect(await signIn(repo, G, "s-back", "back@example.com", null)).toMatchObject({ status: "ok", linked: false });
  db.close();
});

// ── #130: the undeliveredFrom plan ────────────────────────────────────────────

test("undeliveredFrom looks each read point up by its key, never a mailbox_cursors scan", async () => {
  const { db, repo } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  await seed(repo, () => {
    repo.users.upsertByEmail("a@example.com", null);
    repo.aliases.create(person("a@example.com", "fe"), "a@example.com");
    repo.users.upsertByEmail("b@example.com", null);
    repo.aliases.create(person("b@example.com", "be"), "b@example.com");
    repo.messages.insert("a@example.com/fe", "user", "b@example.com/be", "hello", null);
    repo.cursors.advance("b@example.com/be", "direct", "b@example.com/be", 1);
  });
  const plan = db.prepare("EXPLAIN QUERY PLAN " + UNDELIVERED_FROM_SQL)
    .all(JSON.stringify(["a@example.com/fe"]), Number.MAX_SAFE_INTEGER) as { detail: string }[];
  const detail = plan.map(p => p.detail).join(" ");
  expect(detail).toContain("SEARCH c USING INDEX sqlite_autoindex_mailbox_cursors_1");
  expect(detail).not.toContain("SCAN c");
});

// #805: without ANALYZE the planner took idx_msg_recipient on `recipient_type = 'user'` alone, a pass over every
// user DM per call; at 130K messages each churned session's start spent ~100 ms there, stalling the loop for seconds.
// Both sender-keyed statements must seek by sender.
test("undeliveredFrom and sentPending search messages by sender, never by recipient_type alone", () => {
  const { db } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  const detail = (sql: string, ...args: (string | number)[]) =>
    (db.prepare("EXPLAIN QUERY PLAN " + sql).all(...args) as { detail: string }[]).map((p) => p.detail).join(" ");
  for (const plan of [detail(UNDELIVERED_FROM_SQL, JSON.stringify(["a@example.com/fe"]), Number.MAX_SAFE_INTEGER),
                      detail(SENT_PENDING_SQL, JSON.stringify(["a@example.com/fe"]), 0)]) {
    expect(plan).toContain("SEARCH m USING INDEX idx_msg_sender (sender=?)");
    expect(plan).not.toContain("idx_msg_recipient");
  }
});

// #284 audit: queuedTo and retract read the read point by its key too.
test("queuedTo and retract look the read point up by its key, never a mailbox_cursors scan", async () => {
  const { db, repo } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  await seed(repo, () => {
    repo.users.upsertByEmail("a@example.com", null);
    repo.aliases.create(person("a@example.com", "fe"), "a@example.com");
    repo.users.upsertByEmail("b@example.com", null);
    repo.aliases.create(person("b@example.com", "be"), "b@example.com");
    repo.messages.insert("a@example.com/fe", "user", "b@example.com/be", "hello", null);
    repo.cursors.advance("b@example.com/be", "direct", "b@example.com/be", 1);
  });
  const detail = (sql: string, ...args: (string | number)[]) =>
    (db.prepare("EXPLAIN QUERY PLAN " + sql).all(...args) as { detail: string }[]).map((p) => p.detail).join(" ");
  const queued = detail(QUEUED_TO_SQL, JSON.stringify(["b@example.com/be"]));
  expect(queued).toContain("SEARCH c USING INDEX sqlite_autoindex_mailbox_cursors_1");
  expect(queued).not.toContain("SCAN c");
  const retract = detail(RETRACTABLE_SQL, 1, "a@example.com/fe");
  expect(retract).toContain("SEARCH mailbox_cursors USING INDEX sqlite_autoindex_mailbox_cursors_1");
  expect(retract).not.toContain("SCAN mailbox_cursors");
});

// #295: audit.last searches access_log by (action, target) and reads it newest first, with no scan or sort.
test("audit.last searches access_log by (action, target), never a scan or a sort", async () => {
  const { db, repo } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  const detail = (db.prepare("EXPLAIN QUERY PLAN " + ACCESS_LOG_LAST_SQL).all("dm.retract", "7") as { detail: string }[]).map((p) => p.detail).join(" ");
  expect(detail).toContain("SEARCH access_log USING INDEX idx_access_log_action_target (action=? AND target=?)");
  expect(detail).not.toContain("SCAN");
  expect(detail).not.toContain("TEMP B-TREE");
  await seed(repo, () => {
    for (const [at, target] of [[1, "7"], [3, "7"], [2, "7"], [4, "8"]] as const) db.prepare("INSERT INTO access_log (at, actor, action, target, detail) VALUES (?, 'a', 'dm.retract', ?, ?)").run(at, target, `row ${at}`);
  });
  expect(repo.audit.last("dm.retract", "7")?.detail).toBe("row 3");
});
