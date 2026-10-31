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
import { createGrayboard, type Grayboard, type Level, type Marker, type ShutdownReason, type StartReason } from "./extension.ts";

// omp's MCP naming (tool-bridge.ts mintMCPToolName): grayboard's tool names
// are already lowercase snake case, so `mcp__grayboard_<tool>`, as the local
// mcp.json entry names them.
const SERVER = "grayboard";
const PREFIX = `mcp__${SERVER}_`;

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

// Every live session in this process by its omp agent id ("Main",
// "0-Explore", …): the raw grayboard session id, whether it is a top-level
// session, and for a subagent its top-level root and the subagent sessions
// between (outermost first). A subagent whose chain doesn't reach a main
// session has no root.
type Agent = { raw: string; main: boolean; root?: string; via: string[] };
const KEY = Symbol.for("grayboard.omp.agents");
const agents: Map<string, Agent> = ((globalThis as Record<symbol, unknown>)[KEY] ??= new Map()) as Map<string, Agent>;

function place(agent: ExtensionContext["agent"], raw: string): Agent {
  if (agent.kind === "main") return { raw, main: true, via: [] };
  const parent = agent.parentId === undefined ? undefined : agents.get(agent.parentId);
  if (parent?.main) return { raw, main: false, root: parent.raw, via: [] };
  if (parent?.root !== undefined) return { raw, main: false, root: parent.root, via: [...parent.via, parent.raw] };
  return { raw, main: false, via: [] };
}

export default function grayboard(pi: ExtensionAPI) {
  let ctx: ExtensionContext | undefined;
  let current: Grayboard | undefined, currentId: string | undefined;
  let marker: Marker = { child: false };
  let agentId: string | undefined;

  const make = () => createGrayboard({
    name: "omp",
    clientId: "grayboard-omp",
    version,
    agentDir: getAgentDir(),
    marker: () => marker,
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
    // land at the next step boundary mid-run; digests and deferred replies
    // wait, hidden, for the next turn.
    deliver: (content, wake) => pi.sendMessage({ customType: "grayboard", content, display: true },
      wake ? { deliverAs: "aside", triggerTurn: true } : { deliverAs: "nextTurn" }),
    notify: (message: string, level: Level) => {
      if (ctx?.hasUI) ctx.ui.notify(message, level);
      else console.error(message);
    },
  });

  const begin = async (context: ExtensionContext, reason: StartReason) => {
    ctx = context;
    const id = context.sessionManager.getSessionId();
    const self = place(context.agent, id);
    agentId = context.agent.id;
    currentId = id;
    agents.set(agentId, self);
    marker = self.main ? { child: false }
      : self.root === undefined ? { child: true } : { child: true, root: self.root, via: self.via };
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
    // Unless a newer session under this agent id already replaced the entry.
    if (agentId !== undefined && agents.get(agentId)?.raw === currentId) agents.delete(agentId);
    currentId = undefined;
    await ending?.shutdown(reason);
  };
  // A switch or branch that changed the session id ends the old session and
  // starts the new one; one that kept it (a branch in place) changes nothing.
  const replace = async (context: ExtensionContext, reason: "new" | "resume" | "fork") => {
    ctx = context;
    if (current && currentId === context.sessionManager.getSessionId()) return;
    await finish(reason);
    await begin(context, reason);
  };

  pi.on("session_start", async (_event, context) => { await begin(context, "startup"); });
  pi.on("session_switch", async (event, context) => { await replace(context, event.reason); });
  pi.on("session_branch", async (_event, context) => { await replace(context, "fork"); });
  pi.on("session_shutdown", async () => { await finish("quit"); });
  // A subagent's run ended: omp keeps it live for its idle TTL, revivable, so
  // its child slot goes back now rather than at shutdown.
  pi.on("agent_end", async (_event, context) => { if (context.agent.kind === "sub") await current?.idle(); });
  // The server's instructions tell the model what a <channel> message is;
  // a subagent receives none, so only a main session gets them.
  pi.on("before_agent_start", async (event, context) => {
    if (context.agent.kind !== "main") return undefined;
    const text = await current?.instructions();
    return text ? { systemPrompt: [...event.systemPrompt, text] } : undefined;
  });
  pi.registerCommand("grayboard", {
    description: "grayboard: login | logout | resume | status",
    getArgumentCompletions: prefix => ["login", "logout", "resume", "status"].filter(v => v.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: async (args, context) => { ctx = context; await current?.command(args); },
  });
}
