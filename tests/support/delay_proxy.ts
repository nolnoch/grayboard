// A TCP proxy that delays each direction's data by a fixed time (#1510): the loadtest's `--pg-latency` puts it between
// the server and Postgres, so a round trip grows by twice the delay, the way a network hop to a managed database would.
// Each connection gets its own upstream connection; its bytes keep their order (one FIFO per direction, every chunk due
// `delayMs` after it arrived), and when either side closes, the other is closed once what it was owed has gone out.
//
// Timers in Bun fire no sooner than about 1 ms, so a delay under that is reached by polling with setImmediate (one check
// per event-loop turn) while a chunk is due within the next ~1.5 ms; a longer wait sleeps on a timer first. The poll
// costs CPU only while data is in flight.
import type { Socket, TCPSocketListener } from "bun";

type Chunk = { due: number; bytes: Uint8Array };
// One direction: chunks waiting out their delay, then whatever the destination's buffer didn't take (sent on drain).
class Pipe {
  readonly queue: Chunk[] = [];
  head = 0;
  unsent: Uint8Array | undefined;
  armed = false;
  // The source closed: end the destination once everything queued has been written.
  ending = false;
  to: Socket<Side> | undefined;
  constructor(private readonly delayMs: number, private readonly onIdleEnd: () => void) {}

  push(bytes: Uint8Array) {
    this.queue.push({ due: performance.now() + this.delayMs, bytes });
    this.arm();
  }

  arm() {
    if (this.armed || !this.to || this.head >= this.queue.length) return this.maybeEnd();
    const wait = this.queue[this.head]!.due - performance.now();
    if (wait <= 0) return this.flush();
    this.armed = true;
    const tick = () => { this.armed = false; this.arm(); };
    if (wait > 1.5) setTimeout(tick, wait - 1.2); else setImmediate(tick);
  }

  flush() {
    const now = performance.now();
    while (this.head < this.queue.length && this.queue[this.head]!.due <= now) {
      const { bytes } = this.queue[this.head++]!;
      this.unsent = this.unsent ? concat(this.unsent, bytes) : bytes;
    }
    if (this.head > 1024 && this.head * 2 > this.queue.length) { this.queue.splice(0, this.head); this.head = 0; }
    this.drain();
    this.arm();
  }

  // Writes what the destination will take; the rest waits for its drain event.
  drain() {
    if (!this.unsent || !this.to) return;
    const n = this.to.write(this.unsent);
    if (n < 0) { this.unsent = undefined; return; }
    this.unsent = n < this.unsent.length ? this.unsent.subarray(n) : undefined;
    this.maybeEnd();
  }

  maybeEnd() {
    if (this.ending && !this.unsent && this.head >= this.queue.length) this.onIdleEnd();
  }
}

const concat = (a: Uint8Array, b: Uint8Array) => { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; };

// Per accepted connection: the two pipes and both sockets.
type Conn = { down: Pipe; up: Pipe; client: Socket<Side>; server?: Socket<Side>; closed: boolean };
type Side = { conn: Conn; side: "client" | "server" };

export type DelayProxy = { port: number; url(upstream: string): string; connections(): number; stop(): void };

// Listens on 127.0.0.1 (an ephemeral port), forwarding to `upstream` with `delayMs` added each way.
export function startDelayProxy(upstream: { hostname: string; port: number }, delayMs: number): DelayProxy {
  if (!(delayMs >= 0)) throw new Error(`delay must be a non-negative number of ms, not ${delayMs}`);
  const live = new Set<Conn>();
  const close = (conn: Conn) => {
    if (conn.closed) return;
    conn.closed = true;
    live.delete(conn);
    conn.client.end();
    conn.server?.end();
  };
  // A side closed: what it already sent still goes out, then the other side closes.
  const sideClosed = (conn: Conn, side: "client" | "server") => {
    const pipe = side === "client" ? conn.up : conn.down;
    pipe.ending = true;
    pipe.arm();
  };
  const handlers = {
    data(socket: Socket<Side>, data: Uint8Array) {
      const { conn, side } = socket.data;
      // Copied: the chunk waits past this callback.
      (side === "client" ? conn.up : conn.down).push(new Uint8Array(data));
    },
    drain(socket: Socket<Side>) {
      const { conn, side } = socket.data;
      (side === "client" ? conn.down : conn.up).drain();
    },
    close(socket: Socket<Side>) { sideClosed(socket.data.conn, socket.data.side); },
    end(socket: Socket<Side>) { sideClosed(socket.data.conn, socket.data.side); },
    error(socket: Socket<Side>) { close(socket.data.conn); },
  };
  const listener: TCPSocketListener<Side> = Bun.listen<Side>({
    hostname: "127.0.0.1", port: 0,
    socket: {
      ...handlers,
      open(client) {
        client.setNoDelay(true);
        const conn: Conn = { client, closed: false } as Conn;
        conn.down = new Pipe(delayMs, () => close(conn));
        conn.up = new Pipe(delayMs, () => close(conn));
        conn.down.to = client;
        client.data = { conn, side: "client" };
        live.add(conn);
        Bun.connect<Side>({
          hostname: upstream.hostname, port: upstream.port, data: { conn, side: "server" },
          socket: { ...handlers, open(server) { server.setNoDelay(true); conn.server = server; conn.up.to = server; if (conn.closed) server.end(); else conn.up.arm(); }, connectError() { close(conn); } },
        }).catch(() => close(conn));
      },
    },
  });
  return {
    port: listener.port,
    // `upstream` (a postgres:// URL) with its host and port pointed here.
    url(target: string) { const u = new URL(target); u.hostname = "127.0.0.1"; u.port = String(listener.port); return u.toString(); },
    connections: () => live.size,
    stop() { listener.stop(true); for (const c of [...live]) close(c); },
  };
}
