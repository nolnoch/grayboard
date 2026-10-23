import { age } from "../core/boards.ts";
import { CoreError } from "../core/errors.ts";
import type { AttachmentInfo } from "./attachments.ts";

type Msg = { id: number; sender: string; recipient: string; body: string; parent_id: number | null; created_at: number; attachments?: AttachmentInfo[] };

export type InboxItem = { id: number; from: string; parent_id?: number; age: string; body: string; attachments?: AttachmentInfo[] };
export type PromiseItem = { id: number; to: string; parent_id?: number; age: string; body: string; attachments?: AttachmentInfo[] };

export const INBOX_DAYS = 3;
export const MAX_INBOX_DAYS = 30;
// Promises don't age out with the days argument; they stay until kept or acked.
export const PROMISE_DAYS = MAX_INBOX_DAYS;
const SNIPPET = 300;

// Candidates with no later message from `me` in the same thread.
function lastWord<M extends Msg>(me: string, candidates: M[], threadOf: (id: number) => Msg[]): M[] {
  const threadById = new Map<number, Msg[]>();
  return candidates.filter((m) => {
    let t = threadById.get(m.id);
    if (!t) {
      t = threadOf(m.id);
      for (const x of t) threadById.set(x.id, t);
    }
    return !t.some((x) => x.sender === me && x.id > m.id);
  });
}

function item(m: Msg, now: number) {
  return {
    ...(m.parent_id !== null ? { parent_id: m.parent_id } : {}),
    age: age(now - m.created_at),
    body: m.body.length > SNIPPET ? `${m.body.slice(0, SNIPPET)}… (dm_thread for the rest)` : m.body,
    ...(m.attachments ? { attachments: m.attachments } : {}),
  };
}

// Received messages still owed an answer: no later message from `me` in the
// same thread. Candidates are already windowed and filtered of acks.
export function unanswered(me: string, candidates: Msg[], threadOf: (id: number) => Msg[], now = Date.now()): InboxItem[] {
  return lastWord(me, candidates, threadOf).map((m) => ({ id: m.id, from: m.sender, ...item(m, now) }));
}

// Messages `me` sent pending that are still its latest in their thread: a
// follow-up it promised. Candidates are `me`'s pending sends, windowed by
// PROMISE_DAYS and filtered of its own acks.
export function promised(me: string, candidates: Msg[], threadOf: (id: number) => Msg[], now = Date.now()): PromiseItem[] {
  return lastWord(me, candidates, threadOf).map((m) => ({ id: m.id, to: m.recipient, ...item(m, now) }));
}

// pending is stored as 0/1; rows show it only when set, so history and
// threads don't pay for it on every message.
export function showPending<M extends { pending: number | boolean }>(m: M): Omit<M, "pending"> & { pending?: true } {
  const { pending, ...rest } = m;
  return pending ? { ...rest, pending: true } : rest;
}

// dm_history's limit, checked alike in both modes (#75).
export function historyLimit(limit: unknown): number {
  if (limit === undefined || limit === null) return 20;
  if (typeof limit !== "number" || !Number.isFinite(limit)) throw new CoreError("limit must be a number");
  return Math.min(Math.max(Math.floor(limit), 1), 200);
}

export function inboxDays(days: unknown): number {
  if (days === undefined || days === null) return INBOX_DAYS;
  if (typeof days !== "number" || !(days > 0) || days > MAX_INBOX_DAYS) {
    throw new CoreError(`days must be in (0, ${MAX_INBOX_DAYS}]`);
  }
  return days;
}

export const DM_INBOX_INSTRUCTION =
  `Pushes don't survive /clear: after one, or a restart, dm_inbox() lists direct messages you haven't answered or acked, and follow-ups you promised.`;

export const DM_INBOX_TOOL = {
  name: "dm_inbox",
  _meta: { "anthropic/alwaysLoad": true },
  description:
    `dm_inbox(days?): direct messages to you from the last days (default ${INBOX_DAYS}) with no later message from you in their thread and no dm_ack, plus your messages still queued for offline peers, plus follow-ups you promised (sent pending; from the last ${PROMISE_DAYS} days, ignoring days). Use after /clear to see what you owe.`,
  inputSchema: {
    type: "object",
    properties: { days: { type: "number", description: `Look back this many days (default ${INBOX_DAYS}, max ${MAX_INBOX_DAYS}).` } },
  },
};

