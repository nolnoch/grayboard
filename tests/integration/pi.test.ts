// End-to-end with the real pi coding agent (the pinned devDependency) and its
// built-in MCP client, in RPC mode against a scripted fake model. Local-mode
// grayboard: pi runs a tools-only `grayboard mcp` from mcp.json, and the
// adapter in adapters/pi runs the push side. A peer is an MCP client like in
// local.test.ts.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = resolve(import.meta.dir, "../..");
const CLI = join(ROOT, "src/cli/main.ts");
const ADAPTER = join(ROOT, "adapters/pi/grayboard.ts");
const PI_PKG = join(ROOT, "node_modules/@earendil-works/pi-coding-agent/package.json");
const PI_CLI = join(dirname(PI_PKG), JSON.parse(readFileSync(PI_PKG, "utf8")).bin.pi);

let dir: string;
const clients: Client[] = [];
const procs: ChildProcess[] = [];
let model: ReturnType<typeof Bun.serve> | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grayboard-pi-"));
});

afterEach(async () => {
  for (const p of procs.splice(0)) p.kill();
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  model?.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

function busEnv(identity: string, extra: Record<string, string> = {}): Record<string, string> {
  const env = { ...process.env, BUS_DB_PATH: join(dir, "bus.db"), BUS_SOCK_DIR: dir, GRAYBOARD_CREDENTIALS: join(dir, "credentials") } as Record<string, string | undefined>;
  delete env.GRAYBOARD_TOKEN;
  return { ...env, BUS_IDENTITY: identity, ...extra } as Record<string, string>;
}

async function peer(identity: string, extra: Record<string, string> = {}): Promise<{ c: Client; pushes: string[] }> {
  const pushes: string[] = [];
  const c = new Client({ name: "test", version: "0" });
  let initialized = false;
  c.fallbackNotificationHandler = async (n) => {
    if (initialized && n.method === "notifications/claude/channel") pushes.push((n.params as { content: string }).content);
  };
  await c.connect(
    new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp", "--mode", "local"], cwd: dir, env: busEnv(identity, extra), stderr: "ignore" }),
  );
  initialized = true;
  clients.push(c);
  return { c, pushes };
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = await c.callTool({ name, arguments: args });
  const body = (r.content as { text: string }[])[0]!.text;
  if (r.isError) throw new Error(body);
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

async function until<T>(f: () => T | undefined | Promise<T | undefined>, what: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

// ── fake model: OpenAI chat completions, streamed ────────────────────────────

type ChatMessage = { role: string; content?: unknown; tool_calls?: unknown };
type ChatRequest = { messages: ChatMessage[] };

const text = (m: ChatMessage): string =>
  typeof m.content === "string"
    ? m.content
    : Array.isArray(m.content)
      ? m.content.map((p: { text?: string }) => p.text ?? "").join("")
      : "";

function sse(delta: Record<string, unknown>, finish: string): Response {
  const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
    `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "fake-1", choices, ...extra })}\n\n`;
  const body =
    chunk([{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }]) +
    chunk([{ index: 0, delta: {}, finish_reason: finish }]) +
    chunk([], { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) +
    "data: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

// Answers the latest <channel> direct message by calling dm_send back, unless
// the model already acted after it. A context-only message (a digest) can land
// after the tool result, mid-turn; that isn't a new DM to answer. A DM
// delivered twice still gets two replies.
const DM = /<channel source="grayboard" message_id="(\d+)" from="peer"/;
function startModel(requests: ChatRequest[]) {
  model = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as ChatRequest;
      requests.push(body);
      const at = body.messages.findLastIndex((m) => DM.test(text(m)));
      if (at < 0 || body.messages.slice(at + 1).some((m) => m.role === "assistant")) return sse({ content: "nothing to do" }, "stop");
      const id = DM.exec(text(body.messages[at]!))![1];
      const args = { to: "peer", body: "pong", parent_id: Number(id) };
      return sse(
        { content: null, tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "mcp__grayboard__dm_send", arguments: JSON.stringify(args) } }] },
        "tool_calls",
      );
    },
  });
  return model.port;
}

// ── pi in RPC mode ───────────────────────────────────────────────────────────

