// Attachment rows on Postgres (#807 P3 C5 decision 8, docs/future/postgres-server.md D3, D6): the bind, read and drop
// of uploads owned by a message or a post, which core/attachments.ts (bindAttachments, withAttachments,
// dropAttachments) does for SQLite. pg/messages.ts uses the message side; C10c adds the post side and the per-user
// quota here. What differs from core, and why:
// - The bind locks first. lockUnsent reads the unsent rows FOR UPDATE, by id, and the caller refuses and tallies
//   before it writes anything, then inserts its owner and binds. Two sends binding one upload: the second waits on the
//   first's row lock, re-checks `message_id IS NULL` on the bound version, gets no row and refuses before its insert,
//   so no savepoint is needed and a caller that catches the refusal and commits keeps nothing. ORDER BY id is the lock
//   order: two sends with overlapping sets can't deadlock.
// - The uploader's user is `$n::text`: a parameter used only in `$n IS NULL OR col = $n` has no type Postgres can
//   infer, and fails 42P18 uncast (D6).
//
// Runtime imports stay off bun:sqlite, db.ts and core/attachments.ts (pg/isolation.test.ts): the SQL is restated.
import type { Uploader } from "../../../core/attachments.ts";
import { CoreError } from "../../../core/errors.ts";
import { SizeTally, type AttachmentInfo, type AttachmentLimits } from "../../../shared/attachments.ts";
import { int8 } from "./sql.ts";
import type { PgFragment, PgSql } from "./tx.ts";

export type AttachmentOwner = "message" | "post";

type Row = Record<string, unknown>;
const info = (r: Row): AttachmentInfo => ({ id: int8(r.id), filename: r.filename as string, type: r.type as string, size: int8(r.size), sha256: r.sha256 as string });
const column = (sql: PgSql, owner: AttachmentOwner) => sql(owner === "message" ? "message_id" : "post_id");
const refused = (id: number) => new CoreError(`attachment ${id} isn't an unsent upload of yours`);

// core's UNSENT clause: `from`'s unsent uploads among ids.
const unsent = (sql: PgSql, ids: number[], from: Uploader) => sql.fragment`id = ANY(${ids}::int8[]) AND uploader = ANY(${from.addresses}::text[])
  AND (${from.principal}::text IS NULL OR uploader_principal = ${from.principal}::text) AND message_id IS NULL AND post_id IS NULL`;

// `from`'s unsent uploads `ids`, locked for the rest of the body, in call order; a missing id (someone else's, unknown,
// or already on a message or post) throws core's CoreError, then the size tally core's bind runs (TooLargeError).
// Writes nothing, so a refusal leaves the caller's transaction usable.
export async function lockUnsent(sql: PgSql, ids: number[], from: Uploader, limits: AttachmentLimits): Promise<AttachmentInfo[]> {
  if (ids.length === 0) return [];
  const rows: Row[] = await sql`SELECT id, filename, type, size, sha256 FROM attachments WHERE ${unsent(sql, ids, from)} ORDER BY id FOR UPDATE`;
  const by = new Map(rows.map(r => [int8(r.id), info(r)]));
  const out = ids.map(id => {
    const r = by.get(id);
    if (!r) throw refused(id);
    return r;
  });
  const tally = new SizeTally(limits, ids.length);
  for (const r of out) tally.add(`attachment ${r.id}`, r.size);
  return out;
}

// Binds the uploads lockUnsent returned to their owner, just written. Conditional on still being unsent, as core's is;
// under lockUnsent's row locks nothing can have taken one, so a lost row is a caller that skipped the lock.
export async function bindLocked(sql: PgSql, owner: AttachmentOwner, ownerId: number, files: AttachmentInfo[], from: Uploader): Promise<void> {
  if (files.length === 0) return;
  const ids = files.map(f => f.id);
  const bound: Row[] = await sql`UPDATE attachments SET ${column(sql, owner)} = ${ownerId} WHERE ${unsent(sql, ids, from)} RETURNING id`;
  const got = new Set(bound.map(r => int8(r.id)));
  const lost = ids.find(id => !got.has(id));
  if (lost !== undefined) throw refused(lost);
}

// Each row with its attachments added, in id order, for those that have any (core withAttachments).
export async function withAttachments<T extends { id: number }>(sql: PgSql, owner: AttachmentOwner, rows: T[]): Promise<(T & { attachments?: AttachmentInfo[] })[]> {
  if (rows.length === 0) return rows;
  const col = column(sql, owner);
  const found: Row[] = await sql`SELECT ${col} AS owner, id, filename, type, size, sha256 FROM attachments
    WHERE ${col} = ANY(${rows.map(r => r.id)}::int8[]) ORDER BY id`;
  if (found.length === 0) return rows;
  const by = new Map<number, AttachmentInfo[]>();
  for (const r of found) {
    const o = int8(r.owner);
    const list = by.get(o) ?? [];
    list.push(info(r));
    by.set(o, list);
  }
  return rows.map(r => by.has(r.id) ? { ...r, attachments: by.get(r.id)! } : r);
}

// Deletes the attachment rows of the owners `owners` names: ids, or a subquery fragment over owner ids (core
// dropAttachments). The blob sweep after commit stays the caller's. Returns how many rows went.
export async function dropAttachments(sql: PgSql, owner: AttachmentOwner, owners: number[] | PgFragment): Promise<number> {
  const col = column(sql, owner);
  const rows: Row[] = Array.isArray(owners)
    ? await sql`DELETE FROM attachments WHERE ${col} = ANY(${owners}::int8[]) RETURNING id`
    : await sql`DELETE FROM attachments WHERE ${col} IN (${owners}) RETURNING id`;
  return rows.length;
}
