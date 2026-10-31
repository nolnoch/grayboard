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
import { homedir } from "node:os";
import { join } from "node:path";

type ChannelParams = { content: string; meta?: Record<string, string> };
type McpEntry = { type?: string; command?: string[]; environment?: Record<string, string>; enabled?: boolean };
type JsonSchema = {
  type?: string;
  description?: string;
  enum?: unknown[];
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
const z = tool.schema;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// Same shape Claude Code shows the model, so the MCP server's instructions apply.
function render({ content, meta = {} }: ChannelParams): string {
  const attrs = Object.entries(meta)
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join("");
  // A body's `<channel` or `</channel` keeps its `<` escaped, so it can't close
  // the element or forge another one (#433, #435).
  return `<channel source="grayboard"${attrs}>\n${content.replace(/<(?=\s*\/?\s*channel)/gi, "&lt;")}\n</channel>`;
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
  else if (s.type === "number") out = z.number();
  else if (s.type === "integer") out = z.number().int();
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
};

export const GrayboardPlugin: Plugin = async ({ client, directory }) => {
  // The user-level entry: the only one whose command and environment run.
  const entry = userEntry();
  const tools = loadTools(entry);
  let child: Child | undefined;
  let exitReason: string | undefined;
  let instructions: string | undefined;
  let refused: string | undefined;
  // The root session to deliver into: the one the user last wrote in.
  let target: string | undefined;
  const subagents = new Set<string>();
  // One delivery at a time, in order.
  let queue = Promise.resolve();

  const log = (level: "info" | "error", message: string) =>
    client.app.log({ body: { service: "grayboard", level, message } }).catch(() => {});
  const report = (message: string) => {
    log("error", message);
    client.tui.showToast({ body: { message, variant: "error" } }).catch(() => {});
  };

  const deliver = (params: ChannelParams) => {
    queue = queue.then(async () => {
      if (!target) return;
      const contextOnly = params.meta?.kind === "digest" || params.meta?.deferred === "true";
      // Direct messages, mentions, thread replies: act on them (starts a turn,
      // or joins a running one at its next step). Digests and deferred thread
      // replies: context only. The instructions this plugin adds to the
      // system prompt tell the model what a <channel> message is.
      const r = await client.session.promptAsync({
        path: { id: target },
        body: { parts: [{ type: "text", text: render(params) }], ...(contextOnly ? { noReply: true } : {}) },
      });
      if (r.error) log("error", `delivery failed: ${JSON.stringify(r.error)}`);
    });
  };

  // Started on the first root session, not at load: until something can
  // receive them, messages wait in grayboard rather than in this process.
  const start = (): Child => {
    const { cmd, args, env } = commandOf(entry);
    const proc = spawn(cmd, args, { cwd: directory, env, stdio: ["pipe", "pipe", "inherit"] });
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
      gone = new Error(reason);
      for (const p of pending.values()) p.reject(gone);
      pending.clear();
      if (child?.proc !== proc) return;
      child = undefined;
      exitReason = reason;
      report(`${reason}; restart opencode to reconnect`);
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
    proc.on("error", (e) => fail(`grayboard process failed to start: ${e.message}`));
    proc.on("exit", (code, signal) => fail(`grayboard process exited (${code ?? signal})`));
    // A write after grayboard closed its end (EPIPE); unhandled, the error event would crash the host.
    proc.stdin!.on("error", (e) => fail(`grayboard process stopped reading: ${e.message}`));
    // stdin stays open: grayboard exits when it closes, releasing the name.
    const ready = call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "opencode-grayboard", version: "1" },
    }).then(async (result: { instructions?: string }) => {
      instructions = result.instructions;
      send({ method: "notifications/initialized" });
      const served = ((await call("tools/list", {})) as { tools: Tool[] }).tools;
      const diff = toolDiff(tools, served);
      if (diff.length) report(`grayboard: the running grayboard serves different tools than \`grayboard tools\` listed at load: ${diff.join(", ")}`);
    });
    // A call that awaits ready gets the failure; this only keeps an unawaited
    // rejection from surfacing when no call is waiting.
    ready.catch(() => {});
    return { proc, ready, call };
  };

  // The child, started if it isn't yet; a call after it exited fails with why.
  const running = (): Child => {
    if (refused) throw new Error(refused);
    if (exitReason) throw new Error(exitReason);
    return (child ??= start());
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
          const c = running();
          await c.ready;
          const result = (await c.call("tools/call", { name: t.name, arguments: args }, ctx.abort)) as CallResult;
          const text = (result.content ?? []).flatMap((b) => (b.type === "text" && b.text ? [b.text] : [])).join("\n");
          // A result carries the instructions when the name changed (#182
          // decision 13): bind's, or the next one after a bind whose result
          // was lost (cancelled, timed out) or a lost name. Errors included.
          if (result.structuredContent?.instructions) instructions = result.structuredContent.instructions.join(" ");
          // A thrown error is opencode's tool error.
          if (result.isError) throw new Error(text || `MCP tool ${SERVER}/${t.name} returned an error`);
          return text;
        },
      }),
    ]),
  );

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
      if (event.type === "session.created" || event.type === "session.updated") {
        const s = event.properties.info;
        if (s.parentID) subagents.add(s.id);
        else if (event.type === "session.created") target ??= s.id;
      } else if (event.type === "message.updated") {
        const m = event.properties.info;
        if (m.role === "user" && !subagents.has(m.sessionID)) target = m.sessionID;
      }
      if (target && !refused && !exitReason) child ??= start();
    },

    // The MCP entry used to supply these; now it's disabled. A turn that
    // starts before the child's initialize waits for it.
    "experimental.chat.system.transform": async (input, output) => {
      if (refused) return;
      if (!child && !exitReason && input.sessionID && !subagents.has(input.sessionID)) {
        target ??= input.sessionID;
        child = start();
      }
      await child?.ready.catch(() => {});
      if (instructions) output.system.push(instructions);
    },

    dispose: async () => {
      child?.proc.kill();
    },
  };
};
