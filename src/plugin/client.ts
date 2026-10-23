import type { ServerMessage, ClientMessage, HelloOk, Message } from "../shared/protocol.ts";
import { refOf, type Pending } from "../core/boards.ts";
import { describeLocation } from "../shared/identity.ts";

// Server tool calls are single DB transactions; one unanswered this long never will be.
const REQUEST_TIMEOUT_MS = 30_000;

// Both resolve once the item has been handed to the agent; it's acked after
// that, so a failed handoff is resent on the next connection.
export type PushCallback = (msg: Message) => Promise<void>;
export type BoardPushCallback = (item: Pending) => Promise<void>;
export type ReadyCallback = (data: HelloOk) => void;

export class GrayboardClient {
  private ws: WebSocket | null = null;
  private backoffMs = 1000;
  private counter   = 0;
  private pending   = new Map<string, { resolve: (m: ServerMessage) => void; reject: (e: Error) => void }>();
  private dead      = false; // set on superseded; do not reconnect

  private helloData: HelloOk | null = null;
  private refused: string | null = null; // set while the server refuses our token
  private wasReady  = false; // a later hello is a reconnect, not a new session
  private helloId   = "";    // the req_id of this connection's hello
  private readyResolvers: Array<(err?: Error) => void> = [];

  constructor(
    private readonly serverUrl: string,
    // Read on each connect, so signing in again takes effect on the next reconnect.
    private readonly token: () => string,
    private readonly identity: string,
    private readonly onPush: PushCallback,
    private readonly onBoardPush: BoardPushCallback,
    // false: a tools-only connection that never receives pushes.
    private readonly push = true,
    // What to say when the server refuses the token: at startup (fatal), or
    // in tool results while a running session waits to reconnect.
    private readonly refusedMessage = (_running: boolean) => "the grayboard server refused this session's token; sign in again",
  ) {}

  /** Resolves once hello_ok is received. Rejects if the client dies first. */
  ready(): Promise<HelloOk> {
    if (this.helloData) return Promise.resolve(this.helloData);
    return new Promise<HelloOk>((resolve, reject) => {
      this.readyResolvers.push((err) => {
        if (this.helloData) resolve(this.helloData);
        else reject(err ?? new Error("client died before hello_ok"));
      });
    });
  }

  connect(): void {
    if (this.dead) return;
    const url = `${this.serverUrl.replace(/^http/, "ws")}/ws`;

    // Bun extends WebSocket with a headers option (non-standard)
    this.ws = new (WebSocket as any)(url, {
      headers: { Authorization: `Bearer ${this.token()}` },
    }) as WebSocket;

    this.ws.onopen = () => {
      this.backoffMs = 1000; // reset backoff on success
      // Read each time, so a reconnect picks up a branch switch.
      const where = describeLocation(process.cwd());
      this.helloId = this.nextId();
      this.send({
        type: "hello", req_id: this.helloId, identity: this.identity,
        ...(this.push ? {} : { push: false }),
        ...(where ? { where } : {}),
        ...(this.wasReady ? { resume: true } : {}),
      });
    };

    this.ws.onmessage = (event) => {
      let raw: unknown;
      try { raw = JSON.parse(event.data as string); } catch { return; }
      this.handleServerMessage(raw as ServerMessage);
    };

    this.ws.onclose = () => {
      for (const p of this.pending.values()) p.reject(new Error("connection to the grayboard server was lost"));
      this.pending.clear();
      if (this.dead) return;
      const neverOpened = !this.helloData;
      this.ws = null;
      this.helloData = null;
      if (neverOpened) void this.checkToken();
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose fires after onerror; nothing extra needed
    };
  }

  private handleServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "hello_ok":
        this.helloData = msg;
        this.wasReady = true;
        this.refused = null;
        const resolvers = this.readyResolvers.splice(0);
        for (const r of resolvers) r();
        break;

      case "push": {
        const id = msg.message.id;
        this.onPush(msg.message).then(
          () => {
            if (this.ws?.readyState === WebSocket.OPEN) {
              this.send({ type: "ack", req_id: this.nextId(), message_ids: [id] });
            }
          },
          (e) => console.error("[grayboard] message delivery failed:", e),
        );
        break;
      }

