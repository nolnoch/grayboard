// Who may read an attachment on the server: the HTTP download route and the
// Slack bridge's human identities ask the same question.
import { canReadAttachment, getAttachment, type AttachmentRow } from "../core/attachments.ts";
import type { CoreDb } from "../core/boards.ts";
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
