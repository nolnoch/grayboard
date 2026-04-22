import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Row types
export type User     = { id: number; email: string; display_name: string | null; created_at: number; disabled_at: number | null };
export type Session  = { id: number; user_id: number; token_hash: string; created_at: number; last_used_at: number; revoked_at: number | null; label: string | null };
export type Identity = { id: number; user_id: number; name: string; created_at: number };
export type Team     = { id: number; name: string; created_by: number; policy: string; created_at: number };
export type MessageRow = { id: number; sender: string; recipient_type: "user" | "team"; recipient: string; body: string; parent_id: number | null; created_at: number };
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
  };
  messages: {
    insert(sender: string, recipientType: "user" | "team", recipient: string, body: string, parentId: number | null): MessageRow;
    getById(id: number): MessageRow | undefined;
    history(identityFull: string, peer?: string, limit?: number, beforeId?: number): MessageRow[];
    thread(rootId: number): MessageRow[];
    unreadSince(streams: { type: "direct" | "team"; ref: string; since: number }[]): MessageRow[];
    prune(olderThanMs: number): void;
  };
  cursors: {
    get(identityId: number, streamType: "direct" | "team", streamRef: string): number;
    advance(identityId: number, streamType: "direct" | "team", streamRef: string, messageId: number): void;
    initTeamCursorToCurrentMax(identityId: number, teamRef: string): void;
  };
  audit: {
    write(row: AccessLogRow): void;
    prune(olderThanMs: number): void;
  };
}

export function openDatabase(path: string): { db: Database; repo: Repo } {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec(
    "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA auto_vacuum = INCREMENTAL;",
  );
  initSchema(db);
  return { db, repo: makeRepo(db) };
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
  `);
}

function makeRepo(db: Database): Repo {
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
    },

    messages: {
      insert(sender, recipientType, recipient, body, parentId) {
        const r = db.run(
          `INSERT INTO messages (sender, recipient_type, recipient, body, parent_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [sender, recipientType, recipient, body, parentId, Date.now()],
        );
        return db.query<MessageRow, [number]>("SELECT * FROM messages WHERE id = ?").get(Number(r.lastInsertRowid))!;
      },
      getById(id) {
        return db.query<MessageRow, [number]>("SELECT * FROM messages WHERE id = ?").get(id) ?? undefined;
      },
      history(identityFull, peer, limit = 20, beforeId) {
        const cap = Math.min(limit, 200);
        if (peer) {
          if (beforeId !== undefined) {
            return db.query<MessageRow, [string, string, string, string, number, number]>(
              `SELECT * FROM messages
               WHERE ((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?))
                 AND recipient_type = 'user' AND id < ?
               ORDER BY id DESC LIMIT ?`,
            ).all(identityFull, peer, peer, identityFull, beforeId, cap);
          }
          return db.query<MessageRow, [string, string, string, string, number]>(
            `SELECT * FROM messages
             WHERE ((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?))
               AND recipient_type = 'user'
             ORDER BY id DESC LIMIT ?`,
          ).all(identityFull, peer, peer, identityFull, cap);
        }
        if (beforeId !== undefined) {
          return db.query<MessageRow, [string, string, number, number]>(
            `SELECT * FROM messages
             WHERE (sender = ? OR (recipient = ? AND recipient_type = 'user')) AND id < ?
             ORDER BY id DESC LIMIT ?`,
          ).all(identityFull, identityFull, beforeId, cap);
        }
        return db.query<MessageRow, [string, string, number]>(
          `SELECT * FROM messages
           WHERE (sender = ? OR (recipient = ? AND recipient_type = 'user'))
           ORDER BY id DESC LIMIT ?`,
        ).all(identityFull, identityFull, cap);
      },
      thread(rootId) {
        return db.query<MessageRow, [number]>(`
          WITH RECURSIVE tree(id) AS (
            SELECT id FROM messages WHERE id = ?
            UNION ALL
            SELECT m.id FROM messages m JOIN tree t ON m.parent_id = t.id
          )
          SELECT m.* FROM messages m JOIN tree t ON m.id = t.id ORDER BY m.id ASC
        `).all(rootId);
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
        return all;
      },
      prune(olderThanMs) {
        db.run("DELETE FROM messages WHERE created_at < ?", [olderThanMs]);
      },
    },

    cursors: {
      get(identityId, streamType, streamRef) {
        const row = db.query<{ last_seen_id: number }, [number, string, string]>(
          "SELECT last_seen_id FROM cursors WHERE identity_id = ? AND stream_type = ? AND stream_ref = ?",
        ).get(identityId, streamType, streamRef);
        return row?.last_seen_id ?? 0;
      },
      advance(identityId, streamType, streamRef, messageId) {
        db.run(
          `INSERT INTO cursors (identity_id, stream_type, stream_ref, last_seen_id) VALUES (?, ?, ?, ?)
           ON CONFLICT(identity_id, stream_type, stream_ref)
           DO UPDATE SET last_seen_id = MAX(excluded.last_seen_id, cursors.last_seen_id)`,
          [identityId, streamType, streamRef, messageId],
        );
      },
      initTeamCursorToCurrentMax(identityId, teamRef) {
        const row = db.query<{ max_id: number | null }, [string]>(
          "SELECT MAX(id) as max_id FROM messages WHERE recipient_type = 'team' AND recipient = ?",
        ).get(teamRef);
        const maxId = row?.max_id ?? 0;
        db.run(
          `INSERT OR IGNORE INTO cursors (identity_id, stream_type, stream_ref, last_seen_id) VALUES (?, 'team', ?, ?)`,
          [identityId, teamRef, maxId],
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
  };
}
