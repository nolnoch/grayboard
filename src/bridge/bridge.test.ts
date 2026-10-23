import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256Hex } from "../shared/attachments.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { Relay, format, fromSlack, type Bus, type RelayOptions } from "./relay.ts";
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
  // A note ends the message; the body gives way so the whole still fits.
  expect(format("be", null, "x", 1, "⚠️ n")).toBe("**be** x\n\n⚠️ n");
  const noted = format("be", null, "x".repeat(20_000), 7, "⚠️ " + "n".repeat(5_000));
  expect(noted.length).toBeLessThan(12_000);
  expect(noted).toContain("(truncated; the full text is grayboard message 7)\n\n⚠️ nnn");
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

test("SlackWeb sends the bot token only to the API's host or its subdomains", async () => {
  const seen: string[] = [];
  const f = async (url: string, init: RequestInit) => {
    seen.push(`${url} ${(init.headers as Record<string, string>).Authorization}`);
    return new Response("abc");
  };
  const web = new SlackWeb("xoxb-t", "https://slack.com/api/", f);
  expect(new TextDecoder().decode(await web.download("https://files.slack.com/files-pri/T1-F1/download/a.txt", 3))).toBe("abc");
  for (const bad of ["https://evil.example/a.txt", "http://files.slack.com/a.txt", "https://files.slack.com.evil.example/a", "https://evilslack.com/a", "https://files.slack.com:8443/a", "not a url"]) {
    expect(await web.download(bad, 3).catch((e) => e)).toMatchObject({ code: "untrusted_host" });
  }
  expect(seen).toEqual(["https://files.slack.com/files-pri/T1-F1/download/a.txt Bearer xoxb-t"]);
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

// A bus holding attachment 7 that records what the relay sends back through
// it, and a Slack whose file methods answer per `slack`, recording every call.
// upload: a status getUploadURLExternal fails with once. complete: an error
// code it refuses with, or a status it answers once after the share landed
// (a lost answer), then `again` for the next call. shares: how many files.info
// calls show no shares yet.
function withAttachment(slack: { upload?: number; complete?: string | number; again?: string; shares?: number } = {}) {
  const told: Record<string, unknown>[] = [];
  const bus: Bus = {
    call: async (name, args) => {
      if (name === "dm_send") told.push(args);
      return { ok: true, value: name === "dm_send" ? { message_id: 99 } : [] };
    },
    attachment: async (id) => ({ id, filename: "shot.png", type: "image/png", size: 3, sha256: sha256Hex(new Uint8Array([1, 2, 3])), data: new Uint8Array([1, 2, 3]) }),
    withFiles: noFiles.withFiles,
  };
  const calls: string[] = [];
  const said: string[] = [];
  const blocks: string[] = [];
  let shared = false;
  const f: Fetch = async (url, init) => {
    const method = String(url).split("/").pop()!;
    calls.push(method);
    if (method === "chat.postMessage") {
      said.push(JSON.parse(String(init.body)).markdown_text);
      return Response.json({ ok: true, ts: "5.0" });
    }
    if (method === "files.getUploadURLExternal" && slack.upload) {
      const status = slack.upload;
      delete slack.upload;
      return new Response("down", { status });
    }
    if (method === "files.getUploadURLExternal") return Response.json({ ok: true, file_id: "F1", upload_url: "http://slack.test/upload/F1" });
    if (method === "F1") return new Response("OK");
    if (method === "files.completeUploadExternal") {
      if (typeof slack.complete === "string") return Response.json({ ok: false, error: slack.complete });
      // Like Slack: a repeat posts nothing new and names the first share.
      if (shared) return Response.json({ ok: true, files: [{ id: "F1", title: "shot.png", shares: { private: { G1: [{ ts: "6.0" }] } } }] });
      shared = true;
      blocks.push(JSON.parse(new URLSearchParams(String(init.body)).get("blocks")!)[0].text);
      if (typeof slack.complete === "number") {
        const status = slack.complete;
        slack.complete = slack.again;
        return new Response("lost", { status });
      }
      return Response.json({ ok: true, files: [{ id: "F1", title: "shot.png" }] });
    }
    if (method === "files.info") {
      const show = shared && !(slack.shares && slack.shares-- > 0);
      return Response.json({ ok: true, file: { id: "F1", shares: show ? { private: { G1: [{ ts: "6.0" }] } } : {} } });
    }
    return Response.json({ ok: true });
  };
  return { bus, told, calls, said, blocks, f };
}

const LOOK = { content: "look", meta: { message_id: "1", from: "be", attachments: `7:shot.png image/png 3B sha256:${sha256Hex(new Uint8Array([1, 2, 3]))}` } };
const errors = (store: Store) => (store.db.prepare(`SELECT error FROM outbox ORDER BY id`).all() as { error: string | null }[]).map((r) => r.error);

function fileRelay(store: Store, x: ReturnType<typeof withAttachment>, extra: Partial<RelayOptions> = {}) {
  const sent: string[] = [];
  const relay = new Relay(store, x.bus, new SlackWeb("xoxb-t", "http://slack.test/api/", x.f), {
    channel: "G1", owner: "U1", onFatal: () => {}, retryMs: 20, shareWaitMs: 50,
    onFileSent: (f) => sent.push(`${f.attachment}→${f.slack_file}@${f.thread_ts}`),
    ...extra,
  });
  return { relay, sent };
}

test("files: text and files go as one message, whose ts files.info gives; a retry re-uploads but shares once", async () => {
  const x = withAttachment({ upload: 503 });
  const store = new Store(join(dir, "b.db"));
  const { relay, sent } = fileRelay(store, x);
  relay.notify(LOOK);
  await Bun.sleep(150);
  expect(x.calls).toEqual(["files.getUploadURLExternal", "files.getUploadURLExternal", "F1", "files.completeUploadExternal", "files.info"]);
  expect(x.blocks).toEqual(["**be** look"]);
  expect(x.said).toEqual([]);
  expect(sent).toEqual(["7→F1@6.0"]);
  expect(store.byTs("6.0")).toMatchObject({ kind: "dm", root_id: 1, peer: "be", last_id: 1 });
  expect(store.pending()).toEqual([]);
  expect(errors(store)).toEqual([null]);
  store.close();
});

test("files: a restart after the upload resumes at the share, without uploading again", async () => {
  const x = withAttachment();
  const store = new Store(join(dir, "b.db"));
  const id = store.enqueue(LOOK);
  store.setProgress(id, { files: [{ id: "F1", title: "shot.png", attachment: 7 }], refused: [] });
  const { relay, sent } = fileRelay(store, x);
  await relay.drain();
  expect(x.calls).toEqual(["files.completeUploadExternal", "files.info"]);
  expect(sent).toEqual(["7→F1@6.0"]);
  expect(store.pending()).toEqual([]);
  store.close();
});

test("files: a share whose answer was lost is completed again, which Slack doesn't post twice", async () => {
  const x = withAttachment({ complete: 503, shares: 100 });
  const store = new Store(join(dir, "b.db"));
  const { relay, sent } = fileRelay(store, x);
  relay.notify(LOOK);
  await Bun.sleep(200);
  // The repeat's answer names the share, so files.info isn't needed.
  expect(x.calls).toEqual(["files.getUploadURLExternal", "F1", "files.completeUploadExternal", "files.completeUploadExternal"]);
  expect(x.blocks).toEqual(["**be** look"]);
  expect(x.said).toEqual([]);
  expect(sent).toEqual(["7→F1@6.0"]);
  expect(store.byTs("6.0")).toBeDefined();
  expect(errors(store)).toEqual([null]);
  store.close();
});

test("files: a completion Slack refuses after a lost answer is a refusal: the text posts alone and the sender hears why", async () => {
  const x = withAttachment({ complete: 503, again: "invalid_arguments" });
  const store = new Store(join(dir, "b.db"));
  const { relay, sent } = fileRelay(store, x);
  relay.notify(LOOK);
  await Bun.sleep(200);
  expect(x.calls.filter((c) => c === "files.completeUploadExternal")).toHaveLength(2);
  expect(x.said).toHaveLength(1);
  expect(x.said[0]).toStartWith("**be** look");
  expect(x.said[0]).toContain("invalid_arguments");
  expect(x.told).toHaveLength(1);
  expect(sent).toEqual([]);
  expect(errors(store)).toEqual(["files_refused"]);
  store.close();
});

test("files: a share whose message never shows in files.info leaves the thread unmapped, and says so", async () => {
  const x = withAttachment({ shares: 100 });
  const store = new Store(join(dir, "b.db"));
  const { relay, sent } = fileRelay(store, x);
  relay.notify(LOOK);
  await Bun.sleep(200);
  expect(x.calls.filter((c) => c === "files.info")).toHaveLength(10);
  expect(sent).toEqual(["7→F1@null"]);
  expect(x.said).toEqual(["⚠️ Slack didn't say where it put message 1 from be, so replies in that thread won't reach grayboard. Answer in the next message of that conversation instead."]);
  expect(errors(store)).toEqual(["ts_unknown"]);
  store.close();
});

test("files: an app without files:write still relays the text with a warning, and the sender hears why", async () => {
  const x = withAttachment({ complete: "missing_scope" });
  const store = new Store(join(dir, "b.db"));
  let fatal = "";
  const { relay } = fileRelay(store, x, { onFatal: (r) => (fatal = r) });
  relay.notify(LOOK);
  relay.notify({ content: "next", meta: { message_id: "2", from: "be" } });
  await Bun.sleep(100);
  expect(fatal).toBe("");
  // The file attempt, the text with the warning as one message, then the next item.
  expect(x.calls).toEqual(["files.getUploadURLExternal", "F1", "files.completeUploadExternal", "chat.postMessage", "chat.postMessage"]);
  const why = "shot.png: the Slack app lacks files:write (reinstall it from the current manifest)";
  expect(x.said).toEqual([`**be** look\n\n⚠️ not delivered to Slack: ${why}`, "**be** next"]);
  expect(x.told).toEqual([{ to: "be", parent_id: 1, body: `[Slack bridge] Files on your message 1 didn't reach Slack, so the human hasn't seen them: ${why}. The text did reach them.` }]);
  expect(errors(store)).toEqual(["files_refused", null]);
  store.close();
});

test("files: bytes that don't match the stored sha256 never reach Slack", async () => {
  const x = withAttachment();
  const good = x.bus.attachment;
  x.bus.attachment = async (id) => ({ ...(await good(id)), data: new Uint8Array([1, 2, 4]) });
  const store = new Store(join(dir, "b.db"));
  const { relay, sent } = fileRelay(store, x);
  relay.notify(LOOK);
  await Bun.sleep(100);
  expect(x.calls).toEqual(["chat.postMessage"]);
  expect(x.said).toEqual(["**be** look\n\n⚠️ not delivered to Slack: shot.png: its bytes don't match the stored sha256"]);
  expect(x.told).toHaveLength(1);
  expect(sent).toEqual([]);
  expect(errors(store)).toEqual(["files_refused"]);
  store.close();
});

test("files: attachments meta the relay can't read is refused loudly, not dropped", async () => {
  const x = withAttachment();
  const store = new Store(join(dir, "b.db"));
  const { relay } = fileRelay(store, x);
  relay.notify({ content: "look", meta: { message_id: "1", from: "be", attachments: "shot.png, 3 bytes" } });
  await Bun.sleep(100);
  expect(x.calls).toEqual(["chat.postMessage"]);
  expect(x.said[0]).toStartWith("**be** look\n\n⚠️ not delivered to Slack: its files: unreadable attachments meta item");
  expect(x.told).toHaveLength(1);
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

test("slack: a reply sent while the one before it is still sending threads under it", async () => {
  const posts: Record<string, unknown>[] = [];
  let release!: () => void;
  const slow = new Promise<void>((r) => (release = r));
  let next = 6;
  const bus: Bus = {
    call: async (name, args) => {
      if (name !== "board_post") return { ok: true, value: {} };
      posts.push(args);
      if (posts.length === 1) await slow; // the first reply's files are still downloading
      return { ok: true, value: { post_id: next++, board: "ops" } };
    },
    ...noFiles,
  };
  const store = new Store(join(dir, "b.db"));
  store.addThread({ thread_ts: "1.0", kind: "board", board: "ops", root_id: 5, peer: null, last_id: 5 });
  const f: Fetch = async () => Response.json({ ok: true, ts: "9.0" });
  const relay = new Relay(store, bus, new SlackWeb("xoxb-t", "http://slack.test/api/", f), { channel: "G1", owner: "U1", onFatal: () => {} });
  const reply = (text: string, ts: string) => relay.onEvent({ type: "event_callback", event: { type: "message", channel: "G1", user: "U1", text, ts, thread_ts: "1.0" } });
  const a = reply("here's the screen", "2.0");
  const b = reply("fix the button in it", "3.0");
  await Bun.sleep(20);
  expect(posts.length).toBe(1); // the second waits for the first
  release();
  await Promise.all([a, b]);
  expect(posts.map((p) => [p.body, p.parent_id])).toEqual([
    ["here's the screen", 5],
    ["fix the button in it", 6],
  ]);
  store.close();
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

test("socket: an envelope is acked before its handler settles, and handlers start in arrival order", async () => {
  const acked: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no")),
    websocket: {
      open(ws) {
        ws.send(JSON.stringify({ type: "hello" }));
        for (const n of [1, 2]) ws.send(JSON.stringify({ type: "events_api", envelope_id: `e${n}`, payload: { event_id: `Ev${n}` } }));
      },
      message(_ws, m) {
        acked.push(JSON.parse(String(m)).envelope_id);
      },
    },
  });
  const started: string[] = [];
  // A handler that never settles, like a download slower than Slack's 3 s window.
  const sm = new SocketMode({ open: async () => `ws://localhost:${server.port}/`, onEvent: (p) => (started.push(p.event_id), new Promise(() => {})), onFatal: () => {} });
  await sm.start();
  const end = Date.now() + 2000;
  while (acked.length < 2 && Date.now() < end) await Bun.sleep(10);
  sm.stop();
  server.stop(true);
  expect(acked).toEqual(["e1", "e2"]);
  expect(started).toEqual(["Ev1", "Ev2"]);
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
