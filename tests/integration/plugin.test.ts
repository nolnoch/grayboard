// The server-mode MCP process (src/plugin/mcp.ts) against an in-memory
// server: what was queued while a session was offline reaches it at start.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GrayboardClient } from "../../src/plugin/client.ts";
import { startServer } from "../../src/server/app.ts";
import { describeLocation } from "../../src/shared/identity.ts";
import { HUMAN_RESERVED } from "../../src/shared/addressing.ts";
import { serverBusDir } from "../../src/shared/attachments.ts";

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
      admins: [],
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
  expect(again.c.getInstructions()).toMatch(/Others': ticket:ENG-3\. Respect them; claim_list shows holders and the current state\.$/);
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

test("dm_ack takes a list in server mode: one frame per id, unknown ids reported", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const be = await session(alice, "be");
  const fe = await session(bob, "fe");
  const ids = [];
  for (const body of ["a", "b"]) ids.push((await fe.call("dm_send", { to: "alice@example.com/be", body })).message_id);
  expect(await be.call("dm_ack", { message_id: ids })).toBe("ok");
  expect((await be.call("dm_inbox")).unanswered).toEqual([]);
  const mine = (await be.call("dm_send", { to: "bob@example.com/fe", body: "mine" })).message_id;
  const c = (await fe.call("dm_send", { to: "alice@example.com/be", body: "c" })).message_id;
  expect(await be.call("dm_ack", { message_id: [c, mine] })).toMatchObject({ acked: [c], not_found: [mine] });
  await expect(be.call("dm_ack", { message_id: [mine] })).rejects.toThrow(/no message/);
}, 20_000);

test("dm_retract in server mode: withdraws a queued message, errors on a delivered one", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const be = await session(alice, "be");
  const fe = await session(bob, "fe");
  const live = (await be.call("dm_send", { to: "bob@example.com/fe", body: "live" })).message_id;
  await expect(be.call("dm_retract", { message_id: live })).rejects.toThrow(/already reached/);
  await fe.c.close();
  open.splice(open.indexOf(fe.c), 1);
  await Bun.sleep(200);
  const queued = (await be.call("dm_send", { to: "bob@example.com/fe", body: "queued" })).message_id;
  expect(await be.call("dm_retract", { message_id: queued })).toBe("ok");
}, 20_000);

test("grayboard claims in server mode reads /api/claims and leaves out boards", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const be = await session(alice, "be");
  await be.call("board_create", { name: "e2e", purpose: "fixtures" });
  await be.call("claim_take", { key: "dev:env", board: "e2e", note: "migrating" });
  const r = await fetch(`${base}/api/claims?prefix=dev:`, { headers: { Authorization: `Bearer ${bob}` } });
  expect(await r.json()).toEqual([expect.not.objectContaining({ board: expect.anything() })]);

  const dir = mkdtempSync(join(tmpdir(), "grayboard-claims-"));
  const claims = async (token: string, email: string, identity: string) => {
    const creds = join(dir, `${identity}-${email}`);
    writeFileSync(creds, JSON.stringify({ session_token: token, server: base, user_email: email }));
    const env = { ...process.env, GRAYBOARD_CREDENTIALS: creds, BUS_IDENTITY: identity } as Record<string, string>;
    delete env.GRAYBOARD_TOKEN;
    delete env.GRAYBOARD_SERVER;
    const p = Bun.spawn([process.execPath, CLI, "claims", "--prefix", "dev:"], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
    return { code: await p.exited, err: await new Response(p.stderr).text() };
  };
  const held = await claims(bob, "bob@example.com", "fe");
  expect(held.code).toBe(2);
  expect(held.err).toContain("dev:env held by alice@example.com/be until");
  expect((await claims(alice, "alice@example.com", "be")).code).toBe(0);
  expect((await claims("bogus", "bob@example.com", "fe")).code).toBe(1);
}, 20_000);

test("the client reports where it runs, and a dropped connection resumes without clearing its status", async () => {
  const alice = await login("alice@example.com");
  const noop = async () => {};
  const be = new GrayboardClient(base, () => alice, "be", noop, noop);
  be.connect();
  await be.ready();
  await be.request({ type: "call", tool: "peer_status", args: { text: "soaking" } });

  (be as any).ws.close();
  await Bun.sleep(1500); // first reconnect backoff is 1s
  await be.ready();
  const fe = await session(await login("bob@example.com"), "fe");
  const me = (await fe.call("peer_list")).peers.find((p: any) => p.handle === "alice@example.com/be");
  be.close();
  expect(me).toMatchObject({ online: true, where: describeLocation(process.cwd()), status: "soaking" });
}, 20_000);

