import { PROTO, type ServerMessage, type ClientMessage, type AliasLost, type ErrorMessage, type HelloOk, type Message, type AckRequest, type BoardAckRequest } from "../shared/protocol.ts";
import { refOf } from "../core/boards.ts";
import type { Pending } from "../shared/notifications.ts";
import { idAddress, mintSessionKey } from "../core/bindings.ts";
import { describeLocation } from "../shared/identity.ts";
import { HTTP_TIMEOUT_MS, describeFetchError } from "../shared/http.ts";

// Server tool calls are single DB transactions; one unanswered this long never will be.
const REQUEST_TIMEOUT_MS = 30_000;
// Once a session has had a hello_ok, its reconnects must land inside the
// server's 30 s grace (#284 S4): the backoff stops at 8 s, unjittered,
// and the pre-open token check gives up after 5 s.
const RESUME_BACKOFF_MAX_MS = 8_000;
const RESUME_PROBE_MS = 5_000;

// Both resolve once the item has been handed to the agent; it's acked after
// that, so a failed handoff is resent on the next connection.
export type PushCallback = (msg: Message) => Promise<void>;
export type BoardPushCallback = (item: Pending) => Promise<void>;
// Every hello_ok, a reconnect's too. `rekeyedFrom`: the key of the session
// that ended during the outage, when this hello started a new one (#284 S4).
export type ReadyCallback = (data: HelloOk, rekeyedFrom: string | null) => void;

/** The server refused a hello (`holder` unset) or a request: its code and what came with it. */
export class ServerRefused extends Error {
  readonly code: ErrorMessage["code"];
  readonly holder?: string;
  readonly retryAfterMs?: number;
  constructor(m: ErrorMessage, message = m.message) {
    super(message);
    this.code = m.code;
    this.holder = m.holder;
    this.retryAfterMs = m.retry_after_ms;
  }
}

export type ClientOptions = {
  // false: a hold or tools-only connection that never receives pushes.
  push?: boolean;
  // With push false: a session all the same, which binds and holds an alias,
  // for a harness that can't show pushes (#182 audit 2).
  hold?: boolean;
  // With push false and no hold: a tools-only connection, which writes as
  // this alias of the session that owns delivery (#284 S7).
  writesAs?: string;
  // The key came from BUS_SESSION_KEY (#284 S10): sent as keyed, and an
  // ended session is fatal, since a keyed process never mints a replacement.
  keyed?: boolean;
  // This session's harness can spawn subagents, so delegate requests may
  // land here (#184). Sent on every hello; the server records it on the
  // session's row and peer_list shows it.
  launcher?: boolean;
  // What the session runs on (#284 S12): the harness's command name,
  // BUS_MODEL, BUS_EFFORT. Sent on every hello; the server records them when
  // the hello registers the session.
  facts?: { harness?: string; model?: string; effort?: string };
  onReady?: ReadyCallback;
  // The server released an alias this session held (#284 S9).
  onAliasLost?: (m: AliasLost) => void;
  // The client stopped for good after it was ready: superseded, or its
  // session refused on a reconnect. It never exits the process; the session decides.
  onDead?: (reason: string) => void;
  // After a refused token: how often to look for a new one, and when to try
  // the old one again anyway. Shortened by tests.
  tokenPollMs?: number;
  signedOutRetryMs?: number;
  // The token check's deadline before a hello_ok (after one, RESUME_PROBE_MS
  // caps it). Shortened by tests.
  probeTimeoutMs?: number;
};

/** Why the server is refusing this client for now: what it limits, its
 *  message, and when the client tries again. */
export type RateLimited = { what: string; message: string; retryAt: number };
// An ack waiting for a ready socket; its req_id is minted when it goes out.
type UnsentAck = Omit<AckRequest, "req_id"> | Omit<BoardAckRequest, "req_id">;

// What a token check found: go ahead, sign in again, wait, or no answer.
type Probe =
  | { kind: "ok" | "refused" }
  | { kind: "limited"; what: string; retryAfterMs: unknown; message: string }
  | { kind: "unanswered"; why: string };

const TOKEN_POLL_MS = 5_000;
const SIGNED_OUT_RETRY_MS = 5 * 60_000;

