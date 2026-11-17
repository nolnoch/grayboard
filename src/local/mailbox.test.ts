import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { lowercaseLegacyHandles } from "./handle_case.ts";
import { markDmDelivered } from "./mailbox.ts";
import { openLocalDb } from "./open.ts";

function bus() {
  const db = openLocalDb(join(mkdtempSync(join(tmpdir(), "gb-mailbox-")), "bus.db")).db;
  const send = (to: string) =>
    Number(db.prepare(`INSERT INTO messages (sender, recipient, body, created_at) VALUES ('be', ?, 'x', 1)`).run(to).lastInsertRowid);
  const cursor = (reader: string) =>
    (db.prepare(`SELECT last_seen_id FROM cursors WHERE reader = ?`).get(reader) as { last_seen_id: number } | null)?.last_seen_id ?? 0;
  const stamped = (id: number) =>
    (db.prepare(`SELECT delivered_at FROM messages WHERE id = ?`).get(id) as { delivered_at: number | null }).delivered_at;
  return { db, send, cursor, stamped };
}

test("markDmDelivered stamps the DM and moves the cursor to it", () => {
  const { db, send, cursor, stamped } = bus();
  const a = send("gray");
  const b = send("gray");
  markDmDelivered(db, "gray", a, 5);
  markDmDelivered(db, "gray", b, 6);
  expect([cursor("gray"), stamped(a), stamped(b)]).toEqual([b, 5, 6]);
  // A late mark of an older id never moves the cursor back.
  markDmDelivered(db, "gray", a, 7);
  expect([cursor("gray"), stamped(a)]).toEqual([b, 5]);
});

// #1192: a case merge (#216) gives `gray` an undelivered DM below the one whose
// push is in flight, lowering its cursor to reach it. Marking the in-flight one
// stops the cursor below the merged DM, so the next drain still pushes it.
test("markDmDelivered stops the cursor below an undelivered DM a case merge moved in", () => {
  const { db, send, cursor, stamped } = bus();
  db.prepare(`INSERT INTO handles (name, first_seen, last_seen) VALUES ('Gray', 1, 1), ('gray', 2, 2)`).run();
  const merged = send("Gray");
  const inflight = send("gray");
  const later = send("Gray");
  // `gray`'s session is pushing `inflight` when another process's open merges
  // `Gray` (no cursor) in: both its DMs move and the cursor drops below them.
  db.prepare(`INSERT INTO cursors (reader, last_seen_id) VALUES ('gray', ?)`).run(inflight - 1);
  db.transaction(() => lowercaseLegacyHandles(db, () => {})).immediate();
  expect(cursor("gray")).toBe(merged - 1);
  markDmDelivered(db, "gray", inflight, 5);
  expect([cursor("gray"), stamped(inflight)]).toEqual([merged - 1, 5]);
  // The drain then pushes the merged DM; the in-flight one above the cursor is
  // stamped, so delivery skips it and the next mark passes it.
  markDmDelivered(db, "gray", merged, 6);
  expect(cursor("gray")).toBe(merged);
  markDmDelivered(db, "gray", later, 7);
  expect(cursor("gray")).toBe(later);
});

test("markDmDelivered ignores undelivered DMs at or below the cursor and other readers' DMs", () => {
  const { db, send, cursor } = bus();
  const old = send("gray"); // e.g. mail from before delivered_at existed (#470)
  const other = send("blue");
  const next = send("gray");
  db.prepare(`INSERT INTO cursors (reader, last_seen_id) VALUES ('gray', ?)`).run(old);
  markDmDelivered(db, "gray", next, 5);
  expect(cursor("gray")).toBe(next);
  expect(other).toBeLessThan(next);
});
