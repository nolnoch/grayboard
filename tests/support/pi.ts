// The pi scenarios: the real pi coding agent (the pinned devDependency) in RPC
// mode against a scripted fake model. Local-mode grayboard: mcp.json's
// grayboard entry is disabled, as setup writes it, and the pi adapter runs the
// session's one `grayboard mcp` and serves its tools (#182 decision 13). A
// peer is an MCP client like in local.test.ts. `bin` runs it all on a compiled
// grayboard (binaries.e2e.ts) instead of this checkout, with the adapter that
// binary carries. Server mode (#279, the hosted section below): the hosted
// extension bundle against an in-process server, no grayboard process at all.
import { expect } from "bun:test";
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
import { adapterChildren, grayboardChildren, grayboardDescendants } from "./procs.ts";
import { until } from "./until.ts";

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
  writeModels(agentDir, modelPort);
  const proc = spawn("node", [PI_CLI, ...PI_ARGS, "--no-session"], {
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
  "SELECT name, lease_deadline, ownership_id FROM hosted_sessions WHERE client_id = ? AND source_session_id = ?").get(client, raw) ?? undefined;
// `raw`'s hosted session holds `name` and the server's one delivery lease.
export const leased = (srv: HostedServer, client: string, raw: string, name: string): boolean => {
  const row = hostedRow(srv, client, raw);
  return row?.name === name && row.lease_deadline !== null && srv.app.mcp.activeLeases === 1;
};
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
// whose dm_send reply lands in the same thread, sent as `name`. Returns the DM's id.
export async function pingPong(srv: HostedServer, peer: Peer, name: string): Promise<number> {
  const { message_id: id } = await peer.call("dm_send", { to: `alice@example.com/${name}`, body: `ping ${name}` });
  const reply = await until(() => srv.app.db.query<{ sender: string }, [number]>("SELECT sender FROM messages WHERE parent_id = ? AND body = 'pong'").get(id), 30_000, `pong to DM ${id}`);
  expect(reply.sender).toBe(`alice@example.com/${name}`);
  return id;
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
    await pingPong(srv, peer, "pi-carry");
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
    await pingPong(srv, peer, "pi-carry");
    await idle(pi);

    // /resume of the first session: it rebinds the name it remembers.
    await pi.command({ type: "switch_session", sessionPath: first.sessionFile });
    expect((await pi.command({ type: "get_state" })).sessionId).toBe(first.sessionId);
    await until(() => leasedAs(srv, first.sessionId, "pi-carry"), 15_000, "resumed first session leased as pi-carry");
    expect(piRow(srv, fresh.sessionId)).toBeUndefined();
    await pingPong(srv, peer, "pi-carry");
    await idle(pi);
    expect(grayboardDescendants(pi.pid)).toEqual([]);
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
    // The other process's next tool call says to sign in.
    await b.command({ type: "prompt", message: "check" });
    const checked = await toolResult(b, "whoami");
    expect(checked.isError).toBe(true);
    expect(resultText(checked)).toBe("error: Signed out of grayboard in pi; run /grayboard login");
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
    expect(resultText(checked)).toMatch(/"name":\s*"pi-twice"/);
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
