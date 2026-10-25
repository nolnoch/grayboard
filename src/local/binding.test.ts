import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REFUSED_COALESCE_MS, logBinding } from "../core/bindings.ts";
import { prunePosts } from "../core/boards.ts";
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

// #210: a retry loop refused for the same reason is one row with a count.
test("a session's identical refusals within the window share a row; anything else inserts", () => {
  const db = openLocalDb(join(mkdtempSync(join(tmpdir(), "gb-local-")), "bus.db"));
  const s1 = "0123456789abcdef", s2 = "fedcba9876543210";
  logBinding(db, s1, "fe", "refused", "held by be", 1000);
  logBinding(db, s1, "fe", "refused", "held by be", 2000);
  logBinding(db, s1, "fe", "refused", "held by be", 2000 + REFUSED_COALESCE_MS);
  // Another session, another detail, another name: their own rows.
  logBinding(db, s2, "fe", "refused", "held by be", 3000);
  logBinding(db, s1, "fe", "refused", "held by sim", 4000);
  // The detail changed back: the latest row for the session is the new one.
  logBinding(db, s1, "fe", "refused", "held by be", 5000);
  // Past the window from the last repeat.
  logBinding(db, s1, "fe", "refused", "held by be", 5001 + REFUSED_COALESCE_MS);
  // Only refusals coalesce.
  logBinding(db, s1, "fe", "bound", null, 70_000);
  logBinding(db, s1, "fe", "bound", null, 70_001);
  const rows = db.prepare(`SELECT session_id, detail, event, at, count, last_at FROM binding_events ORDER BY id`).all();
  expect(rows).toEqual([
    { session_id: s1, detail: "held by be", event: "refused", at: 1000, count: 3, last_at: 2000 + REFUSED_COALESCE_MS },
    { session_id: s2, detail: "held by be", event: "refused", at: 3000, count: null, last_at: null },
    { session_id: s1, detail: "held by sim", event: "refused", at: 4000, count: null, last_at: null },
    { session_id: s1, detail: "held by be", event: "refused", at: 5000, count: null, last_at: null },
    { session_id: s1, detail: "held by be", event: "refused", at: 5001 + REFUSED_COALESCE_MS, count: null, last_at: null },
    { session_id: s1, detail: null, event: "bound", at: 70_000, count: null, last_at: null },
    { session_id: s1, detail: null, event: "bound", at: 70_001, count: null, last_at: null },
  ]);
  // Retention keeps a coalesced row while its last repeat is inside the window.
  prunePosts(db, 2000 + REFUSED_COALESCE_MS);
  expect(db.prepare(`SELECT at FROM binding_events WHERE count = 3`).all()).toEqual([{ at: 1000 }]);
});

// #211: retention keeps each name's latest bound or moved event, which says
// who holds the name by the record; everything else past the window goes.
test("retention keeps each name's latest bound or moved event", () => {
  const db = openLocalDb(join(mkdtempSync(join(tmpdir(), "gb-local-")), "bus.db"));
  const [s1, s2] = ["0123456789abcdef", "fedcba9876543210"];
  logBinding(db, s1, "fe", "bound", null, 1000);
  logBinding(db, s2, "fe", "bound", null, 2000);
  logBinding(db, s2, "fe", "released", null, 3000);
  logBinding(db, s1, "be", "moved", "fe", 4000);
  logBinding(db, s1, "be", "refused", "held", 5000);
  prunePosts(db, 10_000);
  expect(db.prepare(`SELECT session_id, name, event FROM binding_events ORDER BY id`).all()).toEqual([
    { session_id: s2, name: "fe", event: "bound" },
    { session_id: s1, name: "be", event: "moved" },
  ]);
});
