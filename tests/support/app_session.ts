// An application-level session: what src/server/ws.ts does for one
// connection, with no socket and no frames (#282). Each request is built as
// the client frame and checked by parseClientMessage, as ws.ts receives it;
// then the same application calls run in the same order: hello, then replay;
// bind, then replay of its alias; revalidateSession before every later
// operation. Refusals reject with the ApplicationError the WSS error frame
// carried (code, message, extra).
import { expect } from "bun:test";
import { mintSessionKey } from "../../src/core/bindings.ts";
import type { PendingRef } from "../../src/core/boards.ts";
import {
  ApplicationError,
  type Application,
  type ApplicationSession,
  type BindResult,
  type DeliveryEvent,
  type DeliverySink,
  type DirectMessage,
  type HelloOptions,
  type HelloResult,
  type HistoryMessage,
  type InboxResult,
  type SendResult,
  type UnbindResult,
} from "../../src/server/application.ts";
import type { AuthedUser } from "../../src/server/auth.ts";
import {
  parseClientMessage,
  PROTO,
  type ClientMessage,
  type DelegateRequest,
  type DelegateResult,
  type ErrorCode,
} from "../../src/shared/protocol.ts";
import { until } from "./until.ts";

export type AppEvent =
  | DeliveryEvent
  // DeliverySink.aliasLost: the server released an alias the session held.
  | { kind: "alias_lost"; alias: string; reason: string }
  // DeliverySink.closed: the server closed the session; the driver then closes, as the socket did.
  | { kind: "closed"; code: ErrorCode; message: string }
  // DeliverySink.keepAlive: the heartbeat's ping.
  | { kind: "keep_alive" };

// push/hold/key: as a WSS client's hello (push: false with no hold is a
// tools-only session, whose identity is its writes_as; key: the session key,
// minted when absent). hello: further hello fields; `alive` is the driver's
// own (open until close()). bind: further fields for the identity's bind.
// probe: how the session answers the hello's holder probe: "answer" (a live
// client's pong, the default), "silent" (no pong: false after the probe's
// ms), or a function of the ms.
export type AppSessionOptions = {
  push?: boolean;
  hold?: boolean;
  key?: string;
  hello?: Partial<Omit<HelloOptions, "alive">>;
  bind?: Record<string, unknown>;
  probe?: "answer" | "silent" | ((ms: number) => Promise<boolean>);
};

type Waiter = { pred: (e: AppEvent) => boolean; resolve: (e: AppEvent) => void; reject: (e: Error) => void };
type Frame<T extends ClientMessage["type"]> = Extract<ClientMessage, { type: T }>;

export class AppSession {
  readonly key: string;
  // The session's ID, from the hello's answer.
  id = "";
  session!: ApplicationSession;
  // Every event no next() has taken yet, oldest first.
  events: AppEvent[] = [];
  private waiters: Waiter[] = [];
  private closed = false;
  private n = 0;

  constructor(
    private readonly application: Application,
    private readonly authed: AuthedUser,
    // The alias to bind after the hello; null stays an unbound session.
    private readonly identity: string | null,
    private readonly opts: AppSessionOptions = {},
  ) {
    this.key = opts.key ?? mintSessionKey();
  }

  private get label(): string {
    return this.identity ?? (this.id || "unbound");
  }

  // The sink ws.ts's sinkFor would be, with events in place of frames.
  private sink(): DeliverySink {
    return {
      deliver: (event) => this.arrive(event),
      closed: (error) => {
        this.arrive({ kind: "closed", code: error.code, message: error.message });
        this.drop(`closed by the server (${error.code}: ${error.message})`);
      },
      aliasLost: (alias, reason) => {
        if (!this.closed) this.arrive({ kind: "alias_lost", alias, reason });
      },
      keepAlive: () => {
        if (!this.closed) this.arrive({ kind: "keep_alive" });
      },
      probe: (ms) => {
        const probe = this.opts.probe ?? "answer";
        if (probe === "answer") return Promise.resolve(!this.closed);
        if (typeof probe === "function") return probe(ms);
        // No pong: ws.ts's probe timer answers false.
        const { promise, resolve } = Promise.withResolvers<boolean>();
        setTimeout(() => resolve(false), ms);
        return promise;
      },
    };
  }

