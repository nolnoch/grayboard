// End-to-end Slack bridge: a fake Slack (Web API + Socket Mode over Bun.serve)
// on one side, a real local-mode bus on the other. The bridge runs in-process
// with its own `grayboard mcp` child; agents are separate `grayboard mcp`
// processes driven by MCP clients, as in local.test.ts.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { startSlackBridge, type BridgeHandle } from "../../src/bridge/slack.ts";
import { FakeSlack } from "./fake_slack.ts";

const CLI = resolve(import.meta.dir, "../../src/cli/main.ts");
const MCP = { command: process.execPath, args: [CLI, "mcp", "--mode", "local"] };
const CHANNEL = "G0PRIVATE";
const OWNER = "U0OWNER";

let dir: string;
let slack: FakeSlack;
let bridge: BridgeHandle | null;
const open: Client[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grayboard-slack-"));
  slack = new FakeSlack({ channel: CHANNEL, owner: OWNER, channelType: "group" });
  bridge = null;
});

afterEach(async () => {
  await bridge?.stop();
  await Promise.all(open.splice(0).map((c) => c.close().catch(() => {})));
  slack.stop();
  rmSync(dir, { recursive: true, force: true });
});

function env(identity?: string): Record<string, string> {
  const e: Record<string, string | undefined> = {
    ...process.env,
    BUS_DB_PATH: join(dir, "bus.db"),
    BUS_SOCK_DIR: dir,
    GRAYBOARD_CREDENTIALS: join(dir, "credentials"),
    GRAYBOARD_SLACK_CONFIG: join(dir, "slack.json"),
    GRAYBOARD_SLACK_DB: join(dir, "slack-bridge.db"),
    SLACK_API_URL: slack.api,
  };
  delete e.BUS_IDENTITY;
  delete e.BUS_HUMAN;
  delete e.GRAYBOARD_TOKEN;
  delete e.SLACK_APP_TOKEN;
  delete e.SLACK_BOT_TOKEN;
  if (identity) e.BUS_IDENTITY = identity;
  return e as Record<string, string>;
}

function writeConfig(extra: Record<string, unknown> = {}, mode = 0o600): void {
  const path = join(dir, "slack.json");
  writeFileSync(path, JSON.stringify({ app_token: "xapp-1-test", bot_token: "xoxb-test", channel: CHANNEL, owner: OWNER, handle: "alex", ...extra }));
  chmodSync(path, mode);
}

async function startBridge(): Promise<BridgeHandle> {
  writeConfig();
  bridge = await startSlackBridge(MCP, env());
  return bridge;
}

type Agent = { c: Client; pushes: { content: string; meta: Record<string, string> }[] };

async function agent(identity: string): Promise<Agent> {
  const pushes: Agent["pushes"] = [];
  const c = new Client({ name: "test", version: "0" });
  c.fallbackNotificationHandler = async (n) => {
    if (n.method === "notifications/claude/channel") pushes.push(n.params as Agent["pushes"][number]);
  };
  await c.connect(new StdioClientTransport({ ...MCP, cwd: dir, env: env(identity), stderr: "ignore" }));
  open.push(c);
  return { c, pushes };
}

async function stopAgent(a: Agent): Promise<void> {
  open.splice(open.indexOf(a.c), 1);
  await a.c.close();
  await Bun.sleep(200);
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = await c.callTool({ name, arguments: args });
  const body = (r.content as { text: string }[])[0]!.text;
  if (r.isError) throw new Error(body);
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

async function until<T>(f: () => T | undefined | null | false, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(20);
  }
}

test("an agent's DM becomes a Slack thread; the reply reaches only that agent, marked human", async () => {
  const be = await agent("be");
  const fe = await agent("fe");
  await startBridge();

  const q = await call(be.c, "dm_send", { to: "alex", body: "Return 204 or []?" });
  expect(q.delivered_now).toBe(true);
  const top = await until(() => slack.posts().find((p) => p.markdown_text?.includes("204")));
  expect(top).toMatchObject({ channel: CHANNEL, username: "be", markdown_text: "**be** Return 204 or []?" });
  expect(top.thread_ts).toBeUndefined();
  const threadTs = slackTsOf(top);

  const { envelope, ts } = slack.say("[] please", { thread_ts: threadTs });
  const got = await until(() => be.pushes.find((p) => p.content === "[] please"));
  expect(got.meta).toMatchObject({ from: "alex", parent_id: String(q.message_id), human: "true" });
  await until(() => slack.acks.includes(envelope));
  await until(() => slack.reactions().find((r) => r.timestamp === ts && r.name === "white_check_mark"));
  expect(fe.pushes).toEqual([]);

  // The agent's follow-up lands in the same Slack thread.
  await call(be.c, "dm_send", { to: "alex", body: "done", parent_id: Number(got.meta.message_id) });
  const follow = await until(() => slack.posts().find((p) => p.markdown_text === "**be** done"));
  expect(follow.thread_ts).toBe(threadTs);
}, 30_000);

