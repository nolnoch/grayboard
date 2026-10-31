// The channel notification for a direct message or a board item: the post and
// pending-item shapes core delivers, and the one builder every mode and every
// hosted adapter renders them with. Free of Bun and SQLite, so hosted-core's
// Node build (adapters/hosted-core) can import it.
import { formatAttachmentsMeta, type AttachmentInfo } from "./attachments.ts";

export type Post = {
  id: number;
  board: string;
  author: string;
  body: string;
  parent_id: number | null;
  created_at: number;
  // An announcement's TTL; null (or absent, from older peers) otherwise.
  expires_at?: number | null;
  // Present on reads and pushes when the post carries files.
  attachments?: AttachmentInfo[];
};

export type Pending =
  | { kind: "push"; reason: "mention" | "thread" | "subscription"; post: Post; deferred?: true }
  | { kind: "digest"; board: string; unread: number; latest: Post };

export type DirectNotice = { id: number; sender: string; recipient?: string; body: string; parent_id: number | null; created_at: number; kind?: "bounce" | null; attachments?: AttachmentInfo[] };

// A message's or post's files, in its channel meta. attachment_get isn't
// alwaysLoad, so the notification that carries files names it; one without
// files costs nothing.
function addFiles(meta: Record<string, string>, list: AttachmentInfo[] | undefined): void {
  if (!list?.length) return;
  meta.attachments = formatAttachmentsMeta(list);
  meta.files_tool = "attachment_get(id, dir?) saves one; ids lead each item";
}

// The channel notification for a direct message. Same shape in every mode.
// `to` names the address the mail came to when it isn't the session's
// `primary` (#284 S4): a one-address session pays nothing for it.
export function dmNotification(msg: DirectNotice, primary?: string): { content: string; meta: Record<string, string> } {
  const meta: Record<string, string> = { message_id: String(msg.id), from: msg.sender, created_at: String(msg.created_at) };
  if (primary !== undefined && msg.recipient !== undefined && msg.recipient !== primary) meta.to = msg.recipient;
  if (msg.parent_id !== null) meta.parent_id = String(msg.parent_id);
  if (msg.kind) meta.kind = msg.kind;
  addFiles(meta, msg.attachments);
  return { content: msg.body, meta };
}

// The channel notification for a board item. Same shape in every mode.
export function boardNotification(item: Pending): { content: string; meta: Record<string, string> } {
  if (item.kind === "push") {
    const p = item.post;
    const meta: Record<string, string> = {
      board: p.board,
      post_id: String(p.id),
      from: p.author,
      reason: item.reason,
      created_at: String(p.created_at),
    };
    if (p.parent_id !== null) meta.parent_id = String(p.parent_id);
    addFiles(meta, p.attachments);
    if (item.deferred) meta.deferred = "true";
    return { content: p.body, meta };
  }
  const snippet = item.latest.body.replace(/\s+/g, " ").slice(0, 160);
  return {
    content: `#${item.board} has ${item.unread} unread post${item.unread === 1 ? "" : "s"}. Latest from ${item.latest.author}: "${snippet}${item.latest.body.length > 160 ? "…" : ""}" Call board_read if it's relevant.`,
    meta: { board: item.board, kind: "digest", unread: String(item.unread) },
  };
}
