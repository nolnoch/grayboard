// End-to-end over real local-mode processes: each session is a separate
// `grayboard mcp --mode local` driven by an MCP client, sharing a temp database
// and socket directory. Covers liveness in `who`, which only works across processes.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CLI = resolve(import.meta.dir, "../../src/cli/main.ts");

let dir: string;
const open: Client[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grayboard-local-"));
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close().catch(() => {})));
  rmSync(dir, { recursive: true, force: true });
});

// Local-mode env for a session in `dir`; no credentials file, so `grayboard mcp` picks local.
function busEnv(identity?: string): Record<string, string> {
  const env = { ...process.env, BUS_DB_PATH: join(dir, "bus.db"), BUS_SOCK_DIR: dir, GRAYBOARD_CREDENTIALS: join(dir, "credentials") };
  delete env.BUS_IDENTITY;
  delete env.GRAYBOARD_TOKEN;
  return (identity ? { ...env, BUS_IDENTITY: identity } : env) as Record<string, string>;
}

async function start(identity: string | undefined, cwd = dir, args = [CLI, "mcp", "--mode", "local"]): Promise<Client> {
  const c = new Client({ name: "test", version: "0" });
  await c.connect(
    new StdioClientTransport({ command: process.execPath, args, cwd, env: busEnv(identity), stderr: "ignore" }),
  );
  open.push(c);
  return c;
}

async function stop(c: Client): Promise<void> {
  open.splice(open.indexOf(c), 1);
  await c.close();
  await Bun.sleep(200); // let the process exit and drop its socket
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = await c.callTool({ name, arguments: args });
  const body = (r.content as { text: string }[])[0]!.text;
  if (r.isError) throw new Error(body);
  try {
    return JSON.parse(body);
  } catch {
    return body; // e.g. board_subscribe's "ok: ..."
  }
}

test("who: live sessions are online; a stopped one is offline with last_seen", async () => {
  const be = await start("be");
  const sim = await start("sim");
  const tmp = await start("tmp");
  const before = Date.now();
  await stop(tmp);

  const online = await call(sim, "peer_list");
  expect(online.you).toBe("sim");
  expect(online.peers.map((p: any) => p.handle)).toEqual(["be", "sim"]);
  expect(online.offline_hidden).toBe(1);

  const all = await call(sim, "peer_list", { include_offline: true });
  const gone = all.peers.find((p: any) => p.handle === "tmp");
  expect(gone.online).toBe(false);
  expect(gone.last_seen).toBeGreaterThanOrEqual(before);

  await call(be, "board_create", { name: "e2e", purpose: "fixtures" });
  await call(sim, "board_subscribe", { board: "e2e", mode: "quiet" });
  expect((await call(sim, "peer_list", { board: "#e2e" })).peers).toEqual([
    { handle: "be", online: true, last_seen: expect.any(Number), mode: "push" },
    { handle: "sim", online: true, last_seen: expect.any(Number), mode: "quiet" },
  ]);
}, 20_000);

test("a session started in a linked worktree gets a suffixed handle", async () => {
  const wt = join(dir, "repo", ".wt", "stream");
  mkdirSync(join(dir, "repo", ".git", "worktrees"), { recursive: true });
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, ".git"), `gitdir: ${join(dir, "repo", ".git", "worktrees", "stream")}\n`);

  const main = await start("be", join(dir, "repo"));
  const stream = await start("be", wt);
  expect((await call(stream, "peer_list")).you).toBe("be-stream");
  expect((await call(main, "peer_list")).peers.map((p: any) => p.handle)).toEqual(["be", "be-stream"]);
}, 20_000);

test("grayboard mcp: local mode when signed out, named after the repo", async () => {
  const repo = join(dir, "api");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const api = await start(undefined, repo, [CLI, "mcp"]);
  const be = await start("be", dir, [CLI, "mcp"]);
  expect((await call(api, "peer_list")).you).toBe("api");
  expect((await call(be, "peer_list")).peers.map((p: any) => p.handle)).toEqual(["api", "be"]);
}, 20_000);

test("grayboard mcp: a signed-out credentials file fails instead of falling back to local", async () => {
  writeFileSync(join(dir, "credentials"), "");
  const p = Bun.spawn([process.execPath, CLI, "mcp"], { cwd: dir, env: busEnv("be"), stdin: "ignore", stderr: "pipe" });
  expect(await p.exited).toBe(1);
  expect(await new Response(p.stderr).text()).toContain("signed out");
}, 20_000);

test("grayboard mcp --mode local overrides a signed-in credentials file", async () => {
  writeFileSync(join(dir, "credentials"), JSON.stringify({ session_token: "x", server: "http://127.0.0.1:9", user_email: "a@b.c" }));
  const be = await start("be");
  expect((await call(be, "peer_list")).you).toBe("be");
}, 20_000);

test("dm_send to a handle that never connected is an error, not a silent queue", async () => {
  const be = await start("be");
  await expect(call(be, "dm_send", { recipient: "backend", body: "hi" })).rejects.toThrow(/peer_list/);
  await start("fe");
  expect((await call(be, "dm_send", { recipient: "fe", body: "hi" })).delivered_now).toBe(true);
}, 20_000);

test("identities from before the handles roster are backfilled", async () => {
  const { Database } = await import("bun:sqlite");
  const old = new Database(join(dir, "bus.db"));
  old.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT NOT NULL, recipient TEXT NOT NULL,
              body TEXT NOT NULL, parent_id INTEGER, created_at INTEGER NOT NULL);
            CREATE TABLE cursors (reader TEXT PRIMARY KEY, last_seen_id INTEGER NOT NULL);
            INSERT INTO messages (sender, recipient, body, created_at) VALUES ('fe', 'be', 'hi', 1), ('be', 'typo', 'x', 2);
            INSERT INTO cursors VALUES ('docs', 1);`);
  old.close();
  const be = await start("be");
  const all = await call(be, "peer_list", { include_offline: true });
  expect(all.peers.map((p: any) => p.handle)).toEqual(["be", "docs", "fe"]);
  expect((await call(be, "dm_send", { recipient: "fe", body: "still there?" })).delivered_now).toBe(false);
  await expect(call(be, "dm_send", { recipient: "typo", body: "x" })).rejects.toThrow(/peer_list/);
}, 20_000);
