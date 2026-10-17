// Slack Socket Mode client on Bun's built-in WebSocket. Written by hand
// because @slack/socket-mode drives its heartbeat through undici internals
// (undici.ping, diagnostics_channel) that Bun's undici shim doesn't have; under
// Bun it drops every connection ~2s after connecting.
//
// Protocol (docs.slack.dev/apis/events-api/using-socket-mode): open() returns a
// wss:// URL from apps.connections.open; the server sends "hello", then
// envelopes {type, envelope_id, payload}; each envelope is acked by sending
// {envelope_id} back. "disconnect" warns of a refresh: we connect again and
// drop the old socket once the new one says hello.

export type SocketLog = (msg: string) => void;

export type SocketOptions = {
  /** A fresh wss:// URL (apps.connections.open). */
  open: () => Promise<string>;
  /** An events_api payload. The envelope is acked after this settles. */
  onEvent: (payload: Record<string, any>) => Promise<void>;
  /** Socket Mode was turned off for the app (disconnect reason link_disabled). */
  onFatal: (reason: string) => void;
  log?: SocketLog;
  /** Detail for checking Slack's behavior live (GRAYBOARD_SLACK_DEBUG). */
  debug?: SocketLog;
  /** How often to ping Slack; also the watchdog's tick. */
  pingMs?: number;
  /** Silence (no frame of any kind) after which the connection counts as dead. */
  deadMs?: number;
  maxBackoffMs?: number;
};

type Conn = { ws: WebSocket; lastHeard: number; hello: boolean };

const SEEN_MAX = 1000;

export class SocketMode {
  private current: Conn | null = null;
  private pending: Conn | null = null;
  private stopped = false;
  private backoff = 1000;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private readonly seen = new Set<string>();
  private said = false;
  private firstHello!: () => void;
  private neverReady!: (e: Error) => void;
  private readonly ready = new Promise<void>((resolve, reject) => {
    this.firstHello = resolve;
    this.neverReady = reject;
  });
  private readonly o: Required<SocketOptions>;

  constructor(opts: SocketOptions) {
    // Slack pings about every 10s (measured live), so 30s of silence is three missed pings.
    // ?? rather than spread defaults: callers pass debug: undefined when it's off.
    this.o = { pingMs: 10_000, deadMs: 30_000, maxBackoffMs: 60_000, ...opts, log: opts.log ?? (() => {}), debug: opts.debug ?? (() => {}) };
  }

  /**
   * Connect; resolves on the first hello and reconnects on its own after that.
   * Rejects if the client stops (or hits a fatal error) before any hello.
   */
  async start(): Promise<void> {
    this.watchdog = setInterval(() => this.tick(), this.o.pingMs);
    await this.connect();
    await this.ready;
  }

  stop(reason = "stopped before connecting"): void {
    if (!this.said) this.neverReady(new Error(reason));
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    for (const c of [this.current, this.pending]) c?.ws.close();
    this.current = this.pending = null;
  }

