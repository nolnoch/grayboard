// The SQLite store as a cursors-contract backend (cursors.contract.ts), registered by db.test.ts: the Repo's cursors
// group.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db.ts";
import { scratchDbPath } from "../../../tests/support/scratch_db.ts";
import type { CursorsBackend, CursorsHarness } from "./cursors.contract.ts";

export const sqliteCursorsBackend: CursorsBackend = {
  kind: "sqlite",
  async open(): Promise<CursorsHarness> {
    const { repo } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
    return { cursors: repo.cursors, write: fn => repo.write(fn), read: repo.read, close: () => repo.close() };
  },
};
