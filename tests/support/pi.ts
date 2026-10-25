// The pi scenarios: the real pi coding agent (the pinned devDependency) in RPC
// mode against a scripted fake model. Local-mode grayboard: mcp.json's
// grayboard entry is disabled, as setup writes it, and the pi adapter runs the
// session's one `grayboard mcp` and serves its tools (#182 decision 13). A
// peer is an MCP client like in local.test.ts. `bin` runs it all on a compiled
// grayboard (binaries.e2e.ts) instead of this checkout, with the adapter that
// binary carries.
import { expect } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { localEnv } from "./env.ts";
import { onChannelDm, messageText, startFakeModel, type ChatRequest, type Reply, type Rule } from "./fake_model.ts";
import { localSession, stopSession } from "./mcp.ts";
import { CLI, ROOT } from "./paths.ts";
import { adapterChildren, grayboardChildren } from "./procs.ts";
import { until } from "./until.ts";

const ADAPTER = join(ROOT, "adapters/pi/grayboard.ts");
const PI_PKG = join(ROOT, "node_modules/@earendil-works/pi-coding-agent/package.json");
const PI = JSON.parse(readFileSync(PI_PKG, "utf8")) as { version: string; bin: { pi: string } };
const PI_CLI = join(dirname(PI_PKG), PI.bin.pi);

// ── pi in RPC mode ───────────────────────────────────────────────────────────

class Pi {
  events: Record<string, any>[] = [];
  stderr = "";
  readonly exited: Promise<number | null>;
  private n = 0;
  constructor(private proc: ChildProcess) {
    this.exited = new Promise((r) => proc.once("exit", (code) => r(code)));
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
    proc.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
      this.stderr += chunk;
      process.stderr.write(chunk);
    });
  }
  get pid(): number {
    return this.proc.pid!;
  }
  async command(cmd: Record<string, unknown>): Promise<any> {
    const id = `r${++this.n}`;
    this.proc.stdin!.write(JSON.stringify({ ...cmd, id }) + "\n");
    const r = await until(() => this.events.find((e) => e.type === "response" && e.id === id), 15_000, `${cmd.type} response`);
    if (!r.success) throw new Error(`${cmd.type}: ${r.error}`);
    return r.data;
  }
  async messages(): Promise<{ role: string; content: unknown; toolName?: string; isError?: boolean }[]> {
    return (await this.command({ type: "get_messages" })).messages;
  }
  notices(): string[] {
    return this.events.filter((e) => e.type === "extension_ui_request" && e.method === "notify").map((e) => e.message);
  }
  async quit(): Promise<void> {
    this.proc.stdin!.end();
    await this.exited;
  }
}

type PiOpts = {
  bin?: string;
  // The session's BUS_IDENTITY; null starts it unbound.
  identity?: string | null;
  // Merged over the grayboard entry setup writes.
  entry?: Record<string, unknown>;
};