test("two agents asking at once get separate threads that don't cross", async () => {
  const be = await agent("be");
  const fe = await agent("fe");
  await startBridge();
  await call(be.c, "dm_send", { to: "alex", body: "be question" });
  await call(fe.c, "dm_send", { to: "alex", body: "fe question" });
  const bePost = await until(() => slack.posts().find((p) => p.markdown_text === "**be** be question"));
  const fePost = await until(() => slack.posts().find((p) => p.markdown_text === "**fe** fe question"));
  slack.say("to fe", { thread_ts: slackTsOf(fePost) });
  slack.say("to be", { thread_ts: slackTsOf(bePost) });
  await until(() => fe.pushes.find((p) => p.content === "to fe"));
  await until(() => be.pushes.find((p) => p.content === "to be"));
  expect(fe.pushes.map((p) => p.content)).toEqual(["to fe"]);
  expect(be.pushes.map((p) => p.content)).toEqual(["to be"]);
}, 30_000);

test("board mentions forward with the board's name; a reply posts in the board thread", async () => {
  const be = await agent("be");
  const fe = await agent("fe");
  await startBridge();
  await call(be.c, "board_create", { name: "e2e", purpose: "fixtures" });
  await call(fe.c, "board_subscribe", { board: "e2e", mode: "quiet" });

  // Mentioned deep in a thread whose root never reached Slack.
  const root = await call(be.c, "board_post", { board: "e2e", body: "selector ready?" });
  await call(fe.c, "board_post", { board: "e2e", body: "yes", parent_id: root.post_id });
  const m1 = await call(be.c, "board_post", { board: "e2e", body: "@alex please review", parent_id: root.post_id });
  const p1 = await until(() => slack.posts().find((p) => p.markdown_text?.includes("please review")));
  expect(p1.markdown_text).toBe("**be** · #e2e · @alex please review");
  const threadTs = slackTsOf(p1);

  slack.say("looks good, merge it", { thread_ts: threadTs });
  await until(() => be.pushes.find((p) => p.content === "looks good, merge it" && p.meta.reason === "thread"));
  const thread = await call(be.c, "board_read", { board: "e2e", thread: root.post_id });
  const mine = thread.posts.find((p: any) => p.author === "alex");
  expect(mine.parent_id).toBe(m1.post_id);
  // fe wrote in the thread too, so it's notified; and the post is marked human.
  const feGot = await until(() => fe.pushes.find((p) => p.content === "looks good, merge it"));
  expect(feGot.meta.human).toBe("true");

  // Later replies in that board thread come back to the same Slack thread.
  await call(fe.c, "board_post", { board: "e2e", body: "merged", parent_id: mine.id });
  const p2 = await until(() => slack.posts().find((p) => p.markdown_text === "**fe** merged"));
  expect(p2.thread_ts).toBe(threadTs);
}, 30_000);

test("top-level @handle and #board start conversations; mistakes get an answer", async () => {
  const be = await agent("be");
  const sim = await agent("sim");
  await stopAgent(sim);
  await startBridge();
  await call(be.c, "board_create", { name: "e2e", purpose: "fixtures" });

  const dm = slack.say("@be rerun the soak");
  const got = await until(() => be.pushes.find((p) => p.content === "rerun the soak"));
  expect(got.meta.parent_id).toBeUndefined();
  await until(() => slack.reactions().find((r) => r.timestamp === dm.ts));
  // be's reply threads under the Slack message that started it.
  await call(be.c, "dm_send", { to: "alex", body: "on it", parent_id: Number(got.meta.message_id) });
  expect((await until(() => slack.posts().find((p) => p.markdown_text === "**be** on it"))).thread_ts).toBe(dm.ts);

  const queued = slack.say("@sim are you there");
  const q = await until(() => slack.posts().find((p) => p.thread_ts === queued.ts));
  expect(q.markdown_text).toMatch(/^queued: sim is offline \(last seen \d+m ago\); it gets this/);

  const unknown = slack.say("@nobody hi");
  expect((await until(() => slack.posts().find((p) => p.thread_ts === unknown.ts))).markdown_text).toMatch(/^⚠️ not sent: no agent "nobody" has ever connected/);

  const post = slack.say("#e2e status? @be");
  await until(() => be.pushes.find((p) => p.content === "status? @be" && p.meta.board === "e2e"));
  await until(() => slack.reactions().find((r) => r.timestamp === post.ts));

  const hint = slack.say("hello?");
  expect((await until(() => slack.posts().find((p) => p.thread_ts === hint.ts))).markdown_text).toContain('"@handle"');
  const stray = slack.say("in a thread nobody knows", { thread_ts: "1.000000" });
  expect((await until(() => slack.posts().find((p) => p.thread_ts === "1.000000"))).markdown_text).toContain("isn't connected");
  await until(() => slack.acks.includes(stray.envelope));
}, 30_000);