// dm_send's pending parameter, the same in both modes.
export const PENDING_PARAM = {
  type: "boolean",
  description: "Optional. true: you owe them a follow-up. dm_inbox lists it under promised until your next message in the thread.",
};

export const DM_ACK_TOOL = {
  name: "dm_ack",
  _meta: { "anthropic/alwaysLoad": true },
  description: "dm_ack(message_id): mark direct messages to you handled without a reply in their thread (an FYI, or ones a combined reply covered), so dm_inbox drops them; or a pending message you sent, to drop that promise.",
  inputSchema: {
    type: "object",
    properties: {
      message_id: {
        anyOf: [{ type: "number" }, { type: "array", items: { type: "number" } }],
        description: "A message_id, or a list of them.",
      },
    },
    required: ["message_id"],
  },
};

// dm_ack's message_id as a list of ids, or null if it isn't a number or a
// non-empty list of numbers.
export function ackIds(arg: unknown): number[] | null {
  const ids = Array.isArray(arg) ? arg : [arg];
  return ids.length && ids.every((x) => typeof x === "number") ? [...new Set(ids as number[])] : null;
}

// One message is "ok" or the error; a list reports what it couldn't ack,
// failing only when nothing was.
export function ackResult(acked: number[], missing: number[]): { text: string; isError: boolean } {
  if (!missing.length) return { text: "ok", isError: false };
  const why = `no message ${missing.join(", ")} to you or pending from you; dm_inbox lists them`;
  return acked.length
    ? { text: JSON.stringify({ acked, not_found: missing, note: why }), isError: false }
    : { text: `error: ${why}`, isError: true };
}

// Sent direct messages still queued a day later, so a stale "told them" in a
// handoff gets caught when the session starts.
export const STALE_UNDELIVERED_MS = 86_400_000;

export function undeliveredInstruction(
  stale: { recipient: string; n: number; oldest_id: number }[],
  lastSeen: (handle: string) => number | null,
  now = Date.now(),
): string[] {
  if (stale.length === 0) return [];
  const list = stale
    .map((u) => {
      const seen = lastSeen(u.recipient);
      return `${u.recipient}: ${u.n} since message_id ${u.oldest_id}${seen ? ` (last seen ${age(now - seen)} ago)` : ""}`;
    })
    .join("; ");
  return [`Direct messages you sent that still haven't reached the recipient after 24h: ${list}. Don't count them as read.`];
}

// A queued message to a handle idle this long is likely a misaddress (a live
// peer under another handle), so the send result says so and names the undo.
export const STALE_RECIPIENT_MS = 3_600_000;

export function queuedNote(recipient: string, seen: number | null, now = Date.now()): string {
  if (seen !== null && now - seen < STALE_RECIPIENT_MS) return "Recipient offline; will be delivered on their next session.";
  const when = seen === null ? "has never connected" : `last seen ${age(now - seen)} ago`;
  return `Queued: ${recipient} ${when}. If you meant a live peer, check peer_list; dm_retract undoes this.`;
}

// Not alwaysLoad: queuedNote names it when it's relevant.
export const DM_RETRACT_TOOL = {
  name: "dm_retract",
  description:
    "dm_retract(message_id): delete a direct message you sent that is still queued (the recipient is offline and hasn't received it). Refused once it has reached them or has a reply.",
  inputSchema: {
    type: "object",
    properties: { message_id: { type: "number", description: "The message_id dm_send returned." } },
    required: ["message_id"],
  },
};

export const retractRefusal = {
  notYours: (id: number) => `no message ${id} from you`,
  reached: (id: number, to: string) => `message ${id} already reached ${to}; send a correction instead`,
  replied: (id: number) => `message ${id} has a reply in its thread; send a correction instead`,
};
