import type { CoreDb } from "../core/boards.ts";
import { ApplicationError } from "./application.ts";
import { sourceContext, type HostedSessions } from "./hosted.ts";
import type { Repo } from "./db.ts";
import { attachmentDownload, attachmentRelease, attachmentUpload } from "./http.ts";
import type { createOAuthServer } from "./oauth.ts";
import type { UploadGate } from "./uploads.ts";

class Refusal extends Error {
  constructor(readonly response: Response) { super("attachment request refused"); }
}

const error = (code: string, message: string, status: number) => Response.json({ code, message }, { status });
const privateResponse = (response: Response) => {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
};

export function createMcpAttachments(repo: Repo, db: CoreDb, oauth: Pick<ReturnType<typeof createOAuthServer>, "authenticate" | "resource">, uploads: UploadGate, opts: { trustedOrigin: string; sessions: HostedSessions }) {
  const origin = new URL(opts.trustedOrigin).origin;
  const paths = new Set(["/mcp/attachments", `${new URL(oauth.resource).pathname}/attachments`]);
  const pending = new Set<Promise<Response>>();
  const shutdown = new AbortController();
  let closed = false;
  // Match MCP's serialized-origin policy; its validator is private to that router.
  const permitsOrigin = (value: string | null) => {
    if (value === null) return true;
    if (!/^https?:\/\/[^\s/@?#,\\]+$/.test(value)) return false;
    try {
      const parsed = new URL(value);
      return value.replace(parsed.protocol === "https:" ? /:443$/ : /:80$/, "") === parsed.origin && parsed.origin === origin;
    } catch { return false; }
  };

  async function handle(req: Request, url: URL, id: string | undefined): Promise<Response> {
    try {
      if (closed) return error("unavailable", "server closing", 503);
      if (!permitsOrigin(req.headers.get("Origin"))) return error("forbidden", "invalid origin", 403);
      const principal = oauth.authenticate(req, ["grayboard:tools"]);
      if (principal instanceof Response) return principal;
      if (pending.size >= 128) return error("unavailable", "too many attachment requests", 503);
      if (url.hash || url.search.length > 2048 || /%(?![0-9a-f]{2})/i.test(url.search)) return error("bad_request", "invalid query", 400);
      const allowed = req.method === "POST" ? ["identity", "filename"] : ["identity"];
      const seen = new Set<string>();
      for (const [key, value] of url.searchParams) {
        if (!allowed.includes(key) || seen.has(key) || /[\x00-\x1f\x7f\ufffd]/u.test(value)) return error("bad_request", "invalid query", 400);
        seen.add(key);
      }
      const source = req.headers.get("X-Grayboard-Session");
      let raw: string | undefined;
      try {
        if (source && source.length <= 12288) {
          raw = decodeURIComponent(source);
          if (encodeURIComponent(raw) !== source) return error("bad_request", "noncanonical source context", 400);
        }
      } catch { return error("bad_request", "invalid source context", 400); }
      const context = sourceContext(principal, raw);
      if (id !== undefined && (!/^[1-9]\d{0,14}$/.test(id) || !Number.isSafeInteger(Number(id)))) return error("bad_request", "invalid attachment id", 400);
      if (req.method === "POST") {
        const filename = url.searchParams.get("filename");
        if (!filename || filename.length > 255 || /[/\\]/.test(filename) || filename === "." || filename === "..") return error("bad_request", "invalid filename", 400);
      }
      const signal = AbortSignal.any([req.signal, shutdown.signal]);
      return await opts.sessions.transfer(principal, context, async (session, bindingGuard) => {
        const asserted = url.searchParams.get("identity");
        if (asserted !== null && asserted !== session.identityName) return error("forbidden", "identity differs from current source binding", 403);
        const selected = new URL(url);
        // The HTTP routes act as `as` (#284): the hosted session's name.
        selected.searchParams.delete("identity");
        selected.searchParams.set("as", session.identityFull);
        const guard = () => {
          if (closed || signal.aborted) throw new Refusal(error(closed ? "unavailable" : "cancelled", closed ? "server closing" : "request cancelled", closed ? 503 : 499));
          const current = oauth.authenticate(req, ["grayboard:tools"]);
          if (current instanceof Response) throw new Refusal(current);
          bindingGuard();
          if (!repo.aliases.find(session.identityFull)) throw new Refusal(error("not_found", "identity not found", 404));
        };
        guard();
        const response = req.method === "POST" ? await attachmentUpload(req, selected, principal.authed, repo, db, uploads, guard, signal)
          : req.method === "GET" ? await attachmentDownload(id!, selected, principal.authed, repo, db, guard)
          : await attachmentRelease(id!, selected, principal.authed, repo, db, guard);
        if (req.method === "POST" && req.body && !req.body.locked) await req.body.cancel();
        guard();
        return response;
      });
    } catch (cause) {
      if (cause instanceof Refusal) return cause.response;
      if (cause instanceof ApplicationError) return error(cause.code, cause.message, cause.code === "unauthenticated" ? 401 : 403);
      if (req.signal.aborted && cause === req.signal.reason) return error("cancelled", "request cancelled", 499);
      // Cancellation is not evidence that a simultaneous storage fault was auth failure.
      return error("internal", "internal error", 500);
    }
  }

  return {
    fetch(req: Request): Promise<Response> | undefined {
      const url = new URL(req.url);
      const base = [...paths].find(path => url.pathname === path || url.pathname.startsWith(`${path}/`));
      if (!base) return;
      const suffix = url.pathname.slice(base.length);
      const id = suffix ? suffix.slice(1) : undefined;
      if (id?.includes("/") || (id === undefined ? req.method !== "POST" : !["GET", "DELETE"].includes(req.method))) return;
      const operation = (async () => {
        const response = await handle(req, url, id);
        try {
          // Refusals before quota/body reading still own the original source.
          if (response.status >= 400 && req.method === "POST" && req.body) await req.body.cancel();
          return privateResponse(response);
        } catch {
          return privateResponse(error("internal", "internal error", 500));
        }
      })();
      pending.add(operation);
      void operation.finally(() => pending.delete(operation));
      return operation;
    },
    async close(): Promise<void> {
      closed = true;
      shutdown.abort(new Refusal(error("unavailable", "server closing", 503)));
      await Promise.allSettled([...pending]);
    },
  };
}
