// A `grayboard mcp` child driven by an MCP client, as a harness drives it.
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { localEnv } from "./env.ts";
import { RESTARTED } from "./harness.ts";
import { CLI } from "./paths.ts";
import { until } from "./until.ts";

const HARNESS = resolve(import.meta.dir, "harness.ts");

export type Push = { content: string; meta: Record<string, string> };
export type Session = {
  c: Client;
  pushes: Push[];
  // The child's stderr so far; a failed start or call carries it in its error.
  stderr: () => string;
  call: (name: string, args?: Record<string, unknown>) => Promise<any>;
  // The harness stand-in (harness.ts) this session's grayboard runs under.
  harnessPid: number;
  // Restart grayboard under the same harness, as `/mcp` reconnect does
  // ("reconnect") or a crash does ("crash"), and handshake with the new
  // process. The returned session replaces this one.
  restart: (how: "reconnect" | "crash") => Promise<Session>;
};

const open = new Set<Client>();

// Starts `grayboard <args>` (default: `mcp`) under its own harness
// stand-in, and collects its channel notifications. Like Claude Code, it
// drops any that arrive before it has sent `initialized`. `via` runs the CLI
// under a launcher (its command and leading args) between the harness and
// grayboard. `bin` runs a compiled grayboard (a release) instead of the source.
// `harness` is the executable that runs the stand-in (default: this bun).
export async function mcpSession(
  o: { env: Record<string, string>; cwd?: string; args?: string[]; via?: string[]; bin?: string; harness?: string },
): Promise<Session> {
  const args = o.args ?? ["mcp"];
  const cmd = o.bin ? [o.bin, ...args] : [...(o.via ?? [process.execPath]), CLI, ...args];
  const t = new HarnessTransport([o.harness ?? process.execPath, HARNESS, ...cmd], o.env, o.cwd);
  return handshake(t);
}

async function handshake(t: HarnessTransport): Promise<Session> {
  const pushes: Push[] = [];
  const c = new Client({ name: "test", version: "0" });
  let initialized = false;
  c.fallbackNotificationHandler = async (n) => {
    if (initialized && n.method === "notifications/claude/channel") pushes.push(n.params as Push);
  };
  try {
    await c.connect(t);
  } catch (e) {
    throw withStderr(e, t.stderr);
  }
  initialized = true;
  open.add(c);
  return {
    c, pushes, stderr: t.stderr, harnessPid: t.pid,
    call: (name, args) => call(c, name, args).catch((e) => Promise.reject(withStderr(e, t.stderr))),
    restart: async (how) => {
      open.delete(c);
      await t.restart(how === "crash" ? "SIGUSR2" : "SIGUSR1");
      return handshake(t);
    },
  };
}

// stdio to the harness stand-in, kept across restarts of the grayboard
// under it: each new Client connects to the same transport, and start() only
// spawns the first time. Closing ends the harness's stdin, as the SDK's
// stdio transport does, then signals it if it outlives that.
class HarnessTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private p: ChildProcess | null = null;
  private readonly buf = new ReadBuffer();
  private err = "";
  readonly stderr = () => this.err;

  constructor(private readonly cmd: string[], private readonly env: Record<string, string>, private readonly cwd?: string) {}

  get pid(): number {
    return this.p!.pid!;
  }

  start(): Promise<void> {
    if (this.p) return Promise.resolve();
    return new Promise((ok, fail) => {
      const p = spawn(this.cmd[0]!, this.cmd.slice(1), { env: this.env, cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] });
      this.p = p;
      p.on("error", (e) => {
        fail(e);
        this.onerror?.(e);
      });
      p.on("spawn", () => ok());
      p.on("close", () => this.onclose?.());
      p.stdin!.on("error", (e) => this.onerror?.(e));
      p.stderr!.on("data", (chunk: Buffer) => (this.err += chunk.toString()));
      p.stdout!.on("data", (chunk: Buffer) => {
        this.buf.append(chunk);
        for (let m = this.buf.readMessage(); m; m = this.buf.readMessage()) this.onmessage?.(m);
      });
    });
  }

  send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.p?.stdin;
    if (!stdin || stdin.writableEnded) return Promise.reject(new Error("not connected"));
    return new Promise((ok) => (stdin.write(serializeMessage(message)) ? ok() : stdin.once("drain", ok)));
  }

  async restart(signal: "SIGUSR1" | "SIGUSR2"): Promise<void> {
    const before = this.err.split(RESTARTED).length;
    this.buf.clear();
    this.p!.kill(signal);
    await until(() => this.err.split(RESTARTED).length > before, 10_000, "the harness to restart grayboard");
  }

  async close(): Promise<void> {
    const p = this.p;
    if (!p || p.exitCode !== null || p.signalCode !== null) return;
    const closed = new Promise((ok) => p.once("close", ok));
    const within = (ms: number) => Promise.race([closed, Bun.sleep(ms)]);
    p.stdin!.end();
    await within(2000);
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      if (p.exitCode !== null || p.signalCode !== null) return;
      p.kill(signal);
      await within(2000);
    }
  }
}

// A local-mode session on the bus in `dir`, started there unless `cwd` says otherwise.
export function localSession(
  dir: string, identity?: string, o: { cwd?: string; args?: string[]; extra?: Record<string, string>; via?: string[]; bin?: string } = {},
): Promise<Session> {
  return mcpSession({ env: localEnv(dir, identity, o.extra), cwd: o.cwd ?? dir, args: o.args ?? ["mcp", "--mode", "local"], via: o.via, bin: o.bin });
}

function withStderr(e: unknown, stderr: () => string): Error {
  const out = stderr().trim();
  const err = e instanceof Error ? e : new Error(String(e));
  if (out) err.message += `\n--- grayboard stderr ---\n${out}`;
  return err;
}

// A tool call's JSON result; a tool error throws with its text.
export async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = await c.callTool({ name, arguments: args });
  const body = (r.content as { text: string }[])[0]!.text;
  if (r.isError) throw new Error(body);
  try {
    return JSON.parse(body);
  } catch {
    return body; // e.g. board_subscribe's "ok: ..."
  }
}

// Ends one session mid-test. The SDK's close waits for the child to exit.
export async function stopSession(c: Client): Promise<void> {
  open.delete(c);
  await c.close();
}

// For afterEach: ends every session still open.
export async function closeSessions(): Promise<void> {
  const all = [...open];
  open.clear();
  await Promise.all(all.map((c) => c.close().catch(() => {})));
}
