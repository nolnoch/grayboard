// An access_log row on Postgres (#807 P3 C3/C4): the insert every Postgres store group writes its audit rows with,
// stamped with the request's origin as db.ts insertAudit stamps SQLite's. C7 ports the rest of the audit store.
// Runtime imports stay off bun:sqlite and db.ts (pg/isolation.test.ts).
import { requestOrigin } from "../../request_context.ts";
import type { AuditDetail } from "./sql.ts";
import type { PgSql } from "./tx.ts";

// `detail` is the object itself: a string bound to jsonb is stored as a JSON string, which every `detail->>` read
// misses, and a top-level scalar fails or stores SQL NULL (AuditDetail refuses all three).
export async function insertAudit(sql: PgSql, at: number, actor: string | null, action: string, target: string | null, detail: AuditDetail): Promise<void> {
  const o = requestOrigin();
  await sql`INSERT INTO access_log (at, actor, action, target, detail, ip, ua, client_id)
    VALUES (${at}, ${actor}, ${action}, ${target}, ${detail}, ${o?.ip ?? null}, ${o?.ua ?? null}, ${o?.client_id ?? null})`;
}
