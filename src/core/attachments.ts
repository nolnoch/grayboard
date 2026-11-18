// Attachment storage, shared by local mode and the distributed server. Files
// are read and checked in the session's MCP process (src/shared/attachments.ts);
// this stores them, binds them to the message or post that carries them, and
// drops them with it. SQL holds only metadata: the attachment rows and the
// attachment_blobs catalog. Bytes live in a BlobStore, outside any transaction.
import type { Database } from "bun:sqlite";

import { canSeeBoard, getPost } from "./boards.ts";
import { CoreError, TooLargeError } from "./errors.ts";
import {
  MAX_ATTACHMENTS, SizeTally, UNBOUND_TTL_MS, formatSize,
  type AttachmentFile, type AttachmentInfo, type AttachmentLimits,
} from "../shared/attachments.ts";
import { sha256Hex } from "../shared/hash.ts";
import { immediateTx, type WriteTx } from "./write_tx.ts";

export type AttachmentRow = AttachmentInfo & {
  uploader: string;
  // The user who stored it, on a server; null in local mode and for rows an earlier release stored without one.
  uploader_principal: string | null;
  message_id: number | null;
  post_id: number | null;
  created_at: number;
};

export type AttachTarget = { message_id: number } | { post_id: number };

// Who may send an unsent upload: the sending session's addresses (#284 S5)
// and, on a server, its user. An address can pass to another user (a team
// alias rebound), so an upload goes only with the user who made it (#367).
// principal is null in local mode, which has one user.
export type Uploader = { addresses: string[]; principal: string | null };

// A mode that sends files: the caps a write's files are bound under, and the
// user sending them.
export type FileSend = { limits: AttachmentLimits; principal: string | null };
type Kind = "message_id" | "post_id";

const INFO = `id, filename, type, size, sha256`;

// Where attachment bytes live, keyed by sha256: a directory on the server
// (src/server/blobs.ts), a table in local mode (src/local/blobs.ts), S3 later.
export interface BlobStore {
  // Idempotent: the same sha256 is the same bytes.
  put(sha256: string, data: Uint8Array): Promise<void>;
  // Throws BlobMissing if the bytes are missing.
  get(sha256: string): Promise<Uint8Array>;
  // Missing bytes are fine.
  delete(sha256: string): Promise<void>;
}

// Uploads and sweeps of one sha256 run one at a time in this process, so a
// sweep can't delete bytes an upload has just put. A store other processes
// share must also refuse to delete bytes an attachment row names.
const held = new Map<string, Promise<void>>();
export async function withBlob<T>(sha256: string, fn: () => Promise<T>): Promise<T> {
  const before = held.get(sha256) ?? Promise.resolve();
  const run = before.then(fn);
  const done = run.then(() => {}, () => {});
  held.set(sha256, done);
  void done.then(() => {
    if (held.get(sha256) === done) held.delete(sha256);
  });
  return run;
}

// A principal's caps (#284 decision 13), over every upload that counts
// against it, whatever address uploaded it: `unsent` bytes not yet on a
// message or post, and `stored` bytes in all, sent or not. `principal` is a
// server user's email; it's recorded on the upload as uploader_principal.
export type UploadQuota = { principal: string; unsent: number; stored: number };

// Stores one checked file as an unbound upload of `uploader`'s. Identical
// bytes share one blob. Also prunes uploads left unbound past their TTL, then
// checks `quota` in the same write transaction, so two concurrent uploads
// can't both fit under it. The row and its catalog entry commit before the
// bytes are put, so a sweep never sees bytes no row names; a failed put
// drops the row.
export async function storeAttachment(
  db: Database,
  blobs: BlobStore,
  uploader: string,
  file: AttachmentFile,
  opts: { now?: number; quota?: UploadQuota; tx?: WriteTx } = {},
): Promise<AttachmentRow> {
  const now = opts.now ?? Date.now();
  const tx = opts.tx ?? immediateTx(db);
  const sha256 = sha256Hex(file.data);
  let unnamed = false;
  try {
    return await withBlob(sha256, async () => {
      const row = await tx((w) => {
        const added = insertUpload(w, { sha256, filename: file.filename, type: file.type, size: file.data.length, uploader, quota: opts.quota, now });
        unnamed = added.pruned;
        return added.row;
      });
      try {
        // Put even when the catalog knew this sha256: it heals bytes a crash lost.
        await blobs.put(sha256, file.data);
      } catch (e) {
        await tx((w) => removeUpload(w, row.id));
        unnamed = true;
        throw e;
      }
      return row;
    });
  } finally {
    if (unnamed) await sweepBlobs(db, blobs, tx);
  }
}

