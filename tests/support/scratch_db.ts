import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A server database file in a fresh scratch directory, in place of ":memory:": a second connection to
// ":memory:" opens a separate, empty database, and the server store reads on its own connection
// (docs/future/postgres-server.md D8, P1).
export function scratchDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "gb-db-")), "bus.db");
}
