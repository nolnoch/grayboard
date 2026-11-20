import { isSqliteDb } from "./hosted_rows.ts";
import { type RepoLike, rows } from "./repo_sql.ts";

type SqliteDb = { query(sql: string): { all(...args: string[]): unknown[] } };

// The server's access_log rows of `action`, oldest first (by id, not `at`: rows written in one
// millisecond, or under a test clock that stands still, share an `at`), details parsed (#479, #277).
// Given the server (or its Repo), on either backend (#807 P3 C11c); given a SQLite connection, read there
// synchronously (callers not yet ported).
export type AccessAudit = { at: number; actor: string | null; target: string | null; detail: Record<string, unknown> };
type AuditRow = { at: number; actor: string | null; target: string | null; detail: string };
const AUDITS = "SELECT at, actor, target, detail FROM access_log WHERE action = ? ORDER BY id";
const parsed = (rs: AuditRow[]): AccessAudit[] => rs.map((r) => ({ at: r.at, actor: r.actor, target: r.target, detail: JSON.parse(r.detail) }));

export function accessAudits(on: SqliteDb, action: string): AccessAudit[];
export function accessAudits(on: RepoLike, action: string): Promise<AccessAudit[]>;
export function accessAudits(on: SqliteDb | RepoLike, action: string): AccessAudit[] | Promise<AccessAudit[]> {
  if (isSqliteDb(on)) return parsed(on.query(AUDITS).all(action) as AuditRow[]);
  return rows<AuditRow>(on, AUDITS, action).then(parsed);
}

// Where each of the server's access_log rows of `action` came from, oldest first (security audit F-19).
export type AuditOrigin = { ip: string | null; ua: string | null; client_id: string | null };
const ORIGINS = "SELECT ip, ua, client_id FROM access_log WHERE action = ? ORDER BY id";

export function auditOrigins(on: SqliteDb, action: string): AuditOrigin[];
export function auditOrigins(on: RepoLike, action: string): Promise<AuditOrigin[]>;
export function auditOrigins(on: SqliteDb | RepoLike, action: string): AuditOrigin[] | Promise<AuditOrigin[]> {
  if (isSqliteDb(on)) return on.query(ORIGINS).all(action) as AuditOrigin[];
  return rows<AuditOrigin>(on, ORIGINS, action);
}
