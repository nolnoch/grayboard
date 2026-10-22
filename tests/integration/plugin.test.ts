// The server-mode MCP process (src/plugin/mcp.ts) against an in-memory
// server: what was queued while a session was offline reaches it at start.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GrayboardClient } from "../../src/plugin/client.ts";
import { startServer } from "../../src/server/app.ts";
import { describeLocation } from "../../src/shared/identity.ts";
import { HUMAN_RESERVED } from "../../src/shared/addressing.ts";

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

// A session paused past the heartbeat's miss window (a sleep, a SIGSTOP)
// is closed as half-open. The close code decides what happens on resume:
// lost_ownership reconnects and re-attaches; the pre-fix superseded made
// the client exit for good (N1, Wade's repro: 300ms pings, miss limit 2,
// 2s SIGSTOP).
test("a session paused past the ping-miss window resumes by reconnecting, not exiting (N1)", async () => {
  const local = startServer(
    { dbPath: ":memory:", httpPort: 0, googleClientId: "dev", googleClientSecret: "", orgDomain: "example.com", publicUrl: "http://localhost", messageRetentionDays: 90, auditRetentionDays: 90, devAuth: true, admins: [] },
    { background: false, pingIntervalMs: 300, pingMissLimit: 2 },
  );
  const base2 = `http://localhost:${local.server.port}`;
  try {
    const token = ((await (await fetch(`${base2}/api/auth/dev-login`, { method: "POST", body: JSON.stringify({ email: "alice@example.com" }) })).json()) as { session_token: string }).session_token;
    const p = Bun.spawn([process.execPath, CLI, "mcp", "--mode", "server"], {
      env: { ...process.env, GRAYBOARD_TOKEN: token, GRAYBOARD_SERVER: base2, BUS_IDENTITY: "be" } as Record<string, string>,
      stdin: "pipe", stdout: "ignore", stderr: "pipe",
    });
    const fleetLive = async () => {
      const rows = await (await fetch(`${base2}/api/fleet?identity=be`, { headers: { Authorization: `Bearer ${token}` } })).json() as { live: boolean }[];
      return Array.isArray(rows) && rows.some((l) => l.live);
    };
    for (let i = 0; i < 50 && !(await fleetLive()); i++) await Bun.sleep(100);
    expect(await fleetLive()).toBe(true); // connected

    process.kill(p.pid!, "SIGSTOP"); // the machine went to sleep
    await Bun.sleep(2_000);           // past the miss window: closed meanwhile
    process.kill(p.pid!, "SIGCONT");  // wake: must reconnect, not exit

    let reconnected = false;
    for (let i = 0; i < 60 && !reconnected; i++) {
      await Bun.sleep(100);
      reconnected = await fleetLive();
    }
    expect(reconnected).toBe(true);
    expect(p.exitCode).toBe(null); // never exited
    p.kill();
    await p.exited;
  } finally {
    local.stop();
  }
}, 20_000);

test("a true identity_in_use refusal still exits the client (N1: only lost ownership reconnects)", async () => {
  const token = await login("alice@example.com");
  const holder = Bun.spawn([process.execPath, CLI, "mcp", "--mode", "server"], {
    env: { ...process.env, GRAYBOARD_TOKEN: token, GRAYBOARD_SERVER: base, BUS_IDENTITY: "be" } as Record<string, string>,
    stdin: "pipe", stdout: "ignore", stderr: "pipe",
  });
  const fleetLive = async () => {
    const rows = await (await fetch(`${base}/api/fleet?identity=be`, { headers: { Authorization: `Bearer ${token}` } })).json() as { live: boolean }[];
    return Array.isArray(rows) && rows.some((l) => l.live);
  };
  for (let i = 0; i < 50 && !(await fleetLive()); i++) await Bun.sleep(100);
  expect(await fleetLive()).toBe(true);

  // A second session, same identity and lane: the holder answers the
  // probe, so this is a genuine refusal — the client must exit, not retry.
  const second = Bun.spawn([process.execPath, CLI, "mcp", "--mode", "server"], {
    env: { ...process.env, GRAYBOARD_TOKEN: token, GRAYBOARD_SERVER: base, BUS_IDENTITY: "be" } as Record<string, string>,
    stdin: "pipe", stdout: "ignore", stderr: "pipe",
  });
  expect(await second.exited).toBe(1);
  holder.kill();
  await holder.exited;
}, 20_000);

