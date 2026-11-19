// Live oauth_grants rows for a test's hand-made principals (#807 P3 C8a): a hosted write body reads its grant first
// (HostedStore.grantLive), so a principal whose grantId names no live row is refused unauthenticated there, whatever
// the test's isAuthorized says. Never expiring; an id already present is left as it is.
import type { Repo } from "../../src/server/db.ts";
import { sqliteOf } from "../../src/server/store/tx.ts";

export function liveGrants(repo: Pick<Repo, "write">, userId: number, ids: string[]): Promise<void> {
  return repo.write(async tx => {
    for (const id of ids) sqliteOf(tx).run("INSERT OR IGNORE INTO oauth_grants (id, user_id, expires_at, revoked_at, data) VALUES (?, ?, ?, NULL, '{}')", [id, userId, Number.MAX_SAFE_INTEGER]);
  });
}