// An upload's catalog row, as one write: prunes uploads left unbound past their TTL, checks `quota` and inserts the
// blob's catalog entry and the row. A caller whose transactions can interleave (a Postgres store, #807 P3 B3) holds
// the principal's lock first, so two uploads can't both fit under the quota. `pruned`: some upload was pruned, so a
// blob sweep after the commit has bytes to free.
export type NewUpload = { sha256: string; filename: string; type: string; size: number; uploader: string; quota?: UploadQuota; now: number };
export function insertUpload(db: Database, u: NewUpload): { row: AttachmentRow; pruned: boolean } {
  const pruned = pruneUnbound(db, u.now - UNBOUND_TTL_MS) > 0;
  const q = u.quota;
  // Bytes the principal already has under this blob add nothing.
  const adds = (unbound: boolean) => (q && heldBlob(db, q.principal, u.sha256, unbound) ? 0 : u.size);
  if (q && uploadedBytes(db, q.principal, true) + adds(true) > q.unsent) {
    throw new TooLargeError(`your unsent uploads would exceed ${formatSize(q.unsent)}; send or wait for them to expire`);
  }
  if (q && uploadedBytes(db, q.principal, false) + adds(false) > q.stored) {
    throw new TooLargeError(`your stored attachments would exceed ${formatSize(q.stored)}; they're freed as their messages and posts age out`);
  }
  db.prepare(`INSERT OR IGNORE INTO attachment_blobs (sha256, size, created_at) VALUES (?, ?, ?)`).run(u.sha256, u.size, u.now);
  const row = db
    .prepare(
      `INSERT INTO attachments (sha256, filename, type, size, uploader, uploader_principal, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(u.sha256, u.filename, u.type, u.size, u.uploader, q?.principal ?? null, u.now) as AttachmentRow;
  return { row, pruned };
}

// Drops an upload row whose bytes failed to store.
export function removeUpload(db: Database, id: number): void {
  db.prepare(`DELETE FROM attachments WHERE id = ?`).run(id);
}

// The attachment ids a tool call or wire frame carries, checked for shape.
export function attachmentIds(v: unknown): number[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.every((x) => Number.isInteger(x) && x > 0)) {
    throw new CoreError("attachment_ids must be a list of attachment ids");
  }
  const ids = [...new Set(v as number[])];
  if (ids.length > MAX_ATTACHMENTS) throw new CoreError(`at most ${MAX_ATTACHMENTS} attachments per message`);
  return ids;
}

// Binds uploads to the message or post just written. Run it inside that
// write's transaction: each id must be an unbound upload of `from`, or the
// write rolls back with it.
export function bindAttachments(
  db: Database,
  ids: number[],
  from: Uploader,
  target: AttachTarget,
  limits: AttachmentLimits,
): AttachmentInfo[] {
  if (ids.length === 0) return [];
  const rows = unsentUploads(db, ids, from);
  // Each upload was checked alone when stored; the message's total is known only here.
  const tally = new SizeTally(limits, ids.length);
  for (const r of rows) tally.add(`attachment ${r.id}`, r.size);
  const [col, value] = "message_id" in target ? ["message_id", target.message_id] : ["post_id", target.post_id];
  // Conditional on still being unsent, so a store whose read can miss a concurrent bind (Postgres) can't move a file
  // another write just took: a row that no longer matches refuses as the read would have.
  const bound = new Set(
    (db.prepare(`UPDATE attachments SET ${col} = ?4 WHERE ${UNSENT} RETURNING id`).all(...unsentArgs(ids, from), value) as { id: number }[])
      .map((r) => r.id),
  );
  const lost = ids.find((id) => !bound.has(id));
  if (lost !== undefined) throw new CoreError(`attachment ${lost} isn't an unsent upload of yours`);
  return rows.map(info);
}

// `from`'s unsent uploads among ids ?1, as SQL over ?2 (its addresses) and ?3
// (its user, or null in local mode).
const UNSENT = `id IN (SELECT value FROM json_each(?1)) AND uploader IN (SELECT value FROM json_each(?2))
  AND (?3 IS NULL OR uploader_principal = ?3) AND message_id IS NULL AND post_id IS NULL`;
const unsentArgs = (ids: number[], from: Uploader) => [JSON.stringify(ids), JSON.stringify(from.addresses), from.principal] as const;

// The unsent uploads `ids` of `from`, in call order. Throws on an id that
// isn't one: someone else's, unknown, or already on a message or post.
function unsentUploads(db: Database, ids: number[], from: Uploader): AttachmentRow[] {
  const rows = db.prepare(`SELECT * FROM attachments WHERE ${UNSENT}`).all(...unsentArgs(ids, from)) as AttachmentRow[];
  const by = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => {
    const r = by.get(id);
    if (!r) throw new CoreError(`attachment ${id} isn't an unsent upload of yours`);
    return r;
  });
}

