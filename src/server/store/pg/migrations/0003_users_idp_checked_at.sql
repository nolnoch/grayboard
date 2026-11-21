-- #930: when the user's IdP last vouched for them (a verified sign-in), in ms since the epoch. A person whose clock is
-- older than GRAYBOARD_IDP_REAUTH_DAYS is sent back through the IdP: refresh answers invalid_grant and the CLI token is
-- refused. Every existing row is stamped now, once with the column, so an upgrade starts each user's clock rather
-- than finding every user stale, and a row unlink-idp cleared (no issuer) gets a clock rather than reading as exempt. Additive (expand only): a release without it never reads the column, and a
-- row it links meanwhile keeps a null clock, which reads as due, so that user signs in once more.
ALTER TABLE users ADD COLUMN idp_checked_at int8;
UPDATE users SET idp_checked_at = (extract(epoch FROM clock_timestamp()) * 1000)::int8;
