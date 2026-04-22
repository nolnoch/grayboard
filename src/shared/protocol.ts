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
export type HelloRequest   = { type: "hello";   req_id: string; identity: string };
export type SendRequest    = { type: "send";    req_id: string; recipient: string; body: string; parent_id?: number };
export type HistoryRequest = { type: "history"; req_id: string; peer?: string; limit?: number; before_id?: number };
export type ThreadRequest  = { type: "thread";  req_id: string; root_id: number };
export type AckRequest     = { type: "ack";     req_id: string; message_ids: number[] };
export type PongMessage    = { type: "pong" };

export type ClientMessage = HelloRequest | SendRequest | HistoryRequest | ThreadRequest | AckRequest | PongMessage;

// Server -> Client
export type HelloOk     = { type: "hello_ok";   req_id: string; identity_full: string; user_email: string; teams: string[] };
export type SendOk      = { type: "send_ok";    req_id: string; message_id: number; delivered_now: boolean };
export type HistoryOk   = { type: "history_ok"; req_id: string; messages: Message[] };
export type ThreadOk    = { type: "thread_ok";  req_id: string; messages: Message[] };
export type AckOk       = { type: "ack_ok";     req_id: string };
export type PushMessage = { type: "push"; message: Message };
export type PingMessage = { type: "ping" };
export type ErrorMessage = { type: "error"; req_id?: string; code: ErrorCode; message: string };

export type ServerMessage = HelloOk | SendOk | HistoryOk | ThreadOk | AckOk | PushMessage | PingMessage | ErrorMessage;

export type ErrorCode =
  | "unauthenticated" | "forbidden" | "bad_request" | "not_found"
  | "rate_limited" | "internal" | "superseded";

export function parseClientMessage(raw: unknown): ClientMessage {
  if (typeof raw !== "object" || raw === null) throw new Error("expected object");
  const m = raw as Record<string, unknown>;

  switch (m.type) {
    case "hello":
      assertStr(m, "req_id"); assertStr(m, "identity");
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
      if (typeof m.root_id !== "number") throw new Error("root_id must be number");
      return m as unknown as ThreadRequest;
    case "ack":
      assertStr(m, "req_id");
      if (!Array.isArray(m.message_ids) || !m.message_ids.every(x => typeof x === "number"))
        throw new Error("message_ids must be number[]");
      return m as unknown as AckRequest;
    case "pong":
      return { type: "pong" };
    default:
      throw new Error(`unknown message type: ${String(m.type)}`);
  }
}

function assertStr(m: Record<string, unknown>, key: string) {
  if (typeof m[key] !== "string") throw new Error(`${key} must be string`);
}
