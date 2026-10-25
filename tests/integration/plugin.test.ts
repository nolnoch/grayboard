// The server-mode MCP process (src/plugin/mcp.ts) against an in-memory
// server: what was queued while a session was offline reaches it at start.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mintSessionKey } from "../../src/core/bindings.ts";
import { GrayboardClient } from "../../src/plugin/client.ts";
import { describeLocation } from "../../src/shared/identity.ts";
import { HUMAN_RESERVED } from "../../src/shared/addressing.ts";
import { serverBusDir } from "../../src/shared/attachments.ts";
import { sha256Hex } from "../../src/shared/hash.ts";
import { runCli } from "../support/cli.ts";
import { cleanEnv, serverEnv } from "../support/env.ts";
import { closeSessions, stopSession } from "../support/mcp.ts";
import { TestServer } from "../support/server.ts";
import { until } from "../support/until.ts";

let srv: TestServer;

beforeEach(() => {
  srv = new TestServer();
});

afterEach(async () => {
  await closeSessions();
  srv.stop();
});

const login = (email: string) => srv.login(email);

const session = (token: string, identity: string, extra: Record<string, string> = {}) => srv.session(token, identity, extra);

test("queued messages and posts are pushed at session start; instructions list claims", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const be = await session(alice, "be");
  await be.call("board_create", { name: "e2e", purpose: "fixtures" });
  await stopSession(be.c);

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
  await stopSession(fe.c);
  const queued = (await be.call("dm_send", { to: "bob@example.com/fe", body: "queued" })).message_id;
  expect(await be.call("dm_retract", { message_id: queued })).toBe("ok");
}, 20_000);

