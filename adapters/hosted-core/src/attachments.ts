// Client-side byte transfers shared by native-tool hosts and ToolProxy.
import type { AuthProvider } from "@modelcontextprotocol/client";
import { z } from "zod";
import { AccessExpired } from "./model.js";
import { ServerUnreachable, serverText, unreachable } from "./wire.js";
import {
  checkAttachmentId, downloadAttachment, formatSize, readAttachmentFiles, saveTarget, sendWithUploads, serverBusDir,
  type AttachmentLimits, type AttachmentTransport, type SavedAttachment,
} from "../../../src/shared/attachments.ts";
import { describeFetchError, HTTP_TIMEOUT_MS, transferTimeoutMs } from "../../../src/shared/http.ts";

export class AttachmentRefused extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(serverText(message)); }
}

export type HostedAttachmentOptions = {
  resource: URL;
  auth: AuthProvider;
  harness: string;
  loginAction: string;
  signal: AbortSignal;
  roots: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  limits(): Promise<AttachmentLimits>;
  unreleased(id: number, error: Error): void;
};

export class HostedAttachments {
  constructor(readonly options: HostedAttachmentOptions) {}
  async send<T>(paths: unknown, sessionID: string, send: (ids: number[]) => Promise<T>): Promise<T> {
    const files = await readAttachmentFiles(paths, this.options.roots, { limits: await this.options.limits(), cwd: this.options.cwd });
    return sendWithUploads(files, this.transport(sessionID), send);
  }
  async get(args: { id?: unknown; dir?: unknown }, sessionID: string): Promise<SavedAttachment> {
    const id = checkAttachmentId(args.id);
    const target = await saveTarget(args.dir, this.options.roots, serverBusDir(this.options.resource.href), this.options.env, this.options.cwd);
    return downloadAttachment(id, target, (await this.options.limits()).file, this.transport(sessionID));
  }
  // The hosted attachment routes act as the bound session whose raw source ID
  // rides in X-Grayboard-Session (the canonical encodeURIComponent form).
  private transport(sessionID: string): AttachmentTransport {
    const base = `${this.options.resource.href.replace(/\/$/, "")}/attachments`;
    return {
      upload: async file => {
        const response = await this.http("POST", `${base}?filename=${encodeURIComponent(file.filename)}`, sessionID, transferTimeoutMs(file.data.length), file.data);
        const stored = z.object({ id: z.number().int().positive() }).safeParse(await response.json().catch(() => undefined));
        if (!stored.success) throw new Error("Invalid attachment upload response");
        return stored.data.id;
      },
      release: async id => {
        try {
          const response = await this.http("DELETE", `${base}/${id}`, sessionID, HTTP_TIMEOUT_MS);
          await response.body?.cancel();
          return true;
        } catch (error) {
          if (error instanceof AttachmentRefused && error.status === 404) return false;
          throw error;
        }
      },
      download: async (id, maxBytes) => {
        const ms = transferTimeoutMs(maxBytes);
        const response = await this.http("GET", `${base}/${id}`, sessionID, ms);
        const reader = response.body?.getReader();
        if (!reader) throw new Error(`attachment ${id}: empty download`);
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.length;
            if (size > maxBytes) throw new Error(`attachment ${id}: exceeds the ${formatSize(maxBytes)} limit per file`);
            chunks.push(chunk.value);
          }
          const data = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
          return { headers: response.headers, data };
        }
        catch (error) { throw this.fetchFailure(error, ms); }
        finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      },
      unreleased: this.options.unreleased,
    };
  }
  // One authorized byte request, retried once after onUnauthorized as the
  // MCP transport does; the host remains the only credential refresher.
  private async http(method: "POST" | "GET" | "DELETE", url: string, sessionID: string, ms: number, body?: Uint8Array): Promise<Response> {
    const signal = AbortSignal.any([AbortSignal.timeout(ms), this.options.signal]);
    for (let attempt = 0; ; attempt++) {
      const token = await this.options.auth.token();
      if (!token) throw new AccessExpired(this.options.harness, this.options.loginAction, "login_required");
      const headers = new Headers({ Authorization: `Bearer ${token}`, "X-Grayboard-Session": encodeURIComponent(sessionID) });
      if (body) { headers.set("Content-Type", "application/octet-stream"); headers.set("Content-Length", String(body.length)); }
      let response: Response;
      try { response = await fetch(url, { method, headers, body: body ? new Uint8Array(body) : undefined, redirect: "error", signal }); }
      catch (error) { throw this.fetchFailure(error, ms); }
      if (response.ok) return response;
      if (response.status === 401 && attempt === 0 && this.options.auth.onUnauthorized) {
        await response.body?.cancel();
        await this.options.auth.onUnauthorized({ response, serverUrl: this.options.resource, fetchFn: fetch });
        continue;
      }
      if (response.status === 401 || response.status === 403 && /insufficient_scope/.test(response.headers.get("www-authenticate") ?? "")) {
        await response.body?.cancel();
        throw new AccessExpired(this.options.harness, this.options.loginAction, response.status === 401 ? "expired" : "login_required");
      }
      const refusal = z.object({ code: z.string(), message: z.string() }).safeParse(await response.json().catch(() => undefined));
      if (refusal.success) throw new AttachmentRefused(response.status, refusal.data.code, refusal.data.message);
      if ([502, 503, 504].includes(response.status)) throw new ServerUnreachable(new Error(`HTTP ${response.status}`));
      throw new Error(`grayboard server at ${this.options.resource.origin}: HTTP ${response.status}`);
    }
  }
  private fetchFailure(error: unknown, ms: number): Error {
    if (!this.options.signal.aborted && unreachable(error)) return new ServerUnreachable(error);
    return new Error(`grayboard server at ${this.options.resource.origin}: ${describeFetchError(error, ms)}`, { cause: error });
  }
}