export class GrayboardClient {
  private ws: WebSocket | null = null;
  private backoffMs = 1000;
  private counter   = 0;
  private pending   = new Map<string, { resolve: (m: ServerMessage) => void; reject: (e: Error) => void }>();
  private dead      = false; // set on superseded, refusal or close; do not reconnect

  private helloData: HelloOk | null = null;
  private unsentAcks: UnsentAck[] = [];
  private refused: string | null = null; // set while the server refuses our token
  // Set while the server rate-limits this client, its user's hellos (#210)
  // or its address after auth failures (#240), until a hello is accepted:
  // why, when the next try goes out, whether a hello said so (a probe's
  // answer replaces only a probe's), and for a hello the wait before it
  // (null once used).
  private limited: (RateLimited & { byHello: boolean; retryMs: number | null }) | null = null;
  private wasReady  = false; // a later hello is a reconnect, not a new session
  private helloId   = "";    // the req_id of this connection's hello
  private readyResolvers: Array<(err?: Error) => void> = [];
  // Set from an ended session's resume refusal until the new key's hello_ok:
  // the old key, which the session's re-bind presents as proof of descent.
  private rekeyedFrom: string | null = null;

  constructor(
    private readonly serverUrl: string,
    // Read on each connect, so signing in again takes effect on the next reconnect.
    private readonly token: () => string,
    // This session's key (#284): the server derives the session's ID from
    // it, and possession of it is what re-attaches a reconnect.
    private key: string,
    private readonly onPush: PushCallback,
    private readonly onBoardPush: BoardPushCallback,
    // What to say when the server refuses the token: at startup (fatal), or
    // in tool results while a running session waits to reconnect.
    private readonly refusedMessage = (_running: boolean) => "the grayboard server refused this session's token; sign in again",
    private readonly opts: ClientOptions = {},
  ) {}

