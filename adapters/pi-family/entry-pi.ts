// grayboard's hosted extension for pi (server mode, #279). `grayboard setup
// --server <url>` bundles this file for Node and installs it as
// <agentDir>/extensions/grayboard.js; local mode keeps adapters/pi/grayboard.ts.
// pi's API is imported as types only: the bundle has no runtime pi import.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { version } from "../../package.json" with { type: "json" };
import { piAgentDir } from "../../src/shared/pi.ts";
import { createGrayboard, type Level } from "./extension.ts";

// pi's MCP naming (createMcpToolName), so --tools, --exclude-tools and the
// MCP call renderer treat these as they treat any MCP server's tools.
const SERVER = "grayboard";
const PREFIX = `mcp__${SERVER}__`;

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export default function grayboard(pi: ExtensionAPI) {
  let ctx: ExtensionContext | undefined;
  const ext = createGrayboard({
    name: "pi",
    clientId: "grayboard-pi",
    version,
    agentDir: piAgentDir(),
    // pi-subagents' detached runner sets PI_SUBAGENT_CHILD=1 and passes the
    // top-level parent's session id (src/runs/background/subagent-runner.js).
    marker: () => process.env.PI_SUBAGENT_CHILD === "1"
      ? { child: true, ...(process.env.PI_SUBAGENT_PARENT_SESSION ? { root: process.env.PI_SUBAGENT_PARENT_SESSION } : {}) }
      : { child: false },
    register: (tools, call) => {
      for (const tool of tools) {
        pi.registerTool({
          name: PREFIX + tool.name,
          label: `${SERVER}/${tool.name}`,
          description: tool.description ?? `MCP tool ${tool.name} from server ${SERVER}`,
          // Plain JSON Schema: pi-ai validates by it when the schema isn't TypeBox.
          parameters: { ...tool.inputSchema, properties: tool.inputSchema.properties ?? {} } as never,
          namespace: { name: `mcp__${SERVER}`, aliases: [SERVER] },
          async execute(_id, params) {
            const result = await call(tool.name, params && typeof params === "object" ? Object.fromEntries(Object.entries(params)) : {});
            const content = result.content.flatMap((block): Content[] =>
              block.type === "text" ? [{ type: "text", text: block.text }]
              : block.type === "image" ? [{ type: "image", data: block.data, mimeType: block.mimeType }] : []);
            if (result.isError && !content.some(block => block.type === "text" && block.text))
              content.push({ type: "text", text: `MCP tool ${SERVER}/${tool.name} returned an error` });
            return { content, details: { server: SERVER, tool: tool.name }, ...(result.isError ? { isError: true } : {}) };
          },
        });
      }
    },
    // Direct messages, mentions, thread replies start a turn when idle and
    // steer in mid-run; digests and deferred replies are context only.
    deliver: (content, wake) => pi.sendMessage({ customType: "grayboard", content, display: true }, wake ? { triggerTurn: true } : undefined),
    notify: (message: string, level: Level) => {
      if (ctx?.hasUI) ctx.ui.notify(message, level);
      else console.error(message);
    },
  });

  pi.on("session_start", async (event, context) => {
    ctx = context;
    const header = context.sessionManager.getHeader();
    const file = context.sessionManager.getSessionFile();
    await ext.start({
      id: context.sessionManager.getSessionId(), reason: event.reason,
      ...(file ? { file } : {}), ...(header?.parentSession ? { parentFile: header.parentSession } : {}),
    });
  });
  pi.on("session_shutdown", async event => { await ext.shutdown(event.reason); });
  // pi leaves MCP instructions out of the prompt; they tell the model what a
  // <channel> message is.
  pi.on("before_agent_start", async event => {
    const text = await ext.instructions();
    if (text) event.systemPromptOptions.sections.grayboard = text;
  });
  pi.registerCommand("grayboard", {
    description: "grayboard: login | logout | resume | status",
    getArgumentCompletions: prefix => ["login", "logout", "resume", "status"].filter(v => v.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: async (args, context) => { ctx = context; await ext.command(args); },
  });
}
