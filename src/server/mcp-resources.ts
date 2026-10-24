import { McpServer, ProtocolError, ProtocolErrorCode, ResourceNotFoundError } from "@modelcontextprotocol/server";
import { z } from "zod";
import { CoreError } from "../core/errors.ts";
import { ApplicationError, type ApplicationSession } from "./application.ts";
import type { OAuthPrincipal } from "./oauth.ts";
import type { Delivery } from "./delivery.ts";
import { parseBoardResourceUri, type Resources } from "./resources.ts";

export type HostedRole = "native" | "subscriber";
export function hostedRole(request: Request): HostedRole {
  const role = request.headers.get("X-Grayboard-Client");
  if (role === null) return "native";
  if (role === "subscriber") return role;
  throw new ApplicationError("bad_request", "unknown X-Grayboard-Client role");
}
export const roleScopes = (role: HostedRole) => [role === "subscriber" ? "grayboard:delivery" : "grayboard:tools"];
const identityUri = "grayboard://identity";
const inboxUri = "grayboard://inbox";
const metadata = (uri: string, name: string) => ({ uri, name, mimeType: "application/json" });
const json = (uri: string, value: unknown) => ({ contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value) }] });
const expected = (error: unknown): error is ApplicationError | CoreError => error instanceof ApplicationError && error.code !== "internal" || error instanceof CoreError;
const message = (error: unknown) => expected(error) ? error.message : "internal error";
const resourceError = (error: unknown) => new ProtocolError(expected(error) ? ProtocolErrorCode.InvalidParams : ProtocolErrorCode.InternalError, message(error));

function boardRead(uri: string) {
  const separator = uri.indexOf("?");
  const base = separator === -1 ? uri : uri.slice(0, separator);
  const query = separator === -1 ? undefined : uri.slice(separator + 1);
  parseBoardResourceUri(base);
  if (query === undefined) return { uri: base!, options: {} };
  // Only canonical decimal options, in a fixed order, are supported URI variants.
  const match = /^(?:limit=([1-9][0-9]*))?(?:(&?)before_id=([1-9][0-9]*))?$/.exec(query);
  if (!match || match[0] !== query || !query || (match[1] ? match[3] && match[2] !== "&" : match[2] === "&")) {
    throw new ApplicationError("not_found", "board resource not found");
  }
  const options = { ...(match[1] ? { limit: Number(match[1]) } : {}), ...(match[3] ? { before_id: Number(match[3]) } : {}) };
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit > 100) ||
      options.before_id !== undefined && !Number.isSafeInteger(options.before_id)) {
    throw new ApplicationError("bad_request", "invalid board snapshot options");
  }
  return { uri: base!, options };
}

export function registerHostedResources(server: McpServer, context: {
  role: HostedRole; principal: OAuthPrincipal; session: ApplicationSession; request: Request;
  issuer: string; resource: string; resources: Resources; delivery: Delivery;
  authorize(): void;
}) {
  const { role, principal, session, request, resources, delivery } = context;
  const authorize = (signal?: AbortSignal) => {
    if (signal?.aborted) throw new ApplicationError("unauthenticated", "request cancelled");
    context.authorize();
  };
  const leaseCapability = (signal: AbortSignal) => {
    authorize(signal);
    const capability = request.headers.get("X-Grayboard-Lease");
    if (!capability || !/^[A-Za-z0-9_-]{43}$/.test(capability) ||
        delivery.describe(principal, capability).identity.identity_full !== session.identityFull) {
      throw new ApplicationError("not_found", "delivery lease or item not found");
    }
    return capability;
  };
  server.server.setRequestHandler("resources/list", async (request, ctx) => {
    const params = request.params ?? {};
    try {
      authorize(ctx.mcpReq.signal);
      if (role === "subscriber") {
        if (params.cursor !== undefined) throw new ApplicationError("bad_request", "invalid catalog cursor");
        return { resources: [metadata(identityUri, "identity"), metadata(inboxUri, "inbox")] };
      }
      const page = resources.list(session, params.cursor);
      return {
        resources: [...(params.cursor === undefined ? [metadata(identityUri, "identity")] : []),
          ...page.resources.map(r => ({ ...metadata(r.uri, r.board.name), description: r.board.purpose }))],
        ...(page.next_after === null ? {} : { nextCursor: page.next_after }),
      };
    } catch (error) { throw resourceError(error); }
  });
  server.server.setRequestHandler("resources/templates/list", async (request, ctx) => {
    try {
      authorize(ctx.mcpReq.signal);
      if (request.params?.cursor !== undefined) throw new ApplicationError("bad_request", "invalid catalog cursor");
      return { resourceTemplates: [] };
    } catch (error) { throw resourceError(error); }
  });
  server.server.setRequestHandler("resources/read", async ({ params }, ctx) => {
    try {
      authorize(ctx.mcpReq.signal);
      if (params.uri === identityUri) return json(params.uri, {
        user: { id: principal.authed.user_id, email: principal.authed.user_email },
        identity_full: session.identityFull, identity: session.identityName,
        issuer: context.issuer, resource: context.resource,
      });
      if (role === "subscriber") {
        if (params.uri !== inboxUri) throw new ApplicationError("not_found", "resource not found");
        return json(params.uri, { items: delivery.pending(principal, leaseCapability(ctx.mcpReq.signal), 100) });
      }
      const read = boardRead(params.uri);
      return json(params.uri, resources.read(session, read.uri, read.options));
    } catch (error) {
      if (error instanceof CoreError || error instanceof ApplicationError && error.code === "not_found") throw new ResourceNotFoundError(params.uri, "resource not found");
      throw resourceError(error);
    }
  });
  if (role !== "subscriber") return;
  const run = async (signal: AbortSignal, call: () => unknown | Promise<unknown>) => {
    try {
      authorize(signal);
      const value = await call();
      return { content: [{ type: "text" as const, text: JSON.stringify(value ?? { ok: true }) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text" as const, text: `error: ${message(error)}` }] };
    }
  };
  server.registerTool("delivery_open", {
    description: "Explicitly acquire delivery ownership for this identity. Reads do not acknowledge items.", inputSchema: z.strictObject({}),
  }, (_args, ctx) => run(ctx.mcpReq.signal, async () => {
    const lease = await delivery.open(principal, session.identityName);
    try { authorize(ctx.mcpReq.signal); return lease; }
    catch (error) {
      try { delivery.release(principal, lease.capability); } catch {}
      throw error;
    }
  }));
  server.registerTool("delivery_renew", {
    description: "Renew this identity's delivery lease supplied in X-Grayboard-Lease.", inputSchema: z.strictObject({}),
  }, (_args, ctx) => run(ctx.mcpReq.signal, () => delivery.renew(principal, leaseCapability(ctx.mcpReq.signal))));
  server.registerTool("delivery_receipt", {
    description: "Receipt issued delivery IDs only after durable host admission; not a DM handling acknowledgment.",
    inputSchema: z.strictObject({ ids: z.array(z.string().min(1).max(128)).max(100).refine(ids => new Set(ids).size === ids.length, "IDs must be distinct") }),
  }, (args, ctx) => run(ctx.mcpReq.signal, () => delivery.receipt(principal, leaseCapability(ctx.mcpReq.signal), args.ids)));
  server.registerTool("delivery_release", {
    description: "Release this identity's delivery lease supplied in X-Grayboard-Lease.", inputSchema: z.strictObject({}),
  }, (_args, ctx) => run(ctx.mcpReq.signal, () => delivery.release(principal, leaseCapability(ctx.mcpReq.signal))));
}
