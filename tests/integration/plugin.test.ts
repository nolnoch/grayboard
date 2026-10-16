// The server-mode MCP process (src/plugin/mcp.ts) against an in-memory
// server: what was queued while a session was offline reaches it at start.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { startServer } from "../../src/server/app.ts";

const CLI = resolve(import.meta.dir, "../../src/cli/main.ts");

let app: ReturnType<typeof startServer>;
let base: string;
const open: Client[] = [];

beforeEach(() => {
  app = startServer(
    {
      dbPath: ":memory:",
      httpPort: 0,
      googleClientId: "dev",
      googleClientSecret: "",
      orgDomain: "example.com",
      publicUrl: "http://localhost",
      messageRetentionDays: 90,
      auditRetentionDays: 90,
      devAuth: true,
    },
    { background: false },
  );
  base = `http://localhost:${app.server.port}`;
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close().catch(() => {})));
  app.stop();
});

async function login(email: string): Promise<string> {
  const r = await fetch(`${base}/api/auth/dev-login`, { method: "POST", body: JSON.stringify({ email }) });
  return ((await r.json()) as { session_token: string }).session_token;
}

// A grayboard MCP session in server mode; collects channel notifications.
// Like Claude Code, it drops any that arrive before it has sent `initialized`.
async function session(token: string, identity: string, extraEnv: Record<string, string> = {}) {
  const pushes: { content: string; meta: Record<string, string> }[] = [];
  const c = new Client({ name: "test", version: "0" });
  let initialized = false;
  c.fallbackNotificationHandler = async (n) => {
    if (initialized && n.method === "notifications/claude/channel") pushes.push(n.params as any);
  };
  const env = { ...process.env, GRAYBOARD_TOKEN: token, GRAYBOARD_SERVER: base, BUS_IDENTITY: identity, ...extraEnv } as Record<string, string>;
  await c.connect(
    new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp", "--mode", "server"], env, stderr: "ignore" }),
  );
  initialized = true;
  open.push(c);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await c.callTool({ name, arguments: args });
    const body = (r.content as { text: string }[])[0]!.text;
    if (r.isError) throw new Error(body);
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  };
  return { c, pushes, call };
}

test("queued messages and posts are pushed at session start; instructions list claims", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const be = await session(alice, "be");
  await be.call("board_create", { name: "e2e", purpose: "fixtures" });
  await be.c.close();
  open.splice(open.indexOf(be.c), 1);
  await Bun.sleep(200);

  const fe = await session(bob, "fe");
  await fe.call("dm_send", { to: "alice@example.com/be", body: "queued dm" });
  await fe.call("board_post", { board: "e2e", body: "queued post" });
  await fe.call("claim_take", { key: "ticket:ENG-3" });

  const again = await session(alice, "be");
  await Bun.sleep(500);
  expect(again.pushes.map((p) => p.content).sort()).toEqual(["queued dm", "queued post"]);
  expect(again.c.getInstructions()).toContain("ticket:ENG-3 (held by bob@example.com/fe");
}, 20_000);

test("BUS_PUSH=off runs beside the session that owns the identity, for tools only", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const owner = await session(alice, "be");
  const tools = await session(alice, "be", { BUS_PUSH: "off" });
  const fe = await session(bob, "fe");
  expect((await fe.call("dm_send", { to: "alice@example.com/be", body: "hi" })).delivered_now).toBe(true);
  expect((await tools.call("dm_inbox")).unanswered.map((m: any) => m.body)).toEqual(["hi"]);
  await Bun.sleep(300);
  expect(owner.pushes.map((p) => p.content)).toEqual(["hi"]);
  expect(tools.pushes).toEqual([]);
}, 20_000);