class Pi {
  events: Record<string, any>[] = [];
  private n = 0;
  constructor(private proc: ChildProcess) {
    let buf = "";
    proc.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        try {
          this.events.push(JSON.parse(line));
        } catch {}
      }
    });
  }
  async command(cmd: Record<string, unknown>): Promise<any> {
    const id = `r${++this.n}`;
    this.proc.stdin!.write(JSON.stringify({ ...cmd, id }) + "\n");
    const r = await until(() => this.events.find((e) => e.type === "response" && e.id === id), `${cmd.type} response`);
    if (!r.success) throw new Error(`${cmd.type}: ${r.error}`);
    return r.data;
  }
  async quit(): Promise<void> {
    const exited = new Promise((r) => this.proc.once("exit", r));
    this.proc.stdin!.end();
    await exited;
  }
}

function startPi(modelPort: number): Pi {
  const agentDir = join(dir, "pi-agent");
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  copyFileSync(ADAPTER, join(agentDir, "extensions", "grayboard.ts"));
  // The entry grayboard setup writes, with this checkout as the command.
  writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({
    mcpServers: {
      grayboard: { command: process.execPath, args: [CLI, "mcp", "--mode", "local"], env: { BUS_PUSH: "off" }, exposure: "direct" },
    },
  }));
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      fake: { baseUrl: `http://localhost:${modelPort}/v1`, api: "openai-completions", apiKey: "x", models: [{ id: "fake-1" }] },
    },
  }));
  const proc = spawn("node", [PI_CLI, "--mode", "rpc", "--no-session", "--offline", "--provider", "fake", "--model", "fake-1"], {
    cwd: dir,
    env: busEnv("pi", { PI_CODING_AGENT_DIR: agentDir, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" }),
    stdio: ["pipe", "pipe", "inherit"],
  });
  procs.push(proc);
  return new Pi(proc);
}

test("pi: a DM wakes the session, which replies with dm_send; a digest rides along as context", async () => {
  // pi's identity follows #ops in digest mode (a tools-only session may share it).
  const { c: setup } = await peer("pi", { BUS_PUSH: "off" });
  const { c: p, pushes } = await peer("peer");
  await call(p, "board_create", { name: "ops", purpose: "ops" });
  await call(setup, "board_subscribe", { board: "ops", mode: "digest" });
  await setup.close();

  const requests: ChatRequest[] = [];
  const pi = startPi(startModel(requests));
  await pi.command({ type: "get_state" });
  await until(async () => (await call(p, "peer_list")).peers.some((x: any) => x.handle === "pi") || undefined, "pi online");

  // Digest: no model call. It reaches the session with the next wake, or with
  // the first drain if the adapter's MCP handshake finishes after this post.
  await call(p, "board_post", { board: "ops", body: "deploy at 5" });
  const messages = async () => (await pi.command({ type: "get_messages" })).messages as { role: string; content: unknown }[];
  const hasDigest = async () => (await messages()).some((m) => JSON.stringify(m).includes('kind=\\"digest\\"'));
  await Bun.sleep(300);
  expect(requests).toHaveLength(0);

  // DM: starts a turn, and the digest comes with it; the model sees the
  // <channel> tag and grayboard's instructions, and its dm_send reply reaches
  // the peer in the same thread.
  const sent = await call(p, "dm_send", { to: "pi", body: "ping" });
  await until(async () => (await hasDigest()) || undefined, "digest in session");
  const reply = await until(() => pushes.find((x) => x.includes("pong")), "pong at peer", 30_000);
  expect(reply).toBeDefined();
  const thread = await call(p, "dm_thread", { thread: sent.message_id });
  expect(thread.map((m: any) => [m.sender, m.body, m.parent_id])).toEqual([
    ["peer", "ping", null],
    ["pi", "pong", sent.message_id],
  ]);

  const first = requests[0]!;
  const system = first.messages.filter((m) => m.role === "system" || m.role === "developer").map(text).join("\n");
  expect(system).toContain("<grayboard>");
  expect(system).toContain('You are identity "pi" on the grayboard bus');
  expect(first.messages.map(text).join("\n")).toContain(`<channel source="grayboard" message_id="${sent.message_id}" from="peer"`);
  await until(() => pi.events.some((e) => e.type === "agent_settled") || undefined, "agent_settled");

  // One delivery, one reply: a DM pushed twice would wake the session twice.
  const copies = (await messages()).filter((m) => JSON.stringify(m).includes(`message_id=\\"${sent.message_id}\\"`));
  expect(copies).toHaveLength(1);
  expect((await call(p, "dm_thread", { thread: sent.message_id })).length).toBe(2);

  // Quitting pi stops the push process and frees the identity.
  await pi.quit();
  await until(
    async () => ((await call(p, "peer_list", { include_offline: true })).peers.find((x: any) => x.handle === "pi")?.online === false) || undefined,
    "pi offline",
  );
}, 90_000);
