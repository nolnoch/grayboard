import type { Database } from "bun:sqlite";
import type { HostedStore, HostedSession, HostedEnd } from "./hosted-types.ts";
import { testPause } from "../shared/testpause.ts";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { setAccess } from "../core/boards.ts";
import { bindAttachments, dropAttachments, withAttachments, type BlobStore } from "../core/attachments.ts";
import { initCoreSchema } from "../core/schema.ts";
import { afterCommit, openSqlite } from "../core/sqlite.ts";
import { serverAccess } from "./access.ts";
import type { HumanReach } from "./can_send.ts";
import { DEFAULT_ATTACHMENT_LIMITS, DEFAULT_ATTACHMENT_USER_QUOTA, type AttachmentInfo, type AttachmentLimits } from "../shared/attachments.ts";
import { DiskBlobs } from "./blobs.ts";
import { OAUTH_TTL, type OAuthStore, type OAuthBinding, type OAuthAuthorization, type OAuthRequest, type OAuthBrowserSession, type OAuthCode, type OAuthGrant, type OAuthTokenPair, type OAuthAccess } from "./oauth-types.ts";

// Row types
export type User     = { id: number; email: string; display_name: string | null; created_at: number; disabled_at: number | null };
export type Session  = { id: number; user_id: number; token_hash: string; created_at: number; last_used_at: number; revoked_at: number | null; label: string | null };
// A person-scope alias (#284): one of a user's names, `email/name`.
export type Alias = { id: number; address: string; name: string; created_at: number };

export type Team     = { id: number; name: string; created_by: number; policy: string; created_at: number };
// attachments: present on reads when the message carries files.
export type MessageRow = { id: number; sender: string; recipient_type: "user" | "team"; recipient: string; body: string; parent_id: number | null; created_at: number; pending: number; attachments?: AttachmentInfo[] };
// Only a direct message's sender and recipient can see it, its thread, or
// the files it carries. One you're not in reads as missing, so its existence
// doesn't leak.
export function participant(m: MessageRow | undefined, me: string): m is MessageRow {
  return !!m && m.recipient_type === "user" && (m.sender === me || m.recipient === me);
}
// A user's Slack link: their member ID and their DM with the bridge's app.
export type SlackLink = { user_id: number; email: string; slack_user: string; dm_channel: string; linked_at: number };
// thread_ts: the Slack top-level message. root_id: the grayboard thread's root
// (message id for dm, post id for board). peer: the other party in a dm.
// last_id: the newest grayboard id in the thread, the parent for a reply.
export type SlackThread = { thread_ts: string; kind: "dm" | "board"; board: string | null; root_id: number; peer: string | null; last_id: number };
export type AccessLogRow = { at: number; actor: string | null; action: string; target: string | null; detail: string | null };
// An append write's receipt (#254, src/server/write_dedup.ts): which row the
// first call made and the result it answered, so a repeat replays it.
export type WriteReceipt = {
  session: string; sender: string; fp: string; tool: string;
  ref_kind: "message" | "post"; ref_id: number; result_json: string; at: number;
};

// A message's columns as readers see them. sender_id (#284) is the sending
// session's provenance, kept in the database and left out of reads and pushes.
const MSG_COLS = `id, sender, recipient_type, recipient, body, parent_id, created_at, pending`;
const M_MSG_COLS = `m.id, m.sender, m.recipient_type, m.recipient, m.body, m.parent_id, m.created_at, m.pending`;

// A synchronous callback's result: a promise is refused at compile time, so
// nothing can await between a transaction's reads and its writes.
export type Sync<T> = T extends PromiseLike<unknown> ? never : T;

export interface Repo {
  // Runs fn in one IMMEDIATE transaction, or a savepoint inside an open one.
  atomic<T>(fn: () => Sync<T>): T;
  oauth: OAuthStore;
  hosted: HostedStore;
  users: {
    upsertByEmail(email: string, displayName: string | null): User;
    findByEmail(email: string): User | undefined;
    findById(userId: number): User | undefined;
    setDisabled(userId: number, disabled: boolean): void;
  };
  sessions: {
    create(userId: number, tokenHash: string, label: string | null): Session;
    findByTokenHash(hash: string): Session | undefined;
    revoke(sessionId: number): void;
    revokeAllForUser(userId: number): void;
    touch(sessionId: number, now: number): void;
  };
  // A user's names, keyed by the user's email (the person scope).
  aliases: {
    create(email: string, name: string): Alias;
    listFor(email: string): Alias[];
    find(email: string, name: string): Alias | undefined;
    findAllByName(name: string): { email: string; name: string }[];
    // Also deletes the alias's read points.
    remove(email: string, name: string): void;
  };
  teams: {
    // Inserts the team's principal in the same transaction; throws
    // PrincipalTaken if another principal has the name.
    create(name: string, createdBy: number): Team;
    findByName(name: string): Team | undefined;
    listForUser(userId: number): Team[];
    addMember(teamId: number, userId: number): void;
    removeMember(teamId: number, userId: number): void;
    listMembers(teamId: number): { user_id: number; email: string }[];
    listMemberUserIds(teamId: number): number[];
    isMember(teamId: number, userId: number): boolean;
  };
  messages: {
    // attachmentIds: the sender's unbound uploads, bound in the insert's
    // transaction (a refused id throws CoreError and nothing is written).
    // senderId: the sending session's ID (#284); null for a writer with no session.
    insert(sender: string, recipientType: "user" | "team", recipient: string, body: string, parentId: number | null, pending?: boolean, attachmentIds?: number[], senderId?: string | null): MessageRow;
    // The row alone, without its attachments: an access or ack check.
    getById(id: number): MessageRow | undefined;
    history(identityFull: string, peer?: string, limit?: number, beforeId?: number): MessageRow[];
    thread(id: number): MessageRow[];
    unreadSince(streams: { type: "direct" | "team"; ref: string; since: number }[]): MessageRow[];
    // Direct messages to each of recipients still past its cursor, sent by
    // someone else; recipients with none are absent.
    queuedTo(recipients: string[]): Map<string, number>;
    // Direct messages from sender still past each recipient's cursor, per recipient.
    undeliveredFrom(sender: string, olderThan?: number): { recipient: string; n: number; oldest_id: number }[];
    // Direct messages to reader since `since` that it hasn't acked, oldest first.
    receivedUnacked(reader: string, since: number): MessageRow[];
    // Direct messages from sender since `since` sent pending and not acked by it, oldest first.
    sentPending(sender: string, since: number): MessageRow[];
    ack(reader: string, id: number): void;
    // Deletes a direct message from sender that's past the recipient's cursor
    // and has no reply. False if any of that doesn't hold.
    retract(sender: string, id: number): boolean;
    prune(olderThanMs: number): void;
  };
  // Read points (#284), keyed by the reading address: how far it has
  // received a stream (its direct messages, stream_ref = the address itself).
  cursors: {
    get(address: string, streamType: "direct" | "team", streamRef: string): number;
    // How far an address has received its direct messages.
    directFor(address: string): number;
    advance(address: string, streamType: "direct" | "team", streamRef: string, messageId: number): void;
  };
  audit: {
    write(row: AccessLogRow): void;
    // The most recent row for this action+target, for dedup windows and
    // "has this happened recently" checks. Undefined when none exists.
    last(action: string, target: string): AccessLogRow | undefined;
    prune(olderThanMs: number): void;
  };
  slack: {
    links(): SlackLink[];
    linkFor(userId: number): SlackLink | undefined;
    linkBySlackUser(slackUser: string): SlackLink | undefined;
    // Replaces the user's earlier link, if any.
    link(userId: number, slackUser: string, dmChannel: string): void;
    // Also forgets the user's thread map.
    unlink(userId: number): void;
    thread(userId: number, kind: "dm" | "board", board: string | null, rootId: number): SlackThread | undefined;
    threadByTs(userId: number, threadTs: string): SlackThread | undefined;
    addThread(userId: number, t: SlackThread): void;
    // Moves a thread's reply target forward, never back.
    advanceThread(userId: number, threadTs: string, id: number): void;
    // How far an outbound item got in Slack, keyed by its grayboard ref
    // ("dm:<message id>" or "post:<post id>"); cleared once it's done.
    progress(userId: number, ref: string): unknown;
    setProgress(userId: number, ref: string, progress: unknown): void;
    clearProgress(userId: number, ref: string): void;
  };
  writeReceipts: {
    // The receipt for (session, sender, fp) written after `since`.
    find(session: string, sender: string, fp: string, since: number): WriteReceipt | undefined;
    // Replaces any receipt for the same (session, sender, fp).
    upsert(r: WriteReceipt): void;
    // Whether the row a receipt names still exists (a retract or retention removes it).
    refExists(kind: "message" | "post", id: number): boolean;
    // Deletes receipts written at or before `before`: one session's, or all. Returns how many.
    pruneSession(session: string, before: number): number;
    prune(before: number): number;
  };
  // Attachment bytes, by sha256; the attachment rows are metadata in this database.
  blobs: BlobStore;
  // The server's per-file and per-message caps; insert binds files under them.
  attachmentLimits: AttachmentLimits;
  // The bytes of attachments one user may store, sent or not.
  attachmentUserQuota: number;
}

