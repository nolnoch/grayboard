import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LOCAL_SENT_PENDING_SQL, LOCAL_UNDELIVERED_FROM_SQL, QUEUED_FOR_SQL, localHistorySql } from "./binding.ts";
import { openLocalDb } from "./open.ts";
import { AUDIT_LOG_LAST_SQL } from "../core/audit.ts";

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

// #859: both sender-keyed statements seek messages by sender; without the
// index each scanned the whole DM history, at every session start.
test("undeliveredFrom and sentPending search messages by sender, never scan it", () => {
  const db = openLocalDb(join(mkdtempSync(join(tmpdir(), "gb-local-")), "bus.db")).db;
  const detail = (sql: string, ...args: (string | number)[]) =>
    (db.prepare("EXPLAIN QUERY PLAN " + sql).all(...args) as { detail: string }[]).map((p) => p.detail).join(" ");
  for (const plan of [detail(LOCAL_UNDELIVERED_FROM_SQL, JSON.stringify(["fe"]), Number.MAX_SAFE_INTEGER),
                      detail(LOCAL_SENT_PENDING_SQL, JSON.stringify(["fe"]), 0)]) {
    expect(plan).toContain("SEARCH m USING INDEX idx_messages_sender_id (sender=?)");
    expect(plan).not.toContain("SCAN m");
  }
});

// #859 audit: idx_messages_sender_id must not turn dm_history's no-peer page
// into an index OR that gathers and sorts all the caller's DMs; it walks
// messages newest first and stops at the limit.
test("dm_history with no peer walks messages by id, never an index OR and a sort", () => {
  const db = openLocalDb(join(mkdtempSync(join(tmpdir(), "gb-local-")), "bus.db")).db;
  const me = JSON.stringify(["fe"]);
  for (const [sql, args] of [[localHistorySql(false, false), [me, me, 20]], [localHistorySql(false, true), [me, me, 100, 20]]] as const) {
    const detail = (db.prepare("EXPLAIN QUERY PLAN " + sql).all(...args) as { detail: string }[]).map((p) => p.detail).join(" ");
    expect(detail).toMatch(/SCAN m|SEARCH m USING INTEGER PRIMARY KEY/);
    expect(detail).not.toContain("MULTI-INDEX");
    expect(detail).not.toContain("TEMP B-TREE");
  }
  db.prepare(`INSERT INTO messages (sender, recipient, body, created_at) VALUES ('be', 'fe', 'a', 1), ('fe', 'be', 'b', 2), ('be', 'sim', 'x', 3), ('sim', 'fe', 'c', 4)`).run();
  expect((db.prepare(localHistorySql(false, false)).all(me, me, 2) as { body: string }[]).map((m) => m.body)).toEqual(["c", "b"]);
  expect((db.prepare(localHistorySql(true, true)).all(me, "be", "be", me, 4, 5) as { body: string }[]).map((m) => m.body)).toEqual(["b", "a"]);
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

// #295: lastCoreAudit searches audit_log by (action, target) and reads it newest first, with no scan or sort.
test("lastCoreAudit searches audit_log by (action, target), never a scan or a sort", () => {
  const db = openLocalDb(join(mkdtempSync(join(tmpdir(), "gb-local-")), "bus.db")).db;
  const detail = (db.prepare("EXPLAIN QUERY PLAN " + AUDIT_LOG_LAST_SQL).all("delegation.created", "7") as { detail: string }[]).map((p) => p.detail).join(" ");
  expect(detail).toContain("SEARCH audit_log USING INDEX idx_audit_log_action_target (action=? AND target=?)");
  expect(detail).not.toContain("SCAN");
  expect(detail).not.toContain("TEMP B-TREE");
});
