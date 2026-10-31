// grayboard's hosted extension for omp (server mode, #280). `grayboard setup
// --server <url>` bundles this file and installs it as
// <agentDir>/extensions/grayboard.js; local mode keeps adapters/omp/grayboard.ts
// with an enabled mcp.json entry. `@oh-my-pi/pi-coding-agent` stays external:
// omp resolves an extension's import of it to the running host, so the agent
// directory is omp's own (profiles, PI_CODING_AGENT_DIR, XDG).
//
// omp, unlike pi, keeps one extension runtime across a session's /new,
// /resume and /fork (session_switch) and branch transitions (session_branch),
// and runs task subagents in-process, each with its own runtime and
// `ctx.agent`. So this entry holds the current session's Grayboard and
// replaces it when the session id changes, and attributes a subagent to its
// top-level session through the chain of `ctx.agent.parentId`s.
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { version } from "../../package.json" with { type: "json" };
import { loadMode } from "../hosted-core/src/proxy.ts";
import { COMMAND, createGrayboard, toolArgs, toolResult, type Grayboard, type Level, type Marker, type ShutdownReason, type StartReason } from "./extension.ts";
import { registry, rootOf } from "./omp-ancestry.ts";

// omp's MCP naming (tool-bridge.ts mintMCPToolName): grayboard's tool names
// are already lowercase snake case, so `mcp__grayboard_<tool>`, as the local
// mcp.json entry names them.
const SERVER = "grayboard";
const PREFIX = `mcp__${SERVER}_`;

export default function grayboard(pi: ExtensionAPI) {
  let ctx: ExtensionContext | undefined;
  let current: Grayboard | undefined, currentId: string | undefined;
  let agent: ExtensionContext["agent"] | undefined;
  let disposed = false; // session_shutdown ran: no session starts after it

  // Read at each register, so a subagent revived after its main session
  // moved on (/new) registers under the root that is live now.
  const marker = (): Marker => {
    if (!agent || agent.kind === "main") return { child: false };
    const placed = rootOf(registry, agent.parentId);
    return placed ? { child: true, ...placed } : { child: true };
  };

  const make = () => createGrayboard({
    name: "omp",
    clientId: "grayboard-omp",
    version,
    agentDir: getAgentDir(),
    marker,
    register: (tools, call) => {
      for (const tool of tools) {
        pi.registerTool({
          name: PREFIX + tool.name,
          label: `${SERVER}/${tool.name}`,
          description: tool.description ?? `MCP tool from ${SERVER}`,
          // Plain JSON Schema, as omp's own MCP tools pass it.
          parameters: { ...tool.inputSchema, properties: tool.inputSchema.properties ?? {} } as never,
          mcpServerName: SERVER,
          mcpToolName: tool.name,
          approval: "write",
          strict: false,
          loadMode: loadMode(tool),
          execute: async (_id, params) => toolResult(SERVER, tool.name, await call(tool.name, toolArgs(params))),
        });
      }
    },
    // Direct messages, mentions, thread replies start a turn when idle and
    // land at the next step boundary mid-run; digests and deferred replies
    // wait, hidden, for the next turn.
    deliver: (content, wake) => pi.sendMessage({ customType: "grayboard", content, display: true },
      wake ? { deliverAs: "aside", triggerTurn: true } : { deliverAs: "nextTurn" }),
    // Always into omp's log file; on screen too when there is one.
    notify: (message: string, level: Level) => {
      if (level === "error") pi.logger.error(message);
      else if (level === "warning") pi.logger.warn(message);
      else pi.logger.info(message);
      if (ctx?.hasUI) ctx.ui.notify(message, level);
      else console.error(message);
    },
  });

  const begin = async (context: ExtensionContext, reason: StartReason) => {
    ctx = context;
    agent = context.agent;
    const id = context.sessionManager.getSessionId();
    currentId = id;
    registry.set(agent.id, { raw: id, main: agent.kind === "main", ...(agent.parentId !== undefined ? { parent: agent.parentId } : {}) });
    const header = context.sessionManager.getHeader();
    const file = context.sessionManager.getSessionFile();
    current = make();
    await current.start({
      id, reason,
      ...(file ? { file } : {}), ...(header?.parentSession ? { parentFile: header.parentSession } : {}),
    });
  };
  const finish = async (reason: ShutdownReason) => {
    const ending = current;
    current = undefined;
    currentId = undefined;
    await ending?.shutdown(reason);
  };
  // A switch or branch that changed the session id ends the old session and
  // starts the new one; one that kept it (a branch in place) changes nothing.
  // A shutdown while the old one ends leaves none started.
  const replace = async (context: ExtensionContext, reason: "new" | "resume" | "fork") => {
    ctx = context;
    if (disposed || (current && currentId === context.sessionManager.getSessionId())) return;
    await finish(reason);
    if (disposed) return;
    await begin(context, reason);
  };

  pi.on("session_start", async (_event, context) => { await begin(context, "startup"); });
  pi.on("session_switch", async (event, context) => { await replace(context, event.reason); });
  pi.on("session_branch", async (_event, context) => { await replace(context, "fork"); });
  pi.on("session_shutdown", async () => { disposed = true; await finish("quit"); });
  // A subagent's run ended: omp keeps it live for its idle TTL, revivable, so
  // its child slot goes back now rather than at shutdown. Not awaited: the
  // end waits for calls still running, which must not hold omp's event loop.
  pi.on("agent_end", async (event, context) => {
    if (context.agent.kind === "sub" && !event.willContinue) void current?.idle();
  });
  // The server's instructions tell the model what a <channel> message is;
  // a subagent receives none, so only a main session gets them.
  pi.on("before_agent_start", async (event, context) => {
    if (context.agent.kind !== "main") return undefined;
    const text = await current?.instructions();
    return text ? { systemPrompt: [...event.systemPrompt, text] } : undefined;
  });
  pi.registerCommand("grayboard", { ...COMMAND, handler: async (args, context) => { ctx = context; await current?.command(args); } });
}