test("only the owner's new messages are relayed; duplicates once; every envelope acked", async () => {
  const be = await agent("be");
  await startBridge();
  const envs = [
    slack.say("@be from someone else", { user: "U0STRANGER" }),
    slack.say("@be from a bot", { extra: { bot_id: "B0OTHER" } }),
    slack.say("@be edited", { extra: { subtype: "message_changed" } }),
    slack.say("@be first", { event_id: "EvSAME" }),
    slack.say("@be first", { event_id: "EvSAME" }),
    slack.say("@be last"),
  ].map((e) => e.envelope);
  await until(() => be.pushes.find((p) => p.content === "last"));
  await until(() => envs.every((e) => slack.acks.includes(e)));
  expect(be.pushes.map((p) => p.content)).toEqual(["first", "last"]);
}, 30_000);

test("a post Slack can't take stays in the outbox and goes out when it can", async () => {
  const be = await agent("be");
  slack.failPosts = 1;
  await startBridge();
  await call(be.c, "dm_send", { to: "alex", body: "eventually" });
  // One 503, then the relay's retry (5s backoff) posts it.
  const ok = await until(() => slack.posts().find((p) => p.markdown_text === "**be** eventually" && slack.postTs.has(p)), 15_000);
  expect(slack.posts().filter((p) => p.markdown_text === "**be** eventually")).toHaveLength(2);
  expect(ok.thread_ts).toBeUndefined();
}, 30_000);

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const share = (files: Record<string, any>[]) => ({ extra: { subtype: "file_share", files } });
const firstId = (meta: string) => Number(meta.split(":")[0]);

test("an agent's attachments and text reach Slack as one message, whose thread maps back", async () => {
  const be = await agent("be");
  await startBridge();
  writeFileSync(join(dir, "shot.png"), PNG);
  writeFileSync(join(dir, "notes.md"), "# notes\n");
  const q = await call(be.c, "dm_send", { to: "alex", body: "see attached", attachments: ["shot.png", "notes.md"] });
  const s = await until(() => slack.shares()[0]);
  expect(s).toMatchObject({ channel_id: CHANNEL, username: "be", blocks: [{ type: "markdown", text: "**be** see attached" }] });
  expect(s.thread_ts).toBeUndefined();
  expect(s.files.map((f: { title: string }) => f.title)).toEqual(["shot.png", "notes.md"]);
  expect(slack.uploaded.get(s.files[0].id)).toEqual(PNG);
  expect(new TextDecoder().decode(slack.uploaded.get(s.files[1].id))).toBe("# notes\n");
  expect(slack.calls.find((c) => c.method === "files.getUploadURLExternal")!.body).toEqual({ filename: "shot.png", length: String(PNG.length) });
  expect(slack.posts()).toEqual([]);

  // Slack's answer doesn't name the message; files.info's shares do, and the thread maps to it.
  slack.say("thanks", { thread_ts: s.ts });
  const got = await until(() => be.pushes.find((p) => p.content === "thanks"));
  expect(got.meta.parent_id).toBe(String(q.message_id));
  // The agent's follow-up with a file lands in that thread.
  await call(be.c, "dm_send", { to: "alex", body: "one more", parent_id: Number(got.meta.message_id), attachments: ["notes.md"] });
  const s2 = await until(() => slack.shares()[1]);
  expect(s2).toMatchObject({ thread_ts: s.ts, blocks: [{ type: "markdown", text: "**be** one more" }] });
}, 30_000);

