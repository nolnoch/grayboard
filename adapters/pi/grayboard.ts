// grayboard push adapter for pi.
//
// pi runs grayboard's MCP server for tools, but its MCP client drops server
// notifications and leaves server instructions out of the system prompt for
// directly exposed tools. So that server runs with BUS_PUSH=off (tools only),
// and this extension runs a second `grayboard mcp` with push on: it reads that
// child's channel notifications and delivers them into the session, and puts
// the child's instructions in the system prompt. The child is the identity's
// one delivery owner: it holds the wakeup socket (local) or the live
// connection (server) and moves the read cursors, as the MCP server does under
// Claude Code and omp.
//
// Install: copy into ~/.pi/agent/extensions/ (grayboard setup does this), next
// to an mcpServers.grayboard entry in ~/.pi/agent/mcp.json with env BUS_PUSH=off.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type ChannelParams = { content: string; meta?: Record<string, string> };
type McpEntry = { command?: string; args?: string[]; env?: Record<string, string> };

const SERVER = process.env.GRAYBOARD_MCP_NAME ?? "grayboard";
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// Same shape Claude Code shows the model, so the MCP server's instructions apply.
function render({ content, meta = {} }: ChannelParams): string {
  const attrs = Object.entries(meta)
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join("");
  return `<channel source="grayboard"${attrs}>\n${content}\n</channel>`;
}

// The user-level entry grayboard setup writes; the push child runs the same command.
function mcpEntry(): McpEntry | undefined {
  try {
    const cfg = JSON.parse(readFileSync(join(AGENT_DIR, "mcp.json"), "utf8"));
    return cfg?.mcpServers?.[SERVER];
  } catch {
    return undefined;
  }
}

export default function grayboard(pi: ExtensionAPI) {
  let child: ChildProcess | undefined;
  let instructions: string | undefined;

  const deliver = (params: ChannelParams) => {
    // Direct messages, mentions, thread replies: act on them (starts a turn
    // when idle; mid-run, steers in at the next step). Digests: context only.
    const digest = params.meta?.kind === "digest";
    pi.sendMessage(
      { customType: "grayboard", content: render(params), display: true },
      digest ? undefined : { triggerTurn: true },
    );
  };

  // Started per session, not at load: until something can receive them,
  // messages wait in grayboard rather than in this process.
  pi.on("session_start", async (_event, ctx) => {
    if (child) return;
    const entry = mcpEntry();
    const [cmd, ...args] = entry?.command ? [entry.command, ...(entry.args ?? [])] : ["grayboard", "mcp"];
    const env: Record<string, string | undefined> = { ...process.env, ...entry?.env };
    delete env.BUS_PUSH;
    const proc = spawn(cmd!, args, { cwd: ctx.cwd, env, stdio: ["pipe", "pipe", "inherit"] });
    child = proc;
    const send = (msg: object) => proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
    // JSON-RPC over stdio is LF-delimited; split on "\n" only (readline would
    // also split on U+2028/2029, which are valid inside JSON strings).
    let buf = "";
    proc.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: { id?: number; method?: string; params?: unknown; result?: { instructions?: string } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1 && msg.result) {
          instructions = msg.result.instructions;
          send({ method: "notifications/initialized" });
        } else if (msg.method === "notifications/claude/channel") {
          deliver(msg.params as ChannelParams);
        }
      }
    });
    // stdin stays open: grayboard exits when it closes, releasing the identity.
    send({
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pi-grayboard", version: "1" } },
    });
    // E.g. no grayboard on PATH; unhandled, the error event would crash pi.
    proc.on("error", (e) => {
      if (child === proc) child = undefined;
      if (ctx.hasUI) ctx.ui.notify(`grayboard push process failed to start: ${e.message}`, "error");
    });
    proc.on("exit", (code) => {
      if (child !== proc) return;
      child = undefined;
      if (ctx.hasUI) ctx.ui.notify(`grayboard push process exited (${code}); restart pi to reconnect`, "error");
    });
  });

  // pi leaves MCP server instructions out of the prompt for direct tools, and
  // they're what tells the model what a <channel> message is.
  pi.on("before_agent_start", async (event) => {
    if (instructions) event.systemPromptOptions.sections.grayboard = instructions;
  });

  // Also fires before /new, /resume, and fork, which start the session again:
  // wait for the child to exit so the next one can take the identity.
  pi.on("session_shutdown", async () => {
    const proc = child;
    if (!proc) return;
    child = undefined;
    const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    proc.stdin!.end();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
    if (proc.exitCode === null) proc.kill();
  });
}
