// An in-process grayboard server on port 0 with dev auth and an in-memory DB.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type StartOptions } from "../../src/server/app.ts";
import type { Config } from "../../src/server/config.ts";
import { WsClient, type WsClientOptions } from "./ws_client.ts";

export function serverConfig(overrides: Partial<Config> = {}): Config {
  return {
    dbPath: ":memory:",
    blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")),
    httpPort: 0,
    googleClientId: "dev",
    googleClientSecret: "",
    orgDomain: "example.com",
    publicUrl: "http://localhost",
    messageRetentionDays: 90,
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
  private clients: WsClient[] = [];

  // Tests skip the background timers unless they pass `background`.
  constructor(overrides: Partial<Config> = {}, opts: StartOptions = {}) {
    this.config = serverConfig(overrides);
    this.app = startServer(this.config, { background: false, ...opts });
    this.base = `http://localhost:${this.app.server.port}`;
  }

  // A dev-auth session token for `email`.
  async login(email: string): Promise<string> {
    const r = await fetch(`${this.base}/api/auth/dev-login`, { method: "POST", body: JSON.stringify({ email }) });
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
    const r = await fetch(`${this.base}/api/attachments?identity=${identity}&filename=${encodeURIComponent(filename)}`, {
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

  stop(): void {
    for (const c of this.clients.splice(0)) c.close();
    this.app.stop();
    rmSync(this.config.blobDir, { recursive: true, force: true });
  }
}
