// grayboard push adapter for opencode.
//
// opencode runs grayboard's MCP server for tools, but drops MCP notifications,
// so that server runs with BUS_PUSH=off (tools only). This plugin runs a second
// `grayboard mcp` with push on, reads its channel notifications, and delivers
// them into the session. That child is the identity's one delivery owner: it
// holds the wakeup socket (local) or the live connection (server) and moves
// the read cursors, as the MCP server does under Claude Code and omp.
//
// Install: copy into ~/.config/opencode/plugin/ (grayboard setup does this),
// next to an `mcp.grayboard` entry with environment BUS_PUSH=off.
import type { Plugin } from "@opencode-ai/plugin";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

type ChannelParams = { content: string; meta?: Record<string, string> };
type McpEntry = { type?: string; command?: string[]; environment?: Record<string, string> };

const SERVER = process.env.GRAYBOARD_MCP_NAME ?? "grayboard";

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

export const GrayboardPlugin: Plugin = async ({ client, directory }) => {
  let entry: McpEntry | undefined;
  let child: ChildProcess | undefined;
  // The root session to deliver into: the one the user last wrote in.
  let target: string | undefined;
  const subagents = new Set<string>();
  // One delivery at a time, in order.
  let queue = Promise.resolve();

  const log = (level: "info" | "error", message: string) =>
    client.app.log({ body: { service: "grayboard", level, message } }).catch(() => {});

  const deliver = (params: ChannelParams) => {
    queue = queue.then(async () => {
      if (!target) return;
      const contextOnly = params.meta?.kind === "digest" || params.meta?.deferred === "true";
      // Direct messages, mentions, thread replies: act on them (starts a turn,
      // or joins a running one at its next step). Digests and deferred thread
      // replies: context only. The
      // tools-only server's instructions, which opencode puts in the system
      // prompt, tell the model what a <channel> message is.
      const r = await client.session.promptAsync({
        path: { id: target },
        body: { parts: [{ type: "text", text: render(params) }], ...(contextOnly ? { noReply: true } : {}) },
      });
      if (r.error) log("error", `delivery failed: ${JSON.stringify(r.error)}`);
    });
  };

  // Started on the first root session, not at load: until something can
  // receive them, messages wait in grayboard rather than in this process.
  const start = () => {
    if (child) return;
    const [cmd, ...args] = entry?.command?.length ? entry.command : ["grayboard", "mcp"];
    const env: Record<string, string | undefined> = { ...process.env, ...entry?.environment };
    delete env.BUS_PUSH;
    child = spawn(cmd!, args, { cwd: directory, env, stdio: ["pipe", "pipe", "inherit"] });
    const send = (msg: object) => child!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
    createInterface({ input: child.stdout! }).on("line", (line) => {
      let msg: { id?: number; method?: string; params?: unknown; result?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id === 1 && msg.result) {
        send({ method: "notifications/initialized" });
      } else if (msg.method === "notifications/claude/channel") {
        deliver(msg.params as ChannelParams);
      }
    });
    // stdin stays open: grayboard exits when it closes, releasing the identity.
    send({
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "opencode-grayboard", version: "1" } },
    });
    child.on("exit", (code) => {
      log("error", `grayboard push process exited (${code}); restart opencode to reconnect`);
    });
  };

  return {
    config: async (cfg) => {
      entry = (cfg.mcp as Record<string, McpEntry> | undefined)?.[SERVER];
    },

    event: async ({ event }) => {
      if (event.type === "session.created" || event.type === "session.updated") {
        const s = event.properties.info;
        if (s.parentID) subagents.add(s.id);
        else if (event.type === "session.created") target ??= s.id;
      } else if (event.type === "message.updated") {
        const m = event.properties.info;
        if (m.role === "user" && !subagents.has(m.sessionID)) target = m.sessionID;
      }
      if (target) start();
    },

    dispose: async () => {
      child?.kill();
    },
  };
};
