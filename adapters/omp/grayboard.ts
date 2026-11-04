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
// Install: grayboard setup bundles this into <agentDir>/extensions/grayboard.ts.
// The command and env come from the mcpServers.grayboard entry in the user-level
// <agentDir>/mcp.json, which setup writes with "enabled": false: omp's own
// client then runs none, and the disabled entry still shadows a same-named
// entry omp ranks lower (Claude Code's user config, a repo's .mcp.json).
import { getAgentDir, settings, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { expandEnvVarsDeep } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { extractUriScheme } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { cfgMcpEnableProjectConfig } from "@oh-my-pi/pi-coding-agent/mcp/settings";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { render, wakes, type ChannelParams } from "../hosted-core/src/channel.ts";
import { instructionHooks } from "../pi-family/omp-instructions.ts";

type McpEntry = { command?: string; args?: string[]; env?: Record<string, string>; cwd?: string };
type Tool = { name: string; description?: string; inputSchema: { type?: string; properties?: Record<string, unknown> }; _meta?: Record<string, unknown> };
type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type Config = { cmd: string; args: string[]; env: Record<string, string | undefined>; cwd?: string; entryPath: string; protocol: boolean };
type Child = {
  proc: ChildProcess;
  ready: Promise<void>;
  epoch: number;
  call(method: string, params: object, signal?: AbortSignal): Promise<unknown>;
};

const SERVER = process.env.GRAYBOARD_MCP_NAME ?? "grayboard";
// omp's MCP tool naming (mintMCPToolName in its tool-bridge.ts).
const PREFIX = `mcp__${SERVER.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "") || "server"}_`;
// The `_meta` key naming a subagent's call (GRAYBOARD_AGENT_META, src/shared/session_meta.ts).
const AGENT_META = "io.github.nolnoch.grayboard/agent";
// omp gives session_shutdown handlers 2 s; the grayboard process gets most of it to end its session.
const EXIT_WAIT_MS = 1_500;
// An unexpected exit restarts the grayboard process after each delay in turn,
// as omp's MCP manager restarted its stdio servers; one more exit gives up.
// A process that ran STABLE_MS before exiting starts the count over.
const RESTART_DELAYS_MS = [0, 1_000, 5_000];
const STABLE_MS = 60_000;

// A subagent serves grayboard's tools only for the top-level session that runs
// the grayboard process. One omp process can run several top-level sessions
// (ACP), each with its own runtime and agent id; a subagent of another would
// act as that session's names (#470), so it gets none.
const NOT_OWNERS = "grayboard: this subagent's top-level session doesn't run grayboard (another top-level session in this omp process does), so it gets no grayboard tools";

// Each runtime's agent as omp reports it (`ctx.agent`), by agent id: entries
// are never removed, since omp keeps a finished subagent revivable for its idle
// TTL and a nested one revived after its parent's run ended must still reach
// its root. Unlike hosted omp's ancestry walk, this one checks the owning
// runtime and ambiguous ACP main ids, not just the root's session id.
type Agent = { main: boolean; parent?: string; runtime: ExtensionAPI };

// What every runtime in this omp process shares: each subagent's runtime
// loads its own copy of this module, so module state would be per runtime.
type Shared = {
  config?: Config;
  tools?: Tool[];
  // The main runtime that runs the grayboard process, and its verdict: the
  // refusal text, or undefined when it serves the tools. Its subagents follow it.
  owner?: ExtensionAPI;
  verdict?: Promise<string | undefined>;
  agents?: Map<string, Agent>;
  // Every live top-level runtime, and its agent id.
  mains?: Map<ExtensionAPI, string>;
  child?: Child;
  ownerToken?: string;
  selected?: { id: string; epoch: number; ctx: ExtensionContext };
  epoch?: number;
  transition?: Promise<void>;
  calls?: Set<Promise<unknown>>;
  // Consecutive restarts, and the one waiting to start.
  restarts?: number;
  restart?: Promise<void>;
  exitReason?: string;
  instructions?: string;
};
const KEY = Symbol.for("io.github.nolnoch.grayboard/omp-local");
const shared = ((globalThis as Record<symbol, unknown>)[KEY] ??= {}) as Shared;

// Whether a subagent belongs to the top-level session that runs grayboard:
// its chain of parentIds reaches the owner's agent, and no other live
// top-level session has that agent id (then the chain can't tell them apart).
function ownersSubagent(parent: string | undefined): boolean {
  const agents = shared.agents ?? new Map<string, Agent>();
  let id = parent;
  for (let hops = 0; id !== undefined && hops <= agents.size; hops++) {
    const agent = agents.get(id);
    if (!agent) return false;
    if (agent.main) return agent.runtime === shared.owner && [...(shared.mains?.values() ?? [])].filter((m) => m === id).length === 1;
    id = agent.parent;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The child's command, args, env and cwd, from the user-level entry only: a
// project's config (a cloned repo's) never chooses what this extension runs.
// `${VAR}` and `${VAR:-default}` expand as omp's own loader expands them
// (expandEnvVarsDeep, its discovery/builtin.ts). The entry's BUS_PUSH=off is
// for omp's client, were it ever enabled; this process is the delivery owner.
// BUS_HARNESS=omp has grayboard read a repo's .omp/mcp.json name pin, enabled
// or not, and say "restart omp" where it would say /mcp reconnect
// (src/shared/identity.ts pinnedIdentity, src/shared/toolguard.ts).
function config(agentDir: string): Config {
  const entryPath = join(agentDir, "mcp.json");
  let entry: McpEntry | undefined;
  try {
    const servers: unknown = JSON.parse(readFileSync(entryPath, "utf8"))?.mcpServers;
    if (isRecord(servers) && isRecord(servers[SERVER])) entry = expandEnvVarsDeep(servers[SERVER]) as McpEntry;
  } catch {
    entry = undefined;
  }
  const [cmd, ...args] = typeof entry?.command === "string" ? [entry.command, ...(entry.args ?? [])] : ["grayboard", "mcp"];
  const env: Record<string, string | undefined> = { ...process.env, ...entry?.env };
  delete env.BUS_PUSH;
  env.BUS_HARNESS = "omp";
  // Modern mcp always runs locally, including on a signed-in machine;
  // hosted extensions have a separate entry. Never send this protocol to an
  // explicitly hosted command retained in a user's old entry.
  const mode = args.findIndex(arg => arg === "--mode");
  const local = !args.some(arg => arg === "--server" || arg.startsWith("--server=") || (arg.startsWith("--mode=") && arg !== "--mode=local")) && (mode < 0 || args[mode + 1] === "local");
  const protocol = local && env.BUS_PARENT_SESSION === undefined && env.BUS_SESSION_KEY === undefined && env.BUS_HUMAN !== "1";
  return { cmd: cmd!, args, env, ...(typeof entry?.cwd === "string" ? { cwd: entry.cwd } : {}), entryPath, protocol };
}

// The tool list `grayboard mcp` serves in the entry's mode, from the installed
// binary, so this file and the binary can't drift. A failure fails the
// extension load, and omp reports it.
function loadTools({ cmd, args: entryArgs, env, cwd, entryPath }: Config): Tool[] {
  const at = entryArgs.indexOf("mcp");
  if (at < 0) throw new Error(`grayboard: can't find "mcp" in the ${SERVER} entry's args in ${entryPath}: ${JSON.stringify(entryArgs)}`);
  const args = [...entryArgs.slice(0, at), "tools", ...entryArgs.slice(at + 1)];
  const r = spawnSync(cmd, args, { env, cwd, encoding: "utf8", timeout: 15_000 });
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

// A launcher's argv unwrapped to the program it runs: a package runner
// (bunx, npx, pnpx, `bun x`, `npm exec`, `pnpm dlx`, `yarn dlx`) and its
// flags, `env` and its assignments, `exec`, or a shell's `-c` line.
function unwrap(argv: string[]): string[] {
  const [head = "", ...rest] = argv;
  const name = basename(head).replace(/\.exe$/i, "");
  if (["sh", "bash", "zsh", "dash"].includes(name)) {
    const line = rest[rest.indexOf("-c") + 1];
    return rest.includes("-c") && line ? unwrap(line.trim().split(/\s+/)) : argv;
  }
  if (name === "exec") return unwrap(rest);
  if (name === "env") return unwrap(rest.filter((a, i) => !rest.slice(0, i + 1).every((b) => b.includes("=") || b.startsWith("-"))));
  const runner = ["bunx", "npx", "pnpx"].includes(name) ? 1
    : (name === "bun" && rest[0] === "x") || (["npm", "pnpm"].includes(name) && ["exec", "x", "dlx"].includes(rest[0] ?? "")) || (name === "yarn" && rest[0] === "dlx") ? 2
    : 0;
  if (!runner) return argv;
  const tail = argv.slice(runner);
  while (tail[0]?.startsWith("-")) tail.shift();
  return unwrap(tail);
}

// Whether an MCP server runs `grayboard mcp`: a stdio server whose program,
// past any launcher, is a grayboard binary or package with an `mcp`
// argument, or whose argv up to `mcp` is this extension's own
// (`bun <checkout>/src/cli/main.ts` from source).
function runsGrayboard(server: { type?: string; command?: string; args?: string[] }, own: Config): boolean {
  if ((server.type !== undefined && server.type !== "stdio") || !server.command) return false;
  const argv = unwrap([server.command, ...(server.args ?? [])]);
  const at = argv.indexOf("mcp");
  if (at < 1) return false;
  if (/^grayboard(@[^/]*)?(\.exe)?$/i.test(basename(argv[0]!))) return true;
  const ownArgv = [own.cmd, ...own.args];
  return at === ownArgv.indexOf("mcp") && argv.slice(0, at).every((p, i) => p === ownArgv[i]);
}

// The refusal when omp itself would serve a grayboard beside this one, as
// omp's own loader resolves its config (every source, priority, same-name
// shadowing, disabledServers, enabledServers and mcp.enableProjectConfig): an
// enabled server named "grayboard", whatever it runs (pi's name rule: its
// tools take this extension's names), or one under any other name that runs
// `grayboard mcp` (a second delivery owner). The disabled user entry shadows
// only a same-named server omp ranks lower, so a repo's .omp/mcp.json entry,
// or one under another name, can still run. Undefined when there's none.
async function secondGrayboard(cwd: string, own: Config): Promise<string | undefined> {
  const meanwhile = "until then the grayboard extension registers no tools and receives nothing";
  try {
    const { configs, sources } = await loadAllMCPConfigs(cwd, { enableProjectConfig: cfgMcpEnableProjectConfig.get(settings) });
    const found = Object.entries(configs).find(([name, server]) => name === SERVER || runsGrayboard(server, own));
    if (!found) return undefined;
    const [name, server] = found;
    const source = sources[name];
    const why = name === SERVER ? `is named "${SERVER}", the name this extension serves its tools under` : "runs `grayboard mcp`";
    // The pin grayboard reads itself under omp: the repo's .omp/mcp.json grayboard entry's.
    const pin = "env" in server ? server.env?.BUS_IDENTITY : undefined;
    const pins = name === "grayboard" && source?.level === "project" && basename(dirname(source.path)) === ".omp" && basename(source.path) === "mcp.json" && pin;
    const keeps = pins ? ` (disabled, its BUS_IDENTITY "${pin}" still pins this session's name)` : "";
    return `grayboard: the "${name}" MCP server in ${source?.path ?? "omp's MCP config"} is enabled and ${why}, so omp would run it beside this extension's grayboard. Set "enabled": false on it${keeps} or remove it (grayboard setup writes the user-level "${SERVER}" entry disabled); ${meanwhile}.`;
  } catch (e) {
    return `grayboard: couldn't read omp's MCP config to check for a second grayboard (${(e as Error).message}); ${meanwhile}.`;
  }
}

// omp's MCP client hands a server a file-backed internal URL argument
// (local://, artifact://, agent://, skill://, …) as the path behind it
// (resolveOutboundUrlArgs, its mcp/tool-bridge.ts); this does the same through
// omp's own router, so an attachment like local://report.md still reaches
// grayboard as a file it can read.
async function resolveUrls(value: unknown, ctx: ExtensionContext): Promise<unknown> {
  if (typeof value === "string") {
    if (!extractUriScheme(value)) return value;
    const router = InternalUrlRouter.instance();
    const url = router.normalize(value);
    if (!router.canHandle(url)) return value;
    const scheme = extractUriScheme(url);
    if (!scheme || router.spec(scheme)?.backing !== "file") return value;
    return (await router.locate(url, { cwd: ctx.cwd, settings, localProtocolOptions: ctx.localProtocolOptions })) ?? value;
  }
  if (Array.isArray(value)) return Promise.all(value.map((v) => resolveUrls(v, ctx)));
  if (isRecord(value)) return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await resolveUrls(v, ctx)])));
  return value;
}

