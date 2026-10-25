import type { Database } from "bun:sqlite";

// Board + claim tables, shared by local and distributed modes. Kept separate
// from each mode's direct-message tables so neither needs a migration.
export function initCoreSchema(db: Database): void {
  db.exec(`
    -- The 1.x roster, replaced by aliases and ids (#284). Nothing reads or
    -- writes it after each mode's open seeds aliases from it; it stays
    -- because schema changes are additive.
    CREATE TABLE IF NOT EXISTS handles (
      name        TEXT PRIMARY KEY,
      first_seen  INTEGER NOT NULL,
      last_seen   INTEGER NOT NULL
    );

    -- One row per session (#284): the session ID as an address, and the
    -- facts that describe a running session. principal: the session's
    -- signed-in user (its email) on a server, null in local mode's one
    -- implicit person scope. cwd (local) or place (server, as the client
    -- described it) says where it runs; status is its peer_status line;
    -- launcher: its harness can spawn subagents (#184). ended_at: local
    -- mode's session ended (a clean exit, or reaped once its process was
    -- gone), so its ID is never taken again.
    CREATE TABLE IF NOT EXISTS ids (
      id          TEXT PRIMARY KEY,
      principal   TEXT,
      harness     TEXT,
      cwd         TEXT,
      place       TEXT,
      status      TEXT,
      status_at   INTEGER,
      launcher    INTEGER,
      started_at  INTEGER NOT NULL,
      last_seen   INTEGER NOT NULL,
      ended_at    INTEGER
    );

    -- Durable names (#284): every 1.x handle, as a person-scope alias.
    -- address is the handle as written (local: the bare name; server:
    -- email/name). scope_ref: the person's email, null for local mode's
    -- implicit scope. human: the declared human's alias. queue_off: opted
    -- out of queue boards' rotation, until it opts back in. last_seen: when
    -- a session last used it, null until one has.
    CREATE TABLE IF NOT EXISTS aliases (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      address               TEXT    NOT NULL UNIQUE,
      scope_kind            TEXT    NOT NULL CHECK (scope_kind IN ('person','team','service')),
      scope_ref             TEXT,
      name                  TEXT    NOT NULL,
      human                 INTEGER,
      queue_off             INTEGER,
      created_by_principal  TEXT,
      created_at            INTEGER NOT NULL,
      last_seen             INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_aliases_scope ON aliases(scope_ref, name);
    CREATE INDEX IF NOT EXISTS idx_aliases_name ON aliases(name);

    -- Which session holds each alias now: the address is the key, so a
    -- name has one holder (src/core/bindings.ts holdAlias).
    CREATE TABLE IF NOT EXISTS alias_holds (
      address   TEXT    PRIMARY KEY,
      id        TEXT    NOT NULL,
      bound_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alias_holds_id ON alias_holds(id);

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
    -- session's run metadata and a name. event: bound, moved (a rebind;
    -- detail has the old name), released, refused (detail has the holder or
    -- the reason). Append-only, except that a session's identical refusals
    -- within REFUSED_COALESCE_MS grow one row's count and last_at (#210).
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
  // Session end and kinds (#284 PR 2). held_aliases_json: the aliases the ID
  // held when it ended, for the id_ended hint and bounces. delivery: 'push'
  // (default) or 'none', a tools-only process (BUS_PUSH=off) that receives
  // nothing. viewer: a `grayboard tail` session, never listed or addressable.
  const idCols = new Set((db.prepare(`PRAGMA table_info(ids)`).all() as { name: string }[]).map((c) => c.name));
  if (!idCols.has("held_aliases_json")) db.exec(`ALTER TABLE ids ADD COLUMN held_aliases_json TEXT`);
  if (!idCols.has("delivery")) db.exec(`ALTER TABLE ids ADD COLUMN delivery TEXT NOT NULL DEFAULT 'push'`);
  if (!idCols.has("viewer")) {
    db.exec(`ALTER TABLE ids ADD COLUMN viewer INTEGER NOT NULL DEFAULT 0`);
    // A local tail's 1.x `~tail-<pid>` handle had its rows swept by the next
    // tail; viewers are ids rows now, ended like any session, so the old
    // handles' rows go once, on the open that adds the column.
    db.exec(`DELETE FROM subscriptions WHERE handle LIKE '~tail-%'; DELETE FROM outbox WHERE handle LIKE '~tail-%';`);
  }

  // The 1.x roster's later columns, which each mode's alias seed reads.
  const handleCols = new Set((db.prepare(`PRAGMA table_info(handles)`).all() as { name: string }[]).map((c) => c.name));
  for (const [col, type] of [["cwd", "TEXT"], ["place", "TEXT"], ["status", "TEXT"], ["status_at", "INTEGER"], ["human", "INTEGER"], ["queue_off", "INTEGER"], ["launcher", "INTEGER"]]) {
    if (!handleCols.has(col!)) db.exec(`ALTER TABLE handles ADD COLUMN ${col} ${type}`);
  }

  // An announcement's TTL (`grayboard announce --ttl`); null for other posts.
  const postCols = db.prepare(`PRAGMA table_info(posts)`).all() as { name: string }[];
  if (!postCols.some((c) => c.name === "expires_at")) db.exec(`ALTER TABLE posts ADD COLUMN expires_at INTEGER`);
  // The session that wrote the post (#284), beside the address it posted as;
  // null for posts from before it, and for writers with no session.
  if (!postCols.some((c) => c.name === "author_id")) db.exec(`ALTER TABLE posts ADD COLUMN author_id TEXT`);

  // The principal an upload counts against (#284 decision 13): a server
  // user's email, null in local mode. Backfilled from the uploader's "email/"
  // prefix, which is what the quota ranged over before, on every open: rows
  // a 1.x server wrote after a downgrade count too.
  const attachmentCols = db.prepare(`PRAGMA table_info(attachments)`).all() as { name: string }[];
  if (!attachmentCols.some((c) => c.name === "uploader_principal")) db.exec(`ALTER TABLE attachments ADD COLUMN uploader_principal TEXT`);
  db.exec(`UPDATE attachments SET uploader_principal = substr(uploader, 1, instr(uploader, '/') - 1) WHERE uploader_principal IS NULL AND instr(uploader, '/') > 0`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_attachments_principal ON attachments(uploader_principal, sha256) WHERE uploader_principal IS NOT NULL`);

  // Whether a push wakes its recipient (1), or waits to ride along with the
  // next push that does (0): a thread reply to a bystander.
  const outboxCols = db.prepare(`PRAGMA table_info(outbox)`).all() as { name: string }[];
  if (!outboxCols.some((c) => c.name === "wake")) db.exec(`ALTER TABLE outbox ADD COLUMN wake INTEGER NOT NULL DEFAULT 1`);

  // A refused binding event's repeats (#210): NULL count means 1, NULL
  // last_at means at.
  const bindingCols = new Set((db.prepare(`PRAGMA table_info(binding_events)`).all() as { name: string }[]).map((c) => c.name));
  for (const col of ["count", "last_at"]) {
    if (!bindingCols.has(col)) db.exec(`ALTER TABLE binding_events ADD COLUMN ${col} INTEGER`);
  }

  // Local databases from before board scopes.
  const cols = db.prepare(`PRAGMA table_info(boards)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === "scope")) db.exec(`ALTER TABLE boards ADD COLUMN scope TEXT`);

  // Queue boards deliver each post to exactly one subscriber (the claim IS the
  // delivery); broadcast (the default) fans out to every push subscriber.
  if (!cols.some((c) => c.name === "kind")) db.exec(`ALTER TABLE boards ADD COLUMN kind TEXT NOT NULL DEFAULT 'broadcast'`);
}
