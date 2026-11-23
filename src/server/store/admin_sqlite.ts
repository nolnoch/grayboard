// The admin dashboard's reads on SQLite (#1651): store/admin.ts's AdminStore, the reference the Postgres store
// (pg/admin.ts) follows. Each read runs on its caller's handle through sqliteOf. The indexes are db.ts adminIndexes'
// and core/schema.ts's; a SQLite index ends in the rowid, so (key) orders a key's rows by id and (actor, at) breaks a
// tie on at by id with no sort. INDEXED BY makes a missing or unusable index an error rather than a scan, and
// admin_plan.test.ts asserts each statement's plan sorts nothing.
import type { Claim } from "../../core/claims.ts";
import { adminLimit, type AdminAuditRow, type AdminClaimEvent, type AdminMessage, type AdminPost, type AdminStore, type AdminThread } from "./admin.ts";
import type { Team, User } from "./identity.ts";
import { sqliteOf } from "./tx.ts";

// The keyset over (at, id), newest first: `at <= ?` is the index's range, the OR breaks a tie on at by id.
const OLDER = "at <= ? AND (at < ? OR id < ?) ORDER BY at DESC, id DESC LIMIT ?";
const AUDIT = "SELECT id, at, actor, action, target, detail, ip, ua, client_id FROM access_log";
const BIG = Number.MAX_SAFE_INTEGER;

// What follows db.ts USER_SQL in the users read; admin_plan.test.ts explains the two joined.
export const USERS_PAGE = "WHERE u.id > ? ORDER BY u.id LIMIT ?";

// Every statement but users', by read: what admin_plan.test.ts explains.
export const ADMIN_SQL = {
  teams: "SELECT id, name, created_by, policy, created_at FROM teams WHERE id > ? ORDER BY id LIMIT ?",
  claims: "SELECT key, holder, note, board, acquired_at, expires_at FROM claims WHERE key > ? AND expires_at > ? ORDER BY key LIMIT ?",
  claimEvents: `SELECT id, key, handle, event, note, board, expires_at, held_by, at FROM claim_events INDEXED BY idx_claim_events_key
    WHERE key = ? AND id < ? ORDER BY id DESC LIMIT ?`,
  threads: `SELECT id, author, created_at FROM posts INDEXED BY idx_posts_board_roots
    WHERE board = ? AND parent_id IS NULL AND id < ? ORDER BY id DESC LIMIT ?`,
  thread: `WITH RECURSIVE t(id) AS (SELECT id FROM posts WHERE id = ? UNION ALL SELECT p.id FROM posts p JOIN t ON p.parent_id = t.id)
    SELECT p.id, p.board, p.author, p.body, p.parent_id, p.created_at FROM posts p JOIN t ON t.id = p.id
    WHERE p.id > ? ORDER BY p.id LIMIT ?`,
  messages: `SELECT id, sender, recipient_type, recipient, parent_id, created_at, delivered_at, pending, kind FROM messages
    WHERE id < ? ORDER BY id DESC LIMIT ?`,
  auditAll: `${AUDIT} INDEXED BY idx_audit_at WHERE ${OLDER}`,
  auditActor: `${AUDIT} INDEXED BY idx_access_log_actor WHERE actor = ? AND ${OLDER}`,
  auditAction: `${AUDIT} INDEXED BY idx_access_log_action WHERE action = ? AND ${OLDER}`,
  auditActionTarget: `${AUDIT} INDEXED BY idx_access_log_action_target WHERE action = ? AND target = ? AND ${OLDER}`,
} as const;

type P = (string | number)[];

// userSql: db.ts USER_SQL (a user row with its kind), passed in so this module needn't import db.ts, which imports it.
export function makeSqliteAdmin(userSql: string): AdminStore {
  return {
    async users(r, after, limit) {
      return sqliteOf(r).query<User, P>(`${userSql} ${USERS_PAGE}`).all(after, adminLimit(limit));
    },
    async teams(r, after, limit) {
      return sqliteOf(r).query<Team, P>(ADMIN_SQL.teams).all(after, adminLimit(limit));
    },
    async claims(r, after, now, limit) {
      return sqliteOf(r).query<Claim, P>(ADMIN_SQL.claims).all(after, now, adminLimit(limit));
    },
    async claimEvents(r, key, before, limit) {
      return sqliteOf(r).query<AdminClaimEvent, P>(ADMIN_SQL.claimEvents).all(key, before > 0 ? before : BIG, adminLimit(limit));
    },
    async threads(r, board, before, limit) {
      return sqliteOf(r).query<AdminThread, P>(ADMIN_SQL.threads).all(board, before > 0 ? before : BIG, adminLimit(limit));
    },
    async thread(r, root, after, limit) {
      return sqliteOf(r).query<AdminPost, P>(ADMIN_SQL.thread).all(root, after, adminLimit(limit));
    },
    async messages(r, before, limit) {
      return sqliteOf(r).query<Omit<AdminMessage, "pending"> & { pending: number }, P>(ADMIN_SQL.messages)
        .all(before > 0 ? before : BIG, adminLimit(limit)).map(m => ({ ...m, pending: m.pending === 1 }));
    },
    async audit(r, filter, before, limit) {
      const [at, id] = before ? [before.at, before.id] : [BIG, BIG];
      const page = [at, at, id, adminLimit(limit)];
      const db = sqliteOf(r);
      if (filter.actor !== undefined) return db.query<AdminAuditRow, P>(ADMIN_SQL.auditActor).all(filter.actor, ...page);
      if (filter.action !== undefined && filter.target !== undefined) {
        return db.query<AdminAuditRow, P>(ADMIN_SQL.auditActionTarget).all(filter.action, filter.target, ...page);
      }
      if (filter.action !== undefined) return db.query<AdminAuditRow, P>(ADMIN_SQL.auditAction).all(filter.action, ...page);
      return db.query<AdminAuditRow, P>(ADMIN_SQL.auditAll).all(...page);
    },
  };
}
