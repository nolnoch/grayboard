import { parseClientMessage, type ServerMessage, type ErrorCode } from "../shared/protocol.ts";
import type { AuthedUser } from "./auth.ts";
import { ApplicationError, type Application, type ApplicationOptions, type ApplicationSession, type DeliverySink } from "./application.ts";

export type WsData = {
  authed: AuthedUser;
  identityId: number;
  identityName: string;
  identityFull: string;
  ready: boolean;
  session?: ApplicationSession;
  onPong?: () => void;
};
export type Conn = {
  data: WsData;
  readonly readyState: number;
  send(data: string): unknown;
  close(): void;
};
export type WsOptions = ApplicationOptions;

function send(ws: Conn, message: ServerMessage) {
  ws.send(JSON.stringify(message));
}

function err(ws: Conn, reqId: string | undefined, code: ErrorCode, message: string) {
  send(ws, { type: "error", req_id: reqId, code, message });
}

// Transitional wire adapter. Operations and delivery ownership live in the application.
export function createWsHandlers(application: Application) {
  const handlers = {
    open(_ws: Conn) {},
    message(ws: Conn, rawData: string | Buffer) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawData.toString());
      } catch {
        err(ws, undefined, "bad_request", "invalid JSON");
        return;
      }
      let msg;
      try {
        msg = parseClientMessage(parsed);
      } catch (e) {
        const reqId = (parsed as { req_id?: unknown } | null)?.req_id;
        err(ws, typeof reqId === "string" ? reqId : undefined, "bad_request", String(e));
        return;
      }
      if (msg.type === "pong") {
        ws.data.onPong?.();
        return;
      }
      if (!ws.data.ready) {
        if (msg.type !== "hello") {
          err(ws, undefined, "bad_request", "send hello first");
          ws.close();
          return;
        }
        const sink: DeliverySink = {
          deliver(event) {
            send(ws, event.kind === "direct" ? { type: "push", message: event.message } : { type: "board_push", item: event.item });
          },
          closed(error) {
            err(ws, undefined, error.code, error.message);
            ws.close();
          },
          keepAlive() {
            if (ws.readyState === 1) send(ws, { type: "ping" });
          },
          probe(ms) {
            return new Promise(resolve => {
              const timer = setTimeout(() => {
                ws.data.onPong = undefined;
                resolve(false);
              }, ms);
              ws.data.onPong = () => {
                clearTimeout(timer);
                ws.data.onPong = undefined;
                resolve(true);
              };
              try {
                send(ws, { type: "ping" });
              } catch {
                clearTimeout(timer);
                ws.data.onPong = undefined;
                resolve(false);
              }
            });
          },
        };
        application.selectIdentity(ws.data.authed, msg.identity, sink, {
          ...msg,
          alive: () => ws.readyState === 1,
        }).then(({ session, info }) => {
          ws.data.session = session;
          ws.data.identityId = session.identityId;
          ws.data.identityName = session.identityName;
          ws.data.identityFull = session.identityFull;
          ws.data.ready = true;
          send(ws, { type: "hello_ok", req_id: msg.req_id, ...info });
          application.replay(session);
        }).catch(e => {
          if (!(e instanceof ApplicationError)) console.error("[grayboard] hello failed:", e);
          send(ws, { type: "error", req_id: msg.req_id, code: e instanceof ApplicationError ? e.code : "internal", message: e instanceof ApplicationError ? e.message : "hello failed", ...(e instanceof ApplicationError ? e.extra : {}) });
          ws.close();
        });
        return;
      }
      const session = ws.data.session!;
      try {
        switch (msg.type) {
          case "hello":
            err(ws, msg.req_id, "bad_request", "already authenticated");
            break;
          case "send":
            send(ws, { type: "send_ok", req_id: msg.req_id, ...application.send(session, msg.recipient, msg.body, msg) });
            break;
          case "delegate":
            send(ws, { type: "send_ok", req_id: msg.req_id, ...application.delegate(session, msg) });
            break;
          case "history":
            send(ws, { type: "history_ok", req_id: msg.req_id, messages: application.history(session, msg) });
            break;
          case "thread":
            send(ws, { type: "thread_ok", req_id: msg.req_id, messages: application.thread(session, msg.message_id) });
            break;
          case "inbox":
            send(ws, { type: "inbox_ok", req_id: msg.req_id, ...application.inbox(session, msg.days) });
            break;
          case "call":
            application.call(session, msg.tool, msg.args, result => send(ws, { type: "call_ok", req_id: msg.req_id, result }));
            break;
          case "ack":
            application.receiptDirect(session, msg.message_ids);
            send(ws, { type: "ack_ok", req_id: msg.req_id });
            break;
          case "board_ack":
            application.receiptBoards(session, msg.refs);
            send(ws, { type: "ack_ok", req_id: msg.req_id });
            break;
          case "dm_ack":
            application.acknowledgeDm(session, msg.message_id);
            send(ws, { type: "ack_ok", req_id: msg.req_id });
            break;
          case "dm_retract":
            application.retract(session, msg.message_id);
            send(ws, { type: "ack_ok", req_id: msg.req_id });
            break;
        }
      } catch (e) {
        if (!(e instanceof ApplicationError)) console.error(`[grayboard] ${msg.type} failed:`, e);
        err(ws, msg.req_id, e instanceof ApplicationError ? e.code : "internal", e instanceof ApplicationError ? e.message : `${msg.type} failed`);
      }
    },
    close(ws: Conn) {
      if (ws.data.session) application.close(ws.data.session);
      ws.data.onPong = undefined;
    },
  };
  return { handlers, startPing: () => setInterval(() => application.heartbeat(), 30_000) };
}
