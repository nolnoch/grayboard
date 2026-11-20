// The SQLite store as a bindings-contract backend (bindings.contract.ts), registered by db.test.ts: the Repo's bindings
// group, with the harness's fixture writes and raw reads on its connection.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db.ts";
import { scratchDbPath } from "../../../tests/support/scratch_db.ts";
import type { BindingsBackend, BindingsHarness } from "./bindings.contract.ts";
import { sqliteOf } from "./tx.ts";

export const sqliteBindingsBackend: BindingsBackend = {
  kind: "sqlite",
  async open(): Promise<BindingsHarness> {
    const { repo } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
    const run = (sql: string, args: (string | number | null)[]) => repo.write(async tx => { sqliteOf(tx).run(sql, args); });
    const all = <T>(sql: string, args: (string | number)[] = []) => sqliteOf(repo.read).query<T, (string | number)[]>(sql).all(...args);
    return {
      bindings: repo.bindings,
      write: fn => repo.write(fn),
      read: repo.read,
      alias: (scopeRef, name) => repo.write(async tx => (await repo.aliases.create(tx, { scope_kind: "person", scope_ref: scopeRef, name }, scopeRef))!.address),
      hold: (address, id, boundAt) => run("INSERT INTO alias_holds (address, id, bound_at) VALUES (?, ?, ?)", [address, id, boundAt]),
      end: (id, at) => run("UPDATE ids SET ended_at = ? WHERE id = ?", [at, id]),
      started: (id, at) => run("UPDATE ids SET started_at = ? WHERE id = ?", [at, id]),
      tombstone: (id, endedAt, prunedAt) => run("INSERT INTO pruned_ids (id, ended_at, pruned_at) VALUES (?, ?, ?)", [id, endedAt, prunedAt]),
      holdRows: async () => all("SELECT address, id, bound_at FROM alias_holds ORDER BY address"),
      events: async () => all("SELECT session_id, name, event, at, detail, count, last_at FROM binding_events ORDER BY id"),
      aliasRow: async address => all<{ last_seen: number | null; queue_off: number | null; task: string | null; owner: string | null; source_board: string | null; spec_hash: string | null; description: string | null }>(
        "SELECT last_seen, queue_off, task, owner, source_board, spec_hash, description FROM aliases WHERE address = ?", [address])
        .map(r => ({ ...r, queue_off: r.queue_off === null ? null : r.queue_off === 1 }))[0],
      idColumns: async id => all<{ harness: string | null; cwd: string | null; delivery: string; keyed: number; local_resume: number; root_id: string | null; harness_session: string | null; started_at: number; last_seen: number }>(
        "SELECT harness, cwd, delivery, keyed, local_resume, root_id, harness_session, started_at, last_seen FROM ids WHERE id = ?", [id])
        .map(r => ({ ...r, keyed: r.keyed === 1, local_resume: r.local_resume === 1 }))[0],
      tombstones: async () => all("SELECT id, ended_at, pruned_at FROM pruned_ids ORDER BY id"),
      audits: async action => all("SELECT actor, target, detail FROM access_log WHERE action = ? ORDER BY id", [action]),
      close: () => repo.close(),
    };
  },
};
