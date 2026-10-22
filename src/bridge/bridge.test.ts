import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigError, loadConfig } from "./config.ts";
import { Relay, format, fromSlack, type Bus } from "./relay.ts";
import { SocketMode } from "./socket.ts";
import { Store } from "./store.ts";
import { SlackError, SlackUnavailable, SlackWeb, type Fetch } from "./web.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grayboard-bridge-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// ── text ─────────────────────────────────────────────────────────────────────

test("fromSlack unwraps links and unescapes entities", () => {
  expect(fromSlack("a &lt;b&gt; &amp; c")).toBe("a <b> & c");
  expect(fromSlack("see <https://x.dev/a|the doc> and <https://x.dev/b>")).toBe("see the doc (https://x.dev/a) and https://x.dev/b");
  expect(fromSlack("<https://x.dev|https://x.dev>")).toBe("https://x.dev");
  expect(fromSlack("<#C123|e2e> status")).toBe("#e2e status");
  expect(fromSlack("<mailto:a@b.co|a@b.co>")).toBe("a@b.co");
  expect(fromSlack("<!here> ping")).toBe("@here ping");
  expect(fromSlack("@be plain")).toBe("@be plain");
});

test("format leads with the handle, names the board on a new thread, and truncates", () => {
  expect(format("be", null, "one line", 1)).toBe("**be** one line");
  expect(format("fe", "e2e", "a\nb", 2)).toBe("**fe** · #e2e ·\na\nb");
  expect(format("bob@example.com/be", null, "hi", 3)).toBe("`bob@example.com/be` hi");
  const long = format("be", null, "x".repeat(20_000), 7);
  expect(long.length).toBeLessThan(12_000);
  expect(long).toEndWith("(truncated; the full text is grayboard message 7)");
});

// ── config ───────────────────────────────────────────────────────────────────

function cfgEnv(): Record<string, string> {
  return { GRAYBOARD_SLACK_CONFIG: join(dir, "slack.json"), GRAYBOARD_SLACK_DB: join(dir, "b.db") };
}
function writeCfg(obj: Record<string, unknown>, mode = 0o600): void {
  writeFileSync(join(dir, "slack.json"), JSON.stringify(obj));
  chmodSync(join(dir, "slack.json"), mode);
}
const GOOD = { app_token: "xapp-1", bot_token: "xoxb-1", channel: "G1", owner: "U1", handle: "Alex" };

test("config: env overrides tokens; handle is lowercased; wrong token kinds are refused", () => {
  writeCfg(GOOD);
  const c = loadConfig({ ...cfgEnv(), SLACK_BOT_TOKEN: "xoxb-env" });
  expect(c).toMatchObject({ appToken: "xapp-1", botToken: "xoxb-env", handle: "alex", channel: "G1" });
  writeCfg({ ...GOOD, app_token: "xoxb-oops" });
  expect(() => loadConfig(cfgEnv())).toThrow(/app-level token/);
  writeCfg({ ...GOOD, handle: "not a handle" });
  expect(() => loadConfig(cfgEnv())).toThrow(ConfigError);
  writeCfg({ ...GOOD, owner: undefined });
  expect(() => loadConfig(cfgEnv())).toThrow(/missing "owner"/);
});

test("config: a file group or others can read is refused", () => {
  writeCfg(GOOD, 0o640);
  expect(() => loadConfig(cfgEnv())).toThrow(/chmod 600/);
});

// ── web ──────────────────────────────────────────────────────────────────────

test("web: waits out a rate limit, then classifies errors", async () => {
  let n = 0;
  const f: Fetch = async () => {
    n++;
    if (n === 1) return new Response("", { status: 429, headers: { "retry-after": "1" } });
    if (n === 2) return Response.json({ ok: true, ts: "1.2" });
    if (n === 3) return Response.json({ ok: false, error: "not_in_channel" });
    if (n === 4) return Response.json({ ok: false, error: "msg_too_long" });
    return new Response("down", { status: 502 });
  };
  const web = new SlackWeb("xoxb-t", "http://slack.test/api/", f);
  const t = performance.now(); // monotonic: WSL can step the wall clock back mid-test
  expect((await web.call<{ ts: string }>("chat.postMessage")).ts).toBe("1.2");
  expect(performance.now() - t).toBeGreaterThanOrEqual(900);
  const fatal = await web.call("chat.postMessage").catch((e) => e);
  expect(fatal).toBeInstanceOf(SlackError);
  expect(fatal.fatal).toBe(true);
  const soft = await web.call("chat.postMessage").catch((e) => e);
  expect(soft.fatal).toBe(false);
  expect(await web.call("chat.postMessage").catch((e) => e)).toBeInstanceOf(SlackUnavailable);
});

