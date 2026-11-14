// An application-level session: no socket, no frames, no hosted store (#282).
// It is a session the way application.hostedSession builds one, registered
// with hostedRegister and given its aliases by application.bind, so tests
// drive the application's own operations (send, bind, call, replay...) with
// no transport in between. It is not a hosted-store root: it has no lease, no
// ownership and no generation, and nothing in the hosted service sees it. A
// session with no alias is hosted's read-only kind (it may not send), and the
// first bind lifts that, as a rebuilt hosted session would. Refusals reject
// with the ApplicationError the operation threw (code, message, extra).
import { expect } from "bun:test";
import { idAddress, mintSessionKey } from "../../src/core/bindings.ts";
import type { PendingRef } from "../../src/core/boards.ts";
import {
  ApplicationError,
  type Application,
  type ApplicationSession,
  type BindResult,
  type DeliveryEvent,
  type DeliverySink,
  type DirectMessage,
  type HistoryMessage,
  type IdentityInfo,
  type InboxResult,
  type SendResult,
  type UnbindResult,
} from "../../src/server/application.ts";
import type { startServer } from "../../src/server/app.ts";
import { type AuthedUser, verifySessionToken } from "../../src/server/auth.ts";
import type { DelegateRequest, DelegateResult, ErrorCode } from "../../src/shared/protocol.ts";
import { until } from "./until.ts";

type StartedServer = ReturnType<typeof startServer>;

export type AppEvent =
  | DeliveryEvent
  // DeliverySink.closed: the server closed the session; the driver then closes.
  | { kind: "closed"; code: ErrorCode; message: string };

// push/hold/key: a session with push: false and no hold is tools-only, whose
// identity is the alias it writes as; key: the session key its ID derives
// from, minted when absent. harness: what hostedRegister records. bind:
// further fields for the identity's bind. launcher: the declaration a hosted
// request's `_meta` carries (#473), declared as `rowFor` does. The session
// answers a bind's probe of its alias while it's open; it is never a hosted
// holder (hostedSession registers it with no holds), so no bind probes it.
export type AppSessionOptions = {
  push?: boolean;
  launcher?: boolean;
  hold?: boolean;
  key?: string;
  harness?: string;
  bind?: Record<string, unknown>;
};

// What connect() answers: the session's ID and what its user's instructions
// would carry, and the bind's result when the identity was bound.
export type AppConnected = IdentityInfo & { id: string; bind?: BindResult };

// An AppSession of the server `app`, signed in with the session token
// `token` as an API request resolves it; connect() it. The caller closes it.
export function signedIn(app: Pick<StartedServer, "application" | "repo" | "touches">, token: string, identity: string | null, opts: AppSessionOptions = {}): AppSession {
  const authed = verifySessionToken(token, app.repo, app.touches);
  if (!authed) throw new Error("appSession: the token doesn't authenticate");
  return new AppSession(app.application, authed, identity, opts);
}

// The ApplicationError `p` (a connect, a bind, a call) is refused with.
export async function refusal(p: Promise<unknown>): Promise<ApplicationError> {
  const e = await p.then(() => undefined, (e: unknown) => e);
  if (!(e instanceof ApplicationError)) throw new Error(`expected an ApplicationError, got ${e}`);
  return e;
}

type Waiter = { pred: (e: AppEvent) => boolean; resolve: (e: AppEvent) => void; reject: (e: Error) => void };

export class AppSession {
  readonly key: string;
  // The session's ID, from its key.
  id = "";
  session!: ApplicationSession;
  // Every event no next() has taken yet, oldest first.
  events: AppEvent[] = [];
  private waiters: Waiter[] = [];
  private closed = false;

  constructor(
    private readonly application: Application,
    private readonly authed: AuthedUser,
    // The alias to bind after connecting; null stays an unbound session.
    private readonly identity: string | null,
    private readonly opts: AppSessionOptions = {},
  ) {
    this.key = opts.key ?? mintSessionKey();
  }

  private get label(): string {
    return this.identity ?? (this.id || "unbound");
  }

  // The sink a hosted session has, with events in place of a stream.
  private sink(): DeliverySink {
    return {
      deliver: (event) => this.arrive(event),
      closed: (error) => {
        this.arrive({ kind: "closed", code: error.code, message: error.message });
        this.drop(`closed by the server (${error.code}: ${error.message})`);
      },
      probe: () => Promise.resolve(!this.closed),
    };
  }

  private arrive(e: AppEvent): void {
    const i = this.waiters.findIndex((w) => w.pred(e));
    if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(e);
    else this.events.push(e);
  }

