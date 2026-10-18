// `grayboard bridge slack`: one human's grayboard handle, relayed to one
// private Slack channel. See docs/slack-bridge.md.
//
// The bridge is an MCP client of its own `grayboard mcp` child, run as the
// human's handle with BUS_HUMAN=1, the way the pi adapter runs one for pi. It
// gets the same pushes an agent session gets and acts only through the same
// tools, so roster checks, wakeups, and identity uniqueness come for free.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { busMode } from "../cli/api.ts";
import { declareHuman, humanHandles } from "../core/boards.ts";
import { localDbPath, openLocalDb } from "../local/open.ts";
import { ConfigError, configPath, loadConfig } from "./config.ts";
import { Relay, type Bus, type ChannelParams } from "./relay.ts";
import { SocketMode } from "./socket.ts";
import { Store } from "./store.ts";
import { SlackError, SlackWeb } from "./web.ts";
import pkg from "../../package.json" with { type: "json" };

const log = (msg: string) => console.error(`[grayboard slack] ${msg}`);
const debug = process.env.GRAYBOARD_SLACK_DEBUG ? (msg: string) => log(`debug: ${msg}`) : undefined;

export type BridgeHandle = { stop: () => Promise<void>; done: Promise<number> };

// The child's BUS_HUMAN=1 only asserts that its handle is the declared human,
// so declare it here, on the human's side of the tool boundary: on first run
// if nobody is declared, refused if someone else is.
function declareBridgeHuman(handle: string, env: Record<string, string | undefined>): void {
  const db = openLocalDb(localDbPath(env));
  try {
    const humans = humanHandles(db);
    if (humans.length === 0) declareHuman(db, handle);
    else if (!humans.includes(handle)) {
      throw new ConfigError(`"${humans[0]}" is the declared human handle, but ${configPath(env)} says "${handle}"; fix one (grayboard human <handle>)`);
    }
  } finally {
    db.close();
  }
}

/**
 * Start the bridge. `mcp` is how to run `grayboard mcp`. Resolves once it's
 * connected to both sides; `done` settles with the exit code when it stops.
 * `mode: "local"` pins the child to the local bus on a signed-in machine.
 */
export async function startSlackBridge(
  mcp: { command: string; args: string[] },
  env: Record<string, string | undefined> = process.env,
  mode?: "local",
): Promise<BridgeHandle> {
  // On a server, only the server can vouch that a handle is a human; this
  // bridge would relay fine but its messages would arrive unmarked.
  if (mode !== "local" && busMode(env) === "server") {
    throw new ConfigError("the Slack bridge runs in local mode only; on a grayboard server it needs the org bridge (docs/future/org-bridge.md). To relay this machine's local bus instead, pass --mode local");
  }
  const cfg = loadConfig(env);
  declareBridgeHuman(cfg.handle, env);
  const web = new SlackWeb(cfg.botToken, cfg.apiUrl);
  const app = new SlackWeb(cfg.appToken, cfg.apiUrl);

  const me = await web.call<{ user_id: string; team?: string }>("auth.test");
  const store = new Store(cfg.dbPath);

  let finish!: (code: number) => void;
  const done = new Promise<number>((r) => (finish = r));
  let stopping = false;
  let socket: SocketMode | null = null;
  let relay: Relay | null = null;
  const client = new Client({ name: "grayboard-slack", version: pkg.version });

  const stop = async (code = 0, reason?: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    if (reason) log(reason);
    socket?.stop();
    relay?.stop();
    await client.close().catch(() => {});
    store.close();
    finish(code);
  };

  const bus: Bus = {
    async call(name, args) {
      const r = await client.callTool({ name, arguments: args });
      const text = (r.content as { type: string; text?: string }[]).find((c) => c.type === "text")?.text ?? "";
      if (r.isError) return { ok: false, error: text.replace(/^error:\s*/, "") };
      try {
        return { ok: true, value: JSON.parse(text) };
      } catch {
        return { ok: true, value: text };
      }
    },
  };

  relay = new Relay(store, bus, web, {
    channel: cfg.channel,
    owner: cfg.owner,
    log,
    debug,
    onFatal: (reason) => void stop(1, `stopping: ${reason}`),
  });

  // Pushes can arrive as soon as the handshake completes.
  client.fallbackNotificationHandler = async (n) => {
    if (n.method === "notifications/claude/channel") relay!.notify(n.params as ChannelParams);
  };
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) childEnv[k] = v;
  delete childEnv.BUS_PUSH;
  childEnv.BUS_IDENTITY = cfg.handle;
  childEnv.BUS_HUMAN = "1";
  const args = mode === "local" ? [...mcp.args, "--mode", "local"] : mcp.args;
  const transport = new StdioClientTransport({ command: mcp.command, args, env: childEnv, stderr: "inherit" });
  try {
    await client.connect(transport);
  } catch (e) {
    store.close();
    throw new Error(`couldn't start grayboard as "${cfg.handle}" (is another session using that handle?): ${(e as Error).message}`);
  }
  // Without the child, nothing reaches the bus: exit and let a supervisor restart us.
  client.onclose = () => void stop(1, "the grayboard session exited");

  void relay.drain(); // anything left from a previous run

  socket = new SocketMode({
    open: async () => (await app.call<{ url: string }>("apps.connections.open")).url,
    onEvent: (payload) => relay!.onEvent(payload),
    onFatal: (reason) => void stop(1, `stopping: ${reason}`),
    log,
    debug,
  });
  try {
    await socket.start();
  } catch (e) {
    await stop(1);
    throw e;
  }
  log(`relaying grayboard "${cfg.handle}" ⇄ Slack channel ${cfg.channel} as bot ${me.user_id}${me.team ? ` (${me.team})` : ""}`);
  return { stop: () => stop(0), done };
}

/** CLI entry: run until stopped; exit nonzero on failure so a supervisor restarts it. */
export async function runSlackBridge(mcp: { command: string; args: string[] }, mode?: "local"): Promise<never> {
  let bridge: BridgeHandle;
  try {
    bridge = await startSlackBridge(mcp, process.env, mode);
  } catch (e) {
    if (e instanceof ConfigError || e instanceof SlackError) log(e.message);
    else log(String((e as Error).message ?? e));
    process.exit(1);
  }
  const quit = () => void bridge.stop();
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  process.exit(await bridge.done);
}
