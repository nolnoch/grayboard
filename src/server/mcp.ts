import { AsyncLocalStorage } from "node:async_hooks";
import { McpServer, createMcpHandler, fromJsonSchema, type McpServerFactory } from "@modelcontextprotocol/server";
import type { CallToolResultSchema } from "@modelcontextprotocol/core";
import { z } from "zod";
import { boardTools, BOARD_INSTRUCTIONS, ownHumanInstruction } from "../core/tools.ts";
import { closestNames, unknownNameError } from "../core/bindings.ts";
import { CoreError } from "../core/errors.ts";
import { DELEGATE_TOOL } from "../core/delegation.ts";
import { DM_ACK_TOOL, DM_INBOX_TOOL, DM_RETRACT_TOOL, MAX_INBOX_DAYS, PENDING_PARAM, ackResult } from "../shared/inbox.ts";
import { HUMAN_NAME, isValidIdentityName } from "../shared/addressing.ts";
import { ApplicationError, type Application, type ApplicationSession } from "./application.ts";
import { extractBearer, verifySessionToken, type TouchQueue } from "./auth.ts";
import type { Repo } from "./db.ts";
import { diagnosticOrigin, failureLocations } from "./diagnostics.ts";
import { RateLimiter } from "./rate_limit.ts";
import pkg from "../../package.json" with { type: "json" };

export const MCP_PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18"];
type CallToolResult = z.infer<typeof CallToolResultSchema>;
const id = z.number().int().positive();
const ids = z.array(id);
const attachmentIds = ids.describe("IDs uploaded through the authenticated attachment HTTP API as this identity; never local file paths.");
const text = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

