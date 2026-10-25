// A child that opens one database the way its mode does, for tests of
// concurrent opens: `bun open_db.ts <local|bridge|server> <path> <go file>`.
// It loads its modules, writes <go file>.ready-<pid>, then waits for the go
// file, so every child's open starts within a millisecond or so of the
// others'. Exits 0 once the open
// returns; an open that throws exits 1 with the error on stderr.
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Store } from "../../src/bridge/store.ts";
import { openLocalDb } from "../../src/local/open.ts";
import { openDatabase } from "../../src/server/db.ts";

const [kind, path, go] = process.argv.slice(2) as [string, string, string];
const open = {
  local: () => openLocalDb(path).close(),
  bridge: () => new Store(path).db.close(),
  server: () => openDatabase(path, { blobDir: join(dirname(path), "blobs") }).db.close(),
}[kind];
if (!open) throw new Error(`unknown kind ${kind}`);
writeFileSync(`${go}.ready-${process.pid}`, "");
const deadline = Date.now() + 10_000;
while (!existsSync(go)) {
  if (Date.now() > deadline) throw new Error(`no go file ${go} within 10 s`);
  Bun.sleepSync(1);
}
open();
