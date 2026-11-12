// The pi scenarios: the real pi coding agent (the pinned devDependency) in RPC
// mode against a scripted fake model. Local-mode grayboard: mcp.json's
// grayboard entry is disabled, as setup writes it, and the pi adapter runs the
// session's one `grayboard mcp` and serves its tools (#182 decision 13). A
// peer is an MCP client like in local.test.ts. `bin` runs it all on a compiled
// grayboard (binaries.e2e.ts) instead of this checkout, with the adapter that
// binary carries. Server mode (#279, the hosted section below): the hosted
// extension bundle against an in-process server, no grayboard process at all.
import { expect } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { hostTools, snapshotTools, ToolProxy } from "../../adapters/hosted-core/src/proxy.ts";
import { deliveryPath } from "../../adapters/hosted-core/src/storage.ts";
import { adapterBundle } from "../../src/cli/adapters.ts" with { type: "macro" };
import { GRAYBOARD_SESSION_META } from "../../src/shared/session_meta.ts";
import { attachRoots } from "../../src/shared/attachments.ts";
import { sha256Hex } from "../../src/shared/hash.ts";
import { issueOAuth } from "../helpers/oauth.ts";
import { cleanEnv, localEnv } from "./env.ts";
import { onChannelDm, messageText, promptText, startFakeModel, type ChatRequest, type FakeModel, type Reply, type Rule } from "./fake_model.ts";
import { browse, hostedServer, seedGrant, type HostedServer } from "./hosted_oauth.ts";
import { localSession, stopSession } from "./mcp.ts";
import { CLI, ROOT } from "./paths.ts";
import { adapterChildren, grayboardChildren, grayboardChildPids, grayboardDescendants, processDescendants, sigkill, STOP_READING } from "./procs.ts";
import { until } from "./until.ts";
import { SIGNED_OUT } from "../../adapters/pi-family/always-on/always-on.ts";

const ADAPTER = join(ROOT, "adapters/pi/grayboard.ts");
const PI_PKG = join(ROOT, "node_modules/@earendil-works/pi-coding-agent/package.json");
const PI = JSON.parse(readFileSync(PI_PKG, "utf8")) as { version: string; bin: { pi: string } };
const PI_CLI = join(dirname(PI_PKG), PI.bin.pi);
const PI_ARGS = ["--mode", "rpc", "--offline", "--provider", "fake", "--model", "fake-1"];

// pi's custom provider for the fake model.
function writeModels(agentDir: string, modelPort: number): void {
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      fake: { baseUrl: `http://localhost:${modelPort}/v1`, api: "openai-completions", apiKey: "x", models: [{ id: "fake-1" }] },
    },
  }));
}

// One entry of pi's session (get_messages).
export type PiMessage = { role: string; content: unknown; toolName?: string; isError?: boolean };

// ── pi in RPC mode ───────────────────────────────────────────────────────────