// ── outbox ───────────────────────────────────────────────────────────────────

// A bus for tests that carry no files.
const noFiles: Pick<Bus, "attachment" | "withFiles"> = {
  attachment: async () => {
    throw new Error("no attachments here");
  },
  withFiles: async () => {
    throw new Error("no attachments here");
  },
};

test("outbox: rows a stopped bridge couldn't post go out on the next run, in order", async () => {
  const path = join(dir, "b.db");
  const nobus: Bus = { call: async () => ({ ok: true, value: [] }), ...noFiles };
  const down: Fetch = async () => new Response("down", { status: 503 });
  let relay = new Relay(new Store(path), nobus, new SlackWeb("xoxb-t", "http://slack.test/api/", down), {
    channel: "G1",
    owner: "U1",
    onFatal: () => {},
    retryMs: 50,
  });
  relay.notify({ content: "first", meta: { message_id: "1", from: "be" } });
  relay.notify({ content: "digest", meta: { kind: "digest", board: "x" } });
  relay.notify({ content: "second", meta: { message_id: "2", from: "fe" } });
  await Bun.sleep(150);
  relay.stop();
  await Bun.sleep(100);

  const posted: string[] = [];
  const up: Fetch = async (_url, init) => {
    posted.push(JSON.parse(String(init.body)).markdown_text);
    return Response.json({ ok: true, ts: `${posted.length}.0` });
  };
  const store = new Store(path);
  relay = new Relay(store, nobus, new SlackWeb("xoxb-t", "http://slack.test/api/", up), { channel: "G1", owner: "U1", onFatal: () => {} });
  await relay.drain();
  expect(posted).toEqual(["**be** first", "**fe** second"]);
  expect(store.pending()).toEqual([]);
  store.close();
});

test("outbox: a bad token stops the relay instead of retrying forever", async () => {
  let fatal = "";
  const f: Fetch = async () => Response.json({ ok: false, error: "invalid_auth" });
  const store = new Store(join(dir, "b.db"));
  const relay = new Relay(store, { call: async () => ({ ok: true, value: [] }), ...noFiles }, new SlackWeb("x", "http://slack.test/api/", f), {
    channel: "G1",
    owner: "U1",
    onFatal: (r) => (fatal = r),
  });
  relay.notify({ content: "hi", meta: { message_id: "1", from: "be" } });
  await Bun.sleep(50);
  expect(fatal).toContain("invalid_auth");
  expect(store.pending()).toHaveLength(1); // kept for after the token is fixed
  store.close();
});

// A bus holding attachment 7, and a Slack whose file methods answer `files`
// (a status to fail with, or an error code), recording every call.
function withAttachment(files: { upload?: number; complete?: string }) {
  const bus: Bus = {
    call: async () => ({ ok: true, value: [] }),
    attachment: async (id) => ({ id, filename: "shot.png", type: "image/png", size: 3, data: new Uint8Array([1, 2, 3]) }),
    withFiles: noFiles.withFiles,
  };
  const calls: string[] = [];
  const said: string[] = [];
  const f: Fetch = async (url, init) => {
    const method = String(url).split("/").pop()!;
    calls.push(method);
    if (method === "chat.postMessage") said.push(JSON.parse(String(init.body)).markdown_text);
    if (method === "files.getUploadURLExternal" && files.upload) {
      const status = files.upload;
      delete files.upload;
      return new Response("down", { status });
    }
    if (method === "files.getUploadURLExternal") return Response.json({ ok: true, file_id: "F1", upload_url: "http://slack.test/upload/F1" });
    if (method === "F1") return new Response("OK");
    if (method === "files.completeUploadExternal" && files.complete) return Response.json({ ok: false, error: files.complete });
    return Response.json({ ok: true, ts: "5.0" });
  };
  return { bus, calls, said, f };
}