export default function grayboard(pi: ExtensionAPI) {
  const own = (shared.config ??= config(getAgentDir()));
  const tools = (shared.tools ??= loadTools(own));
  let registered = false;
  const hooks = instructionHooks<ExtensionContext>({
    instructions: () => shared.instructions,
    logger: pi.logger,
    show: (message, ctx) => {
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
      else console.error(message);
    },
  });

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
    const wake = wakes(true, params.meta);
    pi.sendMessage(
      { customType: "grayboard", content: render(params, "grayboard"), display: true, attribution: "agent" },
      wake ? { deliverAs: "aside", triggerTurn: true } : { deliverAs: "nextTurn" },
    );
  };

  const associate = async (call: Child["call"], selection: NonNullable<Shared["selected"]>, owner: string) => {
    const result = await call("grayboard/session", { owner, epoch: selection.epoch, session: selection.id });
    if (!isRecord(result) || typeof result.id !== "string" || result.session !== selection.id || result.epoch !== selection.epoch || !Array.isArray(result.instructions) || !result.instructions.every(value => typeof value === "string")) {
      throw new Error("grayboard: invalid session transition acknowledgement");
    }
    if (shared.owner !== pi || shared.ownerToken !== owner || shared.selected !== selection) return;
    shared.instructions = result.instructions.join(" ");
    await call("grayboard/session/ready", { owner, epoch: selection.epoch });
  };

  // Calls stay concurrent; a selection closes admission synchronously, waits
  // outgoing calls, then rotates the root in the retained MCP process.
  const select = (ctx: ExtensionContext): Promise<void> => {
    if (ctx.agent.kind !== "main" || shared.owner !== pi || !registered) return Promise.resolve();
    const id = ctx.sessionManager.getSessionId();
    if (shared.selected?.id === id) { shared.selected.ctx = ctx; return shared.transition ?? Promise.resolve(); }
    const selection = { id, epoch: shared.epoch = (shared.epoch ?? 0) + 1, ctx };
    shared.selected = selection;
    const owner = shared.ownerToken!;
    const previous = shared.transition;
    const outgoing = [...(shared.calls ?? [])];
    const transition = (previous ?? Promise.resolve()).catch(() => {}).then(async () => {
      await Promise.allSettled(outgoing);
      if (shared.owner !== pi || shared.ownerToken !== owner || shared.selected !== selection) return;
      if (!shared.child && shared.restart) await shared.restart;
      const c = shared.child;
      if (!c) throw new Error(shared.exitReason ?? "grayboard: no grayboard process runs in this omp process");
      await c.ready;
      if (shared.owner !== pi || shared.ownerToken !== owner || shared.selected !== selection || shared.child !== c) return;
      if (own.protocol && c.epoch !== selection.epoch) await associate(c.call, selection, owner);
    });
    shared.transition = transition;
    transition.catch(() => {});
    return transition;
  };

  const currentChild = async (): Promise<Child> => {
    for (;;) {
      const transition = shared.transition;
      try { await transition; } catch (error) { if (transition === shared.transition) throw error; }
      if (!shared.child && shared.restart) await shared.restart;
      const c = shared.child;
      if (!c) throw new Error(shared.exitReason ?? "grayboard: no grayboard process runs in this omp process");
      await c.ready;
      if (c === shared.child && transition === shared.transition) return c;
    }
  };

  // Started by the main session, not at load: until something can receive
  // them, messages wait in grayboard rather than in this process.
  const start = (ctx: ExtensionContext): Child => {
    const startedAt = Date.now();
    const owner = shared.ownerToken!;
    const selection = shared.selected!;
    const env = { ...own.env, BUS_HARNESS_SESSION: selection.id, BUS_ADAPTER_OWNER: own.protocol ? owner : undefined };
    const proc = spawn(own.cmd, own.args, { cwd: own.cwd ?? selection.ctx.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
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
    // An unexpected exit fails the calls in flight with its reason, then
    // restarts the process (RESTART_DELAYS_MS); it takes its names back from
    // its name record, as a restart under the same harness does.
    const fail = (reason: string) => {
      if (gone) return;
      gone = new Error(reason);
      for (const p of pending.values()) p.reject(gone);
      pending.clear();
      if (shared.child?.proc !== proc) return;
      shared.child = undefined;
      shared.transition = undefined;
      shared.instructions = undefined;
      // EPIPE can happen while the child is still alive. Stop it before a
      // replacement, so it can't linger as a second delivery owner (#580).
      if (proc.exitCode === null && proc.signalCode === null) proc.kill();
      if (Date.now() - startedAt >= STABLE_MS) shared.restarts = 0;
      const attempt = shared.restarts ?? 0;
      if (shared.owner !== pi || attempt >= RESTART_DELAYS_MS.length) {
        shared.exitReason = reason;
        report(ctx, `${reason}${attempt ? ` after ${attempt} restarts` : ""}; restart omp to reconnect`);
        return;
      }
      shared.restarts = attempt + 1;
      shared.exitReason = `${reason}; restarting it`;
      pi.logger.warn(`${reason}; restarting it (${attempt + 1} of ${RESTART_DELAYS_MS.length})`);
      shared.restart = Bun.sleep(RESTART_DELAYS_MS[attempt]!).then(() => {
        shared.restart = undefined;
        if (shared.owner === pi && shared.ownerToken === owner && !shared.child && shared.selected) shared.child = start(shared.selected.ctx);
      });
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
          const selected = shared.selected;
          let accepted = shared.owner === pi && shared.ownerToken === owner && shared.child?.proc === proc && !!selected &&
            selected.ctx.sessionManager.getSessionId() === selected.id &&
            (!meta.grayboard_session || meta.grayboard_session === selected.id) &&
            (!meta.grayboard_epoch || meta.grayboard_epoch === String(selected.epoch));
          // Receipts bypass the transition barrier: MCP waits for them before
          // ending the outgoing root. A rejected delivery remains durable.
          try { if (accepted) deliver({ content: params.content, meta }); }
          catch (error) { accepted = false; report(shared.selected?.ctx ?? ctx, `grayboard: couldn't deliver a channel notification: ${String(error)}`); }
          if (meta.grayboard_delivery) void call("grayboard/delivery", { owner, token: meta.grayboard_delivery, accepted }).catch(error => pi.logger.error(String(error)));
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
      if (shared.owner === pi && shared.ownerToken === owner && shared.selected === selection && isRecord(init) && typeof init.instructions === "string") shared.instructions = init.instructions;
      send({ method: "notifications/initialized" });
      const listed = await call("tools/list", {});
      const served = isRecord(listed) && Array.isArray(listed.tools) ? listed.tools : [];
      const diff = toolDiff(tools, served);
      if (diff.length) report(ctx, `grayboard: the running grayboard serves different tools than \`grayboard tools\` listed at load: ${diff.join(", ")}`);
      if (own.protocol && shared.owner === pi && shared.ownerToken === owner && shared.selected === selection) await associate(call, selection, owner);
    });
    // A call that awaits ready gets the failure; this only keeps an unawaited
    // rejection from crashing omp when no call is waiting.
    ready.catch(() => {});
    return { proc, ready, call, epoch: selection.epoch };
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
          const sub = ctx.agent.kind !== "main";
          // Checked per call too: a top-level session sharing the owner's agent id may have started since.
          if (sub && !ownersSubagent(ctx.agent.parentId)) throw new Error(NOT_OWNERS);
          const args = await resolveUrls(isRecord(params) ? params : {}, ctx);
          let c: Child;
          let selection: Shared["selected"];
          let transition: Shared["transition"];
          do {
            selection = shared.selected;
            transition = shared.transition;
            c = await currentChild();
          } while (selection !== shared.selected || transition !== shared.transition || c !== shared.child);
          if ((!sub && shared.owner !== pi) || (sub && !ownersSubagent(ctx.agent.parentId))) throw new Error(NOT_OWNERS);
          if (!sub && selection?.id !== ctx.sessionManager.getSessionId()) throw new Error("grayboard: the selected omp conversation changed before this call");
          const call = c.call("tools/call", {
            name: tool.name,
            arguments: args,
            ...(sub ? { _meta: { [AGENT_META]: ctx.sessionManager.getSessionId() } } : {}),
          }, signal);
          (shared.calls ??= new Set()).add(call);
          const result = callResult(await call.finally(() => shared.calls!.delete(call)));
          if (result.isError && !result.content.some((b) => b.type === "text" && b.text)) {
            result.content.push({ type: "text", text: `MCP tool ${SERVER}/${tool.name} returned an error` });
          }
          // A main session's result carries the instructions when its names
          // changed (#182 decision 13): bind's, the next one's after a bind
          // whose result was lost, or a lost name's. A child's never does.
          if (!sub && shared.owner === pi && shared.child === c && shared.selected === selection && result.instructions) shared.instructions = result.instructions.join(" ");
          return { content: result.content, details: { server: SERVER, tool: tool.name }, ...(result.isError ? { isError: true as const } : {}) };
        },
      });
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    // Every runtime records its agent before it can spawn one, so a subagent finds its root.
    (shared.agents ??= new Map()).set(ctx.agent.id, { main: ctx.agent.kind === "main", ...(ctx.agent.parentId !== undefined ? { parent: ctx.agent.parentId } : {}), runtime: pi });
    if (ctx.agent.kind !== "main") {
      // A subagent of the session that runs grayboard serves its tools; when
      // that session's grayboard was refused, its notice already said why.
      if (registered || !shared.verdict || (await shared.verdict) !== undefined) return;
      if (ownersSubagent(ctx.agent.parentId)) register();
      else report(ctx, NOT_OWNERS);
      return;
    }
    (shared.mains ??= new Map()).set(pi, ctx.agent.id);
    if (shared.owner === pi) return;
    // One grayboard process per omp process: a second top-level session in
    // it (ACP serves several) would act as the first's names.
    if (shared.owner) {
      const ownerRefused = shared.verdict ? await shared.verdict : undefined;
      return report(ctx, ownerRefused
        ? "grayboard: the first top-level session in this omp process didn't start grayboard (its notice says why); this one registers no grayboard tools and receives nothing"
        : "grayboard: another top-level session in this omp process runs grayboard; this one and its subagents register no grayboard tools and receive nothing");
    }
    shared.owner = pi;
    shared.ownerToken = randomUUID();
    shared.verdict = secondGrayboard(ctx.cwd, own);
    const refused = await shared.verdict;
    if (refused) return report(ctx, refused);
    register();
    shared.exitReason = undefined;
    shared.restarts = 0;
    shared.selected = { id: ctx.sessionManager.getSessionId(), epoch: shared.epoch = (shared.epoch ?? 0) + 1, ctx };
    shared.transition = undefined;
    shared.child = start(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => { await select(ctx); });
  pi.on("session_branch", async (_event, ctx) => {
    if (shared.selected?.id !== ctx.sessionManager.getSessionId()) await select(ctx);
  });

  // The instructions tell the model what a <channel> message is; only the
  // main session receives any, so a subagent gets none. A prompt sent as omp
  // starts can beat the grayboard process's initialize; the first turn waits.
  pi.on("before_agent_start", async (event, ctx) => {
    if (!registered || ctx.agent.kind !== "main" || shared.owner !== pi) return undefined;
    await currentChild();
    return hooks.beforeAgentStart(event);
  });

  // Share hosted omp's per-request plan and payload rewrite (#441): a
  // push-started turn after bind sees the current names, and a rebuilt base
  // prompt gets them as a hidden message, last for Anthropic's cache boundary.
  pi.on("context", async (event, ctx) => {
    if (!registered || ctx.agent.kind !== "main" || shared.owner !== pi) return undefined;
    await currentChild();
    return hooks.context(event, ctx);
  });
  pi.on("before_provider_request", async (event, ctx) => {
    if (!registered || ctx.agent.kind !== "main" || shared.owner !== pi) return undefined;
    await currentChild();
    return hooks.beforeProviderRequest(event, ctx);
  });

  // omp keeps the main runtime across /new, /resume and /fork, so this runs
  // once, at quit: close the process's stdin and give it time to end its session.
  pi.on("session_shutdown", async () => {
    shared.mains?.delete(pi);
    if (shared.owner !== pi) return;
    const c = shared.child;
    shared.owner = undefined;
    shared.ownerToken = undefined;
    shared.selected = undefined;
    shared.transition = undefined;
    shared.instructions = undefined;
    shared.verdict = undefined;
    shared.child = undefined;
    shared.restart = undefined;
    shared.exitReason = "grayboard: the main omp session ended";
    if (!c) return;
    const exited = Promise.withResolvers<void>();
    c.proc.once("exit", () => exited.resolve());
    c.proc.stdin!.end();
    await Promise.race([exited.promise, Bun.sleep(EXIT_WAIT_MS)]);
    if (c.proc.exitCode === null && c.proc.signalCode === null) c.proc.kill();
  });
}
