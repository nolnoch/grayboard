// The SQLite store as an aliases-contract backend (aliases.contract.ts), registered by db.test.ts: the Repo's aliases
// group on a fixed clock, with the harness's fixture writes and raw reads on its connection.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db.ts";
import { scratchDbPath } from "../../../tests/support/scratch_db.ts";
import type { AliasesBackend, AliasesHarness } from "./aliases.contract.ts";
import { sqliteOf } from "./tx.ts";

export const sqliteAliasesBackend: AliasesBackend = {
  kind: "sqlite",
  async open(): Promise<AliasesHarness> {
    let now = 0;
    const { repo } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")), now: () => now });
    const run = (sql: string, args: (string | number | null)[]) => repo.write(async tx => { sqliteOf(tx).run(sql, args); });
    return {
      aliases: repo.aliases,
      write: fn => repo.write(fn),
      read: repo.read,
      setNow: ms => { now = ms; },
      session: (id, f) => run("INSERT INTO ids (id, principal, cwd, place, started_at, last_seen, ended_at) VALUES (?, NULL, ?, ?, 0, 0, ?)",
        [id, f.cwd ?? null, f.place ?? null, f.endedAt ?? null]),
      hold: (address, id) => run("INSERT INTO alias_holds (address, id, bound_at) VALUES (?, ?, 0)", [address, id]),
      bound: (address, id, at) => run("INSERT INTO binding_events (session_id, name, event, at) VALUES (?, ?, 'bound', ?)", [id, address, at]),
      cursor: (address, lastSeenId, streamRef = address) =>
        run("INSERT INTO mailbox_cursors (address, stream_type, stream_ref, last_seen_id) VALUES (?, 'direct', ?, ?)", [address, streamRef, lastSeenId]),
      touch: (address, at) => run("UPDATE aliases SET last_seen = ? WHERE address = ?", [at, address]),
      aliasRows: async () => sqliteOf(repo.read).query<{ address: string; created_by_principal: string | null }, []>(
        "SELECT address, created_by_principal FROM aliases").all(),
      cursorRows: async () => sqliteOf(repo.read).query<{ address: string; stream_ref: string }, []>(
        "SELECT address, stream_ref FROM mailbox_cursors").all(),
      close: () => repo.close(),
    };
  },
};
