// The server's access_log rows of `action`, oldest first (by id, not `at`: rows written in one
// millisecond, or under a test clock that stands still, share an `at`), details parsed (#479, #277).
export type AccessAudit = { at: number; actor: string | null; target: string | null; detail: Record<string, unknown> };
export const accessAudits = (db: { query(sql: string): { all(...args: string[]): unknown[] } }, action: string): AccessAudit[] =>
  (db.query("SELECT at, actor, target, detail FROM access_log WHERE action = ? ORDER BY id").all(action) as { at: number; actor: string | null; target: string | null; detail: string }[])
    .map((r) => ({ at: r.at, actor: r.actor, target: r.target, detail: JSON.parse(r.detail) }));
