// Who may read an attachment on the server: the HTTP download route and the
// Slack bridge's human identities ask the same question.
import { attachmentReach, getAttachment, releaseUpload, storeAttachment, type AttachmentRow } from "../core/attachments.ts";
import { unboundCap, type AttachmentFile } from "../shared/attachments.ts";
import { writeAudit } from "./audit.ts";
import { participant, queuedGuardTx, queuedTx, type Repo } from "./db.ts";
import type { Read } from "./store/tx.ts";
import { addressSet } from "../core/bindings.ts";
import { authorize, recordDecision, type Actor, type AuthzRequest } from "./policy.ts";

// The read request for attachment `idText`, judged by authorize(): `handle` may read it on a post on a board it can see,
// on a direct message it sent or received, or its own unsent upload. A
// session's files are its whole address set's (#284 S8): `principal` names
// the caller, whose session holding `handle` (or held by it) joins the set;
// null for the Slack bridge's humans, which have no session. `user` is the
// reading user's email, always set on a server: an unsent upload is readable
// only by the user who made it, not by whoever holds its address next (#367).
function readRequest(repo: Repo, r: Read, handle: string, idText: string, principal: string | null, user: string) {
  const db = repo.coreOn(r);
  const id = Number(idText);
  const row = Number.isInteger(id) && id > 0 ? getAttachment(db, id) : undefined;
  const addresses = addressSet(db, handle, principal);
  const dmVisible = (messageId: number) => participant(repo.messages.getById(r, messageId), addresses);
  const req: AuthzRequest = { verb: "attachment.read", identity: handle, attachment: idText.slice(0, 32), reach: row && attachmentReach(db, handle, row, dmVisible, { addresses, principal: user }) };
  return { row, req };
}

// A requested read (the download route's and its recheck, the Slack bridge's): the row if readable, with a refusal recorded as both
// its `attachment.download_refused` row and an `authz.decision` row (security audit F-01, #851). `detail` joins the
// first. `r` is the caller's handle: `repo.read` for the download's first read and the Slack bridge's, the recheck body's `Tx`
// inside it. `writeAudit` joins an open transaction and queues otherwise, so neither row needs deferring.
export function requestAttachment(repo: Repo, r: Read, handle: string, idText: string, principal: string | null, actor: Actor & { user: string }, detail: Record<string, unknown> = {}): { row: AttachmentRow } | { refused: string } {
  const { row, req } = readRequest(repo, r, handle, idText, principal, actor.user);
  const d = authorize(repo, {}, req);
  // An allow has a row: authorize() refuses an attachment that doesn't exist.
  if (d.allow) return { row: row! };
  writeAudit(repo, r, "attachment.download_refused", actor.user, `attachment:${req.attachment}`, { identity: handle, ...detail });
  recordDecision(repo, r, actor, req, d, detail);
  return { refused: d.reason };
}

// An attachment route's guard (the hosted byte routes' OAuth recheck, binding fence and alias check, #1053): it reads on `r`, the handle of the context it runs in: the pool
// between transactions, a body's own Tx inside one, so it never takes a second connection while a body holds one.
export type Guard = (r: Read) => void | Promise<void>;

// Stores a checked file as an unsent upload of `handle`'s, within the quotas
// of its principal, the user `email` (unsent bytes, and stored bytes in all),
// and audits it. The HTTP upload route and the Slack app's in-process sends
// both store this way. Each runs outside any write body: its transactions
// queue behind the others, and its reads outside them are the pool's.
export async function storeUpload(
  repo: Repo,
  email: string,
  handle: string,
  file: AttachmentFile,
  detail: Record<string, unknown> = {},
  guard?: Guard,
): Promise<AttachmentRow> {
  const quota = { principal: email, unsent: unboundCap(repo.attachmentLimits), stored: repo.attachmentUserQuota };
  const inBody = queuedGuardTx(repo, guard);
  const tx = inBody.tx;
  const pool = repo.coreOn(repo.read);
  const row = await storeAttachment(pool, repo.blobs, handle, file, { quota, guard: inBody.guard, tx });
  try {
    // The guard and the audit row are one awaited write (#965): a failed audit row fails the upload, which is
    // released, rather than keeping bytes no `attachment.uploaded` row records.
    await repo.write(async w => {
      await guard?.(w);
      writeAudit(repo, w, "attachment.uploaded", email, `attachment:${row.id}`, {
        identity: handle, filename: row.filename, type: row.type, size: row.size, sha256: row.sha256, ...detail,
      });
    });
    return row;
  } catch (error) {
    // Only this upload, and only while unbound; concurrent sends keep their bytes. Unguarded, so through the plain
    // queue: the guarded one would run the guard again in each of its bodies (queuedGuardTx).
    await releaseUpload(pool, repo.blobs, row.id, { addresses: [handle], principal: email }, undefined, queuedTx(repo));
    throw error;
  }
}

// Drops one of `handle`'s unsent uploads and audits it, for a send that
// failed after uploading. Null if it isn't theirs or is already sent.
export async function releaseStored(
  repo: Repo,
  email: string,
  handle: string,
  id: number,
  detail: Record<string, unknown> = {},
  guard?: Guard,
): Promise<AttachmentRow | null> {
  const inBody = queuedGuardTx(repo, guard);
  const row = await releaseUpload(repo.coreOn(repo.read), repo.blobs, id, { addresses: [handle], principal: email }, inBody.guard, inBody.tx);
  if (row) {
    writeAudit(repo, repo.read, "attachment.released", email, `attachment:${row.id}`, {
      identity: handle, filename: row.filename, size: row.size, sha256: row.sha256, ...detail,
    });
  }
  return row;
}
