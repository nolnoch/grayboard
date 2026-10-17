import type { Database } from "bun:sqlite";

// Board + claim tables, shared by local and distributed modes. Kept separate
// from each mode's direct-message tables so neither needs a migration.
export function initCoreSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS handles (
      name        TEXT PRIMARY KEY,
      first_seen  INTEGER NOT NULL,
      last_seen   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS boards (
      name        TEXT PRIMARY KEY,
      purpose     TEXT NOT NULL,
      scope       TEXT,
      created_by  TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS posts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      board       TEXT NOT NULL REFERENCES boards(name),
      author      TEXT NOT NULL,
      body        TEXT NOT NULL,
      parent_id   INTEGER REFERENCES posts(id),
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_posts_board_id ON posts(board, id);
    CREATE INDEX IF NOT EXISTS idx_posts_parent ON posts(parent_id);

    -- cursor: last post read. notified_id: last post covered by a push or
    -- digest. A digest re-arms once the reader catches up (cursor >= notified_id).
    CREATE TABLE IF NOT EXISTS subscriptions (
      board        TEXT NOT NULL REFERENCES boards(name),
      handle       TEXT NOT NULL,
      mode         TEXT NOT NULL CHECK (mode IN ('push','digest','quiet')),
      cursor       INTEGER NOT NULL,
      notified_id  INTEGER NOT NULL,
      PRIMARY KEY (board, handle)
    );

    -- Per-handle pending pushes (mentions, thread replies, push-mode subs).
    CREATE TABLE IF NOT EXISTS outbox (
      handle        TEXT NOT NULL,
      post_id       INTEGER NOT NULL REFERENCES posts(id),
      reason        TEXT NOT NULL CHECK (reason IN ('mention','thread','subscription')),
      delivered_at  INTEGER,
      PRIMARY KEY (handle, post_id)
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(handle, delivered_at);

    CREATE TABLE IF NOT EXISTS claims (
      key          TEXT PRIMARY KEY,
      holder       TEXT NOT NULL,
      note         TEXT,
      board        TEXT REFERENCES boards(name),
      acquired_at  INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL
    );
  `);
  // Session context, added after the roster: where the session runs (cwd in
  // local mode; place, as the client described it, in server mode), a
  // free-text status it set, and whether a human holds the handle (a bridge
  // such as `grayboard bridge slack`). All reset when a session starts.
  const handleCols = new Set((db.prepare(`PRAGMA table_info(handles)`).all() as { name: string }[]).map((c) => c.name));
  for (const [col, type] of [["cwd", "TEXT"], ["place", "TEXT"], ["status", "TEXT"], ["status_at", "INTEGER"], ["human", "INTEGER"]]) {
    if (!handleCols.has(col!)) db.exec(`ALTER TABLE handles ADD COLUMN ${col} ${type}`);
  }

  // Local databases from before board scopes.
  const cols = db.prepare(`PRAGMA table_info(boards)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === "scope")) db.exec(`ALTER TABLE boards ADD COLUMN scope TEXT`);
}
