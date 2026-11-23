// The admin dashboard's reads on Postgres (#1651): store/admin.ts's AdminStore, each on its caller's handle through
// pgOf. The SQLite store (store/admin_sqlite.ts) is the reference; what differs, and why:
// - A Postgres index doesn't end in a row id, so the audit page's (at, id) order sorts ties on `at` by id after the
//   index range, and claimEvents sorts one key's rows by id: both bounded (rows sharing a millisecond; one key's
//   history, which retention prunes).
// - The keyset predicate is `at <= $ AND (at < $ OR id < $)`, never a row comparison: `(at, id) < (…)` isn't an index
//   condition on (actor, at), so the scan would start at the newest row on every page.
// - int8 columns arrive as strings (Bun.SQL) and go through the mappers; detail is jsonb, selected as text.
//
// Runtime imports stay off bun:sqlite and db.ts (pg/isolation.test.ts).
import type { Claim } from "../../../core/claims.ts";
import { adminLimit, type AdminAuditRow, type AdminClaimEvent, type AdminMessage, type AdminPost, type AdminStore, type AdminThread } from "../admin.ts";
import { toTeam, toUser, userFrom } from "./identity.ts";
import { int8, int8OrNull } from "./sql.ts";
import { pgOf, type PgSql } from "./tx.ts";

type Row = Record<string, unknown>;
const BIG = Number.MAX_SAFE_INTEGER;
const s = (v: unknown) => v as string;
const sn = (v: unknown) => v as string | null;

const toClaim = (r: Row): Claim => ({
  key: s(r.key), holder: s(r.holder), note: sn(r.note), board: sn(r.board), acquired_at: int8(r.acquired_at), expires_at: int8(r.expires_at),
});
const toEvent = (r: Row): AdminClaimEvent => ({
  id: int8(r.id), key: s(r.key), handle: s(r.handle), event: s(r.event), note: sn(r.note), board: sn(r.board),
  expires_at: int8OrNull(r.expires_at), held_by: sn(r.held_by), at: int8(r.at),
});
const toThread = (r: Row): AdminThread => ({ id: int8(r.id), author: s(r.author), created_at: int8(r.created_at) });
const toPost = (r: Row): AdminPost => ({
  id: int8(r.id), board: s(r.board), author: s(r.author), body: s(r.body), parent_id: int8OrNull(r.parent_id), created_at: int8(r.created_at),
});
const toMessage = (r: Row): AdminMessage => ({
  id: int8(r.id), sender: s(r.sender), recipient_type: r.recipient_type as AdminMessage["recipient_type"], recipient: s(r.recipient),
  parent_id: int8OrNull(r.parent_id), created_at: int8(r.created_at), delivered_at: int8OrNull(r.delivered_at),
  pending: r.pending === true, kind: sn(r.kind),
});
const toAudit = (r: Row): AdminAuditRow => ({
  id: int8(r.id), at: int8(r.at), actor: sn(r.actor), action: s(r.action), target: sn(r.target), detail: sn(r.detail),
  ip: sn(r.ip), ua: sn(r.ua), client_id: sn(r.client_id),
});
const auditCols = (sql: PgSql) => sql.fragment`id, at, actor, action, target, detail::text AS detail, ip, ua, client_id`;

export function makePgAdmin(): AdminStore {
  return {
    async users(r, after, limit) {
      const sql = pgOf(r);
      return (await sql`${userFrom(sql)} WHERE u.id > ${after} ORDER BY u.id LIMIT ${adminLimit(limit)}`).map(toUser);
    },
    async teams(r, after, limit) {
      return (await pgOf(r)`SELECT id, name, created_by, policy, created_at FROM teams WHERE id > ${after} ORDER BY id LIMIT ${adminLimit(limit)}`).map(toTeam);
    },
    async claims(r, after, now, limit) {
      return (await pgOf(r)`SELECT key, holder, note, board, acquired_at, expires_at FROM claims
        WHERE key > ${after} AND expires_at > ${now} ORDER BY key LIMIT ${adminLimit(limit)}`).map(toClaim);
    },
    async claimEvents(r, key, before, limit) {
      return (await pgOf(r)`SELECT id, key, handle, event, note, board, expires_at, held_by, at FROM claim_events
        WHERE key = ${key} AND id < ${before > 0 ? before : BIG} ORDER BY id DESC LIMIT ${adminLimit(limit)}`).map(toEvent);
    },
    async threads(r, board, before, limit) {
      return (await pgOf(r)`SELECT id, author, created_at FROM posts
        WHERE board = ${board} AND parent_id IS NULL AND id < ${before > 0 ? before : BIG}
        ORDER BY id DESC LIMIT ${adminLimit(limit)}`).map(toThread);
    },
    async thread(r, root, after, limit) {
      return (await pgOf(r)`WITH RECURSIVE t(id) AS (SELECT id FROM posts WHERE id = ${root} UNION ALL SELECT p.id FROM posts p JOIN t ON p.parent_id = t.id)
        SELECT p.id, p.board, p.author, p.body, p.parent_id, p.created_at FROM posts p JOIN t ON t.id = p.id
        WHERE p.id > ${after} ORDER BY p.id LIMIT ${adminLimit(limit)}`).map(toPost);
    },
    async messages(r, before, limit) {
      return (await pgOf(r)`SELECT id, sender, recipient_type, recipient, parent_id, created_at, delivered_at, pending, kind FROM messages
        WHERE id < ${before > 0 ? before : BIG} ORDER BY id DESC LIMIT ${adminLimit(limit)}`).map(toMessage);
    },
    async audit(r, filter, before, limit) {
      const sql = pgOf(r);
      const [at, id] = before ? [before.at, before.id] : [BIG, BIG];
      const older = sql.fragment`at <= ${at} AND (at < ${at} OR id < ${id})`;
      const where = filter.actor !== undefined ? sql.fragment`actor = ${filter.actor} AND`
        : filter.action !== undefined && filter.target !== undefined ? sql.fragment`action = ${filter.action} AND target = ${filter.target} AND`
        : filter.action !== undefined ? sql.fragment`action = ${filter.action} AND`
        : sql.fragment``;
      return (await sql`SELECT ${auditCols(sql)} FROM access_log WHERE ${where} ${older}
        ORDER BY at DESC, id DESC LIMIT ${adminLimit(limit)}`).map(toAudit);
    },
  };
}
