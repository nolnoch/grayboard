// grayboard adapter for pi subagent children (#244).
//
// A pi-subagents background child runs in a detached runner that loads no
// ambient extensions, so the parent's grayboard extension never reaches it.
// This file is the child's grayboard: an agent definition loads it via
// `subagentOnlyExtensions:` (frontmatter), and it runs the session's one
// `grayboard mcp` for the CHILD, registers its tools, and delivers its pushes.
//
// Identity: the runner inherits the parent's BUS_IDENTITY, and a child reusing
// it is refused (the parent holds the name). So the ambient value is ignored;
// the child's name comes from the launcher's `options.extensionBindings`,
// namespace `grayboard/1`: `{ identity: "child-name", parent: "parent-handle" }`.
// With an identity the child starts bound to it (server mode: the identity must
// exist — `grayboard identity create`); without one the child runs unbound
// (read-only floor: reads work, `bind` via tool goes full). Either way the
// child is its own delivery owner (push on): one delivery owner per handle
// (boards.md §9) — it never shares the parent's push channel.
//
// Thread replies: a delegation's result is posted in the request's thread by
// the LAUNCHER (the relay floor); a child on its own connection reports to the
// parent handle by DM (its own thread), per #244's threading note.
//
// Install: point an agent definition's `subagentOnlyExtensions:` at this file
// (`grayboard setup`/`refresh-adapters` install it next to the parent
// adapter). The command and env come from the mcpServers.grayboard entry in
// ~/.pi/agent/mcp.json, as the parent adapter reads it.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type ChannelParams = { content: string; meta?: Record<string, string> };
type McpEntry = { command?: string; args?: string[]; env?: Record<string, string>; url?: string; type?: string; enabled?: boolean };
type Tool = { name: string; description?: string; inputSchema: { type?: string; properties?: Record<string, unknown> } };
type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type CallResult = { content?: Content[]; structuredContent?: { instructions?: string[] }; isError?: boolean };
type Rpc = { id?: number; method?: string; params?: unknown; result?: any; error?: { message: string } };
type Bindings = { identity?: string; parent?: string };

const SERVER = process.env.GRAYBOARD_MCP_NAME ?? "grayboard";
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
// pi's MCP naming (createMcpToolName), so --tools, --exclude-tools and the
// MCP call renderer treat these as they treat any MCP server's tools.
const PREFIX = `mcp__${SERVER}__`.replace(/[^A-Za-z0-9_]/g, "_");
// pi-subagents carries the launcher's `options.extensionBindings` to the
// child in this variable, canonical JSON keyed by namespace/version.
const BINDINGS_ENV = "PI_SUBAGENT_EXTENSION_BINDINGS";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// Same shape Claude Code shows the model, so the MCP server's instructions apply.
function render({ content, meta = {} }: ChannelParams): string {
  const attrs = Object.entries(meta)
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join("");
  return `<channel source="grayboard"${attrs}>\n${content}\n</channel>`;
}

// The child's bus identity and parent handle, from the launcher's bindings.
// The ambient BUS_IDENTITY is the parent's (the runner inherits it) and is
// never consulted: reusing it is refused (identity_in_use), and a child must
// hold its own name or none.
export function readBindings(env: Record<string, string | undefined>): { identity: string | null; parent: string | null; problem?: string } {
  const raw = env[BINDINGS_ENV];
  if (!raw) return { identity: null, parent: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { identity: null, parent: null, problem: `${BINDINGS_ENV} is not valid JSON` };
  }
  const ns = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>)["grayboard/1"] : undefined;
  if (ns === undefined) return { identity: null, parent: null };
  if (!ns || typeof ns !== "object" || Array.isArray(ns)) return { identity: null, parent: null, problem: `${BINDINGS_ENV} has no "grayboard/1" object` };
  const { identity, parent } = ns as { identity?: unknown; parent?: unknown };
  const bad = (what: string, v: unknown) => `${BINDINGS_ENV} grayboard/1 ${what} "${String(v)}": 1-32 chars, a-z 0-9 _ -`;
  if (identity !== undefined) {
    if (typeof identity !== "string" || !/^[a-z0-9_-]{1,32}$/.test(identity)) return { identity: null, parent: null, problem: bad("identity", identity) };
  }
  if (parent !== undefined && (typeof parent !== "string" || parent.length === 0 || parent.length > 200)) {
    return { identity: null, parent: null, problem: bad("parent", parent) };
  }
  return { identity: typeof identity === "string" ? identity : null, parent: typeof parent === "string" ? parent : null };
}

