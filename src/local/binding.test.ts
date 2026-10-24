import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reap, type SessionRow } from "./binding.ts";
import { openLocalDb } from "./open.ts";

// #182 audit 29: two processes that read the same dead row both reap it;
// only the one whose delete removed it logs the release.
test("a dead row reaped twice logs one release", () => {
  const db = openLocalDb(join(mkdtempSync(join(tmpdir(), "gb-local-")), "bus.db"));
  db.prepare(`INSERT INTO bindings (session_id, name, pid, started_at) VALUES ('0123456789abcdef', 'fe', 999999, 1)`).run();
  const rows = db.prepare(`SELECT * FROM bindings`).all() as SessionRow[];
  db.transaction(() => reap(db, rows, 2)).immediate();
  db.transaction(() => reap(db, rows, 3)).immediate();
  expect(db.prepare(`SELECT name, event, detail FROM binding_events`).all()).toEqual([{ name: "fe", event: "released", detail: "reaped: pid 999999 is gone" }]);
});
