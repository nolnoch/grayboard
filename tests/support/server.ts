// An in-process grayboard server on port 0 with dev auth and an in-memory DB.
// It owns a temp dir: its blobs (unless overridden) and the files of every
// session it starts live there, and stop() removes it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { DEFAULT_RETENTION_DAYS } from "../../src/core/boards.ts";
import { startServer, type StartOptions } from "../../src/server/app.ts";
import type { Config } from "../../src/server/config.ts";
import { DEFAULT_AUTH_FAIL_LIMIT, DEFAULT_HELLO_LIMIT } from "../../src/server/rate_limit.ts";
import { DEFAULT_TRUSTED_PROXIES } from "../../src/server/client_addr.ts";
import { cleanEnv, serverEnv } from "./env.ts";
import { mcpSession, type Session } from "./mcp.ts";
import { WsClient, type WsClientOptions } from "./ws_client.ts";

function serverConfig(dir: string, overrides: Partial<Config>): Config {
  return {
    dbPath: ":memory:",
    blobDir: join(dir, "blobs"),
    httpPort: 0,
    googleClientId: "dev",
    googleClientSecret: "",
    orgDomain: "example.com",
    publicUrl: "http://localhost",
    messageRetentionDays: DEFAULT_RETENTION_DAYS,
    auditRetentionDays: 90,
    devAuth: true,
    admins: [],
    helloLimit: DEFAULT_HELLO_LIMIT,
    authFailLimit: DEFAULT_AUTH_FAIL_LIMIT,
    trustedProxies: DEFAULT_TRUSTED_PROXIES,
    ...overrides,
  };
}

// A dev-auth session token for `email` on the server at `base`.
export async function devLogin(base: string, email: string): Promise<string> {
  const r = await fetch(`${base}/api/auth/dev-login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
  if (!r.ok) throw new Error(`dev-login ${email}: ${r.status} ${await r.text()}`);
  return ((await r.json()) as { session_token: string }).session_token;
}

export class TestServer {
  readonly app: ReturnType<typeof startServer>;
  readonly base: string;
  readonly config: Config;
  readonly dir = mkdtempSync(join(tmpdir(), "gb-server-"));
  private clients: WsClient[] = [];

  // Tests skip the background timers unless they pass `background`.
  constructor(overrides: Partial<Config> = {}, opts: StartOptions = {}) {
    this.config = serverConfig(this.dir, overrides);
    this.app = startServer(this.config, { background: false, ...opts });
    this.base = `http://localhost:${this.app.server.port}`;
  }

  login(email: string): Promise<string> {
    return devLogin(this.base, email);
  }

  async api(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const r = await fetch(`${this.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  }

  async upload(token: string, identity: string, filename: string, data: Uint8Array | string): Promise<{ status: number; body: Record<string, any> }> {
    const q = `as=${encodeURIComponent(identity)}&filename=${encodeURIComponent(filename)}`;
    const r = await fetch(`${this.base}/api/attachments?${q}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: data as BodyInit,
    });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  }

  // A raw WebSocket client (identity null: an unbound session); closed by stop().
  client(token: string, identity: string | null, opts: WsClientOptions = {}): WsClient {
    const c = new WsClient(this.base, token, identity, opts);
    this.clients.push(c);
    return c;
  }

  // A server-mode `grayboard mcp` child signed in with `token`, started in
  // `cwd` (default: this server's dir); identity null starts it unbound.
  // closeSessions() ends it.
  session(token: string, identity: string | null, extra: Record<string, string> = {}, cwd = this.dir): Promise<Session> {
    return mcpSession({ env: serverEnv(this.dir, this.base, token, identity, extra), cwd, args: ["mcp", "--mode", "server"] });
  }

  async stop(): Promise<void> {
    for (const c of this.clients.splice(0)) c.close();
    await this.app.stop();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

// A grayboard server as its own process: a compiled binary (a release, or the
// build under test), or a command line (this tree's src/server/main.ts under
// bun, so a sync testPause blocks only the server). Dev auth, port 0, its DB
// at `dbPath` and its blobs beside it. Ready
// once it prints the port it listens on. Its stdout and stderr are drained
// into one log as they arrive, so it never blocks on a full pipe and log()
// mid-run has both.
export class ServerProcess {
  private constructor(
    readonly proc: Subprocess<"ignore", "pipe", "pipe">,
    readonly base: string,
    private readonly out: { text: string },
    private readonly drained: Promise<unknown>,
  ) {}

  static async start(bin: string | string[], dbPath: string, extra: Record<string, string> = {}): Promise<ServerProcess> {
    const proc = Bun.spawn(Array.isArray(bin) ? bin : [bin], {
      env: cleanEnv({ GRAYBOARD_DEV_AUTH: "1", GRAYBOARD_DB_PATH: dbPath, GRAYBOARD_PUBLIC_URL: "http://localhost", GRAYBOARD_HTTP_PORT: "0", ...extra }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = { text: "" };
    const drain = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) out.text += decoder.decode(chunk, { stream: true });
      out.text += decoder.decode();
    };
    const drained = Promise.all([drain(proc.stdout), drain(proc.stderr)]);
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, 10_000);
    const exited = proc.exited.then((code) => ({ code }));
    try {
      for (;;) {
        const port = /listening on port (\d+)\n/.exec(out.text)?.[1];
        if (port) return new ServerProcess(proc, `http://localhost:${port}`, out, drained);
        const done = await Promise.race([exited, Bun.sleep(20)]);
        if (done) {
          await drained;
          throw new Error(timedOut ? `${bin} didn't listen within 10 s; killed\n${out.text}` : `${bin} exited before listening (code ${done.code})\n${out.text}`);
        }
      }
    } finally {
      clearTimeout(deadline);
    }
  }

  // Everything it has printed so far, stdout and stderr interleaved.
  log(): string {
    return this.out.text;
  }

  login(email: string): Promise<string> {
    return devLogin(this.base, email);
  }

  // SIGTERM runs the server's own shutdown (it doesn't close its database,
  // #168: a copy needs the -wal and -shm files beside it); SIGKILL after 5 s.
  // Resolves once it has exited and its output is all in log().
  async stop(): Promise<void> {
    this.proc.kill("SIGTERM");
    const force = setTimeout(() => this.proc.kill("SIGKILL"), 5_000);
    try {
      await this.proc.exited;
      await this.drained;
    } finally {
      clearTimeout(force);
    }
  }
}
