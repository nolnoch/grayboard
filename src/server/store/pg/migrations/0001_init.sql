-- The server schema on Postgres (#807 P3 C1b; docs/future/postgres-server.md D6, D7). Mirrors the tables a SQLite
-- server database holds after db.ts initSchema, core/schema.ts initCoreSchema and db.ts migrateHostedHolds, with every
-- guarded ALTER's column folded into its CREATE. src/server/store/pg/schema-parity.test.ts compares the two and lists
-- every deliberate difference; a column added on one side alone fails it.
--
-- Rules: INTEGER PRIMARY KEY AUTOINCREMENT → int8 GENERATED ALWAYS AS IDENTITY; other INTEGER → int8, except the 0/1
-- columns, which are boolean; TEXT → text COLLATE "C" (SQLite compares BINARY everywhere), except the JSON columns
-- queried by path or parsed on read, which are jsonb (write_receipts.result_json stays text: it holds '' while a
-- write is in flight and replays its bytes as stored; oauth_tokens.access_scopes stays text, as
-- postgres-server.md D6 records). Every UNIQUE and FOREIGN KEY carries its Postgres default name
-- (<table>_<columns>_key / _fkey), explicitly, so errors.ts can classify a violation by a name this file promises.
-- Indexes keep their SQLite names and partial predicates. Tables run in dependency order: Postgres refuses a forward
-- reference that SQLite accepts.
--
-- Not carried: identities, cursors, handles (pre-#284 legacy), audit_log (local mode's; the server audits to
-- access_log), hosted_sessions.name (#451), ids.token_session (unused since #282). Added: ids.seq and
-- hosted_alias_lost.seq, the insertion order the SQLite queries read from rowid.
--
-- Editable in place until the first release that runs a server on Postgres (P5); append-only after that.

CREATE TABLE users (
  id           int8 GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email        text COLLATE "C" NOT NULL CONSTRAINT users_email_key UNIQUE,
  display_name text COLLATE "C",
  created_at   int8 NOT NULL,
  disabled_at  int8,
  idp_subject  text COLLATE "C",
  idp_issuer   text COLLATE "C"
);
CREATE UNIQUE INDEX idx_users_idp_identity ON users (idp_issuer, idp_subject) WHERE idp_subject IS NOT NULL;

CREATE TABLE sessions (
  id           int8 GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      int8 NOT NULL CONSTRAINT sessions_user_id_fkey REFERENCES users (id),
  token_hash   text COLLATE "C" NOT NULL CONSTRAINT sessions_token_hash_key UNIQUE,
  created_at   int8 NOT NULL,
  last_used_at int8 NOT NULL,
  revoked_at   int8,
  label        text COLLATE "C"
);
CREATE INDEX idx_sessions_user ON sessions (user_id);

CREATE TABLE teams (
  id         int8 GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text COLLATE "C" NOT NULL CONSTRAINT teams_name_key UNIQUE,
  created_by int8 NOT NULL CONSTRAINT teams_created_by_fkey REFERENCES users (id),
  policy     text COLLATE "C" NOT NULL DEFAULT 'open',
  created_at int8 NOT NULL
);

CREATE TABLE team_members (
  team_id   int8 NOT NULL CONSTRAINT team_members_team_id_fkey REFERENCES teams (id) ON DELETE CASCADE,
  user_id   int8 NOT NULL CONSTRAINT team_members_user_id_fkey REFERENCES users (id),
  joined_at int8 NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_members_user ON team_members (user_id);

CREATE TABLE principals (
  id         int8 GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind       text COLLATE "C" NOT NULL CHECK (kind IN ('user', 'team', 'service')),
  name       text COLLATE "C" NOT NULL CONSTRAINT principals_name_key UNIQUE,
  user_id    int8 CONSTRAINT principals_user_id_fkey REFERENCES users (id),
  team_id    int8 CONSTRAINT principals_team_id_fkey REFERENCES teams (id),
  parent_id  int8 CONSTRAINT principals_parent_id_fkey REFERENCES principals (id),
  created_at int8 NOT NULL
);
CREATE INDEX idx_principals_user ON principals (user_id);
CREATE INDEX idx_principals_team ON principals (team_id);

-- #927: runtime role bindings. RESTRICT, not CASCADE: deleting a principal must revoke its bindings (each with its
-- role.revoked row) in the same transaction. A NULL never collides in a unique index, so org and scoped bindings
-- each get a partial one.
CREATE TABLE role_bindings (
  id           int8 GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  principal_id int8 NOT NULL CONSTRAINT role_bindings_principal_id_fkey REFERENCES principals (id) ON DELETE RESTRICT,
  role         text COLLATE "C" NOT NULL,
  scope_id     int8 CONSTRAINT role_bindings_scope_id_fkey REFERENCES principals (id) ON DELETE RESTRICT,
  granted_by   int8 CONSTRAINT role_bindings_granted_by_fkey REFERENCES principals (id) ON DELETE RESTRICT,
  granted_at   int8 NOT NULL
);
CREATE UNIQUE INDEX idx_role_bindings_org ON role_bindings (principal_id, role) WHERE scope_id IS NULL;
CREATE UNIQUE INDEX idx_role_bindings_scoped ON role_bindings (principal_id, role, scope_id) WHERE scope_id IS NOT NULL;
CREATE INDEX idx_role_bindings_scope ON role_bindings (scope_id, role);

CREATE TABLE oauth_grants (
  id         text COLLATE "C" PRIMARY KEY,
  user_id    int8 NOT NULL CONSTRAINT oauth_grants_user_id_fkey REFERENCES users (id),
  expires_at int8 NOT NULL,
  revoked_at int8,
  data       jsonb NOT NULL
);
CREATE INDEX idx_oauth_grants_user ON oauth_grants (user_id);

CREATE TABLE service_credentials (
  id            int8 GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id     text COLLATE "C" NOT NULL CONSTRAINT service_credentials_client_id_key UNIQUE,
  user_id       int8 NOT NULL CONSTRAINT service_credentials_user_id_fkey REFERENCES users (id),
  grant_id      text COLLATE "C" NOT NULL CONSTRAINT service_credentials_grant_id_key UNIQUE CONSTRAINT service_credentials_grant_id_fkey REFERENCES oauth_grants (id) ON DELETE CASCADE,
  source        text COLLATE "C" NOT NULL CHECK (source IN ('opencode', 'generic')),
  token_seconds int8 NOT NULL,
  created_at    int8 NOT NULL
);
CREATE INDEX idx_service_credentials_user ON service_credentials (user_id);

CREATE TABLE service_credential_secrets (
  id            int8 GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  credential_id int8 NOT NULL CONSTRAINT service_credential_secrets_credential_id_fkey REFERENCES service_credentials (id) ON DELETE CASCADE,
  hash          text COLLATE "C" NOT NULL CONSTRAINT service_credential_secrets_hash_key UNIQUE,
  created_at    int8 NOT NULL,
  revoked_at    int8
);
CREATE INDEX idx_service_credential_secrets_credential ON service_credential_secrets (credential_id);

CREATE TABLE oauth_tokens (
  hash          text COLLATE "C" PRIMARY KEY,
  grant_id      text COLLATE "C" NOT NULL CONSTRAINT oauth_tokens_grant_id_fkey REFERENCES oauth_grants (id) ON DELETE CASCADE,
  kind          text COLLATE "C" NOT NULL CHECK (kind IN ('access', 'refresh')),
  expires_at    int8 NOT NULL,
  spent_at      int8,
  revoked_at    int8,
  created_at    int8 NOT NULL,
  access_scopes text COLLATE "C",
  secret_id     int8 CONSTRAINT oauth_tokens_secret_id_fkey REFERENCES service_credential_secrets (id) ON DELETE CASCADE
);
CREATE INDEX idx_oauth_tokens_grant ON oauth_tokens (grant_id);
CREATE INDEX idx_oauth_tokens_secret ON oauth_tokens (secret_id);

-- The auth generation (postgres-server.md D5; #807 P3 C9b): a statement that changes a row of an auth table, or
-- truncates one, marks its transaction (gb.auth_touched, transaction-local, so ROLLBACK TO undoes it) and sends NOTIFY
-- gb_auth, delivered at commit. store/pg/tx.ts reads the mark before COMMIT and bumps this process's counter after it;
-- every listening process bumps on the notification. The auth tables are every table an answer store/auth_cache.ts
-- caches reads: findActiveAccess (store/pg/oauth.ts) joins oauth_tokens, oauth_grants, users (disabled_at),
-- service_credential_secrets (revoked_at: a revoke whose token UPDATE matched no row, a mint racing it, changes only
-- the secret) and service_credentials (source), and users.findById (store/pg/identity.ts) reads users and principals
-- (a service's kind). The application never changes a service_credentials or principals row once written, but an
-- operator's hand edit would then leave a stale answer cached; their triggers cost a cache clear only where a row is
-- written (a team's create inserts its principal). A new table a cached read joins needs these triggers too.
-- Statement triggers with transition tables: a statement that changed no rows (the OAuth cleanup's DELETEs, usually)
-- marks nothing, and a bulk one runs the function once. A transition table serves one event per trigger, so each table
-- has one per event; TRUNCATE has none. ENABLE ALWAYS: they fire under session_replication_role = replica too (a
-- restore, a replication apply), which would otherwise skip them silently; only an explicit DISABLE TRIGGER stops them.
CREATE FUNCTION gb_auth_touched() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('gb.auth_touched', '1', true);
  PERFORM pg_notify('gb_auth', '');
  RETURN NULL;
END $$;
CREATE FUNCTION gb_auth_rows_touched() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM changed) THEN
    PERFORM set_config('gb.auth_touched', '1', true);
    PERFORM pg_notify('gb_auth', '');
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER users_auth_ins AFTER INSERT ON users REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION gb_auth_rows_touched();
CREATE TRIGGER users_auth_upd AFTER UPDATE ON users REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION gb_auth_rows_touched();
CREATE TRIGGER users_auth_del AFTER DELETE ON users REFERENCING OLD TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION gb_auth_rows_touched();
CREATE TRIGGER users_auth_trunc AFTER TRUNCATE ON users FOR EACH STATEMENT EXECUTE FUNCTION gb_auth_touched();
CREATE TRIGGER oauth_grants_auth_ins AFTER INSERT ON oauth_grants REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION gb_auth_rows_touched();
CREATE TRIGGER oauth_grants_auth_upd AFTER UPDATE ON oauth_grants REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION gb_auth_rows_touched();
CREATE TRIGGER oauth_grants_auth_del AFTER DELETE ON oauth_grants REFERENCING OLD TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION gb_auth_rows_touched();
CREATE TRIGGER oauth_grants_auth_trunc AFTER TRUNCATE ON oauth_grants FOR EACH STATEMENT EXECUTE FUNCTION gb_auth_touched();
CREATE TRIGGER oauth_tokens_auth_ins AFTER INSERT ON oauth_tokens REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION gb_auth_rows_touched();
CREATE TRIGGER oauth_tokens_auth_upd AFTER UPDATE ON oauth_tokens REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION gb_auth_rows_touched();
CREATE TRIGGER oauth_tokens_auth_del AFTER DELETE ON oauth_tokens REFERENCING OLD TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION gb_auth_rows_touched();
CREATE TRIGGER oauth_tokens_auth_trunc AFTER TRUNCATE ON oauth_tokens FOR EACH STATEMENT EXECUTE FUNCTION gb_auth_touched();
CREATE TRIGGER service_credential_secrets_auth_ins AFTER INSERT ON service_credential_secrets REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION gb_auth_rows_touched();
CREATE TRIGGER service_credential_secrets_auth_upd AFTER UPDATE ON service_credential_secrets REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION gb_auth_rows_touched();
CREATE TRIGGER service_credential_secrets_auth_del AFTER DELETE ON service_credential_secrets REFERENCING OLD TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION gb_auth_rows_touched();
CREATE TRIGGER service_credential_secrets_auth_trunc AFTER TRUNCATE ON service_credential_secrets FOR EACH STATEMENT EXECUTE FUNCTION gb_auth_touched();
CREATE TRIGGER service_credentials_auth_ins AFTER INSERT ON service_credentials REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION gb_auth_rows_touched();
CREATE TRIGGER service_credentials_auth_upd AFTER UPDATE ON service_credentials REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION gb_auth_rows_touched();
CREATE TRIGGER service_credentials_auth_del AFTER DELETE ON service_credentials REFERENCING OLD TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION gb_auth_rows_touched();
CREATE TRIGGER service_credentials_auth_trunc AFTER TRUNCATE ON service_credentials FOR EACH STATEMENT EXECUTE FUNCTION gb_auth_touched();
CREATE TRIGGER principals_auth_ins AFTER INSERT ON principals REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION gb_auth_rows_touched();
CREATE TRIGGER principals_auth_upd AFTER UPDATE ON principals REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION gb_auth_rows_touched();
CREATE TRIGGER principals_auth_del AFTER DELETE ON principals REFERENCING OLD TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION gb_auth_rows_touched();
CREATE TRIGGER principals_auth_trunc AFTER TRUNCATE ON principals FOR EACH STATEMENT EXECUTE FUNCTION gb_auth_touched();
ALTER TABLE users ENABLE ALWAYS TRIGGER users_auth_ins, ENABLE ALWAYS TRIGGER users_auth_upd, ENABLE ALWAYS TRIGGER users_auth_del, ENABLE ALWAYS TRIGGER users_auth_trunc;
ALTER TABLE oauth_grants ENABLE ALWAYS TRIGGER oauth_grants_auth_ins, ENABLE ALWAYS TRIGGER oauth_grants_auth_upd, ENABLE ALWAYS TRIGGER oauth_grants_auth_del, ENABLE ALWAYS TRIGGER oauth_grants_auth_trunc;
ALTER TABLE oauth_tokens ENABLE ALWAYS TRIGGER oauth_tokens_auth_ins, ENABLE ALWAYS TRIGGER oauth_tokens_auth_upd, ENABLE ALWAYS TRIGGER oauth_tokens_auth_del, ENABLE ALWAYS TRIGGER oauth_tokens_auth_trunc;
ALTER TABLE service_credential_secrets ENABLE ALWAYS TRIGGER service_credential_secrets_auth_ins, ENABLE ALWAYS TRIGGER service_credential_secrets_auth_upd, ENABLE ALWAYS TRIGGER service_credential_secrets_auth_del, ENABLE ALWAYS TRIGGER service_credential_secrets_auth_trunc;
ALTER TABLE service_credentials ENABLE ALWAYS TRIGGER service_credentials_auth_ins, ENABLE ALWAYS TRIGGER service_credentials_auth_upd, ENABLE ALWAYS TRIGGER service_credentials_auth_del, ENABLE ALWAYS TRIGGER service_credentials_auth_trunc;
ALTER TABLE principals ENABLE ALWAYS TRIGGER principals_auth_ins, ENABLE ALWAYS TRIGGER principals_auth_upd, ENABLE ALWAYS TRIGGER principals_auth_del, ENABLE ALWAYS TRIGGER principals_auth_trunc;

CREATE TABLE oauth_requests (
  hash         text COLLATE "C" PRIMARY KEY,
  browser_hash text COLLATE "C" NOT NULL,
  expires_at   int8 NOT NULL,
  data         jsonb NOT NULL
);
CREATE INDEX idx_oauth_requests_expiry ON oauth_requests (expires_at);

CREATE TABLE oauth_browsers (
  hash       text COLLATE "C" PRIMARY KEY,
  user_id    int8 NOT NULL CONSTRAINT oauth_browsers_user_id_fkey REFERENCES users (id),
  expires_at int8 NOT NULL,
  data       jsonb NOT NULL
);

CREATE TABLE oauth_codes (
  hash       text COLLATE "C" PRIMARY KEY,
  user_id    int8 NOT NULL CONSTRAINT oauth_codes_user_id_fkey REFERENCES users (id),
  expires_at int8 NOT NULL,
  data       jsonb NOT NULL,
  grant_id   text COLLATE "C" CONSTRAINT oauth_codes_grant_id_fkey REFERENCES oauth_grants (id) ON DELETE CASCADE,
  session_id int8 CONSTRAINT oauth_codes_session_id_fkey REFERENCES sessions (id) ON DELETE CASCADE
);
CREATE INDEX idx_oauth_codes_grant ON oauth_codes (grant_id);

CREATE TABLE hosted_ownerships (
  id         int8 GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id text COLLATE "C" NOT NULL,
  user_id    int8 NOT NULL CONSTRAINT hosted_ownerships_user_id_fkey REFERENCES users (id),
  client_id  text COLLATE "C" NOT NULL,
  started_at int8 NOT NULL,
  ended_at   int8,
  end_reason text COLLATE "C"
);

CREATE TABLE hosted_sessions (
  session_id        text COLLATE "C" PRIMARY KEY,
  ownership_id      int8 NOT NULL CONSTRAINT hosted_sessions_ownership_id_fkey REFERENCES hosted_ownerships (id),
  user_id           int8 NOT NULL CONSTRAINT hosted_sessions_user_id_fkey REFERENCES users (id),
  client_id         text COLLATE "C" NOT NULL,
  grant_id          text COLLATE "C" NOT NULL,
  source_session_id text COLLATE "C" NOT NULL,
  bind_gen          int8 NOT NULL DEFAULT 0,
  root_session_id   text COLLATE "C",
  place             text COLLATE "C",
  lease_deadline    int8,
  created_at        int8 NOT NULL,
  last_seen_at      int8 NOT NULL,
  writes_as         text COLLATE "C",
  suggested         text COLLATE "C",
  parked_at         int8
);
CREATE INDEX idx_hosted_grant ON hosted_sessions (grant_id);
CREATE INDEX idx_hosted_ownership ON hosted_sessions (ownership_id);
CREATE INDEX idx_hosted_deadline ON hosted_sessions (lease_deadline);
CREATE INDEX idx_hosted_user ON hosted_sessions (user_id);
CREATE INDEX idx_hosted_parked ON hosted_sessions (parked_at);
CREATE INDEX idx_hosted_root ON hosted_sessions (root_session_id);

-- seq: insertion order, for `ORDER BY at, seq` (SQLite reads rowid).
CREATE TABLE hosted_alias_lost (
  session_id  text COLLATE "C" NOT NULL CONSTRAINT hosted_alias_lost_session_id_fkey REFERENCES hosted_sessions (session_id) ON DELETE CASCADE,
  alias       text COLLATE "C" NOT NULL,
  reason      text COLLATE "C" NOT NULL,
  was_primary boolean NOT NULL,
  at          int8 NOT NULL,
  told_at     int8,
  reported_at int8,
  seen_at     int8,
  seq         int8 GENERATED ALWAYS AS IDENTITY CONSTRAINT hosted_alias_lost_seq_key UNIQUE,
  PRIMARY KEY (session_id, alias)
);

CREATE TABLE server_state (
  key   text COLLATE "C" PRIMARY KEY,
  value int8 NOT NULL
);

CREATE TABLE messages (
  id             int8 GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sender         text COLLATE "C" NOT NULL,
  recipient_type text COLLATE "C" NOT NULL CHECK (recipient_type IN ('user', 'team')),
  recipient      text COLLATE "C" NOT NULL,
  body           text COLLATE "C" NOT NULL,
  parent_id      int8 CONSTRAINT messages_parent_id_fkey REFERENCES messages (id),
  created_at     int8 NOT NULL,
  pending        boolean NOT NULL DEFAULT false,
  sender_id      text COLLATE "C",
  kind           text COLLATE "C",
  delivered_at   int8,
  via            text COLLATE "C",
  sender_user    text COLLATE "C",
  human          boolean
);
CREATE INDEX idx_msg_recipient ON messages (recipient_type, recipient, id);
CREATE INDEX idx_msg_sender ON messages (sender, id);

CREATE TABLE mailbox_cursors (
  address      text COLLATE "C" NOT NULL,
  stream_type  text COLLATE "C" NOT NULL CHECK (stream_type IN ('direct', 'team')),
  stream_ref   text COLLATE "C" NOT NULL,
  last_seen_id int8 NOT NULL,
  PRIMARY KEY (address, stream_type, stream_ref)
);

CREATE TABLE access_log (
  id        int8 GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at        int8 NOT NULL,
  actor     text COLLATE "C",
  action    text COLLATE "C" NOT NULL,
  target    text COLLATE "C",
  detail    jsonb,
  ip        text COLLATE "C",
  ua        text COLLATE "C",
  client_id text COLLATE "C"
);
CREATE INDEX idx_audit_at ON access_log (at);
CREATE INDEX idx_access_log_action_target ON access_log (action, target, at);

CREATE TABLE slack_links (
  user_id    int8 PRIMARY KEY CONSTRAINT slack_links_user_id_fkey REFERENCES users (id),
  slack_user text COLLATE "C" NOT NULL CONSTRAINT slack_links_slack_user_key UNIQUE,
  dm_channel text COLLATE "C" NOT NULL,
  linked_at  int8 NOT NULL
);

CREATE TABLE slack_threads (
  user_id   int8 NOT NULL CONSTRAINT slack_threads_user_id_fkey REFERENCES users (id),
  thread_ts text COLLATE "C" NOT NULL,
  kind      text COLLATE "C" NOT NULL CHECK (kind IN ('dm', 'board')),
  board     text COLLATE "C" NOT NULL DEFAULT '',
  root_id   int8 NOT NULL,
  peer      text COLLATE "C",
  last_id   int8 NOT NULL,
  PRIMARY KEY (user_id, thread_ts),
  CONSTRAINT slack_threads_user_id_kind_board_root_id_key UNIQUE (user_id, kind, board, root_id)
);

CREATE TABLE slack_progress (
  user_id  int8 NOT NULL CONSTRAINT slack_progress_user_id_fkey REFERENCES users (id),
  ref      text COLLATE "C" NOT NULL,
  progress jsonb NOT NULL,
  PRIMARY KEY (user_id, ref)
);

CREATE TABLE dm_acks (
  reader     text COLLATE "C" NOT NULL,
  message_id int8 NOT NULL,
  acked_at   int8 NOT NULL,
  PRIMARY KEY (reader, message_id)
);

CREATE TABLE write_receipts (
  session     text COLLATE "C" NOT NULL,
  sender      text COLLATE "C" NOT NULL,
  fp          text COLLATE "C" NOT NULL,
  tool        text COLLATE "C" NOT NULL,
  ref_kind    text COLLATE "C" NOT NULL CHECK (ref_kind IN ('message', 'post')),
  ref_id      int8 NOT NULL,
  result_json text COLLATE "C" NOT NULL,
  at          int8 NOT NULL,
  PRIMARY KEY (session, sender, fp)
);
CREATE INDEX idx_write_receipts_at ON write_receipts (at);

-- Core tables (core/schema.ts). seq: insertion order, the tiebreak SQLite reads from rowid.
CREATE TABLE ids (
  id                text COLLATE "C" PRIMARY KEY,
  principal         text COLLATE "C",
  harness           text COLLATE "C",
  cwd               text COLLATE "C",
  place             text COLLATE "C",
  status            text COLLATE "C",
  status_at         int8,
  launcher          boolean,
  started_at        int8 NOT NULL,
  last_seen         int8 NOT NULL,
  ended_at          int8,
  held_aliases_json jsonb,
  delivery          text COLLATE "C" NOT NULL DEFAULT 'push',
  writes_as         text COLLATE "C",
  viewer            boolean NOT NULL DEFAULT false,
  keyed             boolean NOT NULL DEFAULT false,
  local_resume      boolean NOT NULL DEFAULT false,
  model             text COLLATE "C",
  effort            text COLLATE "C",
  root_id           text COLLATE "C",
  harness_session   text COLLATE "C",
  seq               int8 GENERATED ALWAYS AS IDENTITY CONSTRAINT ids_seq_key UNIQUE
);
CREATE INDEX idx_ids_viewer ON ids (id) WHERE viewer;
CREATE INDEX idx_ids_root ON ids (root_id) WHERE root_id IS NOT NULL;
CREATE INDEX idx_ids_harness_session ON ids (harness_session) WHERE harness_session IS NOT NULL;
CREATE INDEX idx_ids_ended ON ids (ended_at) WHERE ended_at IS NOT NULL;
CREATE INDEX idx_ids_live ON ids (id) WHERE ended_at IS NULL;

CREATE TABLE aliases (
  id                   int8 GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  address              text COLLATE "C" NOT NULL CONSTRAINT aliases_address_key UNIQUE,
  scope_kind           text COLLATE "C" NOT NULL CHECK (scope_kind IN ('person', 'team', 'service')),
  scope_ref            text COLLATE "C",
  name                 text COLLATE "C" NOT NULL,
  human                boolean,
  queue_off            boolean,
  created_by_principal text COLLATE "C",
  created_at           int8 NOT NULL,
  last_seen            int8,
  task                 text COLLATE "C",
  owner                text COLLATE "C",
  source_board         text COLLATE "C",
  spec_hash            text COLLATE "C",
  description          text COLLATE "C"
);
CREATE INDEX idx_aliases_scope ON aliases (scope_ref, name);
CREATE INDEX idx_aliases_name ON aliases (name);

CREATE TABLE alias_holds (
  address  text COLLATE "C" PRIMARY KEY,
  id       text COLLATE "C" NOT NULL,
  bound_at int8 NOT NULL
);
CREATE INDEX idx_alias_holds_id ON alias_holds (id);

CREATE TABLE boards (
  name        text COLLATE "C" PRIMARY KEY,
  purpose     text COLLATE "C" NOT NULL,
  scope       text COLLATE "C",
  created_by  text COLLATE "C" NOT NULL,
  created_at  int8 NOT NULL,
  kind        text COLLATE "C" NOT NULL DEFAULT 'broadcast',
  archived_at int8,
  archived_by text COLLATE "C"
);

CREATE TABLE posts (
  id          int8 GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  board       text COLLATE "C" NOT NULL CONSTRAINT posts_board_fkey REFERENCES boards (name),
  author      text COLLATE "C" NOT NULL,
  body        text COLLATE "C" NOT NULL,
  parent_id   int8 CONSTRAINT posts_parent_id_fkey REFERENCES posts (id),
  created_at  int8 NOT NULL,
  expires_at  int8,
  author_id   text COLLATE "C",
  via         text COLLATE "C",
  author_user text COLLATE "C",
  human       boolean
);
CREATE INDEX idx_posts_board_id ON posts (board, id);
CREATE INDEX idx_posts_parent ON posts (parent_id);

CREATE TABLE subscriptions (
  board       text COLLATE "C" NOT NULL CONSTRAINT subscriptions_board_fkey REFERENCES boards (name),
  handle      text COLLATE "C" NOT NULL,
  mode        text COLLATE "C" NOT NULL CHECK (mode IN ('push', 'digest', 'quiet')),
  cursor      int8 NOT NULL,
  notified_id int8 NOT NULL,
  PRIMARY KEY (board, handle)
);
CREATE INDEX idx_subscriptions_handle ON subscriptions (handle);

CREATE TABLE outbox (
  handle       text COLLATE "C" NOT NULL,
  post_id      int8 NOT NULL CONSTRAINT outbox_post_id_fkey REFERENCES posts (id),
  reason       text COLLATE "C" NOT NULL CHECK (reason IN ('mention', 'thread', 'subscription')),
  delivered_at int8,
  wake         boolean NOT NULL DEFAULT true,
  PRIMARY KEY (handle, post_id)
);
CREATE INDEX idx_outbox_pending ON outbox (handle, delivered_at);

CREATE TABLE thread_mutes (
  handle  text COLLATE "C" NOT NULL,
  root_id int8 NOT NULL,
  PRIMARY KEY (handle, root_id)
);
CREATE INDEX idx_thread_mutes_root ON thread_mutes (root_id);

CREATE TABLE claims (
  key         text COLLATE "C" PRIMARY KEY,
  holder      text COLLATE "C" NOT NULL,
  note        text COLLATE "C",
  board       text COLLATE "C" CONSTRAINT claims_board_fkey REFERENCES boards (name),
  acquired_at int8 NOT NULL,
  expires_at  int8 NOT NULL,
  holder_user text COLLATE "C"
);

CREATE TABLE claim_watches (
  key    text COLLATE "C" NOT NULL,
  handle text COLLATE "C" NOT NULL,
  PRIMARY KEY (key, handle)
);

CREATE TABLE claim_events (
  id         int8 GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key        text COLLATE "C" NOT NULL,
  handle     text COLLATE "C" NOT NULL,
  event      text COLLATE "C" NOT NULL,
  note       text COLLATE "C",
  board      text COLLATE "C",
  expires_at int8,
  held_by    text COLLATE "C",
  at         int8 NOT NULL
);
CREATE INDEX idx_claim_events_at ON claim_events (at);
CREATE INDEX idx_claim_events_key ON claim_events (key);
CREATE INDEX idx_claim_events_take ON claim_events (board, handle, at) WHERE event = 'take';

CREATE TABLE binding_events (
  id         int8 GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id text COLLATE "C" NOT NULL,
  name       text COLLATE "C" NOT NULL,
  event      text COLLATE "C" NOT NULL,
  at         int8 NOT NULL,
  detail     text COLLATE "C",
  count      int8,
  last_at    int8
);
CREATE INDEX idx_binding_events_name ON binding_events (name, at);
CREATE INDEX idx_binding_events_session ON binding_events (session_id);

CREATE TABLE attachment_blobs (
  sha256     text COLLATE "C" PRIMARY KEY,
  size       int8 NOT NULL,
  created_at int8 NOT NULL
);

CREATE TABLE attachments (
  id                 int8 GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sha256             text COLLATE "C" NOT NULL CONSTRAINT attachments_sha256_fkey REFERENCES attachment_blobs (sha256),
  filename           text COLLATE "C" NOT NULL,
  type               text COLLATE "C" NOT NULL,
  size               int8 NOT NULL,
  uploader           text COLLATE "C" NOT NULL,
  message_id         int8 CONSTRAINT attachments_message_id_fkey REFERENCES messages (id),
  post_id            int8 CONSTRAINT attachments_post_id_fkey REFERENCES posts (id),
  created_at         int8 NOT NULL,
  uploader_principal text COLLATE "C",
  CHECK (message_id IS NULL OR post_id IS NULL)
);
CREATE INDEX idx_attachments_message ON attachments (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX idx_attachments_post ON attachments (post_id) WHERE post_id IS NOT NULL;
CREATE INDEX idx_attachments_sha ON attachments (sha256);
CREATE INDEX idx_attachments_unbound ON attachments (created_at) WHERE message_id IS NULL AND post_id IS NULL;
CREATE INDEX idx_attachments_uploader ON attachments (uploader);
CREATE INDEX idx_attachments_principal ON attachments (uploader_principal, sha256) WHERE uploader_principal IS NOT NULL;

CREATE TABLE pruned_ids (
  id        text COLLATE "C" PRIMARY KEY,
  ended_at  int8 NOT NULL,
  pruned_at int8 NOT NULL
);
