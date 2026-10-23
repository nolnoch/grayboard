// A `grayboard mcp` child driven by an MCP client, as a harness drives it.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CLI } from "./paths.ts";

export type Push = { content: string; meta: Record<string, string> };
export type Session = { c: Client; pushes: Push[]; call: (name: string, args?: Record<string, unknown>) => Promise<any> };

const open = new Set<Client>();

// Starts `grayboard <args>` (default: `mcp`) and collects its channel
// notifications. Like Claude Code, it drops any that arrive before it has
// sent `initialized`. `via` runs the CLI under a launcher (its command and
// leading args) that execs bun itself, as a harness wrapper would.
export async function mcpSession(o: { env: Record<string, string>; cwd?: string; args?: string[]; via?: string[] }): Promise<Session> {
  const pushes: Push[] = [];
  const c = new Client({ name: "test", version: "0" });
  let initialized = false;
  c.fallbackNotificationHandler = async (n) => {
    if (initialized && n.method === "notifications/claude/channel") pushes.push(n.params as Push);
  };
  await c.connect(
    new StdioClientTransport({
      command: o.via?.[0] ?? process.execPath,
      args: [...(o.via?.slice(1) ?? []), CLI, ...(o.args ?? ["mcp"])],
      cwd: o.cwd,
      env: o.env,
      stderr: "ignore",
    }),
  );
  initialized = true;
  open.add(c);
  return { c, pushes, call: (name, args) => call(c, name, args) };
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

// Ends one session mid-test, and waits for its process to exit and drop its socket.
export async function stopSession(c: Client): Promise<void> {
  open.delete(c);
  await c.close();
  await Bun.sleep(200);
}

// For afterEach: ends every session still open.
export async function closeSessions(): Promise<void> {
  const all = [...open];
  open.clear();
  await Promise.all(all.map((c) => c.close().catch(() => {})));
}
