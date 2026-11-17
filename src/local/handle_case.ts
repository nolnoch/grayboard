// #216: a 1.x bus could store a mixed-case handle (`Gray`): BUS_IDENTITY and
// the repo pin were taken literally until #181 (v2.0.0), and the open's seed
// (open.ts) made each such handle an alias. Since #181 a session asking for
// `Gray` binds `gray`, so the old name's DMs, claims, cursors and
// subscriptions sat where no session could reach them. This step moves them
// to the lowercase name, and leaves a trail either way.
//
// The lowercase name usually exists already: any v2 session started with
// BUS_IDENTITY=Gray created it. Then the two merge, the lowercase name's row
// winning wherever a key holds one row per name (its cursor, its
// subscription mode, its alias labels). A merge is refused only where it
// would change who a name is: one of the two is a human and the other isn't,
// an agent's name lowercases to the reserved `human`, or it isn't a valid name
// at all.
//
// Data only (schema changes stay additive). It runs inside the open's schema
// transaction, after the seed, on every open: a 1.x grayboard still running
// as `Gray` writes the old name again, and the next open merges those rows
// too. One name moves under its own savepoint; a statement that fails rolls
// it back and is reported as a collision rather than failing the open.
import type { Database } from "bun:sqlite";

import { HUMAN_NAME, normalizeIdentityName } from "../shared/addressing.ts";
import { writeCoreAudit } from "../core/audit.ts";
import { afterCommit } from "../core/sqlite.ts";

// Every column a 1.x bus wrote a handle to, plus the aliases its seed copied
// them into and the v2 tables keyed by a name. Bodies, claim keys and notes
// are text, not addresses, and stay as written. `keyed`: a key holds one row
// per name, so where both names have one the lowercase name's stays and the
// old one's is dropped.
const COLUMNS: readonly (readonly [table: string, column: string, keyed: boolean])[] = [
  ["handles", "name", true], ["aliases", "address", true], ["aliases", "name", false], ["alias_holds", "address", true],
  ["boards", "created_by", false], ["boards", "archived_by", false], ["posts", "author", false],
  ["subscriptions", "handle", true], ["outbox", "handle", true], ["thread_mutes", "handle", true],
  ["claims", "holder", false], ["claim_watches", "handle", true], ["claim_events", "handle", false], ["claim_events", "held_by", false],
  ["attachments", "uploader", false], ["messages", "sender", false], ["messages", "recipient", false],
  ["cursors", "reader", true], ["dm_acks", "reader", true],
];

export type CaseNotice = (line: string) => void;

// The names a committed move gave rows, per connection, for the opener to
// wake: a live session bound to `gray` while another process's open merges
// `Gray` into it is told only by a wakeup (#1189).
const wakes = new WeakMap<Database, string[]>();
export function takeCaseWakes(db: Database): string[] {
  const names = wakes.get(db) ?? [];
  wakes.delete(db);
  return names;
}

// The alias row is the human flag's authority (core/boards.ts); handles.human
// is 1.x's copy, which declaring a human since never updates.
const isHuman = (db: Database, name: string): boolean =>
  !!db.prepare(`SELECT 1 FROM aliases WHERE address = ? AND human = 1`).get(name);
const cursorOf = (db: Database, name: string): number =>
  (db.prepare(`SELECT last_seen_id AS c FROM cursors WHERE reader = ?`).get(name) as { c: number } | null)?.c ?? 0;
const exists = (db: Database, name: string): boolean =>
  !!db.prepare(`SELECT 1 FROM aliases WHERE address = ?1 UNION SELECT 1 FROM handles WHERE name = ?1`).get(name);

