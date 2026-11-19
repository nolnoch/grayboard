// The SQLite store as an auth-cache-contract backend (auth_cache.contract.ts), registered by db.test.ts: the Repo's auth
// members over db.ts's generation source, with an outside writer on a second connection to the file. It reaches the
// connection class through the store's own handle, so this module stays off bun:sqlite (db.test.ts's isolation test).
import { spyOn } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, USER_BY_ID_SQL } from "../db.ts";
import { scratchDbPath } from "../../../tests/support/scratch_db.ts";
import type { AuthCacheBackend, AuthCacheHarness } from "./auth_cache.contract.ts";

export const sqliteAuthCacheBackend: AuthCacheBackend = {
  kind: "sqlite",
  async open(): Promise<AuthCacheHarness> {
    const path = scratchDbPath();
    const { db, repo } = openDatabase(path, { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
    const Connection = db.constructor as new (path: string) => typeof db;
    let advanced = 0;
    return {
      auth: { authRead: repo.authRead, authPeek: repo.authPeek, authGeneration: repo.authGeneration, commitGeneration: repo.commitGeneration,
        findActiveAccess: (...a) => repo.oauth.findActiveAccess(...a), isDisabled: (...a) => repo.users.isDisabled(...a), active: (...a) => repo.users.active(...a) },
      oauth: repo.oauth, users: repo.users,
      write: fn => repo.write(fn),
      read: repo.read,
      now: () => repo.now(),
      touchOther: tx => repo.cursors.advance(tx, "a@example.com/fe", "direct", "a@example.com/fe", ++advanced),
      async outsideDisable(userId) {
        const outside = new Connection(path);
        try { outside.run("PRAGMA busy_timeout = 5000"); outside.run("UPDATE users SET disabled_at = ? WHERE id = ?", [repo.now(), userId]); }
        finally { outside.close(); }
      },
      seen: async () => {},
      reads() {
        // The user-by-id read and the live-token join (its grant_expiry column), as the caches issue them.
        const query = spyOn(Object.getPrototypeOf(db) as typeof db, "query");
        const count = (match: (sql: string) => boolean) => query.mock.calls.filter(([sql]) => match(String(sql))).length;
        return { users: () => count(sql => sql === USER_BY_ID_SQL), accesses: () => count(sql => sql.includes("AS grant_expiry")), restore: () => query.mockRestore() };
      },
      close: () => repo.close(),
    };
  },
};
