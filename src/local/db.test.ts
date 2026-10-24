import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LOCAL_UNDELIVERED_FROM_SQL } from "./db.ts";
import { openLocalDb } from "./open.ts";

// #130: the local undeliveredFrom join keys on the cursors PK (reader), so the
// plan must SEARCH by that key — a SCAN here means the index/PK was lost.
test("undeliveredFrom uses the reader PK, not a cursors scan", () => {
  const db = openLocalDb(join(mkdtempSync(join(tmpdir(), "gb-local-")), "bus.db"));
  const plan = db.prepare("EXPLAIN QUERY PLAN " + LOCAL_UNDELIVERED_FROM_SQL)
    .all("be@example.com/be", Number.MAX_SAFE_INTEGER) as { detail: string }[];
  const detail = plan.map(p => p.detail).join(" ");
  expect(detail).toContain("SEARCH c USING");
  expect(detail).not.toContain("SCAN cursors");
});