function readEntry(path: string): McpEntry | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8"))?.mcpServers?.[SERVER];
  } catch {
    return undefined;
  }
}

// The user-level entry grayboard setup writes; the child runs its command.
// A project .pi/mcp.json can only override enabled and exposure of a user
// entry, so per-project env comes from the shell, as for any pi process.
const ENTRY = readEntry(join(AGENT_DIR, "mcp.json"));
const [CMD, ...ARGS] = ENTRY?.command ? [ENTRY.command, ...(ENTRY.args ?? [])] : ["grayboard", "mcp"];
// The child is its own delivery owner: push on, and never the parent's name.
const ENV: Record<string, string | undefined> = { ...process.env, ...ENTRY?.env };
delete ENV.BUS_PUSH;
delete ENV.BUS_IDENTITY;
delete ENV[BINDINGS_ENV];

// The file whose entry pi's own MCP client would run, if one does: its tools
// would collide with these by name (pi warns, and the last registration wins),
// and its process would be a second grayboard for this session. Same merge as
// pi's loadMcpConfig: a trusted project's entry replaces the user one, or,
// without command, url or type, overrides only enabled.
function enabledEntry(ctx: ExtensionContext): string | undefined {
  const user = join(AGENT_DIR, "mcp.json");
  let path = ENTRY ? user : undefined;
  let enabled = ENTRY?.enabled;
  const projectPath = join(ctx.cwd, ".pi", "mcp.json");
  const project = ctx.isProjectTrusted() ? readEntry(projectPath) : undefined;
  if (project && (project.command !== undefined || project.url !== undefined || project.type !== undefined)) {
    path = projectPath;
    enabled = project.enabled;
  } else if (project && ENTRY && project.enabled !== undefined) {
    path = projectPath;
    enabled = project.enabled;
  }
  return path && enabled !== false ? path : undefined;
}

// The tool list `grayboard mcp` serves in the entry's mode, from the installed
// binary on every start so this file and the binary can't drift. A failure
// fails the extension load, and pi lists it among its startup errors.
function loadTools(): Tool[] {
  const at = ARGS.indexOf("mcp");
  if (at < 0) throw new Error(`grayboard: can't find "mcp" in the ${SERVER} entry's args in ${join(AGENT_DIR, "mcp.json")}: ${JSON.stringify(ARGS)}`);
  const args = [...ARGS.slice(0, at), "tools", ...ARGS.slice(at + 1)];
  const r = spawnSync(CMD!, args, { env: ENV, encoding: "utf8", timeout: 15_000 });
  const what = [CMD, ...args].join(" ");
  if (r.error) throw new Error(`grayboard: \`${what}\` failed to run: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`grayboard: \`${what}\` exited ${r.status ?? r.signal}: ${r.stderr.trim()}`);
  try {
    const tools = JSON.parse(r.stdout) as Tool[];
    if (!Array.isArray(tools) || !tools.every((t) => typeof t?.name === "string" && t.inputSchema)) throw new Error("not a tool list");
    return tools;
  } catch (e) {
    throw new Error(`grayboard: \`${what}\` printed no tool list (${(e as Error).message}): ${r.stdout.slice(0, 200)}`);
  }
}

