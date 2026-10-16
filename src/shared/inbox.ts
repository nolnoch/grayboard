import { CoreError, age } from "../core/boards.ts";

type Msg = { id: number; sender: string; body: string; parent_id: number | null; created_at: number };

export type InboxItem = { id: number; from: string; parent_id?: number; age: string; body: string };

export const INBOX_DAYS = 3;
export const MAX_INBOX_DAYS = 30;
const SNIPPET = 300;

// Received messages still owed an answer: no later message from `me` in the
// same thread. Candidates are already windowed and filtered of acks.
export function unanswered(me: string, candidates: Msg[], threadOf: (id: number) => Msg[], now = Date.now()): InboxItem[] {
  const threadById = new Map<number, Msg[]>();
  const out: InboxItem[] = [];
  for (const m of candidates) {
    let t = threadById.get(m.id);
    if (!t) {
      t = threadOf(m.id);
      for (const x of t) threadById.set(x.id, t);
    }
    if (t.some((x) => x.sender === me && x.id > m.id)) continue;
    out.push({
      id: m.id,
      from: m.sender,
      ...(m.parent_id !== null ? { parent_id: m.parent_id } : {}),
      age: age(now - m.created_at),
      body: m.body.length > SNIPPET ? `${m.body.slice(0, SNIPPET)}… (dm_thread for the rest)` : m.body,
    });
  }
  return out;
}

export function inboxDays(days: unknown): number {
  if (days === undefined || days === null) return INBOX_DAYS;
  if (typeof days !== "number" || !(days > 0) || days > MAX_INBOX_DAYS) {
    throw new CoreError(`days must be in (0, ${MAX_INBOX_DAYS}]`);
  }
  return days;
}

export const DM_INBOX_INSTRUCTION =
  `Pushes don't survive /clear: after one, or a restart, dm_inbox() lists direct messages you haven't answered or acked.`;

export const DM_INBOX_TOOL = {
  name: "dm_inbox",
  _meta: { "anthropic/alwaysLoad": true },
  description:
    `dm_inbox(days?): direct messages to you from the last days (default ${INBOX_DAYS}) with no later message from you in their thread and no dm_ack, plus your messages still queued for offline peers. Use after /clear to see what you owe.`,
  inputSchema: {
    type: "object",
    properties: { days: { type: "number", description: `Look back this many days (default ${INBOX_DAYS}, max ${MAX_INBOX_DAYS}).` } },
  },
};

export const DM_ACK_TOOL = {
  name: "dm_ack",
  description: "dm_ack(id): mark a direct message to you handled without replying (an FYI), so dm_inbox drops it.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "number", description: "The message_id." } },
    required: ["id"],
  },
};

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