export function lowercaseLegacyHandles(db: Database, notice: CaseNotice = (l) => process.stderr.write(`${l}\n`)): void {
  // The most recently seen spelling first, so of a stale `GRAY` and the
  // `Gray` in use, `Gray` moves and `GRAY` merges into it after.
  const names = (db.prepare(
    `SELECT n FROM (
       SELECT address AS n, last_seen AS seen FROM aliases WHERE scope_ref IS NULL AND address <> lower(address)
       UNION ALL SELECT name, last_seen FROM handles WHERE name <> lower(name) AND name NOT LIKE '~%'
     ) GROUP BY n ORDER BY max(coalesce(seen, 0)) DESC, n`,
  ).all() as { n: string }[]).map((r) => r.n);
  for (const from of names) {
    // The name a session asking for `from` binds since #181.
    const n = normalizeIdentityName(from);
    if (!n.ok) {
      collision(db, from, from.toLowerCase(), "not a valid name after lowercasing", notice);
      continue;
    }
    const to = n.name;
    // Local mode lets a human handle be named `human`; an agent can't be.
    if (to === HUMAN_NAME && !isHuman(db, from)) {
      collision(db, from, to, `"${HUMAN_NAME}" is reserved`, notice);
      continue;
    }
    const merged = exists(db, to);
    if (merged && isHuman(db, from) !== isHuman(db, to)) {
      collision(db, from, to, `one of "${from}" and "${to}" is a human and the other isn't`, notice);
      continue;
    }
    db.exec("SAVEPOINT handle_case");
    try {
      // Two DM cursors become one. Below its own cursor each name's DMs were
      // delivered (1.x never stamped delivered_at), so stamp them, then keep
      // the lower cursor: the other name's undelivered DMs above it still
      // push, and delivery skips what is stamped.
      const lowest = merged ? Math.min(cursorOf(db, from), cursorOf(db, to)) : 0;
      if (merged) {
        const stamp = db.prepare(`UPDATE messages SET delivered_at = ?1 WHERE recipient = ?2 AND id <= ?3 AND delivered_at IS NULL`);
        for (const name of [from, to]) stamp.run(Date.now(), name, cursorOf(db, name));
        // The old alias's queue opt-out and last sighting carry over.
        db.prepare(
          `UPDATE aliases SET
             queue_off = max(coalesce(queue_off, 0), coalesce((SELECT queue_off FROM aliases WHERE address = ?2), 0)),
             last_seen = max(coalesce(last_seen, 0), coalesce((SELECT last_seen FROM aliases WHERE address = ?2), 0))
           WHERE address = ?1`,
        ).run(to, from);
      }
      for (const [t, c, keyed] of COLUMNS) {
        db.prepare(`UPDATE OR IGNORE ${t} SET ${c} = ?1 WHERE ${c} = ?2`).run(to, from);
        if (keyed) db.prepare(`DELETE FROM ${t} WHERE ${c} = ?`).run(from);
      }
      if (merged) db.prepare(`UPDATE cursors SET last_seen_id = ? WHERE reader = ?`).run(lowest, to);
      // A 1.x process still running as `from` writes it again, and every open
      // merges the new rows: one notice per name, a row per move.
      const again = !!db.prepare(
        `SELECT 1 FROM audit_log WHERE action = 'alias.case_moved' AND target = ? AND json_extract(detail, '$.from') = ? LIMIT 1`,
      ).get(to, from);
      writeCoreAudit(db, "alias.case_moved", "grayboard", to, { from, merged });
      db.exec("RELEASE handle_case");
      afterCommit(db, () => { wakes.set(db, [...(wakes.get(db) ?? []), to]); });
      if (again) continue;
    } catch (e) {
      db.exec("ROLLBACK TO handle_case");
      db.exec("RELEASE handle_case");
      collision(db, from, to, String(e), notice);
      continue;
    }
    const line = merged
      ? `[grayboard] handle "${from}" merged into "${to}" (handles are lowercase since v2.0.0); its messages, claims and subscriptions moved with it (#216)`
      : `[grayboard] handle "${from}" is now "${to}" (handles are lowercase since v2.0.0); its messages, claims and subscriptions moved with it (#216)`;
    afterCommit(db, () => notice(line));
  }
}

// A collision is reported once, while its audit row lasts (retention prunes
// it, and the next open reports it again).
function collision(db: Database, from: string, to: string, reason: string, notice: CaseNotice): void {
  const seen = db.prepare(
    `SELECT 1 FROM audit_log WHERE action = 'alias.case_collision' AND target = ? AND json_extract(detail, '$.from') = ? LIMIT 1`,
  ).get(to, from);
  if (seen) return;
  writeCoreAudit(db, "alias.case_collision", "grayboard", to, { from, reason });
  const line = `[grayboard] handle "${from}" can't become "${to}" (handles are lowercase since v2.0.0): ${reason}. Its messages and claims stay under "${from}", which no session can bind (#216)`;
  afterCommit(db, () => notice(line));
}
