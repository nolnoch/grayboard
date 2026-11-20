// The SQLite store as a hosted-contract backend (hosted.contract.ts), registered by db.test.ts: the Repo's hosted group,
// with the harness's fixture writes and raw reads on its connection. A child's ID end is the server's
// (server/session_end.ts), through the port the server passes.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db.ts";
import { sessionEndPort } from "../session_end.ts";
import { scratchDbPath } from "../../../tests/support/scratch_db.ts";
import type { HostedBackend, HostedHarness } from "./hosted.contract.ts";
import { sqliteOf } from "./tx.ts";

type Arg = string | number | null;

export const sqliteHostedBackend: HostedBackend = {
  kind: "sqlite",
  async open(): Promise<HostedHarness> {
    const { repo } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")), sessionEnd: sessionEndPort("team") });
    const run = (sql: string, args: Arg[]) => repo.write(async tx => sqliteOf(tx).run(sql, args));
    const all = <T>(sql: string, args: Arg[] = []) => sqliteOf(repo.read).query<T, Arg[]>(sql).all(...args);
    return {
      hosted: repo.hosted,
      write: fn => repo.write(fn),
      read: repo.read,
      seedUser: async (email, disabled = false) =>
        Number((await run("INSERT INTO users (email, created_at, disabled_at) VALUES (?, 0, ?)", [email, disabled ? 1 : null])).lastInsertRowid),
      seedGrant: async (id, user, expiresAt, revokedAt = null) => {
        await run("INSERT INTO oauth_grants (id, user_id, expires_at, revoked_at, data) VALUES (?, ?, ?, ?, '{}')", [id, user, expiresAt, revokedAt]);
      },
      seedIds: async (id, f = {}) => {
        await run("INSERT INTO ids (id, started_at, last_seen, root_id, ended_at, held_aliases_json, writes_as, launcher) VALUES (?, 0, 0, ?, ?, ?, ?, ?)",
          [id, f.rootId ?? null, f.endedAt ?? null, f.heldAliasesJson ?? null, f.writesAs ?? null, f.launcher === null ? null : f.launcher ? 1 : 0]);
      },
      seedHold: async (address, id, boundAt) => { await run("INSERT INTO alias_holds (address, id, bound_at) VALUES (?, ?, ?)", [address, id, boundAt]); },
      ids: async id => {
        const row = all<{ root_id: string | null; ended_at: number | null; held_aliases_json: string | null; writes_as: string | null; launcher: number | null }>(
          "SELECT root_id, ended_at, held_aliases_json, writes_as, launcher FROM ids WHERE id = ?", [id])[0];
        return row && { ...row, launcher: row.launcher === 1 };
      },
      ownership: async id => all<{ session_id: string; ended_at: number | null; end_reason: string | null }>(
        "SELECT session_id, ended_at, end_reason FROM hosted_ownerships WHERE id = ?", [id])[0],
      holdRows: async () => all("SELECT address, id FROM alias_holds ORDER BY address"),
      bindingRows: async () => all("SELECT session_id, name, event, detail FROM binding_events ORDER BY id"),
      auditRows: async () => all<{ actor: string | null; action: string; target: string | null; detail: string | null }>(
        "SELECT actor, action, target, detail FROM access_log ORDER BY id").map(a => ({ ...a, detail: a.detail === null ? null : JSON.parse(a.detail) })),
      lostRows: async () => all("SELECT session_id, alias FROM hosted_alias_lost ORDER BY session_id, alias"),
      idEnded: async id => all<{ ended_at: number | null }>("SELECT ended_at FROM ids WHERE id = ?", [id])[0]?.ended_at ?? null,
      close: () => repo.close(),
    };
  },
};
