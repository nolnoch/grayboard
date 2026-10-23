// A `grayboard mcp` child driven by an MCP client, as a harness drives it.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { localEnv } from "./env.ts";
import { CLI } from "./paths.ts";

export type Push = { content: string; meta: Record<string, string> };
export type Session = {
  c: Client;
  pushes: Push[];
  // The child's stderr so far; a failed start or call carries it in its error.
  stderr: () => string;
  call: (name: string, args?: Record<string, unknown>) => Promise<any>;
};

const open = new Set<Client>();

// Starts `grayboard <args>` (default: `mcp`) and collects its channel
// notifications. Like Claude Code, it drops any that arrive before it has
// sent `initialized`. `via` runs the CLI under a launcher (its command and
// leading args) that execs bun itself, as a harness wrapper would. `bin` runs
// a compiled grayboard (a release) instead of the source.
export async function mcpSession(
  o: { env: Record<string, string>; cwd?: string; args?: string[]; via?: string[]; bin?: string },
): Promise<Session> {
  const pushes: Push[] = [];
  const c = new Client({ name: "test", version: "0" });
  let initialized = false;
  c.fallbackNotificationHandler = async (n) => {
    if (initialized && n.method === "notifications/claude/channel") pushes.push(n.params as Push);
  };
  const args = o.args ?? ["mcp"];
  const transport = new StdioClientTransport({
    command: o.bin ?? o.via?.[0] ?? process.execPath,
    args: o.bin ? args : [...(o.via?.slice(1) ?? []), CLI, ...args],
    cwd: o.cwd,
    env: o.env,
    stderr: "pipe",
  });
  let err = "";
  transport.stderr!.on("data", (chunk: Buffer) => (err += chunk.toString()));
  const stderr = () => err;
  try {
    await c.connect(transport);
  } catch (e) {
    throw withStderr(e, stderr);
  }
  initialized = true;
  open.add(c);
  return { c, pushes, stderr, call: (name, args) => call(c, name, args).catch((e) => Promise.reject(withStderr(e, stderr))) };
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
