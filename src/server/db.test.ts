import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
import { ACCESS_LOG_LAST_SQL, INVOKE_BINDING_SQL, mailPort, openDatabase, QUEUED_TO_SQL, RETRACTABLE_SQL, SENT_PENDING_SQL, UNDELIVERED_FROM_SQL, type Repo } from "./db.ts";
import type { Tx } from "./store/tx.ts";
import { scratchDbPath } from "../../tests/support/scratch_db.ts";
import { holdAlias } from "../core/bindings.ts";
import { createBoard, post, registerId, subscribe, touchAlias } from "../core/boards.ts";
import { claim, watch } from "../core/claims.ts";
import { seed } from "../../tests/support/seed.ts";
import { GOOGLE_ISSUER } from "./idp_google.ts";
import { onTeamJoined } from "./teams.ts";
import { hashToken } from "./auth.ts";
import { issueOAuth } from "../../tests/helpers/oauth.ts";
import { grantOwner } from "../../tests/support/roles.ts";
import { identityContract } from "./store/identity.contract.ts";
import { sqliteIdentityBackend } from "./store/identity.contract.sqlite.ts";
import { aliasesContract } from "./store/aliases.contract.ts";
import { sqliteAliasesBackend } from "./store/aliases.contract.sqlite.ts";
import { messagesContract } from "./store/messages.contract.ts";
import { sqliteMessagesBackend } from "./store/messages.contract.sqlite.ts";
import { cursorsContract } from "./store/cursors.contract.ts";
import { sqliteCursorsBackend } from "./store/cursors.contract.sqlite.ts";
import { writeReceiptsContract } from "./store/write_receipts.contract.ts";
import { sqliteWriteReceiptsBackend } from "./store/write_receipts.contract.sqlite.ts";
import { auditContract } from "./store/audit.contract.ts";
import { sqliteAuditBackend } from "./store/audit.contract.sqlite.ts";
import { slackContract } from "./store/slack.contract.ts";
import { sqliteSlackBackend } from "./store/slack.contract.sqlite.ts";
import { hostedContract } from "./store/hosted.contract.ts";
import { sqliteHostedBackend } from "./store/hosted.contract.sqlite.ts";
import { authCacheContract } from "./store/auth_cache.contract.ts";
import { sqliteAuthCacheBackend } from "./store/auth_cache.contract.sqlite.ts";

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
  // src/server/store/*.contract.sqlite.ts are test-only runners (registered by this file) that put the SQLite store
  // under a shared contract; they may drive a second connection or spy on the connection class.
  const offenders: string[] = [];
  const glob = new Glob("src/**/*.ts");
  const importPattern = /from\s+["']bun:sqlite["']/;
  for await (const file of glob.scan(".")) {
    if (file === "src/server/db.ts") continue;
    if (file.startsWith("src/local/")) continue;
    if (file.startsWith("src/core/")) continue;
    if (file.startsWith("src/bridge/")) continue;
    if (file.endsWith(".test.ts")) continue;
    if (/^src\/server\/store\/[^/]+\.contract\.sqlite\.ts$/.test(file)) continue;
    const text = await Bun.file(file).text();
    if (importPattern.test(text)) offenders.push(file);
  }
  expect(offenders).toEqual([]);
});