// The close-code taxonomy, pinned from the client's side: only LOST
// OWNERSHIP reconnects. A newer session taking over the SAME lane key is
// terminal — otherwise two clients on one lane reconnect-supersede each
// other forever. The displaced client exits ONCE and never re-enters.
test("a same-lane takeover is terminal: the displaced client exits once, no reconnect flap", async () => {
  const local = startServer(
    { dbPath: ":memory:", httpPort: 0, googleClientId: "dev", googleClientSecret: "", orgDomain: "example.com", publicUrl: "http://localhost", messageRetentionDays: 90, auditRetentionDays: 90, devAuth: true, admins: [] },
    { background: false, probeMs: 300 },
  );
  const base2 = `http://localhost:${local.server.port}`;
  try {
    const token = ((await (await fetch(`${base2}/api/auth/dev-login`, { method: "POST", body: JSON.stringify({ email: "alice@example.com" }) })).json()) as { session_token: string }).session_token;
    const spawnBe = () => Bun.spawn([process.execPath, CLI, "mcp", "--mode", "server"], {
      // BUS_LANE pins the lane: from a linked worktree (this test suite's
      // own cwd during a worktree run), an explicit BUS_IDENTITY would
      // otherwise take the worktree's name as its lane and the lane
      // assertions below would fail — and the pre-push hook with them.
      env: { ...process.env, GRAYBOARD_TOKEN: token, GRAYBOARD_SERVER: base2, BUS_IDENTITY: "be", BUS_LANE: "main" } as Record<string, string>,
      stdin: "pipe", stdout: "ignore", stderr: "pipe",
    });
    const fleet = async () => {
      const rows = await (await fetch(`${base2}/api/fleet?identity=be`, { headers: { Authorization: `Bearer ${token}` } })).json();
      // Before the first hello creates the identity, the route answers
      // not_found — poll as zero lanes until then.
      return Array.isArray(rows) ? (rows as { live: boolean }[]) : [];
    };
    const liveCount = async () => (await fleet()).filter((l) => l.live).length;

    // The older session hangs (SIGSTOP); the newer probes it, gets no
    // answer, and takes the lane — the classic same-lane takeover.
    const first = spawnBe();
    const lines: string[] = [];
    void (async () => { const r = first.stderr.getReader(); const d = new TextDecoder(); let buf = ""; for (;;) { const { done, value } = await r.read(); if (done) break; buf += d.decode(value); const nl = buf.split("\n"); lines.push(...nl.slice(0, -1)); buf = nl.at(-1)!; } })();
    for (let i = 0; i < 50 && (await liveCount()) !== 1; i++) await Bun.sleep(100);
    expect(await liveCount()).toBe(1);
    process.kill(first.pid!, "SIGSTOP");

    // The newer session probes the stopped holder, gets no answer, and
    // supersedes it. Wait for the TAKEOVER, not just "one live lane": the
    // stopped owner's row already counts as live, and a SIGCONT that lands
    // while the probe is still in flight lets the owner answer it and win
    // its lane back — the taker is (correctly) refused instead. The row's
    // first_seen changes only when the supersede ends the old row and the
    // taker's join writes a fresh one.
    const seenBefore = (await fleet()).find((r) => r.lane === "main")?.first_seen;
    const second = spawnBe();
    let taken = false;
    for (let i = 0; i < 50 && !taken; i++) {
      const main = (await fleet()).find((r) => r.lane === "main");
      taken = !!main && main.live && main.first_seen !== seenBefore;
      if (!taken) await Bun.sleep(100);
    }
    expect(taken).toBe(true); // the newer session holds the lane

    // The displaced client wakes to the terminal code: exits once, no
    // reconnect (bounded race so a never-exiting client fails the pin
    // instead of hanging it). Note on the guard's shape: this pins the
    // exit-once contract via the client's own stderr line — a mutant that
    // reconnects AND flaps would show repeated lines and fail, but a mutant
    // whose reconnect is refused by identity_in_use doesn't flap either;
    // the no-starve test pins the reconnect path itself.
    process.kill(first.pid!, "SIGCONT");
    const exited = await Promise.race([first.exited, Bun.sleep(5_000).then(() => null)]);
    expect(exited).toBe(1);
    const err1 = lines.join("\n");
    expect(err1.match(/superseded by a newer session — exiting/g)).toHaveLength(1);

    // No flap: past the reconnect backoff (1s), the lane still holds
    // exactly one live connection — the newer session's.
    await Bun.sleep(2_500);
    expect(await liveCount()).toBe(1);
    second.kill();
    await second.exited;
  } finally {
    local.stop();
  }
}, 20_000);