test("a refused token says to sign in again: at startup, in a running session's tools, and in the CLI", async () => {
  const noop = async () => {};
  const msg = (running: boolean) => (running ? "sign in; reconnecting" : "sign in");

  const stale = new GrayboardClient(base, () => "stale", "be", noop, noop, true, msg);
  stale.connect();
  await expect(stale.ready()).rejects.toThrow(/^sign in$/);

  // A running session whose token is revoked (as by a database reset)...
  let token = await login("alice@example.com");
  const be = new GrayboardClient(base, () => token, "be", noop, noop, true, msg);
  be.connect();
  await be.ready();
  await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  (be as any).ws.close();
  await Bun.sleep(1500); // the first reconnect (after 1s) is refused
  await expect(be.request({ type: "inbox" })).rejects.toThrow("sign in; reconnecting");
  // ...picks up a new sign-in on its next reconnect (2s later).
  token = await login("alice@example.com");
  await Bun.sleep(2500);
  expect(await be.request({ type: "inbox" })).toMatchObject({ type: "inbox_ok" });
  be.close();

  const creds = join(mkdtempSync(join(tmpdir(), "gb-creds-")), "credentials");
  writeFileSync(creds, JSON.stringify({ session_token: "stale", server: base, user_email: "alice@example.com" }));
  const { GRAYBOARD_SERVER: _, ...env } = process.env;
  const p = Bun.spawn([process.execPath, CLI, "team", "list"], {
    env: { ...env, GRAYBOARD_CREDENTIALS: creds },
    stderr: "pipe",
  });
  expect(await p.exited).toBe(1);
  expect(await new Response(p.stderr).text()).toContain(
    `Error (unauthenticated): your sign-in isn't valid on ${base} (signed out, expired, revoked, or the server's database was reset). Run: grayboard login --server ${base}`,
  );
}, 20_000);

test("a hello the server refuses exits at once with its reason, not a timeout (#74)", async () => {
  const token = await login("alice@example.com");
  const env = { ...process.env, GRAYBOARD_TOKEN: token, GRAYBOARD_SERVER: base, BUS_IDENTITY: "human" } as Record<string, string>;
  const t0 = Date.now();
  const p = Bun.spawn([process.execPath, CLI, "mcp", "--mode", "server"], { env, stdin: "pipe", stdout: "ignore", stderr: "pipe" });
  expect(await p.exited).toBe(1);
  expect(Date.now() - t0).toBeLessThan(5000);
  expect(await new Response(p.stderr).text()).toContain(HUMAN_RESERVED);
}, 20_000);

test("login and logout use GRAYBOARD_CREDENTIALS, not ~/.grayboard", async () => {
  const home = mkdtempSync(join(tmpdir(), "gb-home-"));
  const creds = join(mkdtempSync(join(tmpdir(), "gb-creds-")), "sub", "credentials");
  const { GRAYBOARD_SERVER: _, ...env } = process.env;
  const run = async (...args: string[]) => {
    const p = Bun.spawn([process.execPath, CLI, ...args], { env: { ...env, HOME: home, GRAYBOARD_CREDENTIALS: creds }, stdout: "ignore", stderr: "pipe" });
    expect(await p.exited, await new Response(p.stderr).text()).toBe(0);
  };

  await run("login", "--dev", "alice@example.com", "--server", base);
  expect(JSON.parse(readFileSync(creds, "utf8"))).toMatchObject({ server: base, user_email: "alice@example.com" });
  expect(existsSync(join(home, ".grayboard"))).toBe(false);

  await run("logout");
  expect(readFileSync(creds, "utf8")).toBe("");
  expect(existsSync(join(home, ".grayboard"))).toBe(false);
});

