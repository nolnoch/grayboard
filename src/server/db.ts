import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { setAccess } from "../core/boards.ts";
import { bindAttachments, dropAttachments, withAttachments, type BlobStore, type Uploader } from "../core/attachments.ts";
import { addressParts, type ScopeKind } from "../core/addresses.ts";
import type { Principal, Resolver } from "../core/resolver.ts";
import { initCoreSchema } from "../core/schema.ts";
import type { MailPort } from "../core/session_end.ts";
import { openSqlite } from "../core/sqlite.ts";
import { serverAccess } from "./access.ts";
import type { HumanReach } from "./can_send.ts";
import { DEFAULT_ATTACHMENT_LIMITS, DEFAULT_ATTACHMENT_USER_QUOTA, type AttachmentInfo, type AttachmentLimits } from "../shared/attachments.ts";
import { DiskBlobs } from "./blobs.ts";

// Row types
export type User     = { id: number; email: string; display_name: string | null; created_at: number; disabled_at: number | null };
export type Session  = { id: number; user_id: number; token_hash: string; created_at: number; last_used_at: number; revoked_at: number | null; label: string | null };
// An alias (#284): a name in a scope, `<scope_ref>/<name>`. A person scope's
// ref is the user's email; a team or service scope's is the principal's name.
export type Alias = { id: number; address: string; scope_kind: ScopeKind; scope_ref: string; name: string; created_at: number };
// A scope owner (#284 decision 5): a user (name = email), a team or a service principal.
export type PrincipalRow = { id: number; kind: Principal["kind"]; name: string; user_id: number | null; team_id: number | null; parent_id: number | null; created_at: number };

