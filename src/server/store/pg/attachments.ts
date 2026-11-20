// The attachments store on Postgres, upload side (#807 P3 C10c, docs/future/postgres-server.md D3, D6):
// store/attachments.ts's AttachmentsStore, each method on its caller's handle through pgOf. The SQLite store (db.ts
// makeRepo's attachments, over core/attachments.ts's SQL) is the reference; what differs, and why:
// - insertUpload takes the principal's quota lock first: pg_advisory_xact_lock(ATTACH_QUOTA_LOCK,
//   hashtext(principal)), then prunes, counts and inserts as core does. Two uploads by one principal that each fit
//   and together don't would otherwise both count the other's bytes as absent and both insert. Advisory rather than a
//   row lock: the quota's key is the uploader's principal string, which isn't always a users row (a service), and
//   `users … FOR UPDATE` would block every insert whose foreign key names the user. Never taken inside a savepoint
//   that rolls back: ROLLBACK TO frees it. An upload with no quota (no principal) takes no lock.
// - The quota's sum counts each blob once (MAX(size) per sha256), and one read answers both the sum and whether the
//   principal already holds the blob, whose bytes then add nothing.
// - The catalog entry is insert-if-absent (ON CONFLICT (sha256) DO NOTHING): a second upload of a blob, committed or
//   not, waits on the first's entry and inserts nothing, where a plain insert fails 23505 and aborts the body.
// - pruneUnbound deletes `WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`: a row a send holds locked to bind it
//   (pg/attachment_rows.ts lockUnsent) is skipped, so an upload's prune never waits on a send (and can't deadlock
//   against a bind's id-ordered locks); the next prune takes it if the send didn't bind it.
// - dropBlobEntry is core's conditional DELETE … NOT EXISTS, in a savepoint. Racing an upload whose attachment row
//   names the blob but hasn't committed, the delete waits on that row's foreign-key lock and, once it commits, fails
//   the foreign key (23503 attachments_sha256_fkey): its NOT EXISTS read the snapshot from before the commit. The
//   savepoint keeps that from aborting the sweep's transaction, and it answers 0, as a named blob does.
// - unsentDigests restores call order in JS over an `= ANY` read, as core's does; dropUnsent is core's conditional
//   DELETE … RETURNING (it waits on a send's bind lock, then re-checks and leaves a bound row), ordered by id.
//
// Runtime imports stay off bun:sqlite, db.ts and core/attachments.ts (pg/isolation.test.ts): the SQL is restated,
// and the unsent clause is pg/attachment_rows.ts's.
import { TooLargeError } from "../../../core/errors.ts";
import { UNBOUND_TTL_MS, formatSize } from "../../../shared/attachments.ts";
import type { AttachmentRow, AttachmentsStore } from "../attachments.ts";
import { refused, unsent } from "./attachment_rows.ts";
import { foreignKeyViolation } from "./errors.ts";
import { int8, int8OrNull } from "./sql.ts";
import { pgOf, type PgSql } from "./tx.ts";

// pg_advisory_xact_lock(class, key) for the attachment quota (c10-scope §7 Q2): the two-int4 form beside
// ALIAS_CAP_LOCK, keyed by hashtext(principal). A collision only serializes two principals' uploads.
export const ATTACH_QUOTA_LOCK = 0x67626171; // "gbaq"

// The upload's catalog foreign key: what a drop racing an upload of its blob fails on.
export const ATTACHMENT_BLOB_CONSTRAINT = "attachments_sha256_fkey";

type Row = Record<string, unknown>;
const toRow = (r: Row): AttachmentRow => ({
  id: int8(r.id), sha256: r.sha256 as string, filename: r.filename as string, type: r.type as string, size: int8(r.size),
  uploader: r.uploader as string, uploader_principal: r.uploader_principal as string | null,
  message_id: int8OrNull(r.message_id), post_id: int8OrNull(r.post_id), created_at: int8(r.created_at),
});
const cols = (sql: PgSql) => sql.fragment`id, sha256, filename, type, size, uploader, uploader_principal, message_id, post_id, created_at`;

// core pruneUnbound, skipping rows a send holds.
async function prune(sql: PgSql, olderThanMs: number): Promise<number> {
  const gone: Row[] = await sql`DELETE FROM attachments WHERE id IN (
      SELECT id FROM attachments WHERE message_id IS NULL AND post_id IS NULL AND created_at < ${olderThanMs}
      FOR UPDATE SKIP LOCKED)
    RETURNING id`;
  return gone.length;
}