  private arrive(e: AppEvent): void {
    const i = this.waiters.findIndex((w) => w.pred(e));
    if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(e);
    else this.events.push(e);
  }

  // The connection is gone: its session closes (ws.ts's close handler) and
  // every pending wait fails now, not at its timeout.
  private drop(why: string): void {
    if (!this.closed) {
      this.closed = true;
      if (this.session) this.application.close(this.session);
    }
    for (const w of this.waiters.splice(0)) w.reject(new Error(`${this.label}: ${why}`));
  }

  // The frame as ws.ts parses it from the wire (JSON, then
  // parseClientMessage); a malformed one is ws.ts's bad_request.
  private frame<T extends ClientMessage["type"]>(fields: { type: T } & Record<string, unknown>): Frame<T> {
    try {
      // parseClientMessage answers the variant its `type` names.
      return parseClientMessage(JSON.parse(JSON.stringify({ ...fields, req_id: `r${++this.n}` }))) as Frame<T>;
    } catch (e) {
      throw new ApplicationError("bad_request", (e as Error).message);
    }
  }

  // Every operation after the hello (ws.ts:132-141): parsed, then the
  // session revalidated; a session that fails it is refused and its
  // connection closes.
  private live<T extends ClientMessage["type"]>(fields: { type: T } & Record<string, unknown>): { msg: Frame<T>; session: ApplicationSession } {
    if (!this.session) throw new Error(`${this.label}: not connected`);
    const msg = this.frame(fields);
    try {
      this.application.revalidateSession(this.session, true);
    } catch (e) {
      this.drop(`refused: ${(e as Error).message}`);
      throw e;
    }
    return { msg, session: this.session };
  }

  // The hello (ws.ts:115-131), then a bind of the identity unless it's
  // null, tools-only or already held. Rejects with the ApplicationError that
  // refused either.
  async connect(): Promise<HelloResult & { bind?: BindResult }> {
    if (this.session || this.closed) throw new Error(`${this.label}: connect() runs once, before close()`);
    const toolsOnly = this.opts.push === false && this.opts.hold !== true;
    const { type: _t, req_id: _r, proto: _p, ...hello } = this.frame({
      type: "hello", proto: PROTO, session_key: this.key,
      ...(this.opts.push === false ? { push: false } : {}),
      ...(this.opts.hold ? { hold: true } : {}),
      ...(toolsOnly && this.identity !== null ? { writes_as: this.identity } : {}),
      ...this.opts.hello,
    });
    let session: ApplicationSession, ok: HelloResult;
    try {
      ({ session, ok } = await this.application.hello(this.authed, this.sink(), { ...hello, alive: () => !this.closed }));
    } catch (e) {
      this.drop(`hello refused: ${(e as Error).message}`);
      throw e;
    }
    this.session = session;
    this.id = ok.id;
    // Closed while the hello answered: its session closes too.
    if (this.closed) {
      this.application.close(session);
      throw new Error(`${this.label}: closed during its hello`);
    }
    try {
      this.application.replay(session);
    } catch (e) {
      this.drop(`refused: ${(e as Error).message}`);
      throw e;
    }
    if (this.identity === null || toolsOnly) return ok;
    const full = this.identity.includes("/") ? this.identity : `${ok.user_email}/${this.identity}`;
    if (ok.bound?.includes(full)) return ok;
    return { ...ok, bind: await this.bind(this.identity, this.opts.bind) };
  }

  // bind, then the new alias's mail and boards (ws.ts:143-149).
  async bind(alias: string, extra: Record<string, unknown> = {}): Promise<BindResult> {
    const { msg, session } = this.live({ type: "bind", alias, ...extra });
    const { type: _t, req_id: _r, ...bind } = msg;
    const ok = await this.application.bind(session, bind);
    this.application.replay(session, [ok.alias]);
    return ok;
  }

  async unbind(alias: string): Promise<UnbindResult> {
    const { msg, session } = this.live({ type: "unbind", alias });
    return this.application.unbind(session, msg.alias);
  }

