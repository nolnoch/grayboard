import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { QUEUED_FOR_SQL } from "./binding.ts";
import { LOCAL_UNDELIVERED_FROM_SQL } from "./db.ts";
import { openLocalDb } from "./open.ts";

// #130: the local undeliveredFrom join keys on the cursors PK (reader), so the
// plan must SEARCH by that key — a SCAN here means the index/PK was lost.
test("undeliveredFrom uses the reader PK, not a cursors scan", () => {
  const db = openLocalDb(join(mkdtempSync(join(tmpdir(), "gb-local-")), "bus.db")).db;
  const plan = db.prepare("EXPLAIN QUERY PLAN " + LOCAL_UNDELIVERED_FROM_SQL)
    .all(JSON.stringify(["be@example.com/be"]), Number.MAX_SAFE_INTEGER) as { detail: string }[];
  const detail = plan.map(p => p.detail).join(" ");
  expect(detail).toContain("SEARCH c USING");
  expect(detail).not.toContain("SCAN cursors");
});

// #182 audit 27: an unbound start counts queued DMs for its candidate names
// only, by an index search per name; a SCAN of messages means it lost that.
test("candidate queue counts search messages by recipient, never scan it", () => {
  const db = openLocalDb(join(mkdtempSync(join(tmpdir(), "gb-local-")), "bus.db")).db;
  const plan = db.prepare("EXPLAIN QUERY PLAN " + QUEUED_FOR_SQL).all(JSON.stringify(["fe", "be"])) as { detail: string }[];
  const detail = plan.map((p) => p.detail).join(" ");
  expect(detail).toContain("SEARCH m USING INDEX idx_messages_recipient_id (recipient=? AND id>?)");
  expect(detail).not.toContain("SCAN m");
  db.prepare(`INSERT INTO messages (sender, recipient, body, created_at) VALUES ('be', 'fe', 'a', 1), ('be', 'fe', 'b', 2), ('fe', 'fe', 'self', 3), ('fe', 'sim', 'c', 4)`).run();
  db.prepare(`INSERT INTO cursors (reader, last_seen_id) VALUES ('fe', 1)`).run();
  expect(db.prepare(QUEUED_FOR_SQL).all(JSON.stringify(["fe", "be"]))).toEqual([{ name: "fe", n: 1 }, { name: "be", n: 0 }]);
});
