// The admin dashboard's reads (#1651, docs/future/admin-dashboard.md D3, D6): keyset-paginated pages over users, teams,
// claims, threads, messages and the access log, which Repo (db.ts) composes and the Postgres store (pg/admin.ts)
// implements. Type-only imports, so a module under pg/ may import it (pg/isolation.test.ts).
//
// Every read is an indexed range bounded by `limit` (clamped to 1..ADMIN_PAGE_MAX), or by one thread's or one claim
// key's history where its comment says so: no COUNT, no GROUP BY, no read whose cost grows with the fleet. Each names its index. Nothing here writes: no read point, delivery or cursor
// moves. Only `thread` returns content (a post's body); the list rows are body-free, so a route can't serve content
// without the audited read (D5). Reads the dashboard also uses that other groups already have: roles.list,
// services.list, boards.catalogPage, messages.history (a conversation), teams.listMembers, aliases.listForScope and
// the OAuth store's listGrants.
import type { Claim } from "../../core/claims.ts";
import type { Team, User } from "./identity.ts";
import type { Read } from "./tx_base.ts";

export const ADMIN_PAGE_MAX = 100;

// A limit as every read applies it: an integer clamped to 1..ADMIN_PAGE_MAX (a non-finite one is the cap).
export const adminLimit = (limit: number): number =>
  Number.isFinite(limit) ? Math.min(ADMIN_PAGE_MAX, Math.max(1, Math.trunc(limit))) : ADMIN_PAGE_MAX;

// A thread's root, without its body.
export type AdminThread = { id: number; author: string; created_at: number };
// A post of a thread, with its body: content (D5).
export type AdminPost = { id: number; board: string; author: string; body: string; parent_id: number | null; created_at: number };
// A claim event (claim_events), newest first.
export type AdminClaimEvent = {
  id: number; key: string; handle: string; event: string; note: string | null; board: string | null;
  expires_at: number | null; held_by: string | null; at: number;
};
// A direct or team message, without its body.
export type AdminMessage = {
  id: number; sender: string; recipient_type: "user" | "team"; recipient: string; parent_id: number | null;
  created_at: number; delivered_at: number | null; pending: boolean; kind: string | null;
};
// An access_log row with its id and request origin; detail is the row's JSON text, as AuditStore.last returns it.
export type AdminAuditRow = {
  id: number; at: number; actor: string | null; action: string; target: string | null; detail: string | null;
  ip: string | null; ua: string | null; client_id: string | null;
};
// The filters the audit page drives from an index: none (idx_audit_at), an action (idx_access_log_action), an action
// and target (idx_access_log_action_target) or an actor (idx_access_log_actor). Other combinations would filter
// rows the index doesn't order, a scan, so the type doesn't allow them.
export type AuditFilter = { action?: undefined; target?: undefined; actor?: undefined }
  | { action: string; target?: string; actor?: undefined }
  | { actor: string; action?: undefined; target?: undefined };
// The audit page's cursor: the last row's (at, id); the next page is older than it.
export type AuditCursor = { at: number; id: number };

export interface AdminStore {
  // Users and services with ids above `after`, in id order (the users primary key).
  users(r: Read, after: number, limit: number): Promise<User[]>;
  // Teams with ids above `after`, in id order (the teams primary key).
  teams(r: Read, after: number, limit: number): Promise<Team[]>;
  // Claims live at `now` with keys after `after` ("" for the first), in byte order (the claims primary key; Postgres
  // COLLATE "C"). A lapsed row the expiry sweep hasn't removed yet is skipped.
  claims(r: Read, after: string, now: number, limit: number): Promise<Claim[]>;
  // The key's events with ids below `before` (0 for the newest), newest first (idx_claim_events_key; Postgres sorts
  // the key's rows by id, bounded by its history, which retention prunes).
  claimEvents(r: Read, key: string, before: number, limit: number): Promise<AdminClaimEvent[]>;
  // The board's thread roots with ids below `before` (0 for the newest), newest first
  // (idx_posts_board_roots, partial on parent_id IS NULL).
  threads(r: Read, board: string, before: number, limit: number): Promise<AdminThread[]>;
  // The thread under `root`, root included, with ids above `after` (0 for the first), in id order:
  // one recursive walk on idx_posts_parent, bounded by the thread's size. Empty when the root is gone.
  thread(r: Read, root: number, after: number, limit: number): Promise<AdminPost[]>;
  // Messages with ids below `before` (0 for the newest), newest first (the messages primary key).
  messages(r: Read, before: number, limit: number): Promise<AdminMessage[]>;
  // access_log rows older than `before` by (at, id) (null for the newest), newest first, under `filter`.
  audit(r: Read, filter: AuditFilter, before: AuditCursor | null, limit: number): Promise<AdminAuditRow[]>;
}
