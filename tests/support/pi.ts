// The pi scenario: the real pi coding agent (the pinned devDependency) and its
// built-in MCP client, in RPC mode against a scripted fake model. Local-mode
// grayboard: pi runs a tools-only `grayboard mcp` from mcp.json, and the pi
// adapter runs the push side. A peer is an MCP client like in local.test.ts.
// `bin` runs it all on a compiled grayboard (binaries.e2e.ts) instead of
// this checkout, with the adapter that binary carries.
import { expect } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { localEnv } from "./env.ts";
import { onChannelDm, messageText, startFakeModel } from "./fake_model.ts";
import { localSession, stopSession } from "./mcp.ts";
import { CLI, ROOT } from "./paths.ts";
import { until } from "./until.ts";

const ADAPTER = join(ROOT, "adapters/pi/grayboard.ts");
const PI_PKG = join(ROOT, "node_modules/@earendil-works/pi-coding-agent/package.json");
const PI = JSON.parse(readFileSync(PI_PKG, "utf8")) as { version: string; bin: { pi: string } };
const PI_CLI = join(dirname(PI_PKG), PI.bin.pi);

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
    const r = await until(() => this.events.find((e) => e.type === "response" && e.id === id), 15_000, `${cmd.type} response`);
    if (!r.success) throw new Error(`${cmd.type}: ${r.error}`);
    return r.data;
  }
  async quit(): Promise<void> {
    const exited = new Promise((r) => this.proc.once("exit", r));
    this.proc.stdin!.end();
    await exited;
  }
}

function startPi(dir: string, modelPort: number, procs: ChildProcess[], bin?: string): Pi {
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
    mcpServers: { grayboard: { ...command, env: { BUS_PUSH: "off" }, exposure: "direct" } },
  }));
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      fake: { baseUrl: `http://localhost:${modelPort}/v1`, api: "openai-completions", apiKey: "x", models: [{ id: "fake-1" }] },
    },
  }));
  const proc = spawn("node", [PI_CLI, "--mode", "rpc", "--no-session", "--offline", "--provider", "fake", "--model", "fake-1"], {
    cwd: dir,
    env: localEnv(dir, "pi", { PI_CODING_AGENT_DIR: agentDir, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" }),
    stdio: ["pipe", "pipe", "inherit"],
  });
  procs.push(proc);
  return new Pi(proc);
}

// A DM wakes the session, which replies with dm_send; a digest rides along as context.
// The caller closes the MCP sessions (closeSessions). A failure names pi's version.
export async function piScenario(dir: string, bin?: string): Promise<void> {
  try {
    await scenario(dir, bin);
  } catch (e) {
    if (e instanceof Error) e.message = `pi ${PI.version}: ${e.message}`;
    throw e;
  }
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
    const pi = startPi(dir, model.port, procs, bin);
    await pi.command({ type: "get_state" });
    await until(async () => (await p.call("peer_list")).peers.some((x: any) => x.handle === "pi"), 15_000, "pi online");

    // Digest: no model call. It reaches the session with the next wake, or with
    // the first drain if the adapter's MCP handshake finishes after this post.
    await p.call("board_post", { board: "ops", body: "deploy at 5" });
    const messages = async () => (await pi.command({ type: "get_messages" })).messages as { role: string; content: unknown }[];
    const hasDigest = async () => (await messages()).some((m) => JSON.stringify(m).includes('kind=\\"digest\\"'));
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
    const system = first.messages.filter((m) => m.role === "system" || m.role === "developer").map(messageText).join("\n");
    expect(system).toContain("<grayboard>");
    expect(system).toContain('You are identity "pi" on the grayboard bus');
    expect(first.messages.map(messageText).join("\n")).toContain(`<channel source="grayboard" message_id="${sent.message_id}" from="peer"`);
    await until(() => pi.events.some((e) => e.type === "agent_settled"), 15_000, "agent_settled");

    // One delivery, one reply: a DM pushed twice would wake the session twice.
    const copies = (await messages()).filter((m) => JSON.stringify(m).includes(`message_id=\\"${sent.message_id}\\"`));
    expect(copies).toHaveLength(1);
    expect((await p.call("dm_thread", { thread: sent.message_id })).length).toBe(2);

    // Quitting pi stops the push process and frees the identity.
    await pi.quit();
    await until(
      async () => (await p.call("peer_list", { include_offline: true })).peers.find((x: any) => x.handle === "pi")?.online === false,
      15_000,
      "pi offline",
    );
  } finally {
    // SIGTERM lets pi stop its own children; awaited (SIGKILL after 5 s) so
    // the caller's rmSync doesn't race a pi still writing in dir.
    await Promise.all(procs.map(async (p) => {
      if (p.exitCode !== null || p.signalCode !== null) return;
      const exited = new Promise((r) => p.once("exit", r));
      p.kill("SIGTERM");
      const force = setTimeout(() => p.kill("SIGKILL"), 5_000);
      await exited;
      clearTimeout(force);
    }));
    model?.stop();
  }
}