test("#807 P1b-3: the server reads on its read-only connection outside a transaction and on the writer inside one", async () => {
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
    await repo.write(() => db.prepare<{ n: number }, []>("SELECT 7 AS n").get());
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
  const { user, session } = await seed(old.repo, async tx => {
    const user = await old.repo.users.upsertByEmail(tx, "you@example.com", "You");
    const session = await old.repo.sessions.create(tx, user.id, "old-session-hash", "old client");
    await old.repo.aliases.create(tx, { scope_kind: "person", scope_ref: user.email, name: "fe" }, user.email);
    await old.repo.messages.insert(tx, "you@example.com/fe", "user", "peer@example.com/be", "preserved", null);
    for (const table of ["oauth_tokens", "oauth_grants", "oauth_codes", "oauth_browsers", "oauth_requests"]) old.db.exec(`DROP TABLE ${table}`);
    return { user, session };
  });
  old.db.close();
  const reopened = openDatabase(path, opts);
  try {
    expect((await reopened.repo.users.findById(reopened.repo.read, user.id))?.display_name).toBe("You");
    expect((await reopened.repo.sessions.findByTokenHash(reopened.repo.read, "old-session-hash"))?.id).toBe(session.id);
    expect((await reopened.repo.aliases.listForScope(reopened.repo.read, "person", user.email)).map(i => i.name)).toEqual(["fe"]);
    expect((await reopened.repo.messages.history(reopened.repo.read, ["you@example.com/fe"]))[0]?.body).toBe("preserved");
    expect(await reopened.repo.oauth.isGrantActive(reopened.repo.read, "missing", Date.now())).toBe(false);
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
  await seed(old.repo, async tx => {
    const user = await old.repo.users.upsertByEmail(tx, "you@example.com", null);
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
  const user = await seed(old.repo, async tx => {
    const user = await old.repo.users.upsertByEmail(tx, "you@example.com", null);
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

  // #284 S5: the MailPort core endSession runs on the server (repo.sessionEnd.end's, #807 P3 B4a).
  test("mail: unread is the ID's unread direct mail from others; bounce and dropReader", async () => {
    const [id, peer] = ["id:s1", "b@example.com/be"];
    const { read, unread } = await seed(repo, async tx => {
      const read = await repo.messages.insert(tx, peer, "user", id, "read", null);
      const unread = await repo.messages.insert(tx, peer, "user", id, "unread", null);
      await repo.messages.insert(tx, id, "user", id, "to itself", null);
      await repo.messages.insert(tx, peer, "team", id, "a team stream of the same name", null);
      await repo.messages.insert(tx, peer, "user", "a@example.com/fe", "to someone else", null);
      await repo.cursors.advance(tx, id, "direct", id, read.id);
      return { read, unread };
    });
    expect(await seed(repo, tx => mailPort(repo.coreOn(tx)).unread(id))).toEqual([{ id: unread.id, sender: peer }]);

    await seed(repo, tx => mailPort(repo.coreOn(tx)).bounce(id, peer, unread.id, "returned", 1234));
    const [bounce] = (await repo.messages.history(repo.read, [peer])).filter((m) => m.kind === "bounce");
    expect(bounce).toMatchObject({ sender: id, recipient_type: "user", recipient: peer, body: "returned", parent_id: unread.id, created_at: 1234, pending: 0, kind: "bounce" });
    expect((await repo.messages.getById(repo.read, unread.id))?.kind).toBeNull();

    await seed(repo, async tx => {
      await repo.messages.ack(tx, id, unread.id);
      await repo.messages.ack(tx, peer, bounce!.id);
      mailPort(repo.coreOn(tx)).dropReader(id);
    });
    expect(await repo.cursors.directFor(repo.read, id)).toBe(0);
    expect((await repo.messages.receivedUnacked(repo.read, [id], 0)).map((m) => m.id)).toEqual([read.id, unread.id]);
    expect((await repo.messages.receivedUnacked(repo.read, [peer], 0))).toEqual([]);
  });
});

// The identity groups' rows (users, sessions, principals, teams, roles, services), shared with the Postgres store
// (#807 P3 C3): the sign-in D4 branches, the name guards, the role refusals and the savepoint rows live there.
describe("identity contract (SQLite)", () => identityContract(sqliteIdentityBackend));
// The aliases and messages groups' rows, shared with the Postgres store (#807 P3 C5).
describe("aliases contract (SQLite)", () => aliasesContract(sqliteAliasesBackend));
describe("messages contract (SQLite)", () => messagesContract(sqliteMessagesBackend));
// The cursors, write receipts, audit and Slack groups' rows, shared with the Postgres store (#807 P3 C67a).
describe("cursors contract (SQLite)", () => cursorsContract(sqliteCursorsBackend));
describe("write receipts contract (SQLite)", () => writeReceiptsContract(sqliteWriteReceiptsBackend));
describe("audit contract (SQLite)", () => auditContract(sqliteAuditBackend));
describe("slack contract (SQLite)", () => slackContract(sqliteSlackBackend));
// The hosted sessions group's rows, shared with the Postgres store (#807 P3 C8a); its settled-Tx refusals moved there.
describe("hosted contract (SQLite)", () => hostedContract(sqliteHostedBackend));
describe("auth cache contract (SQLite)", () => authCacheContract(sqliteAuthCacheBackend));

// Sign-in fixtures for the rows below (security audit F-13, #928 D4).
const G = GOOGLE_ISSUER, OKTA = "https://example.okta.com";
const fresh = () => openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
// Each write in a queued body, as the OAuth sign-in and the admin route run them (#807 P1b-4f).
const signIn = (repo: Repo, ...a: Parameters<Repo["users"]["signIn"]> extends [Tx, ...infer R] ? R : never) => seed(repo, tx => repo.users.signIn(tx, ...a));
const upsert = (repo: Repo, email: string) => seed(repo, tx => repo.users.upsertByEmail(tx, email, null));

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

// #927: a database from before role_bindings gets one team_owner binding per owner on its first open: each
// team_members row with role 'owner', and each team creator still in it with a null role (rows from before roles).
// A member, a creator demoted to member, and a creator who left get none. The seed runs once, with the table.
test("schema: team ownership is seeded into role bindings once, from team_members.role and creators from before roles", async () => {
  const path = scratchDbPath();
  const first = openDatabase(path, { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  await seed(first.repo, async tx => {
    const u = await Promise.all(["a", "b", "c", "d"].map(n => first.repo.users.upsertByEmail(tx, `${n}@example.com`, null)));
    const eng = await first.repo.teams.create(tx, "eng", u[0]!.id), ops = await first.repo.teams.create(tx, "ops", u[1]!.id), qa = await first.repo.teams.create(tx, "qa", u[2]!.id);
    for (const [t, m] of [[eng, 0], [eng, 1], [eng, 3], [ops, 1], [ops, 2], [qa, 3]] as const) await first.repo.teams.addMember(tx, t.id, u[m]!.id);
  });
  // As a pre-#927 server left them: eng's creator a with a null role, d an explicit owner, b a member; ops's creator
  // b demoted to member and c its owner; qa's creator c gone, d a member.
  first.db.close();
  const raw = new Database(path);
  raw.exec("DROP TABLE role_bindings");
  const role = (team: string, email: string, r: string | null) => raw.run("UPDATE team_members SET role = ? WHERE team_id = (SELECT id FROM teams WHERE name = ?) AND user_id = (SELECT id FROM users WHERE email = ?)", [r, team, email]);
  role("eng", "a@example.com", null); role("eng", "b@example.com", "member"); role("eng", "d@example.com", "owner");
  role("ops", "b@example.com", "member"); role("ops", "c@example.com", "owner");
  role("qa", "d@example.com", "member");
  raw.close();
  const owners = (db: Database) => db.query("SELECT p.name AS holder, s.name AS team, b.granted_by FROM role_bindings b JOIN principals p ON p.id = b.principal_id JOIN principals s ON s.id = b.scope_id WHERE b.role = 'team_owner' ORDER BY s.name, p.name").all();
  const second = openDatabase(path, { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  try {
    expect(owners(second.db)).toEqual([
      { holder: "a@example.com", team: "eng", granted_by: null },
      { holder: "d@example.com", team: "eng", granted_by: null },
      { holder: "c@example.com", team: "ops", granted_by: null },
    ]);
  } finally { second.db.close(); }
  const raw2 = new Database(path);
  raw2.run("DELETE FROM role_bindings WHERE principal_id = (SELECT id FROM principals WHERE name = 'd@example.com')");
  raw2.close();
  const third = openDatabase(path, { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  try {
    expect(owners(third.db).map(r => (r as { holder: string }).holder)).toEqual(["a@example.com", "c@example.com"]);
  } finally { third.db.close(); }
});

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
  await seed(repo, async tx => repo.users.clearSubject(tx, (await repo.users.findByEmail(tx, "linked@example.com"))!.id));
  await seed(repo, async tx => repo.users.clearSubject(tx, (await repo.users.findByEmail(tx, "legacy@example.com"))!.id));
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
  await seed(repo, async tx => {
    await repo.users.upsertByEmail(tx, "a@example.com", null);
    await repo.aliases.create(tx, person("a@example.com", "fe"), "a@example.com");
    await repo.users.upsertByEmail(tx, "b@example.com", null);
    await repo.aliases.create(tx, person("b@example.com", "be"), "b@example.com");
    await repo.messages.insert(tx, "a@example.com/fe", "user", "b@example.com/be", "hello", null);
    await repo.cursors.advance(tx, "b@example.com/be", "direct", "b@example.com/be", 1);
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

// #270 D6 (principle 13): the service_invoke grant read is driven from the holder, 1 + its team count probes of the
// unique (principal_id, role, scope_id) index; never a scan of role_bindings or a pass over a service's holders by
// idx_role_bindings_scope, even with statistics that make role_bindings look small.
test("the service_invoke grant read probes by holder, never scans a service's holders", () => {
  const { db } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  db.run("ANALYZE");
  const plan = (db.prepare("EXPLAIN QUERY PLAN " + INVOKE_BINDING_SQL).all("a@example.com", "user", "ingest") as { detail: string }[]).map((p) => p.detail);
  expect(plan.filter((d) => d.includes(" b "))).toEqual([
    "SEARCH b USING COVERING INDEX idx_role_bindings_scoped (principal_id=? AND role=? AND scope_id=?)",
    "SEARCH b USING COVERING INDEX idx_role_bindings_scoped (principal_id=? AND role=? AND scope_id=?)",
  ]);
  expect(plan).toContain("SEARCH tm USING INDEX team_members_user (user_id=?)");
  expect(plan).toContain("SEARCH pt USING INDEX idx_principals_team (team_id=?)");
  expect(plan.join(" ")).not.toContain("idx_role_bindings_scope ");
  expect(plan.filter((d) => /^SCAN (b|h|s|tm|pt)\b/.test(d))).toEqual([]);
});

// #284 audit: queuedTo and retract read the read point by its key too.
test("queuedTo and retract look the read point up by its key, never a mailbox_cursors scan", async () => {
  const { db, repo } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  await seed(repo, async tx => {
    await repo.users.upsertByEmail(tx, "a@example.com", null);
    await repo.aliases.create(tx, person("a@example.com", "fe"), "a@example.com");
    await repo.users.upsertByEmail(tx, "b@example.com", null);
    await repo.aliases.create(tx, person("b@example.com", "be"), "b@example.com");
    await repo.messages.insert(tx, "a@example.com/fe", "user", "b@example.com/be", "hello", null);
    await repo.cursors.advance(tx, "b@example.com/be", "direct", "b@example.com/be", 1);
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
  expect((await repo.audit.last(repo.read, "dm.retract", "7"))?.detail).toBe("row 3");
});

// #807 P3 C7 (U3): last's tiebreak is pinned by its text. SQLite's reverse index scan gives ties in descending rowid
// with `ORDER BY at DESC` alone, so contract row U3 can't catch the `id DESC` dropped; Postgres breaks such ties by
// heap order, so it may not either (C67b pins pg/audit.ts's query text the same way).
test("audit.last orders by (at, id), newest first", () => {
  expect(ACCESS_LOG_LAST_SQL).toContain("ORDER BY at DESC, id DESC LIMIT 1");
});

// #807 P1c-5: a leaf store refuses a value that isn't a SQLite store handle. A settled Tx's refusal is a contract row
// on every backend (cursors.contract.ts K4, write_receipts.contract.ts), as are the store's answers.
test("#807 P1c-5: cursors and writeReceipts refuse a handle from another store", async () => {
  const { repo } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  const foreign = {} as typeof repo.read;
  await expect(repo.cursors.directFor(foreign, "a@example.com/fe")).rejects.toThrow("not a SQLite store handle");
  await expect(repo.cursors.advance(foreign as Tx, "a@example.com/fe", "direct", "a@example.com/fe", 1)).rejects.toThrow("not a SQLite store handle");
  await expect(repo.writeReceipts.refExists(foreign, "message", 1)).rejects.toThrow("not a SQLite store handle");
  await expect(repo.writeReceipts.claim(foreign as Tx, { session: "s", sender: "a@example.com/fe", fp: "f" }, "dm_send", 1)).rejects.toThrow("not a SQLite store handle");
  await expect(repo.audit.lock(foreign as Tx, "bridge.notified", "a@example.com/human")).rejects.toThrow("not a SQLite store handle");
  expect(() => repo.audit.write(foreign as Tx, { at: 1, actor: null, action: "auth.login", target: null, detail: null })).toThrow("not a SQLite store handle");
});

// #807 P1c-6: the sessions store runs on the handle it's given, as P1c-5's leaf stores do.
test("#807 P1c-6: sessions run on the handle they're given", async () => {
  const { repo } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  const { kept, s, u } = await seed(repo, async tx => {
    const u = await repo.users.upsertByEmail(tx, "a@example.com", null);
    const s = await repo.sessions.create(tx, u.id, "hash-a", "test");
    await repo.sessions.touch(tx, s.id, 7);
    return { kept: tx, s, u };
  });
  expect((await repo.sessions.findByTokenHash(repo.read, "hash-a"))?.id).toBe(s.id);
  expect((await repo.sessions.findById(repo.read, s.id))?.last_used_at).toBe(7);
  const settled = /used after its transaction settled/;
  await expect(repo.sessions.create(kept, u.id, "hash-b", "test")).rejects.toThrow(settled);
  await expect(repo.sessions.findByTokenHash(kept, "hash-a")).rejects.toThrow(settled);
  await expect(repo.sessions.findById(kept, s.id)).rejects.toThrow(settled);
  await expect(repo.sessions.revoke(kept, s.id)).rejects.toThrow(settled);
  await expect(repo.sessions.revokeAllForUser(kept, u.id)).rejects.toThrow(settled);
  await expect(repo.sessions.revokeDev(kept)).rejects.toThrow(settled);
  await expect(repo.sessions.touch(kept, s.id, 9)).rejects.toThrow(settled);
  const foreign = {} as typeof repo.read;
  await expect(repo.sessions.findById(foreign, s.id)).rejects.toThrow("not a SQLite store handle");
  const after = (await repo.sessions.findById(repo.read, s.id))!;
  expect(after.revoked_at).toBeNull();
  expect(after.last_used_at).toBe(7);
  expect(await repo.sessions.findByTokenHash(repo.read, "hash-b")).toBeUndefined();
});

// #807 P1c-7: the users store's writes and reads run on the handle they're given, as P1c-6's sessions do.
test("#807 P1c-7: the users store runs on the handle it's given", async () => {
  const { repo } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  const { kept, u } = await seed(repo, async tx => ({ kept: tx, u: await repo.users.upsertByEmail(tx, "a@example.com", null) }));
  const settled = /used after its transaction settled/;
  await expect(repo.users.upsertByEmail(kept, "b@example.com", null)).rejects.toThrow(settled);
  await expect(repo.users.signIn(kept, GOOGLE_ISSUER, "s-1", "c@example.com", null)).rejects.toThrow(settled);
  await expect(repo.users.clearSubject(kept, u.id)).rejects.toThrow(settled);
  await expect(repo.users.setDisabled(kept, u.id, true)).rejects.toThrow(settled);
  await expect(repo.users.setDisabled({} as Tx, u.id, true)).rejects.toThrow("not a SQLite store handle");
  expect((await repo.users.findByEmail(repo.read, "b@example.com"))).toBeUndefined();
  expect((await repo.users.findByEmail(repo.read, "c@example.com"))).toBeUndefined();
  expect((await repo.users.findById(repo.read, u.id))?.disabled_at).toBeNull();
  // Reads refuse a kept or foreign handle too, the cached ones even on a hit: isDisabled fills the user cache first.
  expect(await repo.users.isDisabled(repo.read, u.id)).toBe(false);
  for (const h of [kept, {} as Tx]) {
    const refused = h === kept ? settled : /not a SQLite store handle/;
    await expect(repo.users.findById(h, u.id)).rejects.toThrow(refused);
    await expect(repo.users.isDisabled(h, u.id)).rejects.toThrow(refused);
    await expect(repo.users.active(h, u.id).then((u) => u?.email)).rejects.toThrow(refused);
  }
});

// #807 P1c-8: the OAuth store runs on the handle it's given, as P1c-6's sessions do. The facade resolves the handle
// before it reads any argument, so a kept Tx is refused whatever the rest of the call says.
test("#807 P1c-8: the OAuth store runs on the handle it's given", async () => {
  const { repo } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  const kept = await seed(repo, async tx => {
    await repo.oauth.cleanup(tx, 1);
    return tx;
  });
  const settled = /used after its transaction settled/;
  const x = {} as never;
  const o = repo.oauth;
  // A refused change notifies no hosted observer: the notice waits for the async op to fulfil (#807 P3 A6c).
  let notices = 0;
  const unsubscribe = repo.hosted.subscribe(() => { notices++; });
  await expect(o.createRequest(kept, x, 1)).rejects.toThrow(settled);
  await expect(o.bindRequestSession(kept, "r", "b", "s", 1)).rejects.toThrow(settled);
  await expect(o.createBrowserSession(kept, x, 1)).rejects.toThrow(settled);
  await expect(o.revokeBrowserSession(kept, "s")).rejects.toThrow(settled);
  await expect(o.decideRequest(kept, x, 1)).rejects.toThrow(settled);
  await expect(o.redeemCode(kept, x, 1)).rejects.toThrow(settled);
  await expect(o.redeemLoginCode(kept, x, 1)).rejects.toThrow(settled);
  await expect(o.rotateRefresh(kept, x, 1)).rejects.toThrow(settled);
  await expect(o.revokeToken(kept, "t", "c", 1)).rejects.toThrow(settled);
  await expect(o.revokePreBuiltinGrants(kept, ["c"], 1)).rejects.toThrow(settled);
  await expect(o.cleanup(kept, 1)).rejects.toThrow(settled);
  await expect(o.findRequest(kept, "r", "b", 1)).rejects.toThrow(settled);
  await expect(o.findBrowserSession(kept, "s", 1)).rejects.toThrow(settled);
  await expect(o.findCodeScopes(kept, "c", "c", "r", "u", 1)).rejects.toThrow(settled);
  await expect(o.findRefreshGrant(kept, "h", "c", "r", 1)).rejects.toThrow(settled);
  await expect(o.findActiveAccess(kept, "h", "r", [], 1)).rejects.toThrow(settled);
  await expect(o.isGrantActive(kept, "g", 1)).rejects.toThrow(settled);
  await expect(o.revokeToken({} as Tx, "t", "c", 1)).rejects.toThrow("not a SQLite store handle");
  expect(notices).toBe(0);
  await seed(repo, tx => o.revokeToken(tx, "t", "c", 1));
  expect(notices).toBe(1);
  unsubscribe();
  expect(await o.isGrantActive(repo.read, "g", 1)).toBe(false);
  // A warm access cache still resolves the handle first.
  const issued = await issueOAuth(repo, "https://grayboard.example.com/mcp");
  const live = () => o.findActiveAccess(repo.read, hashToken(issued.token), issued.binding.resource, [], issued.now);
  expect(await live()).toBeDefined();
  expect(await live()).toBeDefined();
  await expect(o.findActiveAccess(kept, hashToken(issued.token), issued.binding.resource, [], issued.now)).rejects.toThrow(settled);
});

// #807 P1c-9: the Slack store runs on the handle it's given, as P1c-6's sessions do.
test("#807 P1c-9: the Slack store runs on the handle it's given", async () => {
  const { repo } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  const t = { thread_ts: "1.1", kind: "dm" as const, board: null, root_id: 1, peer: null, last_id: 1 };
  const { kept, u } = await seed(repo, async tx => {
    const u = await repo.users.upsertByEmail(tx, "a@example.com", null);
    await repo.slack.link(tx, u.id, "U1", "D1");
    await repo.slack.addThread(tx, u.id, t);
    await repo.slack.setProgress(tx, u.id, "dm:1", { posted: true });
    return { kept: tx, u };
  });
  const settled = /used after its transaction settled/;
  const s = repo.slack;
  await expect(s.link(kept, u.id, "U2", "D2")).rejects.toThrow(settled);
  await expect(s.unlink(kept, u.id)).rejects.toThrow(settled);
  await expect(s.addThread(kept, u.id, { ...t, thread_ts: "2.2" })).rejects.toThrow(settled);
  await expect(s.advanceThread(kept, u.id, "1.1", 9)).rejects.toThrow(settled);
  await expect(s.setProgress(kept, u.id, "dm:1", { posted: false })).rejects.toThrow(settled);
  await expect(s.clearProgress(kept, u.id, "dm:1")).rejects.toThrow(settled);
  await expect(s.links(kept)).rejects.toThrow(settled);
  await expect(s.linkFor(kept, u.id)).rejects.toThrow(settled);
  await expect(s.linkBySlackUser(kept, "U1")).rejects.toThrow(settled);
  await expect(s.thread(kept, u.id, "dm", null, 1)).rejects.toThrow(settled);
  await expect(s.threadByTs(kept, u.id, "1.1")).rejects.toThrow(settled);
  await expect(s.progress(kept, u.id, "dm:1")).rejects.toThrow(settled);
  await expect(s.lock(kept)).rejects.toThrow(settled);
  await expect(s.linkFor({} as Tx, u.id)).rejects.toThrow("not a SQLite store handle");
  await expect(s.lock({} as Tx)).rejects.toThrow("not a SQLite store handle");
  expect(await s.links(repo.read)).toMatchObject([{ user_id: u.id, slack_user: "U1", dm_channel: "D1" }]);
  expect(await s.linkBySlackUser(repo.read, "U2")).toBeUndefined();
  expect((await s.threadByTs(repo.read, u.id, "1.1"))?.last_id).toBe(1);
  expect((await s.thread(repo.read, u.id, "dm", null, 1))?.thread_ts).toBe("1.1");
  expect(await s.threadByTs(repo.read, u.id, "2.2")).toBeUndefined();
  expect(await s.progress(repo.read, u.id, "dm:1")).toEqual({ posted: true });
});

// #807 P1c-10: the teams store's writes run on the handle they're given, as P1c-7's users writes do.
test("#807 P1c-10: team writes run on the handle they're given", async () => {
  const { repo } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  const { kept, t, a, b } = await seed(repo, async tx => {
    const a = await repo.users.upsertByEmail(tx, "a@example.com", null), b = await repo.users.upsertByEmail(tx, "b@example.com", null);
    const t = await repo.teams.create(tx, "ops", a.id);
    await repo.teams.addMember(tx, t.id, a.id);
    await grantOwner(repo, tx, "ops", "a@example.com");
    return { kept: tx, t, a, b };
  });
  const settled = /used after its transaction settled/;
  await expect(repo.teams.create(kept, "dev", a.id)).rejects.toThrow(settled);
  await expect(repo.teams.addMember(kept, t.id, b.id)).rejects.toThrow(settled);
  await expect(repo.teams.removeMember(kept, t.id, a.id)).rejects.toThrow(settled);
  await expect(repo.teams.setPolicy(kept, t.id, "collaborative")).rejects.toThrow(settled);
  await expect(repo.teams.addMember({} as Tx, t.id, b.id)).rejects.toThrow("not a SQLite store handle");
  expect((await repo.teams.findByName(repo.read, "dev"))).toBeUndefined();
  expect((await repo.teams.listMembers(repo.read, t.id))).toEqual([{ user_id: a.id, email: "a@example.com", role: "owner" }]);
  expect((await repo.teams.findByName(repo.read, "ops"))?.policy).toBe("open");
});

// #807 P1c-11/P1c-12: the hosted store refuses a handle that isn't a SQLite store's, the three lock seams (#807 P3 C8a)
// among them; its settled-Tx refusals are contract rows (store/hosted.contract.ts).
test("#807 P1c-11: the hosted store refuses a foreign handle", async () => {
  const { repo } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  const h = repo.hosted, foreign = {} as Tx, refused = "not a SQLite store handle";
  await expect(h.touch(foreign, "root-1", 9)).rejects.toThrow(refused);
  await expect(h.get(foreign, "root-1")).rejects.toThrow(refused);
  await expect(h.lock(foreign, "root-1")).rejects.toThrow(refused);
  await expect(h.lockCapacity(foreign)).rejects.toThrow(refused);
  await expect(h.grantLive(foreign, "g", 1)).rejects.toThrow(refused);
  repo.close();
});

// #807 P1c-13: the aliases store runs on the handle it's given, as P1c-6's sessions do.
test("#807 P1c-13: the aliases store runs on the handle it's given", async () => {
  const { repo } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  const { kept } = await seed(repo, async tx => {
    await repo.users.upsertByEmail(tx, "a@example.com", null);
    await repo.aliases.create(tx, person("a@example.com", "fe"), "a@example.com");
    // Read inside the body that wrote it, on its Tx.
    expect((await repo.aliases.find(tx, "a@example.com/fe"))?.name).toBe("fe");
    return { kept: tx };
  });
  const settled = /used after its transaction settled/;
  const a = repo.aliases;
  expect(() => a.create(kept, person("a@example.com", "be"), "a@example.com")).toThrow(settled);
  expect(() => a.remove(kept, "a@example.com/fe")).toThrow(settled);
  await expect(a.find(kept, "a@example.com/fe")).rejects.toThrow(settled);
  await expect(a.listForScope(kept, "person", "a@example.com")).rejects.toThrow(settled);
  await expect(a.countForScope(kept, "person", "a@example.com")).rejects.toThrow(settled);
  await expect(a.findAllByName(kept, "fe")).rejects.toThrow(settled);
  await expect(a.lock(kept, "a@example.com/fe", "delete")).rejects.toThrow(settled);
  await expect(a.lockScope(kept, { scope_kind: "person", scope_ref: "a@example.com" })).rejects.toThrow(settled);
  await expect(a.lockScope({} as Tx, { scope_kind: "person", scope_ref: "a@example.com" })).rejects.toThrow("not a SQLite store handle");
  await expect(a.find({} as Tx, "a@example.com/fe")).rejects.toThrow("not a SQLite store handle");
  expect(await a.find(repo.read, "a@example.com/be")).toBeUndefined();
  expect((await a.listForScope(repo.read, "person", "a@example.com")).map(x => x.name)).toEqual(["fe"]);
  expect((await a.countForScope(repo.read, "person", "a@example.com"))).toBe(1);
  expect((await a.findAllByName(repo.read, "fe")).map(x => x.address)).toEqual(["a@example.com/fe"]);
  // A create rolls back with its body, and a remove's read points with it.
  await expect(seed(repo, tx => {
    a.create(tx, person("a@example.com", "qa"), "a@example.com");
    a.remove(tx, "a@example.com/fe");
    throw new Error("rolled back");
  })).rejects.toThrow("rolled back");
  expect(await a.find(repo.read, "a@example.com/qa")).toBeUndefined();
  expect((await a.find(repo.read, "a@example.com/fe"))?.name).toBe("fe");
});

// #807 P1c-14a: the messages store's writes run on the Tx they're given (the mail port's moved into repo.sessionEnd.end,
// whose handle test is P3 B4a's).
test("#807 P1c-14a: the messages writes run on the Tx they're given", async () => {
  const { repo } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  const [id, peer] = ["id:s1", "b@example.com/be"];
  const { kept, first, second } = await seed(repo, async tx => {
    const first = await repo.messages.insert(tx, peer, "user", id, "first", null);
    const second = await repo.messages.insert(tx, peer, "user", id, "second", null);
    await repo.cursors.advance(tx, id, "direct", id, first.id);
    return { kept: tx, first, second };
  });
  const settled = /used after its transaction settled/;
  const m = repo.messages;
  await expect(m.insert(kept, peer, "user", id, "late", null)).rejects.toThrow(settled);
  await expect(m.ack(kept, id, first.id)).rejects.toThrow(settled);
  await expect(m.markDelivered(kept, first.id, 1)).rejects.toThrow(settled);
  await expect(m.retract(kept, peer, second.id, { actor: null, session: null })).rejects.toThrow(settled);
  await expect(m.prune(kept, Date.now() + 1)).rejects.toThrow(settled);
  await expect(m.ack({} as Tx, id, first.id)).rejects.toThrow("not a SQLite store handle");
  // Every write rolls back with its body. On SQLite the resolved connection is the ambient one, so only the kept-Tx
  // refusals above tell them apart; this half discriminates on Postgres.
  await expect(seed(repo, async tx => {
    await m.insert(tx, peer, "user", id, "rolled back", null);
    await m.ack(tx, id, first.id);
    await m.markDelivered(tx, first.id, 1234);
    expect(await m.retract(tx, peer, second.id, { actor: null, session: null })).toBe("retracted");
    throw new Error("rolled back");
  })).rejects.toThrow("rolled back");
  expect((await m.history(repo.read, [id])).map(x => x.body)).toEqual(["second", "first"]);
  expect((await m.receivedUnacked(repo.read, [id], 0)).map(x => x.id)).toEqual([first.id, second.id]);
  expect((await m.getById(repo.read, first.id))?.delivered_at).toBeNull();
  expect(await repo.cursors.directFor(repo.read, id)).toBe(first.id);
  await expect(seed(repo, async tx => { await m.prune(tx, Date.now() + 1); throw new Error("rolled back"); })).rejects.toThrow("rolled back");
  expect((await m.history(repo.read, [id]))).toHaveLength(2);
});

// #807 P1c-14b: the messages store's reads, and aliases.seen, run on the handle they're given.
test("#807 P1c-14b: the messages reads and aliases.seen run on the handle they're given", async () => {
  const { repo, db } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  const [id, peer] = ["id:s1", "b@example.com/be"];
  const m = repo.messages;
  const { kept, root, reply } = await seed(repo, async tx => {
    await repo.users.upsertByEmail(tx, "b@example.com", null);
    await repo.aliases.create(tx, person("b@example.com", "be"), "b@example.com");
    const root = await m.insert(tx, peer, "user", id, "root", null, true);
    const reply = await m.insert(tx, id, "user", peer, "reply", root.id);
    db.run("UPDATE aliases SET last_seen = 1000 WHERE address = ?", [peer]);
    // Read inside the body that wrote them, on its Tx. On SQLite the pool routes to the writer inside a transaction
    // too, so this half discriminates only on Postgres; the kept-Tx and foreign-handle refusals below are the SQLite check.
    expect((await m.getById(tx, reply.id))?.parent_id).toBe(root.id);
    expect((await m.thread(tx, reply.id)).map(x => x.id)).toEqual([root.id, reply.id]);
    expect((await m.history(tx, [id])).map(x => x.id)).toEqual([reply.id, root.id]);
    expect((await repo.aliases.seen(tx, [peer])).get(peer)?.last_seen).toBe(1000);
    return { kept: tx, root, reply };
  });
  const settled = /used after its transaction settled/;
  const streams = [{ type: "direct" as const, ref: id, since: 0 }];
  await expect(m.getById(kept, root.id)).rejects.toThrow(settled);
  await expect(m.writerUsers(kept, [root.id], [])).rejects.toThrow(settled);
  await expect(m.delegationIds(kept, [root.id])).rejects.toThrow(settled);
  await expect(m.bouncesFrom(kept, id)).rejects.toThrow(settled);
  await expect(m.history(kept, [id])).rejects.toThrow(settled);
  await expect(m.thread(kept, root.id)).rejects.toThrow(settled);
  await expect(m.unreadSince(kept, streams)).rejects.toThrow(settled);
  await expect(m.queuedTo(kept, [id])).rejects.toThrow(settled);
  await expect(m.undeliveredFrom(kept, [peer])).rejects.toThrow(settled);
  await expect(m.receivedUnacked(kept, [id], 0)).rejects.toThrow(settled);
  await expect(m.sentPending(kept, [peer], 0)).rejects.toThrow(settled);
  await expect(repo.aliases.seen(kept, [peer])).rejects.toThrow(settled);
  await expect(m.getById({} as Tx, root.id)).rejects.toThrow("not a SQLite store handle");
  await expect(repo.aliases.seen({} as Tx, [peer])).rejects.toThrow("not a SQLite store handle");
  // The pool reads what the body committed.
  const r = repo.read;
  expect((await m.getById(r, root.id))?.body).toBe("root");
  expect((await m.writerUsers(r, [root.id], [])).messages.size).toBe(0);
  expect((await m.delegationIds(r, [root.id])).size).toBe(0);
  expect((await m.bouncesFrom(r, id))).toEqual([]);
  expect((await m.thread(r, root.id)).map(x => x.id)).toEqual([root.id, reply.id]);
  expect((await m.unreadSince(r, streams)).map(x => x.id)).toEqual([root.id]);
  expect((await m.queuedTo(r, [id])).get(id)).toBe(1);
  expect((await m.undeliveredFrom(r, [peer])).map(u => u.recipient)).toEqual([id]);
  expect((await m.receivedUnacked(r, [id], 0)).map(x => x.id)).toEqual([root.id]);
  expect((await m.sentPending(r, [peer], 0)).map(x => x.id)).toEqual([root.id]);
  expect((await repo.aliases.seen(r, [peer, "b@example.com/none"]))).toEqual(new Map([[peer, { last_seen: 1000, cwd: null, place: null }]]));
});

test("#807 P3 B1a: the bindings reads run on the handle they're given; the batched ones keep HOLD_ORDER and leave misses out", async () => {
  const { repo, db } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  const [s1, s2, idle] = ["id:0000000000001", "id:0000000000002", "id:0000000000003"];
  const [fe, be, ops, zz] = ["b@example.com/fe", "b@example.com/be", "b@example.com/ops", "b@example.com/zz"];
  const b = repo.bindings;
  const kept = await seed(repo, async tx => {
    await repo.users.upsertByEmail(tx, "b@example.com", null);
    for (const n of ["fe", "be", "ops", "zz"]) await repo.aliases.create(tx, person("b@example.com", n), "b@example.com");
    const core = repo.coreOn(tx);
    for (const id of [s1, s2, idle]) registerId(core, { id, principal: "b@example.com", launcher: false });
    // s1's be is bound after its fe, and in the same millisecond: HOLD_ORDER keeps fe first.
    holdAlias(core, fe, s1, 500);
    holdAlias(core, be, s1, 500);
    holdAlias(core, ops, s2, 100);
    // s2's zz is written after its ops but bound before it: HOLD_ORDER disagrees with rowid and address order.
    holdAlias(core, zz, s2, 100);
    db.run("UPDATE alias_holds SET bound_at = 50 WHERE address = ?", [zz]);
    db.run("UPDATE ids SET status = 'busy', status_at = 7, last_seen = 900 WHERE id = ?", [s2]);
    db.run("UPDATE aliases SET last_seen = 1000 WHERE address = ?", [fe]);
    // Inside the body that wrote them, on its Tx.
    expect(await b.holdsOf(tx, s1)).toEqual([fe, be]);
    expect(await b.holderOf(tx, ops)).toBe(s2);
    return tx;
  });
  const settled = /used after its transaction settled/;
  await expect(b.holdsOf(kept, s1)).rejects.toThrow(settled);
  await expect(b.holdsOfMany(kept, [s1])).rejects.toThrow(settled);
  await expect(b.holderOf(kept, fe)).rejects.toThrow(settled);
  await expect(b.holdersOf(kept, [fe])).rejects.toThrow(settled);
  await expect(b.userOf(kept, fe)).rejects.toThrow(settled);
  await expect(b.addressSet(kept, fe, "b@example.com")).rejects.toThrow(settled);
  await expect(b.idRow(kept, s1)).rejects.toThrow(settled);
  await expect(b.unendedIds(kept)).rejects.toThrow(settled);
  await expect(b.idStatuses(kept, [s2])).rejects.toThrow(settled);
  await expect(b.aliasUses(kept, null)).rejects.toThrow(settled);
  await expect(b.lastSeen(kept, [fe])).rejects.toThrow(settled);
  await expect(b.holdsOf({} as Tx, s1)).rejects.toThrow("not a SQLite store handle");
  const r = repo.read;
  expect(await b.holdsOfMany(r, [s1, s2, idle])).toEqual(new Map([[s1, [fe, be]], [s2, [zz, ops]], [idle, []]]));
  expect(await b.holdersOf(r, [fe, ops, "b@example.com/none"])).toEqual(new Map([[fe, s1], [ops, s2]]));
  expect(await b.userOf(r, fe)).toBe(s1);
  expect(await b.userOf(r, fe, "b@example.com")).toBeNull();
  expect(await b.addressSet(r, be, "b@example.com")).toEqual([be, fe, s1]);
  expect(await b.addressSet(r, be, "c@example.com")).toEqual([be]);
  expect((await b.idRow(r, s1))?.principal).toBe("b@example.com");
  expect(await b.idRow(r, "id:000000000000Z")).toBeUndefined();
  expect((await b.unendedIds(r)).sort()).toEqual([s1, s2, idle]);
  expect(await b.idStatuses(r, [s1, s2])).toEqual(new Map([[s2, { status: "busy", status_at: 7 }]]));
  expect((await b.aliasUses(r, "b@example.com")).map(u => u.address).sort()).toEqual([be, fe, ops, zz]);
  // An alias's and a session's last-seen, a repeat once, a never-seen alias absent (an ids row always has one).
  expect(await b.lastSeen(r, [fe, s2, fe, be])).toEqual(new Map([[fe, 1000], [s2, 900]]));
});

test("#807 P3 B1c: bindings.take refuses another ID's hold and another user's writer, re-takes its own, and orders one ID's takes", async () => {
  const { repo, db } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  const [s1, s2, bWriter, cWriter] = ["id:0000000000001", "id:0000000000002", "id:0000000000003", "id:0000000000004"];
  const [fe, be, ops, qa] = ["b@example.com/fe", "b@example.com/be", "b@example.com/ops", "b@example.com/qa"];
  const holds = () => db.query("SELECT address, id, bound_at FROM alias_holds ORDER BY address").all();
  await seed(repo, async tx => {
    for (const u of ["b@example.com", "c@example.com"]) await repo.users.upsertByEmail(tx, u, null);
    for (const n of ["fe", "be", "ops", "qa"]) await repo.aliases.create(tx, person("b@example.com", n), "b@example.com");
    const core = repo.coreOn(tx);
    for (const id of [s1, s2]) registerId(core, { id, principal: "b@example.com", launcher: false });
    // A tools-only writer as fe of another user, and one as be of the same user.
    registerId(core, { id: cWriter, principal: "c@example.com", launcher: false, writesAs: fe });
    registerId(core, { id: bWriter, principal: "b@example.com", launcher: false, writesAs: be });
    holdAlias(core, ops, s2, 100);
  });
  const take = (address: string, id: string, now: number) => repo.write(tx => repo.bindings.take(tx, address, id, "b@example.com", now));
  // Another ID's hold, the same user's: no take, and its row stays as it was.
  expect(await take(ops, s1, 200)).toBeNull();
  // Another user's unended writer: no take.
  expect(await take(fe, s1, 200)).toBeNull();
  expect(holds()).toEqual([{ address: ops, id: s2, bound_at: 100 }]);
  // The same user's writer shares the alias with a holder.
  expect(await take(be, s1, 300)).toEqual({ bound_at: 300 });
  // Two takes by one ID in one millisecond keep their order (holdAlias's contract).
  expect(await take(qa, s1, 300)).toEqual({ bound_at: 301 });
  // The same ID's re-take restamps its own hold.
  expect(await take(be, s1, 400)).toEqual({ bound_at: 400 });
  expect(holds()).toEqual([{ address: be, id: s1, bound_at: 400 }, { address: ops, id: s2, bound_at: 100 }, { address: qa, id: s1, bound_at: 301 }]);
});

// #807 P3 B4a: repo.sessionEnd runs on the handle it's given: a kept Tx and a non-store handle are refused, and an end
// rolls back with its body (its bounce, cursor drop and ended_at with it).
test("#807 P3 B4a: sessionEnd runs on the Tx it's given and rolls back with its body", async () => {
  const { repo } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  const [id, peer] = ["id:0000000000001", "b@example.com/be"];
  const { kept, unread } = await seed(repo, async tx => {
    registerId(repo.coreOn(tx), { id, principal: "a@example.com", launcher: false });
    const read = await repo.messages.insert(tx, peer, "user", id, "read", null);
    const unread = await repo.messages.insert(tx, peer, "user", id, "unread", null);
    await repo.cursors.advance(tx, id, "direct", id, read.id);
    return { kept: tx, unread };
  });
  const settled = /used after its transaction settled/;
  const e = repo.sessionEnd;
  await expect(e.end(kept, id, { why: "t", now: 1 })).rejects.toThrow(settled);
  await expect(e.refusal(kept, id)).rejects.toThrow(settled);
  await expect(e.pruneEnded(kept, 1, 1)).rejects.toThrow(settled);
  await expect(e.refusal({} as Tx, id)).rejects.toThrow("not a SQLite store handle");
  await expect(seed(repo, async tx => {
    expect((await e.end(tx, id, { why: "t", now: 5 })).ended).toBe(true);
    expect((await e.refusal(tx, id))?.code).toBe("id_ended");
    throw new Error("rolled back");
  })).rejects.toThrow("rolled back");
  expect(await seed(repo, tx => e.refusal(tx, id))).toBeNull();
  expect((await repo.messages.history(repo.read, [peer])).filter(m => m.kind === "bounce")).toEqual([]);
  expect(await repo.cursors.directFor(repo.read, id)).toBeGreaterThan(0);
  // Committed, the end bounces the unread message and the ID refuses delivery.
  expect((await seed(repo, tx => e.end(tx, id, { why: "t", now: 5 }))).ended).toBe(true);
  expect((await repo.messages.history(repo.read, [peer])).filter(m => m.kind === "bounce").map(m => m.parent_id)).toEqual([unread.id]);
  expect((await seed(repo, tx => e.refusal(tx, id)))?.code).toBe("id_ended");
});

// #807 P3 B5a1: repo.boards runs on the handle it's given: a kept Tx and a non-store handle are refused, a read inside
// a body sees that body's writes, and an acknowledge rolls back with its body.
test("#807 P3 B5a1: repo.boards runs on the handle it's given; acknowledge rolls back with its body", async () => {
  const { repo } = fresh();
  const [be, fe] = ["a@example.com/be", "a@example.com/fe"];
  const { kept, id } = await seed(repo, async tx => {
    // A board reads as missing to an address no principal owns (#284).
    await repo.users.upsertByEmail(tx, "a@example.com", null);
    for (const name of ["be", "fe"]) await repo.aliases.create(tx, person("a@example.com", name), "a@example.com");
    const core = repo.coreOn(tx);
    createBoard(core, be, "hall", "tests");
    subscribe(core, fe, "hall", "push");
    return { kept: tx, id: post(core, be, "hall", "hi").post.id };
  });
  const settled = /used after its transaction settled/;
  const b = repo.boards;
  const ref = { kind: "push" as const, post_id: id };
  await expect(b.get(kept, "hall")).rejects.toThrow(settled);
  await expect(b.post(kept, id)).rejects.toThrow(settled);
  await expect(b.catalogPage(kept, "")).rejects.toThrow(settled);
  await expect(b.snapshotPage(kept, "hall", {})).rejects.toThrow(settled);
  await expect(b.pendingPushes(kept, fe)).rejects.toThrow(settled);
  await expect(b.pendingDigests(kept, fe)).rejects.toThrow(settled);
  await expect(b.acknowledge(kept, fe, ref)).rejects.toThrow(settled);
  await expect(b.get({} as Tx, "hall")).rejects.toThrow("not a SQLite store handle");
  expect((await b.get(repo.read, "hall"))?.name).toBe("hall");
  expect((await b.post(repo.read, id))?.body).toBe("hi");
  expect((await b.catalogPage(repo.read, "")).map(x => x.name)).toContain("hall");
  expect((await b.snapshotPage(repo.read, "hall", {})).posts.map(p => p.id)).toEqual([id]);
  const pushed = async (r: Parameters<typeof b.pendingPushes>[0]) => (await b.pendingPushes(r, fe)).map(p => p.post.id);
  expect(await pushed(repo.read)).toEqual([id]);
  await expect(seed(repo, async tx => {
    await b.acknowledge(tx, fe, ref);
    expect(await pushed(tx)).toEqual([]);
    throw new Error("rolled back");
  })).rejects.toThrow("rolled back");
  expect(await pushed(repo.read)).toEqual([id]);
  await seed(repo, tx => b.acknowledge(tx, fe, ref));
  expect(await pushed(repo.read)).toEqual([]);
});

// #807 P3 B5b1: the board writes outside the tools run on the handle they're given: a kept Tx and a non-store handle are
// refused, and a body that ensures a board and subscribes, then throws, leaves neither.
test("#807 P3 B5b1: repo.boards writes run on the Tx they're given and roll back with their body", async () => {
  const { repo, db } = fresh();
  const [be, fe] = ["a@example.com/be", "a@example.com/fe"];
  const kept = await seed(repo, async tx => {
    await repo.users.upsertByEmail(tx, "a@example.com", null);
    for (const name of ["be", "fe"]) await repo.aliases.create(tx, person("a@example.com", name), "a@example.com");
    return tx;
  });
  const settled = /used after its transaction settled/;
  const b = repo.boards;
  await expect(b.ensure(kept, "hall", "p", null, be)).rejects.toThrow(settled);
  await expect(b.isSubscribed(kept, be, "hall")).rejects.toThrow(settled);
  await expect(b.setSubscription(kept, be, "hall", "push")).rejects.toThrow(settled);
  await expect(b.unsubscribeScope(kept, be, "team:x")).rejects.toThrow(settled);
  await expect(b.forget(kept, be)).rejects.toThrow(settled);
  await expect(b.prunePosts(kept, 0)).rejects.toThrow(settled);
  await expect(repo.aliases.markHuman(kept, be, true)).rejects.toThrow(settled);
  const stranger = /not a SQLite store handle/;
  await expect(b.ensure({} as Tx, "hall", "p", null, be)).rejects.toThrow(stranger);
  await expect(b.isSubscribed({} as Tx, be, "hall")).rejects.toThrow(stranger);
  await expect(b.setSubscription({} as Tx, be, "hall", "push")).rejects.toThrow(stranger);
  await expect(b.unsubscribeScope({} as Tx, be, "team:x")).rejects.toThrow(stranger);
  await expect(b.forget({} as Tx, be)).rejects.toThrow(stranger);
  await expect(b.prunePosts({} as Tx, 0)).rejects.toThrow(stranger);
  await expect(repo.aliases.markHuman({} as Tx, be, true)).rejects.toThrow(stranger);
  const human = async () => db.query<{ human: number | null }, [string]>("SELECT human FROM aliases WHERE address = ?").get(fe)?.human ?? null;
  await expect(seed(repo, async tx => {
    expect(await b.ensure(tx, "hall", "p", "team:x", be)).toBe(true);
    expect(await b.ensure(tx, "hall", "other", null, fe)).toBe(false);
    await b.setSubscription(tx, fe, "hall", "digest");
    expect(await b.isSubscribed(tx, fe, "hall")).toBe(true);
    await repo.aliases.markHuman(tx, fe, true);
    throw new Error("rolled back");
  })).rejects.toThrow("rolled back");
  expect(await b.get(repo.read, "hall")).toBeUndefined();
  expect(await b.isSubscribed(repo.read, fe, "hall")).toBe(false);
  expect(await human()).toBeFalsy();
  // Committed: a subscription starts at the tip, so the post before it is no backlog; "off" and a scope's drop delete it.
  const id = await seed(repo, async tx => {
    await b.ensure(tx, "hall", "p", null, be);
    await b.ensure(tx, "crew", "p", "team:x", be);
    const id = post(repo.coreOn(tx), be, "hall", "before").post.id;
    await b.setSubscription(tx, fe, "hall", "push");
    await repo.aliases.markHuman(tx, fe, true);
    return id;
  });
  expect((await b.get(repo.read, "hall"))?.purpose).toBe("p");
  expect(db.query("SELECT cursor, notified_id FROM subscriptions WHERE handle = ? AND board = 'hall'").get(fe)).toEqual({ cursor: id, notified_id: id });
  expect(await human()).toBeTruthy();
  await seed(repo, tx => b.setSubscription(tx, fe, "hall", "off"));
  expect(await b.isSubscribed(repo.read, fe, "hall")).toBe(false);
  await seed(repo, tx => b.setSubscription(tx, fe, "crew", "digest"));
  await seed(repo, tx => b.unsubscribeScope(tx, fe, "team:other"));
  expect(await b.isSubscribed(repo.read, fe, "crew")).toBe(true);
  await seed(repo, tx => b.unsubscribeScope(tx, fe, "team:x"));
  expect(await b.isSubscribed(repo.read, fe, "crew")).toBe(false);
  await seed(repo, tx => b.setSubscription(tx, fe, "hall", "push"));
  await seed(repo, tx => b.forget(tx, fe));
  expect(await b.isSubscribed(repo.read, fe, "hall")).toBe(false);
  // The prune names the boards that lost posts, and the post goes.
  expect(await seed(repo, tx => b.prunePosts(tx, Date.now() + 1))).toEqual(["hall"]);
  expect(await b.post(repo.read, id)).toBeUndefined();
  await seed(repo, tx => repo.aliases.markHuman(tx, fe, false));
  expect(await human()).toBeFalsy();
});

// #807 P3 B5b1b1: the board tools' reads and session writes run on the handle they're given: a kept Tx and a non-store
// handle are refused, a read inside a body sees that body's writes, and a status or queue opt-out rolls back with its body.
test("#807 P3 B5b1b1: the board tools' repo reads and writes run on the handle they're given", async () => {
  const { repo, db } = fresh();
  const [be, fe] = ["a@example.com/be", "a@example.com/fe"];
  const [s1, tail, solo] = ["id:0000000000001", "id:0000000000002", "id:0000000000003"];
  const kept = await seed(repo, async tx => {
    await repo.users.upsertByEmail(tx, "a@example.com", null);
    for (const name of ["be", "fe"]) await repo.aliases.create(tx, person("a@example.com", name), "a@example.com");
    const core = repo.coreOn(tx);
    registerId(core, { id: s1, principal: "a@example.com", launcher: false, harness: "pi", model: "m1" });
    registerId(core, { id: tail, principal: "a@example.com", launcher: false, viewer: true });
    registerId(core, { id: solo, principal: "a@example.com", launcher: true });
    holdAlias(core, be, s1, 100);
    touchAlias(core, be, 100);
    createBoard(core, be, "hall", "tests");
    subscribe(core, fe, "hall", "digest");
    post(core, be, "hall", "hi");
    return tx;
  });
  const settled = /used after its transaction settled/;
  const stranger = /not a SQLite store handle/;
  const [b, i] = [repo.boards, repo.bindings];
  await expect(b.views(kept, [fe], null)).rejects.toThrow(settled);
  await expect(b.openSummaries(kept)).rejects.toThrow(settled);
  await expect(b.roster(kept, null)).rejects.toThrow(settled);
  await expect(i.viewerIds(kept)).rejects.toThrow(settled);
  await expect(i.idFacts(kept, [s1])).rejects.toThrow(settled);
  await expect(i.setStatus(kept, be, "x", 1)).rejects.toThrow(settled);
  await expect(i.setQueueParticipation(kept, be, false)).rejects.toThrow(settled);
  await expect(b.views({} as Tx, [fe], null)).rejects.toThrow(stranger);
  await expect(b.openSummaries({} as Tx)).rejects.toThrow(stranger);
  await expect(b.roster({} as Tx, null)).rejects.toThrow(stranger);
  await expect(i.viewerIds({} as Tx)).rejects.toThrow(stranger);
  await expect(i.idFacts({} as Tx, [s1])).rejects.toThrow(stranger);
  await expect(i.setStatus({} as Tx, be, "x", 1)).rejects.toThrow(stranger);
  await expect(i.setQueueParticipation({} as Tx, be, false)).rejects.toThrow(stranger);
  // The reads: fe's view carries its subscription and the unread post; be's, its creator's, not its own post; a board
  // filter narrows them.
  const views = await b.views(repo.read, [fe, be], null);
  expect(views.map(v => [v.handle, v.row.name, v.row.mode, v.row.unread])).toEqual([[fe, "hall", "digest", 1], [be, "hall", "push", 0]]);
  expect(await b.views(repo.read, [fe], "nope")).toEqual([]);
  expect((await b.openSummaries(repo.read)).map(r => [r.name, r.mode, r.unread])).toEqual([["hall", null, 0]]);
  expect((await b.roster(repo.read, "hall")).map(r => [r.handle, r.mode])).toEqual([[be, "push"], [fe, "digest"]]);
  expect((await b.roster(repo.read, null)).find(r => r.handle === be)?.id).toBe(s1);
  expect(await i.viewerIds(repo.read)).toEqual(new Set([tail]));
  // A missing ID is absent; a repeat once.
  expect(await i.idFacts(repo.read, [s1, "id:0000000000009", s1])).toEqual(new Map([[s1, { principal: "a@example.com", harness: "pi", model: "m1", effort: null, launcher: 0 }]]));
  const statusOf = (id: string) => db.query<{ status: string | null; status_at: number | null }, [string]>("SELECT status, status_at FROM ids WHERE id = ?").get(id);
  const queueOff = () => db.query<{ queue_off: number | null }, [string]>("SELECT queue_off FROM aliases WHERE address = ?").get(be)?.queue_off ?? null;
  await expect(seed(repo, async tx => {
    expect(await i.setStatus(tx, be, "busy", 500)).toBe(true);
    await i.setQueueParticipation(tx, be, false);
    expect((await b.roster(tx, null)).find(r => r.handle === be)).toMatchObject({ status: "busy", queue_off: 1 });
    throw new Error("rolled back");
  })).rejects.toThrow("rolled back");
  expect(statusOf(s1)).toEqual({ status: null, status_at: null });
  expect(queueOff()).toBeNull();
  // Committed: the holder's status and the opt-out land; an unheld name has no session to set, an ID-only one its own.
  expect(await seed(repo, tx => i.setStatus(tx, be, "busy", 500))).toBe(true);
  expect(statusOf(s1)).toEqual({ status: "busy", status_at: 500 });
  expect(db.query<{ last_seen: number }, [string]>("SELECT last_seen FROM aliases WHERE address = ?").get(be)?.last_seen).toBe(500);
  expect(await seed(repo, tx => i.setStatus(tx, fe, "x", 600))).toBe(false);
  expect(await seed(repo, tx => i.setStatus(tx, solo, "own", 600))).toBe(true);
  expect(statusOf(solo)).toEqual({ status: "own", status_at: 600 });
  expect(await seed(repo, tx => i.setStatus(tx, be, "", 700))).toBe(true);
  expect(statusOf(s1)).toEqual({ status: null, status_at: null });
  await seed(repo, tx => i.setQueueParticipation(tx, be, false));
  expect(queueOff()).toBe(1);
  await seed(repo, tx => i.setQueueParticipation(tx, be, true));
  expect(queueOff()).toBeNull();
});

// #807 P3 B5b1b2: the board tools' writes and the reads they add run on the handle they're given: a kept Tx and a
// non-store handle are refused, a create, archive, read or mute rolls back with its body, and committed they land.
test("#807 P3 B5b1b2: the board tools' repo writes and reads run on the handle they're given", async () => {
  const { repo, db } = fresh();
  const [be, fe, ghost] = ["a@example.com/be", "a@example.com/fe", "a@example.com/ghost"];
  let root = 0, reply = 0;
  const kept = await seed(repo, async tx => {
    await repo.users.upsertByEmail(tx, "a@example.com", null);
    for (const name of ["be", "fe"]) await repo.aliases.create(tx, person("a@example.com", name), "a@example.com");
    const core = repo.coreOn(tx);
    createBoard(core, be, "hall", "tests");
    subscribe(core, fe, "hall", "push");
    root = post(core, be, "hall", "root").post.id;
    reply = post(core, be, "hall", "reply", root).post.id;
    return tx;
  });
  await seed(repo, tx => repo.aliases.markHuman(tx, fe, true));
  const settled = /used after its transaction settled/;
  const stranger = /not a SQLite store handle/;
  const [b, al] = [repo.boards, repo.aliases];
  const nb = { name: "fresh", purpose: "p", scope: null, kind: "broadcast", createdBy: be, now: 900 };
  for (const h of [kept, {} as Tx]) {
    const want = h === kept ? settled : stranger;
    await expect(b.create(h, nb)).rejects.toThrow(want);
    await expect(b.setArchived(h, "hall", be, 1)).rejects.toThrow(want);
    await expect(b.read(h, "hall", fe, {})).rejects.toThrow(want);
    await expect(b.threadRoot(h, reply)).rejects.toThrow(want);
    await expect(b.mute(h, fe, root, true)).rejects.toThrow(want);
    await expect(al.isHuman(h, fe)).rejects.toThrow(want);
    await expect(al.scopesOf(h, [be])).rejects.toThrow(want);
  }
  // The reads: a reply's root, the human mark, each address's scope columns (an address with no row absent).
  expect(await b.threadRoot(repo.read, reply)).toBe(root);
  expect(await b.threadRoot(repo.read, root)).toBe(root);
  expect(await al.isHuman(repo.read, fe)).toBe(true);
  expect(await al.isHuman(repo.read, be)).toBe(false);
  expect(await al.scopesOf(repo.read, [be, ghost])).toEqual(new Map([[be, { scope_kind: "person", scope_ref: "a@example.com" }]]));
  const cursor = () => db.query<{ cursor: number }, [string]>("SELECT cursor FROM subscriptions WHERE board = 'hall' AND handle = ?").get(fe)?.cursor;
  const muted = () => db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM thread_mutes WHERE handle = ?").get(fe)!.n;
  const archivedAt = () => db.query<{ archived_at: number | null }, []>("SELECT archived_at FROM boards WHERE name = 'hall'").get()!.archived_at;
  const before = cursor();
  // Inside a body each write is seen by the body's reads, and all of it rolls back.
  await expect(seed(repo, async tx => {
    expect((await b.create(tx, nb))?.name).toBe("fresh");
    expect(await b.create(tx, nb)).toBeNull();
    expect(await b.get(tx, "fresh")).toMatchObject({ purpose: "p", created_by: be });
    expect((await b.setArchived(tx, "hall", be, 1000))?.archived_by).toBe(be);
    expect(await b.setArchived(tx, "hall", be, 1001)).toBeNull();
    expect((await b.read(tx, "hall", fe, {})).posts.map(p => p.id)).toEqual([root, reply]);
    await b.mute(tx, fe, root, true);
    throw new Error("rolled back");
  })).rejects.toThrow("rolled back");
  expect(await b.get(repo.read, "fresh")).toBeUndefined();
  expect(archivedAt()).toBeNull();
  expect(cursor()).toBe(before);
  expect(muted()).toBe(0);
  // Committed: they land; a null-handle read (a peek) leaves the cursor; a reopen clears the stamp.
  expect((await seed(repo, tx => b.read(tx, "hall", null, {}))).posts.length).toBe(2);
  expect(cursor()).toBe(before);
  await seed(repo, tx => b.read(tx, "hall", fe, {}));
  expect(cursor()).toBe(reply);
  await seed(repo, tx => b.mute(tx, fe, root, true));
  expect(muted()).toBe(1);
  await seed(repo, tx => b.mute(tx, fe, root, false));
  expect(muted()).toBe(0);
  expect((await seed(repo, tx => b.setArchived(tx, "hall", be, 1000)))?.archived_at).toBe(1000);
  expect(archivedAt()).toBe(1000);
  expect((await seed(repo, tx => b.setArchived(tx, "hall", null, 1100)))?.archived_at ?? null).toBeNull();
  expect(archivedAt()).toBeNull();
});

// #807 P3 B5b2b: board_post's repo reads and writes run on the handle they're given: a kept Tx and a non-store handle
// are refused, the writes roll back with their body, and committed they land.
test("#807 P3 B5b2b: board_post's repo reads and writes run on the handle they're given", async () => {
  const { repo, db } = fresh();
  const [be, fe] = ["a@example.com/be", "a@example.com/fe"];
  let root = 0;
  const kept = await seed(repo, async tx => {
    await repo.users.upsertByEmail(tx, "a@example.com", null);
    for (const name of ["be", "fe"]) await repo.aliases.create(tx, person("a@example.com", name), "a@example.com");
    const core = repo.coreOn(tx);
    createBoard(core, be, "hall", "tests");
    createBoard(core, be, "jobs", "work", null, { kind: "queue" });
    subscribe(core, fe, "hall", "push");
    subscribe(core, fe, "jobs", "push");
    root = post(core, be, "hall", "root").post.id;
    return tx;
  });
  const settled = /used after its transaction settled/;
  const stranger = /not a SQLite store handle/;
  const [b, al, cl] = [repo.boards, repo.aliases, repo.claims];
  const np = (board: string, body: string) => ({ board, author: be, body, parentId: null, now: 900, expiresAt: null, authorId: null, via: null, authorUser: null });
  const limits = { file: 1 << 20, total: 1 << 20 };
  const target = [[fe, { reason: "subscription", wake: true }]] as [string, { reason: "subscription"; wake: boolean }][];
  for (const h of [kept, {} as Tx]) {
    const want = h === kept ? settled : stranger;
    await expect(al.humansAmong(h, [fe])).rejects.toThrow(want);
    await expect(cl.ackQueue(h, [fe], "queue:jobs:1", 1)).rejects.toThrow(want);
    await expect(b.insertPost(h, np("hall", "x"))).rejects.toThrow(want);
    await expect(b.bindAttachments(h, [1], { addresses: [be], principal: "a@example.com" }, root, limits)).rejects.toThrow(want);
    await expect(b.authorAddresses(h, be, null)).rejects.toThrow(want);
    await expect(b.subscribers(h, "hall")).rejects.toThrow(want);
    await expect(b.threadFacts(h, root)).rejects.toThrow(want);
    await expect(b.laneRows(h, "jobs", [be])).rejects.toThrow(want);
    await expect(b.claimQueuePost(h, "jobs", root, fe, 1, { note: "n", push: true })).rejects.toThrow(want);
    await expect(b.insertOutbox(h, root, target)).rejects.toThrow(want);
  }
  const count = (sql: string) => db.query<{ n: number }, []>(sql).get()!.n;
  const before = { posts: count("SELECT count(*) AS n FROM posts"), outbox: count("SELECT count(*) AS n FROM outbox"), claims: count("SELECT count(*) AS n FROM claims") };
  // Inside a body the writes are seen by its reads, and all of it rolls back.
  await expect(seed(repo, async tx => {
    const p = await b.insertPost(tx, np("jobs", "build"));
    expect(await b.laneRows(tx, "jobs", [be])).toEqual([fe]);
    expect(await b.claimQueuePost(tx, "jobs", p.id, fe, 901, { note: "n", push: true })).toBe(true);
    await b.insertOutbox(tx, p.id, target);
    expect(await cl.ackQueue(tx, [fe], `queue:jobs:${p.id}`, 902)).toBe(true);
    throw new Error("rolled back");
  })).rejects.toThrow("rolled back");
  expect({ posts: count("SELECT count(*) AS n FROM posts"), outbox: count("SELECT count(*) AS n FROM outbox"), claims: count("SELECT count(*) AS n FROM claims") }).toEqual(before);
  // Committed: they land.
  const landed = await seed(repo, async tx => {
    const p = await b.insertPost(tx, np("hall", "later"));
    await b.insertOutbox(tx, p.id, target);
    return p.id;
  });
  expect(db.query<{ handle: string }, [number]>("SELECT handle FROM outbox WHERE post_id = ?").all(landed)).toEqual([{ handle: fe }]);
  expect(await b.subscribers(repo.read, "hall")).toEqual([{ handle: be, mode: "push" }, { handle: fe, mode: "push" }]);
});

// #807 P3 B5b1: a team's follow judges the board for the alias before subscribing it, as core's subscribe did: an
// alias whose user isn't a member is refused as for a missing board, and its body rolls back.
test("#807 P3 B5b1: a team follow refuses an alias that can't see the team board", async () => {
  const { repo } = fresh();
  const team = await seed(repo, async tx => {
    const a = await repo.users.upsertByEmail(tx, "a@example.com", null);
    await repo.users.upsertByEmail(tx, "b@example.com", null);
    await repo.aliases.create(tx, person("b@example.com", "be"), "b@example.com");
    const team = await repo.teams.create(tx, "crew", a.id);
    await repo.teams.addMember(tx, team.id, a.id);
    return team;
  });
  await expect(seed(repo, tx => onTeamJoined(repo, tx, team, "b@example.com"))).rejects.toThrow("no such board #crew; see board_list");
  expect(await repo.boards.get(repo.read, "crew")).toBeUndefined();
  expect(await repo.boards.isSubscribed(repo.read, "b@example.com/be", "crew")).toBe(false);
});

// #807 P3 B4b: repo.delegation reads on the handle it's given, and its facts answer only what they read: a question
// about anything else throws rather than reading as false or zero.
test("#807 P3 B4b: repo.delegation runs on the handle it's given; its facts answer only what they read", async () => {
  const { repo } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  const [s1, s2, idle] = ["id:0000000000001", "id:0000000000002", "id:0000000000003"];
  const [be, ops, sim] = ["b@example.com/be", "b@example.com/ops", "c@example.com/sim"];
  const d = repo.delegation;
  const kept = await seed(repo, async tx => {
    await repo.users.upsertByEmail(tx, "b@example.com", null);
    await repo.users.upsertByEmail(tx, "c@example.com", null);
    for (const n of ["be", "ops"]) await repo.aliases.create(tx, person("b@example.com", n), "b@example.com");
    await repo.aliases.create(tx, person("c@example.com", "sim"), "c@example.com");
    const core = repo.coreOn(tx);
    registerId(core, { id: s1, principal: "b@example.com", launcher: true });
    registerId(core, { id: s2, principal: "c@example.com", launcher: false });
    registerId(core, { id: idle, principal: "b@example.com", launcher: true });
    holdAlias(core, be, s1, 100);
    holdAlias(core, sim, s2, 100);
    // sim is on the roster (it has been seen); ops never connected.
    touchAlias(core, sim);
    // Inside the body that wrote them, on its Tx.
    expect(await d.addressUser(tx, be)).toBe("b@example.com");
    expect((await d.facts(tx, { since: 0 })).launchers()).toEqual([be, idle]);
    return tx;
  });
  const settled = /used after its transaction settled/;
  await expect(d.addressUser(kept, be)).rejects.toThrow(settled);
  await expect(d.facts(kept, { since: 0 })).rejects.toThrow(settled);
  await expect(d.facts({} as Tx, { since: 0 })).rejects.toThrow("not a SQLite store handle");
  const r = repo.read;
  expect(await d.addressUser(r, sim)).toBe("c@example.com");
  expect(await d.addressUser(r, s2)).toBe("c@example.com");
  expect(await d.addressUser(r, ops)).toBeUndefined();
  // Auto-pick: every launcher (the named one, then the unbound ID), each one's user and open count.
  const auto = await d.facts(r, { since: 0 });
  expect(auto.launchers()).toEqual([be, idle]);
  expect([auto.userOf(be), auto.userOf(idle)]).toEqual(["b@example.com", "b@example.com"]);
  expect([auto.open(be), auto.open(idle)]).toEqual([0, 0]);
  expect(() => auto.userOf(sim)).toThrow(/the user of "c@example.com\/sim" was not read/);
  expect(() => auto.open(sim)).toThrow(/the open count of "c@example.com\/sim" was not read/);
  expect(() => auto.everConnected(be)).toThrow(/was not read/);
  expect(() => auto.humanHandles()).toThrow(/the human handles was not read/);
  expect(() => auto.lastSeen(be)).toThrow(/was not read/);
  // A named target: its own facts only.
  const named = await d.facts(r, { to: sim, since: 0 });
  expect([named.everConnected(sim), named.isLauncher(sim), named.userOf(sim), named.open(sim)]).toEqual([true, false, "c@example.com", 0]);
  expect((await d.facts(r, { to: idle, since: 0 })).isLauncher(idle)).toBe(true);
  expect((await d.facts(r, { to: "b@example.com/none", since: 0 })).everConnected("b@example.com/none")).toBe(false);
  expect(() => named.launchers()).toThrow(/the launcher list was not read/);
  expect(() => named.open(be)).toThrow(/was not read/);
  // The target's facts answer for that address only.
  expect(() => named.everConnected(be)).toThrow(/whether "b@example.com\/be" connected was not read/);
  expect(() => named.isLauncher(be)).toThrow(/whether "b@example.com\/be" is a launcher was not read/);
});

// #807 P3 B5b3b: the sweep's repo steps (claims.expire, logEvent, takeWatchers, holderUser; boards.redeliveryFacts)
// run on the handle they're given, and the writes roll back with their body.
test("#807 P3 B5b3b: the claim sweep's repo reads and writes run on the handle they're given", async () => {
  const { repo, db } = fresh();
  const [be, fe] = ["a@example.com/be", "a@example.com/fe"];
  let qkey = "";
  const kept = await seed(repo, async tx => {
    await repo.users.upsertByEmail(tx, "a@example.com", null);
    for (const name of ["be", "fe"]) await repo.aliases.create(tx, person("a@example.com", name), "a@example.com");
    const core = repo.coreOn(tx);
    createBoard(core, be, "hall", "tests");
    createBoard(core, be, "jobs", "work", null, { kind: "queue" });
    qkey = `queue:jobs:${post(core, be, "jobs", "build").post.id}`;
    claim(core, be, "ticket:1", { board: "hall", ttl_minutes: 5 });
    watch(core, fe, "ticket:1");
    return tx;
  });
  const settled = /used after its transaction settled/;
  const stranger = /not a SQLite store handle/;
  const [b, cl] = [repo.boards, repo.claims];
  const row = (await cl.list(repo.read))[0]!;
  const later = row.expires_at + 1;
  for (const h of [kept, {} as Tx]) {
    const want = h === kept ? settled : stranger;
    await expect(cl.expire(h, later)).rejects.toThrow(want);
    await expect(cl.logEvent(h, "expire", be, row, later)).rejects.toThrow(want);
    await expect(cl.takeWatchers(h, "ticket:1")).rejects.toThrow(want);
    await expect(cl.holderUser(h, { ...row, holder_user: null })).rejects.toThrow(want);
    await expect(b.redeliveryFacts(h, qkey, fe)).rejects.toThrow(want);
  }
  const count = (sql: string) => db.query<{ n: number }, []>(sql).get()!.n;
  const tally = () => ({ claims: count("SELECT count(*) AS n FROM claims"), watches: count("SELECT count(*) AS n FROM claim_watches"), events: count("SELECT count(*) AS n FROM claim_events") });
  const before = tally();
  // Inside a body the writes are seen by its reads, and all of it rolls back.
  await expect(seed(repo, async tx => {
    const gone = await cl.expire(tx, later);
    expect(gone.map(c => c.key)).toEqual(["ticket:1"]);
    expect(await cl.holderUser(tx, gone[0]!)).toBe("a@example.com");
    await cl.logEvent(tx, "expire", be, gone[0]!, later);
    expect(await cl.takeWatchers(tx, "ticket:1")).toEqual([fe]);
    expect(await cl.takeWatchers(tx, "ticket:1")).toEqual([]);
    expect(await cl.list(tx)).toEqual([]);
    throw new Error("rolled back");
  })).rejects.toThrow("rolled back");
  expect(tally()).toEqual(before);
  // Committed: they land.
  await seed(repo, async tx => {
    await cl.expire(tx, later);
    await cl.logEvent(tx, "expire", be, row, later);
    await cl.takeWatchers(tx, "ticket:1");
  });
  expect(tally()).toEqual({ claims: before.claims - 1, watches: before.watches - 1, events: before.events + 1 });
  const facts = await b.redeliveryFacts(repo.read, qkey, fe);
  expect(facts && { board: facts.board.name, takers: facts.takers, held: facts.held.has(fe) }).toEqual({ board: "jobs", takers: 1, held: true });
  expect(await b.redeliveryFacts(repo.read, "ticket:1", fe)).toBeNull();
});

// #807 P3 B5b3c: the claim tools' repo steps (claims.get, take, release, recentEvents, watchers, liveForWatch, addWatch,
// unwatch) run on the handle they're given, and the writes roll back with their body.
test("#807 P3 B5b3c: the claim tools' repo reads and writes run on the handle they're given", async () => {
  const { repo, db } = fresh();
  const [be, fe] = ["a@example.com/be", "a@example.com/fe"];
  const kept = await seed(repo, async tx => {
    await repo.users.upsertByEmail(tx, "a@example.com", null);
    for (const name of ["be", "fe"]) await repo.aliases.create(tx, person("a@example.com", name), "a@example.com");
    const core = repo.coreOn(tx);
    createBoard(core, be, "hall", "tests");
    claim(core, be, "ticket:1", { board: "hall", ttl_minutes: 5 });
    return tx;
  });
  const settled = /used after its transaction settled/;
  const stranger = /not a SQLite store handle/;
  const cl = repo.claims;
  const now = Date.now();
  const take = { key: "ticket:2", as: be, note: "n", board: "hall", now, expires: now + 60_000, user: "a@example.com" };
  for (const h of [kept, {} as Tx]) {
    const want = h === kept ? settled : stranger;
    await expect(cl.get(h, "ticket:1")).rejects.toThrow(want);
    await expect(cl.take(h, take)).rejects.toThrow(want);
    await expect(cl.release(h, "ticket:1", be, now)).rejects.toThrow(want);
    await expect(cl.recentEvents(h, "ticket:1")).rejects.toThrow(want);
    await expect(cl.watchers(h, "ticket:1")).rejects.toThrow(want);
    await expect(cl.liveForWatch(h, "ticket:1", now)).rejects.toThrow(want);
    await expect(cl.addWatch(h, "ticket:1", fe)).rejects.toThrow(want);
    await expect(cl.unwatch(h, "ticket:1", fe)).rejects.toThrow(want);
  }
  const count = (sql: string) => db.query<{ n: number }, []>(sql).get()!.n;
  const tally = () => ({ claims: count("SELECT count(*) AS n FROM claims"), watches: count("SELECT count(*) AS n FROM claim_watches") });
  const before = tally();
  // Inside a body the writes are seen by its reads, and all of it rolls back.
  await expect(seed(repo, async tx => {
    expect((await cl.get(tx, "ticket:1"))?.holder).toBe(be);
    expect((await cl.liveForWatch(tx, "ticket:1", now))?.holder).toBe(be);
    await cl.addWatch(tx, "ticket:1", fe);
    expect(await cl.watchers(tx, "ticket:1")).toEqual([fe]);
    await cl.unwatch(tx, "ticket:1", fe);
    expect(await cl.watchers(tx, "ticket:1")).toEqual([]);
    expect((await cl.take(tx, take))?.key).toBe("ticket:2");
    // Someone else's live claim isn't taken over (D3).
    expect(await cl.take(tx, { ...take, as: fe })).toBeNull();
    expect(await cl.release(tx, "ticket:1", fe, now)).toBeNull();
    expect((await cl.release(tx, "ticket:1", be, now))?.key).toBe("ticket:1");
    expect(await cl.get(tx, "ticket:1")).toBeUndefined();
    expect(await cl.liveForWatch(tx, "ticket:1", now)).toBeUndefined();
    expect((await cl.recentEvents(tx, "ticket:1")).map(e => e.event)).toContain("take");
    throw new Error("rolled back");
  })).rejects.toThrow("rolled back");
  expect(tally()).toEqual(before);
  // Committed: they land.
  await seed(repo, async tx => {
    await cl.take(tx, take);
    await cl.addWatch(tx, "ticket:1", fe);
  });
  expect(tally()).toEqual({ claims: before.claims + 1, watches: before.watches + 1 });
});
