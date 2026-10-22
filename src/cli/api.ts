import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Credentials = { session_token: string; server: string; user_email: string };

export function credentialsPath(env = process.env): string {
  return env.GRAYBOARD_CREDENTIALS ?? join(homedir(), ".grayboard", "credentials");
}

/**
 * Which bus `grayboard mcp` joins. Signed in to a server (a credentials file
 * exists) → server mode; otherwise local. A signed-out credentials file still
 * counts as server mode, so the MCP server fails with "run grayboard login"
 * instead of quietly moving you to a different bus.
 */
export function busMode(env = process.env): "local" | "server" {
  if (env.GRAYBOARD_TOKEN) return "server";
  return existsSync(credentialsPath(env)) ? "server" : "local";
}

export function loadCredentials(): Credentials | null {
  const credPath = credentialsPath();
  if (!existsSync(credPath)) return null;
  try {
    return JSON.parse(readFileSync(credPath, "utf8")) as Credentials;
  } catch {
    return null;
  }
}

/** What to tell someone whose token the server refused (401). envToken: it came from GRAYBOARD_TOKEN (MCP only). */
export function signInHint(server: string | undefined, envToken = false): string {
  const at = server ? ` at ${server}` : "";
  if (envToken) return `the server${at} refused GRAYBOARD_TOKEN; set a valid one or unset it`;
  return `your sign-in isn't valid on ${server ?? "the server"} (signed out, expired, revoked, or the server's database was reset). ` +
    `Run: grayboard login${server ? ` --server ${server}` : ""}`;
}

export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string | null = null,
  ) {}

  private async fetch(path: string, options: RequestInit = {}): Promise<unknown> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;

    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: { ...headers, ...(options.headers as Record<string, string> | undefined ?? {}) },
    });

    if (!res.ok) throw await apiError(res);
    try { return await res.json(); } catch { return {}; }
  }

  get(path: string)                  { return this.fetch(path); }
  post(path: string, body?: unknown) { return this.fetch(path, { method: "POST",  body: body !== undefined ? JSON.stringify(body) : undefined }); }
  del(path: string)                  { return this.fetch(path, { method: "DELETE" }); }
  // A raw body (an attachment upload); the answer is JSON.
  upload(path: string, data: Uint8Array) {
    return this.fetch(path, { method: "POST", body: new Uint8Array(data), headers: { "Content-Type": "application/octet-stream" } });
  }

  // A raw answer (an attachment download), for the caller to read.
  async download(path: string): Promise<Response> {
    const res = await fetch(`${this.baseUrl}${path}`, { headers: this.token ? { Authorization: `Bearer ${this.token}` } : {} });
    if (!res.ok) throw await apiError(res);
    return res;
  }
}

async function apiError(res: Response): Promise<ApiError> {
  let body: { code?: string; message?: string } = {};
  try { body = await res.json() as typeof body; } catch { /* not JSON, e.g. a proxy's page */ }
  return new ApiError(body.message ?? `HTTP ${res.status}`, body.code ?? "error", res.status);
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function makeClient(requireAuth = true): ApiClient {
  const creds = loadCredentials();
  const server = process.env.GRAYBOARD_SERVER ?? creds?.server;

  if (!server) {
    console.error("No server configured. Run `grayboard login` first.");
    process.exit(1);
  }
  if (requireAuth && !creds?.session_token) {
    console.error("Not logged in. Run `grayboard login` first.");
    process.exit(1);
  }
  return new ApiClient(server, creds?.session_token ?? null);
}

export function makeUnauthClient(serverUrl: string): ApiClient {
  return new ApiClient(serverUrl);
}
