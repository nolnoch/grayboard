import { parseClientMessage, type ServerMessage, type ErrorCode } from "../shared/protocol.ts";
import type { AuthedUser } from "./auth.ts";
import { ApplicationError, type Application, type ApplicationOptions, type ApplicationSession, type DeliverySink } from "./application.ts";

export { GRACE_MS, SWEEP_MS } from "./application.ts";

export type WsData = {
  authed: AuthedUser;
  ready: boolean;
  session?: ApplicationSession;
  onPong?: () => void;
  // Its hello is in flight: a second one is refused.
  helloing?: true;
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

function err(ws: Conn, reqId: string | undefined, code: ErrorCode, message: string, extra: ApplicationError["extra"] = {}) {
  send(ws, { type: "error", req_id: reqId, code, message, ...extra });
}

function sinkFor(ws: Conn): DeliverySink {
  return {
    deliver(event) {
      send(ws, event.kind === "direct" ? { type: "push", message: event.message } : { type: "board_push", item: event.item });
    },
    closed(error) {
      err(ws, undefined, error.code, error.message);
      ws.close();
    },
    aliasLost(alias, reason) {
      if (ws.readyState === 1) send(ws, { type: "alias_lost", alias, reason });
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
}

// The WSS wire adapter. Operations, sessions and delivery ownership live in
// the application (#402); this maps frames to them.
export function createWsHandlers(application: Application) {
  const refused = (ws: Conn, reqId: string | undefined, e: unknown, what: string) => {
    if (!(e instanceof ApplicationError)) console.error(`[grayboard] ${what} failed:`, e);
    if (e instanceof ApplicationError) err(ws, reqId, e.code, e.message, e.extra);
    else err(ws, reqId, "internal", `${what} failed`);
  };
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
        // Echo the req_id when there is one, or the client's call waits forever (#40).
        const reqId = (parsed as { req_id?: unknown } | null)?.req_id;
        err(ws, typeof reqId === "string" ? reqId : undefined, "bad_request", (e as Error).message);
        return;
      }
      if (msg.type === "pong") {
        ws.data.onPong?.();
        return;
      }
      if (ws.data.session?.ended) {
        err(ws, msg.req_id, "id_ended", `session ${ws.data.session.sessionId} has ended`);
        ws.close();
        return;
      }
      if (!ws.data.ready) {
        if (msg.type !== "hello") {
          err(ws, undefined, "bad_request", "send hello first");
          ws.close();
          return;
        }
        // A hello awaits a probe; a second one meanwhile would race it for the session.
        if (ws.data.helloing) {
          err(ws, msg.req_id, "bad_request", "a hello is already in flight on this connection");
          ws.close();
          return;
        }
        ws.data.helloing = true;
        const { type: _t, req_id: _r, proto: _p, ...hello } = msg;
        application.hello(ws.data.authed, sinkFor(ws), { ...hello, alive: () => ws.readyState === 1 }).then(({ session, ok }) => {
          ws.data.session = session;
          ws.data.ready = true;
          // The connection closed while the hello answered: its session closes too.
          if (ws.readyState !== 1) return application.close(session);
          send(ws, { type: "hello_ok", req_id: msg.req_id, ...ok });
          application.replay(session);
        }).catch(e => {
          refused(ws, msg.req_id, e, "hello");
          ws.close();
        });
        return;
      }
      const session = ws.data.session!;
      // A connection superseded, revoked or closed has left the application;
      // a frame already in flight on it must not act for the session.
      try {
        application.revalidateSession(session, true);
      } catch (e) {
        refused(ws, msg.req_id, e, msg.type);
        ws.close();
        return;
      }
      if (msg.type === "bind") {
        const { type: _t, req_id: _r, ...bind } = msg;
        application.bind(session, bind).then(ok => {
          send(ws, { type: "bind_ok", req_id: msg.req_id, ...ok });
          // Its mail and boards after the answer, as a hello's are.
          application.replay(session, [ok.alias]);
        }).catch(e => refused(ws, msg.req_id, e, "bind"));
        return;
      }
      try {
        switch (msg.type) {
          case "hello":
            err(ws, msg.req_id, "bad_request", "already authenticated");
            break;
          case "unbind":
            send(ws, { type: "unbind_ok", req_id: msg.req_id, ...application.unbind(session, msg.alias) });
            break;
          case "end":
            application.end(session);
            send(ws, { type: "end_ok", req_id: msg.req_id });
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
            send(ws, { type: "ack_ok", req_id: msg.req_id, ...application.retract(session, msg.message_id) });
            break;
        }
      } catch (e) {
        refused(ws, msg.req_id, e, msg.type);
      }
    },
    close(ws: Conn) {
      if (ws.data.session) application.close(ws.data.session);
      ws.data.onPong = undefined;
    },
  };
  return { handlers, startPing: () => setInterval(() => application.heartbeat(), 30_000) };
}
