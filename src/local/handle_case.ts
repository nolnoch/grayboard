// #216: a 1.x bus could store a mixed-case handle (`Gray`): BUS_IDENTITY and
// the repo pin were taken literally until #181 (v2.0.0), and the open's seed
// (open.ts) made each such handle an alias. Since #181 a session asking for
// `Gray` binds `gray`, so the old name's DMs, claims, cursors and
// subscriptions sat where no session could reach them. This step moves them
// to the lowercase name where that name is free, and leaves a trail either way.
//
// Data only (schema changes stay additive). It runs inside the open's schema
// transaction, after the seed, on every open: a 1.x grayboard still sharing
// the file can add a mixed-case handle again, which then lands as a collision.
// One name moves under its own savepoint, and any failure rolls it back and
// counts as a collision, so the step never fails an open.
import type { Database } from "bun:sqlite";

import { normalizeIdentityName } from "../shared/addressing.ts";
import { writeCoreAudit } from "../core/audit.ts";

// Every column a 1.x bus wrote a handle to, plus the aliases its seed copied
// them into and the v2 tables keyed by a name. Bodies, claim keys and notes
// are text, not addresses, and stay as written.
const COLUMNS: readonly (readonly [string, string])[] = [
  ["handles", "name"], ["aliases", "address"], ["aliases", "name"], ["alias_holds", "address"],
  ["boards", "created_by"], ["boards", "archived_by"], ["posts", "author"],
  ["subscriptions", "handle"], ["outbox", "handle"], ["thread_mutes", "handle"],
  ["claims", "holder"], ["claim_watches", "handle"], ["claim_events", "handle"], ["claim_events", "held_by"],
  ["attachments", "uploader"], ["messages", "sender"], ["messages", "recipient"],
  ["cursors", "reader"], ["dm_acks", "reader"],
];
// A row under the lowercase name in any of these makes it taken: their keys
// include the name, so merging two names' rows would collide or pick a winner.
const KEYED: readonly (readonly [string, string])[] = [
  ["handles", "name"], ["aliases", "address"], ["alias_holds", "address"], ["bindings", "name"],
  ["subscriptions", "handle"], ["outbox", "handle"], ["thread_mutes", "handle"],
  ["claim_watches", "handle"], ["cursors", "reader"], ["dm_acks", "reader"],
];

export type CaseNotice = (line: string) => void;

export function lowercaseLegacyHandles(db: Database, notice: CaseNotice = (l) => process.stderr.write(`${l}\n`)): void {
  // Bytewise order, so of `GRAY` and `Gray` the same one wins on every open.
  const names = (db.prepare(
    `SELECT address AS n FROM aliases WHERE scope_ref IS NULL AND address <> lower(address)
     UNION SELECT name FROM handles WHERE name <> lower(name) AND name NOT LIKE '~%'
     ORDER BY n`,
  ).all() as { n: string }[]).map((r) => r.n);
  for (const from of names) {
    // The name a session asking for `from` binds since #181; a name that
    // rule refuses was never silently moved, so it stays.
    const n = normalizeIdentityName(from);
    if (!n.ok || n.name === from) continue;
    const to = n.name;
    if (KEYED.some(([t, c]) => db.prepare(`SELECT 1 FROM ${t} WHERE ${c} = ? LIMIT 1`).get(to))) {
      collision(db, from, to, `${to} already exists`, notice);
      continue;
    }
    db.exec("SAVEPOINT handle_case");
    try {
      for (const [t, c] of COLUMNS) db.prepare(`UPDATE ${t} SET ${c} = ?1 WHERE ${c} = ?2`).run(to, from);
      writeCoreAudit(db, "alias.case_moved", "grayboard", to, { from });
      db.exec("RELEASE handle_case");
    } catch (e) {
      db.exec("ROLLBACK TO handle_case");
      db.exec("RELEASE handle_case");
      collision(db, from, to, String(e), notice);
      continue;
    }
    notice(`[grayboard] handle "${from}" is now "${to}" (handles are lowercase since v2.0.0); its messages, claims and subscriptions moved with it (#216)`);
  }
}

// A collision is reported once: its audit row is the record that it was.
function collision(db: Database, from: string, to: string, reason: string, notice: CaseNotice): void {
  const seen = db.prepare(
    `SELECT 1 FROM audit_log WHERE action = 'alias.case_collision' AND target = ? AND json_extract(detail, '$.from') = ? LIMIT 1`,
  ).get(to, from);
  if (seen) return;
  writeCoreAudit(db, "alias.case_collision", "grayboard", to, { from, reason });
  notice(`[grayboard] handle "${from}" can't become "${to}" (handles are lowercase since v2.0.0): ${reason}. Its messages and claims stay under "${from}", which no session can bind (#216)`);
}
