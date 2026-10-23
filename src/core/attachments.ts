// Attachment storage, shared by local mode and the distributed server. Files
// are read and checked in the session's MCP process (src/shared/attachments.ts);
// this stores their bytes, binds them to the message or post that carries
// them, and drops them with it.
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import { CoreError, canSeeBoard, getPost } from "./boards.ts";
import {
  DEFAULT_ATTACHMENT_LIMITS, MAX_ATTACHMENTS, UNBOUND_TTL_MS, formatSize, type AttachmentFile, type AttachmentInfo, type AttachmentLimits,
} from "../shared/attachments.ts";

export type AttachmentRow = AttachmentInfo & {
  sha256: string;
  uploader: string;
  message_id: number | null;
  post_id: number | null;
  created_at: number;
};

export type AttachTarget = { message_id: number } | { post_id: number };
type Kind = "message_id" | "post_id";

const INFO = `id, filename, type, size`;

const limitsByDb = new WeakMap<Database, AttachmentLimits>();

// A server's configured limits for this database; local mode keeps the defaults.
export function setAttachmentLimits(db: Database, limits: AttachmentLimits): void {
  limitsByDb.set(db, limits);
}

export function attachmentLimits(db: Database): AttachmentLimits {
  return limitsByDb.get(db) ?? DEFAULT_ATTACHMENT_LIMITS;
}

// Stores one checked file as an unbound upload of `uploader`'s. Identical
// bytes share one blob. Also prunes uploads left unbound past their TTL.
export function storeAttachment(db: Database, uploader: string, file: AttachmentFile, now = Date.now()): AttachmentRow {
  const sha256 = createHash("sha256").update(file.data).digest("hex");
  return db.transaction(() => {
    pruneUnbound(db, now - UNBOUND_TTL_MS);
    db.prepare(`INSERT OR IGNORE INTO attachment_blobs (sha256, data, size) VALUES (?, ?, ?)`).run(sha256, file.data, file.data.length);
    return db
      .prepare(
        `INSERT INTO attachments (sha256, filename, type, size, uploader, created_at)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(sha256, file.filename, file.type, file.data.length, uploader, now) as AttachmentRow;
  }).immediate();
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
export function bindAttachments(db: Database, ids: number[], uploader: string, target: AttachTarget): AttachmentInfo[] {
  if (ids.length === 0) return [];
  const rows = db
    .prepare(`SELECT * FROM attachments WHERE id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(ids)) as AttachmentRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  let total = 0;
  for (const id of ids) {
    const r = byId.get(id);
    if (!r || r.uploader !== uploader || r.message_id !== null || r.post_id !== null) {
      throw new CoreError(`attachment ${id} isn't an unsent upload of yours`);
    }
    total += r.size;
  }
  const max = attachmentLimits(db).total;
  if (total > max) throw new CoreError(`attachments exceed ${formatSize(max)} in all`);
  const [col, value] = "message_id" in target ? ["message_id", target.message_id] : ["post_id", target.post_id];
  db.prepare(`UPDATE attachments SET ${col} = ? WHERE id IN (SELECT value FROM json_each(?))`).run(value, JSON.stringify(ids));
  return ids.map((id) => info(byId.get(id)!));
}

const info = (r: AttachmentInfo): AttachmentInfo => ({ id: r.id, filename: r.filename, type: r.type, size: r.size });

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

export function attachmentData(db: Database, sha256: string): Uint8Array {
  const row = db.prepare(`SELECT data FROM attachment_blobs WHERE sha256 = ?`).get(sha256) as { data: Uint8Array } | undefined;
  if (!row) throw new Error(`attachment blob ${sha256} is missing`);
  return row.data;
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
// subquery over `params`), and any blob left unnamed. Run before deleting the
// owners themselves, in the same transaction.
export function dropAttachments(db: Database, kind: "message" | "post", ownersSql: string, ...params: (string | number)[]): void {
  const col: Kind = kind === "message" ? "message_id" : "post_id";
  const shas = db
    .prepare(`SELECT DISTINCT sha256 FROM attachments WHERE ${col} IN (${ownersSql})`)
    .all(...params) as { sha256: string }[];
  if (shas.length === 0) return;
  db.prepare(`DELETE FROM attachments WHERE ${col} IN (${ownersSql})`).run(...params);
  dropOrphanBlobs(db, shas.map((s) => s.sha256));
}

// Bytes of unbound uploads held by the handles under `prefix` (a server
// user's "email/"), for the per-user quota on uploads.
export function unboundBytes(db: Database, prefix: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(size), 0) AS n FROM attachments
        WHERE message_id IS NULL AND post_id IS NULL AND substr(uploader, 1, length(?)) = ?`,
    )
    .get(prefix, prefix) as { n: number };
  return row.n;
}

// Drops one of `uploader`'s unsent uploads, for a send that failed after
// uploading. Null if it isn't theirs or a message or post already carries it.
export function releaseUpload(db: Database, id: number, uploader: string): AttachmentRow | null {
  return db.transaction(() => {
    const row = db
      .prepare(`DELETE FROM attachments WHERE id = ? AND uploader = ? AND message_id IS NULL AND post_id IS NULL RETURNING *`)
      .get(id, uploader) as AttachmentRow | null;
    if (row) dropOrphanBlobs(db, [row.sha256]);
    return row;
  }).immediate();
}

// Uploads no message or post claimed, created before `olderThanMs`.
export function pruneUnbound(db: Database, olderThanMs: number): void {
  const where = `message_id IS NULL AND post_id IS NULL AND created_at < ?`;
  const shas = db.prepare(`SELECT DISTINCT sha256 FROM attachments WHERE ${where}`).all(olderThanMs) as { sha256: string }[];
  if (shas.length === 0) return;
  db.prepare(`DELETE FROM attachments WHERE ${where}`).run(olderThanMs);
  dropOrphanBlobs(db, shas.map((s) => s.sha256));
}

function dropOrphanBlobs(db: Database, shas: string[]): void {
  db.prepare(
    `DELETE FROM attachment_blobs WHERE sha256 IN (SELECT value FROM json_each(?))
       AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.sha256 = attachment_blobs.sha256)`,
  ).run(JSON.stringify(shas));
}
