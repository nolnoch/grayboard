import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
import { ACCESS_LOG_LAST_SQL, INVOKE_BINDING_SQL, openDatabase, QUEUED_TO_SQL, RETRACTABLE_SQL, SENT_PENDING_SQL, UNDELIVERED_FROM_SQL, type Repo } from "./db.ts";
import type { Tx } from "./store/tx.ts";
import { scratchDbPath } from "../../tests/support/scratch_db.ts";
import { activeAnnouncements, createBoard, openAccess, post, registerId, setAccess, subscribe } from "../core/boards.ts";
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
import { bindingsContract } from "./store/bindings.contract.ts";
import { sqliteBindingsBackend } from "./store/bindings.contract.sqlite.ts";
import { sqliteAuthCacheBackend } from "./store/auth_cache.contract.sqlite.ts";
import { attachmentsContract } from "./store/attachments.contract.ts";
import { sqliteAttachmentsBackend } from "./store/attachments.contract.sqlite.ts";
import { sessionEndContract } from "./store/session_end.contract.ts";
import { delegationContract } from "./store/delegation.contract.ts";
import { sqliteIdsBackend } from "./store/session_end.contract.sqlite.ts";
import { claimsContract } from "./store/claims.contract.ts";
import { sqliteClaimsBackend } from "./store/claims.contract.sqlite.ts";
import { boardsContract } from "./store/boards.contract.ts";
import { sqliteBoardsBackend } from "./store/boards.contract.sqlite.ts";

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

  // #284 S5: the mail steps of the server's session end (server/session_end.ts; #807 P3 C10d2-a: the store's methods).
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
    expect(await seed(repo, tx => repo.messages.unreadFor(tx, id))).toEqual([{ id: unread.id, sender: peer }]);

    await seed(repo, tx => repo.messages.bounce(tx, id, peer, unread.id, "returned", 1234));
    const [bounce] = (await repo.messages.history(repo.read, [peer])).filter((m) => m.kind === "bounce");
    expect(bounce).toMatchObject({ sender: id, recipient_type: "user", recipient: peer, body: "returned", parent_id: unread.id, created_at: 1234, pending: 0, kind: "bounce" });
    expect((await repo.messages.getById(repo.read, unread.id))?.kind).toBeNull();

    await seed(repo, async tx => {
      await repo.messages.ack(tx, id, unread.id);
      await repo.messages.ack(tx, peer, bounce!.id);
      await repo.messages.dropReader(tx, id);
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
describe("bindings contract (SQLite)", () => bindingsContract(sqliteBindingsBackend));
// The cursors, write receipts, audit and Slack groups' rows, shared with the Postgres store (#807 P3 C67a).
describe("cursors contract (SQLite)", () => cursorsContract(sqliteCursorsBackend));
describe("write receipts contract (SQLite)", () => writeReceiptsContract(sqliteWriteReceiptsBackend));
describe("audit contract (SQLite)", () => auditContract(sqliteAuditBackend));
describe("slack contract (SQLite)", () => slackContract(sqliteSlackBackend));
// The hosted sessions group's rows, shared with the Postgres store (#807 P3 C8a); its settled-Tx refusals moved there.
describe("hosted contract (SQLite)", () => hostedContract(sqliteHostedBackend));
describe("auth cache contract (SQLite)", () => authCacheContract(sqliteAuthCacheBackend));
describe("attachments contract (SQLite)", () => attachmentsContract(sqliteAttachmentsBackend));
describe("session end contract (SQLite)", () => sessionEndContract(sqliteIdsBackend));
describe("delegation contract (SQLite)", () => delegationContract(sqliteIdsBackend));
describe("claims contract (SQLite)", () => claimsContract(sqliteClaimsBackend));
describe("boards contract (SQLite)", () => boardsContract(sqliteBoardsBackend));

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
test("#807 P1c-5: cursors, writeReceipts, bindings and boards refuse a handle from another store", async () => {
  const { repo } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  const foreign = {} as typeof repo.read;
  await expect(repo.cursors.directFor(foreign, "a@example.com/fe")).rejects.toThrow("not a SQLite store handle");
  await expect(repo.cursors.advance(foreign as Tx, "a@example.com/fe", "direct", "a@example.com/fe", 1)).rejects.toThrow("not a SQLite store handle");
  await expect(repo.writeReceipts.refExists(foreign, "message", 1)).rejects.toThrow("not a SQLite store handle");
  await expect(repo.writeReceipts.claim(foreign as Tx, { session: "s", sender: "a@example.com/fe", fp: "f" }, "dm_send", 1)).rejects.toThrow("not a SQLite store handle");
  await expect(repo.audit.lock(foreign as Tx, "bridge.notified", "a@example.com/human")).rejects.toThrow("not a SQLite store handle");
  await expect(repo.bindings.holdsOf(foreign, "id:0000000000001")).rejects.toThrow("not a SQLite store handle");
  await expect(repo.bindings.take(foreign as Tx, "a@example.com/fe", "id:0000000000001", "a@example.com", 1)).rejects.toThrow("not a SQLite store handle");
  const [i, fx] = [repo.bindings, foreign as Tx];
  for (const call of [() => i.viewerIds(foreign), () => i.idFacts(foreign, ["id:0000000000001"]), () => i.setStatus(fx, "a@example.com/fe", "x", 1), () => i.setQueueParticipation(fx, "a@example.com/fe", false)]) {
    await expect(call()).rejects.toThrow("not a SQLite store handle");
  }
  // Every boards method (#807 P3 C10e-a; the settled-Tx refusals are boards.contract.ts's).
  const b = repo.boards;
  const fe = "a@example.com/fe";
  for (const call of [
    () => b.get(foreign, "hall"), () => b.post(foreign, 1), () => b.catalogPage(foreign, ""), () => b.snapshotPage(foreign, "hall", {}),
    () => b.pendingPushes(foreign, fe), () => b.pendingDigests(foreign, fe), () => b.acknowledge(fx, fe, { kind: "push", post_id: 1 }),
    () => b.ensure(fx, "hall", "p", null, fe), () => b.isSubscribed(foreign, fe, "hall"), () => b.setSubscription(fx, fe, "hall", "push"),
    () => b.unsubscribeScope(fx, fe, "team:x"), () => b.forget(fx, fe), () => b.prunePosts(fx, 0), () => b.views(foreign, [fe], null),
    () => b.openSummaries(foreign), () => b.roster(foreign, null), () => b.create(fx, { name: "x", purpose: "p", scope: null, kind: "broadcast", createdBy: fe, now: 1 }),
    () => b.setArchived(fx, "hall", fe, 1), () => b.read(fx, "hall", fe, {}), () => b.threadRoot(foreign, 1), () => b.mute(fx, fe, 1, true), () => b.lockForPost(fx, "hall"),
    () => b.insertPost(fx, { board: "hall", author: fe, body: "x", parentId: null, now: 1, expiresAt: null, authorId: null, via: null, authorUser: null, human: false }),
    () => b.bindAttachments(fx, [1], { addresses: [fe], principal: null }, 1, { file: 1, total: 1 }), () => b.authorAddresses(foreign, fe, null),
    () => b.subscribers(foreign, "hall"), () => b.threadFacts(foreign, 1), () => b.laneRows(foreign, "hall", [fe]),
    () => b.claimQueuePost(fx, "hall", 1, fe, 1, { note: "n", push: true }), () => b.insertOutbox(fx, 1, []), () => b.redeliveryFacts(foreign, "queue:hall:1", fe),
  ]) await expect(call()).rejects.toThrow("not a SQLite store handle");
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
  await repo.close();
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

// #807 P3 B1a, B1c: the bindings group is a contract (store/bindings.contract.ts), registered above.

// #807 P3 B4a: repo.sessionEnd runs on the handle it's given: a kept Tx and a non-store handle are refused, and its row
// step rolls back with its body (C10d2-a: the bounces and the rest are server/session_end.ts's, tested there).
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
  await expect(e.end(kept, id, 1)).rejects.toThrow(settled);
  await expect(e.refusal(kept, id)).rejects.toThrow(settled);
  await expect(e.pruneEnded(kept, 1, 1)).rejects.toThrow(settled);
  await expect(e.refusal({} as Tx, id)).rejects.toThrow("not a SQLite store handle");
  await expect(seed(repo, async tx => {
    expect(await e.end(tx, id, 5)).toEqual({ principal: "a@example.com", held: [], children: [] });
    expect((await e.refusal(tx, id))?.code).toBe("id_ended");
    throw new Error("rolled back");
  })).rejects.toThrow("rolled back");
  expect(await seed(repo, tx => e.refusal(tx, id))).toBeNull();
  // Committed, the ID refuses delivery and a second end finds it ended; the row step bounces nothing.
  expect(await seed(repo, tx => e.end(tx, id, 5))).toEqual({ principal: "a@example.com", held: [], children: [] });
  expect(await seed(repo, tx => e.end(tx, id, 6))).toBeNull();
  expect((await seed(repo, tx => e.refusal(tx, id)))?.code).toBe("id_ended");
  expect((await repo.messages.history(repo.read, [peer])).filter(m => m.kind === "bounce")).toEqual([]);
  expect(await seed(repo, tx => repo.messages.unreadFor(tx, id))).toEqual([{ id: unread.id, sender: peer }]);
});

// #807 P3 B5a1..B5b2b's rows for the groups the board tools call besides boards (whose rows moved to
// boards.contract.ts): the aliases and claims methods refuse a kept Tx and a non-store handle, and roll back with
// their body.
test("#807 P3 B5: the aliases and claims methods the board tools call run on the handle they're given", async () => {
  const { repo, db } = fresh();
  setAccess(db, openAccess(db)); // core seeds on a server database opt in to local mode's open Access
  const [be, fe] = ["a@example.com/be", "a@example.com/fe"];
  const kept = await seed(repo, async tx => {
    await repo.users.upsertByEmail(tx, "a@example.com", null);
    for (const name of ["be", "fe"]) await repo.aliases.create(tx, person("a@example.com", name), "a@example.com");
    const core = repo.coreOn(tx);
    createBoard(core, be, "jobs", "work", null, { kind: "queue" });
    subscribe(core, fe, "jobs", "push");
    return tx;
  });
  const [al, cl] = [repo.aliases, repo.claims];
  for (const [h, want] of [[kept, /used after its transaction settled/], [{} as Tx, /not a SQLite store handle/]] as const) {
    await expect(al.markHuman(h, fe, true)).rejects.toThrow(want);
    await expect(al.isHuman(h, fe)).rejects.toThrow(want);
    await expect(al.scopesOf(h, [be])).rejects.toThrow(want);
    await expect(al.humansAmong(h, [fe])).rejects.toThrow(want);
    await expect(cl.ackQueue(h, [fe], "queue:jobs:1", 1)).rejects.toThrow(want);
  }
  const human = () => db.query<{ human: number | null }, [string]>("SELECT human FROM aliases WHERE address = ?").get(fe)?.human ?? null;
  const claims = () => db.query<{ n: number }, []>("SELECT count(*) AS n FROM claims").get()!.n;
  await expect(seed(repo, async tx => {
    const p = post(repo.coreOn(tx), be, "jobs", "build").post.id;
    expect(await cl.ackQueue(tx, [fe], `queue:jobs:${p}`, 2)).toBe(true);
    await al.markHuman(tx, fe, true);
    expect(await al.isHuman(tx, fe)).toBe(true);
    throw new Error("rolled back");
  })).rejects.toThrow("rolled back");
  expect(human()).toBeFalsy();
  expect(claims()).toBe(0);
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

// #807 P3 B5b3b: the sweep's repo steps (claims.expire, logEvent, takeWatchers, holderUser) run on the handle they're
// given, and the writes roll back with their body. boards.redeliveryFacts' rows are in boards.contract.ts.
test("#807 P3 B5b3b: the claim sweep's repo reads and writes run on the handle they're given", async () => {
  const { repo, db } = fresh();
  setAccess(db, openAccess(db)); // core seeds on a server database opt in to local mode's open Access
  const [be, fe] = ["a@example.com/be", "a@example.com/fe"];
  const kept = await seed(repo, async tx => {
    await repo.users.upsertByEmail(tx, "a@example.com", null);
    for (const name of ["be", "fe"]) await repo.aliases.create(tx, person("a@example.com", name), "a@example.com");
    const core = repo.coreOn(tx);
    createBoard(core, be, "hall", "tests");
    claim(core, be, "ticket:1", { board: "hall", ttl_minutes: 5 });
    watch(core, fe, "ticket:1");
    return tx;
  });
  const settled = /used after its transaction settled/;
  const stranger = /not a SQLite store handle/;
  const cl = repo.claims;
  const row = (await cl.list(repo.read))[0]!;
  const later = row.expires_at + 1;
  for (const h of [kept, {} as Tx]) {
    const want = h === kept ? settled : stranger;
    await expect(cl.expire(h, later)).rejects.toThrow(want);
    await expect(cl.logEvent(h, "expire", be, row, later)).rejects.toThrow(want);
    await expect(cl.takeWatchers(h, "ticket:1")).rejects.toThrow(want);
    await expect(cl.holderUser(h, { ...row, holder_user: null })).rejects.toThrow(want);
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
});

// #807 P3 B5b3c: the claim tools' repo steps (claims.get, take, release, recentEvents, watchers, liveForWatch, addWatch,
// unwatch) run on the handle they're given, and the writes roll back with their body.
test("#807 P3 B5b3c: the claim tools' repo reads and writes run on the handle they're given", async () => {
  const { repo, db } = fresh();
  setAccess(db, openAccess(db)); // core seeds on a server database opt in to local mode's open Access
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

// A server database installs a core Access that refuses every use (C10d2-a audit finding 1): a server path that called
// core's board functions would otherwise judge visibility by local mode's open Access, every board open.
test("#807 P3 C10d2-a: core's Access on a server database refuses, so no server path falls back to open access", () => {
  const { db } = fresh();
  expect(() => activeAnnouncements(db)).toThrow("server paths use boardAccess");
  setAccess(db, openAccess(db));
  expect(activeAnnouncements(db)).toEqual([]);
});
