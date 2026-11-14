// grayboard adapter for opencode.
//
// opencode drops MCP notifications. So this plugin runs the session's one
// `grayboard mcp` itself and serves its tools: it registers each tool
// `grayboard tools` lists under the name opencode's MCP client would give it
// (grayboard_<tool>) and proxies every call to that child. The child is the
// one grayboard process: it holds the bus name (bind moves it), the wakeup
// socket (local) or live connection (server), and moves the read cursors, as
// the MCP server does under Claude Code and omp. The plugin delivers the
// child's channel notifications into the session and adds its instructions to
// the system prompt.
//
// Install: copy into ~/.config/opencode/plugin/ (grayboard setup does this).
// The command and environment come from the `mcp.grayboard` entry in
// ~/.config/opencode/opencode.json, which setup writes with "enabled": false
// so opencode's MCP client doesn't serve a second set of the same tools. Only
// that user-level entry is run: a project's opencode.json (a cloned repo's)
// can disable or enable the entry, never choose the command.
// `@opencode-ai/plugin` is the package opencode installs into its config
// directory for local plugins; its `tool.schema` is the zod opencode reads.
import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

type ChannelParams = { content: string; meta?: Record<string, string> };
type McpEntry = { type?: string; command?: string[]; environment?: Record<string, string>; enabled?: boolean };
type JsonSchema = {
  type?: string;
  description?: string;
  enum?: unknown[];
  exclusiveMinimum?: number;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
};
type Tool = { name: string; description?: string; inputSchema: JsonSchema };
type CallResult = { content?: { type: string; text?: string }[]; structuredContent?: { instructions?: string[] }; isError?: boolean };
type Rpc = { id?: number; method?: string; params?: unknown; result?: any; error?: { message: string } };

const SERVER = process.env.GRAYBOARD_MCP_NAME ?? "grayboard";
const CONFIG = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode", "opencode.json");
// The same harness-asserted subagent key used by the local omp adapter.
const AGENT_META = "io.github.nolnoch.grayboard/agent";
const z = tool.schema;
const AssociationSchema = z.object({ id: z.string(), session: z.string(), epoch: z.number(), instructions: z.array(z.string()) });
// Match pi and omp's local restart policy. Setup embeds this raw file, so
// the lifecycle stays here rather than importing a runtime helper.
const RESTART_DELAYS_MS = [0, 1_000, 5_000];
const STABLE_MS = 60_000;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// Same shape Claude Code shows the model, so the MCP server's instructions apply.
function render({ content, meta = {} }: ChannelParams): string {
  const attrs = Object.entries(meta)
    .filter(([key]) => !["grayboard_session", "grayboard_epoch", "grayboard_delivery"].includes(key))
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join("");
  // A body's `<channel` or `</channel` keeps its `<` escaped, so it can't close
  // the element or forge another one (#433, #435).
  return `<channel source="grayboard"${attrs}>\n${content.replace(/<(?=\s*\/?\s*channel)/gi, "&lt;")}\n</channel>`;
}

function resultText(result: CallResult, toolName: string): string {
  const text = (result.content ?? []).flatMap((b) => (b.type === "text" && b.text ? [b.text] : [])).join("\n");
  if (result.isError) throw new Error(text || `MCP tool ${SERVER}/${toolName} returned an error`);
  return text;
}

// Local MCP's existing child whoami supplies the live root and primary. A
// child gets none of initialize's root-only inbox, holds or channel guidance.
function childInstructions(result: CallResult): string {
  const who: unknown = JSON.parse(resultText(result, "whoami"));
  if (!who || typeof who !== "object" || !("child" in who) || who.child !== true || !("id" in who) || typeof who.id !== "string" || !("root" in who) || typeof who.root !== "string" || !("primary" in who) || typeof who.primary !== "string") {
    throw new Error("grayboard: child whoami returned no child identity");
  }
  return `You are a subagent of session ${who.root} on the grayboard bus. You send, post and claim under your root's addresses (currently ${JSON.stringify(who.primary)}), and your writes show your child ID ${who.id} as via. bind and unbind are the root's; call them from the root session. Mail and board pushes never reach you. dm_thread reads a thread you wrote; board_read reads without marking anything read. Your root owns dm_inbox, dm_ack and board_subscribe, so those calls are refused. Your child session ends with its root.`;
}

