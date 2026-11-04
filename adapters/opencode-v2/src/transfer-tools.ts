import { z } from "zod";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import { HostedAttachments } from "./core/attachments.js";
import { ATTACHMENTS_PARAM, ATTACHMENT_GET_TOOL, DEFAULT_ATTACHMENT_LIMITS, attachRoots, publishedLimits, SendLanded } from "./core/attachment-files.js";
import { NativeWire } from "./core/wire.js";
import type { OpenCodeController } from "./lifecycle.js";
import { SIGN_IN } from "./binding.js";

type InputSchema = { type: "object"; properties?: Record<string, unknown> };

export function attachmentTools(ctx: Context, controller: OpenCodeController) {
  const namespace = controller.options.mcpName.replace(/[^a-zA-Z0-9_-]/g, "_");
  // Native MCP checks this inside execute; path tools must check before any bytes leave or are saved.
  const authorizeTransfer = (name: string, input: unknown, context: ToolContext) => ctx.permission.assert({
    action: `${namespace}_${name}`, resources: ["*"], save: ["*"], metadata: { input },
    sessionID: context.sessionID, agent: context.agent, source: { type: "tool", messageID: context.messageID, id: context.id },
  });
  async function bridge(sessionID: string, signal: AbortSignal) {
    const path = await controller.childRoot(sessionID);
    const enrollment = controller.enrollment(path?.root ?? sessionID) ?? await controller.binding.capture(sessionID);
    let current: string | undefined;
    const auth = {
      token: async () => (current = await controller.binding.token(enrollment)),
      onUnauthorized: async () => controller.binding.unauthorized(enrollment, current ?? ""),
    };
    return new HostedAttachments({
      resource: new URL(enrollment.configuration.url), auth, harness: "OpenCode", loginAction: SIGN_IN,
      signal, roots: attachRoots(process.env, ctx.location.directory), cwd: ctx.location.directory,
      limits: async () => {
        const wire = new NativeWire({ url: enrollment.configuration.url, sessionKey: controller.port.sessionKey, client: controller.port.client }, auth, signal);
        try { await wire.connect(); return publishedLimits(wire.client.getServerCapabilities()?.experimental) ?? DEFAULT_ATTACHMENT_LIMITS; }
        finally { await wire.close(); }
      },
      unreleased: () => controller.backgroundFailure("release_upload"),
    });
  }
  return ctx.tool.transform(editor => {
    const native = editor.list().filter(tool => tool.options?.namespace === namespace);
    for (const name of ["dm_send", "board_post"]) {
      const source = native.find(tool => tool.id === `${namespace}_${name}`);
      if (!source) continue;
      editor.update(source.id, tool => {
        const input = tool.input as InputSchema;
        if (input.type !== "object") throw new Error("Grayboard native attachment tool must have an object input schema");
        tool.input = { ...input, properties: { ...input.properties, attachments: ATTACHMENTS_PARAM } };
        tool.description = tool.description.replace("attachment_ids?", "attachments?, attachment_ids?") + " Attachments are local file paths; attachment_ids are already uploaded IDs. Use one, not both.";
        const execute = tool.execute;
        tool.execute = async (raw: unknown, context: ToolContext) => {
          const args = raw as Record<string, unknown>;
          if (args.attachments === undefined) return execute(raw, context);
          if (args.attachment_ids !== undefined) throw new Error("Use attachments or attachment_ids, not both");
          const { attachments, ...rest } = args;
          await authorizeTransfer(name, raw, context);
          try {
            const transfers = await bridge(context.sessionID, context.signal);
            return await transfers.send(attachments, context.sessionID, async ids => {
              await transfers.options.auth.token();
              context.signal.throwIfAborted();
              const result = await execute(ids.length ? { ...rest, attachment_ids: ids } : rest, context);
              return result;
            });
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
        const output = await (await bridge(context.sessionID, context.signal)).get(args as { id: unknown; dir?: unknown }, context.sessionID);
        return { output, content: JSON.stringify(output) };
      },
      output: z.object({ path: z.string(), filename: z.string(), type: z.string(), size: z.number(), sha256: z.string() }),
    });
  });
}
