-- #1651: the admin dashboard's keyset pages (store/admin.ts): the audit log by actor and by action alone, newest first,
-- and a board's thread roots (partial on parent_id IS NULL). Additive (expand only): a release without them never
-- reads them. Plain CREATE INDEX, inside the migration's transaction: it blocks writes to access_log and posts while it
-- builds, which on the pilot's tables is seconds; CONCURRENTLY can't run in a transaction.
CREATE INDEX idx_access_log_actor ON access_log (actor, at);
CREATE INDEX idx_access_log_action ON access_log (action, at);
CREATE INDEX idx_posts_board_roots ON posts (board, id) WHERE parent_id IS NULL;