  async end(): Promise<void> {
    const { session } = this.live({ type: "end" });
    this.application.end(session);
  }

  async send(
    recipient: string,
    body: string,
    opts: { parent_id?: number; pending?: boolean; attachment_ids?: number[]; resend?: boolean; as?: string } = {},
  ): Promise<SendResult> {
    const { msg, session } = this.live({ type: "send", recipient, body, ...opts });
    return this.application.send(session, msg.recipient, msg.body, msg);
  }

  async delegate(req: Omit<DelegateRequest, "type" | "req_id">): Promise<DelegateResult> {
    const { msg, session } = this.live({ type: "delegate", ...req });
    return this.application.delegate(session, msg);
  }

  async history(opts: { peer?: string; limit?: number; before_id?: number } = {}): Promise<HistoryMessage[]> {
    const { msg, session } = this.live({ type: "history", ...opts });
    return this.application.history(session, msg);
  }

  async thread(id: number): Promise<DirectMessage[]> {
    const { msg, session } = this.live({ type: "thread", message_id: id });
    return this.application.thread(session, msg.message_id);
  }

  async inbox(days?: number): Promise<InboxResult> {
    const { msg, session } = this.live({ type: "inbox", days });
    return this.application.inbox(session, msg.days);
  }

  // A board or claim tool; resolves with the result the call publishes
  // (ws.ts's call_ok), after its commit and before its deliveries. T is the
  // shape the caller expects; nothing checks it.
  async call<T = unknown>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    const { msg, session } = this.live({ type: "call", tool, args });
    const { promise, resolve } = Promise.withResolvers<T>();
    this.application.call(session, msg.tool, msg.args, (result) => resolve(result as T));
    return promise;
  }

  async ack(ids: number[]): Promise<void> {
    const { msg, session } = this.live({ type: "ack", message_ids: ids });
    this.application.receiptDirect(session, msg.message_ids);
  }

  async boardAck(refs: PendingRef[]): Promise<void> {
    const { msg, session } = this.live({ type: "board_ack", refs });
    this.application.receiptBoards(session, msg.refs);
  }

  async dmAck(id: number): Promise<void> {
    const { msg, session } = this.live({ type: "dm_ack", message_id: id });
    this.application.acknowledgeDm(session, msg.message_id);
  }

  async retract(id: number): Promise<{ note?: string }> {
    const { msg, session } = this.live({ type: "dm_retract", message_id: id });
    return this.application.retract(session, msg.message_id);
  }

  // The first event matching pred, taken from those already here or the
  // next to arrive within ms. A close fails it at once.
  next<T extends AppEvent>(pred: (e: AppEvent) => e is T, ms?: number): Promise<T>;
  next(pred: (e: AppEvent) => boolean, ms?: number): Promise<AppEvent>;
  next(pred: (e: AppEvent) => boolean, ms = 1000): Promise<AppEvent> {
    const i = this.events.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.events.splice(i, 1)[0]!);
    if (this.closed) return Promise.reject(new Error(`${this.label}: closed`));
    const { promise, resolve, reject } = Promise.withResolvers<AppEvent>();
    const timer = setTimeout(() => {
      const j = this.waiters.indexOf(w);
      if (j >= 0) {
        this.waiters.splice(j, 1);
        reject(new Error(`${this.label}: timed out after ${ms} ms waiting for ${pred}`));
      }
    }, ms);
    const w: Waiter = {
      pred,
      resolve: (e) => (clearTimeout(timer), resolve(e)),
      reject: (e) => (clearTimeout(timer), reject(e)),
    };
    this.waiters.push(w);
    return promise;
  }

  // Nothing matching pred is here, or arrives within ms.
  async none(pred: (e: AppEvent) => boolean, ms = 150): Promise<void> {
    const end = Date.now() + ms;
    await until(() => {
      expect(this.events.filter(pred)).toEqual([]);
      return Date.now() >= end;
    }, ms + 1000, `${this.label}: no event matching ${pred} for ${ms} ms`);
  }

  // The connection closes (ws.ts's close handler): application.close, which
  // starts a WSS session's grace. Later operations are refused.
  close(): void {
    this.drop("closed");
  }
}
