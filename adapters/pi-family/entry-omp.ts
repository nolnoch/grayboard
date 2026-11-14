// grayboard's hosted extension for omp (server mode, #280). `grayboard setup
// --server <url>` bundles this file and installs it as
// <agentDir>/extensions/grayboard.js; local mode bundles adapters/omp/grayboard.ts
// with a disabled mcp.json entry. `@oh-my-pi/pi-coding-agent` stays external:
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
import type { Level } from "../hosted-core/src/client.ts";
import { loadMode } from "../hosted-core/src/proxy.ts";
import { COMMAND, createGrayboard, factReader, toolArgs, toolResult, type Grayboard, type Marker, type ShutdownReason, type StartReason } from "./extension.ts";
import { registry, rootOf } from "./omp-ancestry.ts";
import { instructionHooks, modelName } from "./omp-instructions.ts";

// omp's MCP naming (tool-bridge.ts mintMCPToolName): grayboard's tool names
// are already lowercase snake case, so `mcp__grayboard_<tool>`, as the local
// mcp.json entry names them.
const SERVER = "grayboard";
const PREFIX = `mcp__${SERVER}_`;
// How long a model call waits for the instructions before going out as omp
// built it.
const FETCH_WAIT_MS = 2_000;
const LATE = Symbol("late");

export default function grayboard(pi: ExtensionAPI) {
  let ctx: ExtensionContext | undefined;
  let current: Grayboard | undefined, currentId: string | undefined;
  let agent: ExtensionContext["agent"] | undefined;
  let disposed = false; // session_shutdown ran: no session starts after it
  let slow = false; // a fetch outran FETCH_WAIT_MS; logged once until one doesn't

  // The current instructions, or undefined when there are none or the server
  // takes longer than FETCH_WAIT_MS (a partition, an outage): a model call
  // never waits out a connect timeout for them.
  const instructions = async (): Promise<string | undefined> => {
    const fetching = current?.instructions();
    if (!fetching) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<typeof LATE>(resolve => { timer = setTimeout(() => resolve(LATE), FETCH_WAIT_MS); });
    const text = await Promise.race([fetching, late]).finally(() => clearTimeout(timer));
    if (text !== LATE) { slow = false; return text; }
    if (!slow) pi.logger.warn(`grayboard: the instructions took longer than ${FETCH_WAIT_MS} ms; model requests go out without refreshing them until the server answers in time`);
    slow = true;
    return undefined;
  };

  // On screen when there is one, else on stderr.
  const show = (message: string, level: Level) => {
    if (ctx?.hasUI) ctx.ui.notify(message, level);
    else console.error(message);
  };
  const hooks = instructionHooks<ExtensionContext>({ instructions, logger: pi.logger, show: message => show(message, "warning") });
  // Always into omp's log file; on screen too.
  const notify = (message: string, level: Level) => {
    if (level === "error") pi.logger.error(message);
    else if (level === "warning") pi.logger.warn(message);
    else pi.logger.info(message);
    show(message, level);
  };
  const readFacts = factReader(message => notify(message, "warning"));

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
    notify,
    // tui and rpc outlive a sign-in's browser round trip; print and json exit after one run.
    interactive: () => ctx?.mode === "tui" || ctx?.mode === "rpc",
    // omp points its session manager at the next session before it emits
    // session_switch, so a receipt landing in between would go into that
    // session's file: only the session the record names gets it.
    record: data => {
      if (ctx?.sessionManager.getSessionId() === data.root) pi.appendEntry("grayboard-delivery", data);
      else pi.logger.warn("grayboard: a delivery record for a session no longer current; logged here, not in its file", { ...data });
    },
    // Like `record`: between omp's switch and session_switch, ctx already
    // shows the next session's model, so only the session it names answers.
    // omp's `inherit` names no level of its own: it's none, and clears the server's (#558).
    facts: sessionID => ctx?.sessionManager.getSessionId() === sessionID ? readFacts(sessionID, {
      model: () => ctx?.model ? modelName(ctx.model) : null,
      effort: () => { const effort = pi.getThinkingLevel(); return effort && effort !== "inherit" ? effort : null; },
    }) : undefined,
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
    return hooks.beforeAgentStart(event);
  });
  // A turn a push started skips before_agent_start, so each main request is
  // brought to the current instructions here. A system prompt omp rebuilt
  // (/resume, /new, /fork) holds no grayboard element: that one request gets
  // the instructions as a hidden message (omp cloned the messages for it),
  // last, since omp marks a context-added message per-call and Anthropic's
  // cache checkpoints stop before the first such message.
  pi.on("context", async (event, context) => {
    if (context.agent.kind !== "main") return undefined;
    return hooks.context(event, context);
  });
  // One that still holds the text last appended, now stale (a bind since),
  // gets it rewritten in the payload, in place: the return value stays
  // undefined, since some providers ignore it or need their own object.
  pi.on("before_provider_request", async (event, context) => {
    if (context.agent.kind !== "main") return undefined;
    return hooks.beforeProviderRequest(event, context);
  });
  pi.registerCommand("grayboard", { ...COMMAND, handler: async (args, context) => { ctx = context; await current?.command(args); } });
}
