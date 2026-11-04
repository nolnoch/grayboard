// Real local/V1 OpenCode, isolated from the user's config and talking to fake_model.ts.
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { localEnv } from "./env.ts";
import { CLI, ROOT } from "./paths.ts";
import { z } from "zod";
import { until } from "./until.ts";

const PACKAGE = join(ROOT, "node_modules/opencode-ai/package.json");
const OPENCODE = z.object({ version: z.string(), bin: z.object({ opencode: z.string() }) }).parse(JSON.parse(readFileSync(PACKAGE, "utf8")));
const VERSION = OPENCODE.version;
const OPENCODE_CLI = join(dirname(PACKAGE), OPENCODE.bin.opencode);

const ToolPartSchema = z.object({ type: z.literal("tool"), tool: z.string(), state: z.object({ status: z.string(), output: z.string().optional(), error: z.string().optional() }) });
const MessageSchema = z.object({ info: z.object({ role: z.string(), error: z.unknown().optional() }), parts: z.array(z.union([ToolPartSchema, z.object({ type: z.string(), text: z.string().optional() })])) });
const ToastSchema = z.object({ type: z.literal("tui.toast.show"), properties: z.object({ message: z.string() }) });
type ToolPart = z.infer<typeof ToolPartSchema>;
export type OpenCodeMessage = z.infer<typeof MessageSchema>;
export type LocalOpenCode = {
  pid: number;
  create(): Promise<string>;
  prompt(session: string, text: string): Promise<OpenCodeMessage>;
  messages(session: string): Promise<OpenCodeMessage[]>;
  request(path: string, method?: string, body?: object): Promise<unknown>;
  notices(): string[];
  stop(): Promise<void>;
};

export async function localOpenCode(dir: string, modelPort: number): Promise<LocalOpenCode> {
  const config = join(dir, "config"), oc = join(config, "opencode");
  mkdirSync(join(oc, "plugin"), { recursive: true });
  // No network-dependent package installation by the plugin loader.
  mkdirSync(join(oc, "node_modules/@opencode-ai"), { recursive: true });
  symlinkSync(join(ROOT, "node_modules/@opencode-ai/plugin"), join(oc, "node_modules/@opencode-ai/plugin"), "dir");
  copyFileSync(join(ROOT, "adapters/opencode/grayboard.ts"), join(oc, "plugin/grayboard.ts"));
  writeFileSync(join(oc, "package.json"), JSON.stringify({ dependencies: { "@opencode-ai/plugin": VERSION } }));
  writeFileSync(join(oc, "opencode.json"), JSON.stringify({
    model: "fake/fake-1", small_model: "fake/fake-1", autoupdate: false,
    provider: { fake: { npm: "@ai-sdk/openai-compatible", name: "fake", options: { baseURL: `http://127.0.0.1:${modelPort}/v1`, apiKey: "x" }, models: { "fake-1": { name: "fake-1", limit: { context: 128000, output: 4096 } } } } },
    mcp: { grayboard: { type: "local", command: [process.execPath, CLI, "mcp", "--mode", "local"], environment: { BUS_PUSH: "off" }, enabled: false } },
    permission: "allow",
  }));
  const proc = spawn(OPENCODE_CLI, ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
    cwd: dir,
    env: localEnv(dir, undefined, { XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"), XDG_STATE_HOME: join(dir, "state"), OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_AUTOUPDATE: "true" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  proc.stdout!.on("data", (d) => { output += d; });
  proc.stderr!.on("data", (d) => { output += d; });
  const exit = Promise.withResolvers<void>();
  proc.once("exit", () => exit.resolve());
  const eventAbort = new AbortController();
  let eventError: unknown;
  const stop = async () => {
    eventAbort.abort();
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    proc.kill("SIGTERM");
    const force = setTimeout(() => proc.kill("SIGKILL"), 5_000);
    await exit.promise;
    clearTimeout(force);
  };
  try {
    const url = await until(() => {
      if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`opencode ${VERSION} exited: ${output}`);
      return /opencode server listening on (http:\/\/[^\s]+)/.exec(output)?.[1];
    }, 30_000, `opencode ${VERSION} listening`);
    const request = async (path: string, method = "GET", body?: object) => {
      if (eventError) throw eventError;
      const r = await fetch(url + path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`opencode ${VERSION} ${method} ${path}: ${r.status} ${await r.text()}\n${output}`);
      return r.status === 204 ? undefined : r.json();
    };
    const notices: string[] = [];
    const stream = await fetch(url + "/event", { signal: eventAbort.signal });
    if (!stream.ok || !stream.body) throw new Error(`opencode events: ${stream.status}`);
    const reader = stream.body.getReader();
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const chunk = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = chunk.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trim()).join("\n");
            if (!data) continue;
            const parsed = ToastSchema.safeParse(JSON.parse(data));
            if (parsed.success) notices.push(parsed.data.properties.message);
          }
        }
      } finally { reader.releaseLock(); }
    })().catch(e => { if (!eventAbort.signal.aborted) eventError = e; });
    return {
      pid: proc.pid!, request, stop,
      notices: () => notices,
      create: async () => z.object({ id: z.string() }).parse(await request("/session", "POST", { title: "Local restart regression" })).id,
      async prompt(session, text) {
        const final = MessageSchema.parse(await request(`/session/${session}/message`, "POST", { model: { providerID: "fake", modelID: "fake-1" }, parts: [{ type: "text", text }] }));
        const messages = z.array(MessageSchema).parse(await request(`/session/${session}/message`));
        const at = messages.findLastIndex(m => m.info.role === "user");
        return { info: final.info, parts: messages.slice(at + 1).flatMap(m => m.parts) };
      },
      messages: async session => z.array(MessageSchema).parse(await request(`/session/${session}/message`)),
    };
  } catch (e) {
    await stop();
    throw e;
  }
}

export function opencodeTool(message: OpenCodeMessage, tool: string): ToolPart {
  const part = message.parts.find((p): p is ToolPart => p.type === "tool" && "tool" in p && p.tool === `grayboard_${tool}`);
  if (!part) throw new Error(`OpenCode didn't call ${tool}: ${JSON.stringify(message)}`);
  return part;
}