  /** Whether a connection is up (said hello and hasn't closed). */
  get connected(): boolean {
    return !!this.current?.hello;
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.pending) return;
    let url: string;
    try {
      url = await this.o.open();
    } catch (e) {
      // A bad or revoked app token won't fix itself.
      if ((e as { fatal?: boolean }).fatal) {
        const reason = `can't open a Socket Mode connection: ${(e as Error).message}`;
        this.stop(reason);
        this.o.onFatal(reason);
        return;
      }
      this.o.log(`socket: can't get a connection URL: ${(e as Error).message}`);
      this.retryLater();
      return;
    }
    if (this.stopped) return;
    const conn: Conn = { ws: new WebSocket(url), lastHeard: Date.now(), hello: false };
    this.pending = conn;
    const heard = () => (conn.lastHeard = Date.now());
    // Bun's client fires these for protocol-level pings and pongs (and answers
    // pings on its own); the DOM typings don't list them.
    let lastPing = Date.now();
    conn.ws.addEventListener("ping" as any, () => {
      this.o.debug(`socket: Slack pinged, ${Math.round((Date.now() - lastPing) / 1000)}s after the last ping or connect`);
      lastPing = heard();
    });
    conn.ws.addEventListener("pong" as any, heard);
    conn.ws.addEventListener("message", (ev) => {
      heard();
      void this.onFrame(conn, String((ev as MessageEvent).data));
    });
    conn.ws.addEventListener("close", (ev) => this.onClose(conn, (ev as CloseEvent).code));
    conn.ws.addEventListener("error", () => {}); // close follows; handled there
  }

  private retryLater(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.o.maxBackoffMs);
    this.o.log(`socket: reconnecting in ${Math.round(delay / 1000)}s`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }

  private onClose(conn: Conn, code: number): void {
    if (conn === this.pending) this.pending = null;
    if (conn !== this.current) {
      // A replaced socket closing, or a new one that never said hello.
      if (!conn.hello && !this.current) this.retryLater();
      return;
    }
    this.current = null;
    if (this.stopped) return;
    this.o.log(`socket: closed (${code})`);
    this.retryLater();
  }

  private async onFrame(conn: Conn, raw: string): Promise<void> {
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case "hello": {
        conn.hello = true;
        if (conn === this.pending) this.pending = null;
        const old = this.current;
        this.current = conn;
        this.backoff = 1000;
        old?.ws.close();
        this.o.log("socket: connected");
        this.said = true;
        this.firstHello();
        return;
      }
      case "disconnect": {
        if (msg.reason === "link_disabled") {
          const reason = "Socket Mode was disabled for this Slack app (link_disabled)";
          this.stop(reason);
          this.o.onFatal(reason);
          return;
        }
        // warning / refresh_requested: bring up the replacement now; the old
        // socket stays until the new one says hello.
        this.o.log(`socket: Slack asked to reconnect (${msg.reason ?? "no reason"})`);
        if (conn === this.current) void this.connect();
        return;
      }
    }
    if (!msg.envelope_id) return;
    const id = String(msg.envelope_id);
    if (msg.type === "events_api" && msg.payload) {
      const eventId = String(msg.payload.event_id ?? id);
      if (!this.seen.has(eventId)) {
        this.remember(eventId);
        try {
          await this.o.onEvent(msg.payload);
        } catch (e) {
          this.o.log(`socket: event handler failed: ${(e as Error).message}`);
        }
      }
    }
    // Every envelope gets acked, including types we don't handle, so Slack
    // doesn't retry them.
    if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify({ envelope_id: id }));
  }

  private remember(eventId: string): void {
    this.seen.add(eventId);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value!);
  }

  // Every pingMs: declare a silent connection dead, else ping it. A dead
  // socket after a sleep or network change can otherwise look open forever.
  private tick(): void {
    if (this.stopped) return;
    // A connect that never opened or closed (e.g. a stalled TLS handshake).
    const p = this.pending;
    if (p && !p.hello && Date.now() - p.lastHeard > this.o.deadMs) {
      this.o.log("socket: connect attempt stalled; retrying");
      this.pending = null;
      kill(p.ws);
      if (!this.current) this.retryLater();
    }
    const c = this.current;
    if (!c) return;
    if (Date.now() - c.lastHeard > this.o.deadMs) {
      this.o.log(`socket: nothing heard for ${Math.round(this.o.deadMs / 1000)}s; reconnecting`);
      this.current = null;
      kill(c.ws);
      this.retryLater();
      return;
    }
    try {
      (c.ws as WebSocket & { ping?: () => void }).ping?.();
    } catch {}
  }
}

// Drop a socket now, without waiting on a close handshake a dead peer won't answer.
function kill(ws: WebSocket): void {
  const w = ws as WebSocket & { terminate?: () => void };
  if (w.terminate) w.terminate();
  else w.close();
}