      case "board_push": {
        const ref = refOf(msg.item);
        this.onBoardPush(msg.item).then(
          () => {
            if (this.ws?.readyState === WebSocket.OPEN) {
              this.send({ type: "board_ack", req_id: this.nextId(), refs: [ref] });
            }
          },
          (e) => console.error("[grayboard] board delivery failed:", e),
        );
        break;
      }

      case "ping":
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.send({ type: "pong" });
        }
        break;

      case "error":
        if (msg.code === "superseded") {
          this.dead = true;
          console.error("[grayboard] connection superseded by a newer session — exiting");
          process.exit(1);
        }
        // The server refused the hello itself (e.g. a reserved or invalid
        // name): retrying gets the same answer, so give up with its reason (#74).
        const helloRefused = !this.helloData && msg.req_id === this.helloId && msg.code === "bad_request";
        if (msg.code === "identity_in_use" || helloRefused) {
          // Another live session holds this identity, or can't have it. Don't retry.
          this.dead = true;
          if (this.readyResolvers.length) {
            const err = new Error(msg.message);
            for (const r of this.readyResolvers.splice(0)) r(err);
          } else {
            // Refused while reconnecting: e.g. another session owns it now.
            console.error(`[grayboard] ${msg.message} — exiting`);
            process.exit(1);
          }
          break;
        }
        if (msg.req_id) {
          const p = this.pending.get(msg.req_id);
          if (p) {
            this.pending.delete(msg.req_id);
            p.reject(new Error(`${msg.code}: ${msg.message}`));
          }
        }
        break;

      default:
        if ("req_id" in msg && msg.req_id) {
          const p = this.pending.get(msg.req_id);
          if (p) {
            this.pending.delete(msg.req_id);
            p.resolve(msg);
          }
        }
    }
  }

  // A refused token fails the upgrade like anything else (Bun shows only
  // "Expected 101 status code"), so ask over HTTP. At startup that's fatal;
  // later, tool calls say to sign in again until a reconnect succeeds.
  private async checkToken(): Promise<void> {
    const r = await fetch(`${this.serverUrl}/api/whoami`, { headers: { Authorization: `Bearer ${this.token()}` } }).catch(() => null);
    if (!r) return;
    this.refused = r.status === 401 ? this.refusedMessage(this.wasReady) : null;
    if (this.refused && !this.wasReady) {
      this.dead = true;
      const err = new Error(this.refused);
      for (const res of this.readyResolvers.splice(0)) res(err);
    }
  }

  private scheduleReconnect(): void {
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    setTimeout(() => this.connect(), delay);
  }

  private send(msg: ClientMessage): void {
    this.ws?.send(JSON.stringify(msg));
  }

  private nextId(): string {
    return `c${++this.counter}`;
  }

  /** Throws unless requests can go out now: before hello_ok the server
   *  rejects them and closes the socket, so a caller fails fast instead. */
  assertConnected(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.helloData) {
      throw new Error(this.refused ?? "not connected to the grayboard server (reconnecting); try again shortly");
    }
  }

  /** Send a request and wait for the corresponding response. */
  request<T extends ServerMessage>(msg: { type: string; [key: string]: unknown }): Promise<T> {
    return new Promise((resolve, reject) => {
      try {
        this.assertConnected();
      } catch (e) {
        reject(e);
        return;
      }
      const ws = this.ws!;
      const req_id = this.nextId();
      const full = { ...msg, req_id } as ClientMessage;
      // Backstop for an answer that never names this req_id (#40): fail the tool call instead of hanging it.
      const timer = setTimeout(() => {
        if (this.pending.delete(req_id)) reject(new Error(`no answer from the grayboard server after ${REQUEST_TIMEOUT_MS / 1000}s`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(req_id, {
        resolve: (m) => { clearTimeout(timer); resolve(m as T); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      ws.send(JSON.stringify(full));
    });
  }

  close(): void {
    this.dead = true;
    this.ws?.close();
  }
}