test("grayboard claim in server mode acts as one of your identities; its sessions are woken", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const be = await session(alice, "be");
  await session(bob, "fe");
  await be.call("board_create", { name: "e2e", purpose: "fixtures" });

  const dir = mkdtempSync(join(tmpdir(), "grayboard-claim-"));
  const gb = async (token: string, email: string, identity: string, ...args: string[]) => {
    const creds = join(dir, `${identity}-${email}`);
    writeFileSync(creds, JSON.stringify({ session_token: token, server: base, user_email: email }));
    const env = { ...process.env, HOME: dir, GRAYBOARD_CREDENTIALS: creds, BUS_IDENTITY: identity } as Record<string, string>;
    delete env.GRAYBOARD_TOKEN;
    delete env.GRAYBOARD_SERVER;
    const p = Bun.spawn([process.execPath, CLI, ...args], { cwd: dir, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code, out, err };
  };

  const who = JSON.parse((await gb(bob, "bob@example.com", "FE", "--json", "whoami")).out);
  expect(who).toMatchObject({ handle: "bob@example.com/fe", source: "BUS_IDENTITY", email: "bob@example.com" });

  const took = await gb(bob, "bob@example.com", "fe", "claim", "take", "sandbox:sbx-1", "--board", "e2e", "--note", "smoke");
  expect(took.code, took.err).toBe(0);
  expect((await be.call("claim_list"))).toMatchObject([{ key: "sandbox:sbx-1", holder: "bob@example.com/fe", note: "smoke" }]);

  const held = await gb(alice, "alice@example.com", "be", "claim", "take", "sandbox:sbx-1");
  expect(held.code).toBe(2);
  expect(JSON.parse(held.out)).toMatchObject({ ok: false, held_by: "bob@example.com/fe" });

  await be.call("claim_watch", { key: "sandbox:sbx-1" });
  expect((await gb(bob, "bob@example.com", "fe", "claim", "release", "sandbox:sbx-1", "--note", "done")).code).toBe(0);
  await Bun.sleep(300);
  expect(be.pushes.map((p) => p.content)).toContain("[release] sandbox:sbx-1 — done cc @alice@example.com/be");

  const unknown = await gb(alice, "alice@example.com", "nope", "claim", "take", "k");
  expect(unknown.code).toBe(1);
  expect(unknown.err).toContain(`no session has used identity "nope"`);
}, 20_000);

test("a frame the server can't parse is answered with its req_id, so the call fails instead of hanging (#40)", async () => {
  const noop = async () => {};
  const token = await login("alice@example.com");
  const be = new GrayboardClient(base, () => token, "be", noop, noop);
  be.connect();
  await be.ready();
  await expect(be.request({ type: "send", recipient: "alice@example.com/be", body: "x", parent_id: "5" })).rejects.toThrow(/bad_request: .*parent_id/);
  be.close();
}, 20_000);

test("attachments in server mode: dm_send and board_post upload files, pushes name them, attachment_get saves them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-attach-"));
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);
  writeFileSync(join(dir, "shot.png"), png);
  writeFileSync(join(dir, "notes.md"), "# notes");
  writeFileSync(join(dir, ".env"), "TOKEN=x");
  const env = { GRAYBOARD_ATTACHMENTS_DIR: join(dir, "saved") };
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const carol = await login("carol@example.com");
  const be = await session(alice, "be", env);
  const fe = await session(bob, "fe", env);
  const sim = await session(carol, "sim", env);

  await expect(be.call("dm_send", { to: "bob@example.com/fe", body: "x", attachments: [join(dir, ".env")] })).rejects.toThrow(/dotfiles/);
  const sent = await be.call("dm_send", { to: "bob@example.com/fe", body: "see these", attachments: [join(dir, "shot.png"), join(dir, "notes.md")] });
  const [shot, notes] = sent.attachments;
  expect(shot).toEqual({ id: expect.any(Number), filename: "shot.png", type: "image/png", size: png.length });
  expect(notes).toMatchObject({ filename: "notes.md", type: "text/markdown", size: 7 });
  await Bun.sleep(300);
  expect(fe.pushes.find((p) => p.content === "see these")!.meta.attachments).toBe(`${shot.id}:shot.png image/png 10B; ${notes.id}:notes.md text/markdown 7B`);

  const saved = await fe.call("attachment_get", { id: shot.id });
  expect(saved).toEqual({ path: join(dir, "saved", serverBusDir(base), `${shot.id}-shot.png`), filename: "shot.png", type: "image/png", size: png.length });
  expect(new Uint8Array(readFileSync(saved.path))).toEqual(png);
  await expect(sim.call("attachment_get", { id: shot.id })).rejects.toThrow(`no attachment ${shot.id} on a message or post you can read`);

  await be.call("board_create", { name: "e2e", purpose: "fixtures" });
  const posted = await be.call("board_post", { board: "e2e", body: "@sim shot", attachments: [join(dir, "shot.png")] });
  expect(posted.attachments).toEqual([{ id: expect.any(Number), filename: "shot.png", type: "image/png", size: png.length }]);
  await Bun.sleep(300);
  expect(sim.pushes.find((p) => p.content === "@sim shot")!.meta.attachments).toBe(`${posted.attachments[0].id}:shot.png image/png 10B`);
  expect((await sim.call("attachment_get", { id: posted.attachments[0].id, dir })).path).toBe(join(realpathSync(dir), `${posted.attachments[0].id}-shot.png`));
}, 20_000);

