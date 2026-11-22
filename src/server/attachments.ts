// Who may read an attachment on the server: the HTTP download route and the
// Slack bridge's human identities ask the same question.
import { attachmentReachWith, withBlob, type AttachmentRow, type UploadQuota, type Uploader } from "../core/attachments.ts";
import { unboundCap, type AttachmentFile } from "../shared/attachments.ts";
import { writeAudit } from "./audit.ts";
import { sha256Hex } from "../shared/hash.ts";
import { participant, type Repo } from "./db.ts";
import type { Read } from "./store/tx.ts";
import { boardAccess } from "./access.ts";
import { testPauseAsync } from "../shared/testpause.ts";
import { visibleBoards } from "./board_reads.ts";
import { decidePure, recordDecision, type Actor, type PureRequest } from "./policy.ts";
import { atSite } from "./store/queue.ts";

// The read request for attachment `idText`, judged by policy.ts decidePure(): `handle` may read it on a post on a board it can see,
// on a direct message it sent or received, or its own unsent upload. A
// session's files are its whole address set's (#284 S8): `principal` names
// the caller, whose session holding `handle` (or held by it) joins the set;
// null for the Slack bridge's humans, which have no session. `user` is the
// reading user's email, always set on a server: an unsent upload is readable
// only by the user who made it, not by whoever holds its address next (#367).
// The carrier is read before core's attachmentReachWith rules on it: a message (#807 P3 A7i), or a post and its board's
// visibility on `r` (B5a1).
async function readRequest(repo: Repo, r: Read, handle: string, idText: string, principal: string | null, user: string) {
  const id = Number(idText);
  const row = Number.isInteger(id) && id > 0 ? await repo.attachments.get(r, id) : undefined;
  const addresses = await repo.bindings.addressSet(r, handle, principal);
  const carrier = row?.message_id != null ? await repo.messages.getById(r, row.message_id) : undefined;
  const dmVisible = (messageId: number) => {
    if (messageId !== row?.message_id) throw new Error(`readRequest: message ${messageId} is not the attachment's carrier`);
    return participant(carrier, addresses);
  };
  // A post carrier's board, judged for `handle` on `r` (#807 P3 B5a1).
  const post = row?.post_id != null ? await repo.boards.post(r, row.post_id) : undefined;
  const postSeen = post !== undefined && (await visibleBoards(repo, boardAccess(repo), r, handle, [post.board])).has(post.board);
  const postVisible = (postId: number) => {
    if (postId !== row?.post_id) throw new Error(`readRequest: post ${postId} is not the attachment's carrier`);
    return postSeen;
  };
  const req: PureRequest = { verb: "attachment.read", identity: handle, attachment: idText.slice(0, 32), reach: row && attachmentReachWith(row, postVisible, dmVisible, { addresses, principal: user }) };
  return { row, req };
}

