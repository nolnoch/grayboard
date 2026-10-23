import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { setAccess } from "../core/boards.ts";
import { bindAttachments, dropAttachments, withAttachments, type BlobStore } from "../core/attachments.ts";
import { initCoreSchema } from "../core/schema.ts";
import { serverAccess } from "./access.ts";
import type { HumanReach } from "./can_send.ts";
import { DEFAULT_ATTACHMENT_LIMITS, type AttachmentInfo, type AttachmentLimits } from "../shared/attachments.ts";
import { DiskBlobs } from "./blobs.ts";

// Row types
export type User     = { id: number; email: string; display_name: string | null; created_at: number; disabled_at: number | null };
export type Session  = { id: number; user_id: number; token_hash: string; created_at: number; last_used_at: number; revoked_at: number | null; label: string | null };
export type Identity = { id: number; user_id: number; name: string; created_at: number };
export type Team     = { id: number; name: string; created_by: number; policy: string; created_at: number };
// attachments: present on reads when the message carries files.
export type MessageRow = { id: number; sender: string; recipient_type: "user" | "team"; recipient: string; body: string; parent_id: number | null; created_at: number; pending: number; attachments?: AttachmentInfo[] };
// A user's Slack link: their member ID and their DM with the bridge's app.
export type SlackLink = { user_id: number; email: string; slack_user: string; dm_channel: string; linked_at: number };
// thread_ts: the Slack top-level message. root_id: the grayboard thread's root
// (message id for dm, post id for board). peer: the other party in a dm.
// last_id: the newest grayboard id in the thread, the parent for a reply.
export type SlackThread = { thread_ts: string; kind: "dm" | "board"; board: string | null; root_id: number; peer: string | null; last_id: number };
export type AccessLogRow = { at: number; actor: string | null; action: string; target: string | null; detail: string | null };