// The blob digests of `from`'s unsent uploads `ids`, in call order: what
// a write's fingerprint keys its files by (#254), since every attempt uploads
// afresh under new ids while the blob is content-addressed. Refuses an id
// bindAttachments would.
export function uploadDigests(db: Database, ids: number[], from: Uploader): string[] {
  return ids.length === 0 ? [] : unsentUploads(db, ids, from).map((r) => r.sha256);
}

// Drops `from`'s unsent uploads `ids`, for a replayed write (#254): the
// retry uploaded its files afresh and nothing will bind them. Run it inside
// the replay's transaction; sweepBlobs after it commits deletes the bytes
// (none, while the first write's copy names the blob).
export function dropUnsentUploads(db: Database, ids: number[], from: Uploader): AttachmentRow[] {
  if (ids.length === 0) return [];
  return db.prepare(`DELETE FROM attachments WHERE ${UNSENT} RETURNING *`).all(...unsentArgs(ids, from)) as AttachmentRow[];
}

const info = (r: AttachmentInfo): AttachmentInfo => ({ id: r.id, filename: r.filename, type: r.type, size: r.size, sha256: r.sha256 });

// Each row with its attachments added, for those that have any.
export function withAttachments<T extends { id: number }>(
  db: Database,
  kind: "message" | "post",
  rows: T[],
): (T & { attachments?: AttachmentInfo[] })[] {
  if (rows.length === 0) return rows;
  const col: Kind = kind === "message" ? "message_id" : "post_id";
  const found = db
    .prepare(`SELECT ${col} AS owner, ${INFO} FROM attachments WHERE ${col} IN (SELECT value FROM json_each(?)) ORDER BY id`)
    .all(JSON.stringify(rows.map((r) => r.id))) as (AttachmentInfo & { owner: number })[];
  if (found.length === 0) return rows;
  const by = new Map<number, AttachmentInfo[]>();
  for (const { owner, ...a } of found) {
    const list = by.get(owner) ?? [];
    list.push(a);
    by.set(owner, list);
  }
  return rows.map((r) => (by.has(r.id) ? { ...r, attachments: by.get(r.id)! } : r));
}

export function getAttachment(db: Database, id: number): AttachmentRow | undefined {
  return (db.prepare(`SELECT * FROM attachments WHERE id = ?`).get(id) as AttachmentRow | null) ?? undefined;
}

// Whether `handle` may fetch an attachment: one on a post, if it can see the
// post's board; on a direct message, if dmVisible (the mode's sender or
// recipient check) says so; an unbound upload, only the user who made it, from
// one of `from.addresses`, the caller's address set (#284 S5). An address can
// pass to another user, so on a server `from.principal` must be that user and
// never null (#367); null means local mode, which has one user.
export function canReadAttachment(
  db: Database,
  handle: string,
  a: AttachmentRow,
  dmVisible: (messageId: number) => boolean,
  from: Uploader = { addresses: [handle], principal: null },
): boolean {
  return attachmentReach(db, handle, a, dmVisible, from).readable;
}

// canReadAttachment's answer and which carrier decided it, for the server's
// decidePure() to name its rule (#851).
export type AttachmentReach = { carrier: "post" | "message" | "unbound"; readable: boolean };
export function attachmentReach(
  db: Database,
  handle: string,
  a: AttachmentRow,
  dmVisible: (messageId: number) => boolean,
  from: Uploader = { addresses: [handle], principal: null },
): AttachmentReach {
  return attachmentReachWith(a, (postId) => {
    const p = getPost(db, postId);
    return !!p && canSeeBoard(db, handle, p.board);
  }, dmVisible, from);
}

// attachmentReach's rule over its carrier's visibility, asked of `postVisible` or `dmVisible`: the server reads both
// up front on its own handle (#807 P3 B5a1).
export function attachmentReachWith(
  a: AttachmentRow,
  postVisible: (postId: number) => boolean,
  dmVisible: (messageId: number) => boolean,
  from: Uploader,
): AttachmentReach {
  if (a.post_id !== null) return { carrier: "post", readable: postVisible(a.post_id) };
  if (a.message_id !== null) return { carrier: "message", readable: dmVisible(a.message_id) };
  return { carrier: "unbound", readable: from.addresses.includes(a.uploader) && (from.principal === null || a.uploader_principal === from.principal) };
}