// Bearer auth here is transitional; the retained HTTP/WS login contract is unchanged.
export function createHostedMcp(application: Application, repo: Repo, opts: { trustedOrigin: string; touches: TouchQueue; now?: () => number }) {
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
  // SDK legacy routing clones Requests; scope refusals to the serving exchange.
  type Exchange = { select?: ReturnType<Application["admitIdentity"]>; refusal?: ApplicationError; failure?: ApplicationError; logged?: boolean; principal?: number; identity?: string; session?: string; tool?: string; protocol?: string; request?: Request; address?: string };
  const admission = new AsyncLocalStorage<Exchange>();
  const refusalLogs = new RateLimiter({ burst: 1, perSec: 0.1 }, { start() {}, end() {} }, opts.now, 4096);
  const report = (e: unknown, exchange = admission.getStore()) => {
    if (e instanceof ApplicationError || e instanceof CoreError || exchange?.failure || exchange?.refusal || exchange?.logged) return;
    if (exchange) exchange.logged = true;
    console.error(`[grayboard] hosted MCP failed: ${JSON.stringify({ principal: exchange?.principal, identity: exchange?.identity, session: exchange?.session, tool: exchange?.tool, protocol: exchange?.protocol, locations: failureLocations(e) })}`);
  };
  const refuse = (reason: string, req: Request, address: string, exchange?: Exchange) => {
    refusalLogs.sweep();
    // At capacity, unknown addresses must not create an unbounded log stream.
    if (refusalLogs.size >= 4096 || !refusalLogs.take(address).ok) return;
    console.error(`[grayboard] hosted MCP refused: ${JSON.stringify({ reason, address, origin: diagnosticOrigin(req.headers.get("Origin")), public_origin: trustedOrigin, principal: exchange?.principal, identity: exchange?.identity, protocol: exchange?.protocol })}`);
  };
  const isRefusal = (e: unknown): e is ApplicationError => e instanceof ApplicationError && e.code === "rate_limited" && typeof e.extra.retry_after_ms === "number" && Number.isFinite(e.extra.retry_after_ms) && e.extra.retry_after_ms > 0;
  const factory: McpServerFactory = async ({ requestInfo }) => {
    if (!requestInfo || closed) throw new Error("MCP endpoint is closed");
    const raw = extractBearer(requestInfo);
    const authed = raw && verifySessionToken(raw, repo, opts.touches);
    if (!authed) throw new ApplicationError("unauthenticated", "invalid or missing token");
    const exchange = admission.getStore();
    if (exchange?.refusal) throw exchange.refusal;
    if (!exchange?.select) throw new Error("MCP identity admission is missing");
    const { session, info } = await exchange.select({ deliver() {}, probe: async () => false, closed() {} }).catch((e: unknown) => {
      if (isRefusal(e)) exchange.refusal = e;
      throw e;
    });
    exchange.session = session.sessionId;
    if (closed || requestInfo.signal.aborted) {
      application.close(session);
      throw new Error("MCP request is closed");
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
    const run = (tool: string, call: () => unknown): CallToolResult => {
      exchange.tool = tool;
      try {
        if (requestInfo.signal.aborted) return { ...text("error: request cancelled"), isError: true };
        // Recheck the token at dispatch as well as at the HTTP boundary.
        if (!verifySessionToken(raw, repo, opts.touches)) return { ...text("error: unauthenticated"), isError: true };
        return text(call() ?? "ok");
      } catch (e) {
        report(e, exchange);
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
      }, args => run(tool.name, () => application.call(session, tool.name, args)));
    }
    server.registerTool("dm_send", {
      description: "Message one peer by exact handle or bare identity name. Offline messages remain queued. Attachments are uploaded IDs, not paths.",
      inputSchema: z.strictObject({ to: z.string(), body: z.string(), parent_id: id.optional(), pending: z.boolean().describe(PENDING_PARAM.description).optional(), attachment_ids: attachmentIds.optional() }),
    }, a => run("dm_send", () => application.send(session, a.to, a.body, a)));
    server.registerTool(DELEGATE_TOOL.name, {
      description: DELEGATE_TOOL.description,
      inputSchema: fromJsonSchema<{ persona: string; task: string; context?: string; to?: string }>({ ...DELEGATE_TOOL.inputSchema, additionalProperties: false } as Parameters<typeof fromJsonSchema>[0]),
    }, a => run(DELEGATE_TOOL.name, () => application.delegate(session, a)));
    server.registerTool("dm_history", {
      description: "Recent direct messages, oldest first; optionally filter by peer or page before an ID.",
      inputSchema: z.strictObject({ peer: z.string().optional(), limit: z.number().optional(), before_id: id.optional() }),
    }, a => run("dm_history", () => application.history(session, a)));
    server.registerTool("dm_thread", {
      description: "A whole direct-message thread you participate in.", inputSchema: z.strictObject({ thread: id }),
    }, a => run("dm_thread", () => application.thread(session, a.thread)));
    server.registerTool(DM_INBOX_TOOL.name, {
      description: DM_INBOX_TOOL.description, _meta: DM_INBOX_TOOL._meta,
      inputSchema: z.strictObject({ days: z.number().positive().max(MAX_INBOX_DAYS).optional() }),
    }, a => run(DM_INBOX_TOOL.name, () => application.inbox(session, a.days)));
    server.registerTool(DM_ACK_TOOL.name, {
      description: DM_ACK_TOOL.description, _meta: DM_ACK_TOOL._meta,
      inputSchema: z.strictObject({ message_id: z.union([id, ids.min(1)]) }),
    }, a => {
      const acked: number[] = [], missing: number[] = [];
      const result = run(DM_ACK_TOOL.name, () => {
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
    }, a => run(DM_RETRACT_TOOL.name, () => application.retract(session, a.message_id)));
    return server;
  };
  const handler = createMcpHandler(async context => {
    try {
      return await factory(context);
    } catch (e) {
      const exchange = admission.getStore();
      if (e instanceof ApplicationError && exchange) exchange.failure = e;
      if (e instanceof ApplicationError && ["identity_unknown", "identity_in_use", "bad_request"].includes(e.code) && exchange?.request) refuse(e.code, exchange.request, exchange.address ?? "unknown", exchange);
      report(e, exchange);
      throw new Error("internal error");
    }
  }, { legacy: "stateless", onerror: e => report(e) });
  return {
    get activeContexts() { return sessions.size; },
    async fetch(req: Request, address = "unknown"): Promise<Response> {
      const exchange: Exchange = { request: req, address, protocol: MCP_PROTOCOL_VERSIONS.includes(req.headers.get("MCP-Protocol-Version") ?? "") ? req.headers.get("MCP-Protocol-Version")! : "unspecified" };
      try {
        if (closed) return new Response("MCP endpoint is closed", { status: 503 });
        if (!permitsOrigin(req.headers.get("Origin"))) {
          refuse("origin", req, address, exchange);
          return Response.json({ code: "forbidden", message: "invalid origin" }, { status: 403 });
        }
        const token = extractBearer(req);
        const authed = token && verifySessionToken(token, repo, opts.touches);
        if (!authed) return Response.json({ code: "unauthenticated", message: "invalid or missing token" }, { status: 401 });
        exchange.principal = authed.user_id;
        const name = req.headers.get("X-Grayboard-Identity");
        if (!name || !isValidIdentityName(name.toLowerCase()) || name.toLowerCase() === HUMAN_NAME) {
          refuse("identity", req, address, exchange);
          return Response.json({ code: "bad_request", message: "X-Grayboard-Identity must name your agent identity, not a full handle or human" }, { status: 400 });
        }
        exchange.identity = name.toLowerCase();
        try {
          exchange.select = application.admitIdentity(authed, name, {
            push: false, create: false, transport: "hosted", where: req.headers.get("X-Grayboard-Where") ?? undefined,
            alive: () => !closed && !req.signal.aborted,
          });
        } catch (e) {
          if (!isRefusal(e)) {
            report(e, exchange);
            return Response.json({ code: "internal", message: "internal error" }, { status: 500 });
          }
          exchange.refusal = e;
        }
        if (!exchange.refusal && !repo.aliases.find(authed.user_email, name.toLowerCase())) {
          refuse("identity_unknown", req, address, exchange);
          const known = closestNames(name.toLowerCase(), repo.aliases.listFor(authed.user_email).map(i => i.name).filter(n => n !== HUMAN_NAME));
          return Response.json({ code: "identity_unknown", message: unknownNameError(name.toLowerCase(), known), known }, { status: 400 });
        }
        return admission.run(exchange, async () => {
          try {
            const response = await handler.fetch(req);
            if (exchange.failure?.code === "unauthenticated") return Response.json({ code: "unauthenticated", message: "invalid or missing token" }, { status: 401 });
            const retryAfterMs = exchange.refusal?.extra.retry_after_ms;
            if (typeof retryAfterMs === "number") {
              const { id = null } = response.headers.get("Content-Type")?.includes("application/json")
                ? await response.json().catch(() => ({})) as { id?: string | number | null } : {};
              return Response.json({
                jsonrpc: "2.0", id,
                error: { code: -32000, message: "too many connections; retry after the indicated delay", data: { code: "rate_limited", retry_after_ms: retryAfterMs } },
              }, { status: 429, headers: { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) } });
            }
            return response;
          } catch (e) {
            report(e, exchange);
            return Response.json({ code: "internal", message: "internal error" }, { status: 500 });
          }
        });
      } catch (e) {
        report(e, exchange);
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