export type Team     = { id: number; name: string; created_by: number; policy: string; created_at: number };
// attachments: present on reads when the message carries files.
export type MessageRow = { id: number; sender: string; recipient_type: "user" | "team"; recipient: string; body: string; parent_id: number | null; created_at: number; pending: number; kind: "bounce" | null; attachments?: AttachmentInfo[] };
// Only a direct message's sender and recipient can see it, its thread, or
// the files it carries. One you're not in reads as missing, so its existence
// doesn't leak. `me`: every address the caller reads as (#284 S8).
export function participant(m: MessageRow | undefined, me: string[]): m is MessageRow {
  return !!m && m.recipient_type === "user" && (me.includes(m.sender) || me.includes(m.recipient));
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
const MSG_COLS = `id, sender, recipient_type, recipient, body, parent_id, created_at, pending, kind`;
const M_MSG_COLS = `m.id, m.sender, m.recipient_type, m.recipient, m.body, m.parent_id, m.created_at, m.pending, m.kind`;
const ALIAS_COLS = `id, address, scope_kind, scope_ref, name, created_at`;

// A synchronous callback's result: a promise is refused at compile time, so
// nothing can await between a transaction's reads and its writes.
export type Sync<T> = T extends PromiseLike<unknown> ? never : T;

export interface Repo {
  // Runs fn in one IMMEDIATE transaction, or a savepoint inside an open one.
  atomic<T>(fn: () => Sync<T>): T;
  users: {
    upsertByEmail(email: string, displayName: string | null): User;
    findByEmail(email: string): User | undefined;
    findById(userId: number): User | undefined;
    setDisabled(userId: number, disabled: boolean): void;
  };
  sessions: {
    create(userId: number, tokenHash: string, label: string | null): Session;
    findByTokenHash(hash: string): Session | undefined;
    findById(sessionId: number): Session | undefined;
    revoke(sessionId: number): void;
    revokeAllForUser(userId: number): void;
    touch(sessionId: number, now: number): void;
  };
  principals: {
    findByName(name: string): PrincipalRow | undefined;
  };
  // Who an address acts for (#284 S12): an ID's registering user, an
  // alias's scope owner, a team broadcast's team.
  resolver: Resolver;
  // Names in scopes, keyed by address.
  aliases: {
    // createdBy: the principal that made it (the binder's user for a lazy create).
    create(scope: { scope_kind: ScopeKind; scope_ref: string; name: string }, createdBy: string): Alias;
    find(address: string): Alias | undefined;
    listForScope(kind: ScopeKind, ref: string): Alias[];
    // Every scope's alias of this name.
    findAllByName(name: string): Alias[];
    // Also deletes the alias's read points.
    remove(address: string): void;
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
    // attachmentIds: unbound uploads of `uploader` (the sending session's
    // address set, #284 PR 4 S5, and its user, #367), bound in the insert's
    // transaction (a refused id throws CoreError and nothing is written).
    // senderId: the sending session's ID (#284); null for a writer with no
    // session.
    insert(
      sender: string, recipientType: "user" | "team", recipient: string, body: string, parentId: number | null, pending?: boolean, attachmentIds?: number[],
      senderId?: string | null, uploader?: Uploader,
    ): MessageRow;
    // The row alone, without its attachments: an access or ack check.
    getById(id: number): MessageRow | undefined;
    // The bounces an ended session's end sent (#284 decision 4): an ID ends once.
    bouncesFrom(id: string): MessageRow[];
    // A session's direct messages, sent or received by any of its addresses
    // (#284 S8): with peer, only those between the set and peer.
    history(addresses: string[], peer?: string, limit?: number, beforeId?: number): MessageRow[];
    thread(id: number): MessageRow[];
    unreadSince(streams: { type: "direct" | "team"; ref: string; since: number }[]): MessageRow[];
    // Direct messages to each of recipients still past its cursor, sent by
    // someone else; recipients with none are absent.
    queuedTo(recipients: string[]): Map<string, number>;
    // Direct messages from any of senders still past each recipient's cursor, per recipient.
    undeliveredFrom(senders: string[], olderThan?: number): { recipient: string; n: number; oldest_id: number }[];
    // Direct messages to any of readers since `since` that their recipient hasn't acked, oldest first.
    receivedUnacked(readers: string[], since: number): MessageRow[];
    // Direct messages from any of senders since `since` sent pending and not acked by their sender, oldest first.
    sentPending(senders: string[], since: number): MessageRow[];
    ack(reader: string, id: number): void;
    // Deletes a direct message from sender that's past the recipient's cursor
    // and has no reply. False if any of that doesn't hold.
    retract(sender: string, id: number): boolean;
    prune(olderThanMs: number): void;
  };
  // An ended session's mail, as core endSession reaches it (#284 decision 4).
  mail: MailPort;
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
            WHERE m.sender IN (SELECT value FROM json_each(?)) AND m.recipient_type = 'user' AND m.recipient != m.sender
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
  // auto_vacuum first: it takes effect only before the file's first page is
  // written, and the WAL switch writes it.
  const db = openSqlite(path, "PRAGMA auto_vacuum = INCREMENTAL; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;", (d) => {
    // The first open under #284 creates aliases; that open seeds it.
    const first = !d.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'aliases'`).get();
    initSchema(d);
    initCoreSchema(d);
    seedSchema(d, first);
  });
  const repo = makeRepo(db, new DiskBlobs(opts.blobDir), opts.attachmentLimits ?? DEFAULT_ATTACHMENT_LIMITS, opts.attachmentUserQuota ?? DEFAULT_ATTACHMENT_USER_QUOTA);
  setAccess(db, serverAccess(repo, db, opts.humanReach ?? "team"));
  return { db, repo };
}

function initSchema(db: Database): void {
  db.exec(`
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
  // dm_send pending: the sender owes a follow-up in the thread. sender_id:
  // the sending session's ID (#284), beside the address it sent as; null for
  // messages from before it, and for writers with no session. kind: 'bounce'
  // for mail returned because its recipient session ended (#284 decision 10).
  const msgCols = db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[];
  if (!msgCols.some((c) => c.name === "pending")) db.exec(`ALTER TABLE messages ADD COLUMN pending INTEGER NOT NULL DEFAULT 0`);
  if (!msgCols.some((c) => c.name === "sender_id")) db.exec(`ALTER TABLE messages ADD COLUMN sender_id TEXT`);
  if (!msgCols.some((c) => c.name === "kind")) db.exec(`ALTER TABLE messages ADD COLUMN kind TEXT`);
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
  const principalByName = (name: string): PrincipalRow | undefined =>
    db.query<PrincipalRow, [string]>("SELECT * FROM principals WHERE name = ?").get(name) ?? undefined;
  return {
    atomic<T>(fn: () => Sync<T>): T {
      return db.transaction(fn).immediate() as T;
    },

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
        db.run("UPDATE users SET disabled_at = ? WHERE id = ?", [disabled ? Date.now() : null, userId]);
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
      // By row, revoked ones included: the caller reads revoked_at (#351).
      findById(sessionId) {
        return db.query<Session, [number]>("SELECT * FROM sessions WHERE id = ?").get(sessionId) ?? undefined;
      },
      revoke(sessionId) {
        db.run("UPDATE sessions SET revoked_at = ? WHERE id = ?", [Date.now(), sessionId]);
      },
      revokeAllForUser(userId) {
        db.run(
          "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
          [Date.now(), userId],
        );
      },
      touch(sessionId, now) {
        db.run("UPDATE sessions SET last_used_at = ? WHERE id = ?", [now, sessionId]);
      },
    },

    principals: {
      findByName: principalByName,
    },

    resolver: {
      principalOf(address) {
        const p = addressParts(address);
        if (!p || p.kind === "bare") return null;
        const name = p.kind === "id"
          ? db.query<{ principal: string | null }, [string]>("SELECT principal FROM ids WHERE id = ?").get(p.address)?.principal
          : p.kind === "alias" ? p.scope : p.name;
        const row = name ? principalByName(name) : undefined;
        // team:x names a team, never a service; a person scope (an email) is only a user's.
        if (!row || (p.kind === "team" && row.kind !== "team")) return null;
        if (p.kind === "alias" && (p.scopeKind === "person") !== (row.kind === "user")) return null;
        return { kind: row.kind, name: row.name };
      },
    },

    aliases: {
      create({ scope_kind, scope_ref, name }, createdBy) {
        return db.query<Alias, [string, string, string, string, string, number]>(
          `INSERT INTO aliases (address, scope_kind, scope_ref, name, created_by_principal, created_at)
           VALUES (?, ?, ?, ?, ?, ?) RETURNING ${ALIAS_COLS}`,
        ).get(`${scope_ref}/${name}`, scope_kind, scope_ref, name, createdBy, Date.now())!;
      },
      find(address) {
        return db.query<Alias, [string]>(`SELECT ${ALIAS_COLS} FROM aliases WHERE address = ?`).get(address) ?? undefined;
      },
      listForScope(kind, ref) {
        return db.query<Alias, [string, string]>(
          `SELECT ${ALIAS_COLS} FROM aliases WHERE scope_ref = ? AND scope_kind = ? ORDER BY name`,
        ).all(ref, kind);
      },
      findAllByName(name) {
        return db.query<Alias, [string]>(`SELECT ${ALIAS_COLS} FROM aliases WHERE name = ? ORDER BY address`).all(name);
      },
      remove(address) {
        db.transaction(() => {
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
      insert(sender, recipientType, recipient, body, parentId, pending = false, attachmentIds = [], senderId = null, uploader) {
        if (attachmentIds.length && !uploader) throw new Error("messages.insert: attachments need their uploader");
        return db.transaction(() => {
          const row = db.query<MessageRow, [string, string | null, string, string, string, number | null, number, number]>(
            `INSERT INTO messages (sender, sender_id, recipient_type, recipient, body, parent_id, created_at, pending)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${MSG_COLS}`,
          ).get(sender, senderId, recipientType, recipient, body, parentId, Date.now(), pending ? 1 : 0)!;
          const attachments = bindAttachments(db, attachmentIds, uploader!, { message_id: row.id }, attachmentLimits);
          return attachments.length ? { ...row, attachments } : row;
        })();
      },
      getById(id) {
        return db.query<MessageRow, [number]>(`SELECT ${MSG_COLS} FROM messages WHERE id = ?`).get(id) ?? undefined;
      },
      bouncesFrom(id) {
        return db.query<MessageRow, [string]>(`SELECT ${MSG_COLS} FROM messages WHERE sender = ? AND kind = 'bounce' ORDER BY id`).all(id);
      },
      history(addresses, peer, limit = 20, beforeId) {
        const set = JSON.stringify(addresses);
        const before = beforeId ?? Number.MAX_SAFE_INTEGER;
        const cap = Math.min(limit, 200);
        if (peer) {
          return att(db.query<MessageRow, [string, string, number, number]>(
            `SELECT ${MSG_COLS} FROM messages
             WHERE ((sender IN (SELECT value FROM json_each(?1)) AND recipient = ?2)
                 OR (sender = ?2 AND recipient IN (SELECT value FROM json_each(?1))))
               AND recipient_type = 'user' AND id < ?3
             ORDER BY id DESC LIMIT ?4`,
          ).all(set, peer, before, cap));
        }
        return att(db.query<MessageRow, [string, number, number]>(
          `SELECT ${MSG_COLS} FROM messages
           WHERE (sender IN (SELECT value FROM json_each(?1))
               OR (recipient IN (SELECT value FROM json_each(?1)) AND recipient_type = 'user'))
             AND id < ?2
           ORDER BY id DESC LIMIT ?3`,
        ).all(set, before, cap));
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
      undeliveredFrom(senders, olderThan = Number.MAX_SAFE_INTEGER) {
        return db.query<{ recipient: string; n: number; oldest_id: number }, [string, number]>(
          UNDELIVERED_FROM_SQL,
        ).all(JSON.stringify(senders), olderThan);
      },
      receivedUnacked(readers, since) {
        return att(db.query<MessageRow, [string, number]>(
          `SELECT ${M_MSG_COLS} FROM messages m
            WHERE m.recipient_type = 'user' AND m.recipient IN (SELECT value FROM json_each(?)) AND m.sender != m.recipient AND m.created_at >= ?
              AND NOT EXISTS (SELECT 1 FROM dm_acks a WHERE a.reader = m.recipient AND a.message_id = m.id)
            ORDER BY m.id ASC`,
        ).all(JSON.stringify(readers), since));
      },
      sentPending(senders, since) {
        return att(db.query<MessageRow, [string, number]>(
          `SELECT ${M_MSG_COLS} FROM messages m
            WHERE m.recipient_type = 'user' AND m.sender IN (SELECT value FROM json_each(?)) AND m.pending = 1 AND m.created_at >= ?
              AND NOT EXISTS (SELECT 1 FROM dm_acks a WHERE a.reader = m.sender AND a.message_id = m.id)
            ORDER BY m.id ASC`,
        ).all(JSON.stringify(senders), since));
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

    mail: {
      unread(id) {
        return db.query<{ id: number; sender: string }, [string]>(
          `SELECT m.id, m.sender FROM messages m
            WHERE m.recipient_type = 'user' AND m.recipient = ?1 AND m.sender <> ?1
              AND m.id > COALESCE((SELECT last_seen_id FROM mailbox_cursors
                                    WHERE address = ?1 AND stream_type = 'direct' AND stream_ref = ?1), 0)
            ORDER BY m.id`,
        ).all(id);
      },
      bounce(from, to, parentId, body, now) {
        db.query(
          `INSERT INTO messages (sender, sender_id, recipient_type, recipient, body, parent_id, created_at, pending, kind)
           VALUES (?1, ?1, 'user', ?2, ?3, ?4, ?5, 0, 'bounce')`,
        ).run(from, to, body, parentId, now);
      },
      dropReader(id) {
        db.query(`DELETE FROM mailbox_cursors WHERE address = ?`).run(id);
        db.query(`DELETE FROM dm_acks WHERE reader = ?`).run(id);
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
