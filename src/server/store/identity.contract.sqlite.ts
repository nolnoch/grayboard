// The SQLite store as an identity-contract backend (identity.contract.ts), registered by db.test.ts: the Repo's
// groups, with the harness's fixture writes and raw reads on its connection.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db.ts";
import { scratchDbPath } from "../../../tests/support/scratch_db.ts";
import type { IdentityBackend, IdentityStore } from "./identity.contract.ts";
import { sqliteOf } from "./tx.ts";

export const sqliteIdentityBackend: IdentityBackend = {
  kind: "sqlite",
  async open(): Promise<IdentityStore> {
    const { db, repo } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
    const run = (sql: string, args: (string | number | null)[]) => repo.write(async tx => { sqliteOf(tx).run(sql, args); });
    return {
      users: repo.users, sessions: repo.sessions, principals: repo.principals, teams: repo.teams, roles: repo.roles, services: repo.services,
      write: fn => repo.write(fn),
      read: repo.read,
      disable: userId => run("UPDATE users SET disabled_at = ? WHERE id = ?", [repo.now(), userId]),
      setIdp: (userId, issuer, subject) => run("UPDATE users SET idp_issuer = ?, idp_subject = ? WHERE id = ?", [issuer, subject, userId]),
      setPolicyRaw: (teamId, policy) => run("UPDATE teams SET policy = ? WHERE id = ?", [policy, teamId]),
      registerId: (id, principal) => run("INSERT INTO ids (id, principal, started_at, last_seen) VALUES (?, ?, 0, 0)", [id, principal]),
      async principalRows() {
        return sqliteOf(repo.read).query<{ kind: string; name: string; user_id: number | null; team_id: number | null }, []>(
          "SELECT kind, name, user_id, team_id FROM principals ORDER BY id").all();
      },
      async audits(action) {
        return sqliteOf(repo.read).query<{ actor: string | null; target: string | null; detail: string | null; detail_type: string | null }, [string]>(
          "SELECT actor, target, detail, json_type(detail) AS detail_type FROM access_log WHERE action = ? ORDER BY id").all(action)
          .map(r => ({ ...r, detail: r.detail === null ? null : JSON.parse(r.detail) as unknown }));
      },
      raw: sql => { db.run(sql); },
      close: () => repo.close(),
    };
  },
};
