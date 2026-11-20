-- #1355: whether a post bears the human mark, judged when it's written (core/schema.ts posts.human, postMark in
-- core/boards.ts): true for a declared human's own words, false for every other post, a system post written as a
-- human's handle among them; null for posts from before it, which fall back to whether the author is human now.
ALTER TABLE posts ADD COLUMN human boolean;