test("files: a retry after Slack was unavailable resends the files, not the text", async () => {
  const { bus, calls, f } = withAttachment({ upload: 503 });
  const store = new Store(join(dir, "b.db"));
  const sent: string[] = [];
  const relay = new Relay(store, bus, new SlackWeb("xoxb-t", "http://slack.test/api/", f), {
    channel: "G1", owner: "U1", onFatal: () => {}, retryMs: 20, onFileSent: (x) => sent.push(`${x.attachment}→${x.slack_file}@${x.thread_ts}`),
  });
  relay.notify({ content: "look", meta: { message_id: "1", from: "be", attachments: "7:shot.png image/png 3B" } });
  await Bun.sleep(150);
  expect(calls).toEqual(["chat.postMessage", "files.getUploadURLExternal", "files.getUploadURLExternal", "F1", "files.completeUploadExternal"]);
  expect(sent).toEqual(["7→F1@5.0"]);
  expect(store.pending()).toEqual([]);
  store.close();
});

test("files: an app without files:write still relays text and says why the file didn't come", async () => {
  const { bus, calls, said, f } = withAttachment({ complete: "missing_scope" });
  const store = new Store(join(dir, "b.db"));
  let fatal = "";
  const relay = new Relay(store, bus, new SlackWeb("xoxb-t", "http://slack.test/api/", f), { channel: "G1", owner: "U1", onFatal: (r) => (fatal = r) });
  relay.notify({ content: "look", meta: { message_id: "1", from: "be", attachments: "7:shot.png image/png 3B" } });
  relay.notify({ content: "next", meta: { message_id: "2", from: "be" } });
  await Bun.sleep(100);
  expect(fatal).toBe("");
  // The text, the file attempt, the warning in the thread, then the next item.
  expect(calls).toEqual(["chat.postMessage", "files.getUploadURLExternal", "F1", "files.completeUploadExternal", "chat.postMessage", "chat.postMessage"]);
  expect(said).toEqual([
    "**be** look",
    "⚠️ not delivered to Slack: shot.png: the Slack app lacks files:write (reinstall it from the current manifest)",
    "**be** next",
  ]);
  expect(store.pending()).toEqual([]);
  store.close();
});

// A relay whose bus answers from `results` and records calls, and whose Slack
// records what the bridge says.
function owned(results: Record<string, { ok: true; value: any } | { ok: false; error: string }>) {
  const calls: [string, Record<string, unknown>][] = [];
  const said: string[] = [];
  const reacted: string[] = [];
  const bus: Bus = {
    call: async (name, args) => {
      calls.push([name, args]);
      return results[name] ?? { ok: true, value: {} };
    },
    ...noFiles,
  };
  const f: Fetch = async (url, init) => {
    const body = JSON.parse(String(init.body));
    if (String(url).endsWith("reactions.add")) reacted.push(body.timestamp);
    else said.push(body.markdown_text);
    return Response.json({ ok: true, ts: "9.0" });
  };
  const store = new Store(join(dir, "b.db"));
  const relay = new Relay(store, bus, new SlackWeb("xoxb-t", "http://slack.test/api/", f), { channel: "G1", owner: "U1", onFatal: () => {} });
  const send = (text: string) => relay.onEvent({ type: "event_callback", event: { type: "message", channel: "G1", user: "U1", text, ts: "1.0" } });
  return { calls, said, reacted, send, close: () => store.close() };
}

test("slack: new #board creates it, quiet for the owner; without a purpose it asks for one", async () => {
  const r = owned({ board_create: { ok: true, value: { name: "workspace" } } });
  await r.send("new #Workspace: lane count and naming");
  expect(r.calls).toEqual([
    ["board_create", { name: "workspace", purpose: "lane count and naming" }],
    ["board_subscribe", { board: "workspace", mode: "quiet" }],
  ]);
  expect(r.reacted).toEqual(["1.0"]);
  expect(r.said[0]).toContain("created #workspace");

  r.calls.length = 0;
  await r.send("new #workspace");
  expect(r.calls).toEqual([]);
  expect(r.said[1]).toContain("not created: say what #workspace is for");
  r.close();
});

