// The audit log on Postgres (#807 P3 C7, docs/future/postgres-server.md D3, D6, D8 A6h): store/audit.ts's AuditStore,
// each method on its caller's handle through pgOf. The SQLite store (db.ts makeRepo's audit, over db.ts insertAudit and
// ACCESS_LOG_LAST_SQL) is the reference; what differs, and why:
// - write stays synchronous (A6h): it builds the insert through pgOf, which checks the Tx and sends the statement at
//   once on the Tx's connection, and returns without awaiting it. The database then orders it: it lands in program
//   order among the body's other statements (the store-direct audit rows too), inside the transaction and any open
//   savepoint, and `last` on the Tx (a later statement on that connection) sees it. A failing insert aborts the
//   transaction, so the body's next statement or its COMMIT fails and the write rejects TxAborted (pg/tx.ts), whose
//   cause is that later failure: 25P02 from the next statement, or ERR_POSTGRES_COMMIT_ROLLED_BACK when the refused
//   insert was the body's last. The insert's own error (its SQLSTATE) would be lost, so its rejection is caught and
//   logged here (class, code and SQLSTATE only: a Postgres error's text quotes row values). The catch also keeps the
//   rejection handled, should Bun start reporting an executed query's unhandled one (Bun 1.4.4 doesn't). A Read
//   refuses synchronously (AUDIT_WRITE_ON_READ): on the pool the insert would fail 25006 after write returned.
// - access_log.detail is jsonb: write parses writeAudit's JSON text and binds the object (bound as text it would be a
//   JSON string scalar), and last selects detail::text, so AccessLogRow.detail stays JSON text (spacing and key order
//   are jsonb's). Strings are made safe first (jsonSafe, store/json_safe.ts): jsonb refuses NUL (22P05) and a lone
//   surrogate (22P02), and text refuses NUL (22021); refusing would fail the audited action.
// - lock is pg_advisory_xact_lock(AUDIT_DEDUP_LOCK, hashtext(action:target)), held to the transaction's end (C7
//   decision 5): owedBridgeNotice and the Slack bridge's stop take it before reading the last bridge.notified, so two
//   binds can't both deliver one notice. Never inside a savepoint that rolls back: ROLLBACK TO frees it.
// - `at` is int8 (int8()); last orders by (at, id), newest first: Postgres breaks a tie in `at` by heap order otherwise.
//
// Runtime imports stay off bun:sqlite and db.ts (pg/isolation.test.ts).
import { SQL } from "bun";
import { errorDiagnostic } from "../../diagnostics.ts";
import { requestOrigin } from "../../request_context.ts";
import { AUDIT_WRITE_ON_READ, type AccessLogRow, type AuditStore } from "../audit.ts";
import type { EndAuditSink } from "../session_end.ts";
import { insertAudit } from "./audit_row.ts";
import { isTx, type Tx } from "../tx_base.ts";
import { jsonSafe, textSafeOrNull } from "../json_safe.ts";
import { int8, type AuditDetail } from "./sql.ts";
import { pgOf } from "./tx.ts";

// pg_advisory_xact_lock(class, key) for a dedup read and the write it decides, per (action, target): the two-int4 form
// beside ALIAS_CAP_LOCK and the OAuth classes, keyed by hashtext(`${action}:${target}`). A collision only serializes
// two targets' notices.
export const AUDIT_DEDUP_LOCK = 0x67626164; // "gbad"

// The newest row for (action, target), by (at, id): idx_access_log_action_target serves it. Exported for its pin
// (pg/audit.pg.test.ts): no serial row tells `at` alone from (at, id) on Postgres.
export const PG_ACCESS_LOG_LAST_SQL = "SELECT at, actor, action, target, detail::text AS detail FROM access_log WHERE action = $1 AND target = $2 ORDER BY at DESC, id DESC LIMIT 1";

// A failed eager insert's own rejection: logged without its text, which can quote the row.
function logged(error: unknown): void {
  console.error("[grayboard] audit row insert failed:", error instanceof SQL.SQLError ? errorDiagnostic(error) : error);
}

export function makePgAudit(): AuditStore {
  return {
    write(tx, row) {
      // pgOf throws synchronously on a settled Tx, or a parent whose savepoint is open, before anything is sent; it
      // takes a Read too, whose insert would fail 25006 on the read-only pool after write returned.
      const sql = pgOf(tx);
      if (!isTx(tx)) throw new Error(AUDIT_WRITE_ON_READ);
      const o = requestOrigin();
      const detail = row.detail === null ? null : jsonSafe(JSON.parse(row.detail) as unknown);
      sql`INSERT INTO access_log (at, actor, action, target, detail, ip, ua, client_id)
        VALUES (${row.at}, ${textSafeOrNull(row.actor)}, ${row.action}, ${textSafeOrNull(row.target)}, ${detail},
          ${o?.ip ?? null}, ${o?.ua ?? null}, ${o?.client_id ?? null})`.catch(logged);
    },
    async last(r, action, target) {
      const [row] = await pgOf(r).unsafe(PG_ACCESS_LOG_LAST_SQL, [action, target]);
      return row ? {
        at: int8(row.at), actor: row.actor as string | null, action: row.action as string,
        target: row.target as string | null, detail: row.detail as string | null,
      } : undefined;
    },
    async lock(tx, action, target) {
      await pgOf(tx)`SELECT pg_advisory_xact_lock(${AUDIT_DEDUP_LOCK}::int4, hashtext(${`${action}:${target}`}))`;
    },
    async prune(tx, olderThanMs) {
      await pgOf(tx)`DELETE FROM access_log WHERE at < ${olderThanMs}`;
    },
  };
}

// A session end's id.ended row on Postgres (an EndAuditSink, #807 P3 C10 Q3): awaited, at `now` on tx, as db.ts
// hostedEnds writes it to SQLite's access_log; what the hosted store hands its session-end port (pg/hosted.ts). A
// missing detail binds SQL NULL, as SQLite stores it.
export function pgCoreAuditSink(tx: Tx, now: number): EndAuditSink {
  return (action, actor, target, detail) => insertAudit(pgOf(tx), now, actor, action, target, (detail ?? null) as AuditDetail);
}