export type OpenOptions = { blobDir: string; humanReach?: HumanReach; attachmentLimits?: AttachmentLimits; attachmentUserQuota?: number };

// undeliveredFrom: messages a sender has sent that the recipient's read point
// hasn't reached. The read point is the last delivered-and-handled message id
// (mailbox_cursors.last_seen_id); unread = `id > read point` — a message is counted
// undelivered iff `id > read point`. Exported so the EXPLAIN pin asserts the
// plan of the exact statement the code executes, not a hand-copied drift.
export const UNDELIVERED_FROM_SQL = `SELECT m.recipient, COUNT(*) AS n, MIN(m.id) AS oldest_id FROM messages m
             LEFT JOIN mailbox_cursors c ON c.address = m.recipient AND c.stream_type = 'direct' AND c.stream_ref = m.recipient
            WHERE m.sender = ? AND m.recipient_type = 'user' AND m.recipient != m.sender
              AND m.id > COALESCE(c.last_seen_id, 0) AND m.created_at < ?
            GROUP BY m.recipient ORDER BY m.recipient`;

// queuedTo: per recipient, the DMs its read point hasn't reached. Exported
// for the same EXPLAIN pin.
export const QUEUED_TO_SQL = `SELECT m.recipient, COUNT(*) AS n FROM messages m
            WHERE m.recipient_type = 'user' AND m.recipient IN (SELECT value FROM json_each(?)) AND m.recipient != m.sender
              AND m.id > COALESCE((SELECT c.last_seen_id FROM mailbox_cursors c WHERE c.address = m.recipient AND c.stream_type = 'direct' AND c.stream_ref = m.recipient), 0)
            GROUP BY m.recipient`;

// retract: the sender's message, still unread and unanswered. Exported for
// the same EXPLAIN pin.
export const RETRACTABLE_SQL = `SELECT 1 AS x FROM messages WHERE id = ? AND sender = ? AND recipient_type = 'user'
               AND id > COALESCE((SELECT last_seen_id FROM mailbox_cursors
                                   WHERE address = messages.recipient AND stream_type = 'direct' AND stream_ref = messages.recipient), 0)
               AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.parent_id = messages.id)`;

