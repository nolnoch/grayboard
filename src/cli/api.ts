import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Credentials = { session_token: string; server: string; user_email: string };

export function loadCredentials(): Credentials | null {
  const credPath = process.env.GRAYBOARD_CREDENTIALS ?? join(homedir(), ".grayboard", "credentials");
  if (!existsSync(credPath)) return null;
  try {
    return JSON.parse(readFileSync(credPath, "utf8")) as Credentials;
  } catch {
    return null;
  }
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

    let body: unknown;
    try { body = await res.json(); } catch { body = {}; }

    if (!res.ok) {
      const errBody = body as { code?: string; message?: string };
      throw new ApiError(
        errBody.message ?? `HTTP ${res.status}`,
        errBody.code ?? "error",
        res.status,
      );
    }
    return body;
  }

  get(path: string)                  { return this.fetch(path); }
  post(path: string, body?: unknown) { return this.fetch(path, { method: "POST",  body: body !== undefined ? JSON.stringify(body) : undefined }); }
  del(path: string)                  { return this.fetch(path, { method: "DELETE" }); }
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
