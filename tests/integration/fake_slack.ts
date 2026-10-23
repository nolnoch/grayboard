// Just enough Slack for the bridge tests: the Web API methods the bridges
// call, and a Socket Mode WebSocket, over Bun.serve.
import type { ServerWebSocket } from "bun";

type Call = { method: string; body: Record<string, any> };

// Just enough Slack: auth.test, apps.connections.open, chat.postMessage,
// reactions.add, the external file upload (get URL, send bytes, complete),
// files.info (hosted files, and uploaded ones with their shares) and file
// downloads, and a Socket Mode WebSocket that says hello and records acks.
export class FakeSlack {
  constructor(private readonly o: { channel: string; owner: string; channelType: "group" | "im" }) {}

  calls: Call[] = [];
  acks: string[] = [];
  opens = 0;
  failPosts = 0;
  badAppToken = false;
  /** An error files.getUploadURLExternal answers with, e.g. "file_type_not_allowed". */
  refuseUploads: string | null = null;
  /** Bytes sent to each upload URL, by file id. */
  readonly uploaded = new Map<string, Uint8Array>();
  /** Where completeUploadExternal shared each uploaded file: files.info's `shares`. */
  private readonly shared = new Map<string, { ts: string; thread_ts?: string }>();
  /** files.info answers for an uploaded file this many times before its shares show. */
  shareLag = 0;
  /** Files the owner can share: what say() sends in an event's files. */
  private readonly hosted = new Map<string, { name: string; data: Uint8Array }>();
  private fileN = 0;
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
      if (url.pathname.startsWith("/upload/")) {
        this.uploaded.set(url.pathname.slice("/upload/".length), new Uint8Array(await req.arrayBuffer()));
        return new Response("OK - 1");
      }
      if (url.pathname.startsWith("/files/")) {
        const f = this.hosted.get(url.pathname.slice("/files/".length));
        // Slack serves its sign-in page to a request it won't authorize.
        if (!f || !req.headers.get("authorization")?.startsWith("Bearer xoxb-")) return new Response("<html>sign in</html>", { headers: { "Content-Type": "text/html" } });
        return new Response(f.data);
      }
      const method = url.pathname.replace(/^\/api\//, "");
      const body = await parseBody(req);
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
        case "files.getUploadURLExternal": {
          if (this.refuseUploads) return Response.json({ ok: false, error: this.refuseUploads });
          if (!body.filename || !(Number(body.length) > 0)) return Response.json({ ok: false, error: "missing_argument" });
          const file_id = `F${++this.fileN}`;
          return Response.json({ ok: true, file_id, upload_url: `http://localhost:${this.server.port}/upload/${file_id}` });
        }
        case "files.completeUploadExternal": {
          const files = JSON.parse(String(body.files ?? "[]")) as { id: string; title?: string }[];
          if (!files.length || files.some((f) => !this.uploaded.has(f.id))) return Response.json({ ok: false, error: "file_not_found" });
          // Like Slack: one message, and an answer that names the files but not the message.
          const ts = `${++this.ts}.000100`;
          this.postTs.set(body, ts);
          for (const f of files) this.shared.set(f.id, { ts, ...(body.thread_ts ? { thread_ts: String(body.thread_ts) } : {}) });
          return Response.json({ ok: true, files: files.map((f) => ({ id: f.id, title: f.title })) });
        }
        case "files.info": {
          const id = String(body.file);
          const share = this.shared.get(id);
          if (this.uploaded.has(id)) {
            const lagging = this.shareLag > 0 && this.shareLag-- > 0;
            const shares = share && !lagging ? { private: { [this.o.channel]: [share] } } : {};
            return Response.json({ ok: true, file: { id, name: id, size: this.uploaded.get(id)!.length, shares } });
          }
          const f = this.hosted.get(id);
          if (!f) return Response.json({ ok: false, error: "file_not_found" });
          return Response.json({ ok: true, file: this.fileObject(id, f) });
        }
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

  /** files.completeUploadExternal calls, with files and blocks parsed, and the ts of the message each made. */
  shares(): Record<string, any>[] {
    return this.calls
      .filter((c) => c.method === "files.completeUploadExternal")
      .map((c) => ({ ...c.body, files: JSON.parse(c.body.files), blocks: c.body.blocks ? JSON.parse(c.body.blocks) : undefined, ts: this.postTs.get(c.body) }));
  }

  /** A file the owner can attach to a message; its event object, or only its id with `idOnly`. */
  host(name: string, data: Uint8Array | string, opts: { idOnly?: boolean; size?: number } = {}): Record<string, any> {
    const id = `FH${++this.fileN}`;
    const f = { name, data: typeof data === "string" ? new TextEncoder().encode(data) : data };
    this.hosted.set(id, f);
    return opts.idOnly ? { id, mode: "file_access", file_access: "check_file_info" } : { ...this.fileObject(id, f), ...(opts.size ? { size: opts.size } : {}) };
  }

  private fileObject(id: string, f: { name: string; data: Uint8Array }): Record<string, any> {
    return { id, name: f.name, title: f.name, size: f.data.length, mimetype: "application/octet-stream", url_private_download: `http://localhost:${this.server.port}/files/${id}` };
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

// The Web API takes JSON or form-encoded arguments.
async function parseBody(req: Request): Promise<Record<string, any>> {
  if ((req.headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(await req.text()));
  }
  return (await req.json().catch(() => ({}))) as Record<string, any>;
}
