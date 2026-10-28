// Who may read an attachment on the server: the HTTP download route and the
// Slack bridge's human identities ask the same question.
import { canReadAttachment, getAttachment, releaseUpload, storeAttachment, type AttachmentRow } from "../core/attachments.ts";
import type { CoreDb } from "../core/boards.ts";
import { unboundCap, type AttachmentFile } from "../shared/attachments.ts";
import { writeAudit } from "./audit.ts";
import { participant, type Repo } from "./db.ts";
import { addressSet } from "../core/bindings.ts";

// Attachment `id`, if `handle` may read it: on a post on a board it can see,
// on a direct message it sent or received, or its own unsent upload. A
// session's files are its whole address set's (#284 S8): `principal` names
// the caller, whose session holding `handle` (or held by it) joins the set;
// null for the Slack bridge's humans, which have no session. `user` is the
// reading user's email, always set on a server: an unsent upload is readable
// only by the user who made it, not by whoever holds its address next (#367).
export function readableAttachment(repo: Repo, db: CoreDb, handle: string, id: number, principal: string | null, user: string): AttachmentRow | undefined {
  const row = Number.isInteger(id) && id > 0 ? getAttachment(db, id) : undefined;
  const addresses = addressSet(db, handle, principal);
  const dmVisible = (messageId: number) => participant(repo.messages.getById(messageId), addresses);
  return row && canReadAttachment(db, handle, row, dmVisible, { addresses, principal: user }) ? row : undefined;
}

// Stores a checked file as an unsent upload of `handle`'s, within the quotas
// of its principal, the user `email` (unsent bytes, and stored bytes in all),
// and audits it. The HTTP upload route and the Slack app's in-process sends
// both store this way.
export async function storeUpload(
  repo: Repo,
  db: CoreDb,
  email: string,
  handle: string,
  file: AttachmentFile,
  detail: Record<string, unknown> = {},
  guard?: () => void,
): Promise<AttachmentRow> {
  const quota = { principal: email, unsent: unboundCap(repo.attachmentLimits), stored: repo.attachmentUserQuota };
  const row = await storeAttachment(db, repo.blobs, handle, file, { quota, guard });
  try {
    guard?.();
    writeAudit(repo, "attachment.uploaded", email, `attachment:${row.id}`, {
      identity: handle, filename: row.filename, type: row.type, size: row.size, sha256: row.sha256, ...detail,
    });
    return row;
  } catch (error) {
    // Only this upload, and only while unbound; concurrent sends keep their bytes.
    if (guard) await releaseUpload(db, repo.blobs, row.id, { addresses: [handle], principal: email });
    throw error;
  }
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
  guard?: () => void,
): Promise<AttachmentRow | null> {
  const row = await releaseUpload(db, repo.blobs, id, { addresses: [handle], principal: email }, guard);
  if (row) {
    writeAudit(repo, "attachment.released", email, `attachment:${row.id}`, {
      identity: handle, filename: row.filename, size: row.size, sha256: row.sha256, ...detail,
    });
  }
  return row;
}