  // The connection is gone: its session closes and every pending wait fails
  // now, not at its timeout.
  private drop(why: string): void {
    if (!this.closed) {
      this.closed = true;
      if (this.session) this.application.close(this.session);
    }
    for (const w of this.waiters.splice(0)) w.reject(new Error(`${this.label}: ${why}`));
  }

  // Every operation after connect: the session revalidated first; one that
  // fails it is refused and closes.
  private live(): ApplicationSession {
    if (!this.session) throw new Error(`${this.label}: not connected`);
    try {
      this.application.revalidateSession(this.session, true);
    } catch (e) {
      this.drop(`refused: ${(e as Error).message}`);
      throw e;
    }
    return this.session;
  }

  // Registers the session, then binds the identity unless it's null or
  // tools-only (a tools-only session writes as it and binds nothing). Rejects
  // with the ApplicationError that refused either.
  async connect(): Promise<AppConnected> {
    if (this.session || this.closed) throw new Error(`${this.label}: connect() runs once, before close()`);
    const toolsOnly = this.opts.push === false && this.opts.hold !== true;
    const id = idAddress(this.key);
    let info: IdentityInfo;
    try {
      const writesAs = toolsOnly && this.identity !== null ? this.application.hostedWritesAs(this.authed, id, this.identity, true) : null;
      this.application.hostedRegister(this.authed, id, this.opts.harness ?? "test", writesAs);
      if (this.opts.launcher && writesAs === null) this.application.hostedDeclareLauncher(this.authed, id, { ownership: 0, client_id: "test" });
      ({ session: this.session, info } = this.application.hostedSession(this.authed, id, [], writesAs, null, this.sink(), this.opts.hold === true, this.opts.push !== false));
    } catch (e) {
      this.drop(`connect refused: ${(e as Error).message}`);
      throw e;
    }
    this.id = id;
    const ok: AppConnected = { id, ...info };
    if (this.identity === null || toolsOnly) return ok;
    return { ...ok, bind: await this.bind(this.identity, this.opts.bind) };
  }

  // bind, then the new alias's mail and boards. The first bind makes the
  // session a writer, as a rebuilt hosted session is.
  async bind(alias: string, extra: { create?: boolean; meta?: unknown; restored_from?: string; previous_key?: string } = {}): Promise<BindResult> {
    const session = this.live();
    const ok = await this.application.bind(session, { alias, ...extra } as Parameters<Application["bind"]>[1]);
    if (session.readOnly) {
      session.readOnly = false;
      session.writerId = this.id;
    }
    this.application.replay(session, [ok.alias]);
    return ok;
  }

  async unbind(alias: string): Promise<UnbindResult> {
    return this.application.unbind(this.live(), alias);
  }

  async send(
    recipient: string,
    body: string,
    opts: { parent_id?: number; pending?: boolean; attachment_ids?: number[]; resend?: boolean; as?: string } = {},
  ): Promise<SendResult> {
    return this.application.send(this.live(), recipient, body, opts);
  }

  async delegate(req: Omit<DelegateRequest, "type" | "req_id">): Promise<DelegateResult> {
    return this.application.delegate(this.live(), req);
  }

  async history(opts: { peer?: string; limit?: number; before_id?: number } = {}): Promise<HistoryMessage[]> {
    return this.application.history(this.live(), opts);
  }

  async thread(id: number): Promise<DirectMessage[]> {
    return this.application.thread(this.live(), id);
  }

  async inbox(days?: number): Promise<InboxResult> {
    return this.application.inbox(this.live(), days);
  }

  // A board or claim tool; resolves with the result the call publishes, after
  // its commit and before its deliveries. T is the shape the caller expects;
  // nothing checks it.
  async call<T = unknown>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    const session = this.live();
    const { promise, resolve } = Promise.withResolvers<T>();
    this.application.call(session, tool, args, (result) => resolve(result as T));
    return promise;
  }

  async ack(ids: number[]): Promise<void> {
    this.application.receiptDirect(this.live(), ids);
  }

  async boardAck(refs: PendingRef[]): Promise<void> {
    this.application.receiptBoards(this.live(), refs);
  }

  async dmAck(id: number): Promise<void> {
    this.application.acknowledgeDm(this.live(), id);
  }

  async retract(id: number): Promise<{ note?: string }> {
    return this.application.retract(this.live(), id);
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

  // The session closes (application.close). Later operations are refused.
  close(): void {
    this.drop("closed");
  }
}
