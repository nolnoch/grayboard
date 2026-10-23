// Who may read an attachment on the server: the HTTP download route and the
// Slack bridge's human identities ask the same question.
import { canReadAttachment, getAttachment, releaseUpload, storeAttachment, type AttachmentRow } from "../core/attachments.ts";
import type { CoreDb } from "../core/boards.ts";
import { unboundCap, type AttachmentFile } from "../shared/attachments.ts";
import { writeAudit } from "./audit.ts";
import type { Repo } from "./db.ts";

// Attachment `id`, if `handle` may read it: on a post on a board it can see,
// on a direct message it sent or received, or its own unsent upload.
export function readableAttachment(repo: Repo, db: CoreDb, handle: string, id: number): AttachmentRow | undefined {
  const row = Number.isInteger(id) && id > 0 ? getAttachment(db, id) : undefined;
  const dmVisible = (messageId: number) => {
    const m = repo.messages.getById(messageId);
    return !!m && m.recipient_type === "user" && (m.sender === handle || m.recipient === handle);
  };
  return row && canReadAttachment(db, handle, row, dmVisible) ? row : undefined;
}

// Stores a checked file as an unsent upload of `handle`'s, within its user's
// quotas (unsent bytes, and stored bytes in all), and audits it. The HTTP
// upload route and the Slack app's in-process sends both store this way.
export async function storeUpload(
  repo: Repo,
  db: CoreDb,
  email: string,
  handle: string,
  file: AttachmentFile,
  detail: Record<string, unknown> = {},
): Promise<AttachmentRow> {
  const quota = { prefix: `${email}/`, unsent: unboundCap(repo.attachmentLimits), stored: repo.attachmentUserQuota };
  const row = await storeAttachment(db, repo.blobs, handle, file, { quota });
  writeAudit(repo, "attachment.uploaded", email, `attachment:${row.id}`, {
    identity: handle, filename: row.filename, type: row.type, size: row.size, sha256: row.sha256, ...detail,
  });
  return row;
}

// Drops one of `handle`'s unsent uploads and audits it, for a send that
// failed after uploading. Null if it isn't theirs or is already sent.
export async function releaseStored(
  repo: Repo,
  db: CoreDb,
  email: string,
  handle: string,
  id: number,
  detail: Record<string, unknown> = {},
): Promise<AttachmentRow | null> {
  const row = await releaseUpload(db, repo.blobs, id, handle);
  if (row) {
    writeAudit(repo, "attachment.released", email, `attachment:${row.id}`, {
      identity: handle, filename: row.filename, size: row.size, sha256: row.sha256, ...detail,
    });
  }
  return row;
}
