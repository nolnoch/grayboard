// An in-process grayboard server on port 0 with dev auth and an in-memory DB.
// It owns a temp dir: its blobs (unless overridden) and the files of every
// session it starts live there, and stop() removes it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_RETENTION_DAYS } from "../../src/core/boards.ts";
import { startServer, type StartOptions } from "../../src/server/app.ts";
import type { Config } from "../../src/server/config.ts";
import { serverEnv } from "./env.ts";
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

  // A dev-auth session token for `email`.
  async login(email: string): Promise<string> {
    const r = await fetch(`${this.base}/api/auth/dev-login`, { method: "POST", body: JSON.stringify({ email }) });
    if (!r.ok) throw new Error(`dev-login ${email}: ${r.status} ${await r.text()}`);
    return ((await r.json()) as { session_token: string }).session_token;
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