  /** This session's ID: a new one after an outage past the grace (unkeyed only). */
  get id(): string {
    return idAddress(this.key);
  }

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
    this.probeThenOpen().catch((e) => {
      console.error(`[grayboard] connecting as ${this.who()} failed: ${(e as Error).message}`);
      if (!this.dead) this.scheduleReconnect();
    });
  }

  // Every connect asks over HTTP first (#240). A refused upgrade says only
  // "Expected 101 status code", and probing after it would charge the address
  // twice per dead token; probing before charges it once, and a 429 here means
  // the address's bucket was already empty, not that the upgrade emptied it.
  private async probeThenOpen(): Promise<void> {
    const token = this.token();
    const probe = await this.checkToken(token);
    if (this.dead) return;
    if (probe.kind === "refused") {
      this.limited = null;
      return this.awaitNewToken(token);
    }
    if (probe.kind === "unanswered") {
      this.limited = null;
      console.error(`[grayboard] the grayboard server didn't answer a token check (${probe.why})`);
      return this.scheduleReconnect();
    }
    if (probe.kind === "limited") {
      // The server's wait is a floor (#240): behind a shared address,
      // returning the moment one token is back keeps the bucket empty for
      // everyone, so the backoff keeps growing until a hello is accepted.
      const wait = Math.round(Math.max(retryWait(probe.retryAfterMs, this.backoffMs), this.backoffMs) * (1 + Math.random() / 2));
      this.backoffMs = this.nextBackoff();
      this.limited = { what: probe.what, message: probe.message, byHello: false, retryMs: null, retryAt: Date.now() + wait };
      return this.reconnectIn(wait, `rate limited (${probe.message})`);
    }
    if (!this.limited?.byHello) this.limited = null;
    this.open(token);
  }

  private open(token: string): void {
    const url = `${this.serverUrl.replace(/^http/, "ws")}/ws`;

    // Bun extends WebSocket with a headers option (non-standard)
    this.ws = new (WebSocket as any)(url, {
      headers: { Authorization: `Bearer ${token}` },
    }) as WebSocket;

    this.ws.onopen = () => {
      // Read each time, so a reconnect picks up a branch switch.
      const where = describeLocation(process.cwd());
      this.helloId = this.nextId();
      const { push = true, hold, writesAs, keyed, launcher, facts } = this.opts;
      this.send({
        type: "hello", req_id: this.helloId, proto: PROTO, session_key: this.key,
        ...(keyed ? { keyed: true } : {}),
        ...(push ? {} : hold ? { push: false, hold: true } : { push: false, writes_as: writesAs }),
        ...(launcher ? { launcher: true } : {}),
        ...facts,
        ...(where ? { where } : {}),
        // A new key's hello starts a session; it resumes nothing.
        ...(this.wasReady && this.rekeyedFrom === null ? { resume: true } : {}),
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
      if (this.dead) {
        // A deliberate stop (a bind's swap, supersede, exit): said once, so a
        // reconnect that shouldn't happen shows as the line below instead.
        if (this.wasReady) console.error(`[grayboard] connection as ${this.who()} closed; not reconnecting`);
        return;
      }
      const neverOpened = !this.helloData;
      this.ws = null;
      this.helloData = null;
      // Rate-limited: the server said why it closed, and the wait is the
      // server's, not the backoff's.
      const retryMs = this.limited?.retryMs;
      if (retryMs != null) {
        this.limited!.retryMs = null;
        return void this.reconnectIn(retryMs, `rate limited (${this.limited!.message})`);
      }
      // Any other close after a hello_ok (the network, the server going away)
      // is not the limit: a stale reason would make startup wait it out and
      // blame it. Before one, the next connect's probe says.
      if (!neverOpened) this.limited = null;
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose fires after onerror; nothing extra needed
    };
  }

  private handleServerMessage(msg: ServerMessage): void {
    // A dead client hands nothing to the agent and acks nothing: what was
    // pushed to it stays queued for its name's next holder (#182 decision 6).
    if (this.dead) return;
    switch (msg.type) {
      case "hello_ok":
        this.helloData = msg;
        this.wasReady = true;
        this.refused = null;
        this.limited = null;
        // Reset on an accepted hello, not on open: a server that closes
        // after every hello would otherwise be retried each second.
        this.backoffMs = 1000;
        for (const ack of this.unsentAcks.splice(0)) this.send({ ...ack, req_id: this.nextId() });
        const resolvers = this.readyResolvers.splice(0);
        for (const r of resolvers) r();
        const rekeyedFrom = this.rekeyedFrom;
        this.rekeyedFrom = null;
        this.opts.onReady?.(msg, rekeyedFrom);
        break;

      case "push": {
        const id = msg.message.id;
        this.onPush(msg.message).then(
          () => this.ackWhenReady({ type: "ack", message_ids: [id] }),
          (e) => console.error("[grayboard] message delivery failed:", e),
        );
        break;
      }

      case "board_push": {
        const ref = refOf(msg.item);
        this.onBoardPush(msg.item).then(
          () => this.ackWhenReady({ type: "board_ack", refs: [ref] }),
          (e) => console.error("[grayboard] board delivery failed:", e),
        );
        break;
      }

      case "alias_lost":
        this.opts.onAliasLost?.(msg);
        break;

      case "ping":
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.send({ type: "pong" });
        }
        break;

      case "error":
        // Transient, never fatal: wait as long as the server says, jittered
        // so a fleet doesn't come back in lockstep, and try again. ready()
        // stays pending; a caller's own deadline decides (#210).
        if (msg.code === "rate_limited" && !this.helloData && msg.req_id === this.helloId) {
          const retryMs = Math.round(retryWait(msg.retry_after_ms, this.backoffMs) * (1 + Math.random() / 2));
          this.limited = { what: "this user's connections", message: msg.message, byHello: true, retryMs, retryAt: Date.now() + retryMs };
          this.ws?.close();
          break;
        }
        if (msg.code === "superseded") {
          this.die(`session ${this.id} was taken over: ${msg.message}`);
          break;
        }
        // The server closed this token's connection (a logout, an admin
        // sign-out) or refused its hello after the token was revoked: say to
        // sign in at once, then let the close run the reconnect, whose token
        // probe waits for a new token (#351). A startup refusal (not
        // wasReady) stays the fatal path below.
        if (msg.code === "unauthenticated" && this.wasReady) {
          this.refused = this.refusedMessage(true);
          this.ws?.close();
          break;
        }
        // A resume refused because the session ended during the outage (its
        // grace ran out): an unkeyed session carries on under a new key at
        // once, and re-binds its aliases with the old key as proof (#284 S4).
        if (msg.code === "id_collision" && !this.helloData && msg.req_id === this.helloId && this.wasReady && !this.opts.keyed && this.rekeyedFrom === null) {
          console.error(`[grayboard] session ${this.id} was refused on reconnect (${msg.message}); starting a new session`);
          this.rekeyedFrom = this.key;
          this.key = mintSessionKey();
          this.backoffMs = 1000;
          this.ws?.close();
          break;
        }
        // The server refused the hello itself (an ended or colliding key, a
        // writes_as it may not use): retrying gets the same answer, so give
        // up with its reason (#74).
        if (!this.helloData && msg.req_id === this.helloId && msg.code !== "internal") {
          if (this.readyResolvers.length) {
            this.dead = true;
            this.ws?.close();
            const err = new ServerRefused(msg);
            for (const r of this.readyResolvers.splice(0)) r(err);
          } else {
            // Refused while reconnecting: a keyed session that ended, say.
            this.die(msg.message);
          }
          break;
        }
        if (msg.req_id) {
          const p = this.pending.get(msg.req_id);
          if (p) {
            this.pending.delete(msg.req_id);
            p.reject(new ServerRefused(msg, `${msg.code}: ${msg.message}`));
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

  // Whether the server takes this token, over HTTP. A 401 is fatal at
  // startup; later, tool calls say to sign in again until a reconnect
  // succeeds. A 429 is the address limit only when the body says so; any
  // other (a proxy's, a load balancer's) is waited out by its Retry-After.
  private async checkToken(token: string): Promise<Probe> {
    const { probeTimeoutMs = HTTP_TIMEOUT_MS } = this.opts;
    const timeoutMs = this.wasReady ? Math.min(probeTimeoutMs, RESUME_PROBE_MS) : probeTimeoutMs;
    let r: Response;
    let body: { code?: unknown; message?: unknown; retry_after_ms?: unknown } = {};
    try {
      r = await fetch(`${this.serverUrl}/api/whoami`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
      if (r.status === 429) body = await r.json().catch(() => ({}));
    } catch (e) {
      return { kind: "unanswered", why: describeFetchError(e, timeoutMs) };
    }
    if (r.status === 429) {
      if (body.code === "rate_limited") {
        const message = typeof body.message === "string" ? body.message : "429";
        return { kind: "limited", what: "this address after repeated authentication failures", retryAfterMs: body.retry_after_ms, message };
      }
      const retryAfter = r.headers.get("Retry-After");
      return { kind: "limited", what: "requests from this client", retryAfterMs: retryAfterMs(retryAfter), message: `HTTP 429 from ${this.serverUrl}${retryAfter ? `, Retry-After ${retryAfter}` : ""}` };
    }
    this.refused = r.status === 401 ? this.refusedMessage(this.wasReady) : null;
    if (this.refused && !this.wasReady) {
      this.dead = true;
      const err = new Error(this.refused);
      for (const res of this.readyResolvers.splice(0)) res(err);
    }
    return { kind: this.refused ? "refused" : "ok" };
  }

  // Each refused attempt costs the address an auth failure (#240), so a
  // fleet retrying a dead token would lock out everyone behind its NAT.
  // Instead wait for a new sign-in, a local file read, or the slow retry,
  // jittered so a fleet signed out together doesn't come back in lockstep.
  private awaitNewToken(refusedToken: string): void {
    const { tokenPollMs = TOKEN_POLL_MS, signedOutRetryMs = SIGNED_OUT_RETRY_MS } = this.opts;
    const retryMs = Math.round(signedOutRetryMs * (1 + Math.random() / 2));
    const giveUpAt = Date.now() + retryMs;
    console.error(`[grayboard] the server refused the token of ${this.who()}; reconnecting after a new sign-in, or in ${Math.round(retryMs / 1000)}s`);
    const tick = () => {
      if (this.dead) return;
      if (this.token() !== refusedToken || Date.now() >= giveUpAt) return this.connect();
      setTimeout(tick, Math.min(tokenPollMs, giveUpAt - Date.now()));
    };
    setTimeout(tick, Math.min(tokenPollMs, retryMs));
  }

  private scheduleReconnect(): void {
    const delay = this.backoffMs;
    this.backoffMs = this.nextBackoff();
    this.reconnectIn(delay, "lost");
  }

  // Doubling, to 30 s before a first hello_ok and to 8 s after one.
  private nextBackoff(): number {
    return Math.min(this.backoffMs * 2, this.wasReady ? RESUME_BACKOFF_MAX_MS : 30_000);
  }

  private reconnectIn(delay: number, why: string): void {
    console.error(`[grayboard] connection as ${this.who()} ${why}; reconnecting in ${delay}ms`);
    setTimeout(() => this.connect(), delay);
  }

  /** Why the server is refusing this client's hellos for now, if it is. */
  rateLimited(): RateLimited | null {
    if (!this.limited) return null;
    const { what, message, retryAt } = this.limited;
    return { what, message, retryAt };
  }

  private who(): string {
    return `session ${this.id}`;
  }

  private send(msg: ClientMessage): void {
    this.ws?.send(JSON.stringify(msg));
  }

  // A delivery can finish after its socket closed, or on a new socket before
  // its hello_ok, where the server would close it for a frame before the
  // hello (A4). Its ack then goes out after the next hello_ok: the session
  // re-attached acks it; any other ignores ids it can't read.
  private ackWhenReady(ack: UnsentAck): void {
    if (this.ws?.readyState === WebSocket.OPEN && this.helloData) this.send({ ...ack, req_id: this.nextId() });
    else this.unsentAcks.push(ack);
  }

  private nextId(): string {
    return `c${++this.counter}`;
  }

  /** Throws unless requests can go out now: before hello_ok the server
   *  rejects them and closes the socket, so a caller fails fast instead.
   *  Returns this connection's hello_ok, which a reconnect replaces. */
  assertConnected(): HelloOk {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.helloData) {
      const limited = this.rateLimited();
      throw new Error(
        this.refused ??
          (limited
            ? `not connected to the grayboard server: it is rate-limiting ${limited.what} (${limited.message}); reconnecting when it allows`
            : "not connected to the grayboard server (reconnecting); try again shortly"),
      );
    }
    return this.helloData;
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

  /**
   * A clean exit (#284 S4): an unkeyed session ends at once, so it asks the
   * server to end it, waiting at most `ms` for the answer; a keyed one only
   * closes, leaving its orchestrator the grace to restart it. Then closes.
   */
  async end(ms: number): Promise<void> {
    if (!this.opts.keyed && this.helloData) {
      await Promise.race([this.request({ type: "end" }).catch((e) => console.error(`[grayboard] ending ${this.who()} failed: ${(e as Error).message}`)), Bun.sleep(ms)]);
    }
    this.close();
  }

  close(): void {
    this.dead = true;
    this.ws?.close();
    const err = new Error("closed");
    for (const r of this.readyResolvers.splice(0)) r(err);
  }

  private die(reason: string): void {
    this.dead = true;
    this.ws?.close();
    this.helloData = null;
    const err = new Error(reason);
    for (const r of this.readyResolvers.splice(0)) r(err);
    console.error(`[grayboard] ${reason}`);
    this.opts.onDead?.(reason);
  }
}

// The server's wait, trusted only within bounds: a missing, non-finite or
// absurd value (a timer past 2^31 ms fires at once in Bun) falls back to the
// backoff, so no server answer can make a hot reconnect loop.
const MIN_RETRY_MS = 100;
const MAX_RETRY_MS = 30_000;
export function retryWait(serverMs: unknown, backoffMs: number): number {
  if (typeof serverMs !== "number" || !Number.isFinite(serverMs) || serverMs < 0) return backoffMs;
  return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, serverMs));
}

// A Retry-After header in ms: delay-seconds or an HTTP date; anything else
// is undefined, which retryWait turns into the backoff.
export function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  if (/^\d+$/.test(header.trim())) return Number(header.trim()) * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}