export interface Repo {
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
  identities: {
    create(userId: number, name: string): Identity;
    listForUser(userId: number): Identity[];
    findByUserAndName(userId: number, name: string): Identity | undefined;
    findAllByName(name: string): { email: string; name: string }[];
    remove(userId: number, name: string): void;
  };
  teams: {
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
    insert(sender: string, recipientType: "user" | "team", recipient: string, body: string, parentId: number | null, pending?: boolean, attachmentIds?: number[]): MessageRow;
    getById(id: number): MessageRow | undefined;
    history(identityFull: string, peer?: string, limit?: number, beforeId?: number): MessageRow[];
    thread(id: number): MessageRow[];
    unreadSince(streams: { type: "direct" | "team"; ref: string; since: number }[]): MessageRow[];
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
  cursors: {
    get(identityId: number, streamType: "direct" | "team", streamRef: string): number;
    // How far an identity (by full address) has received its direct messages.
    directFor(identityFull: string): number;
    advance(identityId: number, streamType: "direct" | "team", streamRef: string, messageId: number): void;
  };
  audit: {
    write(row: AccessLogRow): void;
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
  // Attachment bytes, by sha256; the attachment rows are metadata in this database.
  blobs: BlobStore;
  // The server's per-file and per-message caps; insert binds files under them.
  attachmentLimits: AttachmentLimits;
}

export type OpenOptions = { blobDir: string; humanReach?: HumanReach; attachmentLimits?: AttachmentLimits };

export function openDatabase(path: string, opts: OpenOptions): { db: Database; repo: Repo } {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec(
    "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA auto_vacuum = INCREMENTAL;",
  );
  initSchema(db);
  initCoreSchema(db);
  const repo = makeRepo(db, new DiskBlobs(opts.blobDir), opts.attachmentLimits ?? DEFAULT_ATTACHMENT_LIMITS);
  setAccess(db, serverAccess(repo, opts.humanReach ?? "team"));
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
  `);
  // dm_send pending: the sender owes a follow-up in the thread.
  const msgCols = db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[];
  if (!msgCols.some((c) => c.name === "pending")) db.exec(`ALTER TABLE messages ADD COLUMN pending INTEGER NOT NULL DEFAULT 0`);
}

function makeRepo(db: Database, blobs: BlobStore, attachmentLimits: AttachmentLimits): Repo {
  const att = (rows: MessageRow[]) => withAttachments(db, "message", rows);
  return {
    users: {
      upsertByEmail(email, displayName) {
        const now = Date.now();
        db.run(
          `INSERT INTO users (email, display_name, created_at) VALUES (?, ?, ?)
           ON CONFLICT(email) DO UPDATE SET display_name = excluded.display_name`,
          [email, displayName, now],
        );
        return db.query<User, [string]>("SELECT * FROM users WHERE email = ?").get(email)!;
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

    identities: {
      create(userId, name) {
        const now = Date.now();
        db.run("INSERT INTO identities (user_id, name, created_at) VALUES (?, ?, ?)", [userId, name, now]);
        return db.query<Identity, [number, string]>(
          "SELECT * FROM identities WHERE user_id = ? AND name = ?",
        ).get(userId, name)!;
      },
      listForUser(userId) {
        return db.query<Identity, [number]>("SELECT * FROM identities WHERE user_id = ?").all(userId);
      },
      findByUserAndName(userId, name) {
        return (
          db.query<Identity, [number, string]>(
            "SELECT * FROM identities WHERE user_id = ? AND name = ?",
          ).get(userId, name) ?? undefined
        );
      },
      findAllByName(name) {
        return db.query<{ email: string; name: string }, [string]>(
          "SELECT u.email, i.name FROM identities i JOIN users u ON u.id = i.user_id WHERE i.name = ?",
        ).all(name);
      },
      remove(userId, name) {
        db.run("DELETE FROM identities WHERE user_id = ? AND name = ?", [userId, name]);
      },
    },

    teams: {
      create(name, createdBy) {
        db.run("INSERT INTO teams (name, created_by, created_at) VALUES (?, ?, ?)", [name, createdBy, Date.now()]);
        return db.query<Team, [string]>("SELECT * FROM teams WHERE name = ?").get(name)!;
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
      insert(sender, recipientType, recipient, body, parentId, pending = false, attachmentIds = []) {
        return db.transaction(() => {
          const row = db.query<MessageRow, [string, string, string, string, number | null, number, number]>(
            `INSERT INTO messages (sender, recipient_type, recipient, body, parent_id, created_at, pending)
             VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
          ).get(sender, recipientType, recipient, body, parentId, Date.now(), pending ? 1 : 0)!;
          const attachments = bindAttachments(db, attachmentIds, sender, { message_id: row.id }, attachmentLimits);
          return attachments.length ? { ...row, attachments } : row;
        })();
      },
      getById(id) {
        const row = db.query<MessageRow, [number]>("SELECT * FROM messages WHERE id = ?").get(id);
        return row ? withAttachments(db, "message", [row])[0] : undefined;
      },
      history(identityFull, peer, limit = 20, beforeId) {
        const cap = Math.min(limit, 200);
        if (peer) {
          if (beforeId !== undefined) {
            return att(db.query<MessageRow, [string, string, string, string, number, number]>(
              `SELECT * FROM messages
               WHERE ((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?))
                 AND recipient_type = 'user' AND id < ?
               ORDER BY id DESC LIMIT ?`,
            ).all(identityFull, peer, peer, identityFull, beforeId, cap));
          }
          return att(db.query<MessageRow, [string, string, string, string, number]>(
            `SELECT * FROM messages
             WHERE ((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?))
               AND recipient_type = 'user'
             ORDER BY id DESC LIMIT ?`,
          ).all(identityFull, peer, peer, identityFull, cap));
        }
        if (beforeId !== undefined) {
          return att(db.query<MessageRow, [string, string, number, number]>(
            `SELECT * FROM messages
             WHERE (sender = ? OR (recipient = ? AND recipient_type = 'user')) AND id < ?
             ORDER BY id DESC LIMIT ?`,
          ).all(identityFull, identityFull, beforeId, cap));
        }
        return att(db.query<MessageRow, [string, string, number]>(
          `SELECT * FROM messages
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
          SELECT m.* FROM messages m JOIN tree t ON m.id = t.id ORDER BY m.id ASC
        `).all(id));
      },
      unreadSince(streams) {
        if (streams.length === 0) return [];
        const all: MessageRow[] = [];
        for (const s of streams) {
          const colType = s.type === "direct" ? "user" : "team";
          const rows = db.query<MessageRow, [string, string, number]>(
            `SELECT * FROM messages WHERE recipient_type = ? AND recipient = ? AND id > ? ORDER BY id ASC`,
          ).all(colType, s.ref, s.since);
          all.push(...rows);
        }
        all.sort((a, b) => a.id - b.id);
        return att(all);
      },
      undeliveredFrom(sender, olderThan = Number.MAX_SAFE_INTEGER) {
        return db.query<{ recipient: string; n: number; oldest_id: number }, [string, number]>(
          `SELECT m.recipient, COUNT(*) AS n, MIN(m.id) AS oldest_id FROM messages m
             LEFT JOIN cursors c ON c.stream_type = 'direct' AND c.stream_ref = m.recipient
            WHERE m.sender = ? AND m.recipient_type = 'user' AND m.recipient != m.sender
              AND m.id > COALESCE(c.last_seen_id, 0) AND m.created_at < ?
            GROUP BY m.recipient ORDER BY m.recipient`,
        ).all(sender, olderThan);
      },
      receivedUnacked(reader, since) {
        return att(db.query<MessageRow, [string, number]>(
          `SELECT * FROM messages m
            WHERE m.recipient_type = 'user' AND m.recipient = ? AND m.sender != m.recipient AND m.created_at >= ?
              AND NOT EXISTS (SELECT 1 FROM dm_acks a WHERE a.reader = m.recipient AND a.message_id = m.id)
            ORDER BY m.id ASC`,
        ).all(reader, since));
      },
      sentPending(sender, since) {
        return att(db.query<MessageRow, [string, number]>(
          `SELECT * FROM messages m
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
            `SELECT 1 AS x FROM messages WHERE id = ? AND sender = ? AND recipient_type = 'user'
               AND id > COALESCE((SELECT MAX(last_seen_id) FROM cursors
                                   WHERE stream_type = 'direct' AND stream_ref = messages.recipient), 0)
               AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.parent_id = messages.id)`,
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
      get(identityId, streamType, streamRef) {
        const row = db.query<{ last_seen_id: number }, [number, string, string]>(
          "SELECT last_seen_id FROM cursors WHERE identity_id = ? AND stream_type = ? AND stream_ref = ?",
        ).get(identityId, streamType, streamRef);
        return row?.last_seen_id ?? 0;
      },
      directFor(identityFull) {
        const row = db.query<{ id: number | null }, [string]>(
          "SELECT MAX(last_seen_id) AS id FROM cursors WHERE stream_type = 'direct' AND stream_ref = ?",
        ).get(identityFull);
        return row?.id ?? 0;
      },
      advance(identityId, streamType, streamRef, messageId) {
        db.run(
          `INSERT INTO cursors (identity_id, stream_type, stream_ref, last_seen_id) VALUES (?, ?, ?, ?)
           ON CONFLICT(identity_id, stream_type, stream_ref)
           DO UPDATE SET last_seen_id = MAX(excluded.last_seen_id, cursors.last_seen_id)`,
          [identityId, streamType, streamRef, messageId],
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

    blobs,
    attachmentLimits,
  };
}
