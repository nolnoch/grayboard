// A raw protocol client over the server's WebSocket: a proto-2 hello (#284),
// then a bind of its alias, requests by req_id, and an inbox of everything
// not awaited.
import { expect } from "bun:test";
import { randomBytes } from "node:crypto";
import { PROTO, type ServerMessage } from "../../src/shared/protocol.ts";

export type Any = ServerMessage & Record<string, any>;
// key: the session key (64 hex), minted when absent. hello: extra hello
// fields; bind: extra bind fields. headers: extra upgrade headers (an
// X-Forwarded-For, to come from another address). push: false with no hold
// is a tools-only connection, whose identity is its writes_as.
export type WsClientOptions = {
  pong?: boolean; push?: boolean; hold?: boolean; key?: string;
  hello?: Record<string, unknown>; bind?: Record<string, unknown>; headers?: Record<string, string>;
};

export const mintKey = (): string => randomBytes(32).toString("hex");

export class WsClient {
  ws!: WebSocket;
  inbox: Any[] = [];
  readonly key: string;
  // The session's ID, from hello_ok.
  id = "";
  private waiters: { pred: (m: Any) => boolean; resolve: (m: Any) => void; reject: (e: Error) => void }[] = [];
  private n = 0;

  constructor(
    private base: string,
    private token: string,
    // The alias to bind after the hello; null stays an unbound session.
    private identity: string | null,
    private opts: WsClientOptions = {},
  ) {
    this.key = opts.key ?? mintKey();
  }

  private get toolsOnly(): boolean {
    return this.opts.push === false && this.opts.hold !== true;
  }

  // Resolves with hello_ok (its bind_ok as .bind_ok when it bound), or the
  // error that refused the hello or the bind.
  async connect(): Promise<Any> {
    this.ws = new (WebSocket as any)(`${this.base.replace("http", "ws")}/ws`, {
      headers: { Authorization: `Bearer ${this.token}`, ...this.opts.headers },
    });
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data as string) as Any;
      if (m.type === "ping" && this.opts.pong !== false) this.ws.send(JSON.stringify({ type: "pong" }));
      const i = this.waiters.findIndex((w) => w.pred(m));
      if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(m);
      else this.inbox.push(m);
    };
    // A dropped socket fails every pending wait now, not at its timeout.
    this.ws.onclose = (e) => this.fail(`socket closed (${e.code}${e.reason ? ` ${e.reason}` : ""})`);
    this.ws.onerror = () => this.fail("socket error");
    this.ws.onopen = () =>
      this.ws.send(JSON.stringify({
        type: "hello", req_id: "h", proto: PROTO, session_key: this.key,
        ...(this.opts.push === false ? { push: false } : {}),
        ...(this.opts.hold ? { hold: true } : {}),
        ...(this.toolsOnly && this.identity !== null ? { writes_as: this.identity } : {}),
        ...this.opts.hello,
      }));
    const ok = await this.next((m) => m.type === "hello_ok" || (m.type === "error" && m.req_id === "h"));
    if (ok.type !== "hello_ok") return ok;
    this.id = ok.id;
    if (this.identity === null || this.toolsOnly || ok.bound === this.qualified(ok)) return ok;
    const b = await this.bind(this.identity, this.opts.bind);
    return b.type === "bind_ok" ? { ...ok, bind_ok: b } : b;
  }

  private qualified(ok: Any): string {
    return this.identity!.includes("/") ? this.identity! : `${ok.user_email}/${this.identity}`;
  }

  bind(alias: string, extra: Record<string, unknown> = {}): Promise<Any> {
    return this.request({ type: "bind", alias, ...extra });
  }

  next(pred: (m: Any) => boolean, ms = 1000): Promise<Any> {
    const i = this.inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const j = this.waiters.indexOf(w);
        if (j >= 0) {
          this.waiters.splice(j, 1);
          reject(new Error(`${this.label}: timed out waiting`));
        }
      }, ms);
      const w = {
        pred,
        resolve: (m: Any) => (clearTimeout(timer), resolve(m)),
        reject: (e: Error) => (clearTimeout(timer), reject(e)),
      };
      this.waiters.push(w);
    });
  }

  private get label(): string {
    return this.identity ?? (this.id || "unbound");
  }

  private fail(why: string): void {
    for (const w of this.waiters.splice(0)) w.reject(new Error(`${this.label}: ${why}`));
  }

  // Nothing matching arrives within ms.
  async none(pred: (m: Any) => boolean, ms = 150): Promise<void> {
    await Bun.sleep(ms);
    expect(this.inbox.filter(pred)).toEqual([]);
  }

  async request(msg: Record<string, unknown>): Promise<Any> {
    const req_id = `r${++this.n}`;
    this.ws.send(JSON.stringify({ ...msg, req_id }));
    return this.next((m) => m.req_id === req_id);
  }

  async call(tool: string, args: Record<string, unknown> = {}): Promise<Any> {
    return this.request({ type: "call", tool, args });
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}