test("a send the server refuses releases its uploads, so they don't hold the user's unsent quota", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-attach-"));
  writeFileSync(join(dir, "notes.md"), "# notes");
  const be = await session(await login("alice@example.com"), "be");
  const unsent = () => app.db.query("SELECT COUNT(*) AS n FROM attachments").get();
  await expect(be.call("dm_send", { to: "nobody@example.com/x", body: "x", attachments: [join(dir, "notes.md")] })).rejects.toThrow();
  await expect(be.call("board_post", { board: "nope", body: "x", attachments: [join(dir, "notes.md")] })).rejects.toThrow();
  // Refused before anything is uploaded.
  await expect(be.call("dm_send", { to: "be", body: "x".repeat(70_000), attachments: [join(dir, "notes.md")] })).rejects.toThrow(/body exceeds/);
  expect(unsent()).toEqual({ n: 0 });
  expect(app.db.query("SELECT COUNT(*) AS n FROM attachment_blobs").get()).toEqual({ n: 0 });
  const audit = app.db.query("SELECT action FROM access_log WHERE action LIKE 'attachment.%' ORDER BY id").all();
  expect(audit).toEqual([
    { action: "attachment.uploaded" }, { action: "attachment.released" },
    { action: "attachment.uploaded" }, { action: "attachment.released" },
  ]);
}, 20_000);

test("the plugin checks files against the server's limits from hello_ok before uploading", async () => {
  app.stop();
  app = startServer(
    {
      dbPath: ":memory:", httpPort: 0, googleClientId: "dev", googleClientSecret: "", orgDomain: "example.com",
      publicUrl: "http://localhost", messageRetentionDays: 90, auditRetentionDays: 90, devAuth: true, admins: [],
      attachmentLimits: { file: 5, total: 10 },
    },
    { background: false },
  );
  base = `http://localhost:${app.server.port}`;
  const dir = mkdtempSync(join(tmpdir(), "gb-attach-"));
  writeFileSync(join(dir, "notes.md"), "# notes");
  const be = await session(await login("alice@example.com"), "be");
  await expect(be.call("dm_send", { to: "be", body: "x", attachments: [join(dir, "notes.md")] })).rejects.toThrow(/notes\.md: 7B exceeds the 5B limit/);
  expect(app.db.query("SELECT COUNT(*) AS n FROM attachments").get()).toEqual({ n: 0 });
}, 20_000);

test("attachments against a server from before them: the upload says the server needs updating", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-attach-"));
  writeFileSync(join(dir, "notes.md"), "# notes");
  // Passes everything through to the real server except the upload route,
  // which gets an older router's catch-all.
  type Pipe = { auth: string; up?: WebSocket; queue: (string | Buffer)[] };
  const proxy = Bun.serve<Pipe>({
    port: 0,
    fetch(req, srv) {
      const u = new URL(req.url);
      if (u.pathname === "/api/attachments") return Response.json({ code: "not_found", message: "not found" }, { status: 404 });
      if (req.headers.get("upgrade")) return srv.upgrade(req, { data: { auth: req.headers.get("authorization") ?? "", queue: [] } }) ? undefined : new Response("no", { status: 500 });
      return fetch(`${base}${u.pathname}${u.search}`, { method: req.method, headers: req.headers, body: req.body });
    },
    websocket: {
      open(ws) {
        const up = new (WebSocket as any)(`${base.replace("http", "ws")}/ws`, { headers: { Authorization: ws.data.auth } }) as WebSocket;
        ws.data.up = up;
        up.onopen = () => ws.data.queue.splice(0).forEach((m) => up.send(m));
        up.onmessage = (e) => ws.send(e.data as string);
        up.onclose = () => ws.close();
      },
      message(ws, m) {
        if (ws.data.up?.readyState === WebSocket.OPEN) ws.data.up.send(m);
        else ws.data.queue.push(m);
      },
      close(ws) {
        ws.data.up?.close();
      },
    },
  });
  try {
    const alice = await login("alice@example.com");
    const be = await session(alice, "be", { GRAYBOARD_SERVER: `http://localhost:${proxy.port}` });
    await expect(be.call("dm_send", { to: "be", body: "x", attachments: [join(dir, "notes.md")] })).rejects.toThrow(
      "this server doesn't take attachments; it needs updating",
    );
    expect(await be.call("dm_send", { to: "be", body: "plain" })).toMatchObject({ message_id: expect.any(Number) });
  } finally {
    proxy.stop(true);
  }
}, 20_000);
