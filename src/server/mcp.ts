import { McpServer, createMcpHandler, fromJsonSchema } from "@modelcontextprotocol/server";
import type { CallToolResultSchema } from "@modelcontextprotocol/core";
import { z } from "zod";
import { boardTools, BOARD_INSTRUCTIONS, ownHumanInstruction } from "../core/tools.ts";
import { CoreError } from "../core/errors.ts";
import { DM_ACK_TOOL, DM_INBOX_TOOL, DM_RETRACT_TOOL, MAX_INBOX_DAYS, PENDING_PARAM, ackResult } from "../shared/inbox.ts";
import { HUMAN_NAME, isValidIdentityName } from "../shared/addressing.ts";
import { ApplicationError, type Application, type ApplicationSession } from "./application.ts";
import type { createOAuthServer } from "./oauth.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import pkg from "../../package.json" with { type: "json" };

export const MCP_PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18"];
type CallToolResult = z.infer<typeof CallToolResultSchema>;
const id = z.number().int().positive();
const ids = z.array(id);
const attachmentIds = ids.describe("IDs uploaded through the authenticated attachment HTTP API as this identity; never local file paths.");
const text = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

export function createHostedMcp(application: Application, oauth: Pick<ReturnType<typeof createOAuthServer>, "authenticate" | "isAuthorized">, opts: { trustedOrigin: string }) {
  const trustedOrigin = new URL(opts.trustedOrigin).origin;
  const permitsOrigin = (origin: string | null): boolean => {
    if (origin === null) return true;
    if (!/^https?:\/\/[^\s/@?#,\\]+$/.test(origin)) return false;
    try {
      const parsed = new URL(origin);
      const serialized = origin.replace(parsed.protocol === "https:" ? /:443$/ : /:80$/, "");
      return serialized === parsed.origin && parsed.origin === trustedOrigin;
    } catch { return false; }
  };
  let closed = false;
  const sessions = new Map<ApplicationSession, McpServer>();
  const exchanges = new AsyncLocalStorage<{ refusal?: Response }>();
  const refuse = (response: Response): never => {
    const exchange = exchanges.getStore();
    if (exchange) exchange.refusal = response;
    throw new Error("unauthenticated");
  };
  const handler = createMcpHandler(async ({ requestInfo }) => {
    if (!requestInfo || closed || requestInfo.signal.aborted) throw new Error("MCP endpoint is closed");
    const principal = oauth.authenticate(requestInfo, ["grayboard:tools"]);
    if (principal instanceof Response) return refuse(principal);
    const { session, info } = await application.selectIdentity(
      principal.authed, requestInfo.headers.get("X-Grayboard-Identity")!,
      { deliver() {}, probe: async () => false, closed() {} },
      { push: false, where: requestInfo.headers.get("X-Grayboard-Where") ?? undefined, alive: () => !closed && !requestInfo.signal.aborted },
    );
    try {
      if (closed || requestInfo.signal.aborted) throw new Error("MCP request is closed");
      if (!oauth.isAuthorized(principal)) {
        const current = oauth.authenticate(requestInfo, ["grayboard:tools"]);
        if (current instanceof Response) refuse(current);
        throw new Error("unauthenticated");
      }
    } catch (e) {
      application.close(session);
      throw e;
    }
    const server = new McpServer({ name: "grayboard", version: pkg.version }, {
      supportedProtocolVersions: MCP_PROTOCOL_VERSIONS,
      instructions: [
        `You are "${info.identity_full}" on grayboard. This connection supplies tools only; poll dm_inbox and board_list for pending work.`,
        ...BOARD_INSTRUCTIONS.slice(1),
        ...(info.teams.length ? ["Team boards are private to their members: don't repeat their content where non-members can read it unless your user asks."] : []),
        ...(info.human.linked ? ownHumanInstruction(info.human.handle) : []),
        ...(info.notices ?? []),
      ].join(" "),
    });
    sessions.set(session, server);
    // SDK closes each instance on terminal response, stream cancellation, or shutdown.
    server.server.onclose = () => { application.close(session); sessions.delete(session); };
    const run = (call: () => unknown): CallToolResult => {
      try {
        if (requestInfo.signal.aborted) return { ...text("error: request cancelled"), isError: true };
        // Recheck the token at dispatch as well as at the HTTP boundary.
        if (!oauth.isAuthorized(principal)) return { ...text("error: unauthenticated"), isError: true };
        return text(call() ?? "ok");
      } catch (e) {
        const message = e instanceof ApplicationError && e.code !== "internal" || e instanceof CoreError ? e.message : "internal error";
        return { ...text(`error: ${message}`), isError: true };
      }
    };
    for (const tool of boardTools({ teams: true })) {
      const properties = { ...tool.inputSchema.properties };
      if (tool.name === "board_post") {
        delete properties.attachments;
        properties.attachment_ids = z.toJSONSchema(attachmentIds);
      }
      server.registerTool(tool.name, {
        description: tool.name === "board_post" ? tool.description.replace("attachments?", "attachment_ids?") : tool.description,
        ...(tool._meta ? { _meta: tool._meta } : {}),
        inputSchema: fromJsonSchema<Record<string, unknown>>({ ...tool.inputSchema, properties, additionalProperties: false } as Parameters<typeof fromJsonSchema>[0]),
      }, args => run(() => application.call(session, tool.name, args)));
    }
    server.registerTool("dm_send", {
      description: "Message one peer by exact handle or bare identity name. Offline messages remain queued. Attachments are uploaded IDs, not paths.",
      inputSchema: z.strictObject({ to: z.string(), body: z.string(), parent_id: id.optional(), pending: z.boolean().describe(PENDING_PARAM.description).optional(), attachment_ids: attachmentIds.optional() }),
    }, a => run(() => application.send(session, a.to, a.body, a)));
    server.registerTool("dm_history", {
      description: "Recent direct messages, oldest first; optionally filter by peer or page before an ID.",
      inputSchema: z.strictObject({ peer: z.string().optional(), limit: z.number().optional(), before_id: id.optional() }),
    }, a => run(() => application.history(session, a)));
    server.registerTool("dm_thread", {
      description: "A whole direct-message thread you participate in.", inputSchema: z.strictObject({ thread: id }),
    }, a => run(() => application.thread(session, a.thread)));
    server.registerTool(DM_INBOX_TOOL.name, {
      description: DM_INBOX_TOOL.description, _meta: DM_INBOX_TOOL._meta,
      inputSchema: z.strictObject({ days: z.number().positive().max(MAX_INBOX_DAYS).optional() }),
    }, a => run(() => application.inbox(session, a.days)));
    server.registerTool(DM_ACK_TOOL.name, {
      description: DM_ACK_TOOL.description, _meta: DM_ACK_TOOL._meta,
      inputSchema: z.strictObject({ message_id: z.union([id, ids.min(1)]) }),
    }, a => {
      const acked: number[] = [], missing: number[] = [];
      const result = run(() => {
        for (const n of new Set(Array.isArray(a.message_id) ? a.message_id : [a.message_id])) {
          try { application.acknowledgeDm(session, n); acked.push(n); } catch (e) {
            if (!(e instanceof ApplicationError) || e.code !== "not_found") throw e;
            missing.push(n);
          }
        }
        return ackResult(acked, missing).text;
      });
      return { ...result, ...(missing.length && !acked.length ? { isError: true } : {}) };
    });
    server.registerTool(DM_RETRACT_TOOL.name, {
      description: DM_RETRACT_TOOL.description, inputSchema: z.strictObject({ message_id: id }),
    }, a => run(() => application.retract(session, a.message_id)));
    return server;
  }, { legacy: "stateless" });
  return {
    get activeContexts() { return sessions.size; },
    async fetch(req: Request): Promise<Response> {
      if (closed) return new Response("MCP endpoint is closed", { status: 503 });
      if (!permitsOrigin(req.headers.get("Origin"))) return Response.json({ code: "forbidden", message: "invalid origin" }, { status: 403 });
      try {
        const principal = oauth.authenticate(req, ["grayboard:tools"]);
        if (principal instanceof Response) return principal;
        const name = req.headers.get("X-Grayboard-Identity");
        if (!name || !isValidIdentityName(name.toLowerCase()) || name.toLowerCase() === HUMAN_NAME) {
          return Response.json({ code: "bad_request", message: "X-Grayboard-Identity must name your agent identity, not a full handle or human" }, { status: 400 });
        }
        return await exchanges.run({}, async () => {
          const response = await handler.fetch(req);
          const refusal = exchanges.getStore()?.refusal;
          if (!refusal || closed || req.signal.aborted) return response;
          await response.body?.cancel();
          return refusal;
        });
      } catch {
        return Response.json({ code: "internal", message: "internal error" }, { status: 500 });
      }
    },
    async close() {
      closed = true;
      await handler.close();
      await Promise.all([...sessions.values()].map(server => server.close()));
      for (const session of sessions.keys()) application.close(session);
      sessions.clear();
    },
  };
}
