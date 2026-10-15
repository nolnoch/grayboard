// End-to-end over real local-mode processes: each session is a separate
// `bun src/local/main.ts` driven by an MCP client, sharing a temp database and
// socket directory. Covers liveness in `who`, which only works across processes.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const MAIN = resolve(import.meta.dir, "../../src/local/main.ts");

let dir: string;
const open: Client[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grayboard-local-"));
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close().catch(() => {})));
  rmSync(dir, { recursive: true, force: true });
});

async function start(identity: string, cwd = dir): Promise<Client> {
  const c = new Client({ name: "test", version: "0" });
  await c.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [MAIN],
      cwd,
      env: { ...process.env, BUS_IDENTITY: identity, BUS_DB_PATH: join(dir, "bus.db"), BUS_SOCK_DIR: dir } as Record<string, string>,
      stderr: "ignore",
    }),
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

  const online = await call(sim, "who");
  expect(online.you).toBe("sim");
  expect(online.peers.map((p: any) => p.handle)).toEqual(["be", "sim"]);
  expect(online.offline_hidden).toBe(1);

  const all = await call(sim, "who", { include_offline: true });
  const gone = all.peers.find((p: any) => p.handle === "tmp");
  expect(gone.online).toBe(false);
  expect(gone.last_seen).toBeGreaterThanOrEqual(before);

  await call(be, "board_create", { name: "e2e", purpose: "fixtures" });
  await call(sim, "board_subscribe", { board: "e2e", mode: "quiet" });
  expect((await call(sim, "who", { board: "#e2e" })).peers).toEqual([
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
  expect((await call(stream, "who")).you).toBe("be-stream");
  expect((await call(main, "who")).peers.map((p: any) => p.handle)).toEqual(["be", "be-stream"]);
}, 20_000);