// JSON Schema to zod, for the shapes grayboard's tools use. Anything else
// fails the plugin load rather than reaching the model as something looser.
function toZod(s: JsonSchema, at: string): any {
  let out: any;
  if (s.anyOf) {
    const [a, b, ...rest] = s.anyOf.map((x, i) => toZod(x, `${at}|${i}`));
    if (!b) throw new Error(`grayboard: ${at}: anyOf needs two or more schemas`);
    out = z.union([a, b, ...rest]);
  } else if (s.enum) {
    if (s.type !== "string" || !s.enum.every((v) => typeof v === "string")) throw new Error(`grayboard: ${at}: only string enums are supported`);
    out = z.enum(s.enum as [string, ...string[]]);
  } else if (s.type === "string") out = z.string();
  else if (s.type === "number" || s.type === "integer") {
    out = s.type === "integer" ? z.number().int() : z.number();
    if (typeof s.exclusiveMinimum === "number") out = out.gt(s.exclusiveMinimum);
  }
  else if (s.type === "boolean") out = z.boolean();
  else if (s.type === "array") {
    if (!s.items) throw new Error(`grayboard: ${at}: array without items`);
    out = z.array(toZod(s.items, `${at}[]`));
  } else if (s.type === "object") {
    // A property-less object (bind's meta, peer_list's match) is a free map
    // the bus validates; z.object({}) would strip every key.
    out = s.properties ? z.object(toShape(s, at)) : z.record(z.string(), z.unknown());
  }
  else throw new Error(`grayboard: ${at}: unsupported schema ${JSON.stringify(s)}`);
  return s.description ? out.describe(s.description) : out;
}

// A tool's input schema as the raw shape opencode's tool record takes.
function toShape(s: JsonSchema, at: string): Record<string, any> {
  if (s.type !== undefined && s.type !== "object") throw new Error(`grayboard: ${at}: input schema must be an object`);
  const required = new Set(s.required ?? []);
  return Object.fromEntries(
    Object.entries(s.properties ?? {}).map(([k, v]) => {
      const field = toZod(v, `${at}.${k}`);
      return [k, required.has(k) ? field : field.optional()];
    }),
  );
}

function userEntry(): McpEntry | undefined {
  try {
    return JSON.parse(readFileSync(CONFIG, "utf8"))?.mcp?.[SERVER];
  } catch {
    return undefined;
  }
}

function commandOf(entry: McpEntry | undefined): { cmd: string; args: string[]; env: Record<string, string | undefined> } {
  const [cmd, ...args] = entry?.command?.length ? entry.command : ["grayboard", "mcp"];
  const env: Record<string, string | undefined> = { ...process.env, ...entry?.environment };
  delete env.BUS_PUSH;
  return { cmd: cmd!, args, env };
}

// This V1 entry runs the local CLI even on a signed-in machine. Only
// ordinary roots use association; runners/keyed/human entries retain their
// established lifecycle, and legacy server commands retain their refusal.
function localEntry(entry: McpEntry | undefined): boolean {
  const { args, env } = commandOf(entry);
  const at = args.indexOf("--mode");
  const mode = args.find((arg) => arg.startsWith("--mode="))?.slice(7) ?? (at >= 0 ? args[at + 1] : undefined);
  return mode !== "server" && !args.some((arg) => arg === "--server" || arg.startsWith("--server="))
    && env.BUS_PARENT_SESSION === undefined && env.BUS_SESSION_KEY === undefined && env.BUS_HUMAN !== "1";
}

// The tool list `grayboard mcp` serves in the entry's mode, from the installed
// binary on every start so this file and the binary can't drift. Plugin init
// gets no config, so this reads the user-level entry setup writes; a failure
// throws from init, which fails the plugin load.
function loadTools(entry: McpEntry | undefined): Tool[] {
  const { cmd, args: mcpArgs, env } = commandOf(entry);
  const at = mcpArgs.indexOf("mcp");
  if (at < 0) throw new Error(`grayboard: can't find "mcp" in the ${SERVER} entry's command in ${CONFIG}: ${JSON.stringify(entry?.command)}`);
  const args = [...mcpArgs.slice(0, at), "tools", ...mcpArgs.slice(at + 1)];
  const r = spawnSync(cmd, args, { env, encoding: "utf8", timeout: 15_000 });
  const what = [cmd, ...args].join(" ");
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
  call(method: string, params: object, signal?: AbortSignal): Promise<any>;
  associate(session: string, selection: number): Promise<void>;
  stop(): Promise<void>;
};

