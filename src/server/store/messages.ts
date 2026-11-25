// The messages store's row types and group interface (#807 P3 C5a, docs/future/postgres-server.md D2): direct and team
// messages, their acks and delivery stamps, which Repo (db.ts) composes and the Postgres store (pg/) implements.
// Type-only imports, so a module under pg/ may import it (pg/isolation.test.ts); db.ts re-exports every name.
import type { Uploader } from "../../core/attachments.ts";
import type { AttachmentInfo } from "../../shared/attachments.ts";
import type { Read, Tx } from "./tx_base.ts";

// attachments: present on reads when the message carries files.
// delivered_at: when it was handed to the recipient's harness; null until then, and for mail delivered before the column.
// via: the child session (a harness subagent, #523) that wrote it under its root's addresses; null for a root's own write.
export type MessageRow = { id: number; sender: string; recipient_type: "user" | "team"; recipient: string; body: string; parent_id: number | null; created_at: number; delivered_at: number | null; pending: number; kind: "bounce" | null; via: string | null; attachments?: AttachmentInfo[] };
// A message's files: upload ids and the uploader they must belong to (#391).
export type MessageFiles = { ids: number[]; uploader: Uploader };
// A post on a service's board (#270 D6): its author address, board and the board's scope.
export type ServicePost = { author: string; board: string; scope: string };
// What a retract did (#807 P3 C5 decision 4): "retracted"; "read", delivered or past the recipient's cursor; "replied",
// a reply exists; "gone", no direct message of that id from that sender. The store's checks decide, not the caller's
// pre-check, so a race the pre-check missed still gets the right refusal.
export type RetractResult = "retracted" | "read" | "replied" | "gone";

// Every read and write returns a promise (#807 P3 A6d2, A7i).
export interface MessagesStore {
  // files: unbound uploads (ids) of their uploader (the sending session's
  // address set, #284 PR 4 S5, and its user, #367), bound in the insert's
  // transaction; the ids and their uploader travel together, so the type
  // requires one with the other (#391). A refused id throws CoreError, and a
  // parent_id naming no message throws MissingParent (store/errors.ts), each
  // leaving no message row and no bind even when the caller catches it and
  // commits: the store refuses before it writes, or undoes its own write, so a
  // caller needs no savepoint (#807 P3 C5 decision 8). A backend refuses a
  // missing parent before it runs any statement that could abort the
  // transaction (Postgres: lock the parent by primary key with FOR KEY SHARE
  // first; a failed FK insert would leave the caller's commit to fail, so a
  // classified 23503 is only a backstop; contract row M5). senderId: the sending
  // session's ID (#284); null for a writer with no session. via: the child
  // session that wrote it (#523), else null. senderUser: the writer's
  // signed-in user (security audit F-10), kept out of reads like sender_id.
  // human: the DM bears the human mark (#1364), the caller having judged its
  // sender human in this transaction; false (the default) for every other.
  // Recorded, never shown on reads.
  insert(
    tx: Tx, sender: string, recipientType: "user" | "team", recipient: string, body: string, parentId: number | null, pending?: boolean,
    files?: MessageFiles, senderId?: string | null, via?: string | null, senderUser?: string | null, human?: boolean,
  ): Promise<MessageRow>;
  // The writer's signed-in user of each message and post that has one
  // recorded (rows from before F-10, bounces and system posts have none);
  // and of each post on a service's board (#270 D6), its author address and board, which wake.service_invoke judges.
  writerUsers(r: Read, messageIds: number[], postIds: number[]): Promise<{ messages: Map<number, string>; posts: Map<number, string>; servicePosts: Map<number, ServicePost> }>;
  // Which of these messages `delegate` wrote: each has a delegation.requested row targeting its recipient (#256).
  delegationIds(r: Read, messageIds: number[]): Promise<Set<number>>;
  // The row alone, without its attachments: an access or ack check.
  getById(r: Read, id: number): Promise<MessageRow | undefined>;
  // The bounces an ended session's end sent (#284 decision 4): an ID ends once.
  // since: only an end's own bounces, made at or after its time (a reopened ID can end again, #475).
  bouncesFrom(r: Read, id: string, since?: number): Promise<MessageRow[]>;
  // A session's direct messages, sent or received by any of its addresses
  // (#284 S8): with peer, only those between the set and peer. Newest first, at most 200.
  history(r: Read, addresses: string[], peer?: string, limit?: number, beforeId?: number): Promise<MessageRow[]>;
  // The whole thread containing the message, root to leaves, by id.
  thread(r: Read, id: number): Promise<MessageRow[]>;
  unreadSince(r: Read, streams: { type: "direct" | "team"; ref: string; since: number }[]): Promise<MessageRow[]>;
  // Direct messages to each of recipients still past its cursor, sent by
  // someone else; recipients with none are absent.
  queuedTo(r: Read, recipients: string[]): Promise<Map<string, number>>;
  // Direct messages from any of senders still past each recipient's cursor, per recipient.
  undeliveredFrom(r: Read, senders: string[], olderThan?: number): Promise<{ recipient: string; n: number; oldest_id: number }[]>;
  // Direct messages to any of readers since `since` that their recipient hasn't acked, oldest first.
  receivedUnacked(r: Read, readers: string[], since: number): Promise<MessageRow[]>;
  // Direct messages from any of senders since `since` sent pending and not acked by their sender, oldest first.
  sentPending(r: Read, senders: string[], since: number): Promise<MessageRow[]>;
  // Records reader's ack of a message that exists; a repeat, or an absent message, writes nothing.
  ack(tx: Tx, reader: string, id: number): Promise<void>;
  // A receipt's write (#1510 chunk 5): of `ids`, the direct messages to one of `recipients`, each stamped delivered_at
  // (unless `at` is null: given up, not handed; the first stamp stands), locked in id order (messages.prune's lock
  // order). Returns each such recipient's highest id, the point its direct cursor moves to; a missing id is skipped.
  deliver(tx: Tx, recipients: string[], ids: number[], at: number | null): Promise<Map<string, number>>;
  // Deletes a direct message from sender that's past the recipient's cursor
  // and has no reply, with its acks and attachments; anything else writes
  // nothing and says why (RetractResult). Audited as message.retracted in the
  // delete's transaction (#306), as local's retractMessage is, so every caller
  // writes the row a repeat is answered from.
  retract(tx: Tx, sender: string, id: number, by: { actor: string | null; session: string | null }): Promise<RetractResult>;
  // Deletes messages older than olderThanMs with their acks and attachments; their replies stay, as roots.
  prune(tx: Tx, olderThanMs: number): Promise<void>;
  // A session end's reads and writes (#807 P3 C10d2-a). The direct mail to `id` it never read: past its read point
  // and not sent by itself, acked or not, by id.
  unreadFor(tx: Tx, id: string): Promise<{ id: number; sender: string }[]>;
  // A bounce from `from` (the ended ID) to `to`, threaded under the bounced message `parentId`, at `now`: kind
  // 'bounce', never pending, never the human mark (#1364). The written row, or null when the parent is gone (on
  // Postgres a retract that committed first; the bounce locks the parent FOR KEY SHARE and writes nothing then).
  bounce(tx: Tx, from: string, to: string, parentId: number, body: string, now: number): Promise<MessageRow | null>;
  // Drops `id`'s read points (every stream) and its acks.
  dropReader(tx: Tx, id: string): Promise<void>;
}