function startPi(dir: string, modelPort: number, procs: ChildProcess[], { bin, identity = "pi", entry = {} }: PiOpts = {}): Pi {
  const agentDir = join(dir, "pi-agent");
  const extension = join(agentDir, "extensions", "grayboard.ts");
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  if (bin) {
    // The adapter the binary carries: refresh-adapters rewrites an installed one.
    writeFileSync(extension, "");
    const r = Bun.spawnSync([bin, "refresh-adapters"], { env: localEnv(dir, undefined, { PI_CODING_AGENT_DIR: agentDir }), timeout: 10_000, killSignal: "SIGKILL" });
    if (r.exitedDueToTimeout) throw new Error(`${bin} refresh-adapters: no exit in 10 s`);
    if (r.exitCode !== 0 || !readFileSync(extension, "utf8")) throw new Error(`${bin} refresh-adapters: ${r.stderr}`);
  } else {
    copyFileSync(ADAPTER, extension);
  }
  // The entry grayboard setup writes, with this checkout or the binary as the command.
  const command = bin ? { command: bin, args: ["mcp", "--mode", "local"] } : { command: process.execPath, args: [CLI, "mcp", "--mode", "local"] };
  writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({
    mcpServers: { grayboard: { ...command, env: { BUS_PUSH: "off" }, enabled: false, ...entry } },
  }));
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      fake: { baseUrl: `http://localhost:${modelPort}/v1`, api: "openai-completions", apiKey: "x", models: [{ id: "fake-1" }] },
    },
  }));
  const proc = spawn("node", [PI_CLI, "--mode", "rpc", "--no-session", "--offline", "--provider", "fake", "--model", "fake-1"], {
    cwd: dir,
    env: localEnv(dir, identity ?? undefined, { PI_CODING_AGENT_DIR: agentDir, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  procs.push(proc);
  return new Pi(proc);
}

// The tools `grayboard tools` lists, as the extension names them in pi.
function toolNames(bin?: string): string[] {
  const r = Bun.spawnSync([...(bin ? [bin] : [process.execPath, CLI]), "tools", "--mode", "local"], { timeout: 10_000 });
  if (r.exitCode !== 0) throw new Error(`grayboard tools: ${r.stderr}`);
  return (JSON.parse(r.stdout.toString()) as { name: string }[]).map((t) => `mcp__grayboard__${t.name}`).sort();
}

const requestTools = (req: ChatRequest): string[] => (req.tools ?? []).map((t) => t.function.name);
const systemText = (req: ChatRequest): string =>
  req.messages.filter((m) => m.role === "system" || m.role === "developer").map(messageText).join("\n");

// SIGTERM lets pi stop its own children; awaited (SIGKILL after 5 s) so the
// caller's rmSync doesn't race a pi still writing in dir.
async function stopAll(procs: ChildProcess[]): Promise<void> {
  await Promise.all(procs.map(async (p) => {
    if (p.exitCode !== null || p.signalCode !== null) return;
    const exited = new Promise((r) => p.once("exit", r));
    p.kill("SIGTERM");
    const force = setTimeout(() => p.kill("SIGKILL"), 5_000);
    await exited;
    clearTimeout(force);
  }));
}

// A failure names pi's version.
async function named(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (e) {
    if (e instanceof Error) e.message = `pi ${PI.version}: ${e.message}`;
    throw e;
  }
}

// A DM wakes the session, which replies with dm_send; a digest rides along as
// context. The extension's tools reach the first turn, and the session's one
// grayboard process runs under pi. The caller closes the MCP sessions
// (closeSessions).
export function piScenario(dir: string, bin?: string): Promise<void> {
  return named(() => scenario(dir, bin));
}

async function scenario(dir: string, bin?: string): Promise<void> {
  const procs: ChildProcess[] = [];
  let model: ReturnType<typeof startFakeModel> | undefined;
  try {
    // pi's identity follows #ops in digest mode (a tools-only session may share it).
    const setup = await localSession(dir, "pi", { bin, extra: { BUS_PUSH: "off" } });
    const p = await localSession(dir, "peer", { bin });
    await p.call("board_create", { name: "ops", purpose: "ops" });
    await setup.call("board_subscribe", { board: "ops", mode: "digest" });
    await stopSession(setup.c);

    model = startFakeModel([onChannelDm("peer", (id) => ({ tool: "mcp__grayboard__dm_send", args: { to: "peer", body: "pong", parent_id: id } }))]);
    const { requests } = model;
    const pi = startPi(dir, model.port, procs, { bin });
    await pi.command({ type: "get_state" });
    await until(async () => (await p.call("peer_list")).peers.some((x: any) => x.handle === "pi"), 15_000, "pi online");
    expect(grayboardChildren(pi.pid, bin)).toHaveLength(1);
    expect(adapterChildren(pi.pid, bin)).toHaveLength(1);

    // Digest: no model call. It reaches the session with the next wake, or with
    // the first drain if the adapter's MCP handshake finishes after this post.
    await p.call("board_post", { board: "ops", body: "deploy at 5" });
    const hasDigest = async () => (await pi.messages()).some((m) => JSON.stringify(m).includes('kind=\\"digest\\"'));
    await Bun.sleep(300);
    expect(requests).toHaveLength(0);

    // DM: starts a turn, and the digest comes with it; the model sees the
    // <channel> tag and grayboard's instructions, and its dm_send reply reaches
    // the peer in the same thread.
    const sent = await p.call("dm_send", { to: "pi", body: "ping" });
    await until(hasDigest, 15_000, "digest in session");
    const reply = await until(() => p.pushes.find((x) => x.content.includes("pong")), 30_000, "pong at peer");
    expect(reply).toBeDefined();
    const thread = await p.call("dm_thread", { thread: sent.message_id });
    expect(thread.map((m: any) => [m.sender, m.body, m.parent_id])).toEqual([
      ["peer", "ping", null],
      ["pi", "pong", sent.message_id],
    ]);

    expect(model.unhandled).toEqual([]);
    const first = requests[0]!.body;
    // Every tool `grayboard tools` lists, served by the extension (the MCP entry is disabled).
    expect(requestTools(first).filter((n) => n.startsWith("mcp__grayboard__")).sort()).toEqual(toolNames(bin));
    const system = systemText(first);
    expect(system).toContain("<grayboard>");
    expect(system).toContain('You are identity "pi" on the grayboard bus');
    expect(first.messages.map(messageText).join("\n")).toContain(`<channel source="grayboard" message_id="${sent.message_id}" from="peer"`);
    await until(() => pi.events.some((e) => e.type === "agent_settled"), 15_000, "agent_settled");

    // One delivery, one reply: a DM pushed twice would wake the session twice.
    const copies = (await pi.messages()).filter((m) => JSON.stringify(m).includes(`message_id=\\"${sent.message_id}\\"`));
    expect(copies).toHaveLength(1);
    expect((await p.call("dm_thread", { thread: sent.message_id })).length).toBe(2);
    expect(grayboardChildren(pi.pid, bin)).toHaveLength(1);

    // Quitting pi stops the grayboard process and frees the identity.
    await pi.quit();
    await until(
      async () => (await p.call("peer_list", { include_offline: true })).peers.find((x: any) => x.handle === "pi")?.online === false,
      15_000,
      "pi offline",
    );
  } finally {
    await stopAll(procs);
    model?.stop();
  }
}

// Started without BUS_IDENTITY, the session is unbound: reads work, the rest
// is refused. bind through the extension's tool binds the session's one
// grayboard process, a DM to the new name triggers a turn, and that turn's
// system prompt carries the bound name's instructions.
export function piUnboundScenario(dir: string, bin?: string): Promise<void> {
  return named(() => unboundScenario(dir, bin));
}

async function unboundScenario(dir: string, bin?: string): Promise<void> {
  const procs: ChildProcess[] = [];
  let model: ReturnType<typeof startFakeModel> | undefined;
  try {
    const p = await localSession(dir, "peer", { bin });
    // After the prompt, one step per tool result: a read, a refused write, bind, rebind.
    const steps: Reply[] = [
      { tool: "mcp__grayboard__board_list", args: {} },
      { tool: "mcp__grayboard__dm_send", args: { to: "peer", body: "too early" } },
      { tool: "mcp__grayboard__bind", args: { name: "pi-tmp", create: true } },
      { tool: "mcp__grayboard__bind", args: { name: "pi-task", create: true } },
    ];
    const scripted: Rule = (req) => {
      const at = req.messages.findLastIndex((m) => m.role === "user" && messageText(m) === "start");
      if (at < 0) return undefined;
      const done = req.messages.slice(at + 1).filter((m) => m.role === "assistant").length;
      return steps[done] ?? { text: "bound" };
    };
    model = startFakeModel([
      onChannelDm("peer", (id) => ({ tool: "mcp__grayboard__dm_send", args: { to: "peer", body: "pong", parent_id: id } })),
      scripted,
    ]);
    const { requests } = model;
    const pi = startPi(dir, model.port, procs, { bin, identity: null });
    await pi.command({ type: "get_state" });
    await pi.command({ type: "prompt", message: "start" });
    await until(() => requests.length >= 5 && pi.events.some((e) => e.type === "agent_settled"), 30_000, "scripted turn");

    const results = (await pi.messages()).filter((m) => m.role === "toolResult");
    expect(results.map((m) => [m.toolName, !!m.isError])).toEqual([
      ["mcp__grayboard__board_list", false],
      ["mcp__grayboard__dm_send", true],
      ["mcp__grayboard__bind", false],
      ["mcp__grayboard__bind", false],
    ]);
    expect(JSON.stringify(results[1]!.content)).toContain("no bus name yet");
    expect(JSON.stringify(results[2]!.content)).toContain('Bound to \\"pi-tmp\\"');
    expect(JSON.stringify(results[3]!.content)).toContain('Bound to \\"pi-task\\" (was \\"pi-tmp\\")');
    expect(systemText(requests[0]!.body)).toContain("This session has no bus name yet");
    expect(grayboardChildren(pi.pid, bin)).toHaveLength(1);

    // The bound name receives: a DM triggers a turn whose system prompt is the
    // bound one, in full after the rebind.
    const before = requests.length;
    const sent = await p.call("dm_send", { to: "pi-task", body: "ping" });
    await until(() => p.pushes.find((x) => x.content.includes("pong")), 30_000, "pong at peer");
    const thread = await p.call("dm_thread", { thread: sent.message_id });
    expect(thread.map((m: any) => [m.sender, m.body])).toEqual([["peer", "ping"], ["pi-task", "pong"]]);
    const woken = requests[before]!.body;
    expect(systemText(woken)).toContain('You are identity "pi-task" on the grayboard bus');
    expect(systemText(woken)).toContain('Direct messages arrive as <channel source="grayboard"');
    expect(systemText(woken)).not.toContain("pi-tmp");
    expect(systemText(woken)).not.toContain("no bus name yet");
    expect(model.unhandled).toEqual([]);
    expect(grayboardChildren(pi.pid, bin)).toHaveLength(1);
    await pi.quit();
  } finally {
    await stopAll(procs);
    model?.stop();
  }
}

// An enabled grayboard MCP entry would give pi a second grayboard with the same
// tool names: the extension registers nothing, starts nothing, and says why.
export function piReenabledScenario(dir: string, bin?: string): Promise<void> {
  return named(async () => {
    const procs: ChildProcess[] = [];
    const model = startFakeModel([]);
    try {
      const pi = startPi(dir, model.port, procs, { bin, entry: { enabled: true } });
      await pi.command({ type: "get_state" });
      const notice = await until(() => pi.notices().find((n) => n.includes("is enabled")), 15_000, "refusal notice");
      expect(notice).toContain(join(dir, "pi-agent", "mcp.json"));
      expect(notice).toContain('"enabled": false');
      // The extension would have spawned in session_start, before pi answered
      // get_state; pi's own child for the entry is in its own process group.
      expect(adapterChildren(pi.pid, bin)).toEqual([]);
      // pi's default codemode exposure doesn't declare the entry's tools, so any
      // mcp__grayboard__ tool in the request is one the extension registered.
      await pi.command({ type: "prompt", message: "start" });
      await until(() => model.requests.length > 0, 15_000, "model call");
      expect(requestTools(model.requests[0]!).filter((n) => n.startsWith("mcp__grayboard__"))).toEqual([]);
      await pi.quit();
    } finally {
      await stopAll(procs);
      model.stop();
    }
  });
}

// No grayboard at the entry's command: the extension fails to load, with the reason.
export function piMissingBinaryScenario(dir: string): Promise<void> {
  return named(async () => {
    const procs: ChildProcess[] = [];
    const model = startFakeModel([]);
    try {
      const missing = join(dir, "no-such-grayboard");
      const pi = startPi(dir, model.port, procs, { entry: { command: missing, args: ["mcp"] } });
      expect(await pi.exited).not.toBe(0);
      expect(pi.stderr).toContain("Failed to load extension");
      expect(pi.stderr).toContain(`\`${missing} tools\` failed to run`);
    } finally {
      await stopAll(procs);
      model.stop();
    }
  });
}

// A grayboard that stops reading while it still runs (tests/support/stdin_closed.sh):
// the extension's next write fails with EPIPE, which pi survives and reports.
export function piStdinClosedScenario(dir: string): Promise<void> {
  return named(async () => {
    const procs: ChildProcess[] = [];
    const model = startFakeModel([]);
    try {
      const stub = join(ROOT, "tests/support/stdin_closed.sh");
      const pi = startPi(dir, model.port, procs, { entry: { command: stub, args: [process.execPath, CLI, "mcp", "--mode", "local"] } });
      await pi.command({ type: "get_state" });
      const notice = await until(() => pi.notices().find((n) => n.includes("stopped reading")), 15_000, "EPIPE notice");
      expect(notice).toContain("grayboard process stopped reading: ");
      expect(notice).toContain("restart pi to reconnect");
      await pi.command({ type: "get_state" });
      await pi.quit();
    } finally {
      await stopAll(procs);
      model.stop();
    }
  });
}
