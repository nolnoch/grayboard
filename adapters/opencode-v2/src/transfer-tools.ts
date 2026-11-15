import { z } from "zod";
import type { AuthProvider } from "@modelcontextprotocol/client";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import { HostedAttachments } from "./core/attachments.js";
import { ATTACHMENTS_PARAM, ATTACHMENT_GET_TOOL, DEFAULT_ATTACHMENT_LIMITS, attachRoots, publishedLimits, SendLanded, type AttachmentLimits } from "./core/attachment-files.js";
import { NativeWire, unreachable } from "./core/wire.js";
import { outputOf } from "./core/results.js";
import type { OpenCodeController } from "./lifecycle.js";
import { SIGN_IN } from "./binding.js";

type InputSchema = { type: "object"; properties?: Record<string, unknown> };
type Native = { key: string; wire: NativeWire; auth: AuthProvider; ready: Promise<AttachmentLimits>; users: number; retired: boolean };

export async function attachmentTools(ctx: Context, controller: OpenCodeController, Transport = NativeWire) {
  const namespace = controller.options.mcpName.replace(/[^a-zA-Z0-9_-]/g, "_");
  // Native MCP checks this inside execute; path tools must check before any bytes leave or are saved.
  const authorizeTransfer = (name: string, input: unknown, context: ToolContext) => ctx.permission.assert({
    action: `${namespace}_${name}`, resources: ["*"], save: ["*"], metadata: { input },
    sessionID: context.sessionID, agent: context.agent, source: { type: "tool", messageID: context.messageID, id: context.id },
  });
  // Sessionless native connections share capabilities and calls, never the
  // caller's session ID. A changed endpoint/grant retires, rather than retargets,
  // the previous connection; its in-flight transfers finish before it closes.
  const closing = new AbortController(), connections = new Set<Native>();
  let current: Native | undefined;
  const retire = (native: Native) => {
    native.retired = true;
    if (native.users || !connections.delete(native)) return;
    void native.ready.catch(() => {}).then(() => native.wire.close()).catch(() => controller.backgroundFailure("hook_dispose"));
  };
  async function transfer<T>(sessionID: string, signal: AbortSignal, run: (attachments: HostedAttachments, wire: NativeWire) => Promise<T>): Promise<T> {
    closing.signal.throwIfAborted();
    const path = await controller.childRoot(sessionID);
    const enrollment = controller.enrollment(path?.root ?? sessionID) ?? await controller.binding.capture(sessionID);
    const key = JSON.stringify([enrollment.configuration, enrollment.integrationID, enrollment.connectionID]);
    if (!current || current.key !== key) {
      if (current) retire(current);
      let access: string | undefined;
      const auth: AuthProvider = {
        token: async () => (access = await controller.binding.token(enrollment)),
        onUnauthorized: async () => controller.binding.unauthorized(enrollment, access ?? ""),
      };
      const wire = new Transport({ url: enrollment.configuration.url, sessionKey: controller.port.sessionKey, client: controller.port.client, facts: controller.port.facts }, auth, closing.signal);
      const native: Native = { key, wire, auth, users: 0, retired: false, ready: wire.connect().then(() => publishedLimits(wire.client.getServerCapabilities()?.experimental) ?? DEFAULT_ATTACHMENT_LIMITS) };
      current = native;
      connections.add(native);
      void native.ready.catch(() => { if (current === native) current = undefined; retire(native); });
    }
    const native = current;
    native.users++;
    try {
      const attachments = new HostedAttachments({
        resource: new URL(enrollment.configuration.url), auth: native.auth, harness: "OpenCode", loginAction: SIGN_IN,
        signal: AbortSignal.any([signal, closing.signal]), roots: attachRoots(process.env, ctx.location.directory), cwd: ctx.location.directory,
        limits: () => native.ready, unreleased: () => controller.backgroundFailure("release_upload"),
      });
      return await run(attachments, native.wire);
    } catch (error) {
      if (unreachable(error)) { if (current === native) current = undefined; retire(native); }
      throw error;
    } finally {
      native.users--;
      if (native.retired) retire(native);
    }
  }
  const registration = await ctx.tool.transform(editor => {
    const native = editor.list().filter(tool => tool.options?.namespace === namespace);
    for (const name of ["dm_send", "board_post"]) {
      const source = native.find(tool => tool.id === `${namespace}_${name}`);
      if (!source) continue;
      editor.update(source.id, tool => {
        const input = tool.input as InputSchema;
        if (input.type !== "object") throw new Error("Grayboard native attachment tool must have an object input schema");
        tool.input = { ...input, properties: { ...input.properties, attachments: ATTACHMENTS_PARAM } };
        tool.description = tool.description.replace("attachment_ids?", "attachments?, attachment_ids?") + " attachments takes local file paths; attachment_ids takes already uploaded IDs. Use one, not both.";
        const execute = tool.execute;
        tool.execute = async (raw: unknown, context: ToolContext) => {
          const args = raw as Record<string, unknown>;
          if (args.attachments === undefined) return execute(raw, context);
          if (args.attachment_ids !== undefined) throw new Error("Use attachments or attachment_ids, not both");
          const { attachments, ...rest } = args;
          await authorizeTransfer(name, raw, context);
          try {
            return await transfer(context.sessionID, context.signal, (transfers, wire) => transfers.send(attachments, context.sessionID, async ids => {
              await transfers.options.auth.token();
              context.signal.throwIfAborted();
              const result = await wire.callTool(name, ids.length ? { ...rest, attachment_ids: ids } : rest, context.sessionID).catch(error => {
                // sendWithUploads may turn a lost answer into SendLanded, so
                // retire a broken wire before that recovery hides its cause.
                if (unreachable(error) && current?.wire === wire) { retire(current); current = undefined; }
                throw error;
              });
              if (result.isError) throw new Error(result.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n") || "MCP tool returned an error");
              return { output: outputOf(result), content: result.content.filter(part => part.type === "text") };
            }));
          } catch (error) {
            if (error instanceof SendLanded) { const output = { sent: true, attachment_ids: error.attachments, note: error.message }; return { output, content: JSON.stringify(output) }; }
            throw error;
          }
        };
      });
    }
    const source = native.find(tool => tool.id === `${namespace}_dm_send`);
    if (!source) return;
    editor.add({
      name: ATTACHMENT_GET_TOOL.name, options: source.options, description: ATTACHMENT_GET_TOOL.description,
      input: ATTACHMENT_GET_TOOL.inputSchema,
      execute: async (args: unknown, context: ToolContext) => {
        await authorizeTransfer(ATTACHMENT_GET_TOOL.name, args, context);
        const output = await transfer(context.sessionID, context.signal, transfers => transfers.get(args as { id: unknown; dir?: unknown }, context.sessionID));
        return { output, content: JSON.stringify(output) };
      },
      output: z.object({ path: z.string(), filename: z.string(), type: z.string(), size: z.number(), sha256: z.string() }),
    });
  });
  return { async dispose() {
    closing.abort();
    try { await registration.dispose(); }
    finally {
      await Promise.allSettled([...connections].map(async native => { await native.ready.catch(() => {}); await native.wire.close(); }));
      connections.clear();
      current = undefined;
    }
  } };
}
