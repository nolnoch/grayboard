// End-to-end over real local-mode processes: each session is a separate
// `grayboard mcp --mode local` driven by an MCP client, sharing a temp database
// and socket directory. Covers liveness in `who`, which only works across processes.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
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
  const env = {
    ...process.env,
    BUS_DB_PATH: join(dir, "bus.db"),
    BUS_SOCK_DIR: dir,
    GRAYBOARD_CREDENTIALS: join(dir, "credentials"),
    GRAYBOARD_ATTACHMENTS_DIR: join(dir, "saved"),
  };
  delete env.BUS_ATTACH_ROOTS;
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

// Like start, collecting channel notifications. Like Claude Code, it drops
// any that arrive before it has sent `initialized`.
async function startCollecting(identity: string): Promise<{ c: Client; pushes: string[] }> {
  const pushes: string[] = [];
  const c = new Client({ name: "test", version: "0" });
  let initialized = false;
  c.fallbackNotificationHandler = async (n) => {
    if (initialized && n.method === "notifications/claude/channel") pushes.push((n.params as { content: string }).content);
  };
  await c.connect(
    new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp", "--mode", "local"], cwd: dir, env: busEnv(identity), stderr: "ignore" }),
  );
  initialized = true;
  open.push(c);
  return { c, pushes };
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
    { handle: "be", online: true, last_seen: expect.any(Number), mode: "push", where: expect.any(String) },
    { handle: "sim", online: true, last_seen: expect.any(Number), self: true, mode: "quiet", where: expect.any(String) },
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
  await expect(call(be, "dm_send", { to: "backend", body: "hi" })).rejects.toThrow(/peer_list/);
  await start("fe");
  expect((await call(be, "dm_send", { to: "fe", body: "hi" })).delivered_now).toBe(true);
}, 20_000);

test("dm_thread from any message returns the whole thread; pushes carry parent_id", async () => {
  const be = await start("be");
  const fe = await start("fe");
  const pushes: Record<string, string>[] = [];
  fe.fallbackNotificationHandler = async (n) => {
    pushes.push((n.params as { meta: Record<string, string> }).meta);
  };
  const root = await call(be, "dm_send", { to: "fe", body: "q" });
  const reply = await call(fe, "dm_send", { to: "be", body: "a", parent_id: root.message_id });
  const leaf = await call(be, "dm_send", { to: "fe", body: "thanks", parent_id: reply.message_id });
  const thread = await call(fe, "dm_thread", { thread: leaf.message_id });
  expect(thread.map((m: any) => m.id)).toEqual([root.message_id, reply.message_id, leaf.message_id]);
  const sim = await start("sim");
  await expect(call(sim, "dm_thread", { thread: root.message_id })).rejects.toThrow(/not found/);
  await expect(call(sim, "dm_send", { to: "be", body: "x", parent_id: root.message_id })).rejects.toThrow(/not a message you/);
  await Bun.sleep(300);
  expect(pushes.find((m) => m.message_id === String(leaf.message_id))?.parent_id).toBe(String(reply.message_id));
}, 20_000);

test("peer_list shows where a session runs and its status; a restart clears the status", async () => {
  const be = await start("be");
  let sim = await start("sim");
  await call(sim, "peer_status", { text: "spec 163 soak" });
  const row = (await call(be, "peer_list")).peers.find((p: any) => p.handle === "sim");
  expect(row).toMatchObject({ where: basename(dir), status: "spec 163 soak", status_age: "0m" });
  await stop(sim);
  sim = await start("sim");
  expect((await call(be, "peer_list")).peers.find((p: any) => p.handle === "sim").status).toBeUndefined();
}, 20_000);

test("active claims show in board_read and in a new session's instructions", async () => {
  const be = await start("be");
  await call(be, "board_create", { name: "dev-deploys", purpose: "rolls" });
  await call(be, "claim_take", { key: "dev:freeze", board: "dev-deploys", note: "24h soak", ttl_minutes: 60 });
  const r = await call(be, "board_read", { board: "dev-deploys" });
  expect(r.active_claims).toMatchObject([{ key: "dev:freeze", holder: "be", note: "24h soak" }]);
  const fe = await start("fe");
  expect(fe.getInstructions()).toContain("Others': dev:freeze.");
}, 20_000);

