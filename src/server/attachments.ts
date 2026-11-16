// Who may read an attachment on the server: the HTTP download route and the
// Slack bridge's human identities ask the same question.
import { attachmentReach, getAttachment, releaseUpload, storeAttachment, type AttachmentRow } from "../core/attachments.ts";
import type { CoreDb } from "../core/boards.ts";
import { unboundCap, type AttachmentFile } from "../shared/attachments.ts";
import { writeAudit } from "./audit.ts";
import { participant, queuedTx, type Repo } from "./db.ts";
import { addressSet } from "../core/bindings.ts";
import { authorize, recordDecision, type Actor, type AuthzRequest } from "./policy.ts";

// The read request for attachment `idText`, judged by authorize(): `handle` may read it on a post on a board it can see,
// on a direct message it sent or received, or its own unsent upload. A
// session's files are its whole address set's (#284 S8): `principal` names
// the caller, whose session holding `handle` (or held by it) joins the set;
// null for the Slack bridge's humans, which have no session. `user` is the
// reading user's email, always set on a server: an unsent upload is readable
// only by the user who made it, not by whoever holds its address next (#367).
function readRequest(repo: Repo, db: CoreDb, handle: string, idText: string, principal: string | null, user: string) {
  const id = Number(idText);
  const row = Number.isInteger(id) && id > 0 ? getAttachment(db, id) : undefined;
  const addresses = addressSet(db, handle, principal);
  const dmVisible = (messageId: number) => participant(repo.messages.getById(messageId), addresses);
  const req: AuthzRequest = { verb: "attachment.read", identity: handle, attachment: idText.slice(0, 32), reach: row && attachmentReach(db, handle, row, dmVisible, { addresses, principal: user }) };
  return { row, req };
}

// A requested read (the download route's and its recheck, the Slack bridge's): the row if readable, with a refusal recorded as both
// its `attachment.download_refused` row and an `authz.decision` row (security audit F-01, #851). `detail` joins the
// first. Outside any transaction, so neither row needs deferring.
export function requestAttachment(repo: Repo, db: CoreDb, handle: string, idText: string, principal: string | null, actor: Actor & { user: string }, detail: Record<string, unknown> = {}): { row: AttachmentRow } | { refused: string } {
  const { row, req } = readRequest(repo, db, handle, idText, principal, actor.user);
  const d = authorize(repo, {}, req);
  // An allow has a row: authorize() refuses an attachment that doesn't exist.
  if (d.allow) return { row: row! };
  writeAudit(repo, "attachment.download_refused", actor.user, `attachment:${req.attachment}`, { identity: handle, ...detail });
  recordDecision(repo, actor, req, d, detail);
  return { refused: d.reason };
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
  const tx = queuedTx(repo);
  const row = await storeAttachment(db, repo.blobs, handle, file, { quota, guard, tx });
  try {
    guard?.();
    writeAudit(repo, "attachment.uploaded", email, `attachment:${row.id}`, {
      identity: handle, filename: row.filename, type: row.type, size: row.size, sha256: row.sha256, ...detail,
    });
    return row;
  } catch (error) {
    // Only this upload, and only while unbound; concurrent sends keep their bytes.
    if (guard) await releaseUpload(db, repo.blobs, row.id, { addresses: [handle], principal: email }, undefined, tx);
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
  const row = await releaseUpload(db, repo.blobs, id, { addresses: [handle], principal: email }, guard, queuedTx(repo));
  if (row) {
    writeAudit(repo, "attachment.released", email, `attachment:${row.id}`, {
      identity: handle, filename: row.filename, size: row.size, sha256: row.sha256, ...detail,
    });
  }
  return row;
}
