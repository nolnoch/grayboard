import { PROTO, PROTO_REFUSAL, UPGRADE_REFUSAL, type ErrorMessage } from "../shared/protocol.ts";

// Open refusal sockets one address may hold. The handler is unauthenticated, so
// it is bounded: a restarted fleet reconnecting at once is not a flood.
export const MAX_REFUSAL_SOCKETS = 16;

export type RefusalData = { key: string };
type Conn = { data: RefusalData; send(data: string): unknown; close(): void };

// No session, hub or database: it reads one frame, answers it and closes.
export function createWsRefusal(max = MAX_REFUSAL_SOCKETS, idleSeconds = 10) {
  const open = new Map<string, number>();
  const release = (key: string) => {
    const n = (open.get(key) ?? 1) - 1;
    if (n <= 0) open.delete(key); else open.set(key, n);
  };
  // One log line per address a minute: an operator sees which clients still dial the removed transport, and a flood costs one line.
  const logged = new Map<string, number>();
  const note = (key: string, code: string) => {
    const now = Date.now();
    if (now - (logged.get(key) ?? 0) < 60_000) return;
    if (logged.size > 1024) logged.clear();
    logged.set(key, now);
    console.error(`[grayboard] refused a WebSocket client from ${key}: ${code}`);
  };
  const answer = (ws: Conn, error: Omit<ErrorMessage, "type">) => {
    note(ws.data.key, error.code);
    ws.send(JSON.stringify({ type: "error", ...error } satisfies ErrorMessage));
    ws.close();
  };
  return {
    // Counted at the upgrade, before `server.upgrade`; released by `close`. False: refuse the upgrade.
    admit(key: string): boolean {
      const n = open.get(key) ?? 0;
      if (n >= max) return false;
      open.set(key, n + 1);
      return true;
    },
    // An upgrade `server.upgrade` did not take: give the slot back.
    release,
    get openAddresses() { return open.size; },
    handlers: {
      idleTimeout: idleSeconds,
      // Bun's default pings keep a silent client's socket alive past idleTimeout (measured on 1.4.4); without them a socket that sends no hello closes at the deadline.
      sendPings: false,
      maxPayloadLength: 8192,
      closeOnBackpressureLimit: true,
      open(_ws: Conn) {},
      message(ws: Conn, raw: string | Buffer) {
        let frame: { type?: unknown; req_id?: unknown; proto?: unknown } | null;
        try { frame = JSON.parse(raw.toString()); } catch { frame = null; }
        if (typeof frame !== "object" || frame === null || frame.type !== "hello") { note(ws.data.key, "not_a_hello"); ws.close(); return; }
        const req_id = typeof frame.req_id === "string" ? frame.req_id : undefined;
        if (frame.proto === PROTO) answer(ws, { req_id, code: "upgrade_required", message: UPGRADE_REFUSAL });
        else answer(ws, { req_id, code: "bad_request", message: PROTO_REFUSAL });
      },
      close(ws: Conn) { release(ws.data.key); },
    },
  };
}