// core uploadedBytes and heldBlob in one read: the bytes `principal` stores (only unbound uploads, if `unbound`), each
// distinct blob once, and whether `sha256` is among them.
async function usage(sql: PgSql, principal: string, sha256: string, unbound: boolean): Promise<{ bytes: number; held: boolean }> {
  const only = unbound ? sql.fragment`AND message_id IS NULL AND post_id IS NULL` : sql.fragment``;
  const [r]: Row[] = await sql`SELECT COALESCE(SUM(size), 0)::int8 AS bytes, COALESCE(bool_or(sha256 = ${sha256}), false) AS held
    FROM (SELECT sha256, MAX(size) AS size FROM attachments WHERE uploader_principal = ${principal} ${only} GROUP BY sha256) per_blob`;
  return { bytes: int8(r.bytes), held: r.held === true };
}

export function makePgAttachments(): AttachmentsStore {
  return {
    async get(r, id) {
      const sql = pgOf(r);
      const [row]: Row[] = await sql`SELECT ${cols(sql)} FROM attachments WHERE id = ${id}`;
      return row ? toRow(row) : undefined;
    },
    async unsentDigests(r, ids, from) {
      if (ids.length === 0) return [];
      const sql = pgOf(r);
      const rows: Row[] = await sql`SELECT id, sha256 FROM attachments WHERE ${unsent(sql, ids, from)}`;
      const by = new Map(rows.map(x => [int8(x.id), x.sha256 as string]));
      return ids.map(id => {
        const sha = by.get(id);
        if (sha === undefined) throw refused(id);
        return sha;
      });
    },
    async dropUnsent(tx, ids, from) {
      if (ids.length === 0) return [];
      const sql = pgOf(tx);
      const rows: Row[] = await sql`WITH gone AS (DELETE FROM attachments WHERE ${unsent(sql, ids, from)} RETURNING ${cols(sql)})
        SELECT * FROM gone ORDER BY id`;
      return rows.map(toRow);
    },
    pruneUnbound: (tx, olderThanMs) => prune(pgOf(tx), olderThanMs),
    async insertUpload(tx, u) {
      const sql = pgOf(tx);
      const q = u.quota;
      if (q) await sql`SELECT pg_advisory_xact_lock(${ATTACH_QUOTA_LOCK}::int4, hashtext(${q.principal}))`;
      const pruned = (await prune(sql, u.now - UNBOUND_TTL_MS)) > 0;
      if (q) {
        // Bytes the principal already has under this blob add nothing.
        const unsentNow = await usage(sql, q.principal, u.sha256, true);
        if (unsentNow.bytes + (unsentNow.held ? 0 : u.size) > q.unsent) {
          throw new TooLargeError(`your unsent uploads would exceed ${formatSize(q.unsent)}; send or wait for them to expire`);
        }
        const stored = await usage(sql, q.principal, u.sha256, false);
        if (stored.bytes + (stored.held ? 0 : u.size) > q.stored) {
          throw new TooLargeError(`your stored attachments would exceed ${formatSize(q.stored)}; they're freed as their messages and posts age out`);
        }
      }
      await sql`INSERT INTO attachment_blobs (sha256, size, created_at) VALUES (${u.sha256}, ${u.size}, ${u.now}) ON CONFLICT (sha256) DO NOTHING`;
      const [row]: Row[] = await sql`INSERT INTO attachments (sha256, filename, type, size, uploader, uploader_principal, created_at)
        VALUES (${u.sha256}, ${u.filename}, ${u.type}, ${u.size}, ${u.uploader}, ${q?.principal ?? null}, ${u.now}) RETURNING ${cols(sql)}`;
      return { row: toRow(row), pruned };
    },
    async remove(tx, id) {
      await pgOf(tx)`DELETE FROM attachments WHERE id = ${id}`;
    },
    async unnamedBlobs(r) {
      const rows: Row[] = await pgOf(r)`SELECT sha256 FROM attachment_blobs b
        WHERE NOT EXISTS (SELECT 1 FROM attachments a WHERE a.sha256 = b.sha256) ORDER BY sha256`;
      return rows.map(x => x.sha256 as string);
    },
    async named(r, sha256) {
      return (await pgOf(r)`SELECT 1 FROM attachments WHERE sha256 = ${sha256} LIMIT 1`).length > 0;
    },
    async dropBlobEntry(tx, sha256) {
      try {
        return await tx.savepoint(async sp => (await pgOf(sp)`DELETE FROM attachment_blobs b WHERE sha256 = ${sha256}
          AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.sha256 = b.sha256) RETURNING sha256`).length);
      } catch (e) {
        if (foreignKeyViolation(e) === ATTACHMENT_BLOB_CONSTRAINT) return 0;
        throw e;
      }
    },
  };
}
