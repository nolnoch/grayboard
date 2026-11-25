// The SQLite store as a session-end and delegation contract backend (session_end.contract.ts, delegation.contract.ts),
// registered by db.test.ts: the Repo's sessionEnd and delegation groups (core's SQL), with the harness's fixture writes
// and raw reads on its connection.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db.ts";
import { scratchDbPath } from "../../../tests/support/scratch_db.ts";
import type { IdsBackend, IdsHarness } from "./session_end.contract.ts";
import { sqliteOf } from "./tx.ts";

const bit = (b: boolean | null | undefined) => b === null || b === undefined ? null : b ? 1 : 0;

export const sqliteIdsBackend: IdsBackend = {
  kind: "sqlite",
  async open(): Promise<IdsHarness> {
    const { repo } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
    const run = (sql: string, args: (string | number | null)[]) => repo.write(async tx => { sqliteOf(tx).run(sql, args); });
    return {
      sessionEnd: repo.sessionEnd,
      delegation: repo.delegation,
      write: fn => repo.write(fn),
      read: repo.read,
      session: (id, f = {}) => run(
        `INSERT INTO ids (id, principal, launcher, viewer, keyed, delivery, writes_as, root_id, ended_at, held_aliases_json, started_at, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
        [id, f.principal ?? null, bit(f.launcher), bit(f.viewer) ?? 0, bit(f.keyed) ?? 0, f.delivery ?? "push", f.writesAs ?? null, f.rootId ?? null,
          f.endedAt ?? null, f.held ? JSON.stringify(f.held) : null]),
      alias: (address, f = {}) => {
        const at = address.lastIndexOf("/");
        return run("INSERT INTO aliases (address, scope_kind, scope_ref, name, human, created_at, last_seen) VALUES (?, 'person', ?, ?, ?, 0, ?)",
          [address, address.slice(0, at), address.slice(at + 1), bit(f.human), f.lastSeen ?? null]);
      },
      hold: (address, id, boundAt) => run("INSERT INTO alias_holds (address, id, bound_at) VALUES (?, ?, ?)", [address, id, boundAt]),
      bound: (address, id, at) => run("INSERT INTO binding_events (session_id, name, event, at) VALUES (?, ?, 'bound', ?)", [id, address, at]),
      message: (sender, recipient, parentId = null) => repo.write(async tx => sqliteOf(tx).query<{ id: number }, [string, string, number | null]>(
        "INSERT INTO messages (sender, recipient_type, recipient, body, parent_id, created_at) VALUES (?, 'user', ?, 'm', ?, 0) RETURNING id",
      ).get(sender, recipient, parentId)!.id),
      ack: (reader, messageId) => run("INSERT INTO dm_acks (reader, message_id, acked_at) VALUES (?, ?, 0)", [reader, messageId]),
      requested: (target, at, messageId) => run("INSERT INTO access_log (at, actor, action, target, detail) VALUES (?, 'b@example.com', 'delegation.requested', ?, ?)",
        [at, target, JSON.stringify({ requester: "c@example.com/req", via: "explicit", message_id: messageId })]),
      tombstone: (id, endedAt, prunedAt) => run("INSERT INTO pruned_ids (id, ended_at, pruned_at) VALUES (?, ?, ?)", [id, endedAt, prunedAt]),
      idRows: async () => sqliteOf(repo.read).query<{ id: string }, []>("SELECT id FROM ids ORDER BY id").all().map(r => r.id),
      prunedRows: async () => sqliteOf(repo.read).query<{ id: string; ended_at: number; pruned_at: number }, []>(
        "SELECT id, ended_at, pruned_at FROM pruned_ids ORDER BY id").all(),
      close: () => repo.close(),
    };
  },
};