test("slack: posting to a missing board lists the boards and how to make it", async () => {
  const r = owned({
    board_post: { ok: false, error: "no such board #workspce; see board_list" },
    board_list: { ok: true, value: [{ name: "ops" }, { name: "workspace" }] },
  });
  await r.send("#workspce how many lanes?");
  expect(r.said).toEqual([`⚠️ not posted: no board #workspce (boards: #ops, #workspace). To make it: "new #workspce what it's for"`]);
  r.close();
});

// ── socket ───────────────────────────────────────────────────────────────────

// A WebSocket server that completes the handshake, says hello, and then goes
// silent: it never answers pings, like a socket left half-open by a sleep.
function silentServer(): { port: number; connects: () => number; stop: () => void } {
  let n = 0;
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(sock, buf) {
        const req = buf.toString();
        const key = /Sec-WebSocket-Key: (.+)\r\n/i.exec(req)?.[1];
        if (!key) return; // a frame from the client (a ping): ignore it
        n++;
        const accept = createHash("sha1").update(`${key.trim()}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
        sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        const hello = Buffer.from(JSON.stringify({ type: "hello" }));
        sock.write(Buffer.concat([Buffer.from([0x81, hello.length]), hello]));
      },
    },
  });
  return { port: server.port, connects: () => n, stop: () => server.stop(true) };
}

test("socket: a connection that goes silent is replaced", async () => {
  const srv = silentServer();
  const logs: string[] = [];
  const sm = new SocketMode({
    open: async () => `ws://127.0.0.1:${srv.port}/`,
    onEvent: async () => {},
    onFatal: () => {},
    log: (m) => logs.push(m),
    pingMs: 50,
    deadMs: 200,
    maxBackoffMs: 100,
  });
  await sm.start();
  expect(srv.connects()).toBe(1);
  const end = Date.now() + 3000;
  while (srv.connects() < 2 && Date.now() < end) await Bun.sleep(20);
  sm.stop();
  srv.stop();
  expect(srv.connects()).toBeGreaterThanOrEqual(2);
  expect(logs.some((l) => l.includes("nothing heard"))).toBe(true);
});

test("socket: Slack's pings are fine with debug logging off", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no")),
    websocket: {
      open(ws) {
        ws.send(JSON.stringify({ type: "hello" }));
        setTimeout(() => {
          ws.ping();
          ws.send(JSON.stringify({ type: "events_api", envelope_id: "e1", payload: { event_id: "Ev1" } }));
        }, 20);
      },
      message() {},
    },
  });
  let events = 0;
  // As slack.ts passes them when GRAYBOARD_SLACK_DEBUG is unset.
  const sm = new SocketMode({ open: async () => `ws://localhost:${server.port}/`, onEvent: async () => void events++, onFatal: () => {}, log: undefined, debug: undefined });
  await sm.start();
  const end = Date.now() + 2000;
  while (!events && Date.now() < end) await Bun.sleep(10);
  sm.stop();
  server.stop(true);
  expect(events).toBe(1);
});

test("socket: link_disabled is fatal; a bad app token is fatal", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no")),
    websocket: {
      open(ws) {
        ws.send(JSON.stringify({ type: "hello" }));
        setTimeout(() => ws.send(JSON.stringify({ type: "disconnect", reason: "link_disabled" })), 20);
      },
      message() {},
    },
  });
  let fatal = "";
  const sm = new SocketMode({ open: async () => `ws://localhost:${server.port}/`, onEvent: async () => {}, onFatal: (r) => (fatal = r) });
  await sm.start();
  const end = Date.now() + 2000;
  while (!fatal && Date.now() < end) await Bun.sleep(10);
  server.stop(true);
  expect(fatal).toContain("link_disabled");

  // Before any hello, a fatal error also fails start(), so startup can't hang.
  let fatal2 = "";
  const sm2 = new SocketMode({
    open: async () => {
      throw new SlackError("apps.connections.open", "invalid_auth");
    },
    onEvent: async () => {},
    onFatal: (r) => (fatal2 = r),
  });
  await expect(sm2.start()).rejects.toThrow(/invalid_auth/);
  expect(fatal2).toContain("invalid_auth");
});
