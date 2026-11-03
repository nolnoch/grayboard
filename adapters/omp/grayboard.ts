// grayboard adapter for omp (oh-my-pi), local mode.
//
// omp runs task subagents in-process, each with its own extension runtime, on
// the main session's MCP connections, and its MCP client sends a tool call
// with nothing naming the agent that made it. So omp's MCP client doesn't run
// grayboard: this extension runs the process's one `grayboard mcp` and serves
// its tools in every runtime, under the names omp's client would give them
// (mcp__grayboard_<tool>). A subagent's call names the subagent's session in
// `_meta`, so grayboard runs it as a child session of the main one: it acts as
// the main session's names and is shown as the subagent (docs/boards.md,
// Child sessions). The grayboard process is the session's one process: it
// holds the bus name, the wakeup socket and the read cursors. Only the main
// session's runtime starts and stops it, delivers its channel notifications
// and gives its instructions to the model, so no push reaches a subagent (#526).
//
// Install: grayboard setup copies this into <agentDir>/extensions/. The
// command and env come from the mcpServers.grayboard entry in the user-level
// <agentDir>/mcp.json, which setup writes with "enabled": false: omp's own
// client then runs none, and the disabled entry still shadows a same-named
// entry omp ranks lower (Claude Code's user config, a repo's .mcp.json).
import { getAgentDir, settings, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { cfgMcpEnableProjectConfig } from "@oh-my-pi/pi-coding-agent/mcp/settings";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

type ChannelParams = { content: string; meta?: Record<string, string> };
type McpEntry = { command?: string; args?: string[]; env?: Record<string, string> };
type Tool = { name: string; description?: string; inputSchema: { type?: string; properties?: Record<string, unknown> }; _meta?: Record<string, unknown> };
type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type Config = { cmd: string; args: string[]; env: Record<string, string | undefined>; entryPath: string };
type Child = {
  proc: ChildProcess;
  ready: Promise<void>;
  call(method: string, params: object, signal?: AbortSignal): Promise<unknown>;
};

const SERVER = process.env.GRAYBOARD_MCP_NAME ?? "grayboard";
// omp's MCP tool naming (mintMCPToolName in its tool-bridge.ts).
const PREFIX = `mcp__${SERVER.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "") || "server"}_`;
// The `_meta` key naming a subagent's call (GRAYBOARD_AGENT_META, src/shared/session_meta.ts).
const AGENT_META = "io.github.nolnoch.grayboard/agent";
// omp gives session_shutdown handlers 2 s; the grayboard process gets most of it to end its session.
const EXIT_WAIT_MS = 1_500;

// What every runtime in this omp process shares: each subagent's runtime
// loads its own copy of this module, so module state would be per runtime.
type Shared = {
  config?: Config;
  tools?: Tool[];
  // The main runtime that runs the grayboard process, and its verdict: the
  // refusal text, or undefined when it serves the tools. Subagents follow it.
  owner?: ExtensionAPI;
  verdict?: Promise<string | undefined>;
  child?: Child;
  exitReason?: string;
  instructions?: string;
};
const KEY = Symbol.for("io.github.nolnoch.grayboard/omp-local");
const shared = ((globalThis as Record<symbol, unknown>)[KEY] ??= {}) as Shared;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// Same shape Claude Code shows the model, so the MCP server's instructions
// apply, and the one hosted-core renders (adapters/hosted-core/src/channel.ts):
// a body's `<channel` or `</channel` keeps its `<` escaped, so it can't close
// the element or forge another one (#433).
export function render({ content, meta = {} }: ChannelParams): string {
  const attrs = Object.entries(meta)
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join("");
  return `<channel source="grayboard"${attrs}>\n${content.replace(/<(?=\s*\/?\s*channel)/gi, "&lt;")}\n</channel>`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The child's command and env, from the user-level entry only: a project's
// config (a cloned repo's) never chooses what this extension runs. The entry's
// BUS_PUSH=off is for omp's client, were it ever enabled; this process is the
// delivery owner. BUS_HARNESS=omp has grayboard read a repo's .omp/mcp.json
// name pin, enabled or not, as it did when omp ran that entry
// (src/shared/identity.ts pinnedIdentity).
function config(agentDir: string): Config {
  const entryPath = join(agentDir, "mcp.json");
  let entry: McpEntry | undefined;
  try {
    const servers: unknown = JSON.parse(readFileSync(entryPath, "utf8"))?.mcpServers;
    if (isRecord(servers) && isRecord(servers[SERVER])) entry = servers[SERVER];
  } catch {
    entry = undefined;
  }
  const [cmd, ...args] = typeof entry?.command === "string" ? [entry.command, ...(entry.args ?? [])] : ["grayboard", "mcp"];
  const env: Record<string, string | undefined> = { ...process.env, ...entry?.env };
  delete env.BUS_PUSH;
  env.BUS_HARNESS = "omp";
  return { cmd: cmd!, args, env, entryPath };
}

// The tool list `grayboard mcp` serves in the entry's mode, from the installed
// binary, so this file and the binary can't drift. A failure fails the
// extension load, and omp reports it.
function loadTools({ cmd, args: entryArgs, env, entryPath }: Config): Tool[] {
  const at = entryArgs.indexOf("mcp");
  if (at < 0) throw new Error(`grayboard: can't find "mcp" in the ${SERVER} entry's args in ${entryPath}: ${JSON.stringify(entryArgs)}`);
  const args = [...entryArgs.slice(0, at), "tools", ...entryArgs.slice(at + 1)];
  const r = spawnSync(cmd, args, { env, encoding: "utf8", timeout: 15_000 });
  const what = [cmd, ...args].join(" ");
  if (r.error) throw new Error(`grayboard: \`${what}\` failed to run: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`grayboard: \`${what}\` exited ${r.status ?? r.signal}: ${r.stderr.trim()}`);
  let listed: unknown;
  try {
    listed = JSON.parse(r.stdout);
  } catch (e) {
    throw new Error(`grayboard: \`${what}\` printed no tool list (${(e as Error).message}): ${r.stdout.slice(0, 200)}`);
  }
  if (!Array.isArray(listed) || !listed.every((t): t is Tool => isRecord(t) && typeof t.name === "string" && isRecord(t.inputSchema))) {
    throw new Error(`grayboard: \`${what}\` printed no tool list: ${r.stdout.slice(0, 200)}`);
  }
  return listed;
}

// The tools that differ between two lists, by name, for the post-initialize check.
function toolDiff(registered: Tool[], served: unknown[]): string[] {
  const key = (t: unknown) => isRecord(t) ? JSON.stringify([t.description, t.inputSchema]) : "";
  const a = new Map(registered.map((t) => [t.name, key(t)]));
  const b = new Map(served.map((t) => [isRecord(t) ? String(t.name) : "", key(t)]));
  return [...new Set([...a.keys(), ...b.keys()])].filter((n) => a.get(n) !== b.get(n)).sort();
}

// A tools/call result, narrowed: the blocks omp shows, the error flag, and the
// instructions a main session's result carries when its names changed.
function callResult(value: unknown): { content: Content[]; isError: boolean; instructions?: string[] } {
  const r = isRecord(value) ? value : {};
  const content = (Array.isArray(r.content) ? r.content : []).flatMap((b: unknown): Content[] => {
    if (!isRecord(b)) return [];
    if (b.type === "text" && typeof b.text === "string") return [{ type: "text", text: b.text }];
    if (b.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string") return [{ type: "image", data: b.data, mimeType: b.mimeType }];
    return [];
  });
  const listed = isRecord(r.structuredContent) ? r.structuredContent.instructions : undefined;
  const instructions = Array.isArray(listed) && listed.every((s): s is string => typeof s === "string") ? listed : undefined;
  return { content, isError: r.isError === true, ...(instructions ? { instructions } : {}) };
}

// Whether an MCP server runs `grayboard mcp`: a stdio server with an `mcp`
// argument whose command is a grayboard binary, or whose command up to that
// argument is this extension's own (`bun <checkout>/src/cli/main.ts` from source).
function runsGrayboard(server: { type?: string; command?: string; args?: string[] }, own: Config): boolean {
  if ((server.type !== undefined && server.type !== "stdio") || !server.command) return false;
  const args = server.args ?? [];
  const at = args.indexOf("mcp");
  if (at < 0) return false;
  if (/^grayboard(\.exe)?$/i.test(basename(server.command))) return true;
  const prefix = [server.command, ...args.slice(0, at)];
  const ownPrefix = [own.cmd, ...own.args.slice(0, own.args.indexOf("mcp"))];
  return prefix.length === ownPrefix.length && prefix.every((p, i) => p === ownPrefix[i]);
}

// The refusal when omp itself would run a grayboard: an enabled MCP server,
// under any name, that runs `grayboard mcp`, as omp's own loader resolves its
// config (every source, priority, same-name shadowing, disabledServers,
// enabledServers and mcp.enableProjectConfig). Its tools would collide with
// these, and its process would be a second delivery owner beside this one's.
// The disabled user entry shadows only a same-named server omp ranks lower,
// so a repo's .omp/mcp.json entry, or one under another name, can still run.
// Undefined when there's none.
async function secondGrayboard(cwd: string, own: Config): Promise<string | undefined> {
  const meanwhile = "until then the grayboard extension registers no tools and receives nothing";
  try {
    const { configs, sources } = await loadAllMCPConfigs(cwd, { enableProjectConfig: cfgMcpEnableProjectConfig.get(settings) });
    const found = Object.entries(configs).find(([, server]) => runsGrayboard(server, own));
    if (!found) return undefined;
    const [name, server] = found;
    const source = sources[name];
    // The pin grayboard reads itself under omp: the repo's .omp/mcp.json grayboard entry's.
    const pin = "env" in server ? server.env?.BUS_IDENTITY : undefined;
    const pins = name === "grayboard" && source?.level === "project" && basename(dirname(source.path)) === ".omp" && basename(source.path) === "mcp.json" && pin;
    const keeps = pins ? ` (disabled, its BUS_IDENTITY "${pin}" still pins this session's name)` : "";
    return `grayboard: the "${name}" MCP server in ${source?.path ?? "omp's MCP config"} runs \`grayboard mcp\` and is enabled, so omp would run a second grayboard beside this extension's. Set "enabled": false on it${keeps} or remove it (grayboard setup writes the user-level "${SERVER}" entry disabled); ${meanwhile}.`;
  } catch (e) {
    return `grayboard: couldn't read omp's MCP config to check for a second grayboard (${(e as Error).message}); ${meanwhile}.`;
  }
}

export default function grayboard(pi: ExtensionAPI) {
  const own = (shared.config ??= config(getAgentDir()));
  const tools = (shared.tools ??= loadTools(own));
  let registered = false;
  // The instructions this runtime's before_agent_start last appended.
  let injected: string | undefined;

  // On screen when there is one, else on stderr; always into omp's log.
  const report = (ctx: ExtensionContext, text: string) => {
    pi.logger.error(text);
    if (ctx.hasUI) ctx.ui.notify(text, "error");
    else console.error(text);
  };

  // Direct messages, mentions, thread replies: act on them (wakes an idle
  // agent; mid-run, lands at the next step boundary). Digests and deferred
  // thread replies: context only. Bound to the main runtime's `pi`, so a
  // push lands in the main session only.
  const deliver = (params: ChannelParams) => {
    const contextOnly = params.meta?.kind === "digest" || params.meta?.deferred === "true";
    pi.sendMessage(
      { customType: "grayboard", content: render(params), display: true, attribution: "agent" },
      contextOnly ? { deliverAs: "nextTurn" } : { deliverAs: "aside", triggerTurn: true },
    );
  };

  // Started by the main session, not at load: until something can receive
  // them, messages wait in grayboard rather than in this process.
  const start = (ctx: ExtensionContext): Child => {
    const proc = spawn(own.cmd, own.args, { cwd: ctx.cwd, env: own.env, stdio: ["pipe", "pipe", "pipe"] });
    const pending = new Map<number, PromiseWithResolvers<unknown>>();
    let next = 1;
    let gone: Error | undefined;
    const send = (msg: object) => proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
    const call = (method: string, params: object, signal?: AbortSignal): Promise<unknown> => {
      if (gone) return Promise.reject(gone);
      if (signal?.aborted) return Promise.reject(new Error("aborted"));
      const id = next++;
      const waiter = Promise.withResolvers<unknown>();
      const onAbort = () => {
        pending.delete(id);
        send({ method: "notifications/cancelled", params: { requestId: id, reason: "aborted" } });
        waiter.reject(new Error("aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      pending.set(id, waiter);
      send({ id, method, params });
      return waiter.promise.finally(() => signal?.removeEventListener("abort", onAbort));
    };
    const fail = (reason: string) => {
      gone = new Error(reason);
      for (const p of pending.values()) p.reject(gone);
      pending.clear();
      if (shared.child?.proc !== proc) return;
      shared.child = undefined;
      shared.exitReason = reason;
      report(ctx, `${reason}; restart omp to reconnect`);
    };
    // JSON-RPC over stdio is LF-delimited; split on "\n" only (readline would
    // also split on U+2028/2029, which are valid inside JSON strings).
    let buf = "";
    proc.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (!isRecord(msg)) continue;
        const { id, params } = msg;
        if (msg.method === "notifications/claude/channel" && isRecord(params) && typeof params.content === "string") {
          const meta = isRecord(params.meta) ? Object.fromEntries(Object.entries(params.meta).filter((e): e is [string, string] => typeof e[1] === "string")) : {};
          deliver({ content: params.content, meta });
        } else if (typeof id === "number" && pending.has(id)) {
          const p = pending.get(id)!;
          pending.delete(id);
          if (isRecord(msg.error)) p.reject(new Error(`grayboard: ${String(msg.error.message)}`));
          else p.resolve(msg.result);
        }
      }
    });
    // Into omp's log, not the terminal, where it would cut into omp's screen.
    let errBuf = "";
    proc.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
      errBuf += chunk;
      let nl: number;
      while ((nl = errBuf.indexOf("\n")) >= 0) {
        const line = errBuf.slice(0, nl).trim();
        errBuf = errBuf.slice(nl + 1);
        if (line) pi.logger.warn(`grayboard process: ${line}`);
      }
    });
    // E.g. no grayboard at the entry's command; unhandled, the error event would crash omp.
    proc.on("error", (e) => fail(`grayboard process failed to start: ${e.message}`));
    proc.on("exit", (code, signal) => fail(`grayboard process exited (${code ?? signal})`));
    // A write after grayboard closed its end (EPIPE); unhandled, the error event would crash omp.
    proc.stdin!.on("error", (e) => fail(`grayboard process stopped reading: ${e.message}`));
    // stdin stays open: grayboard exits when it closes, releasing the name.
    const ready = call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "omp-grayboard", version: "1" },
    }).then(async (init) => {
      if (isRecord(init) && typeof init.instructions === "string") shared.instructions = init.instructions;
      send({ method: "notifications/initialized" });
      const listed = await call("tools/list", {});
      const served = isRecord(listed) && Array.isArray(listed.tools) ? listed.tools : [];
      const diff = toolDiff(tools, served);
      if (diff.length) report(ctx, `grayboard: the running grayboard serves different tools than \`grayboard tools\` listed at load: ${diff.join(", ")}`);
    });
    // A call that awaits ready gets the failure; this only keeps an unawaited
    // rejection from crashing omp when no call is waiting.
    ready.catch(() => {});
    return { proc, ready, call };
  };

  // In every runtime: the main session's calls go out as its own; a
  // subagent's name its session, so grayboard runs it as a child session.
  const register = () => {
    registered = true;
    for (const tool of tools) {
      pi.registerTool({
        name: PREFIX + tool.name,
        label: `${SERVER}/${tool.name}`,
        description: tool.description ?? `MCP tool ${tool.name} from server ${SERVER}`,
        // Plain JSON Schema, as omp's own MCP tools pass it.
        parameters: { ...tool.inputSchema, properties: tool.inputSchema.properties ?? {} } as never,
        mcpServerName: SERVER,
        mcpToolName: tool.name,
        approval: "write",
        strict: false,
        loadMode: tool._meta?.["anthropic/alwaysLoad"] === true ? "essential" : "discoverable",
        async execute(_id, params, signal, _onUpdate, ctx) {
          const c = shared.child;
          if (!c) throw new Error(shared.exitReason ?? "grayboard: no grayboard process runs in this omp process");
          await c.ready;
          const sub = ctx.agent.kind !== "main";
          const result = callResult(await c.call("tools/call", {
            name: tool.name,
            arguments: isRecord(params) ? params : {},
            ...(sub ? { _meta: { [AGENT_META]: ctx.sessionManager.getSessionId() } } : {}),
          }, signal));
          if (result.isError && !result.content.some((b) => b.type === "text" && b.text)) {
            result.content.push({ type: "text", text: `MCP tool ${SERVER}/${tool.name} returned an error` });
          }
          // A main session's result carries the instructions when its names
          // changed (#182 decision 13): bind's, the next one's after a bind
          // whose result was lost, or a lost name's. A child's never does.
          if (!sub && result.instructions) shared.instructions = result.instructions.join(" ");
          return { content: result.content, details: { server: SERVER, tool: tool.name }, ...(result.isError ? { isError: true as const } : {}) };
        },
      });
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.agent.kind !== "main") {
      // A subagent serves the tools when its main session does.
      if (!registered && shared.verdict && !(await shared.verdict)) register();
      return;
    }
    if (shared.owner === pi) return;
    // One grayboard process per omp process: a second top-level session in
    // it (ACP serves several) would act as the first's.
    if (shared.owner) {
      return report(ctx, "grayboard: another top-level session in this omp process runs grayboard; this one registers no grayboard tools and receives nothing");
    }
    shared.owner = pi;
    shared.verdict = secondGrayboard(ctx.cwd, own);
    const refused = await shared.verdict;
    if (refused) return report(ctx, refused);
    register();
    shared.exitReason = undefined;
    shared.child = start(ctx);
  });

  // The instructions tell the model what a <channel> message is; only the
  // main session receives any, so a subagent gets none. A prompt sent as omp
  // starts can beat the grayboard process's initialize; the first turn waits.
  pi.on("before_agent_start", async (event, ctx) => {
    if (ctx.agent.kind !== "main" || shared.owner !== pi) return undefined;
    await shared.child?.ready.catch(() => {});
    injected = shared.instructions;
    return injected ? { systemPrompt: [...event.systemPrompt, injected] } : undefined;
  });

  // omp runs before_agent_start only for a user's prompt, and rebuilds the
  // system prompt without what it appended on /new, /resume and /fork: a
  // push-started turn after one gets the instructions as a hidden message.
  pi.on("context", async (event, ctx) => {
    if (ctx.agent.kind !== "main" || shared.owner !== pi || !shared.instructions) return undefined;
    if (injected !== undefined && ctx.getSystemPrompt().includes(injected)) return undefined;
    const message = { role: "custom", customType: "grayboard-instructions", content: shared.instructions, display: false, attribution: "agent", timestamp: Date.now() } as const;
    return { messages: [...event.messages, message] };
  });

  // omp keeps the main runtime across /new, /resume and /fork, so this runs
  // once, at quit: close the process's stdin and give it time to end its session.
  pi.on("session_shutdown", async () => {
    if (shared.owner !== pi) return;
    const c = shared.child;
    shared.owner = undefined;
    shared.verdict = undefined;
    shared.child = undefined;
    shared.exitReason = "grayboard: the main omp session ended";
    if (!c) return;
    const exited = Promise.withResolvers<void>();
    c.proc.once("exit", () => exited.resolve());
    c.proc.stdin!.end();
    await Promise.race([exited.promise, Bun.sleep(EXIT_WAIT_MS)]);
    if (c.proc.exitCode === null && c.proc.signalCode === null) c.proc.kill();
  });
}