test("a file Slack refuses still lets the text through with a warning, and goes back to its sender", async () => {
  const be = await agent("be");
  slack.refuseUploads = "file_type_not_allowed";
  await startBridge();
  writeFileSync(join(dir, "shot.png"), PNG);
  const q = await call(be.c, "dm_send", { to: "alex", body: "see attached", attachments: ["shot.png"] });
  const top = await until(() => slack.posts().find((p) => p.markdown_text?.startsWith("**be** see attached")));
  expect(top.markdown_text).toBe("**be** see attached\n\n⚠️ not delivered to Slack: shot.png: file_type_not_allowed");
  expect(slack.shares()).toEqual([]);
  const back = await until(() => be.pushes.find((p) => p.meta.from === "alex"));
  expect(back.meta.parent_id).toBe(String(q.message_id));
  expect(back.content).toBe(`[Slack bridge] Files on your message ${q.message_id} didn't reach Slack, so the human hasn't seen them: shot.png: file_type_not_allowed. The text did reach them.`);
}, 30_000);

test("files the owner shares in Slack ride on the reply or the new conversation", async () => {
  const be = await agent("be");
  await startBridge();
  await call(be.c, "dm_send", { to: "alex", body: "send the log?" });
  const top = await until(() => slack.posts().find((p) => p.markdown_text === "**be** send the log?"));

  // Files only, in the thread: the body names them.
  slack.say("", { thread_ts: slackTsOf(top), ...share([slack.host("run.log", "line 1\nline 2\n")]) });
  const got = await until(() => be.pushes.find((p) => p.meta.attachments));
  expect(got.content).toBe("run.log");
  expect(got.meta.attachments).toMatch(/^\d+:run\.log text\/plain 14B$/);
  const saved = await call(be.c, "attachment_get", { id: firstId(got.meta.attachments), dir });
  expect(readFileSync(saved.path, "utf8")).toBe("line 1\nline 2\n");

  // Top level, and a file the event names only by id (files.info has the rest).
  const m = slack.say("@be the screenshot", share([slack.host("shot.png", PNG, { idOnly: true })]));
  const got2 = await until(() => be.pushes.find((p) => p.content === "the screenshot"));
  expect(got2.meta.attachments).toMatch(/^\d+:shot\.png image\/png 12B$/);
  expect(new Uint8Array(readFileSync((await call(be.c, "attachment_get", { id: firstId(got2.meta.attachments), dir })).path))).toEqual(PNG);
  await until(() => slack.reactions().find((r) => r.timestamp === m.ts));

  // "#board" alone with a file is a whole post.
  await call(be.c, "board_create", { name: "e2e", purpose: "fixtures" });
  await call(be.c, "board_subscribe", { board: "e2e", mode: "push" });
  slack.say("#e2e", share([slack.host("plan.md", "1. ship\n")]));
  const post = await until(() => be.pushes.find((p) => p.meta.board === "e2e"));
  expect(post.content).toBe("plan.md");
  expect(post.meta.attachments).toMatch(/^\d+:plan\.md text\/markdown 8B$/);
}, 30_000);

