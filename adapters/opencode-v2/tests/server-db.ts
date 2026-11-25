import assert from "node:assert/strict";
import type { Database } from "bun:sqlite";

// Reads of the real server's database (#383), for host.ts and the races it runs, whether the server is
// in this process or its own: a hosted session's row and holds, the access_log audit rows for one action
// (oldest first, detail parsed), and the binding_events `released` rows with their reasons.
export type HostedRow = { session_id: string; root_session_id: string | null; ownership_id: number; bind_gen: number; grant_id: string; lease_deadline: number | null; held: string[]; name: string | null };
// A hosted root's holds are alias_holds rows (#451): the short names, oldest first; the first is the primary.
export function holds(db: Database, id: string): string[] {
  return db.query<{ address: string }, [string]>("SELECT address FROM alias_holds WHERE id = ? ORDER BY bound_at, address").all(id).map(h => h.address.slice(h.address.lastIndexOf("/") + 1));
}
export function hostedRow(db: Database, raw: string): HostedRow | null {
  const r = db.query<Omit<HostedRow, "held" | "name">, [string]>("SELECT session_id, root_session_id, ownership_id, bind_gen, grant_id, lease_deadline FROM hosted_sessions WHERE source_session_id = ?").get(raw);
  if (!r) return null;
  const held = holds(db, r.session_id);
  return { ...r, held, name: held[0] ?? null };
}
export type AuditRow = { id: number; actor: string | null; target: string | null; detail: Record<string, unknown> };
export function audits(db: Database, action: string): AuditRow[] {
  return db.query<{ id: number; actor: string | null; target: string | null; detail: string }, [string]>("SELECT id, actor, target, detail FROM access_log WHERE action = ? ORDER BY id").all(action)
    .map(r => ({ id: r.id, actor: r.actor, target: r.target, detail: JSON.parse(r.detail) }));
}
export function releases(db: Database): { session_id: string; name: string; reason: string }[] {
  return db.query<{ session_id: string; name: string; reason: string }, []>("SELECT session_id, name, detail AS reason FROM binding_events WHERE event = 'released' ORDER BY id").all();
}
// The one hosted.write row a native call wrote (#226 §7): the user's actor, the session that made the call
// (a child's own ID), its root, the root's grant and the OpenCode client.
export function assertWrote(db: Database, tool: string, session: HostedRow, root: HostedRow, client: string) {
  const rows = audits(db, "hosted.write").filter(w => w.detail.tool === tool && w.detail.session === session.session_id);
  assert.equal(rows.length, 1, `one hosted.write row for ${tool} from ${session.session_id}`);
  assert.deepEqual(rows[0], { ...rows[0]!, actor: "you@example.com", target: session.session_id, detail: { ...rows[0]!.detail, tool, session: session.session_id, root: root.session_id, grant: root.grant_id, client_id: client } });
}