test("grayboard claims in server mode reads /api/claims and leaves out boards", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  const be = await session(alice, "be");
  await be.call("board_create", { name: "e2e", purpose: "fixtures" });
  await be.call("claim_take", { key: "dev:env", board: "e2e", note: "migrating" });
  const r = await fetch(`${srv.base}/api/claims?prefix=dev:`, { headers: { Authorization: `Bearer ${bob}` } });
  expect(await r.json()).toEqual([expect.not.objectContaining({ board: expect.anything() })]);

  const dir = mkdtempSync(join(srv.dir, "grayboard-claims-"));
  const claims = async (token: string, email: string, identity: string) => {
    const creds = join(dir, `${identity}-${email}`);
    writeFileSync(creds, JSON.stringify({ session_token: token, server: srv.base, user_email: email }));
    return runCli(["claims", "--prefix", "dev:"], { cwd: dir, env: cleanEnv({ GRAYBOARD_CREDENTIALS: creds, BUS_IDENTITY: identity }) });
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
  const be = new GrayboardClient(srv.base, () => alice, "be", mintSessionKey(), noop, noop);
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

  const stale = new GrayboardClient(srv.base, () => "stale", "be", mintSessionKey(), noop, noop, true, msg);
  stale.connect();
  await expect(stale.ready()).rejects.toThrow(/^sign in$/);

  // A running session whose token is revoked (as by a database reset)...
  let token = await login("alice@example.com");
  const be = new GrayboardClient(srv.base, () => token, "be", mintSessionKey(), noop, noop, true, msg, { tokenPollMs: 200 });
  be.connect();
  await be.ready();
  await fetch(`${srv.base}/api/auth/logout`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  (be as any).ws.close();
  await Bun.sleep(1500); // the first reconnect (after 1s) is refused
  await expect(be.request({ type: "inbox" })).rejects.toThrow("sign in; reconnecting");
  // ...picks up a new sign-in at its next look at the token.
  token = await login("alice@example.com");
  await until(async () => (await be.request({ type: "inbox" }).catch(() => null))?.type === "inbox_ok", 3000);
  be.close();

  const creds = join(mkdtempSync(join(srv.dir, "gb-creds-")), "credentials");
  writeFileSync(creds, JSON.stringify({ session_token: "stale", server: srv.base, user_email: "alice@example.com" }));
  const r = await runCli(["team", "list"], { env: cleanEnv({ GRAYBOARD_CREDENTIALS: creds }) });
  expect(r.code).toBe(1);
  expect(r.err).toContain(
    `Error (unauthenticated): your sign-in isn't valid on ${srv.base} (signed out, expired, revoked, or the server's database was reset). Run: grayboard login --server ${srv.base}`,
  );
}, 20_000);

test("a hello the server refuses exits at once with its reason, not a timeout (#74)", async () => {
  const token = await login("alice@example.com");
  const t0 = Date.now();
  const r = await runCli(["mcp", "--mode", "server"], { env: serverEnv(srv.dir, srv.base, token, "human"), holdStdin: true });
  expect(r.code).toBe(1);
  expect(Date.now() - t0).toBeLessThan(5000);
  expect(r.err).toContain(HUMAN_RESERVED);
}, 20_000);

test("login and logout use GRAYBOARD_CREDENTIALS, not ~/.grayboard", async () => {
  const home = mkdtempSync(join(srv.dir, "gb-home-"));
  const creds = join(mkdtempSync(join(srv.dir, "gb-creds-")), "sub", "credentials");
  const run = async (...args: string[]) => {
    const r = await runCli(args, { env: cleanEnv({ HOME: home, GRAYBOARD_CREDENTIALS: creds }) });
    expect(r.code, r.err).toBe(0);
  };

  await run("login", "--dev", "alice@example.com", "--server", srv.base);
  expect(JSON.parse(readFileSync(creds, "utf8"))).toMatchObject({ server: srv.base, user_email: "alice@example.com" });
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

  const dir = mkdtempSync(join(srv.dir, "grayboard-claim-"));
  const gb = async (token: string, email: string, identity: string, ...args: string[]) => {
    const creds = join(dir, `${identity}-${email}`);
    writeFileSync(creds, JSON.stringify({ session_token: token, server: srv.base, user_email: email }));
    return runCli(args, { cwd: dir, env: cleanEnv({ HOME: dir, GRAYBOARD_CREDENTIALS: creds, BUS_IDENTITY: identity }) });
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
  const be = new GrayboardClient(srv.base, () => token, "be", mintSessionKey(), noop, noop);
  be.connect();
  await be.ready();
  await expect(be.request({ type: "send", recipient: "alice@example.com/be", body: "x", parent_id: "5" })).rejects.toThrow(/bad_request: .*parent_id/);
  be.close();
}, 20_000);

test("attachments in server mode: dm_send and board_post upload files, pushes name them, attachment_get saves them", async () => {
  const dir = mkdtempSync(join(srv.dir, "gb-attach-"));
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
  expect(shot).toEqual({ id: expect.any(Number), filename: "shot.png", type: "image/png", size: png.length, sha256: sha256Hex(png) });
  expect(notes).toMatchObject({ filename: "notes.md", type: "text/markdown", size: 7 });
  await Bun.sleep(300);
  expect(fe.pushes.find((p) => p.content === "see these")!.meta.files_tool).toMatch(/^attachment_get\(id/);
  expect(fe.pushes.find((p) => p.content === "see these")!.meta.attachments).toBe(`${shot.id}:shot.png image/png 10B sha256:${sha256Hex(png)}; ${notes.id}:notes.md text/markdown 7B sha256:${sha256Hex(new TextEncoder().encode("# notes"))}`);

  const saved = await fe.call("attachment_get", { id: shot.id });
  expect(saved).toEqual({ path: join(dir, "saved", serverBusDir(srv.base), `${shot.id}-shot.png`), filename: "shot.png", type: "image/png", size: png.length, sha256: sha256Hex(png) });
  expect(new Uint8Array(readFileSync(saved.path))).toEqual(png);
  await expect(sim.call("attachment_get", { id: shot.id })).rejects.toThrow(`no attachment ${shot.id} on a message or post you can read`);

  await be.call("board_create", { name: "e2e", purpose: "fixtures" });
  const posted = await be.call("board_post", { board: "e2e", body: "@sim shot", attachments: [join(dir, "shot.png")] });
  expect(posted.attachments).toEqual([{ id: expect.any(Number), filename: "shot.png", type: "image/png", size: png.length, sha256: sha256Hex(png) }]);
  await Bun.sleep(300);
  expect(sim.pushes.find((p) => p.content === "@sim shot")!.meta.attachments).toBe(`${posted.attachments[0].id}:shot.png image/png 10B sha256:${sha256Hex(png)}`);
  expect((await sim.call("attachment_get", { id: posted.attachments[0].id, dir })).path).toBe(join(realpathSync(dir), `${posted.attachments[0].id}-shot.png`));

  // The audit log binds each file to the message or post that carried it.
  const bound = (srv.app.db.query("SELECT target, detail FROM access_log WHERE action = 'attachment.bound' ORDER BY id").all() as { target: string; detail: string }[])
    .map((r) => ({ target: r.target, ...JSON.parse(r.detail) }));
  expect(bound).toEqual([
    { target: `attachment:${shot.id}`, identity: "alice@example.com/be", message_id: sent.message_id, recipient: "bob@example.com/fe" },
    { target: `attachment:${notes.id}`, identity: "alice@example.com/be", message_id: sent.message_id, recipient: "bob@example.com/fe" },
    { target: `attachment:${posted.attachments[0].id}`, identity: "alice@example.com/be", post_id: posted.post_id, board: "e2e" },
  ]);
}, 20_000);

test("a send the server refuses releases its uploads, so they don't hold the user's unsent quota", async () => {
  const dir = mkdtempSync(join(srv.dir, "gb-attach-"));
  writeFileSync(join(dir, "notes.md"), "# notes");
  const be = await session(await login("alice@example.com"), "be");
  const unsent = () => srv.app.db.query("SELECT COUNT(*) AS n FROM attachments").get();
  await expect(be.call("dm_send", { to: "nobody@example.com/x", body: "x", attachments: [join(dir, "notes.md")] })).rejects.toThrow();
  await expect(be.call("board_post", { board: "nope", body: "x", attachments: [join(dir, "notes.md")] })).rejects.toThrow();
  // Refused before anything is uploaded.
  await expect(be.call("dm_send", { to: "be", body: "x".repeat(70_000), attachments: [join(dir, "notes.md")] })).rejects.toThrow(/body exceeds/);
  expect(unsent()).toEqual({ n: 0 });
  expect(srv.app.db.query("SELECT COUNT(*) AS n FROM attachment_blobs").get()).toEqual({ n: 0 });
  const audit = srv.app.db.query("SELECT action FROM access_log WHERE action LIKE 'attachment.%' ORDER BY id").all();
  expect(audit).toEqual([
    { action: "attachment.uploaded" }, { action: "attachment.released" },
    { action: "attachment.uploaded" }, { action: "attachment.released" },
  ]);
}, 20_000);

test("a send whose answer is lost, though its files were bound, reports it landed instead of failing", async () => {
  const dir = mkdtempSync(join(srv.dir, "gb-attach-"));
  writeFileSync(join(dir, "notes.md"), "# notes");
  // The server's answer to a send or a board_post never arrives: the connection drops instead.
  let lose = false;
  const p = proxy(() => undefined, (frame) => {
    const msg = JSON.parse(frame) as { type: string };
    if (!lose || (msg.type !== "send_ok" && msg.type !== "call_ok")) return frame;
    setTimeout(() => p.drop(), 0);
    return JSON.stringify({ ...msg, req_id: "lost" });
  });
  try {
    const be = await session(await login("alice@example.com"), "be", { GRAYBOARD_SERVER: `http://localhost:${p.port}` });
    lose = true;
    const dm = await be.call("dm_send", { to: "be", body: "x", attachments: [join(dir, "notes.md")] });
    const row = srv.app.db.query("SELECT id, message_id FROM attachments").get() as { id: number; message_id: number };
    expect(dm).toEqual({
      sent: true,
      attachment_ids: [row.id],
      note: `sent, but the server's answer was lost (connection to the grayboard server was lost); its attachments (${row.id}) are bound to it. It landed, so there's nothing to send again; dm_history or board_read shows it.`,
    });
    // The bound upload wasn't released, and the message carries it.
    expect(row.message_id).toBeNumber();
    expect(srv.app.db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 1 });
  } finally {
    p.stop(true);
  }
}, 20_000);

test("a lost answer says a retry is safe, and the retry replays the first result (#254)", async () => {
  // The server's answers to the first send and the first post never arrive: the connection drops instead.
  let lose = 0;
  const p = proxy(() => undefined, (frame) => {
    const msg = JSON.parse(frame) as { type: string };
    if (lose === 0 || (msg.type !== "send_ok" && msg.type !== "call_ok")) return frame;
    lose--;
    setTimeout(() => p.drop(), 0);
    return JSON.stringify({ ...msg, req_id: "lost" });
  });
  try {
    const token = await login("alice@example.com");
    await stopSession((await session(token, "fe")).c);
    const be = await session(token, "be", { GRAYBOARD_SERVER: `http://localhost:${p.port}` });
    const safe = "the write may have landed. Calling again with the same arguments within 10 minutes is safe: the server returns the first result instead of sending twice.";
    lose = 1;
    await expect(be.call("dm_send", { to: "fe", body: "once" })).rejects.toThrow(`error: the server's answer was lost (connection to the grayboard server was lost); ${safe}`);
    const retry = await until(() => be.call("dm_send", { to: "fe", body: "once" }).catch(() => null), 10_000, "the reconnect");
    const id = (srv.app.db.query("SELECT id FROM messages WHERE body = 'once'").all() as { id: number }[]).map((r) => r.id);
    expect(id.length).toBe(1);
    expect(retry).toMatchObject({ message_id: id[0], replayed: { ref: { kind: "message", id: id[0] } } });
    expect(retry.note).toContain("To send it again on purpose, call with resend: true.");
    // resend passes through the plugin's schema and frame.
    expect((await be.call("dm_send", { to: "fe", body: "once", resend: true })).replayed).toBeUndefined();
    expect(srv.app.db.query("SELECT COUNT(*) AS n FROM messages WHERE body = 'once'").get()).toEqual({ n: 2 });

    await be.call("board_create", { name: "e2e", purpose: "fixtures" });
    lose = 1;
    await expect(be.call("board_post", { board: "e2e", body: "posted once" })).rejects.toThrow(safe);
    const post = await until(() => be.call("board_post", { board: "e2e", body: "posted once" }).catch(() => null), 10_000, "the reconnect");
    expect(post.replayed.ref.kind).toBe("post");
    expect(srv.app.db.query("SELECT COUNT(*) AS n FROM posts WHERE body = 'posted once'").get()).toEqual({ n: 1 });
    expect((await be.call("board_post", { board: "e2e", body: "posted once", resend: true })).replayed).toBeUndefined();

    // A lost resend: repeating it with resend would send again, so the answer says so.
    lose = 1;
    await expect(be.call("dm_send", { to: "fe", body: "again", resend: true })).rejects.toThrow(
      "It was a resend, so calling again with resend sends again; calling again without resend within 10 minutes returns its result instead.",
    );
  } finally {
    p.stop(true);
  }
}, 30_000);

test("a lost answer from a server that doesn't deduplicate says a retry may send twice", async () => {
  // A server from before #254: its hello_ok has no write_dedup.
  let lose = false;
  const p = proxy(() => undefined, (frame) => {
    const msg = JSON.parse(frame) as { type: string; write_dedup?: boolean };
    if (msg.type === "hello_ok") {
      delete msg.write_dedup;
      return JSON.stringify(msg);
    }
    if (!lose || msg.type !== "send_ok") return frame;
    lose = false;
    setTimeout(() => p.drop(), 0);
    return JSON.stringify({ ...msg, req_id: "lost" });
  });
  try {
    const be = await session(await login("alice@example.com"), "be", { GRAYBOARD_SERVER: `http://localhost:${p.port}` });
    lose = true;
    await expect(be.call("dm_send", { to: "be", body: "once" })).rejects.toThrow(
      "the write may have landed. This server doesn't deduplicate writes, so calling again may send twice: check dm_history, board_read or dm_inbox's promised list first.",
    );
  } finally {
    p.stop(true);
  }
}, 20_000);

test("the plugin checks files against the server's limits from hello_ok before uploading", async () => {
  srv.stop();
  srv = new TestServer({ attachmentLimits: { file: 5, total: 10 } });
  const dir = mkdtempSync(join(srv.dir, "gb-attach-"));
  writeFileSync(join(dir, "notes.md"), "# notes");
  const be = await session(await login("alice@example.com"), "be");
  await expect(be.call("dm_send", { to: "be", body: "x", attachments: [join(dir, "notes.md")] })).rejects.toThrow(/notes\.md: 7B exceeds the 5B limit/);
  expect(srv.app.db.query("SELECT COUNT(*) AS n FROM attachments").get()).toEqual({ n: 0 });
}, 20_000);

// A proxy to the real server that passes everything through, WebSockets
// included, except the HTTP requests `intercept` answers. `down` rewrites
// frames the server sends; `drop()` closes every session's socket, so each
// reconnects.
function proxy(intercept: (req: Request, u: URL) => Response | Promise<Response> | undefined, down: (frame: string) => string = (f) => f) {
  type Pipe = { auth: string; up?: WebSocket; queue: (string | Buffer)[] };
  const open = new Set<{ close(): void }>();
  const px = Bun.serve<Pipe>({
    port: 0,
    async fetch(req, px) {
      const u = new URL(req.url);
      const own = await intercept(req, u);
      if (own) return own;
      if (req.headers.get("upgrade")) return px.upgrade(req, { data: { auth: req.headers.get("authorization") ?? "", queue: [] } }) ? undefined : new Response("no", { status: 500 });
      return fetch(`${srv.base}${u.pathname}${u.search}`, { method: req.method, headers: req.headers, body: req.body });
    },
    websocket: {
      open(ws) {
        open.add(ws);
        const up = new (WebSocket as any)(`${srv.base.replace("http", "ws")}/ws`, { headers: { Authorization: ws.data.auth } }) as WebSocket;
        ws.data.up = up;
        up.onopen = () => ws.data.queue.splice(0).forEach((m) => up.send(m));
        up.onmessage = (e) => ws.send(down(e.data as string));
        up.onclose = () => ws.close();
      },
      message(ws, m) {
        if (ws.data.up?.readyState === WebSocket.OPEN) ws.data.up.send(m);
        else ws.data.queue.push(m);
      },
      close(ws) {
        open.delete(ws);
        ws.data.up?.close();
      },
    },
  });
  return Object.assign(px, { drop: () => [...open].forEach((ws) => ws.close()) });
}

// Rewrites the server's hello_ok.
const helloRewrite = (edit: (hello: Record<string, unknown>) => void) => (frame: string) => {
  const msg = JSON.parse(frame) as Record<string, unknown>;
  if (msg.type !== "hello_ok") return frame;
  edit(msg);
  return JSON.stringify(msg);
};

test("attachments against a server from before them: hello_ok without limits says the server needs updating", async () => {
  const dir = mkdtempSync(join(srv.dir, "gb-attach-"));
  writeFileSync(join(dir, "notes.md"), "# notes");
  let uploads = 0;
  const old = proxy(
    (_, u) => (u.pathname.startsWith("/api/attachments") && ++uploads ? Response.json({ code: "not_found", message: "not found" }, { status: 404 }) : undefined),
    helloRewrite((h) => delete h.attachment_limits),
  );
  try {
    const alice = await login("alice@example.com");
    const be = await session(alice, "be", { GRAYBOARD_SERVER: `http://localhost:${old.port}` });
    const outdated = "this server doesn't take attachments; it needs updating";
    await expect(be.call("dm_send", { to: "be", body: "x", attachments: [join(dir, "notes.md")] })).rejects.toThrow(outdated);
    await expect(be.call("attachment_get", { id: 1 })).rejects.toThrow(outdated);
    expect(uploads).toBe(0);
    expect(await be.call("dm_send", { to: "be", body: "plain" })).toMatchObject({ message_id: expect.any(Number) });
  } finally {
    old.stop(true);
  }
}, 20_000);

test("the plugin takes attachment limits from the hello_ok of each reconnect", async () => {
  const dir = mkdtempSync(join(srv.dir, "gb-attach-"));
  writeFileSync(join(dir, "notes.md"), "# notes");
  let file = 5;
  const p = proxy(() => undefined, helloRewrite((h) => (h.attachment_limits = { file, total: 1000 })));
  try {
    const be = await session(await login("alice@example.com"), "be", { GRAYBOARD_SERVER: `http://localhost:${p.port}` });
    const send = () => be.call("dm_send", { to: "be", body: "x", attachments: [join(dir, "notes.md")] });
    await expect(send()).rejects.toThrow(/7B exceeds the 5B limit/);
    file = 1000;
    p.drop();
    // The plugin reconnects about 2s later.
    for (let i = 0; i < 50; i++) {
      await Bun.sleep(100);
      try {
        expect((await send()).attachments).toHaveLength(1);
        return;
      } catch (e) {
        if (!/reconnecting|5B limit/.test((e as Error).message)) throw e;
      }
    }
    throw new Error("the limits never changed");
  } finally {
    p.stop(true);
  }
}, 20_000);

test("attachment HTTP: a refused token gets the sign-in hint, and a refused dir costs no download", async () => {
  const dir = mkdtempSync(join(srv.dir, "gb-attach-"));
  writeFileSync(join(dir, "notes.md"), "# notes");
  let downloads = 0;
  let refuse = false;
  const p = proxy((_, u) => {
    if (!u.pathname.startsWith("/api/attachments")) return undefined;
    if (refuse) return Response.json({ code: "unauthenticated", message: "invalid session" }, { status: 401 });
    if (/^\/api\/attachments\/\d+$/.test(u.pathname)) downloads++;
    return undefined;
  });
  try {
    const be = await session(await login("alice@example.com"), "be", { GRAYBOARD_SERVER: `http://localhost:${p.port}` });
    const [notes] = (await be.call("dm_send", { to: "be", body: "x", attachments: [join(dir, "notes.md")] })).attachments;
    await expect(be.call("attachment_get", { id: notes.id, dir: "/" })).rejects.toThrow(/outside the directories/);
    await expect(be.call("attachment_get", { id: 1.5 })).rejects.toThrow("id must be an attachment id");
    expect(downloads).toBe(0);
    refuse = true;
    await expect(be.call("attachment_get", { id: notes.id })).rejects.toThrow(/refused GRAYBOARD_TOKEN; set a valid one or unset it/);
  } finally {
    p.stop(true);
  }
}, 20_000);

test("attachment_get saves nothing unless the bytes match the server's Repr-Digest", async () => {
  const dir = mkdtempSync(join(srv.dir, "gb-attach-"));
  writeFileSync(join(dir, "notes.md"), "# notes");
  // Downloads come back with the digest dropped, or with one byte changed.
  let mode: "drop" | "alter" = "drop";
  const bad = proxy(async (req, u) => {
    if (!/^\/api\/attachments\/\d+$/.test(u.pathname)) return undefined;
    const res = await fetch(`${srv.base}${u.pathname}${u.search}`, { headers: req.headers });
    const headers = new Headers(res.headers);
    const data = new Uint8Array(await res.arrayBuffer());
    if (mode === "drop") headers.delete("repr-digest");
    else data[0] ^= 1;
    return new Response(data, { status: res.status, headers });
  });
  try {
    const alice = await login("alice@example.com");
    const save = join(dir, "saved");
    const be = await session(alice, "be", { GRAYBOARD_SERVER: `http://localhost:${bad.port}`, GRAYBOARD_ATTACHMENTS_DIR: save });
    const [notes] = (await be.call("dm_send", { to: "be", body: "x", attachments: [join(dir, "notes.md")] })).attachments;
    await expect(be.call("attachment_get", { id: notes.id })).rejects.toThrow(`attachment ${notes.id}: the server sent no digest; it needs updating`);
    mode = "alter";
    await expect(be.call("attachment_get", { id: notes.id })).rejects.toThrow(`attachment ${notes.id}: the bytes received don't match the server's sha256`);
    // The default directory exists (resolved before the download); nothing is in it.
    expect(readdirSync(save, { recursive: true }).filter((n) => String(n).endsWith("notes.md"))).toEqual([]);
  } finally {
    bad.stop(true);
  }
}, 20_000);
