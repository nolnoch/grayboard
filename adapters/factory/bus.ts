// The FactoryBus contract (#293, docs/future/factory.md §3): every bus
// interaction the factory module performs flows through here, so feature
// code never touches a connection. Message-shaped and transport-free by
// design: request/response ops plus an async event stream, identity as a
// handle + capabilities (never a connection object), and a caller-supplied
// idempotency key on every outbound op — the shape a stream broker adapter
// (e.g. a JetStream-style I/O filter shared across services) could implement
// without the module knowing a broker exists. The broker itself is out of
// scope: this contract's only job is to not foreclose it.
//
// Isolation (#293): the ONLY src/ import the module may make is the
// published client and the protocol types (scripts/check_factory_isolation.ts
// enforces both directions).
import { GrayboardClient } from "../../src/plugin/client.ts";
import type { Message, ServerMessage, SendOk, CallOk, ThreadOk, InboxOk, HelloOk, AckOk } from "../../src/shared/protocol.ts";

// A queued board item, derived from the protocol instead of imported: the
// type lives in the core (src/core/boards.ts), which is outside the module's
// allowlisted surface. Same value, reached through the public wire type.
export type BoardItem = Extract<ServerMessage, { type: "board_push" }>["item"];
// A board post, reached through the wire type (Post lives in the core, outside the allowlist).
export type BusPost = Extract<BoardItem, { kind: "push" }>["post"];

// What a launcher/factory session can do, advertised beside its handle.
// Strings and booleans only: capabilities cross the bus as data.
export type Capabilities = Record<string, string | number | boolean>;

export type BusIdentity = { handle: string; capabilities: Capabilities };

// An event delivered to the module. Subject names the kind ("dm", "board");
// replyTo carries the message id a thread reply would answer. Deliberately
// not a WS frame: a broker adapter maps its own subjects onto these.
export type Envelope =
  | { subject: "dm"; payload: Message; replyTo: number }
  | { subject: "board"; payload: BoardItem };

// Every outbound op takes a caller-supplied idempotency key: at-least-once
// delivery is the caller's reality, so repeating an op under one key must
// not repeat its effect.
export type SendOp = { to: string; body: string; idempotencyKey: string; threadId?: number };
export type SendResult = { messageId: number; delivered: boolean };
export type PostOp = { board: string; body: string; idempotencyKey: string };
export type ClaimOp = { key: string; idempotencyKey: string; ttlMinutes?: number; note?: string; board?: string };

export type Peer = { handle: string; online?: boolean; launcher?: true; harness?: string; comms?: string; [k: string]: unknown };

// The one interface feature code is allowed to know.
export interface FactoryBus {
  identity(): Promise<BusIdentity>;
  send(op: SendOp): Promise<SendResult>;
  thread(messageId: number): Promise<Message[]>;
  inbox(): Promise<Omit<InboxOk, "type" | "req_id">>;
  // Settle a pending promise (the requester's side of a delegation thread).
  settle(messageId: number): Promise<void>;
  // Acknowledge delivered pushes so they aren't resent on reconnect.
  acknowledge(messageIds: number[]): Promise<void>;
  post(op: PostOp): Promise<{ postId: number; board: string; notified: string[] }>;
  // Idempotent for a same-creator repeat: the board_create tool answers it
  // from state (#254's lost-answer semantics), so the roster's ensure step
  // can call it every cycle.
  boardCreate(op: { name: string; purpose: string; kind?: "broadcast" | "queue"; idempotencyKey: string }): Promise<{ name: string }>;
  readBoard(board: string): Promise<{ board: string; posts: BusPost[]; unread_remaining: number }>;
  claimTake(op: ClaimOp): Promise<Record<string, unknown>>;
  claimRelease(key: string, note?: string): Promise<void>;
  claimList(): Promise<{ key: string; [k: string]: unknown }[]>;
  peers(board?: string): Promise<Peer[]>;
  // The event stream, consumed once by the module's run loop.
  events(): AsyncIterable<Envelope>;
  close(): Promise<void>;
}

export type ClientBusOptions = {
  capabilities?: Capabilities;
  onReady?: (hello: HelloOk) => void;
  onDead?: (reason: string) => void;
};

// The in-repo implementation: the published client, one adapter deep. This
// is the only place the module knows a WebSocket exists.
export class ClientBus implements FactoryBus {
  private client: GrayboardClient;
  private cap: Capabilities;
  private queue: Envelope[] = [];
  private helloData: HelloOk | null = null;
  private wake: (() => void) | null = null;
  private done = false;
  // idempotencyKey -> the op's in-flight or settled result promise.
  private inflight = new Map<string, Promise<unknown>>();
  // Resolves at hello_ok; every op waits for it, so a caller that fires an
  // op as the module starts queues instead of racing the connect.
  private readonly whenReady: Promise<HelloOk>;

  constructor(
    serverUrl: string,
    token: () => string,
    private readonly id: string,
    opts: ClientBusOptions = {},
  ) {
    this.cap = opts.capabilities ?? {};
    // A session key minted module-side: the server derives the session id
    // from it (#182); the shape is the protocol's, the entropy is ours.
    const sessionKey = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
    this.client = new GrayboardClient(
      serverUrl,
      token,
      id,
      sessionKey,
      async (msg: Message) => {
        this.enqueue({ subject: "dm", payload: msg, replyTo: msg.id });
      },
      async (item: BoardItem) => {
        this.enqueue({ subject: "board", payload: item });
      },
      true, // push: a factory receives its mail; relay-only makes no sense for it
      () => "", // the module signs in through env/credentials before connecting
      { launcher: true, onDead: opts.onDead },
    );
    this.whenReady = this.client.ready();
    this.whenReady.then((hello) => {
      this.helloData = hello;
      opts.onReady?.(hello);
    }).catch(() => {
      // Death before hello_ok: onDead (the opts hook) already fired.
    });
    this.client.connect();
  }