export function openDatabase(path: string, opts: OpenOptions): { db: Database; repo: Repo } {
  mkdirSync(dirname(path), { recursive: true });
  // auto_vacuum must precede the first page write.
  const db = openSqlite(path, "PRAGMA auto_vacuum = INCREMENTAL; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;", (d) => {
    // The first open under #284 creates aliases; that open seeds it.
    const first = !d.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'aliases'`).get();
    initSchema(d);
    initCoreSchema(d);
    seedSchema(d, first);
  });
  const repo = makeRepo(db, new DiskBlobs(opts.blobDir), opts.attachmentLimits ?? DEFAULT_ATTACHMENT_LIMITS, opts.attachmentUserQuota ?? DEFAULT_ATTACHMENT_USER_QUOTA);
  setAccess(db, serverAccess(repo, opts.humanReach ?? "team"));
  return { db, repo };
}

function initSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hosted_ownerships (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id),
      client_id TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, end_reason TEXT
    );
    CREATE TABLE IF NOT EXISTS hosted_sessions (
      session_id TEXT PRIMARY KEY, ownership_id INTEGER NOT NULL REFERENCES hosted_ownerships(id),
      user_id INTEGER NOT NULL REFERENCES users(id), client_id TEXT NOT NULL, grant_id TEXT NOT NULL,
      source_session_id TEXT NOT NULL, name TEXT, bind_gen INTEGER NOT NULL DEFAULT 0,
      root_session_id TEXT, place TEXT, lease_deadline INTEGER, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hosted_grant ON hosted_sessions(grant_id);
    CREATE INDEX IF NOT EXISTS idx_hosted_ownership ON hosted_sessions(ownership_id);
    CREATE INDEX IF NOT EXISTS idx_hosted_deadline ON hosted_sessions(lease_deadline);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_hosted_name ON hosted_sessions(user_id, name) WHERE name IS NOT NULL;
    CREATE TABLE IF NOT EXISTS oauth_requests (
      hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_requests_expiry ON oauth_requests(expires_at);
    CREATE TABLE IF NOT EXISTS oauth_browsers (
      hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_codes (
      hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_grants (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL,
      revoked_at INTEGER, data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_grants_user ON oauth_grants(user_id);
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('access','refresh')), expires_at INTEGER NOT NULL,
      spent_at INTEGER, revoked_at INTEGER, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_tokens_grant ON oauth_tokens(grant_id);

    CREATE TABLE IF NOT EXISTS users (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      email        TEXT NOT NULL UNIQUE,
      display_name TEXT,
      created_at   INTEGER NOT NULL,
      disabled_at  INTEGER
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL REFERENCES users(id),
      token_hash   TEXT NOT NULL UNIQUE,
      created_at   INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      revoked_at   INTEGER,
      label        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS identities (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      name       TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(user_id, name)
    );

    CREATE TABLE IF NOT EXISTS teams (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL UNIQUE,
      created_by  INTEGER NOT NULL REFERENCES users(id),
      policy      TEXT NOT NULL DEFAULT 'open',
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS team_members (
      team_id   INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id   INTEGER NOT NULL REFERENCES users(id),
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (team_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      sender          TEXT NOT NULL,
      recipient_type  TEXT NOT NULL CHECK (recipient_type IN ('user','team')),
      recipient       TEXT NOT NULL,
      body            TEXT NOT NULL,
      parent_id       INTEGER REFERENCES messages(id),
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_msg_recipient ON messages(recipient_type, recipient, id);
    CREATE INDEX IF NOT EXISTS idx_msg_sender ON messages(sender, id);

    CREATE TABLE IF NOT EXISTS cursors (
      identity_id   INTEGER NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
      stream_type   TEXT NOT NULL CHECK (stream_type IN ('direct','team')),
      stream_ref    TEXT NOT NULL,
      last_seen_id  INTEGER NOT NULL,
      PRIMARY KEY (identity_id, stream_type, stream_ref)
    );
    CREATE INDEX IF NOT EXISTS idx_cursors_stream ON cursors(stream_type, stream_ref);

    -- Read points by address (#284), replacing cursors, which an
    -- alias-less session can't key: identity_id is NOT NULL there.
    CREATE TABLE IF NOT EXISTS mailbox_cursors (
      address       TEXT    NOT NULL,
      stream_type   TEXT    NOT NULL CHECK (stream_type IN ('direct','team')),
      stream_ref    TEXT    NOT NULL,
      last_seen_id  INTEGER NOT NULL,
      PRIMARY KEY (address, stream_type, stream_ref)
    );

    -- Scope owners (#284 decision 5): every user (name = email) and team,
    -- and service principals (#270). name is one namespace: a team and a
    -- service principal can't share one, and neither can contain "@".
    CREATE TABLE IF NOT EXISTS principals (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      kind        TEXT    NOT NULL CHECK (kind IN ('user','team','service')),
      name        TEXT    NOT NULL UNIQUE,
      user_id     INTEGER REFERENCES users(id),
      team_id     INTEGER REFERENCES teams(id),
      parent_id   INTEGER REFERENCES principals(id),
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS access_log (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      at     INTEGER NOT NULL,
      actor  TEXT,
      action TEXT NOT NULL,
      target TEXT,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_at ON access_log(at);

    -- The Slack bridge (src/server/slack.ts): who is linked, and which Slack
    -- thread holds which grayboard thread. board is '' for a dm, so the
    -- UNIQUE constraint holds (NULLs never collide).
    CREATE TABLE IF NOT EXISTS slack_links (
      user_id    INTEGER PRIMARY KEY REFERENCES users(id),
      slack_user TEXT NOT NULL UNIQUE,
      dm_channel TEXT NOT NULL,
      linked_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS slack_threads (
      user_id   INTEGER NOT NULL REFERENCES users(id),
      thread_ts TEXT NOT NULL,
      kind      TEXT NOT NULL CHECK (kind IN ('dm','board')),
      board     TEXT NOT NULL DEFAULT '',
      root_id   INTEGER NOT NULL,
      peer      TEXT,
      last_id   INTEGER NOT NULL,
      PRIMARY KEY (user_id, thread_ts),
      UNIQUE (user_id, kind, board, root_id)
    );
    -- An outbound item partway into Slack (src/bridge/relay.ts Progress), so
    -- a restart neither reposts it nor shares its files twice. The outbox
    -- itself is the hub's unacked pushes.
    CREATE TABLE IF NOT EXISTS slack_progress (
      user_id   INTEGER NOT NULL REFERENCES users(id),
      ref       TEXT NOT NULL,
      progress  TEXT NOT NULL,
      PRIMARY KEY (user_id, ref)
    );

    -- Received direct messages marked handled without a reply (dm_ack).
    CREATE TABLE IF NOT EXISTS dm_acks (
      reader      TEXT NOT NULL,
      message_id  INTEGER NOT NULL,
      acked_at    INTEGER NOT NULL,
      PRIMARY KEY (reader, message_id)
    );

    -- Append writes' receipts (#254, src/server/write_dedup.ts): a repeat of
    -- an identical call within the window replays result_json, the first
    -- call's result without its frame, instead of writing again. Pruned on
    -- write per session and nightly (src/server/retention.ts).
    CREATE TABLE IF NOT EXISTS write_receipts (
      session     TEXT NOT NULL,
      sender      TEXT NOT NULL,
      fp          TEXT NOT NULL,
      tool        TEXT NOT NULL,
      ref_kind    TEXT NOT NULL CHECK (ref_kind IN ('message','post')),
      ref_id      INTEGER NOT NULL,
      result_json TEXT NOT NULL,
      at          INTEGER NOT NULL,
      PRIMARY KEY (session, sender, fp)
    );
    CREATE INDEX IF NOT EXISTS idx_write_receipts_at ON write_receipts(at);
  `);
  const oauthColumns: [string, string, string][] = [
    ["oauth_tokens", "access_scopes", "TEXT"],
    ["oauth_codes", "grant_id", "TEXT REFERENCES oauth_grants(id) ON DELETE CASCADE"],
  ];
  for (const [table, column, definition] of oauthColumns) {
    const columns = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
    if (!columns.some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_oauth_codes_grant ON oauth_codes(grant_id)");
  // dm_send pending: the sender owes a follow-up in the thread. sender_id:
  // the sending session's ID (#284), beside the address it sent as; null for
  // messages from before it, and for writers with no session.
  const msgCols = db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[];
  if (!msgCols.some((c) => c.name === "pending")) db.exec(`ALTER TABLE messages ADD COLUMN pending INTEGER NOT NULL DEFAULT 0`);
  if (!msgCols.some((c) => c.name === "sender_id")) db.exec(`ALTER TABLE messages ADD COLUMN sender_id TEXT`);
}

// #284's seeds, inside the schema transaction. Principals follow users and
// teams on every open (their writers insert them too). Aliases and read
// points come from the 1.x identities, handles and cursors once, on the open
// that creates aliases (`first`): after it, nothing reads or writes those
// tables, and a later seed would bring back an alias deleted since.
function seedSchema(db: Database, first: boolean): void {
  db.exec(`
    INSERT OR IGNORE INTO principals (kind, name, user_id, created_at) SELECT 'user', email, id, created_at FROM users;
    INSERT OR IGNORE INTO principals (kind, name, team_id, created_at) SELECT 'team', name, id, created_at FROM teams;
  `);
  if (!first) return;
  db.exec(`
    INSERT OR IGNORE INTO aliases (address, scope_kind, scope_ref, name, human, queue_off, created_by_principal, created_at, last_seen)
    SELECT u.email || '/' || i.name, 'person', u.email, i.name, h.human, h.queue_off, u.email, i.created_at, h.last_seen
      FROM identities i JOIN users u ON u.id = i.user_id LEFT JOIN handles h ON h.name = u.email || '/' || i.name;
    INSERT OR IGNORE INTO mailbox_cursors (address, stream_type, stream_ref, last_seen_id)
    SELECT u.email || '/' || i.name, c.stream_type, c.stream_ref, c.last_seen_id
      FROM cursors c JOIN identities i ON i.id = c.identity_id JOIN users u ON u.id = i.user_id;
  `);
}

/** A team's name another principal already has (#284 decision 5). */
export class PrincipalTaken extends Error {
  constructor(readonly name: string) {
    super(`the name "${name}" belongs to another team or service principal`);
  }
}

function makeRepo(db: Database, blobs: BlobStore, attachmentLimits: AttachmentLimits, attachmentUserQuota: number): Repo {
  const att = (rows: MessageRow[]) => withAttachments(db, "message", rows);
  const observers = new Set<() => void>();
  const changed = () => afterCommit(db, () => { for (const fn of observers) { try { fn(); } catch (error) { console.error("hosted invalidation failed", error); } } });
  const change = <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A): R => {
    const value = fn(...args);
    changed();
    return value;
  };
  const oauth = makeOAuthStore(db);
  const hosted = makeHostedStore(db);
  return {
    atomic<T>(fn: () => Sync<T>): T {
      return db.transaction(fn).immediate() as T;
    },

    oauth: { ...oauth, redeemCode: change(oauth.redeemCode), rotateRefresh: change(oauth.rotateRefresh), revokeToken: change(oauth.revokeToken) },
    hosted: { ...hosted, atomic: change(hosted.atomic), subscribe(fn) { observers.add(fn); return () => { observers.delete(fn); }; } },
    users: {
      upsertByEmail(email, displayName) {
        const now = Date.now();
        return db.transaction(() => {
          db.run(
            `INSERT INTO users (email, display_name, created_at) VALUES (?, ?, ?)
             ON CONFLICT(email) DO UPDATE SET display_name = excluded.display_name`,
            [email, displayName, now],
          );
          const user = db.query<User, [string]>("SELECT * FROM users WHERE email = ?").get(email)!;
          db.run(`INSERT OR IGNORE INTO principals (kind, name, user_id, created_at) VALUES ('user', ?, ?, ?)`, [email, user.id, now]);
          return user;
        })();
      },
      findByEmail(email) {
        return db.query<User, [string]>("SELECT * FROM users WHERE email = ?").get(email) ?? undefined;
      },
      findById(userId) {
        return db.query<User, [number]>("SELECT * FROM users WHERE id = ?").get(userId) ?? undefined;
      },
      setDisabled(userId, disabled) {
        db.transaction(() => {
          const now = Date.now();
          db.run("UPDATE users SET disabled_at = ? WHERE id = ?", [disabled ? now : null, userId]);
          if (disabled) {
            endHostedWhere(db, "disabled", now, row => row.user_id === userId);
            db.run("UPDATE oauth_grants SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", [now, userId]);
            db.run("DELETE FROM oauth_browsers WHERE user_id = ?", [userId]);
            db.run("DELETE FROM oauth_codes WHERE user_id = ? AND grant_id IS NULL", [userId]);
          }
        }).immediate();
        changed();
      },
    },

    sessions: {
      create(userId, tokenHash, label) {
        const now = Date.now();
        const r = db.run(
          `INSERT INTO sessions (user_id, token_hash, created_at, last_used_at, label) VALUES (?, ?, ?, ?, ?)`,
          [userId, tokenHash, now, now, label],
        );
        return db.query<Session, [number]>("SELECT * FROM sessions WHERE id = ?").get(Number(r.lastInsertRowid))!;
      },
      findByTokenHash(hash) {
        return (
          db.query<Session, [string]>(
            "SELECT * FROM sessions WHERE token_hash = ? AND revoked_at IS NULL",
          ).get(hash) ?? undefined
        );
      },
      revoke(sessionId) {
        db.run("UPDATE sessions SET revoked_at = ? WHERE id = ?", [Date.now(), sessionId]);
      },
      revokeAllForUser(userId) {
        db.transaction(() => {
          const now = Date.now();
          db.run("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", [now, userId]);
          endHostedWhere(db, "revoked", now, row => row.user_id === userId);
          db.run("UPDATE oauth_grants SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", [now, userId]);
          db.run("DELETE FROM oauth_codes WHERE user_id = ? AND grant_id IS NULL", [userId]);
        }).immediate();
        changed();
      },
      touch(sessionId, now) {
        db.run("UPDATE sessions SET last_used_at = ? WHERE id = ?", [now, sessionId]);
      },
    },

    aliases: {
      create(email, name) {
        return db.query<Alias, [string, string, string, string, number]>(
          `INSERT INTO aliases (address, scope_kind, scope_ref, name, created_by_principal, created_at)
           VALUES (?, 'person', ?, ?, ?, ?) RETURNING id, address, name, created_at`,
        ).get(`${email}/${name}`, email, name, email, Date.now())!;
      },
      listFor(email) {
        return db.query<Alias, [string]>(
          "SELECT id, address, name, created_at FROM aliases WHERE scope_ref = ? AND scope_kind = 'person' ORDER BY name",
        ).all(email);
      },
      find(email, name) {
        return db.query<Alias, [string, string]>(
          "SELECT id, address, name, created_at FROM aliases WHERE scope_ref = ? AND scope_kind = 'person' AND name = ?",
        ).get(email, name) ?? undefined;
      },
      findAllByName(name) {
        return db.query<{ email: string; name: string }, [string]>(
          "SELECT scope_ref AS email, name FROM aliases WHERE name = ? AND scope_kind = 'person'",
        ).all(name);
      },
      remove(email, name) {
        db.transaction(() => {
          const address = `${email}/${name}`;
          db.run("DELETE FROM mailbox_cursors WHERE address = ?", [address]);
          db.run("DELETE FROM aliases WHERE address = ?", [address]);
        })();
      },
    },

    teams: {
      create(name, createdBy) {
        return db.transaction(() => {
          const now = Date.now();
          if (db.query<{ x: number }, [string]>("SELECT 1 AS x FROM principals WHERE name = ?").get(name)) throw new PrincipalTaken(name);
          const team = db.query<Team, [string, number, number]>(
            "INSERT INTO teams (name, created_by, created_at) VALUES (?, ?, ?) RETURNING *",
          ).get(name, createdBy, now)!;
          db.run(`INSERT INTO principals (kind, name, team_id, created_at) VALUES ('team', ?, ?, ?)`, [name, team.id, now]);
          return team;
        })();
      },
      findByName(name) {
        return db.query<Team, [string]>("SELECT * FROM teams WHERE name = ?").get(name) ?? undefined;
      },
      listForUser(userId) {
        return db.query<Team, [number]>(
          `SELECT t.* FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE tm.user_id = ?`,
        ).all(userId);
      },
      addMember(teamId, userId) {
        db.run(
          "INSERT OR IGNORE INTO team_members (team_id, user_id, joined_at) VALUES (?, ?, ?)",
          [teamId, userId, Date.now()],
        );
      },
      removeMember(teamId, userId) {
        db.run("DELETE FROM team_members WHERE team_id = ? AND user_id = ?", [teamId, userId]);
      },
      listMembers(teamId) {
        return db.query<{ user_id: number; email: string }, [number]>(
          `SELECT u.id as user_id, u.email FROM users u
           JOIN team_members tm ON tm.user_id = u.id WHERE tm.team_id = ?`,
        ).all(teamId);
      },
      listMemberUserIds(teamId) {
        return db.query<{ user_id: number }, [number]>(
          "SELECT user_id FROM team_members WHERE team_id = ?",
        ).all(teamId).map(r => r.user_id);
      },
      isMember(teamId, userId) {
        return !!db.query<{ x: number }, [number, number]>(
          "SELECT 1 AS x FROM team_members WHERE team_id = ? AND user_id = ?",
        ).get(teamId, userId);
      },
    },

    messages: {
      insert(sender, recipientType, recipient, body, parentId, pending = false, attachmentIds = [], senderId = null) {
        return db.transaction(() => {
          const row = db.query<MessageRow, [string, string | null, string, string, string, number | null, number, number]>(
            `INSERT INTO messages (sender, sender_id, recipient_type, recipient, body, parent_id, created_at, pending)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${MSG_COLS}`,
          ).get(sender, senderId, recipientType, recipient, body, parentId, Date.now(), pending ? 1 : 0)!;
          const attachments = bindAttachments(db, attachmentIds, sender, { message_id: row.id }, attachmentLimits);
          return attachments.length ? { ...row, attachments } : row;
        })();
      },
      getById(id) {
        return db.query<MessageRow, [number]>(`SELECT ${MSG_COLS} FROM messages WHERE id = ?`).get(id) ?? undefined;
      },
      history(identityFull, peer, limit = 20, beforeId) {
        const cap = Math.min(limit, 200);
        if (peer) {
          if (beforeId !== undefined) {
            return att(db.query<MessageRow, [string, string, string, string, number, number]>(
              `SELECT ${MSG_COLS} FROM messages
               WHERE ((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?))
                 AND recipient_type = 'user' AND id < ?
               ORDER BY id DESC LIMIT ?`,
            ).all(identityFull, peer, peer, identityFull, beforeId, cap));
          }
          return att(db.query<MessageRow, [string, string, string, string, number]>(
            `SELECT ${MSG_COLS} FROM messages
             WHERE ((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?))
               AND recipient_type = 'user'
             ORDER BY id DESC LIMIT ?`,
          ).all(identityFull, peer, peer, identityFull, cap));
        }
        if (beforeId !== undefined) {
          return att(db.query<MessageRow, [string, string, number, number]>(
            `SELECT ${MSG_COLS} FROM messages
             WHERE (sender = ? OR (recipient = ? AND recipient_type = 'user')) AND id < ?
             ORDER BY id DESC LIMIT ?`,
          ).all(identityFull, identityFull, beforeId, cap));
        }
        return att(db.query<MessageRow, [string, string, number]>(
          `SELECT ${MSG_COLS} FROM messages
           WHERE (sender = ? OR (recipient = ? AND recipient_type = 'user'))
           ORDER BY id DESC LIMIT ?`,
        ).all(identityFull, identityFull, cap));
      },
      // The whole thread containing message `id`: walk up to its root, then down.
      thread(id) {
        return att(db.query<MessageRow, [number]>(`
          WITH RECURSIVE up(id, parent_id) AS (
            SELECT id, parent_id FROM messages WHERE id = ?
            UNION ALL
            SELECT m.id, m.parent_id FROM messages m JOIN up ON m.id = up.parent_id
          ),
          tree(id) AS (
            SELECT id FROM up WHERE parent_id IS NULL
            UNION ALL
            SELECT m.id FROM messages m JOIN tree t ON m.parent_id = t.id
          )
          SELECT ${M_MSG_COLS} FROM messages m JOIN tree t ON m.id = t.id ORDER BY m.id ASC
        `).all(id));
      },
      unreadSince(streams) {
        if (streams.length === 0) return [];
        const all: MessageRow[] = [];
        for (const s of streams) {
          const colType = s.type === "direct" ? "user" : "team";
          const rows = db.query<MessageRow, [string, string, number]>(
            `SELECT ${MSG_COLS} FROM messages WHERE recipient_type = ? AND recipient = ? AND id > ? ORDER BY id ASC`,
          ).all(colType, s.ref, s.since);
          all.push(...rows);
        }
        all.sort((a, b) => a.id - b.id);
        return att(all);
      },
      queuedTo(recipients) {
        const rows = db.query<{ recipient: string; n: number }, [string]>(
          QUEUED_TO_SQL,
        ).all(JSON.stringify(recipients));
        return new Map(rows.map((r) => [r.recipient, r.n]));
      },
      undeliveredFrom(sender, olderThan = Number.MAX_SAFE_INTEGER) {
        return db.query<{ recipient: string; n: number; oldest_id: number }, [string, number]>(
          UNDELIVERED_FROM_SQL,
        ).all(sender, olderThan);
      },
      receivedUnacked(reader, since) {
        return att(db.query<MessageRow, [string, number]>(
          `SELECT ${M_MSG_COLS} FROM messages m
            WHERE m.recipient_type = 'user' AND m.recipient = ? AND m.sender != m.recipient AND m.created_at >= ?
              AND NOT EXISTS (SELECT 1 FROM dm_acks a WHERE a.reader = m.recipient AND a.message_id = m.id)
            ORDER BY m.id ASC`,
        ).all(reader, since));
      },
      sentPending(sender, since) {
        return att(db.query<MessageRow, [string, number]>(
          `SELECT ${M_MSG_COLS} FROM messages m
            WHERE m.recipient_type = 'user' AND m.sender = ? AND m.pending = 1 AND m.created_at >= ?
              AND NOT EXISTS (SELECT 1 FROM dm_acks a WHERE a.reader = m.sender AND a.message_id = m.id)
            ORDER BY m.id ASC`,
        ).all(sender, since));
      },
      ack(reader, id) {
        db.run("INSERT OR IGNORE INTO dm_acks (reader, message_id, acked_at) VALUES (?, ?, ?)", [reader, id, Date.now()]);
      },
      retract(sender, id) {
        return db.transaction(() => {
          const retractable = db.query<{ x: number }, [number, string]>(
            RETRACTABLE_SQL,
          ).get(id, sender);
          if (!retractable) return false;
          dropAttachments(db, "message", "?", id);
          db.run("DELETE FROM messages WHERE id = ?", [id]);
          db.run("DELETE FROM dm_acks WHERE message_id = ?", [id]);
          return true;
        })();
      },
      prune(olderThanMs) {
        // Replies outlive pruned parents as roots; parent_id is a foreign key.
        db.transaction(() => {
          db.run(
            "DELETE FROM dm_acks WHERE message_id IN (SELECT id FROM messages WHERE created_at < ?)",
            [olderThanMs],
          );
          db.run(
            "UPDATE messages SET parent_id = NULL WHERE parent_id IN (SELECT id FROM messages WHERE created_at < ?)",
            [olderThanMs],
          );
          dropAttachments(db, "message", "SELECT id FROM messages WHERE created_at < ?", olderThanMs);
          db.run("DELETE FROM messages WHERE created_at < ?", [olderThanMs]);
        })();
      },
    },

    cursors: {
      get(address, streamType, streamRef) {
        const row = db.query<{ last_seen_id: number }, [string, string, string]>(
          "SELECT last_seen_id FROM mailbox_cursors WHERE address = ? AND stream_type = ? AND stream_ref = ?",
        ).get(address, streamType, streamRef);
        return row?.last_seen_id ?? 0;
      },
      directFor(address) {
        const row = db.query<{ last_seen_id: number }, [string, string]>(
          "SELECT last_seen_id FROM mailbox_cursors WHERE address = ? AND stream_type = 'direct' AND stream_ref = ?",
        ).get(address, address);
        return row?.last_seen_id ?? 0;
      },
      advance(address, streamType, streamRef, messageId) {
        db.run(
          `INSERT INTO mailbox_cursors (address, stream_type, stream_ref, last_seen_id) VALUES (?, ?, ?, ?)
           ON CONFLICT(address, stream_type, stream_ref)
           DO UPDATE SET last_seen_id = MAX(excluded.last_seen_id, mailbox_cursors.last_seen_id)`,
          [address, streamType, streamRef, messageId],
        );
      },
    },

    audit: {
      write(row) {
        db.run(
          "INSERT INTO access_log (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)",
          [row.at, row.actor, row.action, row.target, row.detail],
        );
      },
      last(action, target) {
        return (
          db
            .query<AccessLogRow, [string, string]>(
              "SELECT at, actor, action, target, detail FROM access_log WHERE action = ? AND target = ? ORDER BY at DESC, id DESC LIMIT 1",
            )
            .get(action, target) ?? undefined
        );
      },
      prune(olderThanMs) {
        db.run("DELETE FROM access_log WHERE at < ?", [olderThanMs]);
      },
    },

    slack: {
      links() {
        return db.query<SlackLink, []>(
          "SELECT l.*, u.email FROM slack_links l JOIN users u ON u.id = l.user_id ORDER BY l.user_id",
        ).all();
      },
      linkFor(userId) {
        return db.query<SlackLink, [number]>(
          "SELECT l.*, u.email FROM slack_links l JOIN users u ON u.id = l.user_id WHERE l.user_id = ?",
        ).get(userId) ?? undefined;
      },
      linkBySlackUser(slackUser) {
        return db.query<SlackLink, [string]>(
          "SELECT l.*, u.email FROM slack_links l JOIN users u ON u.id = l.user_id WHERE l.slack_user = ?",
        ).get(slackUser) ?? undefined;
      },
      link(userId, slackUser, dmChannel) {
        db.transaction(() => {
          // Threads and progress live in the old account's DM; a new account starts fresh.
          for (const table of ["slack_threads", "slack_progress"]) {
            db.run(
              `DELETE FROM ${table} WHERE user_id = ?
                 AND NOT EXISTS (SELECT 1 FROM slack_links WHERE user_id = ? AND slack_user = ? AND dm_channel = ?)`,
              [userId, userId, slackUser, dmChannel],
            );
          }
          db.run(
            `INSERT INTO slack_links (user_id, slack_user, dm_channel, linked_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET slack_user = excluded.slack_user, dm_channel = excluded.dm_channel, linked_at = excluded.linked_at`,
            [userId, slackUser, dmChannel, Date.now()],
          );
        })();
      },
      unlink(userId) {
        db.transaction(() => {
          db.run("DELETE FROM slack_threads WHERE user_id = ?", [userId]);
          db.run("DELETE FROM slack_progress WHERE user_id = ?", [userId]);
          db.run("DELETE FROM slack_links WHERE user_id = ?", [userId]);
        })();
      },
      thread(userId, kind, board, rootId) {
        const r = db.query<SlackThread, [number, string, string, number]>(
          "SELECT thread_ts, kind, board, root_id, peer, last_id FROM slack_threads WHERE user_id = ? AND kind = ? AND board = ? AND root_id = ?",
        ).get(userId, kind, board ?? "", rootId);
        return r ? { ...r, board: r.board || null } : undefined;
      },
      threadByTs(userId, threadTs) {
        const r = db.query<SlackThread, [number, string]>(
          "SELECT thread_ts, kind, board, root_id, peer, last_id FROM slack_threads WHERE user_id = ? AND thread_ts = ?",
        ).get(userId, threadTs);
        return r ? { ...r, board: r.board || null } : undefined;
      },
      addThread(userId, t) {
        db.run(
          `INSERT OR IGNORE INTO slack_threads (user_id, thread_ts, kind, board, root_id, peer, last_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [userId, t.thread_ts, t.kind, t.board ?? "", t.root_id, t.peer, t.last_id],
        );
      },
      advanceThread(userId, threadTs, id) {
        db.run("UPDATE slack_threads SET last_id = MAX(last_id, ?) WHERE user_id = ? AND thread_ts = ?", [id, userId, threadTs]);
      },
      progress(userId, ref) {
        const r = db.query<{ progress: string }, [number, string]>("SELECT progress FROM slack_progress WHERE user_id = ? AND ref = ?").get(userId, ref);
        return r ? JSON.parse(r.progress) : undefined;
      },
      setProgress(userId, ref, progress) {
        db.run(
          `INSERT INTO slack_progress (user_id, ref, progress) VALUES (?, ?, ?)
           ON CONFLICT(user_id, ref) DO UPDATE SET progress = excluded.progress`,
          [userId, ref, JSON.stringify(progress)],
        );
      },
      clearProgress(userId, ref) {
        db.run("DELETE FROM slack_progress WHERE user_id = ? AND ref = ?", [userId, ref]);
      },
    },

    writeReceipts: {
      find(session, sender, fp, since) {
        return db.query<WriteReceipt, [string, string, string, number]>(
          "SELECT * FROM write_receipts WHERE session = ? AND sender = ? AND fp = ? AND at > ?",
        ).get(session, sender, fp, since) ?? undefined;
      },
      upsert(r) {
        db.run(
          `INSERT INTO write_receipts (session, sender, fp, tool, ref_kind, ref_id, result_json, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(session, sender, fp) DO UPDATE SET
             tool = excluded.tool, ref_kind = excluded.ref_kind, ref_id = excluded.ref_id, result_json = excluded.result_json, at = excluded.at`,
          [r.session, r.sender, r.fp, r.tool, r.ref_kind, r.ref_id, r.result_json, r.at],
        );
      },
      refExists(kind, id) {
        const table = kind === "message" ? "messages" : "posts";
        return !!db.query<{ x: number }, [number]>(`SELECT 1 AS x FROM ${table} WHERE id = ?`).get(id);
      },
      pruneSession(session, before) {
        return db.run("DELETE FROM write_receipts WHERE session = ? AND at <= ?", [session, before]).changes;
      },
      prune(before) {
        return db.run("DELETE FROM write_receipts WHERE at <= ?", [before]).changes;
      },
    },

    blobs,
    attachmentLimits,
    attachmentUserQuota,
  };
}

function makeOAuthStore(db: Database): OAuthStore {
  const audit = (action: string, g: OAuthGrant, now: number, detail: Record<string, unknown> = {}) => {
    const user = db.query<{ email: string }, [number]>("SELECT email FROM users WHERE id = ?").get(g.userId);
    db.run("INSERT INTO access_log(at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)", [now, user?.email ?? null, action, g.id, JSON.stringify({ client_id: g.clientId, ...detail })]);
  };
  const invalid = { status: "invalid" } as const;
  const missing = { status: "not_found" } as const;
  const ok = <T>(value: T) => ({ status: "ok" as const, value });
  const hash = (s: string) => /^[a-f0-9]{64}$/.test(s);
  const time = (n: number) => Number.isSafeInteger(n) && n >= 0;
  const deadline = (created: number, expiry: number, now: number, ttl: number) =>
    time(now) && created === now && time(expiry) && expiry > now && expiry <= now + ttl;
  const scopes = (s: string[]) => Array.isArray(s) && s.length > 0 && s.length <= 16 &&
    s.every(v => typeof v === "string" && /^[a-zA-Z0-9:_-]{1,100}$/.test(v)) &&
    JSON.stringify(s) === JSON.stringify([...new Set(s)].sort());
  const binding = (b: OAuthBinding) => typeof b.clientId === "string" && b.clientId.length > 0 && b.clientId.length <= 512 &&
    typeof b.resource === "string" && b.resource.length > 0 && b.resource.length <= 2048 && scopes(b.scopes);
  const same = (a: OAuthBinding, b: OAuthBinding) => binding(b) && a.clientId === b.clientId && a.resource === b.resource &&
    JSON.stringify(a.scopes) === JSON.stringify(b.scopes);
  const authorization = (b: OAuthAuthorization) => binding(b) && typeof b.redirectUri === "string" &&
    b.redirectUri.length > 0 && b.redirectUri.length <= 2048 && /^[A-Za-z0-9_-]{43}$/.test(b.codeChallenge);
  const sameAuthorization = (a: OAuthAuthorization, b: OAuthAuthorization) => same(a, b) &&
    a.redirectUri === b.redirectUri && a.codeChallenge === b.codeChallenge;
  const authorizationData = (a: OAuthAuthorization): OAuthAuthorization => ({ clientId: a.clientId,
    resource: a.resource, scopes: a.scopes, redirectUri: a.redirectUri, codeChallenge: a.codeChallenge });
  const activeUser = (id: number) => !!db.query("SELECT 1 FROM users WHERE id = ? AND disabled_at IS NULL").get(id);
  const read = <T>(table: "oauth_requests" | "oauth_browsers" | "oauth_codes", h: string, now: number): T | undefined => {
    if (!time(now) || !hash(h)) return undefined;
    const row = db.query<{ data: string }, [string, number]>(`SELECT data FROM ${table} WHERE hash = ? AND expires_at > ?`).get(h, now);
    return row ? JSON.parse(row.data) as T : undefined;
  };
  const grant = (id: string): OAuthGrant | undefined => {
    const row = db.query<{ data: string; revoked_at: number | null }, [string]>("SELECT data, revoked_at FROM oauth_grants WHERE id = ?").get(id);
    return row ? { ...JSON.parse(row.data), revokedAt: row.revoked_at } : undefined;
  };
  const live = (g: OAuthGrant | undefined, now: number): g is OAuthGrant =>
    !!g && time(now) && g.revokedAt === null && g.expiresAt > now && activeUser(g.userId);
  const validPair = (p: OAuthTokenPair, b: OAuthBinding, now: number, cap: number) =>
    same(b, p) && hash(p.accessHash) && hash(p.refreshHash) && p.accessHash !== p.refreshHash &&
    deadline(now, p.accessExpiresAt, now, OAUTH_TTL.access) && p.accessExpiresAt <= cap &&
    deadline(now, p.refreshExpiresAt, now, OAUTH_TTL.refresh) && p.refreshExpiresAt <= cap;
  const insertPair = (p: OAuthTokenPair, id: string, now: number) => {
    for (const [h, kind, expiry] of [[p.accessHash, "access", p.accessExpiresAt], [p.refreshHash, "refresh", p.refreshExpiresAt]] as const) {
      db.run("INSERT INTO oauth_tokens(hash, grant_id, kind, expires_at, created_at, access_scopes) VALUES (?, ?, ?, ?, ?, ?)",
        [h, id, kind, expiry, now, kind === "access" ? JSON.stringify(p.scopes) : null]);
    }
  };
  const revokeGrant = (id: string, now: number) => {
    testPause("hosted:revoke:in-txn");
    db.run("UPDATE oauth_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [now, id]);
    endHostedWhere(db, "revoked", now, row => row.grant_id === id);
  };
  type Token = { hash: string; grant_id: string; kind: string; expires_at: number; spent_at: number | null; revoked_at: number | null; created_at: number };
  const token = (h: string) => db.query<Token, [string]>("SELECT * FROM oauth_tokens WHERE hash = ?").get(h);
  const browser = (h: string, now: number) => {
    const b = read<OAuthBrowserSession>("oauth_browsers", h, now);
    return b && activeUser(b.userId) ? b : undefined;
  };
  return {
    createRequest(input, now) {
      if (!authorization(input) || input.consentSessionHash !== null || ![input.requestHash, input.browserHash, input.csrfHash, input.stateHash].every(hash) ||
          !deadline(input.createdAt, input.expiresAt, now, OAUTH_TTL.request)) return invalid;
      return db.transaction(() => {
        db.run("DELETE FROM oauth_requests WHERE expires_at <= ?", [now]);
        const count = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM oauth_requests WHERE browser_hash = ?").get(input.browserHash)!.n;
        const total = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM oauth_requests").get()!.n;
        if (count >= 10 || total >= 1000) return { status: "capacity" } as const;
        db.run("INSERT INTO oauth_requests(hash, browser_hash, expires_at, data) VALUES (?, ?, ?, ?)", [input.requestHash, input.browserHash, input.expiresAt, JSON.stringify({ ...authorizationData(input),
          requestHash: input.requestHash, browserHash: input.browserHash, csrfHash: input.csrfHash, stateHash: input.stateHash,
          consentSessionHash: null, createdAt: input.createdAt, expiresAt: input.expiresAt })]);
        return ok(input);
      }).immediate();
    },
    findRequest(requestHash, browserHash, now) {
      const r = read<OAuthRequest>("oauth_requests", requestHash, now);
      return r?.browserHash === browserHash ? r : undefined;
    },
    bindRequestSession(requestHash, browserHash, sessionHash, now) {
      return db.transaction(() => {
        const r = read<OAuthRequest>("oauth_requests", requestHash, now);
        const b = browser(sessionHash, now);
        if (!r || !b) return missing;
        if (r.browserHash !== browserHash || (r.consentSessionHash !== null && r.consentSessionHash !== sessionHash)) return invalid;
        const bound = { ...r, consentSessionHash: sessionHash };
        db.run("UPDATE oauth_requests SET data = ? WHERE hash = ?", [JSON.stringify(bound), requestHash]);
        return ok(bound);
      }).immediate();
    },
    createBrowserSession(input, now, replaceHash) {
      if (!hash(input.sessionHash) || !deadline(input.createdAt, input.expiresAt, now, OAUTH_TTL.browser)) return invalid;
      return db.transaction(() => {
        if (!activeUser(input.userId)) return invalid;
        db.run("DELETE FROM oauth_browsers WHERE expires_at <= ?", [now]);
        const count = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM oauth_browsers").get()!.n;
        if (count >= 10000) return { status: "capacity" } as const;
        if (replaceHash) db.run("DELETE FROM oauth_browsers WHERE hash = ?", [replaceHash]);
        db.run("INSERT INTO oauth_browsers(hash, user_id, expires_at, data) VALUES (?, ?, ?, ?)", [input.sessionHash, input.userId, input.expiresAt, JSON.stringify({ sessionHash: input.sessionHash,
          userId: input.userId, createdAt: input.createdAt, expiresAt: input.expiresAt })]);
        return ok(input);
      }).immediate();
    },
    findBrowserSession: browser,
    revokeBrowserSession(h) { db.run("DELETE FROM oauth_browsers WHERE hash = ?", [h]); },
    decideRequest(input, now) {
      return db.transaction(() => {
        const r = read<OAuthRequest>("oauth_requests", input.requestHash, now);
        const b = browser(input.sessionHash, now);
        if (!r || !b) return missing;
        if (r.browserHash !== input.browserHash || r.csrfHash !== input.csrfHash || r.consentSessionHash !== input.sessionHash) return invalid;
        const c = input.code;
        if (input.approve && (!sameAuthorization(r, c) || c.userId !== b.userId || !hash(c.codeHash) ||
            !deadline(c.createdAt, c.expiresAt, now, OAUTH_TTL.code))) return invalid;
        db.run("DELETE FROM oauth_requests WHERE hash = ?", [input.requestHash]);
        if (!input.approve) return ok(null);
        db.run("INSERT INTO oauth_codes(hash, user_id, expires_at, data) VALUES (?, ?, ?, ?)", [c.codeHash, c.userId, c.expiresAt, JSON.stringify({ ...authorizationData(c),
          codeHash: c.codeHash, userId: c.userId, createdAt: c.createdAt, expiresAt: c.expiresAt })]);
        return ok(c);
      }).immediate();
    },
    findCodeScopes(h, clientId, resource, redirectUri, now) {
      if (!time(now) || !hash(h)) return undefined;
      const row = db.query<{ data: string; expires_at: number; grant_id: string | null }, [string]>(
        "SELECT data, expires_at, grant_id FROM oauth_codes WHERE hash = ?").get(h);
      if (!row) return undefined;
      const c: OAuthCode = JSON.parse(row.data);
      if (c.clientId !== clientId || c.resource !== resource || c.redirectUri !== redirectUri || !activeUser(c.userId)) return undefined;
      if (row.grant_id === null ? row.expires_at <= now : !live(grant(row.grant_id), now)) return undefined;
      return [...c.scopes];
    },
    redeemCode(input, now) {
      return db.transaction(() => {
        if (!time(now) || !hash(input.codeHash)) return invalid;
        const row = db.query<{ data: string; expires_at: number; grant_id: string | null }, [string]>(
          "SELECT data, expires_at, grant_id FROM oauth_codes WHERE hash = ?").get(input.codeHash);
        if (!row) return missing;
        const c: OAuthCode = JSON.parse(row.data);
        if (!sameAuthorization(c, input)) return invalid;
        if (row.grant_id !== null) {
          const g = grant(row.grant_id);
          if (!g || g.expiresAt <= now) return missing;
          revokeGrant(g.id, now);
          audit("oauth.code_replay_revoked", g, now, { level: "warning" });
          return { status: "replay" } as const;
        }
        if (row.expires_at <= now) return missing;
        if (!activeUser(c.userId) ||
            !/^[A-Za-z0-9_-]{16,128}$/.test(input.grantId) ||
            !deadline(now, input.grantExpiresAt, now, OAUTH_TTL.grant) ||
            !validPair(input.tokens, c, now, input.grantExpiresAt)) return invalid;
        const g: OAuthGrant = { id: input.grantId, userId: c.userId, clientId: c.clientId, resource: c.resource,
          scopes: c.scopes, createdAt: now, expiresAt: input.grantExpiresAt, revokedAt: null };
        db.run("INSERT INTO oauth_grants(id, user_id, expires_at, data) VALUES (?, ?, ?, ?)", [g.id, g.userId, g.expiresAt, JSON.stringify(g)]);
        db.run("UPDATE oauth_codes SET grant_id = ? WHERE hash = ?", [g.id, input.codeHash]);
        insertPair(input.tokens, g.id, now);
        audit("oauth.grant_issued", g, now);
        return ok({ grant: g, tokens: input.tokens });
      }).immediate();
    },
    findRefreshGrant(h, clientId, resource, now) {
      if (!time(now) || !hash(h)) return undefined;
      const row = db.query<{ data: string }, [string, number]>(`
        SELECT g.data FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id JOIN users u ON u.id = g.user_id
        WHERE t.hash = ? AND t.kind = 'refresh' AND g.revoked_at IS NULL AND g.expires_at > ? AND u.disabled_at IS NULL`).get(h, now);
      if (!row) return undefined;
      const g: OAuthGrant = JSON.parse(row.data);
      return g.clientId === clientId && g.resource === resource ? g : undefined;
    },
    rotateRefresh(input, now) {
      if (!time(now) || !hash(input.refreshHash)) return invalid;
      return db.transaction(() => {
        testPause("oauth:refresh:in-txn");
        const t = token(input.refreshHash);
        if (!t || t.kind !== "refresh") return missing;
        const g = grant(t.grant_id);
        if (!g || !binding(input) || g.clientId !== input.clientId || g.resource !== input.resource ||
            !input.scopes.every(s => g.scopes.includes(s))) return invalid;
        if (!live(g, now)) return invalid;
        // A recognized ancestor revokes even after its sliding expiry; tombstones outlive it.
        if (t.spent_at !== null) {
          revokeGrant(g.id, now);
          audit("oauth.refresh_replay_revoked", g, now, { level: "warning" });
          return { status: "replay" } as const;
        }
        if (t.revoked_at !== null || t.expires_at <= now || !validPair(input.tokens, input, now, Number.MAX_SAFE_INTEGER) ||
            input.tokens.accessHash === input.refreshHash || input.tokens.refreshHash === input.refreshHash) return invalid;
        const tokens = { ...input.tokens, accessExpiresAt: Math.min(input.tokens.accessExpiresAt, g.expiresAt),
          refreshExpiresAt: Math.min(input.tokens.refreshExpiresAt, g.expiresAt) };
        db.run("UPDATE oauth_tokens SET spent_at = ? WHERE hash = ?", [now, input.refreshHash]);
        insertPair(tokens, g.id, now);
        audit("oauth.refreshed", g, now);
        return ok({ grant: g, tokens });
      }).immediate();
    },
    revokeToken(h, clientId, now) {
      if (!time(now) || !hash(h)) return;
      db.transaction(() => {
        const t = token(h);
        if (!t) return;
        const g = grant(t.grant_id);
        if (!g || g.clientId !== clientId) return;
        if (t.kind === "refresh") revokeGrant(g.id, now);
        else db.run("UPDATE oauth_tokens SET revoked_at = ? WHERE hash = ? AND revoked_at IS NULL", [now, h]);
        audit("oauth.revoked", g, now, { kind: t.kind });
      }).immediate();
    },
    findActiveAccess(h, resource, requiredScopes, now) {
      if (!time(now) || !hash(h) || !Array.isArray(requiredScopes)) return undefined;
      // One read snapshot binds token, grant and user liveness.
      const row = db.query<{ data: string; created_at: number; token_expiry: number; access_scopes: string | null }, [string, number, number]>(`
        SELECT g.data, t.created_at, t.expires_at AS token_expiry, t.access_scopes FROM oauth_tokens t
        JOIN oauth_grants g ON g.id = t.grant_id JOIN users u ON u.id = g.user_id
        WHERE t.hash = ? AND t.kind = 'access' AND t.revoked_at IS NULL AND t.expires_at > ?
          AND g.revoked_at IS NULL AND g.expires_at > ? AND u.disabled_at IS NULL`).get(h, now, now);
      if (!row) return undefined;
      const g: OAuthGrant = JSON.parse(row.data);
      // Pre-downscope rows were issued with exactly the full grant scope.
      const accessScopes: string[] = row.access_scopes === null ? g.scopes : JSON.parse(row.access_scopes);
      if (!scopes(accessScopes) || !accessScopes.every(s => g.scopes.includes(s)) ||
          g.resource !== resource || !requiredScopes.every(s => accessScopes.includes(s))) return undefined;
      const a: OAuthAccess = { tokenHash: h, grantId: g.id, userId: g.userId, clientId: g.clientId,
        resource: g.resource, scopes: accessScopes, createdAt: row.created_at, expiresAt: row.token_expiry };
      return a;
    },
    isGrantActive(id, now) {
      if (!time(now)) return false;
      return !!db.query(`SELECT 1 FROM oauth_grants g JOIN users u ON u.id = g.user_id
        WHERE g.id = ? AND g.revoked_at IS NULL AND g.expires_at > ? AND u.disabled_at IS NULL`).get(id, now);
    },
    cleanup(now) {
      if (!time(now)) throw new RangeError("invalid OAuth cleanup time");
      db.transaction(() => {
        for (const table of ["oauth_requests", "oauth_browsers"]) db.run(`DELETE FROM ${table} WHERE expires_at <= ?`, [now]);
        db.run("DELETE FROM oauth_codes WHERE grant_id IS NULL AND expires_at <= ?", [now]);
        db.run("DELETE FROM oauth_tokens WHERE kind = 'access' AND expires_at <= ?", [now]);
        // Keep refresh tombstones until the absolute family deadline, including revoked families.
        db.run("DELETE FROM oauth_grants WHERE expires_at <= ?", [now]);
      }).immediate();
    },
  };
}

function makeHostedStore(db: Database): HostedStore {
  const get = (id: string) => db.query<HostedSession, [string]>("SELECT * FROM hosted_sessions WHERE session_id = ?").get(id) ?? undefined;
  const audit = (session: string, action: string, detail: Record<string, unknown>, now: number) => {
    const owner = db.query<{ email: string; client_id: string }, [string]>(`SELECT u.email, o.client_id FROM hosted_ownerships o JOIN users u ON u.id = o.user_id
      WHERE o.session_id = ? ORDER BY o.id DESC LIMIT 1`).get(session);
    db.run("INSERT INTO access_log(at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)", [now, owner?.email ?? null, action, session, JSON.stringify({ ...detail, client_id: owner?.client_id ?? null })]);
  };
  const store: HostedStore = {
    atomic: fn => db.transaction(fn).immediate(),
    subscribe: () => () => {},
    get,
    all: () => db.query<HostedSession, []>("SELECT * FROM hosted_sessions").all(),
    start(session, user, client, now) {
      const r = db.run("INSERT INTO hosted_ownerships(session_id, user_id, client_id, started_at) VALUES (?, ?, ?, ?)", [session, user, client, now]);
      const id = Number(r.lastInsertRowid);
      audit(session, "hosted.ownership_started", { ownership: id }, now);
      return id;
    },
    insert(row) {
      db.run("INSERT INTO hosted_sessions(session_id, ownership_id, user_id, client_id, grant_id, source_session_id, name, bind_gen, root_session_id, place, lease_deadline, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [row.session_id, row.ownership_id, row.user_id, row.client_id, row.grant_id, row.source_session_id, row.name, row.bind_gen, row.root_session_id, row.place, row.lease_deadline, row.created_at, row.last_seen_at]);
    },
    update(row) {
      db.run("UPDATE hosted_sessions SET grant_id = ?, name = ?, bind_gen = ?, root_session_id = ?, ownership_id = ?, place = ?, lease_deadline = ?, last_seen_at = ? WHERE session_id = ?",
        [row.grant_id, row.name, row.bind_gen, row.root_session_id, row.ownership_id, row.place, row.lease_deadline, row.last_seen_at, row.session_id]);
    },
    childEnd(session, now) {
      const row = get(session);
      if (!row?.root_session_id) return;
      db.run("DELETE FROM hosted_sessions WHERE session_id = ?", [session]);
      audit(row.root_session_id, "hosted.child_released", { child: session, reason: "closed" }, now);
    },
    end(session, reason, now, deadline) {
      const row = get(session);
      if (!row || row.root_session_id || (deadline !== undefined && row.lease_deadline !== deadline)) return false;
      testPause(reason === "expired" ? "hosted:lease-expire:in-txn" : "hosted:release:in-txn");
      const children = db.query<HostedSession, [number]>("DELETE FROM hosted_sessions WHERE ownership_id = ? RETURNING *").all(row.ownership_id);
      db.run("UPDATE hosted_ownerships SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL", [now, reason, row.ownership_id]);
      if (row.name) {
        const user = db.query<{ email: string }, [number]>("SELECT email FROM users WHERE id = ?").get(row.user_id)!;
        db.run("DELETE FROM alias_holds WHERE address = ? AND id = ?", [`${user.email}/${row.name}`, session]);
        db.run("INSERT INTO binding_events(session_id, name, event, at, detail) VALUES (?, ?, 'released', ?, ?)", [session, `${user.email}/${row.name}`, now, reason]);
      }
      for (const child of children) if (child.root_session_id) audit(session, "hosted.child_released", { child: child.session_id, reason }, now);
      if (row.lease_deadline !== null) audit(session, "hosted.lease_closed", { reason, ownership: row.ownership_id }, now);
      return true;
    },
  };
  return store;
}

function endHostedWhere(db: Database, reason: HostedEnd, now: number, predicate: (row: HostedSession) => boolean) {
  const hosted = makeHostedStore(db);
  for (const row of hosted.all()) if (!row.root_session_id && predicate(row)) hosted.end(row.session_id, reason, now);
}