// pi's RPC protocol, which omp speaks too (tests/support/omp.ts).
export class Pi {
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
  // `timeout`: a command whose handler waits on something (a sign-in) answers late.
  async command(cmd: Record<string, unknown>, timeout = 15_000): Promise<any> {
    const id = `r${++this.n}`;
    this.proc.stdin!.write(JSON.stringify({ ...cmd, id }) + "\n");
    const r = await until(() => this.events.find((e) => e.type === "response" && e.id === id), timeout, `${cmd.type} response`);
    if (!r.success) throw new Error(`${cmd.type}: ${r.error}`);
    return r.data;
  }
  async messages(): Promise<PiMessage[]> {
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
  // Match the hosted launcher's persisted-session options.
  persist?: boolean;
  session?: string;
};

export function startPi(dir: string, modelPort: number, procs: ChildProcess[], { bin, identity = "pi", entry = {}, persist = false, session }: PiOpts = {}): Pi {
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
  writeModels(agentDir, modelPort);
  const proc = spawn("node", [PI_CLI, ...PI_ARGS, ...(persist ? [] : ["--no-session"]), ...(session ? ["--session", session] : [])], {
    cwd: dir,
    env: localEnv(dir, identity ?? undefined, { PI_CODING_AGENT_DIR: agentDir, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  procs.push(proc);
  return new Pi(proc);
}

// Selected snapshots beat outgoing carry, including an explicitly empty one.
export function piLocalCarryScenario(dir: string): Promise<void> {
  return named(async () => {
    const procs: ChildProcess[] = [];
    const prefix = "mcp__grayboard__";
    const model = startFakeModel([
      scripted("bind", [
        { tool: prefix + "bind", args: { name: "pi-one", create: true } },
        { tool: prefix + "bind", args: { name: "pi-two", create: true } },
      ]),
      scripted("empty", [
        { tool: prefix + "unbind", args: { name: "pi-one" } },
        { tool: prefix + "unbind", args: { name: "pi-two" } },
      ]),
      scripted("change", [
        { tool: prefix + "bind", args: { name: "pi-three", create: true } },
        { tool: prefix + "unbind", args: { name: "pi-one" } },
      ]),
      scripted("who", [{ tool: prefix + "whoami", args: {} }]),
    ]);
    let db: Database | undefined;
    try {
      const pi = startPi(dir, model.port, procs, { identity: null, persist: true });
      const original = await pi.command({ type: "get_state" });
      await pi.command({ type: "prompt", message: "bind" });
      await idle(pi);
      db = new Database(join(dir, "bus.db"), { readonly: true });
      const inspect = async (aliases: string[]) => {
        const nth = (await pi.messages()).filter(m => m.role === "toolResult" && m.toolName === prefix + "whoami").length;
        await pi.command({ type: "prompt", message: "who" });
        const result = await toolResult(pi, "whoami", nth);
        expect(!!result.isError).toBe(false);
        await idle(pi);
        const who = JSON.parse(resultText(result));
        expect(who.aliases).toEqual(aliases);
        const state = await pi.command({ type: "get_state" });
        expect(db!.query<{ harness_session: string }, [string]>("SELECT harness_session FROM ids WHERE id = ?").get(who.id)?.harness_session).toBe(state.sessionId);
        return who.id as string;
      };
      const firstRoot = await inspect(["pi-one", "pi-two"]);
      await pi.command({ type: "new_session" });
      const empty = await pi.command({ type: "get_state" });
      expect(empty.sessionId).not.toBe(original.sessionId);
      expect(await inspect(["pi-one", "pi-two"])).not.toBe(firstRoot);
      await pi.command({ type: "prompt", message: "empty" });
      await idle(pi);
      await inspect([]);
      await pi.command({ type: "switch_session", sessionPath: original.sessionFile });
      await inspect(["pi-one", "pi-two"]);
      const { messages } = await pi.command({ type: "get_fork_messages" });
      await pi.command({ type: "fork", entryId: messages[0].entryId });
      const fork = await pi.command({ type: "get_state" });
      expect([original.sessionId, empty.sessionId]).not.toContain(fork.sessionId);
      await inspect(["pi-one", "pi-two"]);
      await pi.command({ type: "prompt", message: "change" });
      await idle(pi);
      await inspect(["pi-two", "pi-three"]);
      await pi.command({ type: "switch_session", sessionPath: original.sessionFile });
      await inspect(["pi-one", "pi-two"]);
      await pi.command({ type: "switch_session", sessionPath: empty.sessionFile });
      await inspect([]);
      expect(model.unhandled).toEqual([]);
      expect(pi.events.filter(e => e.type === "extension_error")).toEqual([]);
      await pi.quit();
    } finally {
      await stopAll(procs);
      db?.close();
      model.stop();
    }
  });
}

// The tools `grayboard tools` lists, as the extension names them in pi.
function toolNames(bin?: string): string[] {
  const r = Bun.spawnSync([...(bin ? [bin] : [process.execPath, CLI]), "tools", "--mode", "local"], { timeout: 10_000 });
  if (r.exitCode !== 0) throw new Error(`grayboard tools: ${r.stderr}`);
  return (JSON.parse(r.stdout.toString()) as { name: string }[]).map((t) => `mcp__grayboard__${t.name}`).sort();
}

export const requestTools = (req: ChatRequest): string[] => (req.tools ?? []).map((t) => t.function.name);
export const systemText = (req: ChatRequest): string =>
  req.messages.filter((m) => m.role === "system" || m.role === "developer").map(messageText).join("\n");

// SIGTERM lets the agent stop its own children; awaited (SIGKILL after 5 s) so the
// caller's rmSync doesn't race an agent still writing in dir.
export async function stopAll(procs: ChildProcess[]): Promise<void> {
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

// Unexpected child exits recover the bound name from the name record, even
// without BUS_IDENTITY. Calls made while the restart is pending wait for it;
// after three restarts, another exit leaves pi alive with a reconnect notice.
export function piLocalRestartScenario(dir: string): Promise<void> {
  return named(async () => {
    const procs: ChildProcess[] = [];
    const model = startFakeModel([
      scripted("bind", [{ tool: "mcp__grayboard__bind", args: { name: "pi-carry", create: true } }]),
      scripted("who", [{ tool: "mcp__grayboard__whoami", args: {} }]),
      onChannelDm("peer", (id) => ({ tool: "mcp__grayboard__dm_send", args: { to: "peer", body: "pong", parent_id: id } })),
    ]);
    let db: Database | undefined;
    try {
      const peer = await localSession(dir, "peer");
      const pi = startPi(dir, model.port, procs, { identity: null });
      await pi.command({ type: "get_state" });
      await pi.command({ type: "prompt", message: "bind" });
      const bound = await toolResult(pi, "bind");
      expect(!!bound.isError).toBe(false);
      await idle(pi);
      db = new Database(join(dir, "bus.db"), { readonly: true });
      const holder = () => db!.query<{ id: string }, []>("SELECT id FROM alias_holds WHERE address = 'pi-carry'").get()?.id;
      let previous = holder()!;
      expect(previous).toBeDefined();

      for (let attempt = 0; attempt < 3; attempt++) {
        const [dead] = grayboardChildPids(pi.pid);
        expect(dead).toBeDefined();
        await sigkill(dead!);
        // Do not wait for a replacement: the 1 s and 5 s backoffs are still
        // pending when this call reaches the adapter.
        await pi.command({ type: "prompt", message: "who" });
        const result = await toolResult(pi, "whoami", attempt);
        expect(!!result.isError).toBe(false);
        const who = JSON.parse(resultText(result));
        expect(who.primary).toBe("pi-carry");
        expect(who.aliases).toEqual(["pi-carry"]);
        expect(who.id).not.toBe(previous);
        expect(holder()).toBe(who.id);
        previous = who.id;
        const [live] = grayboardChildPids(pi.pid);
        expect(grayboardChildPids(pi.pid)).toHaveLength(1);
        expect(live).not.toBe(dead);
        await idle(pi);
      }

      // The new child still owns delivery, not just the tool transport.
      const sent = await peer.call("dm_send", { to: "pi-carry", body: "ping" });
      await until(() => peer.pushes.find((p) => p.content.includes("pong")), 15_000, "pong after restart");
      expect((await peer.call("dm_thread", { thread: sent.message_id })).map((m: { sender: string; body: string }) => [m.sender, m.body])).toEqual([["peer", "ping"], ["pi-carry", "pong"]]);
      await idle(pi);

      const [last] = grayboardChildPids(pi.pid);
      await sigkill(last!);
      const notice = await until(() => pi.notices().find((n) => n.includes("after 3 restarts; restart pi to reconnect")), 15_000, "restart exhaustion notice");
      expect(notice).toContain("grayboard process exited (SIGKILL)");
      await pi.command({ type: "prompt", message: "who" });
      const failed = await toolResult(pi, "whoami", 3);
      expect(failed.isError).toBe(true);
      expect(resultText(failed)).toContain("grayboard process exited (SIGKILL)");
      expect(grayboardChildPids(pi.pid)).toEqual([]);
      await idle(pi);

      // A new pi session clears the exhausted restart count.
      await pi.command({ type: "new_session" });
      await pi.command({ type: "prompt", message: "who" });
      const reset = await toolResult(pi, "whoami");
      expect(!!reset.isError).toBe(false);
      expect(JSON.parse(resultText(reset)).primary).toBe("pi-carry");
      await idle(pi);
      expect(model.unhandled).toEqual([]);
      await pi.quit();
      expect(grayboardChildPids(pi.pid)).toEqual([]);
    } finally {
      await stopAll(procs);
      model.stop();
      db?.close();
    }
  });
}

// /new during the longest backoff cancels the outgoing session's timer,
// whether idle or blocked in a tool wait. Observe past the timer's deadline
// to catch a late duplicate child, and verify the new child owns the name.
export function piLocalRestartShutdownScenario(dir: string, waitingTool = false): Promise<void> {
  return named(async () => {
    const procs: ChildProcess[] = [];
    const model = startFakeModel([
      scripted("bind", [{ tool: "mcp__grayboard__bind", args: { name: "pi-shutdown", create: true } }]),
      scripted("who", [{ tool: "mcp__grayboard__whoami", args: {} }]),
    ]);
    let pi: Pi | undefined;
    let db: Database | undefined;
    try {
      pi = startPi(dir, model.port, procs, { identity: null });
      const session = pi;
      await session.command({ type: "get_state" });
      await session.command({ type: "prompt", message: "bind" });
      expect(!!(await toolResult(session, "bind")).isError).toBe(false);
      await idle(session);
      db = new Database(join(dir, "bus.db"), { readonly: true });
      const holder = () => db!.query<{ id: string; pid: number; raw: string }, []>(
        "SELECT h.id, b.pid, i.harness_session AS raw FROM alias_holds h JOIN ids i ON i.id = h.id JOIN bindings b ON b.session_id = h.id WHERE h.address = 'pi-shutdown'",
      ).get();
      let previous = holder()!.id;
      for (let attempt = 0; attempt < 2; attempt++) {
        const [dead] = grayboardChildPids(session.pid);
        await sigkill(dead!);
        previous = (await until(() => { const h = holder(); return h && h.id !== previous ? h : undefined; }, 15_000, "the name restored before another kill")).id;
      }

      const [dead] = grayboardChildPids(session.pid);
      await sigkill(dead!);
      await until(() => session.notices().some((n) => n.includes("restarting it (3 of 3)")), 1_000, "5 s backoff scheduled");
      if (waitingTool) {
        await session.command({ type: "prompt", message: "who" });
        await until(() => session.events.some((e) => e.type === "tool_execution_start" && e.toolName === "mcp__grayboard__whoami"), 1_000, "the tool waiting on the backoff");
      }
      // No tool call in the idle case. The busy case must abort its wait
      // rather than making /new sit through the remaining 5 s backoff.
      await session.command({ type: "new_session" }, 2_000);
      const fresh = await session.command({ type: "get_state" });
      await until(() => holder()?.raw === fresh.sessionId, 15_000, "the new session holds the name");
      const live = grayboardChildPids(session.pid);
      expect(live).toHaveLength(1);
      expect(holder()!.pid).toBe(live[0]);
      expect(holder()!.id).not.toBe(previous);
      // A negative assertion needs the old timer's complete 5 s window.
      await Bun.sleep(5_500);
      expect(grayboardChildPids(session.pid)).toEqual(live);
      expect(holder()).toMatchObject({ pid: live[0], raw: fresh.sessionId });
      expect(model.unhandled).toEqual([]);
      await session.quit();
    } finally {
      // Mutation runs may leave a duplicate child the adapter no longer owns.
      for (const p of pi ? processDescendants(pi.pid) : []) {
        try { process.kill(p.pid, "SIGKILL"); } catch {}
      }
      await stopAll(procs);
      model.stop();
      db?.close();
    }
  });
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
    // After the prompt, one step per tool result: a read, a write as the
    // session's ID (#284 S13), bind, a second bind, unbind of the first
    // (#284 S1: how a session moves to another name).
    const steps: Reply[] = [
      { tool: "mcp__grayboard__board_list", args: {} },
      { tool: "mcp__grayboard__dm_send", args: { to: "peer", body: "as my id" } },
      { tool: "mcp__grayboard__bind", args: { name: "pi-tmp", create: true } },
      { tool: "mcp__grayboard__bind", args: { name: "pi-task", create: true } },
      { tool: "mcp__grayboard__unbind", args: { name: "pi-tmp" } },
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
    await until(() => requests.length >= 6 && pi.events.some((e) => e.type === "agent_settled"), 30_000, "scripted turn");

    const results = (await pi.messages()).filter((m) => m.role === "toolResult");
    expect(results.map((m) => [m.toolName, !!m.isError])).toEqual([
      ["mcp__grayboard__board_list", false],
      ["mcp__grayboard__dm_send", false],
      ["mcp__grayboard__bind", false],
      ["mcp__grayboard__bind", false],
      ["mcp__grayboard__unbind", false],
    ]);
    const asId = await until(() => p.pushes.find((x) => x.content === "as my id"), 10_000, "the ID's DM at peer");
    expect(asId.meta.from).toMatch(/^id:/);
    expect(JSON.stringify(results[2]!.content)).toContain('Bound to \\"pi-tmp\\"');
    expect(JSON.stringify(results[3]!.content)).toContain('you hold \\"pi-tmp\\", \\"pi-task\\" and send as \\"pi-tmp\\"');
    expect(JSON.stringify(results[4]!.content)).toContain('\\"pi-task\\"');
    expect(systemText(requests[0]!.body)).toContain(`This session has no bus name yet, so it acts as its ID: peers reach it at ${asId.meta.from}`);
    expect(grayboardChildren(pi.pid, bin)).toHaveLength(1);

    // The bound name receives: a DM triggers a turn whose system prompt is the
    // bound one, in full after the move.
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

// pi-subagents' detached runner (#523 step 5). pi-subagents isn't a
// dependency here, so the closest real path stands in for it: a second real
// pi, in print mode, that the root pi's bash tool execs with the env the
// runner gets (PI_SUBAGENT_CHILD=1, PI_SUBAGENT_PARENT_SESSION). Like the
// runner, it is a direct process child of the root pi in a process group of
// its own (spawned detached) that loads this extension. Three runners: one
// whose parent session no live session recorded is its own session from its
// start; one acts as the root's child, writing as the root's name with its
// child ID as via, then binds a name, which promotes it to its own session
// that receives the name's DMs; one acts as the child until the root pi is
// killed while it runs on, then is its own session.
export function piRunnerScenario(dir: string): Promise<void> {
  const gate = (name: string) => join(dir, `gate-${name}`);
  const pidFile = (name: string) => join(dir, `runner-${name}.pid`);
  const node = Bun.which("node");
  let rootSession = "";
  // The root's one step: exec runner `name`, whose parent session is `parent`.
  const launch = (name: string, parent: () => string): Rule => (req) => scripted(`launch ${name}`, [{
    tool: "bash",
    args: { command: `echo $$ > '${pidFile(name)}'; exec env PI_SUBAGENT_CHILD=1 PI_SUBAGENT_PARENT_SESSION='${parent()}' '${node}' '${PI_CLI}' -p --offline --provider fake --model fake-1 --no-session 'runner ${name}'` },
  }])(req);
  const wait = (name: string): Reply => ({ tool: "bash", args: { command: `while [ ! -f '${gate(name)}' ]; do sleep 0.1; done` } });
  const whoami: Reply = { tool: "mcp__grayboard__whoami", args: {} };
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  return named(async () => {
    const procs: ChildProcess[] = [];
    const model = startFakeModel([
      launch("orphan", () => "no-such-session"),
      launch("promote", () => rootSession),
      launch("fallback", () => rootSession),
      scripted("runner orphan", [whoami]),
      scripted("runner promote", [
        whoami,
        { tool: "mcp__grayboard__dm_send", args: { to: "peer", body: "from the runner" } },
        { tool: "mcp__grayboard__bind", args: { name: "pi-runner", create: true } },
        wait("promoted"),
      ]),
      scripted("runner fallback", [whoami, wait("killed"), whoami]),
      onChannelDm("peer", (id) => ({ tool: "mcp__grayboard__dm_send", args: { to: "peer", body: "pong", parent_id: id } })),
    ]);
    let db: Database | undefined;
    try {
      const peer = await localSession(dir, "peer");
      const pi = startPi(dir, model.port, procs);
      rootSession = (await pi.command({ type: "get_state" })).sessionId;
      await until(async () => (await peer.call("peer_list")).peers.some((x: { handle: string }) => x.handle === "pi"), 15_000, "pi online");
      db = new Database(join(dir, "bus.db"));
      const bus = db;
      const idRow = (id: string) => bus.query<{ root_id: string | null; ended_at: number | null; harness_session: string | null }, [string]>(
        `SELECT root_id, ended_at, harness_session FROM ids WHERE id = ?`).get(id);
      const audit = (action: string) => bus.query<{ actor: string; target: string; detail: string }, [string]>(
        `SELECT actor, target, detail FROM audit_log WHERE action = ? ORDER BY rowid`).all(action)
        .map((r) => ({ ...r, detail: JSON.parse(r.detail) as Record<string, unknown> }));
      // The fake model's requests in the conversation `prompt` started, and the tool results its latest carries.
      const asked = (prompt: string) => model.requests.map((r) => r.body).filter((b) => b.messages.some((m) => m.role === "user" && promptText(m) === prompt));
      const results = (prompt: string) => (asked(prompt).at(-1)?.messages ?? []).filter((m) => m.role === "tool").map(messageText);
      // Runner `name` exited: the root's next request carries its bash result.
      const ran = async (name: string) => {
        await until(() => asked(`launch ${name}`).some((b) => b.messages.some((m) => m.role === "tool")), 60_000, `runner ${name} exited`);
        await idle(pi);
      };
      // The root pi's session, which recorded its pi session id.
      const root = bus.query<{ id: string }, [string]>(`SELECT id FROM ids WHERE harness_session = ? AND root_id IS NULL AND ended_at IS NULL`).get(rootSession)?.id;
      if (root === undefined) throw new Error(`no live session recorded pi session ${rootSession}`);

      // No live session recorded its parent session: its own session from the start, unbound.
      await pi.command({ type: "prompt", message: "launch orphan" });
      await ran("orphan");
      const orphan = JSON.parse(results("runner orphan")[0]!);
      expect(orphan).toEqual({ id: orphan.id, primary: orphan.id, aliases: [], principal: null });
      expect(orphan.id).not.toBe(root);
      expect(audit("id.child_fallback")).toEqual([{
        actor: orphan.id, target: orphan.id,
        detail: { parent_session: "no-such-session", why: "no live session recorded harness session no-such-session", pid: expect.any(Number) },
      }]);
      expect(idRow(orphan.id)).toMatchObject({ root_id: null, harness_session: expect.any(String) });

      // The root's child: it writes as the root's name with its ID as via,
      // and its bind promotes it to its own session, which receives.
      await pi.command({ type: "prompt", message: "launch promote" });
      const promoted = await until(() => audit("id.promoted").at(0), 60_000, "the runner's bind");
      // The ping goes once the model has the bind's result, so it is answering
      // with the gate step: pi steers a push in after the step running when it
      // lands, and one landing during the bind would come before the gate step,
      // which the scripted model takes as having acted on it.
      await until(() => results("runner promote").some((t) => t.includes('Bound to "pi-runner"')), 30_000, "the bind's result at the model");
      const ping = await peer.call("dm_send", { to: "pi-runner", body: "ping" });
      await until(() => bus.query<{ delivered_at: number | null }, [number]>(`SELECT delivered_at FROM messages WHERE id = ?`).get(ping.message_id)?.delivered_at, 30_000, "ping pushed to the runner");
      writeFileSync(gate("promoted"), "");
      await until(() => peer.pushes.find((x) => x.content === "pong"), 30_000, "pong from the runner");
      await ran("promote");
      const [asChild, , bound] = results("runner promote");
      const child = JSON.parse(asChild!);
      expect(child).toEqual({ id: child.id, primary: "pi", aliases: ["pi"], principal: null, root, child: true });
      // Its liveness row copies the root's (#539).
      const rootLive = bus.query<{ pid: number }, [string]>(`SELECT pid FROM bindings WHERE session_id = ?`).get(root)!.pid;
      expect(audit("id.child_seen").filter((a) => a.target === child.id)).toEqual([{
        actor: root, target: child.id,
        detail: { child: child.id, root, raw: idRow(child.id)!.harness_session, pid: expect.any(Number), liveness_pid: rootLive, parent_session: rootSession },
      }]);
      expect(bus.query(`SELECT sender, sender_id, via FROM messages WHERE body = 'from the runner'`).get()).toEqual({ sender: "pi", sender_id: child.id, via: child.id });
      expect(peer.pushes.find((x) => x.content === "from the runner")?.meta.from).toBe("pi");
      expect(bound).toContain('Bound to "pi-runner"');
      expect(promoted).toEqual({
        actor: promoted.actor, target: promoted.actor,
        detail: { child: child.id, root, pid: expect.any(Number), parent_session: rootSession, harness_session: idRow(child.id)!.harness_session },
      });
      expect(promoted.actor).not.toBe(child.id);
      expect(idRow(child.id)).toMatchObject({ root_id: root, ended_at: expect.any(Number) });
      expect(idRow(promoted.actor)).toMatchObject({ root_id: null, harness_session: idRow(child.id)!.harness_session });
      expect((await peer.call("dm_thread", { thread: ping.message_id })).map((m: { sender: string; body: string }) => [m.sender, m.body])).toEqual([["peer", "ping"], ["pi-runner", "pong"]]);
      expect(bus.query(`SELECT sender_id, via FROM messages WHERE body = 'pong'`).get()).toEqual({ sender_id: promoted.actor, via: null });
      // The root keeps its name throughout.
      expect(bus.query(`SELECT id FROM alias_holds WHERE address = 'pi'`).get()).toEqual({ id: root });

      // The root pi exits while its child runs on (SIGKILL: no shutdown of
      // its process children, as when pi-subagents' parent exits): the
      // child's next call finds no live root and it is its own session.
      await pi.command({ type: "prompt", message: "launch fallback" });
      await until(() => asked("runner fallback").length >= 2 && existsSync(pidFile("fallback")), 60_000, "the runner at its gate");
      process.kill(pi.pid, "SIGKILL");
      await pi.exited;
      await until(() => idRow(root)?.ended_at, 15_000, "the root session ended");
      writeFileSync(gate("killed"), "");
      const runner = Number(readFileSync(pidFile("fallback"), "utf8"));
      await until(() => !alive(runner), 60_000, "the orphaned runner exited");
      const [first, , second] = results("runner fallback");
      const before = JSON.parse(first!), after = JSON.parse(second!);
      expect(before).toEqual({ id: before.id, primary: "pi", aliases: ["pi"], principal: null, root, child: true });
      expect(after).toEqual({ id: after.id, primary: after.id, aliases: [], principal: null });
      expect(after.id).not.toBe(before.id);
      expect(audit("id.child_fallback").filter((a) => a.actor === after.id)).toEqual([{
        actor: after.id, target: after.id,
        detail: { child: before.id, root, pid: expect.any(Number), parent_session: rootSession, harness_session: idRow(before.id)!.harness_session },
      }]);
      expect(idRow(before.id)).toMatchObject({ root_id: root, ended_at: expect.any(Number) });
      expect(idRow(after.id)).toMatchObject({ root_id: null, harness_session: idRow(before.id)!.harness_session });
      expect(model.unhandled).toEqual([]);
    } finally {
      // A runner left at a gate by a failure: its whole process group.
      for (const name of ["orphan", "promote", "fallback"]) {
        const pid = existsSync(pidFile(name)) ? Number(readFileSync(pidFile(name), "utf8")) : 0;
        if (pid > 0 && alive(pid)) process.kill(-pid, "SIGKILL");
      }
      await stopAll(procs);
      model.stop();
      db?.close();
    }
  });
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
      expect(requestTools(model.requests[0]!.body).filter((n) => n.startsWith("mcp__grayboard__"))).toEqual([]);
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
// pi survives EPIPE, retries, and reports exhaustion without leaving children.
export function piStdinClosedScenario(dir: string): Promise<void> {
  return named(async () => {
    const procs: ChildProcess[] = [];
    const model = startFakeModel([]);
    let pi: Pi | undefined;
    try {
      const stub = join(ROOT, "tests/support/stdin_closed.sh");
      pi = startPi(dir, model.port, procs, { entry: { command: stub, args: [process.execPath, CLI, "mcp", "--mode", "local"] } });
      const session = pi;
      await session.command({ type: "get_state" });
      const notice = await until(() => session.notices().find((n) => n.includes("stopped reading") && n.includes("after 3 restarts")), 15_000, "EPIPE restart exhaustion notice");
      expect(notice).toContain("grayboard process stopped reading: ");
      expect(notice).toContain("restart pi to reconnect");
      // The stub execs sleep, so grayboard-only process filters miss it.
      await until(() => processDescendants(session.pid).length === 0, 1_000, "no EPIPE stub descendants after give-up");
      expect(processDescendants(session.pid)).toEqual([]);
      await session.command({ type: "get_state" });
      await session.quit();
    } finally {
      for (const p of pi ? processDescendants(pi.pid) : []) {
        try { process.kill(p.pid, "SIGKILL"); } catch {}
      }
      await stopAll(procs);
      model.stop();
    }
  });
}

// A grayboard that stops reading while it still runs and holds the name
// (tests/support/stops_reading.ts, whose SIGTERM ends it a second late): the
// adapter's next write fails with EPIPE, and it waits for that process to
// exit before the replacement starts, so the replacement takes the name back
// and no stale delivery owner remains (#599, omp's #580).
export function piLocalStopsReadingScenario(dir: string): Promise<void> {
  return named(async () => {
    const procs: ChildProcess[] = [];
    const model = startFakeModel([
      scripted("bind", [{ tool: "mcp__grayboard__bind", args: { name: "pi-599", create: true } }]),
      scripted("stop", [{ tool: "mcp__grayboard__dm_send", args: { to: "peer", body: STOP_READING } }]),
      // A small write to a closed pipe can succeed; a large one raises EPIPE.
      scripted("big", [{ tool: "mcp__grayboard__dm_send", args: { to: "peer", body: "x".repeat(128_000) } }]),
      scripted("who", [{ tool: "mcp__grayboard__whoami", args: {} }]),
    ]);
    let pi: Pi | undefined;
    let db: Database | undefined;
    // Every relay and grayboard pid seen, SIGKILLed at the end: on a regression
    // the stale pair outlives pi, which only stops the child it still owns.
    const seen = new Set<number>();
    const grayboards = (pid: number) => {
      const pids = grayboardChildPids(pid).flatMap((relay) => [relay, ...processDescendants(relay).filter((p) => p.command.includes(CLI)).map((p) => p.pid)]);
      for (const p of pids) seen.add(p);
      return pids;
    };
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    try {
      await localSession(dir, "peer");
      pi = startPi(dir, model.port, procs, {
        identity: null,
        entry: {
          command: process.execPath,
          args: [join(ROOT, "tests/support/stops_reading.ts"), process.execPath, CLI, "mcp", "--mode", "local"],
          env: { BUS_PUSH: "off", BUS_TEST_STOP_READING: join(dir, "stopped"), BUS_TEST_STOP_READING_ON: STOP_READING },
        },
      });
      const session = pi;
      await session.command({ type: "get_state" });
      await session.command({ type: "prompt", message: "bind" });
      expect(!!(await toolResult(session, "bind")).isError).toBe(false);
      await idle(session);
      db = new Database(join(dir, "bus.db"), { readonly: true });
      const holder = () => db!.query<{ id: string }, []>("SELECT id FROM alias_holds WHERE address = 'pi-599'").get()?.id;
      const first = holder()!;
      expect(first).toBeDefined();

      await session.command({ type: "prompt", message: "stop" });
      expect(!!(await toolResult(session, "dm_send")).isError).toBe(false);
      await idle(session);
      // The relay and the one grayboard behind it.
      const stale = grayboards(session.pid);
      expect(stale).toHaveLength(2);

      await session.command({ type: "prompt", message: "big" });
      expect(resultText(await toolResult(session, "dm_send", 1))).toContain("grayboard process stopped reading");
      await idle(session);
      await until(() => !stale.some(alive), 10_000, "the process that stopped reading killed");
      await until(() => { const h = holder(); return h !== undefined && h !== first; }, 15_000, "pi-599 held by the replacement");
      const replacement = grayboards(session.pid);
      expect(replacement).toHaveLength(2);
      expect(db.query<{ ended_at: number | null }, [string]>("SELECT ended_at FROM ids WHERE id = ?").get(first)?.ended_at).not.toBeNull();

      await session.command({ type: "prompt", message: "who" });
      const who = await toolResult(session, "whoami");
      expect(!!who.isError).toBe(false);
      expect(JSON.parse(resultText(who)).primary).toBe("pi-599");
      await idle(session);
      expect(model.unhandled).toEqual([]);
      await session.quit();
      await until(() => !replacement.some(alive), 5_000, "the replacement ended with pi");
    } finally {
      for (const p of seen) {
        try { process.kill(p, "SIGKILL"); } catch {}
      }
      await stopAll(procs);
      model.stop();
      db?.close();
    }
  });
}

// ── hosted (server mode, #279) ───────────────────────────────────────────────
// The hosted extension exactly as the binary embeds it (adapterBundle, the
// CLI's macro), set up as `grayboard setup --server` leaves it:
// <agentDir>/extensions/grayboard.js, <agentDir>/grayboard/config.json {url}
// and no grayboard MCP entry. A no-op `open`/`xdg-open` leads PATH, so a
// sign-in opens no browser; the test walks the URL pi prints through the
// server's consent page (browse). The peer is bob on the omp client, an MCP
// client with an issued grant.

const BUNDLE = adapterBundle("pi");
const PI_CLIENT = "grayboard-pi";
export const PEER = "bob@example.com/peer";
const LOGIN_NOTICE = "grayboard: Signed out of grayboard in pi; run /grayboard login";
const HELD = "another pi process holds delivery for this session";
const GRAYBOARD_TOOLS = hostTools(snapshotTools()).map((t) => `mcp__grayboard__${t.name}`).sort();

const agentDirOf = (dir: string) => join(dir, "pi-agent");
const stateDirOf = (dir: string) => join(agentDirOf(dir), "grayboard");

// Written once per scenario, before any pi starts: a second pi on the same
// agentDir must not rewrite a bundle the first may be loading.
function installHosted(dir: string, srv: HostedServer, modelPort: number): void {
  const agentDir = agentDirOf(dir), bin = join(dir, "bin");
  for (const d of [join(agentDir, "extensions"), stateDirOf(dir), bin, join(dir, "home")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(agentDir, "extensions", "grayboard.js"), BUNDLE);
  writeFileSync(join(stateDirOf(dir), "config.json"), JSON.stringify({ url: srv.resource }));
  writeModels(agentDir, modelPort);
  for (const opener of ["open", "xdg-open"]) writeFileSync(join(bin, opener), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

// `persist` keeps pi's session files (/fork, /new, /resume need them);
// `session` opens one of them.
function startHostedPi(dir: string, procs: ChildProcess[], { persist = false, session }: { persist?: boolean; session?: string } = {}): Pi {
  const agentDir = agentDirOf(dir);
  const proc = spawn("node", [PI_CLI, ...PI_ARGS, ...(persist ? [] : ["--no-session"]), ...(session ? ["--session", session] : [])], {
    cwd: dir,
    env: cleanEnv({
      HOME: join(dir, "home"), GRAYBOARD_ATTACHMENTS_DIR: join(dir, "saved"), PATH: `${join(dir, "bin")}${delimiter}${process.env.PATH}`,
      PI_CODING_AGENT_DIR: agentDir, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
    }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  procs.push(proc);
  return new Pi(proc);
}

export type Peer = { dir: string; reports: string[]; call(tool: string, args?: Record<string, unknown>): Promise<any>; close(): Promise<void> };

export async function hostedPeer(srv: HostedServer, dir: string): Promise<Peer> {
  const home = join(dir, "peer");
  mkdirSync(home, { recursive: true });
  const { token } = issueOAuth(srv.app.repo, srv.resource, "bob@example.com", ["grayboard:delivery", "grayboard:tools"], Date.now(), "grayboard-omp");
  const reports: string[] = [];
  const proxy = new ToolProxy({
    wire: { url: srv.resource, sessionKey: GRAYBOARD_SESSION_META, client: { name: "grayboard-omp", version: "1.0.0" }, delivery: { mode: "poll", source: "grayboard" } },
    harness: "omp", loginAction: "log in", auth: { token: async () => token },
    roots: attachRoots({ BUS_ATTACH_ROOTS: home }, home), env: { GRAYBOARD_ATTACHMENTS_DIR: join(home, "saved") },
    report: (operation, error) => { reports.push(`${operation}: ${String(error)}`); },
  });
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const result = await proxy.call(tool, args, "peer-session");
    const text = result.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    if (result.isError) throw new Error(`peer ${tool}: ${text}`);
    return result.structuredContent ?? JSON.parse(text);
  };
  await call("bind", { name: "peer", create: true });
  return { dir: home, reports, call, close: () => proxy.close() };
}

type HostedRow = { name: string | null; lease_deadline: number | null; ownership_id: number };

export const resultText = (m: PiMessage): string => (m.content as { text?: string }[]).map((b) => b.text ?? "").join("\n");
// The `nth` result of the tool named `name` (with its harness prefix) in the session.
export const toolResultNamed = (pi: Pi, name: string, nth = 0): Promise<PiMessage> =>
  until(async () => (await pi.messages()).filter((m) => m.role === "toolResult" && m.toolName === name)[nth], 30_000, `${name} result #${nth}`);
const toolResult = (pi: Pi, tool: string, nth = 0): Promise<PiMessage> => toolResultNamed(pi, `mcp__grayboard__${tool}`, nth);
// pi finished its run: nothing streaming, nothing queued.
const idle = (pi: Pi) => until(async () => {
  const s = await pi.command({ type: "get_state" });
  return !s.isStreaming && s.pendingMessageCount === 0;
}, 15_000, "pi idle");

// `/grayboard status`, as pi and omp show it.
export async function statusOf(pi: Pi): Promise<string> {
  const before = pi.notices().length;
  await pi.command({ type: "prompt", message: "/grayboard status" });
  return until(() => pi.notices().slice(before).find((n) => n.startsWith("grayboard: server: ")), 5_000, "/grayboard status");
}

// The hosted session `client` keeps for the harness session `raw`.
export const hostedRow = (srv: HostedServer, client: string, raw: string): HostedRow | undefined => srv.app.db.query<HostedRow, [string, string]>(
  "SELECT (SELECT substr(address, instr(address, '/') + 1) FROM alias_holds WHERE id = session_id ORDER BY bound_at, address LIMIT 1) AS name, lease_deadline, ownership_id FROM hosted_sessions WHERE client_id = ? AND source_session_id = ?").get(client, raw) ?? undefined;
// `raw`'s hosted session holds `name` and the server's one delivery lease.
export const leased = (srv: HostedServer, client: string, raw: string, name: string): boolean => {
  const row = hostedRow(srv, client, raw);
  return row?.name === name && row.lease_deadline !== null && srv.app.mcp.activeLeases === 1;
};
// The model and effort the server holds for `raw`'s hosted session (#364).
export const factsOf = (srv: HostedServer, client: string, raw: string) => srv.app.db.query<{ model: string | null; effort: string | null }, [string, string]>(
  "SELECT model, effort FROM ids WHERE id = (SELECT session_id FROM hosted_sessions WHERE client_id = ? AND source_session_id = ?)").get(client, raw) ?? undefined;
const piRow = (srv: HostedServer, raw: string) => hostedRow(srv, PI_CLIENT, raw);
const leasedAs = (srv: HostedServer, raw: string, name: string) => leased(srv, PI_CLIENT, raw, name);
export const ownershipEnded = (srv: HostedServer, id: number): boolean =>
  srv.app.db.query<{ ended_at: number | null }, [number]>("SELECT ended_at FROM hosted_ownerships WHERE id = ?").get(id)?.ended_at != null;

// After the user prompt `prompt` (the latest; <channel> deliveries aren't
// prompts), one step per assistant message; past the last, the default reply
// ends the turn.
export function scripted(prompt: string, steps: Reply[]): Rule {
  return (req) => {
    const at = req.messages.findLastIndex((m) => m.role === "user" && !promptText(m).startsWith("<channel"));
    if (at < 0 || promptText(req.messages[at]!) !== prompt) return undefined;
    return steps[req.messages.slice(at + 1).filter((m) => m.role === "assistant").length];
  };
}

// The model's side of a peer DM, with the harness's grayboard tool prefix: a
// file it saves, anything else it answers "pong".
export const answerPeer = (prefix: string): Rule => onChannelDm(PEER, (id, text) => {
  const file = /attachments="(\d+):/.exec(text);
  return file
    ? { tool: `${prefix}attachment_get`, args: { id: Number(file[1]) } }
    : { tool: `${prefix}dm_send`, args: { to: PEER, body: "pong", parent_id: id } };
});

// A DM from the peer to `name` starts a turn in the session holding it,
// whose dm_send reply lands in the same thread, sent as `name`. Returns the
// DM's id. `resend`: a scenario pings the same name more than once, and an
// identical dm_send within 10 minutes returns the first message instead.
export async function pingPong(srv: HostedServer, peer: Peer, name: string): Promise<number> {
  const { message_id: id } = await peer.call("dm_send", { to: `alice@example.com/${name}`, body: `ping ${name}`, resend: true });
  const reply = await until(() => srv.app.db.query<{ sender: string }, [number]>("SELECT sender FROM messages WHERE parent_id = ? AND body = 'pong'").get(id), 30_000, `pong to DM ${id}`);
  expect(reply.sender).toBe(`alice@example.com/${name}`);
  return id;
}

// The session file `file` records each of `pings` (DM ids, in order) admitted
// under `root` and then receipted, and no message body in those records; it
// never holds omp's hidden instructions message, which isn't persisted (#441).
export async function expectDeliveryRecords(file: string, root: string, pings: number[], name: string): Promise<void> {
  type Entry = { event: "admitted"; root: string; itemId: string; stableID: string; wake: boolean } | { event: "receipted"; root: string; itemIds: string[] };
  type Line = { type: string; customType?: string; data?: Entry };
  const want = pings.map((p) => `direct:${p}`);
  // A line the harness is still writing doesn't parse yet: skipped, read next time.
  const lines = () => readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l): Line[] => {
    try { return [JSON.parse(l) as Line]; } catch { return []; }
  });
  const read = () => lines().filter((e) => e.type === "custom" && e.customType === "grayboard-delivery").map((e) => e.data!);
  const entries = await until(() => {
    const r = read();
    const receipted = r.flatMap((e) => e.event === "receipted" ? e.itemIds : []);
    return want.every((id) => receipted.includes(id)) ? r : undefined;
  }, 15_000, `receipts for ${want.join(", ")} in ${file}`);
  expect(lines().filter((e) => e.customType === "grayboard-instructions")).toEqual([]);
  const admitted = entries.filter((e) => e.event === "admitted");
  expect(admitted.map((e) => e.itemId)).toEqual(want);
  for (const e of entries) expect(e.root).toBe(root);
  for (const e of admitted) expect(e).toMatchObject({ wake: true, stableID: expect.any(String) });
  // Each receipt follows its admission.
  for (const id of want) {
    const at = entries.findIndex((e) => e.event === "admitted" && e.itemId === id);
    expect(entries.findIndex((e) => e.event === "receipted" && e.itemIds.includes(id))).toBeGreaterThan(at);
  }
  expect(JSON.stringify(entries)).not.toContain(`ping ${name}`);
}

// After a sign-out, a signed-out tool call offers a sign-in (#499): the
// result says the user has the link ahead of the unchanged refusal, never
// the URL itself (#500), and so does a second refused call while the flow
// is pending; the URL is on the notice line only (once: the second call
// joins the flow), the server's consent page approves it, and the next call runs. `check` prompts the scripted
// whoami; `results` is how many whoami results the session already holds.
export async function expectSignInOffer(srv: HostedServer, proc: Pi, harness: string, o: { results: number; whoami(nth: number): Promise<PiMessage>; idle(proc: Pi): Promise<unknown> }): Promise<void> {
  const check = async (nth: number) => {
    await proc.command({ type: "prompt", message: "check" });
    const result = await o.whoami(nth);
    await o.idle(proc);
    return result;
  };
  const offered = async (nth: number) => {
    const result = await check(nth);
    expect(result.isError).toBe(true);
    const text = resultText(result);
    expect(text).toBe(`grayboard: sign-in started: ask the user to open the link ${harness} shows (/grayboard login shows it again), then call a grayboard tool again\nerror: Signed out of grayboard in ${harness}; run /grayboard login`);
    expect(text).not.toContain(srv.issuer);
  };
  const seen = proc.notices().length;
  await offered(o.results);
  await offered(o.results + 1);
  // The offer opened no browser: the URL went to the notice line alone, once.
  const urls = proc.notices().slice(seen).map((n) => /^grayboard: sign in at (\S+)$/.exec(n)?.[1]).filter(Boolean);
  expect(urls).toHaveLength(1);
  const url = urls[0]!;
  expect(url).toStartWith(`${srv.issuer}/`);
  expect(await browse(srv.issuer, url, harness)).toContain("Signed in to grayboard");
  await until(() => proc.notices().includes("grayboard: signed in"), 15_000, "the signed-in notice");
  const ran = await check(o.results + 2);
  expect(ran.isError).toBeFalsy();
  expect(resultText(ran)).not.toContain("Signed out");
}

type Hosted = { srv: HostedServer; model: FakeModel; peer: Peer; start(o?: { persist?: boolean; session?: string }): Pi };

// A server, the fake model (answerPeer first, then `rules`), the peer and the
// installed extension; `run` starts the pi processes. Everything stops after.
function withHosted(dir: string, rules: Rule[], run: (h: Hosted) => Promise<void>): Promise<void> {
  return named(async () => {
    const procs: ChildProcess[] = [];
    const srv = hostedServer();
    const model = startFakeModel([answerPeer("mcp__grayboard__"), ...rules]);
    let peer: Peer | undefined;
    try {
      peer = await hostedPeer(srv, dir);
      installHosted(dir, srv, model.port);
      await run({ srv, model, peer, start: (o) => startHostedPi(dir, procs, o) });
      expect(model.unhandled).toEqual([]);
      expect(peer.reports).toEqual([]);
    } finally {
      await stopAll(procs);
      await peer?.close();
      model.stop();
      await srv.stop();
    }
  });
}

// The spec's load smoke for pi (#279; omp's: ompHostedScenario): the bundle the
// CLI's macro emits, loaded by the pinned pi under Node with an isolated HOME
// and a seeded grant. No load failure and no login notice: it loaded and read
// the grant. The status's session line carries pi's own id: session_start
// ran. The root's unbound Controller line only appears after the Controller's
// whoami round trip: the bundle's @modelcontextprotocol/client Client
// connected under Node. The delivery lock file exists and no `delivery:` line
// shows: node:sqlite opened it and BEGIN EXCLUSIVE took it. No grayboard
// process runs, and quitting leaves nothing leased. The hand-run probe's
// `ctx.agent?.kind` isn't asserted: pi 1.4.0 has no agent kind and the pi
// entry never reads it (omp's entry does).
export function piHostedLoadSmoke(dir: string): Promise<void> {
  return withHosted(dir, [], async ({ srv, start }) => {
    await seedGrant(srv, stateDirOf(dir), PI_CLIENT);
    const pi = start();
    const { sessionId } = await pi.command({ type: "get_state" });
    const controller = `\n  ${sessionId}: unbound, Root approved, unbound; bind(name) to take one`;
    const status = await until(async () => {
      const s = await statusOf(pi);
      return s.includes(controller) ? s : undefined;
    }, 15_000, "the root's Controller line");
    expect(status).toContain(`\nsign-in: signed in\nsession: ${sessionId} (root)\n`);
    expect(status).not.toContain("\ndelivery: ");
    expect(pi.stderr).not.toContain("Failed to load extension");
    expect(pi.events.filter((e) => e.type === "extension_error")).toEqual([]);
    expect(pi.notices()).not.toContain(LOGIN_NOTICE);
    expect(existsSync(deliveryPath(stateDirOf(dir), srv.resource, PI_CLIENT, sessionId))).toBe(true);
    expect(piRow(srv, sessionId)?.name).toBeNull();
    expect(grayboardDescendants(pi.pid)).toEqual([]);
    await pi.quit();
    await until(() => srv.app.mcp.activeLeases === 0, 10_000, "nothing leased after quit");
  });
}

// Signed out at start, the extension says how to sign in; /grayboard login
// walks the server's real consent page; bind through the model's tool call
// takes the delivery lease; a peer's DM arrives as a new turn once and its
// receipt advances the cursor; a local file goes out with dm_send and a
// peer's file comes in with attachment_get. No grayboard process runs.
export function piHostedScenario(dir: string): Promise<void> {
  const report = "quarterly report\n", notes = "peer notes\n";
  return withHosted(dir, [
    scripted("bind", [{ tool: "mcp__grayboard__bind", args: { name: "pi-task", create: true } }]),
    scripted("send report", [{ tool: "mcp__grayboard__dm_send", args: { to: PEER, body: "report attached", attachments: [join(dir, "report.txt")] } }]),
  ], async ({ srv, model, peer, start }) => {
    writeFileSync(join(dir, "report.txt"), report);
    const pi = start();
    const { sessionId } = await pi.command({ type: "get_state" });

    // Loaded with no error, and signed out: it says how to sign in.
    await until(() => pi.notices().includes(LOGIN_NOTICE), 15_000, "the login notice");
    expect(pi.stderr).not.toContain("Failed to load extension");
    expect(pi.events.filter((e) => e.type === "extension_error")).toEqual([]);
    expect(await statusOf(pi)).toContain(`grayboard: server: ${srv.resource}\nsign-in: signed out (never signed in); run /grayboard login\nsession: ${sessionId} (root)`);

    // /grayboard login prints the sign-in URL (the no-op `open` "opened" it);
    // the browser approves on the server's consent page.
    const login = pi.command({ type: "prompt", message: "/grayboard login" }, 60_000);
    const url = await until(() => pi.notices().map((n) => /^grayboard: sign in at (\S+)$/.exec(n)?.[1]).find(Boolean), 15_000, "sign-in URL");
    expect(url).toStartWith(`${srv.issuer}/`);
    expect(await browse(srv.issuer, url, "pi")).toContain("Signed in to grayboard");
    await login;
    expect(pi.notices()).toContain("grayboard: signed in");
    expect(pi.notices().filter((n) => n.includes("couldn't open a browser"))).toEqual([]);
    expect(await statusOf(pi)).toContain("\nsign-in: signed in\n");

    // The model binds through mcp__grayboard__bind, which takes the lease.
    await pi.command({ type: "prompt", message: "bind" });
    const bound = await toolResult(pi, "bind");
    expect(bound.isError).toBeFalsy();
    expect(resultText(bound)).toStartWith('Bound to "pi-task"');
    await until(() => leasedAs(srv, sessionId, "pi-task"), 15_000, "pi-task holds the lease");
    // Its requests report pi's model and thinking level (#364).
    const { thinkingLevel } = await pi.command({ type: "get_state" });
    expect(factsOf(srv, PI_CLIENT, sessionId)).toEqual({ model: "fake/fake-1", effort: thinkingLevel });
    const first = model.requests[0]!.body;
    expect(requestTools(first).filter((n) => n.startsWith("mcp__grayboard__")).sort()).toEqual(GRAYBOARD_TOOLS);
    expect(systemText(first)).toContain("no bus name yet");
    expect(grayboardDescendants(pi.pid)).toEqual([]);
    await idle(pi);

    // A DM wakes the session once: one copy, one turn, one reply; the
    // receipt moves pi-task's cursor past it.
    const asked = model.requests.length;
    const ping = await pingPong(srv, peer, "pi-task");
    await until(() => srv.app.repo.cursors.directFor("alice@example.com/pi-task") >= ping, 15_000, "the receipt advances the cursor");
    await idle(pi);
    const woken = model.requests[asked]!.body;
    expect(messageText(woken.messages.at(-1)!)).toStartWith(`<channel source="grayboard" message_id="${ping}" from="${PEER}"`);
    expect(systemText(woken)).toContain("pi-task");
    expect((await pi.messages()).filter((m) => JSON.stringify(m).includes(`message_id=\\"${ping}\\"`))).toHaveLength(1);
    expect(srv.app.db.query<{ n: number }, [number]>("SELECT count(*) AS n FROM messages WHERE parent_id = ?").get(ping)!.n).toBe(1);

    // dm_send with a local file uploads it with the message; the peer gets it intact.
    await pi.command({ type: "prompt", message: "send report" });
    const sent = await until(() => srv.app.db.query<{ id: number }, []>("SELECT id FROM messages WHERE body = 'report attached' AND sender = 'alice@example.com/pi-task'").get(), 30_000, "the report DM");
    const files = srv.app.db.query<{ id: number; filename: string; sha256: string }, [number]>("SELECT id, filename, sha256 FROM attachments WHERE message_id = ?").all(sent.id);
    expect(files).toEqual([{ id: expect.any(Number), filename: "report.txt", sha256: sha256Hex(new TextEncoder().encode(report)) }]);
    expect(readFileSync((await peer.call("attachment_get", { id: files[0]!.id })).path, "utf8")).toBe(report);
    await idle(pi);

    // A peer's file arrives with its DM; the model's attachment_get saves it
    // under GRAYBOARD_ATTACHMENTS_DIR, this bus's folder.
    writeFileSync(join(peer.dir, "notes.txt"), notes);
    const withFile = (await peer.call("dm_send", { to: "alice@example.com/pi-task", body: "notes attached", attachments: [join(peer.dir, "notes.txt")] })).message_id;
    const fileId = srv.app.db.query<{ id: number }, [number]>("SELECT id FROM attachments WHERE message_id = ?").get(withFile)!.id;
    const saved = await toolResult(pi, "attachment_get");
    expect(saved.isError).toBeFalsy();
    const got = JSON.parse(resultText(saved)) as { path: string };
    expect(got.path).toBe(join(dir, "saved", new URL(srv.resource).host.replace(/[^A-Za-z0-9.-]/g, "_"), `${fileId}-notes.txt`));
    expect(readFileSync(got.path, "utf8")).toBe(notes);
    await idle(pi);
    expect(grayboardDescendants(pi.pid)).toEqual([]);

    // Quitting releases the lease and ends the session.
    await pi.quit();
    await until(() => srv.app.mcp.activeLeases === 0 && !piRow(srv, sessionId), 10_000, "released on quit");
  });
}

// /fork is a new root with its own lease that carries the name; /new carries
// it too; /resume of the first session rebinds that session's remembered
// name. Each time the name receives in the current session.
export function piHostedCarryScenario(dir: string): Promise<void> {
  return withHosted(dir, [scripted("bind", [{ tool: "mcp__grayboard__bind", args: { name: "pi-carry", create: true } }])], async ({ srv, peer, start }) => {
    await seedGrant(srv, stateDirOf(dir), PI_CLIENT);
    const pi = start({ persist: true });
    const first = await pi.command({ type: "get_state" });
    await pi.command({ type: "prompt", message: "bind" });
    await until(() => leasedAs(srv, first.sessionId, "pi-carry"), 30_000, "first session leased as pi-carry");
    const p1 = await pingPong(srv, peer, "pi-carry");
    await idle(pi);
    const firstOwnership = piRow(srv, first.sessionId)!.ownership_id;

    // /fork: the outgoing session ends; the fork binds the name under its own ownership and lease.
    const { messages } = await pi.command({ type: "get_fork_messages" });
    await pi.command({ type: "fork", entryId: messages[0].entryId });
    const forked = await pi.command({ type: "get_state" });
    expect(forked.sessionId).not.toBe(first.sessionId);
    await until(() => leasedAs(srv, forked.sessionId, "pi-carry"), 15_000, "fork leased as pi-carry");
    expect(piRow(srv, first.sessionId)).toBeUndefined();
    expect(ownershipEnded(srv, firstOwnership)).toBe(true);
    expect(piRow(srv, forked.sessionId)!.ownership_id).not.toBe(firstOwnership);
    await pingPong(srv, peer, "pi-carry");
    await idle(pi);

    // /new carries it on.
    const forkOwnership = piRow(srv, forked.sessionId)!.ownership_id;
    await pi.command({ type: "new_session" });
    const fresh = await pi.command({ type: "get_state" });
    expect([first.sessionId, forked.sessionId]).not.toContain(fresh.sessionId);
    await until(() => leasedAs(srv, fresh.sessionId, "pi-carry"), 15_000, "new session leased as pi-carry");
    expect(piRow(srv, forked.sessionId)).toBeUndefined();
    expect(ownershipEnded(srv, forkOwnership)).toBe(true);
    const p3 = await pingPong(srv, peer, "pi-carry");
    await idle(pi);

    // /resume of the first session: it rebinds the name it remembers.
    await pi.command({ type: "switch_session", sessionPath: first.sessionFile });
    expect((await pi.command({ type: "get_state" })).sessionId).toBe(first.sessionId);
    await until(() => leasedAs(srv, first.sessionId, "pi-carry"), 15_000, "resumed first session leased as pi-carry");
    expect(piRow(srv, fresh.sessionId)).toBeUndefined();
    const p4 = await pingPong(srv, peer, "pi-carry");
    await idle(pi);
    expect(grayboardDescendants(pi.pid)).toEqual([]);
    // Each session's file records its deliveries: the first holds the DMs it
    // received before the fork and after the resume, /new's the one it did.
    await expectDeliveryRecords(first.sessionFile, first.sessionId, [p1, p4], "pi-carry");
    await expectDeliveryRecords(fresh.sessionFile, fresh.sessionId, [p3], "pi-carry");
    await pi.quit();
  });
}

// Two pi processes on one agentDir start with an expired access token: one
// refresh serves both. Then /grayboard logout in one revokes the grant and
// pauses both.
export function piHostedRefreshLogoutScenario(dir: string): Promise<void> {
  return withHosted(dir, [
    scripted("bind a", [{ tool: "mcp__grayboard__bind", args: { name: "pi-a", create: true } }]),
    scripted("bind b", [{ tool: "mcp__grayboard__bind", args: { name: "pi-b", create: true } }]),
    scripted("check", [{ tool: "mcp__grayboard__whoami", args: {} }]),
  ], async ({ srv, start }) => {
    const seeded = await seedGrant(srv, stateDirOf(dir), PI_CLIENT, "alice@example.com", -60_000);
    const refreshTokens = () => srv.app.db.query<{ n: number; spent: number }, [string]>(
      "SELECT count(*) AS n, count(spent_at) AS spent FROM oauth_tokens WHERE grant_id = ? AND kind = 'refresh'").get(seeded.grantId)!;
    expect(refreshTokens()).toEqual({ n: 1, spent: 0 });

    const a = start(), b = start();
    const [sa, sb] = await Promise.all([a.command({ type: "get_state" }), b.command({ type: "get_state" })]);
    expect(sa.sessionId).not.toBe(sb.sessionId);
    // Both reached the server on the one rotation.
    await until(() => piRow(srv, sa.sessionId) && piRow(srv, sb.sessionId), 15_000, "both sessions on the server");
    expect(refreshTokens()).toEqual({ n: 2, spent: 1 });

    await a.command({ type: "prompt", message: "bind a" });
    await b.command({ type: "prompt", message: "bind b" });
    await until(() => piRow(srv, sa.sessionId)?.name === "pi-a" && piRow(srv, sb.sessionId)?.name === "pi-b" && srv.app.mcp.activeLeases === 2, 30_000, "both leased");
    expect(refreshTokens()).toEqual({ n: 2, spent: 1 });
    await Promise.all([idle(a), idle(b)]);

    // Logout in a: the grant is revoked, so the server drops both leases,
    // and both processes pause with the login notice.
    const seenA = a.notices().length, seenB = b.notices().length;
    await a.command({ type: "prompt", message: "/grayboard logout" });
    expect(a.notices().slice(seenA)).toContain("grayboard: signed out; every pi session on this server pauses until run /grayboard login");
    await until(() => srv.app.mcp.activeLeases === 0, 15_000, "both leases dropped");
    expect(srv.app.db.query<{ revoked_at: number | null }, [string]>("SELECT revoked_at FROM oauth_grants WHERE id = ?").get(seeded.grantId)!.revoked_at).not.toBeNull();
    await until(() => b.notices().slice(seenB).includes(LOGIN_NOTICE), 15_000, "the login notice in the other process");
    for (const pi of [a, b]) {
      const status = await statusOf(pi);
      expect(status).toContain("\nsign-in: signed out (logged_out); run /grayboard login\n");
      expect(status).toMatch(/: paused, /);
    }
    // The other process's next tool call offers a sign-in; once it lands,
    // both processes' roots restart (unbound: the logout's revoke ended their sessions).
    await expectSignInOffer(srv, b, "pi", { results: 0, whoami: (nth) => toolResult(b, "whoami", nth), idle });
    for (const proc of [a, b]) await until(async () => {
      const status = await statusOf(proc);
      return status.includes("\nsign-in: signed in\n") && !status.includes("paused") ? status : undefined;
    }, 20_000, "both roots restarted signed in");
    await Promise.all([a.quit(), b.quit()]);
  });
}

// The same session opened in a second pi process: it runs tools only behind
// the first's delivery lock (its status and first tool result say so) and the
// server sees one lease holder; when the first quits, the second takes
// delivery over under the session's remembered name.
export function piHostedTwiceScenario(dir: string): Promise<void> {
  return withHosted(dir, [
    scripted("bind", [{ tool: "mcp__grayboard__bind", args: { name: "pi-twice", create: true } }]),
    scripted("check", [{ tool: "mcp__grayboard__whoami", args: {} }]),
  ], async ({ srv, peer, start }) => {
    await seedGrant(srv, stateDirOf(dir), PI_CLIENT);
    const a = start({ persist: true });
    const state = await a.command({ type: "get_state" });
    await a.command({ type: "prompt", message: "bind" });
    await until(() => leasedAs(srv, state.sessionId, "pi-twice"), 30_000, "pi-twice leased");
    await idle(a);
    await until(() => existsSync(state.sessionFile), 5_000, "session file on disk");

    const b = start({ persist: true, session: state.sessionFile });
    expect((await b.command({ type: "get_state" })).sessionId).toBe(state.sessionId);
    expect(await statusOf(b)).toContain(`\ndelivery: ${HELD}`);
    const opened = () => srv.app.db.query<{ n: number }, []>("SELECT count(*) AS n FROM access_log WHERE action = 'hosted.lease_opened'").get()!.n;
    expect(opened()).toBe(1);
    expect(srv.app.mcp.activeLeases).toBe(1);
    await b.command({ type: "prompt", message: "check" });
    const checked = await toolResult(b, "whoami");
    expect(checked.isError).toBeFalsy();
    expect(resultText(checked)).toStartWith(`grayboard: ${HELD}\n`);
    expect(resultText(checked)).toMatch(/"primary":\s*"[^"]*\/pi-twice"/);
    await idle(b);
    expect(opened()).toBe(1);
    expect(leasedAs(srv, state.sessionId, "pi-twice")).toBe(true);

    // a quits, releasing its ownership; b takes delivery and rebinds the name
    // under a new one.
    const held = piRow(srv, state.sessionId)!.ownership_id;
    await a.quit();
    await until(() => leasedAs(srv, state.sessionId, "pi-twice") && piRow(srv, state.sessionId)!.ownership_id !== held, 20_000, "b leased as pi-twice");
    expect(ownershipEnded(srv, held)).toBe(true);
    expect(await statusOf(b)).not.toContain(HELD);
    await pingPong(srv, peer, "pi-twice");
    await idle(b);
    expect(srv.app.mcp.activeLeases).toBe(1);
    await b.quit();
  });
}

// ── Always-on pi (#631) ──────────────────────────────────────────────────────

const ALWAYS_ON = join(ROOT, "adapters/pi-family/always-on/always-on.ts");
const PI_BIN = join(ROOT, "node_modules/.bin/pi");
const AGENT = "pi-agent";

// Each extension dialog, then a notice of what each one returned, at the
// first turn: the first DM's, since the runner never prompts. Not at
// session_start, where a dialog makes pi 1.4.0 in RPC mode exit 0 however
// it's answered.
const DIALOGS = `export default function (pi) {
  let asked = false;
  pi.on("before_agent_start", async (_event, ctx) => {
    if (asked) return;
    asked = true;
    const select = await ctx.ui.select("Pick one", ["a", "b"]);
    const confirm = await ctx.ui.confirm("Allow?", "a dialog nobody answers");
    const input = await ctx.ui.input("Name?", "placeholder");
    const editor = await ctx.ui.editor("Edit", "text");
    ctx.ui.notify(\`dialogs: select=\${select} confirm=\${confirm} input=\${input} editor=\${editor}\`, "info");
  });
}
`;

// The runner under plain Node, as a supervisor starts it, on the hosted
// install `installHosted` wrote: its own session directory under `runner/`,
// the fake model after `--`, and `extra` for pi after that.
class Runner {
  lines: string[] = [];
  readonly exited: Promise<number | null>;
  constructor(readonly proc: ChildProcess) {
    this.exited = new Promise((r) => proc.once("exit", (code) => r(code)));
    let buf = "";
    proc.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      buf += chunk;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        this.lines.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    proc.stderr!.setEncoding("utf8").on("data", (chunk: string) => process.stderr.write(chunk));
  }
  // The log's lines after its timestamp.
  logged(): string[] {
    return this.lines.map((l) => l.slice(l.indexOf(" ") + 1));
  }
}

function startRunner(dir: string, procs: ChildProcess[], extra: string[] = []): Runner {
  const proc = spawn("node", [
    "--disable-warning=ExperimentalWarning", ALWAYS_ON,
    "--handle", AGENT, "--dir", join(dir, "runner"), "--agent-dir", agentDirOf(dir), "--cwd", dir, "--pi", PI_BIN,
    "--", "--offline", "--provider", "fake", "--model", "fake-1", ...extra,
  ], {
    cwd: dir,
    env: cleanEnv({
      HOME: join(dir, "home"), GRAYBOARD_ATTACHMENTS_DIR: join(dir, "saved"), PATH: `${join(dir, "bin")}${delimiter}${process.env.PATH}`,
      PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  procs.push(proc);
  return new Runner(proc);
}

// The pi session (its raw id) whose hosted session holds `name`.
const rootHolding = (srv: HostedServer, name: string): string | undefined => srv.app.db.query<{ raw: string }, [string, string]>(
  "SELECT source_session_id AS raw FROM hosted_sessions h WHERE client_id = ? AND (SELECT substr(address, instr(address, '/') + 1) FROM alias_holds WHERE id = h.session_id ORDER BY bound_at, address LIMIT 1) = ?").get(PI_CLIENT, name)?.raw;

// The extension's notice once a sign-in finishes.
const SIGNED_IN = "grayboard: signed in";

// The always-on runner (#631) under plain Node, which never prompts: its
// handle is pi's BUS_IDENTITY. Signed out, the start says so and the runner
// asks the extension for a sign-in link (/grayboard login, no model turn),
// which is on its log; approved on the consent page, the extension's own
// restart binds BUS_IDENTITY and takes the lease, with no restart of the
// runner and no model call. A peer's DM is answered, and that first turn's
// dialogs are each cancelled. Stopped, it exits 0 and pi releases the lease;
// started again, it continues the same pi session, which takes the name back
// and answers. A pi killed under it makes it exit with pi's status.
export function piAlwaysOnScenario(dir: string): Promise<void> {
  return withHosted(dir, [], async ({ srv, peer }) => {
    const procs: ChildProcess[] = [];
    try {
      writeFileSync(join(dir, "dialogs.ts"), DIALOGS);
      let runner = startRunner(dir, procs, ["-e", join(dir, "dialogs.ts")]);
      expect(await until(() => runner.logged().find((l) => l.startsWith("started pi ")), 15_000, "the runner's start")).not.toContain("continuing");

      // Signed out: the start says so, and the runner asks for a link, which is logged.
      await until(() => runner.logged().includes(`notice: ${SIGNED_OUT}`), 30_000, "the signed-out notice");
      await until(() => runner.logged().includes("signed out: asked the extension for a sign-in link (/grayboard login)"), 15_000, "the login request");
      const url = await until(() => runner.logged().map((l) => /^notice: grayboard: sign in at (\S+)$/.exec(l)?.[1]).find(Boolean), 30_000, "the logged sign-in link");
      expect(url).toStartWith(`${srv.issuer}/`);
      expect(await browse(srv.issuer, url!, "pi")).toContain("Signed in to grayboard");
      await until(() => runner.logged().includes(`notice: ${SIGNED_IN}`), 15_000, "the signed-in notice");

      // Signed in, the extension's own restart binds BUS_IDENTITY and takes
      // the lease: no runner restart, and no model call so far.
      const raw = await until(() => rootHolding(srv, AGENT), 30_000, `${AGENT} bound after the sign-in`);
      await until(() => leasedAs(srv, raw, AGENT), 15_000, `${AGENT} holds the lease`);
      expect(runner.logged().filter((l) => l.startsWith("tool ") || l.startsWith("turn end"))).toEqual([]);

      // A peer's DM starts the first turn, whose reply reaches the peer.
      await pingPong(srv, peer, AGENT);

      // That turn's dialogs were each cancelled, and pi went on past them.
      expect(runner.logged().filter((l) => /^declined (select|confirm|input|editor): /.test(l)).map((l) => l.split(":")[0])).toEqual(
        ["declined select", "declined confirm", "declined input", "declined editor"]);
      expect(runner.logged()).toContain("notice: dialogs: select=undefined confirm=false input=undefined editor=undefined");
      // The model never binds: BUS_IDENTITY did.
      expect(runner.logged()).not.toContain("tool mcp__grayboard__bind");

      // Stopped: the runner exits 0 and pi releases the lease.
      runner.proc.kill("SIGTERM");
      expect(await runner.exited).toBe(0);
      await until(() => srv.app.mcp.activeLeases === 0, 10_000, "released on stop");

      // Started again: the same pi session takes the name back and answers.
      runner = startRunner(dir, procs);
      expect(await until(() => runner.logged().find((l) => l.startsWith("started pi ")), 15_000, "the runner's restart")).toContain("continuing its session");
      await until(() => leasedAs(srv, raw, AGENT), 30_000, `the same session holds ${AGENT} again`);
      await pingPong(srv, peer, AGENT);

      // A pi killed under it: the runner exits with pi's status.
      const pid = Number(/^started pi \(pid (\d+)\)/.exec(runner.logged().find((l) => l.startsWith("started pi "))!)![1]);
      process.kill(pid, "SIGKILL");
      expect(await runner.exited).toBe(128 + 9);
      expect(runner.logged()).toContain("pi exited SIGKILL");
    } finally {
      await stopAll(procs);
    }
  });
}