test("a wrong argument name gets an error naming the expected call", async () => {
  const be = await start("be");
  await start("fe");
  await expect(call(be, "dm_send", { recipient: "fe", body: "hi" })).rejects.toThrow(
    "dm_send(to, body, parent_id?, pending?, attachments?): missing to; unknown recipient.",
  );
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
  expect((await call(be, "dm_send", { to: "fe", body: "still there?" })).delivered_now).toBe(false);
  await expect(call(be, "dm_send", { to: "typo", body: "x" })).rejects.toThrow(/peer_list/);
}, 20_000);

test("senders see what hasn't reached an offline peer: send result, history, and next session", async () => {
  const fe = await start("fe");
  await stop(fe);
  let be = await start("be");
  await call(be, "dm_send", { to: "fe", body: "contract change 1" });
  const second = await call(be, "dm_send", { to: "fe", body: "contract change 2" });
  expect(second).toMatchObject({ delivered_now: false, recipient_last_seen: expect.stringMatching(/ago$/), undelivered_from_you: 2 });
  expect((await call(be, "dm_history", { peer: "fe" })).map((m: any) => m.delivered)).toEqual([false, false]);

  await stop(be);
  const { Database } = await import("bun:sqlite");
  const db = new Database(join(dir, "bus.db"));
  db.exec(`UPDATE messages SET created_at = created_at - 2 * 86400000`);
  db.close();
  be = await start("be");
  expect(be.getInstructions()).toMatch(/haven't reached the recipient after 24h: fe: 2 since message_id \d+ \(last seen/);

  await start("fe");
  await Bun.sleep(300); // fe's first drain moves its cursor
  expect((await call(be, "dm_history", { peer: "fe" })).map((m: any) => m.delivered)).toEqual([true, true]);
}, 20_000);

test("dm_inbox lists what you owe: replied and acked messages drop out", async () => {
  const be = await start("be");
  const fe = await start("fe");
  const q = await call(fe, "dm_send", { to: "be", body: "question?" });
  const fyi = await call(fe, "dm_send", { to: "be", body: "FYI: deployed" });
  const later = await call(fe, "dm_send", { to: "be", body: "follow-up", parent_id: q.message_id });
  expect((await call(be, "dm_inbox")).unanswered.map((m: any) => m.id)).toEqual([q.message_id, fyi.message_id, later.message_id]);

  await call(be, "dm_send", { to: "fe", body: "answer", parent_id: q.message_id });
  await call(be, "dm_ack", { message_id: fyi.message_id });
  expect((await call(be, "dm_inbox")).unanswered).toEqual([]);
  await expect(call(fe, "dm_ack", { message_id: fyi.message_id })).rejects.toThrow(/no message/);
  expect(be.getInstructions()).toContain("dm_inbox()");
}, 20_000);

test("dm_send pending lists a promise in dm_inbox until your next message in the thread, or a dm_ack", async () => {
  const be = await start("be");
  const fe = await start("fe");
  const q = await call(fe, "dm_send", { to: "be", body: "can you check the soak?" });
  const p = await call(be, "dm_send", { to: "fe", body: "on it, results by noon", parent_id: q.message_id, pending: true });
  expect(p).toMatchObject({ pending: true });
  expect((await call(be, "dm_inbox", { days: 1 })).promised).toMatchObject([{ id: p.message_id, to: "fe", parent_id: q.message_id, body: "on it, results by noon" }]);
  // Their reply doesn't keep it; yours does. History marks only the pending one.
  await call(fe, "dm_send", { to: "be", body: "thanks", parent_id: p.message_id });
  expect((await call(be, "dm_inbox")).promised).toHaveLength(1);
  expect((await call(be, "dm_thread", { thread: q.message_id })).map((m: any) => m.pending)).toEqual([undefined, true, undefined]);
  await call(be, "dm_send", { to: "fe", body: "soak passed", parent_id: p.message_id });
  expect((await call(be, "dm_inbox")).promised).toBeUndefined();

  // dm_ack drops your own promise; it still can't ack your other sends.
  const p2 = await call(be, "dm_send", { to: "fe", body: "will follow up", pending: true });
  await expect(call(fe, "dm_ack", { message_id: [p2.message_id] })).resolves.toBe("ok");
  expect((await call(be, "dm_inbox")).promised).toHaveLength(1);
  expect(await call(be, "dm_ack", { message_id: p2.message_id })).toBe("ok");
  expect((await call(be, "dm_inbox")).promised).toBeUndefined();
}, 20_000);

test("dm_ack takes a list, so one combined reply clears every message it covered", async () => {
  const be = await start("be");
  const fe = await start("fe");
  const ids = [];
  for (const body of ["a", "b", "c"]) ids.push((await call(fe, "dm_send", { to: "be", body })).message_id);
  await call(be, "dm_send", { to: "fe", body: "re a, b, c", parent_id: ids[0] });
  expect(await call(be, "dm_ack", { message_id: [ids[1], ids[2]] })).toBe("ok");
  expect((await call(be, "dm_inbox")).unanswered).toEqual([]);
  // Partial: acks what it can and names the rest; all-bad is an error.
  const d = (await call(fe, "dm_send", { to: "be", body: "d" })).message_id;
  const mine = (await call(be, "dm_send", { to: "fe", body: "mine" })).message_id;
  expect(await call(be, "dm_ack", { message_id: [d, mine] })).toMatchObject({ acked: [d], not_found: [mine] });
  await expect(call(be, "dm_ack", { message_id: [mine] })).rejects.toThrow(/no message/);
  await expect(call(be, "dm_ack", { message_id: [] })).rejects.toThrow(/list of them/);
}, 20_000);

test("a send to a long-idle handle says so; dm_retract withdraws it until it's delivered", async () => {
  await stop(await start("fe"));
  const be = await start("be");
  const sim = await start("sim");
  const first = await call(be, "dm_send", { to: "fe", body: "first" });
  expect(first.note).toMatch(/^Recipient offline/);
  const { Database } = await import("bun:sqlite");
  const db = new Database(join(dir, "bus.db"));
  db.exec(`UPDATE handles SET last_seen = last_seen - 22 * 3600000 WHERE name = 'fe'`);
  db.close();
  const wrong = await call(be, "dm_send", { to: "fe", body: "meant for sim" });
  expect(wrong.note).toMatch(/^Queued: fe last seen 22h ago\. .*dm_retract/);
  const followup = await call(be, "dm_send", { to: "fe", body: "also", parent_id: first.message_id });

  await expect(call(sim, "dm_retract", { message_id: wrong.message_id })).rejects.toThrow(/no message \d+ from you/);
  await expect(call(be, "dm_retract", { message_id: first.message_id })).rejects.toThrow(/has a reply/);
  expect(await call(be, "dm_retract", { message_id: wrong.message_id })).toBe("ok");
  expect((await call(be, "dm_history", { peer: "fe" })).map((m: any) => m.body)).toEqual(["first", "also"]);

  const fe = await startCollecting("fe");
  await Bun.sleep(500);
  expect(fe.pushes).toEqual(["first", "also"]);
  await expect(call(be, "dm_retract", { message_id: followup.message_id })).rejects.toThrow(/already reached fe/);
}, 20_000);

test("identity create --mcp names a missing directory instead of failing with ENOENT", async () => {
  const create = async (path: string) => {
    const p = Bun.spawn([process.execPath, CLI, "identity", "create", "be", "--mcp", path], { cwd: dir, env: busEnv(), stdout: "pipe", stderr: "pipe" });
    return { code: await p.exited, err: await new Response(p.stderr).text() };
  };
  const bad = await create("nope/.mcp.json");
  expect(bad.code).toBe(1);
  expect(bad.err).toMatch(/directory \S*\/nope doesn't exist/);
  expect((await create(".mcp.json")).code).toBe(0);
}, 20_000);

test("grayboard claims: exits 2 when another session holds a match, 0 otherwise", async () => {
  const claims = async (identity: string, ...args: string[]) => {
    const p = Bun.spawn([process.execPath, CLI, "claims", ...args], { cwd: dir, env: busEnv(identity), stdout: "pipe", stderr: "pipe" });
    return { code: await p.exited, out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text() };
  };
  expect((await claims("fe")).code).toBe(0); // no bus yet
  const be = await start("be");
  await call(be, "claim_take", { key: "dev:env", note: "migrating", ttl_minutes: 60 });

  const held = await claims("fe");
  expect(held.code).toBe(2);
  expect(held.err).toMatch(/dev:env held by be until \d{4}-\d\d-\d\dT\d\d:\d\dZ: migrating/);
  expect((await claims("fe", "--prefix", "prod:")).code).toBe(0);
  expect((await claims("be")).code).toBe(0);
  expect((await claims("be", "--include-self")).code).toBe(2);
  const json = await claims("fe", "--json");
  expect(JSON.parse(json.out)).toEqual([expect.objectContaining({ key: "dev:env", holder: "be", note: "migrating" })]);
  expect(JSON.parse(json.out)[0].board).toBeUndefined();
}, 20_000);

// The CLI as a lane's shell runs it: env and cwd decide the handle.
async function gb(identity: string | undefined, cwd: string, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn([process.execPath, CLI, ...args], { cwd, env: busEnv(identity), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code, out, err };
}

test("grayboard claim take/release acts as the directory's session; held exits 2", async () => {
  const repo = join(dir, "api");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const api = await start(undefined, repo, [CLI, "mcp"]);
  const be = await start("be");

  expect(await gb(undefined, repo, "whoami")).toMatchObject({ code: 0, out: "api (from the directory name)\n" });
  expect(JSON.parse((await gb("be", dir, "--json", "whoami")).out)).toEqual({ handle: "be", source: "BUS_IDENTITY" });

  const took = await gb(undefined, repo, "claim", "take", "sandbox:sbx-1", "--ttl", "2h", "--note", "smoke");
  expect(took.code).toBe(0);
  expect(JSON.parse(took.out)).toMatchObject({ ok: true, claim: { key: "sandbox:sbx-1", holder: "api", note: "smoke" } });
  const listed = await call(be, "claim_list");
  expect(listed).toMatchObject([{ key: "sandbox:sbx-1", holder: "api" }]);
  expect(listed[0].expires_at - Date.now()).toBeGreaterThan(110 * 60_000);

  const held = await gb("be", dir, "claim", "take", "sandbox:sbx-1");
  expect(held.code).toBe(2);
  expect(JSON.parse(held.out)).toMatchObject({ ok: false, held_by: "api", note: "smoke" });
  expect((await gb("be", dir, "claim", "take", "sandbox:sbx-2")).code).toBe(0);

  expect((await gb(undefined, dir, "--as", "api", "claim", "release", "sandbox:sbx-1")).code).toBe(0);
  expect((await call(api, "claim_list")).map((c: any) => c.key)).toEqual(["sandbox:sbx-2"]);
  expect((await gb(undefined, dir, "--as", "be", "claims")).code).toBe(0); // --as counts as self
}, 20_000);

test("grayboard claim refuses a handle no session has used, and the human's handle", async () => {
  await start("be");
  const unknown = await gb(undefined, dir, "--as", "nobody", "claim", "take", "k");
  expect(unknown.code).toBe(1);
  expect(unknown.err).toMatch(/no session has used handle "nobody".*whoami/);
  expect((await cli("human", "alex")).code).toBe(0);
  const human = await gb(undefined, dir, "--as", "alex", "claim", "take", "k");
  expect(human.code).toBe(1);
  expect(human.err).toContain(`"alex" is the human handle`);
  expect((await gb(undefined, dir, "--as", "Bad Name", "claim", "take", "k")).err).toContain("invalid --as");
}, 20_000);

test("grayboard claim watch: the session is pushed the release", async () => {
  const be = await start("be");
  const sim = await startCollecting("sim");
  await call(be, "board_create", { name: "e2e", purpose: "x" });
  await call(sim.c, "board_subscribe", { board: "e2e", mode: "quiet" });
  await call(be, "claim_take", { key: "sandbox:sbx-1", board: "e2e" });
  const w = await gb("sim", dir, "claim", "watch", "sandbox:sbx-1");
  expect(w.code, w.err).toBe(0);
  await call(be, "claim_release", { key: "sandbox:sbx-1", note: "done" });
  await Bun.sleep(300);
  expect(sim.pushes).toEqual(["[release] sandbox:sbx-1 — done cc @sim"]);
}, 20_000);

test("claim_watch: a quiet subscriber is pushed the release of the claim it waits on", async () => {
  const be = await start("be");
  const sim = await startCollecting("sim");
  await call(be, "board_create", { name: "dev-deploys", purpose: "x" });
  await call(sim.c, "board_subscribe", { board: "dev-deploys", mode: "quiet" });
  await call(be, "claim_take", { key: "dev:env", board: "dev-deploys" });
  await call(sim.c, "claim_watch", { key: "dev:env" });
  await call(be, "claim_release", { key: "dev:env", note: "done" });
  await Bun.sleep(300);
  expect(sim.pushes).toEqual(["[release] dev:env — done cc @sim"]);
}, 20_000);

test("a thread reply to a bystander waits for its next wake, here a DM", async () => {
  const be = await start("be");
  const fe = await start("fe");
  const sim = await startCollecting("sim");
  await call(be, "board_create", { name: "ops", purpose: "x" });
  await call(be, "board_subscribe", { board: "ops", mode: "off" });
  const root = await call(be, "board_post", { board: "ops", body: "root" });
  await call(sim.c, "board_post", { board: "ops", body: "sim chimes in", parent_id: root.post_id });
  const mid = await call(fe, "board_post", { board: "ops", body: "fe asks", parent_id: root.post_id });
  const reply = await call(be, "board_post", { board: "ops", body: "answer for fe", parent_id: mid.post_id });
  expect(reply).toMatchObject({ notified: ["fe"], deferred: ["sim"] });
  await Bun.sleep(300);
  expect(sim.pushes).toEqual([]); // both replies to the thread are deferred for sim
  await call(fe, "dm_send", { to: "sim", body: "ping" });
  await Bun.sleep(300);
  expect(sim.pushes).toEqual(["ping", "fe asks", "answer for fe"]);
}, 20_000);

test("dm_send and dm_history check body and limit as server mode does", async () => {
  await stop(await start("fe"));
  const be = await start("be");
  await expect(call(be, "dm_send", { to: "fe", body: " " })).rejects.toThrow("body is required");
  await expect(call(be, "dm_send", { to: "fe", body: "x".repeat(64 * 1024 + 1) })).rejects.toThrow("body exceeds");
  for (const body of ["one", "two", "three"]) await call(be, "dm_send", { to: "fe", body });
  const bodies = async (limit: unknown) => (await call(be, "dm_history", { peer: "fe", limit })).map((m: any) => m.body);
  expect(await bodies(2)).toEqual(["two", "three"]);
  expect(await bodies(0)).toEqual(["three"]);
  await expect(bodies("lots")).rejects.toThrow("limit must be a number");
}, 20_000);

test("a message queued while offline is pushed when the session starts", async () => {
  await stop(await start("be"));
  const fe = await start("fe");
  expect((await call(fe, "dm_send", { to: "be", body: "queued dm" })).delivered_now).toBe(false);
  const be = await startCollecting("be");
  await Bun.sleep(500);
  expect(be.pushes).toEqual(["queued dm"]);
}, 20_000);

test("the reply and recovery tools ask Claude Code to load them upfront", async () => {
  const c = await start("be");
  const { tools } = await c.listTools();
  const upfront = tools.filter((t) => t._meta?.["anthropic/alwaysLoad"] === true).map((t) => t.name).sort();
  expect(upfront).toEqual(["board_post", "claim_list", "dm_ack", "dm_inbox", "dm_send", "dm_thread", "peer_status"]);
}, 20_000);

test("a Claude Code session started without a channels flag runs tools-only and is warned", async () => {
  // Stand-in for Claude Code: a process named `claude` (bun under another
  // name) that runs grayboard mcp as its child on inherited stdio, with
  // CLAUDECODE=1 as Claude Code sets. Its own flags come before "::".
  const fake = join(dir, "claude");
  symlinkSync(process.execPath, fake);
  const host = join(dir, "host.ts");
  writeFileSync(host, `const cmd = process.argv.slice(process.argv.indexOf("::") + 1);
Bun.spawn([process.execPath, ...cmd], { stdio: ["inherit", "inherit", "inherit"] }).exited.then((c) => process.exit(c ?? 0));`);
  const session = async (identity: string, flags: string[]) => {
    const c = new Client({ name: "test", version: "0" });
    const env = { ...busEnv(identity), CLAUDECODE: "1" };
    await c.connect(new StdioClientTransport({ command: fake, args: [host, ...flags, "::", CLI, "mcp", "--mode", "local"], cwd: dir, env, stderr: "ignore" }));
    open.push(c);
    return c;
  };
  const texts = async (c: Client) => ((await c.callTool({ name: "peer_list", arguments: {} })).content as { text: string }[]).map((t) => t.text);

  const off = await session("be", []);
  expect(off.getInstructions()).toStartWith("Warning: this Claude Code session was started without");
  expect((await texts(off)).some((t) => t.startsWith("Warning:"))).toBe(true);
  expect((await texts(off)).some((t) => t.startsWith("Warning:"))).toBe(false); // first tool result only

  const on = await session("fe", ["--dangerously-load-development-channels", "server:grayboard"]);
  expect(on.getInstructions()).not.toContain("Warning:");
  expect((await texts(on)).some((t) => t.startsWith("Warning:"))).toBe(false);

  // The flagless session would drop pushes yet mark them delivered: it takes
  // none, so peers see it offline and a session with channels gets them later.
  expect((await call(on, "dm_send", { to: "be", body: "waits" })).delivered_now).toBe(false);
  const be = await startCollecting("be");
  await Bun.sleep(500);
  expect(be.pushes).toEqual(["waits"]);
}, 20_000);

async function cli(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn([process.execPath, CLI, ...args], { cwd: dir, env: busEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code, out, err };
}

async function exitOf(identity: string, extra: Record<string, string> = {}): Promise<{ code: number; err: string }> {
  const p = Bun.spawn([process.execPath, CLI, "mcp", "--mode", "local"], { cwd: dir, env: { ...busEnv(identity), ...extra }, stdin: "ignore", stderr: "pipe" });
  return { code: await p.exited, err: await new Response(p.stderr).text() };
}

test("the human's handle: BUS_HUMAN needs a declaration, and agents can't take it by name", async () => {
  expect(await exitOf("alex", { BUS_HUMAN: "1" })).toMatchObject({ code: 1, err: expect.stringContaining("grayboard human alex") });
  expect((await cli("announce", "hi")).err).toContain("no human handle declared");
  expect((await cli("human", "alex")).code).toBe(0);
  expect((await cli("human")).out.trim()).toBe("alex");
  expect(await exitOf("alex")).toMatchObject({ code: 1, err: expect.stringContaining("your user's handle") });
  // Declared, with BUS_HUMAN=1 as the bridge runs it: starts (and exits 0 at stdin EOF).
  expect((await exitOf("alex", { BUS_HUMAN: "1" })).code).toBe(0);
}, 20_000);

test("grayboard board create makes a board as the human; agents see it", async () => {
  expect((await cli("board", "create", "workspace", "lanes")).err).toContain("no human handle declared");
  await cli("human", "alex");
  const r = await cli("board", "create", "#Workspace", "lane", "count", "and", "naming");
  expect(r.code).toBe(0);
  expect(r.out).toContain("Created #workspace");
  expect((await cli("board", "create", "workspace", "again")).err).toContain("already exists");
  const be = await start("be");
  const b = (await call(be, "board_list")).find((x: any) => x.name === "workspace");
  expect(b).toMatchObject({ purpose: "lane count and naming", created_by: "alex" });
}, 20_000);

test("grayboard announce reaches live sessions marked human; a TTL carries it into new sessions", async () => {
  await cli("human", "alex");
  const pushes: { content: string; meta: Record<string, string> }[] = [];
  const be = new Client({ name: "test", version: "0" });
  be.fallbackNotificationHandler = async (n) => {
    if (n.method === "notifications/claude/channel") pushes.push(n.params as (typeof pushes)[number]);
  };
  await be.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp", "--mode", "local"], cwd: dir, env: busEnv("be"), stderr: "ignore" }));
  open.push(be);
  await stop(await start("fe"));
  await expect(call(be, "board_post", { board: "announce", body: "relayed: stop" })).rejects.toThrow(/only your user starts posts/);

  const r = await cli("announce", "--ttl", "1h", "merge", "freeze");
  expect(r.out).toContain("reached: be");
  await Bun.sleep(500);
  expect(pushes.find((p) => p.content === "merge freeze")?.meta).toMatchObject({ board: "announce", from: "alex", human: "true" });

  const fe = await start("fe");
  expect(fe.getInstructions()).toMatch(/announcements still in effect \(human="true"\): post \d+ from alex, in effect until .*: merge freeze/);
}, 20_000);

test("attachments: sent with a DM or post, shown on reads and pushes, fetched by readers only", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);
  writeFileSync(join(dir, "shot.png"), png);
  writeFileSync(join(dir, "notes.md"), "# notes");
  writeFileSync(join(dir, ".env"), "TOKEN=x");
  const be = await start("be");
  const fe = await start("fe");
  const sim = await start("sim");
  const pushes: Record<string, string>[] = [];
  fe.fallbackNotificationHandler = async (n) => {
    pushes.push((n.params as { meta: Record<string, string> }).meta);
  };

  await expect(call(be, "dm_send", { to: "fe", body: "x", attachments: [".env"] })).rejects.toThrow(/dotfiles/);
  await expect(call(be, "dm_send", { to: "fe", body: "x", attachments: ["/etc/hosts"] })).rejects.toThrow(/outside the directories/);
  const sent = await call(be, "dm_send", { to: "fe", body: "see these", attachments: ["shot.png", join(dir, "notes.md")] });
  const [shot, notes] = sent.attachments;
  expect(shot).toEqual({ id: expect.any(Number), filename: "shot.png", type: "image/png", size: png.length });
  expect(notes).toMatchObject({ filename: "notes.md", type: "text/markdown", size: 7 });

  await Bun.sleep(300);
  const meta = pushes.find((m) => m.message_id === String(sent.message_id))!;
  expect(meta.attachments).toBe(`${shot.id}:shot.png image/png 10B; ${notes.id}:notes.md text/markdown 7B`);
  expect((await call(fe, "dm_thread", { thread: sent.message_id }))[0].attachments).toEqual(sent.attachments);
  expect((await call(fe, "dm_inbox")).unanswered[0].attachments).toEqual(sent.attachments);

  const saved = await call(fe, "attachment_get", { id: shot.id });
  expect(saved.path).toBe(join(dir, "saved", `${shot.id}-shot.png`));
  expect(new Uint8Array(readFileSync(saved.path))).toEqual(png);
  mkdirSync(join(dir, "out"));
  expect((await call(fe, "attachment_get", { id: notes.id, dir: "out" })).path).toBe(join(realpathSync(dir), "out", `${notes.id}-notes.md`));
  await expect(call(fe, "attachment_get", { id: notes.id, dir: "/" })).rejects.toThrow(/outside the directories/);
  await expect(call(sim, "attachment_get", { id: shot.id })).rejects.toThrow(/no attachment/);

  await call(be, "board_create", { name: "e2e", purpose: "fixtures" });
  await call(fe, "board_subscribe", { board: "e2e", mode: "push" });
  await expect(call(be, "board_post", { board: "e2e", body: "x", parent_id: 9999, attachments: ["shot.png"] })).rejects.toThrow(/parent_id/);
  const posted = await call(be, "board_post", { board: "e2e", body: "shot", attachments: ["shot.png"] });
  expect(posted.attachments).toEqual([{ id: expect.any(Number), filename: "shot.png", type: "image/png", size: png.length }]);
  await Bun.sleep(300);
  expect(pushes.find((m) => m.post_id === String(posted.post_id))!.attachments).toBe(`${posted.attachments[0].id}:shot.png image/png 10B`);
  expect((await call(sim, "board_read", { board: "e2e" })).posts[0].attachments).toEqual(posted.attachments);
  expect((await call(sim, "attachment_get", { id: posted.attachments[0].id })).size).toBe(png.length);

  const { Database } = await import("bun:sqlite");
  const db = new Database(join(dir, "bus.db"));
  const count = () => (db.prepare(`SELECT COUNT(*) AS n FROM attachments`).get() as { n: number }).n;
  // The refused post's upload rolled back with it; the blob is shared by content.
  expect(count()).toBe(3);
  expect((db.prepare(`SELECT COUNT(*) AS n FROM attachment_blobs`).get() as { n: number }).n).toBe(2);

  await stop(fe);
  const queued = await call(be, "dm_send", { to: "fe", body: "oops", attachments: ["notes.md"] });
  expect(count()).toBe(4);
  expect(await call(be, "dm_retract", { message_id: queued.message_id })).toBe("ok");
  expect(count()).toBe(3);
  db.close();
}, 20_000);
