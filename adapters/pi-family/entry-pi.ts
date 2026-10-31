// grayboard's hosted extension for pi (server mode, #279). `grayboard setup
// --server <url>` bundles this file for Node and installs it as
// <agentDir>/extensions/grayboard.js; local mode keeps adapters/pi/grayboard.ts.
// pi's API is imported as types only: the bundle has no runtime pi import.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { version } from "../../package.json" with { type: "json" };
import { piAgentDir } from "../../src/shared/pi.ts";
import { COMMAND, createGrayboard, toolArgs, toolResult, type Level } from "./extension.ts";

// pi's MCP naming (createMcpToolName), so --tools, --exclude-tools and the
// MCP call renderer treat these as they treat any MCP server's tools.
const SERVER = "grayboard";
const PREFIX = `mcp__${SERVER}__`;

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
          execute: async (_id, params) => toolResult(SERVER, tool.name, await call(tool.name, toolArgs(params))),
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
  pi.registerCommand("grayboard", { ...COMMAND, handler: async (args, context) => { ctx = context; await ext.command(args); } });
}
