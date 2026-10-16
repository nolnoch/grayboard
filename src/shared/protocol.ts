import type { Pending, PendingRef } from "../core/boards.ts";
import type { InboxItem } from "./inbox.ts";

export type Message = {
  id: number;
  sender: string;
  recipient_type: "user" | "team";
  recipient: string;
  body: string;
  parent_id: number | null;
  created_at: number;
};

// Client -> Server
// push: false is a tools-only connection beside the session that owns the
// identity (a harness that can't show pushes): no pushes, not "online".
// where: the client's describeLocation (the server can't see its files).
// resume: a reconnect within one session, so its peer_status stays.
export type HelloRequest   = { type: "hello";   req_id: string; identity: string; push?: boolean; where?: string; resume?: boolean };
export type SendRequest    = { type: "send";    req_id: string; recipient: string; body: string; parent_id?: number };
export type HistoryRequest = { type: "history"; req_id: string; peer?: string; limit?: number; before_id?: number };
export type ThreadRequest  = { type: "thread";  req_id: string; message_id: number };
export type AckRequest     = { type: "ack";     req_id: string; message_ids: number[] };
export type PongMessage    = { type: "pong" };
export type InboxRequest   = { type: "inbox";   req_id: string; days?: number };
export type DmAckRequest   = { type: "dm_ack";  req_id: string; message_id: number };
// Board and claim tools (src/core/tools.ts), run server-side as this identity.
export type CallRequest    = { type: "call";      req_id: string; tool: string; args: Record<string, unknown> };
export type BoardAckRequest = { type: "board_ack"; req_id: string; refs: PendingRef[] };

export type ClientMessage =
  | HelloRequest | SendRequest | HistoryRequest | ThreadRequest | AckRequest | PongMessage
  | CallRequest | BoardAckRequest | InboxRequest | DmAckRequest;

// Server -> Client
export type HelloOk     = {
  type: "hello_ok"; req_id: string; identity_full: string; user_email: string; teams: string[];
  // Sentences for the session's MCP instructions: active claims, and direct
  // messages you sent that still haven't arrived a day later.
  notices?: string[];
};
export type SendOk      = {
  type: "send_ok"; req_id: string; message_id: number; delivered_now: boolean;
  // When not delivered now: the recipient's last session, e.g. "14d ago", and
  // how many of your messages are queued for them, this one included.
  recipient_last_seen?: string; undelivered_from_you?: number;
};
// Messages you sent carry delivered: whether they've reached the recipient's session.
export type HistoryOk   = { type: "history_ok"; req_id: string; messages: (Message & { delivered?: boolean })[] };
export type ThreadOk    = { type: "thread_ok";  req_id: string; messages: Message[] };
export type AckOk       = { type: "ack_ok";     req_id: string };
export type InboxOk     = {
  type: "inbox_ok"; req_id: string; unanswered: InboxItem[];
  undelivered_from_you?: { to: string; n: number; oldest_id: number; last_seen?: string }[];
};
export type PushMessage = { type: "push"; message: Message };
export type PingMessage = { type: "ping" };
export type CallOk      = { type: "call_ok";    req_id: string; result: unknown };
export type BoardPush   = { type: "board_push"; item: Pending };
export type ErrorMessage = { type: "error"; req_id?: string; code: ErrorCode; message: string };

export type ServerMessage =
  | HelloOk | SendOk | HistoryOk | ThreadOk | AckOk | PushMessage | PingMessage | ErrorMessage
  | CallOk | BoardPush | InboxOk;

export type ErrorCode =
  | "unauthenticated" | "forbidden" | "bad_request" | "not_found"
  | "rate_limited" | "internal" | "superseded"
  // hello refused: another live connection holds this identity
  | "identity_in_use";

export function parseClientMessage(raw: unknown): ClientMessage {
  if (typeof raw !== "object" || raw === null) throw new Error("expected object");
  const m = raw as Record<string, unknown>;

  switch (m.type) {
    case "hello":
      assertStr(m, "req_id"); assertStr(m, "identity");
      if (m.push !== undefined && typeof m.push !== "boolean") throw new Error("push must be boolean");
      if (m.resume !== undefined && typeof m.resume !== "boolean") throw new Error("resume must be boolean");
      if (m.where !== undefined && typeof m.where !== "string") throw new Error("where must be a string");
      return m as unknown as HelloRequest;
    case "send":
      assertStr(m, "req_id"); assertStr(m, "recipient"); assertStr(m, "body");
      if (m.parent_id !== undefined && typeof m.parent_id !== "number")
        throw new Error("parent_id must be number");
      return m as unknown as SendRequest;
    case "history":
      assertStr(m, "req_id");
      if (m.peer !== undefined && typeof m.peer !== "string") throw new Error("peer must be string");
      if (m.limit !== undefined && typeof m.limit !== "number") throw new Error("limit must be number");
      if (m.before_id !== undefined && typeof m.before_id !== "number") throw new Error("before_id must be number");
      return m as unknown as HistoryRequest;
    case "thread":
      assertStr(m, "req_id");
      if (typeof m.message_id !== "number") throw new Error("message_id must be number");
      return m as unknown as ThreadRequest;
    case "ack":
      assertStr(m, "req_id");
      if (!Array.isArray(m.message_ids) || !m.message_ids.every(x => typeof x === "number"))
        throw new Error("message_ids must be number[]");
      return m as unknown as AckRequest;
    case "pong":
      return { type: "pong" };
    case "inbox":
      assertStr(m, "req_id");
      if (m.days !== undefined && typeof m.days !== "number") throw new Error("days must be number");
      return m as unknown as InboxRequest;
    case "dm_ack":
      assertStr(m, "req_id");
      if (typeof m.message_id !== "number") throw new Error("message_id must be number");
      return m as unknown as DmAckRequest;
    case "call":
      assertStr(m, "req_id"); assertStr(m, "tool");
      if (m.args !== undefined && (typeof m.args !== "object" || m.args === null || Array.isArray(m.args)))
        throw new Error("args must be an object");
      return { type: "call", req_id: m.req_id as string, tool: m.tool as string, args: (m.args ?? {}) as Record<string, unknown> };
    case "board_ack":
      assertStr(m, "req_id");
      if (!Array.isArray(m.refs) || !m.refs.every(isPendingRef)) throw new Error("refs must be PendingRef[]");
      return m as unknown as BoardAckRequest;
    default:
      throw new Error(`unknown message type: ${String(m.type)}`);
  }
}

function isPendingRef(r: unknown): r is PendingRef {
  if (typeof r !== "object" || r === null) return false;
  const x = r as Record<string, unknown>;
  if (x.kind === "push") return typeof x.post_id === "number";
  if (x.kind === "digest") return typeof x.board === "string" && typeof x.latest_id === "number";
  return false;
}

function assertStr(m: Record<string, unknown>, key: string) {
  if (typeof m[key] !== "string") throw new Error(`${key} must be string`);
}