// Deletes the attachments of the messages or posts `ownersSql` selects (a
// subquery over `params`). Run before deleting the owners themselves, in the
// same transaction; sweepBlobs after it commits deletes the bytes.
export function dropAttachments(db: Database, kind: "message" | "post", ownersSql: string, ...params: (string | number)[]): number {
  const col: Kind = kind === "message" ? "message_id" : "post_id";
  return db.prepare(`DELETE FROM attachments WHERE ${col} IN (${ownersSql})`).run(...params).changes;
}

// Bytes stored against `principal`, only the unbound uploads if `unbound`,
// for the per-principal quotas. Each distinct blob counts once (#284
// decision 13): the same file sent twice is stored once.
export function uploadedBytes(db: Database, principal: string, unbound: boolean): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(size), 0) AS n FROM (
         SELECT MAX(size) AS size FROM attachments
          WHERE uploader_principal = ?${unbound ? " AND message_id IS NULL AND post_id IS NULL" : ""}
          GROUP BY sha256)`,
    )
    .get(principal) as { n: number };
  return row.n;
}

// Whether `principal` already stores blob `sha256` (only unbound uploads, if `unbound`).
function heldBlob(db: Database, principal: string, sha256: string, unbound: boolean): boolean {
  return !!db
    .prepare(`SELECT 1 FROM attachments WHERE uploader_principal = ? AND sha256 = ?${unbound ? " AND message_id IS NULL AND post_id IS NULL" : ""}`)
    .get(principal, sha256);
}

// Drops one of `from`'s unsent uploads, for a send that failed after
// uploading. Null if it isn't theirs (any address of `from`, made by its user,
// #367) or a message or post already carries it.
export async function releaseUpload(
  db: Database, blobs: BlobStore, id: number, from: Uploader,
): Promise<AttachmentRow | null> {
  const tx = immediateTx(db);
  const row = await tx((w) => dropUnsentUploads(w, [id], from)[0] ?? null);
  if (row) await sweepBlobs(db, blobs, tx);
  return row;
}

// Deletes the uploads no message or post claimed, created before
// `olderThanMs`. Returns how many; sweepBlobs deletes their bytes.
export function pruneUnbound(db: Database, olderThanMs: number): number {
  return db.prepare(`DELETE FROM attachments WHERE message_id IS NULL AND post_id IS NULL AND created_at < ?`).run(olderThanMs).changes;
}

const UNNAMED = `NOT EXISTS (SELECT 1 FROM attachments a WHERE a.sha256 = attachment_blobs.sha256)`;

// A blob sweep's three steps (#807 P3 B3: a server's store runs them asynchronously, src/server/attachments.ts):
// the catalog's blobs no attachment names, whether one is named now, and dropping its catalog entry while still unnamed.
export function unnamedBlobs(db: Database): string[] {
  return (db.prepare(`SELECT sha256 FROM attachment_blobs WHERE ${UNNAMED}`).all() as { sha256: string }[]).map((r) => r.sha256);
}
export function blobNamed(db: Database, sha256: string): boolean {
  return !!db.prepare(`SELECT 1 FROM attachments WHERE sha256 = ?`).get(sha256);
}
export function dropBlobEntry(db: Database, sha256: string): number {
  return db.prepare(`DELETE FROM attachment_blobs WHERE sha256 = ? AND ${UNNAMED}`).run(sha256).changes;
}

// Deletes the bytes, then the catalog entry, of every blob no attachment
// names. A crash between the two leaves an entry the next sweep finishes,
// never bytes nothing names. Never throws: a failure is logged and left for
// the next sweep. Returns how many went.
export async function sweepBlobs(db: Database, blobs: BlobStore, tx: WriteTx = immediateTx(db)): Promise<number> {
  let shas: string[];
  try {
    shas = unnamedBlobs(db);
  } catch (e) {
    console.error(`[grayboard] blob sweep: ${(e as Error).message}`);
    return 0;
  }
  let swept = 0;
  for (const sha256 of shas) {
    try {
      await withBlob(sha256, async () => {
        if (blobNamed(db, sha256)) return;
        await blobs.delete(sha256);
        swept += await tx((w) => dropBlobEntry(w, sha256));
      });
    } catch (e) {
      console.error(`[grayboard] blob sweep: ${sha256}: ${(e as Error).message}`);
    }
  }
  return swept;
}
