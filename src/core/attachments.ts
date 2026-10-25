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

export type AttachmentRow = AttachmentInfo & {
  uploader: string;
  message_id: number | null;
  post_id: number | null;
  created_at: number;
};

export type AttachTarget = { message_id: number } | { post_id: number };
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
async function withBlob<T>(sha256: string, fn: () => Promise<T>): Promise<T> {
  const before = held.get(sha256) ?? Promise.resolve();
  const run = before.then(fn);
  const done = run.then(() => {}, () => {});
  held.set(sha256, done);
  void done.then(() => {
    if (held.get(sha256) === done) held.delete(sha256);
  });
  return run;
}

// A server user's caps, over the uploads of every handle under `prefix` (the
// user's "email/"): `unsent` bytes not yet on a message or post, and `stored`
// bytes in all, sent or not.
export type UploadQuota = { prefix: string; unsent: number; stored: number };

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
  opts: { now?: number; quota?: UploadQuota } = {},
): Promise<AttachmentRow> {
  const now = opts.now ?? Date.now();
  const sha256 = sha256Hex(file.data);
  let unnamed = false;
  try {
    return await withBlob(sha256, async () => {
      const row = db.transaction(() => {
        unnamed = pruneUnbound(db, now - UNBOUND_TTL_MS) > 0;
        const q = opts.quota;
        if (q && uploadedBytes(db, q.prefix, true) + file.data.length > q.unsent) {
          throw new TooLargeError(`your unsent uploads would exceed ${formatSize(q.unsent)}; send or wait for them to expire`);
        }
        if (q && uploadedBytes(db, q.prefix, false) + file.data.length > q.stored) {
          throw new TooLargeError(`your stored attachments would exceed ${formatSize(q.stored)}; they're freed as their messages and posts age out`);
        }
        db.prepare(`INSERT OR IGNORE INTO attachment_blobs (sha256, size, created_at) VALUES (?, ?, ?)`).run(sha256, file.data.length, now);
        return db
          .prepare(
            `INSERT INTO attachments (sha256, filename, type, size, uploader, created_at)
             VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
          )
          .get(sha256, file.filename, file.type, file.data.length, uploader, now) as AttachmentRow;
      }).immediate();
      try {
        // Put even when the catalog knew this sha256: it heals bytes a crash lost.
        await blobs.put(sha256, file.data);
      } catch (e) {
        db.prepare(`DELETE FROM attachments WHERE id = ?`).run(row.id);
        unnamed = true;
        throw e;
      }
      return row;
    });
  } finally {
    if (unnamed) await sweepBlobs(db, blobs);
  }
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
// write's transaction: each id must be `uploader`'s and still unbound, or the
// write rolls back with it.
export function bindAttachments(
  db: Database,
  ids: number[],
  uploader: string,
  target: AttachTarget,
  limits: AttachmentLimits,
): AttachmentInfo[] {
  if (ids.length === 0) return [];
  const rows = unsentUploads(db, ids, uploader);
  // Each upload was checked alone when stored; the message's total is known only here.
  const tally = new SizeTally(limits, ids.length);
  for (const r of rows) tally.add(`attachment ${r.id}`, r.size);
  const [col, value] = "message_id" in target ? ["message_id", target.message_id] : ["post_id", target.post_id];
  db.prepare(`UPDATE attachments SET ${col} = ? WHERE id IN (SELECT value FROM json_each(?))`).run(value, JSON.stringify(ids));
  return rows.map(info);
}

// `uploader`'s unsent uploads `ids`, in call order. Throws on an id that
// isn't one: someone else's, unknown, or already on a message or post.
function unsentUploads(db: Database, ids: number[], uploader: string): AttachmentRow[] {
  const rows = db
    .prepare(`SELECT * FROM attachments WHERE id IN (SELECT value FROM json_each(?)) AND uploader = ? AND message_id IS NULL AND post_id IS NULL`)
    .all(JSON.stringify(ids), uploader) as AttachmentRow[];
  const by = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => {
    const r = by.get(id);
    if (!r) throw new CoreError(`attachment ${id} isn't an unsent upload of yours`);
    return r;
  });
}

// The blob digests of `uploader`'s unsent uploads `ids`, in call order: what
// a write's fingerprint keys its files by (#254), since every attempt uploads
// afresh under new ids while the blob is content-addressed. Refuses an id
// bindAttachments would.
export function uploadDigests(db: Database, ids: number[], uploader: string): string[] {
  return ids.length === 0 ? [] : unsentUploads(db, ids, uploader).map((r) => r.sha256);
}

// Drops `uploader`'s unsent uploads `ids`, for a replayed write (#254): the
// retry uploaded its files afresh and nothing will bind them. Run it inside
// the replay's transaction; sweepBlobs after it commits deletes the bytes
// (none, while the first write's copy names the blob).
export function dropUnsentUploads(db: Database, ids: number[], uploader: string): AttachmentRow[] {
  if (ids.length === 0) return [];
  return db
    .prepare(`DELETE FROM attachments WHERE id IN (SELECT value FROM json_each(?)) AND uploader = ? AND message_id IS NULL AND post_id IS NULL RETURNING *`)
    .all(JSON.stringify(ids), uploader) as AttachmentRow[];
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
// recipient check) says so; an unbound upload, only its uploader.
export function canReadAttachment(
  db: Database,
  handle: string,
  a: AttachmentRow,
  dmVisible: (messageId: number) => boolean,
): boolean {
  if (a.post_id !== null) {
    const p = getPost(db, a.post_id);
    return !!p && canSeeBoard(db, handle, p.board);
  }
  if (a.message_id !== null) return dmVisible(a.message_id);
  return a.uploader === handle;
}

// Deletes the attachments of the messages or posts `ownersSql` selects (a
// subquery over `params`). Run before deleting the owners themselves, in the
// same transaction; sweepBlobs after it commits deletes the bytes.
export function dropAttachments(db: Database, kind: "message" | "post", ownersSql: string, ...params: (string | number)[]): number {
  const col: Kind = kind === "message" ? "message_id" : "post_id";
  return db.prepare(`DELETE FROM attachments WHERE ${col} IN (${ownersSql})`).run(...params).changes;
}

// Bytes uploaded by the handles under `prefix` (a server user's "email/"),
// only the unbound ones if `unbound`, for the per-user quotas. The range on
// uploader uses its index: every handle under the prefix sorts below the
// prefix with its last character incremented.
export function uploadedBytes(db: Database, prefix: string, unbound: boolean): number {
  const end = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(size), 0) AS n FROM attachments
        WHERE uploader >= ? AND uploader < ?${unbound ? " AND message_id IS NULL AND post_id IS NULL" : ""}`,
    )
    .get(prefix, end) as { n: number };
  return row.n;
}

// Drops one of `uploader`'s unsent uploads, for a send that failed after
// uploading. Null if it isn't theirs or a message or post already carries it.
export async function releaseUpload(db: Database, blobs: BlobStore, id: number, uploader: string): Promise<AttachmentRow | null> {
  const row = db
    .prepare(`DELETE FROM attachments WHERE id = ? AND uploader = ? AND message_id IS NULL AND post_id IS NULL RETURNING *`)
    .get(id, uploader) as AttachmentRow | null;
  if (row) await sweepBlobs(db, blobs);
  return row;
}

// Deletes the uploads no message or post claimed, created before
// `olderThanMs`. Returns how many; sweepBlobs deletes their bytes.
export function pruneUnbound(db: Database, olderThanMs: number): number {
  return db.prepare(`DELETE FROM attachments WHERE message_id IS NULL AND post_id IS NULL AND created_at < ?`).run(olderThanMs).changes;
}

const UNNAMED = `NOT EXISTS (SELECT 1 FROM attachments a WHERE a.sha256 = attachment_blobs.sha256)`;

// Deletes the bytes, then the catalog entry, of every blob no attachment
// names. A crash between the two leaves an entry the next sweep finishes,
// never bytes nothing names. Never throws: a failure is logged and left for
// the next sweep. Returns how many went.
export async function sweepBlobs(db: Database, blobs: BlobStore): Promise<number> {
  let shas: string[];
  try {
    shas = (db.prepare(`SELECT sha256 FROM attachment_blobs WHERE ${UNNAMED}`).all() as { sha256: string }[]).map((r) => r.sha256);
  } catch (e) {
    console.error(`[grayboard] blob sweep: ${(e as Error).message}`);
    return 0;
  }
  let swept = 0;
  for (const sha256 of shas) {
    try {
      await withBlob(sha256, async () => {
        if (db.prepare(`SELECT 1 FROM attachments WHERE sha256 = ?`).get(sha256)) return;
        await blobs.delete(sha256);
        swept += db.prepare(`DELETE FROM attachment_blobs WHERE sha256 = ? AND ${UNNAMED}`).run(sha256).changes;
      });
    } catch (e) {
      console.error(`[grayboard] blob sweep: ${sha256}: ${(e as Error).message}`);
    }
  }
  return swept;
}
