// Just enough Slack for the bridge tests: the Web API methods the bridges
// call, and a Socket Mode WebSocket, over Bun.serve.
import type { ServerWebSocket } from "bun";

type Call = { method: string; body: Record<string, any> };

// Just enough Slack: auth.test, apps.connections.open, chat.postMessage,
// reactions.add, and a Socket Mode WebSocket that says hello and records acks.
export class FakeSlack {
  constructor(private readonly o: { channel: string; owner: string; channelType: "group" | "im" }) {}

  calls: Call[] = [];
  acks: string[] = [];
  opens = 0;
  failPosts = 0;
  badAppToken = false;
  /** The ts each successful chat.postMessage got. */
  readonly postTs = new WeakMap<Record<string, any>, string>();
  private sockets: ServerWebSocket<unknown>[] = [];
  private ts = 1_700_000_000;
  private envelope = 0;
  readonly server = Bun.serve({
    port: 0,
    fetch: async (req, srv) => {
      const url = new URL(req.url);
      if (url.pathname === "/ws") return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
      const method = url.pathname.replace(/^\/api\//, "");
      const body = (await req.json().catch(() => ({}))) as Record<string, any>;
      this.calls.push({ method, body });
      switch (method) {
        case "auth.test":
          return Response.json({ ok: true, user_id: "UBOT", bot_id: "BBOT", team: "test" });
        case "apps.connections.open":
          if (this.badAppToken) return Response.json({ ok: false, error: "invalid_auth" });
          this.opens++;
          return Response.json({ ok: true, url: `ws://localhost:${this.server.port}/ws` });
        case "chat.postMessage":
          if (this.failPosts > 0) {
            this.failPosts--;
            return new Response("unavailable", { status: 503 });
          }
          const ts = `${++this.ts}.000100`;
          this.postTs.set(body, ts);
          return Response.json({ ok: true, channel: body.channel, ts });
        case "reactions.add":
          return Response.json({ ok: true });
      }
      return Response.json({ ok: false, error: "unknown_method" });
    },
    websocket: {
      open: (ws) => {
        this.sockets.push(ws);
        ws.send(JSON.stringify({ type: "hello", num_connections: 1, connection_info: { app_id: "A1" } }));
      },
      message: (_ws, raw) => {
        const m = JSON.parse(String(raw));
        if (m.envelope_id) this.acks.push(m.envelope_id);
      },
      close: (ws) => {
        this.sockets = this.sockets.filter((s) => s !== ws);
      },
    },
  });

  get api(): string {
    return `http://localhost:${this.server.port}/api/`;
  }

  posts(): Record<string, any>[] {
    return this.calls.filter((c) => c.method === "chat.postMessage").map((c) => c.body);
  }

  reactions(): Record<string, any>[] {
    return this.calls.filter((c) => c.method === "reactions.add").map((c) => c.body);
  }

  /** A message event from Slack, as the owner by default. Returns its envelope_id. */
  say(text: string, opts: { thread_ts?: string; user?: string; channel?: string; event_id?: string; extra?: Record<string, any> } = {}): { envelope: string; ts: string } {
    const ts = `${++this.ts}.000200`;
    const envelope = `env-${++this.envelope}`;
    const event = { type: "message", channel: opts.channel ?? this.o.channel, channel_type: this.o.channelType, user: opts.user ?? this.o.owner, text, ts, ...(opts.thread_ts ? { thread_ts: opts.thread_ts } : {}), ...opts.extra };
    this.send({ type: "events_api", envelope_id: envelope, accepts_response_payload: false, payload: { type: "event_callback", event_id: opts.event_id ?? `Ev${envelope}`, event } });
    return { envelope, ts };
  }

  send(frame: unknown): void {
    for (const s of this.sockets) s.send(JSON.stringify(frame));
  }

  stop(): void {
    this.server.stop(true);
  }
}
