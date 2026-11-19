// The SQLite store as an OAuth-contract backend (oauth.contract.ts), registered by oauth-store.test.ts: the Repo's
// oauth store and the identity groups its fixtures need, with the harness's fixture writes and raw reads on its connection.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db.ts";
import { scratchDbPath } from "../../../tests/support/scratch_db.ts";
import type { OAuthBackend, OAuthHarness, OAuthTable, Row } from "./oauth.contract.ts";
import { sqliteOf } from "./tx.ts";

const WITH_DATA = new Set<OAuthTable>(["oauth_requests", "oauth_browsers", "oauth_codes", "oauth_grants"]);

export const sqliteOAuthBackend: OAuthBackend = {
  kind: "sqlite",
  async open(): Promise<OAuthHarness> {
    const { repo } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
    const run = (sql: string, args: (string | number | null)[]) => repo.write(async tx => { sqliteOf(tx).run(sql, args); });
    return {
      oauth: repo.oauth, users: repo.users, sessions: repo.sessions, services: repo.services,
      write: fn => repo.write(fn),
      read: repo.read,
      setDisabled: (userId, disabled) => repo.write(tx => repo.users.setDisabled(tx, userId, disabled)),
      disable: userId => run("UPDATE users SET disabled_at = ? WHERE id = ?", [repo.now(), userId]),
      revokeAllForUser: userId => repo.write(tx => repo.sessions.revokeAllForUser(tx, userId)),
      fillBrowsers: (userId, n, expiresAt) => run(`WITH RECURSIVE i(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM i WHERE n < ?1)
        INSERT INTO oauth_browsers(hash, user_id, expires_at, data)
        SELECT printf('fill-%d', n), ?2, ?3, json_object('sessionHash', printf('fill-%d', n), 'userId', ?2, 'createdAt', 0, 'expiresAt', ?3) FROM i`, [n, userId, expiresAt]),
      async rows(table) {
        const extra = WITH_DATA.has(table) ? ", json_type(data) AS data_type" : "";
        return sqliteOf(repo.read).query<Row, []>(`SELECT *${extra} FROM ${table} ORDER BY rowid`).all()
          .map(r => WITH_DATA.has(table) ? { ...r, data: JSON.parse(r.data as string) as unknown } : r);
      },
      async audits(action) {
        return sqliteOf(repo.read).query<{ actor: string | null; target: string | null; detail: string | null; detail_type: string | null }, [string]>(
          "SELECT actor, target, detail, json_type(detail) AS detail_type FROM access_log WHERE action = ? ORDER BY id").all(action)
          .map(r => ({ ...r, detail: r.detail === null ? null : JSON.parse(r.detail) as unknown }));
      },
      close: () => repo.close(),
    };
  },
};
