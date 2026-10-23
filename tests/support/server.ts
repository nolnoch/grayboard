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
    ...overrides,
  };
}

// A dev-auth session token for `email` on the server at `base`.
export async function devLogin(base: string, email: string): Promise<string> {
  const r = await fetch(`${base}/api/auth/dev-login`, { method: "POST", body: JSON.stringify({ email }) });
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
    const q = `identity=${encodeURIComponent(identity)}&filename=${encodeURIComponent(filename)}`;
    const r = await fetch(`${this.base}/api/attachments?${q}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: data,
    });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  }

  // A raw WebSocket client; closed by stop().
  client(token: string, identity: string, opts: WsClientOptions = {}): WsClient {
    const c = new WsClient(this.base, token, identity, opts);
    this.clients.push(c);
    return c;
  }

  // A server-mode `grayboard mcp` child signed in with `token`, started in
  // this server's dir; closeSessions() ends it.
  session(token: string, identity: string, extra: Record<string, string> = {}): Promise<Session> {
    return mcpSession({ env: serverEnv(this.dir, this.base, token, identity, extra), cwd: this.dir, args: ["mcp", "--mode", "server"] });
  }

  stop(): void {
    for (const c of this.clients.splice(0)) c.close();
    this.app.stop();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

// A compiled grayboard-server (a release, or the build under test) as its own
// process: dev auth, port 0, its DB at `dbPath` and its blobs beside it. Ready
// once it prints the port it listens on.
export class ServerProcess {
  private constructor(
    readonly proc: Subprocess<"ignore", "pipe", "pipe">,
    readonly base: string,
    readonly log: () => string,
  ) {}

  static async start(bin: string, dbPath: string, extra: Record<string, string> = {}): Promise<ServerProcess> {
    const proc = Bun.spawn([bin], {
      env: cleanEnv({ GRAYBOARD_DEV_AUTH: "1", GRAYBOARD_DB_PATH: dbPath, GRAYBOARD_PUBLIC_URL: "http://localhost", GRAYBOARD_HTTP_PORT: "0", ...extra }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    let out = "";
    const stderr = new Response(proc.stderr).text().then((t) => (out += t));
    const log = () => out;
    const reader = proc.stdout.getReader();
    const deadline = setTimeout(() => proc.kill("SIGKILL"), 10_000);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          const code = await proc.exited;
          await stderr;
          throw new Error(`${bin} exited before listening (code ${code})\n${out}`);
        }
        out += new TextDecoder().decode(value);
        const port = /listening on port (\d+)/.exec(out)?.[1];
        if (port) {
          // Keep draining stdout so the server never blocks on a full pipe.
          void (async () => {
            for (let r = await reader.read(); !r.done; r = await reader.read()) out += new TextDecoder().decode(r.value);
          })();
          return new ServerProcess(proc, `http://localhost:${port}`, log);
        }
      }
    } finally {
      clearTimeout(deadline);
    }
  }

  login(email: string): Promise<string> {
    return devLogin(this.base, email);
  }

  // SIGTERM runs the server's own shutdown, which closes its database.
  async stop(): Promise<void> {
    this.proc.kill("SIGTERM");
    await this.proc.exited;
  }
}
