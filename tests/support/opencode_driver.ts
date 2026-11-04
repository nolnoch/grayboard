// Runs the opencode adapter (adapters/opencode/grayboard.ts) the way opencode
// V1 does, with a fake opencode client, in its own process so its env is the
// test's (the adapter reads XDG_CONFIG_HOME and the entry's environment over
// process.env). The real opencode CLI is #141's. JSON lines on stdin:
// {id, op, ...}; one {id, ok, value | error} line each on stdout.
//   init                       call the plugin; value: { tools: { <id>: <args as JSON Schema> } }
//   config  { cfg }            the config hook
//   event   { event }          the event hook
//   call    { tool, args }     a tool's execute; value: its output
//   system  { sessionID }      experimental.chat.system.transform; value: output.system
//   state                      value: { logs, toasts, prompts } the fake client saw
//   dispose
//   abort   { key }            abort an in-flight call tagged with that key
//   advanceClock { ms }        advance the adapter's stability clock, not its timers
import { createInterface } from "node:readline";
import { ChildProcess } from "node:child_process";
import { tool } from "@opencode-ai/plugin";
import { GrayboardPlugin } from "../../adapters/opencode/grayboard.ts";
import { processDescendants } from "./procs.ts";

// Hold actual stdout data events, then release their original payloads only
// after exit: Bun's node:child_process stdout ignores Readable.pause().
const children: ChildProcess[] = [];
const spawnOwners: number[][] = [];
type HeldStdout = { child: ChildProcess; emit: ChildProcess["emit"]; chunks: unknown[][] };
const heldStdout = new Map<string, HeldStdout>();
const emit = ChildProcess.prototype.emit;
ChildProcess.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
  if (event === "spawn") {
    children.push(this);
    spawnOwners.push(processDescendants(process.pid).filter(p => children.some(c => c.pid === p.pid)).map(p => p.pid));
  }
  return emit.call(this, event, ...args);
};

const logs: { level: string; message: string }[] = [];
const toasts: string[] = [];
const prompts: { session: string; text: string; noReply: boolean }[] = [];
const restartOwners: { message: string; pids: number[] }[] = [];
const client = {
  app: { log: async ({ body }: any) => (logs.push({ level: body.level, message: body.message }), {}) },
  tui: { showToast: async ({ body }: { body: { message: string } }) => {
    toasts.push(body.message);
    if (body.message.includes("restarting it (") || body.message.includes("after 3 restarts")) {
      // Ignore the observing ps process; these are the actual MCP children,
      // including a shell stub that exec'd sleep under the same pid.
      restartOwners.push({ message: body.message, pids: processDescendants(process.pid).filter(p => children.some(c => c.pid === p.pid)).map(p => p.pid) });
    }
    return {};
  } },
  session: {
    promptAsync: async ({ path, body }: any) => {
      prompts.push({ session: path.id, text: body.parts.map((p: any) => p.text).join(""), noReply: !!body.noReply });
      return {};
    },
  },
};

let hooks: any;
const calls = new Map<string, AbortController>();
const now = Date.now;
const ctx = (sessionID = "s1", abort = new AbortController().signal) => ({ sessionID, messageID: "m1", agent: "build", directory: process.cwd(), worktree: process.cwd(), abort, metadata() {}, ask: async () => {} });

async function run(msg: any): Promise<unknown> {
  switch (msg.op) {
    case "init": {
      hooks = await GrayboardPlugin({ client, directory: process.cwd() } as any);
      const z = tool.schema;
      return { tools: Object.fromEntries(Object.entries(hooks.tool ?? {}).map(([id, t]: [string, any]) => [id, z.toJSONSchema(z.object(t.args))])) };
    }
    case "config":
      return hooks.config(msg.cfg);
    case "event":
      return hooks.event({ event: msg.event });
    case "call": {
      const controller = new AbortController();
      const key = String(msg.key ?? msg.id);
      calls.set(key, controller);
      try { return await hooks.tool[msg.tool].execute(msg.args, ctx(msg.sessionID, controller.signal)); }
      finally { calls.delete(key); }
    }
    case "abort":
      calls.get(msg.key)?.abort();
      return;
    case "advanceClock":
      Date.now = () => now() + msg.ms;
      return;
    case "holdStdout": {
      const child = children.at(-1);
      if (!child?.stdout) throw new Error("no child stdout to hold");
      const streamEmit = child.stdout.emit;
      const chunks: unknown[][] = [];
      child.stdout.emit = function (event: string | symbol, ...args: unknown[]) {
        if (event === "data") { chunks.push(args); return true; }
        return streamEmit.call(this, event, ...args);
      };
      heldStdout.set(msg.key, { child, emit: streamEmit, chunks });
      return;
    }
    case "releaseStdout": {
      const held = heldStdout.get(msg.key);
      if (!held?.child.stdout) throw new Error("no held child stdout");
      heldStdout.delete(msg.key);
      const stdout = held.child.stdout;
      stdout.emit = held.emit;
      for (const chunk of held.chunks) held.emit.call(stdout, "data", ...chunk);
      return;
    }
    case "parse":
      // What opencode's runtime hands execute: the args through the tool's zod.
      return tool.schema.object(hooks.tool[msg.tool].args).parse(msg.args);
    case "system": {
      const output = { system: [] as string[] };
      await hooks["experimental.chat.system.transform"]({ sessionID: msg.sessionID, model: {} }, output);
      return output.system;
    }
    case "state":
      return { logs, toasts, prompts, calls: [...calls.keys()], restartOwners, spawnOwners };
    case "dispose":
      return hooks.dispose();
  }
  throw new Error(`unknown op ${msg.op}`);
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  const msg = JSON.parse(line);
  try {
    const value = await run(msg);
    process.stdout.write(JSON.stringify({ id: msg.id, ok: true, value: value ?? null }) + "\n");
  } catch (e) {
    process.stdout.write(JSON.stringify({ id: msg.id, ok: false, error: (e as Error).message }) + "\n");
  }
});