  private enqueue(e: Envelope): void {
    if (this.done) return;
    this.queue.push(e);
    this.wake?.();
  }

  async identity(): Promise<BusIdentity> {
    const hello = this.helloData ?? (await this.client.ready().catch(() => null));
    return { handle: this.id, capabilities: { ...this.cap, launcher: true, ...(hello?.identity_full ? { session: hello.identity_full } : {}) } };
  }

  // One key, one effect: a repeated op under a live or settled key returns
  // the first attempt's result. The skeleton keeps keys for the process's
  // life; a real store or broker owns the dedup window later.
  private once<K>(key: string, op: () => Promise<K>): Promise<K> {
    const held = this.inflight.get(key) as Promise<K> | undefined;
    if (held) return held;
    const p = this.whenReady.then(op) as Promise<K>;
    this.inflight.set(key, p);
    return p;
  }

  // Every op waits for hello_ok: a caller that fires an op as the module
  // starts queues instead of racing the connect (the once() ops got this
  // from whenReady; the plain ops route through here for the same reason —
  // a roster cycle at startup must not throw "not connected").
  private async gated<T extends ServerMessage>(msg: Parameters<GrayboardClient["request"]>[0]): Promise<T> {
    await this.whenReady;
    return this.client.request<T>(msg);
  }

  async send(op: SendOp): Promise<SendResult> {
    return this.once(`send:${op.idempotencyKey}`, async () => {
      const ok = await this.client.request<SendOk>({
        type: "send", recipient: op.to, body: op.body, pending: true,
        ...(op.threadId !== undefined ? { parent_id: op.threadId } : {}),
      });
      return { messageId: ok.message_id, delivered: ok.delivered_now === true };
    });
  }

  async thread(messageId: number): Promise<Message[]> {
    const ok = await this.gated<ThreadOk>({ type: "thread", req_id: this.reqId(), message_id: messageId });
    return ok.messages;
  }

  async inbox() {
    const { type: _t, req_id: _r, ...rest } = await this.gated<InboxOk>({ type: "inbox", req_id: this.reqId() });
    return rest;
  }

  async settle(messageId: number): Promise<void> {
    await this.gated<AckOk>({ type: "dm_ack", req_id: this.reqId(), message_id: messageId });
  }

  async acknowledge(messageIds: number[]): Promise<void> {
    if (!messageIds.length) return;
    await this.gated({ type: "ack", req_id: this.reqId(), message_ids: messageIds });
  }

  async post(op: PostOp): Promise<{ postId: number; board: string; notified: string[] }> {
    return this.once(`post:${op.idempotencyKey}`, async () => {
      const ok = await this.client.request<CallOk>({ type: "call", req_id: this.reqId(), tool: "board_post", args: { board: op.board, body: op.body } });
      const r = ok.result as { post_id: number; board: string; notified?: string[] };
      return { postId: r.post_id, board: r.board, notified: r.notified ?? [] };
    });
  }

  async boardCreate(op: { name: string; purpose: string; kind?: "broadcast" | "queue"; idempotencyKey: string }): Promise<{ name: string }> {
    return this.once(`boardCreate:${op.idempotencyKey}`, async () => {
      const ok = await this.client.request<CallOk>({
        type: "call", req_id: this.reqId(), tool: "board_create",
        args: { name: op.name, purpose: op.purpose, ...(op.kind ? { kind: op.kind } : {}) },
      });
      const r = ok.result as { name: string };
      return { name: r.name };
    });
  }

  async readBoard(board: string) {
    const ok = await this.gated<CallOk>({ type: "call", req_id: this.reqId(), tool: "board_read", args: { board } });
    return ok.result as { board: string; posts: BusPost[]; unread_remaining: number };
  }

  async claimTake(op: ClaimOp): Promise<Record<string, unknown>> {
    return this.once(`claim:${op.idempotencyKey}`, async () => {
      const ok = await this.client.request<CallOk>({
        type: "call", req_id: this.reqId(), tool: "claim_take",
        args: { key: op.key, ...(op.ttlMinutes !== undefined ? { ttl_minutes: op.ttlMinutes } : {}), ...(op.note ? { note: op.note } : {}), ...(op.board ? { board: op.board } : {}) },
      });
      return ok.result as Record<string, unknown>;
    });
  }

  async claimRelease(key: string, note?: string): Promise<void> {
    await this.gated<CallOk>({ type: "call", req_id: this.reqId(), tool: "claim_release", args: { key, ...(note ? { note } : {}) } });
  }

  async claimList() {
    const ok = await this.gated<CallOk>({ type: "call", req_id: this.reqId(), tool: "claim_list", args: {} });
    return ok.result as { key: string; [k: string]: unknown }[];
  }

  async peers(board?: string): Promise<Peer[]> {
    const ok = await this.gated<CallOk>({ type: "call", req_id: this.reqId(), tool: "peer_list", args: board ? { board } : {} });
    return (ok.result as { peers: Peer[] }).peers ?? [];
  }

  private reqId(): string {
    return `factory-${++ClientBus.seq}`;
  }
  private static seq = 0;

  async *events(): AsyncIterable<Envelope> {
    while (!this.done) {
      while (this.queue.length) {
        const e = this.queue.shift()!;
        yield e;
        if (e.subject === "dm") await this.acknowledge([e.payload.id]);
      }
      if (this.done) break;
      await new Promise<void>((ok) => {
        this.wake = ok;
      });
    }
  }

  async close(): Promise<void> {
    this.done = true;
    this.wake?.();
    await this.client.close();
  }
}
