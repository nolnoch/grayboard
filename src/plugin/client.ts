import type { ServerMessage, ClientMessage, HelloOk, Message } from "../shared/protocol.ts";
import { refOf, type Pending } from "../core/boards.ts";

export type PushCallback = (msg: Message) => void;
// Resolve once the item has been handed to the agent; it's acked after that.
export type BoardPushCallback = (item: Pending) => Promise<void>;
export type ReadyCallback = (data: HelloOk) => void;

export class GrayboardClient {
  private ws: WebSocket | null = null;
  private backoffMs = 1000;
  private counter   = 0;
  private pending   = new Map<string, { resolve: (m: ServerMessage) => void; reject: (e: Error) => void }>();
  private dead      = false; // set on superseded; do not reconnect

  private helloData: HelloOk | null = null;
  private readyResolvers: Array<(err?: Error) => void> = [];

  constructor(
    private readonly serverUrl: string,
    private readonly token: string,
    private readonly identity: string,
    private readonly onPush: PushCallback,
    private readonly onBoardPush: BoardPushCallback,
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
      headers: { Authorization: `Bearer ${this.token}` },
    }) as WebSocket;

    this.ws.onopen = () => {
      this.backoffMs = 1000; // reset backoff on success
      this.send({ type: "hello", req_id: this.nextId(), identity: this.identity });
    };

    this.ws.onmessage = (event) => {
      let raw: unknown;
      try { raw = JSON.parse(event.data as string); } catch { return; }
      this.handleServerMessage(raw as ServerMessage);
    };

    this.ws.onclose = () => {
      if (this.dead) return;
      this.ws = null;
      this.helloData = null;
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
        const resolvers = this.readyResolvers.splice(0);
        for (const r of resolvers) r();
        break;

      case "push":
        this.onPush(msg.message);
        // ack immediately
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.send({ type: "ack", req_id: this.nextId(), message_ids: [msg.message.id] });
        }
        break;

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
        if (msg.code === "identity_in_use") {
          // Another live session holds this identity. Don't retry.
          this.dead = true;
          if (this.readyResolvers.length) {
            const err = new Error(msg.message);
            for (const r of this.readyResolvers.splice(0)) r(err);
          } else {
            // Lost it while reconnecting: the other session owns it now.
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

  /** Send a request and wait for the corresponding response. */
  request<T extends ServerMessage>(msg: { type: string; [key: string]: unknown }): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("not connected"));
        return;
      }
      const req_id = this.nextId();
      const full = { ...msg, req_id } as ClientMessage;
      this.pending.set(req_id, { resolve: resolve as (m: ServerMessage) => void, reject });
      this.ws.send(JSON.stringify(full));
    });
  }

  close(): void {
    this.dead = true;
    this.ws?.close();
  }
}
