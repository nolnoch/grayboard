// The SQLite store as a claims-contract backend (claims.contract.ts), registered by db.test.ts: the Repo's claims group
// (core's claim SQL), with the harness's fixture writes and raw reads on its connection.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db.ts";
import { scratchDbPath } from "../../../tests/support/scratch_db.ts";
import type { ClaimsBackend, ClaimsHarness } from "./claims.contract.ts";
import type { ClaimRow } from "./claims.ts";
import { sqliteOf } from "./tx.ts";

export const sqliteClaimsBackend: ClaimsBackend = {
  kind: "sqlite",
  async open(): Promise<ClaimsHarness> {
    let now = 0;
    const { repo } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")), now: () => now });
    const run = (sql: string, args: (string | number | null)[]) => repo.write(async tx => { sqliteOf(tx).run(sql, args); });
    const all = <T>(sql: string) => sqliteOf(repo.read).query<T, []>(sql).all();
    return {
      claims: repo.claims,
      write: fn => repo.write(fn),
      read: repo.read,
      setNow: ms => { now = ms; },
      board: name => run("INSERT INTO boards (name, purpose, created_by, created_at) VALUES (?, '', 'test', 0)", [name]),
      session: (id, principal) => run("INSERT INTO ids (id, principal, started_at, last_seen) VALUES (?, ?, 0, 0)", [id, principal]),
      hold: (address, id) => run("INSERT INTO alias_holds (address, id, bound_at) VALUES (?, ?, 0)", [address, id]),
      claim: c => run("INSERT INTO claims (key, holder, note, board, acquired_at, expires_at, holder_user) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [c.key, c.holder, c.note, c.board, c.acquired_at, c.expires_at, c.holder_user]),
      claimRows: async () => all<ClaimRow>("SELECT key, holder, note, board, acquired_at, expires_at, holder_user FROM claims ORDER BY key"),
      watchRows: async () => all<{ key: string; handle: string }>("SELECT key, handle FROM claim_watches ORDER BY key, handle"),
      eventRows: async () => all("SELECT key, handle, event, note, board, expires_at, held_by, at FROM claim_events ORDER BY id"),
      close: () => repo.close(),
    };
  },
};
