// Every hosted_sessions row, parked children included (#584): `repo.hosted.all()` leaves parked children out, so a
// deletion assert on it would also pass with a parked row left behind.
export const hostedRowCount = (db: { query(sql: string): { get(): unknown } }) =>
  (db.query("SELECT count(*) AS n FROM hosted_sessions").get() as { n: number }).n;

// The server's access_log rows of `action`, oldest first, details parsed (#479).
export type AccessAudit = { actor: string | null; target: string | null; detail: Record<string, unknown> };
export const accessAudits = (db: { query(sql: string): { all(...args: string[]): unknown[] } }, action: string): AccessAudit[] =>
  (db.query("SELECT actor, target, detail FROM access_log WHERE action = ? ORDER BY id").all(action) as { actor: string | null; target: string | null; detail: string }[])
    .map((r) => ({ actor: r.actor, target: r.target, detail: JSON.parse(r.detail) }));
