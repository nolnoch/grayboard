import type { Database } from "bun:sqlite";

// Board + claim tables, shared by local and distributed modes. Kept separate
// from each mode's direct-message tables so neither needs a migration.
// (handles.launcher: the session's harness can spawn subagents, #184.)
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

    -- Threads a handle muted (board_subscribe with thread, mode off), keyed
    -- by root post: their replies no longer push to it, except @mentions.
    CREATE TABLE IF NOT EXISTS thread_mutes (
      handle   TEXT NOT NULL,
      root_id  INTEGER NOT NULL,
      PRIMARY KEY (handle, root_id)
    );
    CREATE INDEX IF NOT EXISTS idx_thread_mutes_root ON thread_mutes(root_id);

    CREATE TABLE IF NOT EXISTS claims (
      key          TEXT PRIMARY KEY,
      holder       TEXT NOT NULL,
      note         TEXT,
      board        TEXT REFERENCES boards(name),
      acquired_at  INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL
    );

    -- Handles waiting on a claim (claim_watch). Its release or expiry post
    -- @mentions them, which reaches every board mode; then the rows go.
    CREATE TABLE IF NOT EXISTS claim_watches (
      key     TEXT NOT NULL,
      handle  TEXT NOT NULL,
      PRIMARY KEY (key, handle)
    );

    -- Claim history, since release and expiry delete the claims row. Append-
    -- only, written in the claim's own transaction; pruned with posts.
    -- event: take, renew, refused (held_by has it), release, expire, moved
    -- (a rebind took it to a new name; held_by has the old one).
    CREATE TABLE IF NOT EXISTS claim_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      key         TEXT    NOT NULL,
      handle      TEXT    NOT NULL,
      event       TEXT    NOT NULL,
      note        TEXT,
      board       TEXT,
      expires_at  INTEGER,
      held_by     TEXT,
      at          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_claim_events_at ON claim_events(at);

    -- Which session held which name, and when (#182): the join between a
    -- session's run metadata and a name. Append-only. event: bound, moved
    -- (a rebind; detail has the old name), released, refused (detail has
    -- the holder or the reason).
    CREATE TABLE IF NOT EXISTS binding_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT    NOT NULL,
      name        TEXT    NOT NULL,
      event       TEXT    NOT NULL,
      at          INTEGER NOT NULL,
      detail      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_binding_events_name ON binding_events(name, at);
    CREATE INDEX IF NOT EXISTS idx_binding_events_session ON binding_events(session_id);

    -- Local mode's audit trail (src/core/audit.ts): the same actions the
    -- server's audit records, for the actions that need one in both modes
    -- (delegation.*). Pruned with the bus's retention.
    CREATE TABLE IF NOT EXISTS audit_log (
      at      INTEGER NOT NULL,
      actor   TEXT,
      action  TEXT    NOT NULL,
      target  TEXT,
      detail  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log(at);

    -- File attachments (src/core/attachments.ts). The catalog of stored
    -- blobs, one per content hash; the bytes are in the mode's BlobStore. A
    -- blob goes when the last attachment naming it does.
    CREATE TABLE IF NOT EXISTS attachment_blobs (
      sha256      TEXT PRIMARY KEY,
      size        INTEGER NOT NULL,
      created_at  INTEGER NOT NULL
    );

    -- One per file attached. Unbound (both targets null) from upload until
    -- the message or post that carries it is written, in that write's
    -- transaction; unbound rows are pruned after an hour. messages is each
    -- mode's direct-message table.
    CREATE TABLE IF NOT EXISTS attachments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      sha256      TEXT    NOT NULL REFERENCES attachment_blobs(sha256),
      filename    TEXT    NOT NULL,
      type        TEXT    NOT NULL,
      size        INTEGER NOT NULL,
      uploader    TEXT    NOT NULL,
      message_id  INTEGER REFERENCES messages(id),
      post_id     INTEGER REFERENCES posts(id),
      created_at  INTEGER NOT NULL,
      CHECK (message_id IS NULL OR post_id IS NULL)
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id) WHERE message_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_attachments_post ON attachments(post_id) WHERE post_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_attachments_sha ON attachments(sha256);
    CREATE INDEX IF NOT EXISTS idx_attachments_unbound ON attachments(created_at) WHERE message_id IS NULL AND post_id IS NULL;
    CREATE INDEX IF NOT EXISTS idx_attachments_uploader ON attachments(uploader);
  `);
  // Session context, added after the roster: where the session runs (cwd in
  // local mode; place, as the client described it, in server mode) and a
  // free-text status it set, both reset when a session starts; and whether the
  // handle is a declared human's (`grayboard human`), which persists.
  const handleCols = new Set((db.prepare(`PRAGMA table_info(handles)`).all() as { name: string }[]).map((c) => c.name));
  for (const [col, type] of [["cwd", "TEXT"], ["place", "TEXT"], ["status", "TEXT"], ["status_at", "INTEGER"], ["human", "INTEGER"], ["queue_off", "INTEGER"], ["launcher", "INTEGER"]]) {
    if (!handleCols.has(col!)) db.exec(`ALTER TABLE handles ADD COLUMN ${col} ${type}`);
  }

  // An announcement's TTL (`grayboard announce --ttl`); null for other posts.
  const postCols = db.prepare(`PRAGMA table_info(posts)`).all() as { name: string }[];
  if (!postCols.some((c) => c.name === "expires_at")) db.exec(`ALTER TABLE posts ADD COLUMN expires_at INTEGER`);

  // Whether a push wakes its recipient (1), or waits to ride along with the
  // next push that does (0): a thread reply to a bystander.
  const outboxCols = db.prepare(`PRAGMA table_info(outbox)`).all() as { name: string }[];
  if (!outboxCols.some((c) => c.name === "wake")) db.exec(`ALTER TABLE outbox ADD COLUMN wake INTEGER NOT NULL DEFAULT 1`);

  // Local databases from before board scopes.
  const cols = db.prepare(`PRAGMA table_info(boards)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === "scope")) db.exec(`ALTER TABLE boards ADD COLUMN scope TEXT`);

  // Queue boards deliver each post to exactly one subscriber (the claim IS the
  // delivery); broadcast (the default) fans out to every push subscriber.
  if (!cols.some((c) => c.name === "kind")) db.exec(`ALTER TABLE boards ADD COLUMN kind TEXT NOT NULL DEFAULT 'broadcast'`);
}