// A requested read (the download route's and its recheck, the Slack bridge's): the row if readable, with a refusal recorded as both
// its `attachment.download_refused` row and an `authz.decision` row (security audit F-01, #851). `detail` joins the
// first. `r` is the caller's handle: `repo.read` for the download's first read and the Slack bridge's, the recheck body's `Tx`
// inside it. `writeAudit` joins an open transaction and queues otherwise, so neither row needs deferring.
export async function requestAttachment(repo: Repo, r: Read, handle: string, idText: string, principal: string | null, actor: Actor & { user: string }, detail: Record<string, unknown> = {}): Promise<{ row: AttachmentRow } | { refused: string }> {
  const { row, req } = await readRequest(repo, r, handle, idText, principal, actor.user);
  const d = decidePure({}, req);
  // An allow has a row: the rule refuses an attachment that doesn't exist.
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
  const row = await storeFile(repo, handle, file, quota, guard);
  try {
    // The guard and the audit row are one awaited write (#965): a failed audit row fails the upload, which is
    // released, rather than keeping bytes no `attachment.uploaded` row records.
    await atSite("attachments", () => repo.write(async w => {
      await guard?.(w);
      writeAudit(repo, w, "attachment.uploaded", email, `attachment:${row.id}`, {
        identity: handle, filename: row.filename, type: row.type, size: row.size, sha256: row.sha256, ...detail,
      });
    }));
    return row;
  } catch (error) {
    // Only this upload, and only while unbound; concurrent sends keep their bytes. Unguarded: the release is the
    // upload's own cleanup, not a fresh access.
    await releaseFile(repo, row.id, { addresses: [handle], principal: email });
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
  const row = await releaseFile(repo, id, { addresses: [handle], principal: email }, guard);
  if (row) {
    writeAudit(repo, repo.read, "attachment.released", email, `attachment:${row.id}`, {
      identity: handle, filename: row.filename, size: row.size, sha256: row.sha256, ...detail,
    });
  }
  return row;
}

// Core's storeAttachment, releaseUpload and sweepBlobs over the server's store (#807 P3 B3), in their order: the
// upload's row commits before its bytes are put, so a sweep never sees bytes no row names; a failed put drops the row;
// a sweep deletes the bytes before their catalog entry. Each blob's uploads and sweeps run one at a time in this
// process (core's withBlob, which local mode's share). `guard` runs on each flow's first body, the row's, and a
// refusal rolls it back.
async function storeFile(repo: Repo, uploader: string, file: AttachmentFile, quota: UploadQuota, guard?: Guard): Promise<AttachmentRow> {
  const now = Date.now();
  const sha256 = sha256Hex(file.data);
  let unnamed = false;
  try {
    return await withBlob(sha256, async () => {
      const added = await atSite("attachments", () => repo.write(async (tx) => {
        await guard?.(tx);
        return repo.attachments.insertUpload(tx, { sha256, filename: file.filename, type: file.type, size: file.data.length, uploader, quota, now });
      }));
      unnamed = added.pruned;
      try {
        // Put even when the catalog knew this sha256: it heals bytes a crash lost.
        await repo.blobs.put(sha256, file.data);
      } catch (e) {
        await atSite("attachments", () => repo.write((tx) => repo.attachments.remove(tx, added.row.id)));
        unnamed = true;
        throw e;
      }
      return added.row;
    });
  } finally {
    if (unnamed) await sweepStoredBlobs(repo);
  }
}

// One of `from`'s unsent uploads dropped, its bytes swept; null if it isn't theirs or a message or post carries it.
async function releaseFile(repo: Repo, id: number, from: Uploader, guard?: Guard): Promise<AttachmentRow | null> {
  const row = await atSite("attachments", () => repo.write(async (tx) => {
    await guard?.(tx);
    return (await repo.attachments.dropUnsent(tx, [id], from))[0] ?? null;
  }));
  if (row) await sweepStoredBlobs(repo);
  return row;
}

// Deletes the bytes, then the catalog entry, of every blob no attachment names. Never throws: a failure is logged and
// left for the next sweep. Returns how many went. `stopped`: the server's stop has begun (#1489), so the blobs not yet
// started are left; each blob's work is resumable, and the next sweep redoes it.
export async function sweepStoredBlobs(repo: Repo, stopped: () => boolean = () => false): Promise<number> {
  let shas: string[];
  try {
    shas = await repo.attachments.unnamedBlobs(repo.read);
  } catch (e) {
    console.error(`[grayboard] blob sweep: ${(e as Error).message}`);
    return 0;
  }
  await testPauseAsync("blobs:listed");
  let swept = 0;
  for (const sha256 of shas) {
    if (stopped()) break;
    try {
      await withBlob(sha256, async () => {
        if (await repo.attachments.named(repo.read, sha256)) return;
        await repo.blobs.delete(sha256);
        swept += await atSite("attachments", () => repo.write((tx) => repo.attachments.dropBlobEntry(tx, sha256)));
      });
    } catch (e) {
      console.error(`[grayboard] blob sweep: ${sha256}: ${(e as Error).message}`);
    }
  }
  return swept;
}