test("a Slack file that can't come along refuses the whole message, in its thread", async () => {
  const be = await agent("be");
  await startBridge();
  const answer = async (text: string, files: Record<string, any>[]) => {
    const { ts } = slack.say(text, share(files));
    return (await until(() => slack.posts().find((p) => p.thread_ts === ts))).markdown_text as string;
  };
  expect(await answer("@be binary", [slack.host("blob.bin", new Uint8Array([0, 1, 2]))])).toBe(
    "⚠️ not sent: file blob.bin: not an image (PNG, JPEG, GIF, WebP), a PDF, or UTF-8 text",
  );
  expect(await answer("@be big", [slack.host("big.png", PNG, { size: 11 * 1024 * 1024 })])).toBe("⚠️ not sent: file big.png: 11MB exceeds the 10MB limit per file");
  // What Slack serves an app without files:read is its sign-in page, not the file.
  expect(await answer("@be scoped", [slack.host("x.png", PNG, { size: 5 })])).toMatch(/^⚠️ not sent: file x\.png: Slack didn't serve it \(does the app have files:read/);
  expect(await answer("@be many", Array.from({ length: 6 }, (_, i) => slack.host(`${i}.md`, "x")))).toBe("⚠️ not sent: at most 5 attachments per message");
  expect(await answer("new #docs specs", [slack.host("a.md", "x")])).toBe('⚠️ not created: files don\'t come along when making a board; make #docs first, then post them with "#docs …"');
  expect(be.pushes).toEqual([]);
}, 30_000);

test("agents learn about the human: instructions, peer_list; digests stay off Slack", async () => {
  const before = await agent("be");
  expect(before.c.getInstructions()).not.toContain("Humans on this bus");
  await startBridge();
  const after = await agent("fe");
  expect(after.c.getInstructions()).toContain('Humans on this bus: "alex"');
  const peers = (await call(after.c, "peer_list")).peers;
  expect(peers.find((p: any) => p.handle === "alex")).toMatchObject({ online: true, human: true });
  expect(peers.find((p: any) => p.handle === "be").human).toBeUndefined();

  // A digest-mode board doesn't reach Slack; a mention on it does.
  await call(before.c, "board_create", { name: "noise", purpose: "chatter" });
  const n = slack.posts().length;
  await call(before.c, "board_post", { board: "noise", body: "chatter" });
  await call(before.c, "board_post", { board: "noise", body: "@alex not chatter" });
  await until(() => slack.posts().find((p) => p.markdown_text?.includes("not chatter")));
  expect(slack.posts().length).toBe(n + 1);
}, 30_000);

test("#announce from Slack reaches every live agent marked human; acks come back to the thread", async () => {
  const be = await agent("be");
  const fe = await agent("fe");
  await startBridge();
  const a = slack.say("#announce shutting down in 30 min");
  const got = await until(() => be.pushes.find((p) => p.content === "shutting down in 30 min"));
  expect(got.meta).toMatchObject({ board: "announce", from: "alex", human: "true" });
  await until(() => fe.pushes.find((p) => p.content === "shutting down in 30 min"));
  await call(be.c, "board_post", { board: "announce", body: "be: ack", parent_id: Number(got.meta.post_id) });
  expect((await until(() => slack.posts().find((p) => p.markdown_text?.includes("be: ack")))).thread_ts).toBe(a.ts);
  await Bun.sleep(300);
  expect(fe.pushes.some((p) => p.content === "be: ack")).toBe(false);
}, 30_000);

test("the bridge declares its handle the human, and refuses if someone else is declared", async () => {
  await startBridge();
  await bridge!.stop();
  bridge = null;
  writeConfig({ handle: "sam" });
  await expect(startSlackBridge(MCP, env())).rejects.toThrow(/"alex" is the declared human handle/);
}, 30_000);

test("the bridge holds the handle; a second bridge can't start", async () => {
  await startBridge();
  await expect(startSlackBridge(MCP, env())).rejects.toThrow(/another session using that handle/);
}, 30_000);

test("Slack's disconnect warning brings up a new connection", async () => {
  const be = await agent("be");
  await startBridge();
  expect(slack.opens).toBe(1);
  slack.send({ type: "disconnect", reason: "refresh_requested" });
  await until(() => slack.opens === 2);
  await Bun.sleep(200);
  slack.say("@be still here");
  await until(() => be.pushes.find((p) => p.content === "still here"));
}, 30_000);

test("in server mode the bridge refuses to start", async () => {
  writeConfig();
  await expect(startSlackBridge(MCP, { ...env(), GRAYBOARD_TOKEN: "t" })).rejects.toThrow(/local mode only/);
}, 30_000);

test("--mode local starts the bridge on a signed-in machine, with a local child", async () => {
  const be = await agent("be");
  writeConfig();
  // No --mode in the base invocation: only the bridge's own pin keeps the child off the server.
  const bare = { command: process.execPath, args: [CLI, "mcp"] };
  bridge = await startSlackBridge(bare, { ...env(), GRAYBOARD_TOKEN: "t" }, "local");
  slack.say("@be from a signed-in machine");
  await until(() => be.pushes.find((p) => p.content === "from a signed-in machine"));
}, 30_000);

test("a bad app token fails startup instead of hanging, and frees the handle", async () => {
  writeConfig();
  slack.badAppToken = true;
  await expect(startSlackBridge(MCP, env())).rejects.toThrow(/invalid_auth/);
  slack.badAppToken = false;
  await Bun.sleep(300); // the child exits and drops its socket
  await startBridge();
}, 30_000);

test("a config file others can read is refused", async () => {
  writeConfig({}, 0o644);
  await expect(startSlackBridge(MCP, env())).rejects.toThrow(/chmod 600/);
});

function slackTsOf(post: Record<string, any>): string {
  const ts = slack.postTs.get(post);
  if (!ts) throw new Error("post not found");
  return ts;
}