// A backoff or initialize must not hold an aborted tool open.
function waitReady(ready: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return ready;
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  const waiter = Promise.withResolvers<void>();
  const onAbort = () => waiter.reject(new Error("aborted"));
  signal.addEventListener("abort", onAbort, { once: true });
  return Promise.race([ready, waiter.promise]).finally(() => signal.removeEventListener("abort", onAbort));
}

export const GrayboardPlugin: Plugin = async ({ client, directory }) => {
  // The user-level entry: the only one whose command and environment run.
  const entry = userEntry();
  const tools = loadTools(entry);
  let child: Child | undefined;
  let exitReason: string | undefined;
  let restarts = 0;
  let restart: { ready: Promise<void>; cancel(): void } | undefined;
  const stopping = new Set<Promise<void>>();
  let closed = false;
  let generation = 0;
  let instructions: string | undefined;
  let refused: string | undefined;
  // The root session to deliver into: the one the user last wrote in.
  let target: string | undefined;
  let requestedTarget: string | undefined;
  let transition = Promise.resolve();
  let transitionError: Error | undefined;
  const activeCalls = new Set<Promise<CallResult>>();
  const owner = randomUUID();
  const deliveryMarker = owner.replace(/-/g, "");
  let deliverySequence = 0;
  const local = localEntry(entry);
  let epoch = 0;
  let rootEvent = 0;
  let selectedEvent = 0;
  // Events cover newly created sessions; lookup also covers resumed children
  // and calls that beat the asynchronous session.created event.
  const parents = new Map<string, string | undefined>();
  // One delivery at a time, in order.
  let queue = Promise.resolve();

  const log = (level: "info" | "warn" | "error", message: string) =>
    client.app.log({ body: { service: "grayboard", level, message } }).catch(() => {});
  const report = (message: string, variant: "warning" | "error" = "error") => {
    log(variant === "warning" ? "warn" : "error", message);
    client.tui.showToast({ body: { message, variant } }).catch(() => {});
  };

  const deliver = (params: ChannelParams, recipient: string | undefined, receipt: (accepted: boolean) => Promise<void>, selection: number) => {
    queue = queue.then(async () => {
      if (!recipient || closed || (local && selection !== generation)) { await receipt(false); return; }
      const contextOnly = params.meta?.kind === "digest" || params.meta?.deferred === "true";
      // Capture the outgoing root when stdout arrives, not when this queued
      // SDK request eventually runs after a root selection.
      let accepted = false;
      try {
        const messageID = `msg_${Date.now().toString(16).padStart(12, "0")}${deliveryMarker}${(++deliverySequence).toString(16).padStart(8, "0")}`;
        const r = await client.session.promptAsync({
          path: { id: recipient },
          body: { messageID, parts: [{ type: "text", text: render(params) }], ...(contextOnly ? { noReply: true } : {}) },
        });
        accepted = !r.error;
        if (r.error) report(`grayboard: delivery failed: ${JSON.stringify(r.error)}`);
      } finally { await receipt(accepted); }
    }).catch((error) => { report(`grayboard: delivery failed: ${String(error)}`); });
  };

  // Started on the first root session, not at load: until something can
  // receive them, messages wait in grayboard rather than in this process.
  const start = (): Child => {
    const startedAt = Date.now();
    const { cmd, args, env } = commandOf(entry);
    let recipient = target;
    let childEpoch = 0;
    let childSelection = generation;
    delete env.BUS_ADAPTER_OWNER;
    if (local) {
      env.BUS_ADAPTER_OWNER = owner;
      env.BUS_HARNESS_SESSION = recipient;
    }
    const proc = spawn(cmd, args, { cwd: directory, env, stdio: ["pipe", "pipe", "inherit"] });
    const exited = Promise.withResolvers<void>();
    let stopped: Promise<void> | undefined;
    const stop = () => stopped ??= (async () => {
      if (proc.exitCode !== null || proc.signalCode !== null || !proc.pid) return;
      proc.kill();
      const force = setTimeout(() => proc.kill("SIGKILL"), 1_500);
      try { await exited.promise; } finally { clearTimeout(force); }
    })();
    const pending = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void }>();
    let next = 1;
    let gone: Error | undefined;
    const send = (msg: object) => proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
    const call = (method: string, params: object, signal?: AbortSignal) =>
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
      if (gone) return;
      gone = new Error(reason);
      for (const p of pending.values()) p.reject(gone);
      pending.clear();
      if (child?.proc !== proc) return;
      child = undefined;
      // EPIPE may precede exit. Kill and await the old owner before a new
      // process can acquire its names or consume its delivery.
      const ending = stop();
      stopping.add(ending);
      void ending.finally(() => stopping.delete(ending));
      if (Date.now() - startedAt >= STABLE_MS) restarts = 0;
      const attempt = restarts;
      if (attempt >= RESTART_DELAYS_MS.length) {
        exitReason = `${reason} after ${attempt} restarts; restart opencode to reconnect`;
        report(exitReason);
        return;
      }
      restarts = attempt + 1;
      exitReason = `${reason}; restarting it`;
      report(`${reason}; restarting it (${attempt + 1} of ${RESTART_DELAYS_MS.length})`, "warning");
      const waiter = Promise.withResolvers<void>();
      let cancelled = false;
      const timer = setTimeout(async () => {
        await ending;
        await transition;
        if (cancelled || closed) return;
        restart = undefined;
        exitReason = undefined;
        child = start();
        waiter.resolve();
      }, RESTART_DELAYS_MS[attempt]);
      restart = {
        ready: waiter.promise,
        cancel() {
          cancelled = true;
          clearTimeout(timer);
          restart = undefined;
          waiter.resolve();
        },
      };
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
          // Final stdout after exit belongs to this child's committed root.
          const params = msg.params as ChannelParams;
          const receipt = async (accepted: boolean) => {
            const token = params.meta?.grayboard_delivery;
            if (token && !gone) await call("grayboard/delivery", { owner, token, accepted });
          };
          if (local && (childSelection !== generation || recipient !== requestedTarget
            || (params.meta?.grayboard_session !== undefined && params.meta.grayboard_session !== recipient)
            || (params.meta?.grayboard_epoch !== undefined && params.meta.grayboard_epoch !== String(childEpoch)))) {
            void receipt(false).catch((error) => report(`grayboard: delivery receipt failed: ${String(error)}`));
            continue;
          }
          // Receipts bypass the transition barrier: the child's exclusive
          // transition waits for them before retiring outgoing delivery.
          deliver(params, recipient, receipt, childSelection);
        } else if (msg.id !== undefined && pending.has(msg.id)) {
          const p = pending.get(msg.id)!;
          pending.delete(msg.id);
          if (msg.error) p.reject(new Error(`grayboard: ${msg.error.message}`));
          else p.resolve(msg.result);
        }
      }
    });
    proc.on("error", (e) => {
      if (!proc.pid) exited.resolve();
      fail(`grayboard process failed to start: ${e.message}`);
    });
    proc.on("exit", (code, signal) => {
      exited.resolve();
      fail(`grayboard process exited (${code ?? signal})`);
    });
    // A write after grayboard closed its end (EPIPE); unhandled, the error event would crash the host.
    proc.stdin!.on("error", (e) => fail(`grayboard process stopped reading: ${e.message}`));
    const associate = async (session: string, selection: number) => {
      const current = () => !closed && selection === generation && session === requestedTarget;
      if (!current()) return;
      if (!local) {
        await queue;
        if (current()) { recipient = session; childSelection = selection; }
        return;
      }
      const nextEpoch = ++epoch;
      const result = AssociationSchema.parse(await call("grayboard/session", { owner, epoch: nextEpoch, session }));
      if (!current()) return;
      if (gone || closed || child?.proc !== proc) throw new Error("grayboard: stale root association response");
      if (result.session !== session || result.epoch !== nextEpoch) throw new Error("grayboard: mismatched root association response");
      await queue;
      if (!current()) return;
      if (gone || closed || child?.proc !== proc) throw new Error("grayboard: root association owner changed");
      recipient = session;
      childEpoch = nextEpoch;
      childSelection = selection;
      instructions = result.instructions.join(" ");
      await call("grayboard/session/ready", { owner, epoch: nextEpoch });
    };
    // stdin stays open: grayboard exits when it closes, releasing the name.
    const ready = call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "opencode-grayboard", version: "1" },
    }).then(async (result: { instructions?: string }) => {
      if (closed || child?.proc !== proc) throw new Error("grayboard: stale initialize response");
      if (childSelection === generation) instructions = result.instructions;
      send({ method: "notifications/initialized" });
      const served = ((await call("tools/list", {})) as { tools: Tool[] }).tools;
      const diff = toolDiff(tools, served);
      if (diff.length) report(`grayboard: the running grayboard serves different tools than \`grayboard tools\` listed at load: ${diff.join(", ")}`);
      if (local && recipient) await associate(recipient, childSelection);
    });
    // A call that awaits ready gets the failure; this only keeps an unawaited
    // rejection from surfacing when no call is waiting.
    ready.catch(() => {});
    return { proc, ready, call, associate, stop };
  };

  // Exclude new tools while outgoing calls and delivery settle, then rotate
  // the child's bus root without replacing the child process.
  const selectTarget = (session: string, event = ++rootEvent): Promise<void> => {
    if (closed || event < selectedEvent) return transition;
    selectedEvent = event;
    if (session === requestedTarget) return transition;
    requestedTarget = session;
    generation++;
    const selection = generation;
    const current = () => !closed && selection === generation && session === requestedTarget;
    restart?.cancel();
    restarts = 0;
    exitReason = undefined;
    const outgoing = [...activeCalls];
    transition = transition.then(async () => {
      await Promise.allSettled(outgoing);
      if (!current()) return;
      await queue;
      if (!current()) return;
      await Promise.all(stopping);
      if (!current()) return;
      target = session;
      const c = child;
      if (c) {
        await c.ready;
        if (!current() || child !== c) return;
        await c.associate(session, selection);
        if (!current() || child !== c) return;
      }
      transitionError = undefined;
    }).catch((error) => {
      if (!current()) return;
      // A process failure already schedules current-root recovery. Don't
      // poison its future calls with the outgoing transport's rejection.
      if (!child && (restart || exitReason)) return;
      transitionError = error instanceof Error ? error : new Error(String(error));
      report(`grayboard: root session transition failed: ${transitionError.message}`);
    });
    return transition;
  };

  const running = async (signal?: AbortSignal): Promise<Child> => {
    const current = generation;
    if (refused) throw new Error(refused);
    await waitReady(transition, signal);
    if (transitionError) throw transitionError;
    if (!child && restart) await waitReady(restart.ready, signal);
    if (closed) throw new Error("grayboard: opencode plugin shut down");
    if (current !== generation) throw new Error("grayboard: root session changed while reconnecting");
    if (!child && exitReason) throw new Error(exitReason);
    await waitReady(Promise.all(stopping).then(() => {}), signal);
    if (closed || current !== generation) throw new Error("grayboard: root session changed or shut down while reconnecting");
    return (child ??= start());
  };

  const sessionParent = async (sessionID: string): Promise<string | undefined> => {
    if (!parents.has(sessionID)) {
      const session = await client.session.get({ path: { id: sessionID } });
      if (session.error || !session.data) throw new Error(`grayboard: can't identify opencode session ${sessionID}: ${JSON.stringify(session.error)}`);
      parents.set(sessionID, session.data.parentID);
    }
    return parents.get(sessionID);
  };
  const isSubagent = async (sessionID: string) => !!(await sessionParent(sessionID));
  const callTool = (c: Child, params: object, signal?: AbortSignal, root = false): Promise<CallResult> => {
    const selection = generation;
    const result = (c.call("tools/call", params, signal) as Promise<CallResult>).then((value) => {
      if (root && child === c && selection === generation && value.structuredContent?.instructions) instructions = value.structuredContent.instructions.join(" ");
      return value;
    });
    activeCalls.add(result);
    void result.finally(() => activeCalls.delete(result)).catch(() => {});
    return result;
  };
  const firstTarget = async (sessionID: string) => {
    if (requestedTarget) return transition;
    const event = ++rootEvent;
    let root = sessionID;
    const seen = new Set<string>();
    let parent: string | undefined;
    while ((parent = await sessionParent(root))) {
      if (seen.has(root)) throw new Error("grayboard: opencode session ancestry contains a cycle");
      seen.add(root);
      root = parent;
    }
    if (!requestedTarget) await selectTarget(root, event);
    else await transition;
  };

  // opencode's MCP naming, so prompts and skills that name these keep working.
  const name = (t: string) => `${SERVER}_${t}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  const record = Object.fromEntries(
    tools.map((t) => [
      name(t.name),
      tool({
        description: t.description ?? `MCP tool ${t.name} from server ${SERVER}`,
        args: toShape(t.inputSchema, t.name),
        async execute(args, ctx) {
          const sub = await isSubagent(ctx.sessionID);
          await firstTarget(ctx.sessionID);
          const current = generation;
          const c = await running(ctx.abort);
          await waitReady(c.ready, ctx.abort);
          await waitReady(transition, ctx.abort);
          if (current !== generation || (!sub && ctx.sessionID !== target)) throw new Error("grayboard: root session changed while waiting for the tool");
          if (transitionError) throw transitionError;
          const result = await callTool(c, { name: t.name, arguments: args, ...(sub ? { _meta: { [AGENT_META]: ctx.sessionID } } : {}) }, ctx.abort, !sub);
          // A thrown error is opencode's tool error.
          return resultText(result, t.name);
        },
      }),
    ]),
  );

  const shutdown = async () => {
    closed = true;
    generation++;
    restart?.cancel();
    const c = child;
    child = undefined;
    await Promise.all([...stopping, ...(c ? [c.stop()] : [])]);
  };

  return {
    tool: record,

    // An enabled entry would give opencode a second grayboard whose tools have
    // these ids. The tool record is already returned, so every call fails
    // with the fix, and nothing starts.
    config: async (cfg) => {
      // The effective entry, merged over project configs, decides only whether it's enabled.
      const effective = (cfg.mcp as Record<string, McpEntry> | undefined)?.[SERVER] ?? entry;
      if (effective && effective.enabled !== false) {
        refused = `grayboard: the "${SERVER}" MCP server in opencode's config is enabled, so opencode would run a second grayboard with the same tool ids. Set "enabled": false on it (grayboard setup writes it that way in ${CONFIG}); until then grayboard's tools fail and it receives nothing.`;
        report(refused);
      }
    },

    event: async ({ event }) => {
      if (closed) return;
      if (event.type === "session.created" || event.type === "session.updated") {
        const s = event.properties.info;
        parents.set(s.id, s.parentID);
        if (!s.parentID && event.type === "session.created" && !requestedTarget) await selectTarget(s.id);
      } else if (event.type === "message.updated") {
        const m = event.properties.info;
        // Events are fire-and-forget in OpenCode. A message can outlive its
        // deleted session: an unknown session must never steal delivery.
        const order = ++rootEvent;
        const ownDelivery = m.id.startsWith("msg_") && m.id.slice(16, 48) === deliveryMarker;
        if (m.role === "user" && !ownDelivery && !(await isSubagent(m.sessionID).catch(() => true))) await selectTarget(m.sessionID, order);
      } else if (event.type === "session.deleted") {
        parents.delete(event.properties.info.id);
      }
      if (target && !closed && !refused && !exitReason && !restart) {
        await Promise.all(stopping);
        await transition;
        if (!closed) child ??= start();
      }
    },

    // The MCP entry used to supply these; now it's disabled. A turn that
    // starts before the child's initialize waits for it.
    "experimental.chat.system.transform": async (input, output) => {
      if (refused || closed) return;
      const sub = input.sessionID ? await isSubagent(input.sessionID).catch(() => undefined) : false;
      if (sub === undefined) return;
      try { if (input.sessionID) await firstTarget(input.sessionID); } catch { return; }
      await transition;
      if (transitionError || closed) return;
      if (target && !child && !exitReason && !closed) {
        await Promise.all(stopping);
        if (!closed) child ??= start();
      }
      await child?.ready.catch(() => {});
      await transition;
      if (transitionError || closed || (!sub && input.sessionID && input.sessionID !== target)) return;
      if (sub && input.sessionID) {
        // V1's system hook has no abort signal. Instructions are optional:
        // never enter running()'s uncancellable restart/backoff wait here.
        // Actual tool calls still wait and forward their ctx.abort.
        const c = child;
        if (!c) return;
        try {
          const result = await callTool(c, { name: "whoami", arguments: {}, _meta: { [AGENT_META]: input.sessionID } });
          output.system.push(childInstructions(result));
        } catch {
          // An outage or failed lookup must not fail a child's model turn,
          // including a child that never calls grayboard in that turn.
        }
      } else if (instructions) output.system.push(instructions);
    },

    dispose: shutdown,
  };
};
