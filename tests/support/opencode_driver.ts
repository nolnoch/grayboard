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
import { createInterface } from "node:readline";
import { tool } from "@opencode-ai/plugin";
import { GrayboardPlugin } from "../../adapters/opencode/grayboard.ts";

const logs: { level: string; message: string }[] = [];
const toasts: string[] = [];
const prompts: { session: string; text: string; noReply: boolean }[] = [];
const client = {
  app: { log: async ({ body }: any) => (logs.push({ level: body.level, message: body.message }), {}) },
  tui: { showToast: async ({ body }: any) => (toasts.push(body.message), {}) },
  session: {
    promptAsync: async ({ path, body }: any) => {
      prompts.push({ session: path.id, text: body.parts.map((p: any) => p.text).join(""), noReply: !!body.noReply });
      return {};
    },
  },
};

let hooks: any;
const ctx = (sessionID = "s1") => ({ sessionID, messageID: "m1", agent: "build", directory: process.cwd(), worktree: process.cwd(), abort: new AbortController().signal, metadata() {}, ask: async () => {} });

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
    case "call":
      return hooks.tool[msg.tool].execute(msg.args, ctx());
    case "parse":
      // What opencode's runtime hands execute: the args through the tool's zod.
      return tool.schema.object(hooks.tool[msg.tool].args).parse(msg.args);
    case "system": {
      const output = { system: [] as string[] };
      await hooks["experimental.chat.system.transform"]({ sessionID: msg.sessionID, model: {} }, output);
      return output.system;
    }
    case "state":
      return { logs, toasts, prompts };
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