// The tools that differ between two lists, by name, for the post-initialize check.
function toolDiff(registered: Tool[], served: Tool[]): string[] {
  const key = (t: Tool) => JSON.stringify([t.description, t.inputSchema]);
  const a = new Map(registered.map((t) => [t.name, key(t)]));
  const b = new Map(served.map((t) => [t.name, key(t)]));
  return [...new Set([...a.keys(), ...b.keys()])].filter((n) => a.get(n) !== b.get(n)).sort();
}

type Child = {
  proc: ChildProcess;
  ready: Promise<void>;
  call(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<any>;
};

export default function grayboardChild(pi: ExtensionAPI) {
  const tools = loadTools();
  const { identity, parent, problem } = readBindings(process.env);
  let child: Child | undefined;
  let exitReason: string | undefined;
  let instructions: string | undefined;
  let registered = false;
  let refused: string | undefined;

  const deliver = (params: ChannelParams) => {
    // Direct messages, mentions, thread replies: act on them (starts a turn
    // when idle; mid-run, steers in at the next step). Digests and deferred
    // thread replies: context only.
    const contextOnly = params.meta?.kind === "digest" || params.meta?.deferred === "true";
    pi.sendMessage(
      { customType: "grayboard", content: render(params), display: true },
      contextOnly ? undefined : { triggerTurn: true },
    );
  };

  const report = (ctx: ExtensionContext, text: string) => {
    if (ctx.hasUI) ctx.ui.notify(text, "error");
    else console.error(text);
  };

  // Started per session, not at load: until something can receive them,
  // messages wait in grayboard rather than in this process.
  const start = (ctx: ExtensionContext): Child => {
    const proc = spawn(CMD!, ARGS, {
      cwd: ctx.cwd,
      env: { ...ENV, ...(identity ? { BUS_IDENTITY: identity } : {}) },
      stdio: ["pipe", "pipe", "inherit"],
    });
    const pending = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void }>();
    let next = 1;
    let gone: Error | undefined;
    const send = (msg: Record<string, unknown>) => proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
    const call = (method: string, params: Record<string, unknown>, signal?: AbortSignal) =>
      new Promise<any>((resolve, reject) => {
        if (gone) return reject(gone);
        if (signal?.aborted) return reject(new Error("aborted"));
        const id = next++;
        const onAbort = () => {
          pending.delete(id);
          send({ method: "notifications/cancelled", params: { requestId: id, reason: "aborted" } });
          reject(new Error("aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        const settle = <T>(f: (v: T) => void) => (v: T) => {
          signal?.removeEventListener("abort", onAbort);
          f(v);
        };
        pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
        send({ id, method, params });
      });
    const fail = (reason: string) => {
      gone = new Error(reason);
      for (const p of pending.values()) p.reject(gone);
      pending.clear();
      if (child?.proc !== proc) return;
      child = undefined;
      exitReason = reason;
      report(ctx, `${reason}; restart pi to reconnect`);
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
        let msg: Rpc;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.method === "notifications/claude/channel") {
          deliver(msg.params as ChannelParams);
        } else if (msg.id !== undefined && pending.has(msg.id)) {
          const p = pending.get(msg.id)!;
          pending.delete(msg.id);
          if (msg.error) p.reject(new Error(`grayboard: ${msg.error.message}`));
          else p.resolve(msg.result);
        }
      }
    });
    // E.g. no grayboard at the entry's command; unhandled, the error event would crash pi.
    proc.on("error", (e) => fail(`grayboard process failed to start: ${e.message}`));
    proc.on("exit", (code, signal) => fail(`grayboard process exited (${code ?? signal})`));
    // A write after grayboard closed its end (EPIPE); unhandled, the error event would crash the host.
    proc.stdin!.on("error", (e) => fail(`grayboard process stopped reading: ${e.message}`));
    // stdin stays open: grayboard exits when it closes, releasing the name.
    const ready = call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "pi-grayboard-child", version: "1" },
    }).then(async (result: { instructions?: string }) => {
      instructions = result.instructions;
      send({ method: "notifications/initialized" });
      const served = ((await call("tools/list", {})) as { tools: Tool[] }).tools;
      const diff = toolDiff(tools, served);
      if (diff.length) report(ctx, `grayboard: the running grayboard serves different tools than \`grayboard tools\` listed at load: ${diff.join(", ")}`);
    });
    // A call that awaits ready gets the failure; this only keeps an unawaited
    // rejection from crashing pi when no call is waiting.
    ready.catch(() => {});
    return { proc, ready, call };
  };

  const register = () => {
    for (const tool of tools) {
      pi.registerTool({
        name: PREFIX + tool.name,
        label: `${SERVER}/${tool.name}`,
        description: tool.description ?? `MCP tool ${tool.name} from server ${SERVER}`,
        // Plain JSON Schema: pi-ai validates by it when the schema isn't TypeBox.
        parameters: { ...tool.inputSchema, type: tool.inputSchema.type ?? "object", properties: tool.inputSchema.properties ?? {} } as any,
        namespace: { name: `mcp__${SERVER.replace(/-/g, "_")}`, aliases: [SERVER] },
        async execute(_id, params, signal, _onUpdate, ctx) {
          if (exitReason) throw new Error(exitReason);
          child ??= start(ctx);
          const c = child;
          await c.ready;
          const result = (await c.call("tools/call", { name: tool.name, arguments: params ?? {} }, signal)) as CallResult;
          const content = (result.content ?? []).filter((b) => b.type === "text" || b.type === "image");
          if (result.isError && !content.some((b) => b.type === "text" && b.text)) {
            content.push({ type: "text", text: `MCP tool ${SERVER}/${tool.name} returned an error` });
          }
          // A result carries the instructions when the name changed (#182
          // decision 13): bind's, or the next one after a bind whose result
          // was lost (cancelled, timed out) or a lost name. Errors included.
          if (result.structuredContent?.instructions) instructions = result.structuredContent.instructions.join(" ");
          return { content, details: { server: SERVER, tool: tool.name }, ...(result.isError ? { isError: true } : {}) };
        },
      });
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    // Registered once per pi process; /new, /resume and fork start the
    // session again under the same tools.
    if (!registered && !refused) {
      const path = enabledEntry(ctx);
      if (path) {
        refused = `grayboard: the "${SERVER}" MCP server in ${path} is enabled, so pi would run a second grayboard with the same tool names. Set "enabled": false on it (grayboard setup writes it that way); until then the grayboard extension registers no tools and receives nothing.`;
      } else {
        register();
        registered = true;
      }
    }
    if (refused) return report(ctx, refused);
    if (problem) report(ctx, `grayboard child: ${problem}; running unbound (reads only) until it's fixed`);
    exitReason = undefined;
    child ??= start(ctx);
  });

  // pi leaves MCP server instructions out of the prompt for direct tools, and
  // they're what tells the model what a <channel> message is. A prompt sent
  // as pi starts can beat the child's initialize; the first turn waits for it.
  // The child's own section says who it reports to: the launcher posts a
  // delegation's result in the request's thread (a thread is only visible to
  // its participants, and the child isn't one — #244's threading note), so the
  // child's own report goes to the parent handle by DM.
  pi.on("before_agent_start", async (event) => {
    await child?.ready.catch(() => {});
    if (instructions) event.systemPromptOptions.sections.grayboard = instructions;
    if (parent) {
      event.systemPromptOptions.sections["grayboard-child"] =
        `You are a subagent of "${parent}" on the grayboard bus. Report progress and results to ${parent} by DM (dm_send).` +
        (identity ? ` You hold the bus name "${identity}" and receive pushes directly.` : ` You have no bus name; bind one with bind (create: true) to send and receive.`);
    }
  });

  // Also fires before /new, /resume, and fork, which start the session again:
  // wait for the child to exit so the next one can take the name.
  pi.on("session_shutdown", async () => {
    const c = child;
    if (!c) return;
    child = undefined;
    const { proc } = c;
    const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    proc.stdin!.end();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
    if (proc.exitCode === null) proc.kill();
  });
}
