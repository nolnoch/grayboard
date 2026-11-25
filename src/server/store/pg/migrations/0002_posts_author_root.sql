-- #540: the root of the session that wrote a post, judged when it's written (core/schema.ts posts.author_root). The
-- NOT_OWN fragment (store/pg/boards.ts notOwn) reads it before the author's root as it is now, which a former child's
-- ID starting as a root clears. Null for a post with no author_id and for rows from before it. Additive (expand only):
-- a release without it never writes or reads the column.
ALTER TABLE posts ADD COLUMN author_root text COLLATE "C";
