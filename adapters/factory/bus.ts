// The FactoryBus seam (docs/factory.md §3): every bus interaction the
// module makes goes through this interface, so feature code never sees a
// transport. LocalBus is the one implementation: the module is its own
// session's harness, running `grayboard mcp` as a child and driving it over
// stdio with the MCP SDK, exactly as Claude Code or pi drives it. It imports
// no grayboard code: the CLI and its tools are the published surface.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// One channel notification, as grayboard renders it for every harness
// (src/shared/notifications.ts builds the shape; the module reads only the
// wire form). A DM carries message_id; a board item carries board.
export type Delivery =
  | { kind: "dm"; id: number; from: string; parentId?: number; body: string }
  | { kind: "board"; board: string; postId?: number; from?: string; body: string };

export interface FactoryBus {
  // The handle this session holds and writes as.
  readonly handle: string;
  // One tool call; its JSON result, or its text when not JSON. A tool error throws.
  call(tool: string, args?: Record<string, unknown>): Promise<unknown>;
  // Pushed deliveries, in arrival order; ends when the bus closes.
  deliveries(): AsyncIterable<Delivery>;
  // Resolves when the bus is gone (closed, or its child exited), with why.
  readonly closed: Promise<string>;
  close(): Promise<void>;
}

export type LocalBusOptions = {
  command: string[];             // the grayboard CLI: [binary] or [bun, src/cli/main.ts]
  identity: string;              // BUS_IDENTITY: the name the factory binds
  env?: Record<string, string>;  // the child's base env (default: this process's)
  cwd?: string;
  version: string;               // reported as the MCP client's version
};

export function toDelivery(params: unknown): Delivery | null {
  const p = params as { content?: unknown; meta?: Record<string, unknown> } | undefined;
  if (typeof p?.content !== "string" || typeof p.meta !== "object" || p.meta === null) return null;
  const m = p.meta;
  const str = (k: string) => (typeof m[k] === "string" ? (m[k] as string) : undefined);
  const int = (k: string) => {
    const v = str(k);
    return v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined;
  };
  const board = str("board");
  if (board !== undefined) return { kind: "board", board, ...(int("post_id") !== undefined ? { postId: int("post_id") } : {}), ...(str("from") ? { from: str("from") } : {}), body: p.content };
  const id = int("message_id");
  const from = str("from");
  if (id === undefined || !from) return null;
  return { kind: "dm", id, from, ...(int("parent_id") !== undefined ? { parentId: int("parent_id") } : {}), body: p.content };
}

// An env with no session of its own: what a factory launched from inside a
// harness inherits names that harness's session. Kept, `grayboard mcp`
// would take the factory for a Claude Code child (CLAUDECODE) and hold every
// push for a hook record no one writes, or join the wrong session. The bus's
// own settings (BUS_DB_PATH, BUS_SOCK_DIR, BUS_RETENTION_DAYS) stay.
const SESSION_VARS = ["BUS_IDENTITY", "BUS_LAUNCHER", "BUS_HUMAN", "BUS_PUSH", "BUS_HARNESS_SESSION", "BUS_HARNESS_PID", "BUS_PARENT_SESSION", "BUS_ADAPTER_OWNER", "BUS_SESSION_KEY", "BUS_MODEL", "BUS_EFFORT", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT"];
export function sessionFree(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !SESSION_VARS.includes(k)) out[k] = v;
  return out;
}

export class LocalBus implements FactoryBus {
  private queue: Delivery[] = [];
  private wake: (() => void) | null = null;
  private done = false;
  private closing = false;
  private settle!: (why: string) => void;
  readonly closed = new Promise<string>((ok) => (this.settle = ok));

  private constructor(private readonly client: Client, readonly handle: string) {}

  static async start(o: LocalBusOptions): Promise<LocalBus> {
    const [command, ...prefix] = o.command;
    if (!command) throw new Error("no grayboard command");
    // Push on (the module is the delivery owner, boards.md §9) and launcher:
    // delegation auto-pick finds it like any launcher session (§13).
    const env = { ...sessionFree(o.env ?? process.env), BUS_IDENTITY: o.identity, BUS_LAUNCHER: "1" };
    const transport = new StdioClientTransport({ command, args: [...prefix, "mcp", "--mode", "local"], env, ...(o.cwd ? { cwd: o.cwd } : {}), stderr: "inherit" });
    const client = new Client({ name: "grayboard-factory", version: o.version }, { capabilities: {} });
    const early: Delivery[] = [];
    let bus: LocalBus | null = null;
    client.fallbackNotificationHandler = async (n) => {
      if (n.method !== "notifications/claude/channel") return;
      const d = toDelivery(n.params);
      if (!d) return;
      if (bus) bus.push(d);
      else early.push(d);
    };
    await client.connect(transport);
    const who = parse(await client.callTool({ name: "whoami", arguments: {} })) as { primary?: unknown };
    if (typeof who.primary !== "string" || who.primary !== o.identity) {
      await client.close().catch(() => {});
      throw new Error(`the factory didn't bind ${o.identity} (whoami: ${JSON.stringify(who)}); is another live session holding it?`);
    }
    bus = new LocalBus(client, who.primary);
    for (const d of early) bus.push(d);
    // Protocol.onclose, not the transport's: connect() owns that one.
    client.onclose = () => bus!.end(bus!.closing ? "closed" : "the grayboard mcp child exited");
    return bus;
  }

  private push(d: Delivery): void {
    if (this.done) return;
    this.queue.push(d);
    this.wake?.();
  }

  private end(why: string): void {
    if (this.done) return;
    this.done = true;
    this.settle(why);
    this.wake?.();
  }

  async call(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return parse(await this.client.callTool({ name: tool, arguments: args }));
  }

  async *deliveries(): AsyncIterable<Delivery> {
    for (;;) {
      const d = this.queue.shift();
      if (d) { yield d; continue; }
      if (this.done) return;
      await new Promise<void>((ok) => (this.wake = ok));
      this.wake = null;
    }
  }

  // The client closes first: a delivery the child pushes before it exits
  // still reaches the queue (the child counts it delivered), and the run
  // loop records it for the next start instead of losing it.
  async close(): Promise<void> {
    this.closing = true;
    await this.client.close().catch(() => {});
    this.end("closed");
  }
}

function parse(r: unknown): unknown {
  const res = r as { content?: { type: string; text?: string }[]; isError?: boolean };
  const text = res.content?.find((c) => c.type === "text")?.text ?? "";
  if (res.isError) throw new Error(text || "tool error");
  try { return JSON.parse(text); } catch { return text; }
}
