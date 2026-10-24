// The org Slack bridge (src/server/slack.ts) end to end: an in-memory server
// with a fake Slack, and agents as server-mode `grayboard mcp` children.
// Linking, the human identity's round trip, who may reach it, and unlinking.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { startServer } from "../../src/server/app.ts";
import { FakeSlack } from "./fake_slack.ts";

const CLI = resolve(import.meta.dir, "../../src/cli/main.ts");
const DM = "D0ALICE";
const ALICE_SLACK = "U0ALICE";

let app: ReturnType<typeof startServer>;
let base: string;
let slack: FakeSlack;
const open: (Client | WebSocket)[] = [];

function serve(apiUrl: string): ReturnType<typeof startServer> {
  return startServer(
    {
      dbPath: ":memory:", blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")),
      httpPort: 0,
      googleClientId: "dev",
      googleClientSecret: "",
      orgDomain: "example.com",
      publicUrl: "http://localhost",
      messageRetentionDays: 90,
      auditRetentionDays: 90,
      devAuth: true,
      admins: ["root@example.com"],
      slack: { appToken: "xapp-1-t", botToken: "xoxb-t", apiUrl },
    },
    { background: false },
  );
}

beforeEach(async () => {
  slack = new FakeSlack({ channel: DM, owner: ALICE_SLACK, channelType: "im" });
  app = serve(slack.api);
  base = `http://localhost:${app.server.port}`;
  await app.slackReady;
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => (c instanceof WebSocket ? c.close() : c.close().catch(() => {}))));
  app.stop();
  slack.stop();
});

async function login(email: string): Promise<string> {
  const r = await fetch(`${base}/api/auth/dev-login`, { method: "POST", body: JSON.stringify({ email }) });
  return ((await r.json()) as { session_token: string }).session_token;
}

async function api(token: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as any };
}

async function session(token: string, identity: string) {
  const pushes: { content: string; meta: Record<string, string> }[] = [];
  const c = new Client({ name: "test", version: "0" });
  c.fallbackNotificationHandler = async (n) => {
    if (n.method === "notifications/claude/channel") pushes.push(n.params as any);
  };
  // The tests' files are under the temp directory, declared as a scratch root.
  const env = { ...process.env, GRAYBOARD_TOKEN: token, GRAYBOARD_SERVER: base, BUS_IDENTITY: identity, BUS_ATTACH_ROOTS: tmpdir() } as Record<string, string>;
  delete env.BUS_HUMAN;
  await c.connect(
    new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp", "--mode", "server"], cwd: tmpdir(), env, stderr: "ignore" }),
  );
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

async function until<T>(f: () => T | undefined | null | false, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(20);
  }
}

function tsOf(post: Record<string, any>): string {
  const ts = slack.postTs.get(post);
  if (!ts) throw new Error("post not found");
  return ts;
}

// alice runs `grayboard slack link` and sends the code to the app in her DM.
async function link(token: string): Promise<void> {
  const r = await api(token, "POST", "/api/slack/link");
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ expires_in_s: 600, linked: false });
  slack.say(`link ${r.body.code}`);
  await until(() => slack.posts().find((p) => p.markdown_text?.startsWith("Linked to `alice@example.com`")));
}

test("link, then an agent's DM to human is a Slack thread whose reply comes back marked human", async () => {
  const alice = await login("alice@example.com");
  await link(alice);
  const me = await api(alice, "GET", "/api/whoami");
  expect(me.body.identities).toContain("human");

  const be = await session(alice, "be");
  expect(be.c.getInstructions()).toContain('"human"');
  const q = await be.call("dm_send", { to: "human", body: "Return 204 or []?" });
  expect(q.delivered_now).toBe(true);
  const top = await until(() => slack.posts().find((p) => p.markdown_text?.includes("204")));
  expect(top).toMatchObject({ channel: DM, username: "be", markdown_text: "**be** Return 204 or []?" });
  expect(top.thread_ts).toBeUndefined();

  const { envelope } = slack.say("[] please", { thread_ts: tsOf(top) });
  const got = await until(() => be.pushes.find((p) => p.content === "[] please"));
  expect(got.meta).toMatchObject({ from: "alice@example.com/human", parent_id: String(q.message_id), human: "true" });
  await until(() => slack.acks.includes(envelope));

  const follow = await be.call("dm_send", { to: "human", body: "done", parent_id: Number(got.meta.message_id) });
  expect(follow.delivered_now).toBe(true);
  const post = await until(() => slack.posts().find((p) => p.markdown_text === "**be** done"));
  expect(post.thread_ts).toBe(tsOf(top));
}, 30_000);

test("attachments cross the org bridge both ways, and the audit log says where they went", async () => {
  const alice = await login("alice@example.com");
  await link(alice);
  const be = await session(alice, "be");
  const tmp = mkdtempSync(join(tmpdir(), "grayboard-slack-org-"));
  try {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);
    writeFileSync(join(tmp, "shot.png"), png);
    const q = await be.call("dm_send", { to: "human", body: "look", attachments: [join(tmp, "shot.png")] });
    const s = await until(() => slack.shares()[0]);
    expect(s).toMatchObject({ channel_id: DM, blocks: [{ type: "markdown", text: "**be** look" }] });
    // Slack ignores username on completeUploadExternal (measured); the name rides in the text.
    expect(s.username).toBeUndefined();
    expect(s.thread_ts).toBeUndefined();
    expect(slack.uploaded.get(s.files[0].id)).toEqual(png);

    // The relay maps the thread once files.info shows the share's ts, which lags the upload.
    await until(() => app.db.prepare(`SELECT 1 FROM slack_threads WHERE thread_ts = ?`).get(s.ts));
    slack.say("here", { thread_ts: s.ts, extra: { subtype: "file_share", files: [slack.host("reply.md", "ok\n")] } });
    const got = await until(() => be.pushes.find((p) => p.content === "here"));
    expect(got.meta).toMatchObject({ from: "alice@example.com/human", parent_id: String(q.message_id), human: "true" });
    expect(got.meta.attachments).toMatch(/^\d+:reply\.md text\/markdown 3B sha256:[0-9a-f]{64}$/);
    const id = Number(got.meta.attachments!.split(":")[0]);
    const saved = await be.call("attachment_get", { id, dir: tmp });
    expect(readFileSync(saved.path, "utf8")).toBe("ok\n");

    const audit = (action: string) =>
      app.db.prepare(`SELECT actor, target, detail FROM access_log WHERE action = ? ORDER BY at`).all(action) as { actor: string; target: string; detail: string }[];
    const sent = await until(() => audit("attachment.sent_to_slack")[0]);
    expect(sent.actor).toBe("alice@example.com");
    const sha256 = createHash("sha256").update(png).digest("hex");
    expect(JSON.parse(sent.detail)).toEqual({ identity: "alice@example.com/human", channel: DM, thread_ts: s.ts, slack_file: s.files[0].id, sha256 });
    // Binding says which message carried each file, to whom: be's to the human, the human's reply to be.
    const bound = audit("attachment.bound").map((r) => ({ target: r.target, ...JSON.parse(r.detail) }));
    expect(bound).toEqual([
      { target: `attachment:${q.attachments[0].id}`, identity: "alice@example.com/be", message_id: q.message_id, recipient: "alice@example.com/human" },
      { target: `attachment:${id}`, identity: "alice@example.com/human", message_id: Number(got.meta.message_id), recipient: "alice@example.com/be" },
    ]);
    const fromSlack = audit("attachment.uploaded").find((r) => r.target === `attachment:${id}`)!;
    expect(JSON.parse(fromSlack.detail)).toMatchObject({ identity: "alice@example.com/human", filename: "reply.md", size: 3, slack_file: expect.stringMatching(/^FH/) });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}, 30_000);

test("a file Slack refuses goes back to its sender, and the text carries the warning", async () => {
  const alice = await login("alice@example.com");
  await link(alice);
  const be = await session(alice, "be");
  slack.refuseUploads = "file_type_not_allowed";
  const tmp = mkdtempSync(join(tmpdir(), "grayboard-slack-org-"));
  try {
    writeFileSync(join(tmp, "shot.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]));
    const q = await be.call("dm_send", { to: "human", body: "look", attachments: [join(tmp, "shot.png")] });
    const top = await until(() => slack.posts().find((p) => p.markdown_text?.startsWith("**be** look")));
    expect(top.markdown_text).toBe("**be** look\n\n⚠️ not delivered to Slack: shot.png: file_type_not_allowed");
    const back = await until(() => be.pushes.find((p) => p.meta.from === "alice@example.com/human"));
    expect(back.meta.parent_id).toBe(String(q.message_id));
    expect(back.content).toStartWith(`[Slack bridge] Files on your message ${q.message_id} didn't reach Slack`);
    const refused = await until(() => app.db.prepare(`SELECT actor, target, detail FROM access_log WHERE action = 'attachment.slack_refused'`).get() as { actor: string; target: string; detail: string } | null);
    expect(refused.actor).toBe("alice@example.com");
    expect(JSON.parse(refused.detail)).toMatchObject({ identity: "alice@example.com/human", channel: DM, filename: "shot.png", reason: "file_type_not_allowed", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    // Done items leave no progress behind.
    await until(() => (app.db.prepare(`SELECT COUNT(*) AS n FROM slack_progress`).get() as { n: number }).n === 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}, 30_000);

test("files on a Slack message the bus refuses are released, not left holding the quota", async () => {
  const alice = await login("alice@example.com");
  await link(alice);
  const { ts } = slack.say("@nobody look", { extra: { subtype: "file_share", files: [slack.host("n.md", "x")] } });
  const reply = await until(() => slack.posts().find((p) => p.thread_ts === ts));
  expect(reply.markdown_text).toStartWith("⚠️ not sent:");
  const actions = app.db.prepare(`SELECT action, detail FROM access_log WHERE action LIKE 'attachment.%' ORDER BY id`).all() as { action: string; detail: string }[];
  expect(actions.map((a) => a.action)).toEqual(["attachment.uploaded", "attachment.released"]);
  expect(JSON.parse(actions[1]!.detail)).toMatchObject({ identity: "alice@example.com/human", filename: "n.md", via: "slack" });
  expect(app.db.prepare(`SELECT COUNT(*) AS n FROM attachments`).get()).toEqual({ n: 0 });
}, 30_000);

test("a post Slack refuses is retried and lands once", async () => {
  const alice = await login("alice@example.com");
  await link(alice);
  const be = await session(alice, "be");
  slack.failPosts = 1;
  const sent = await be.call("dm_send", { to: "human", body: "flaky" });
  await until(() => slack.posts().find((p) => p.markdown_text === "**be** flaky"));
  expect(app.repo.cursors.directFor("alice@example.com/human")).toBeLessThan(sent.message_id);
  // The relay retries after 5s; the refused attempt is in posts() but got no ts.
  const landed = () => slack.posts().filter((p) => p.markdown_text === "**be** flaky" && slack.postTs.has(p));
  await until(() => landed().length > 0, 10_000);
  await Bun.sleep(300);
  expect(landed()).toHaveLength(1);
  expect(app.repo.cursors.directFor("alice@example.com/human")).toBe(sent.message_id);
  expect(slack.posts().filter((p) => p.markdown_text === "**be** flaky")).toHaveLength(2);
}, 30_000);

test("only the bridge may hello as human", async () => {
  const alice = await login("alice@example.com");
  const ws = new (WebSocket as any)(`${base.replace("http", "ws")}/ws`, { headers: { Authorization: `Bearer ${alice}` } }) as WebSocket;
  open.push(ws);
  const reply = await new Promise<any>((res) => {
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data as string);
      if (m.req_id === "h") res(m);
    };
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", req_id: "h", identity: "human" }));
  });
  expect(reply).toMatchObject({ type: "error", code: "bad_request" });
  // And not over HTTP either.
  expect((await api(alice, "POST", "/api/identities", { name: "human" })).status).toBe(400);
}, 30_000);

test("another user's agents reach a human only as teammates", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  await link(alice);
  const fe = await session(bob, "fe");
  // bob hasn't linked, so his sessions pay nothing for the human sentence.
  expect(fe.c.getInstructions()).not.toContain('dm_send(to="human")');

  await expect(fe.call("dm_send", { to: "alice@example.com/human", body: "hi" })).rejects.toThrow(/reachable only by their teammates/);
  // A bare "human" is your own, and bob hasn't linked.
  await expect(fe.call("dm_send", { to: "human", body: "hi" })).rejects.toThrow(/hasn't linked Slack/);
  await fe.call("board_create", { name: "e2e", purpose: "fixtures" });
  const blocked = await fe.call("board_post", { board: "e2e", body: "@alice/human look" });
  expect(blocked.unresolved).toEqual(["alice/human"]);

  expect((await api(alice, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
  await api(alice, "POST", "/api/teams/eng/add", { email: "bob@example.com" });

  expect((await fe.call("dm_send", { to: "alice@example.com/human", body: "hi alice" })).delivered_now).toBe(true);
  const dm = await until(() => slack.posts().find((p) => p.markdown_text?.endsWith("hi alice")));
  expect(dm.username).toBe("bob@example.com/fe");
  const ok = await fe.call("board_post", { board: "e2e", body: "@alice/human look again" });
  expect(ok.unresolved ?? []).toEqual([]);
  await until(() => slack.posts().find((p) => p.markdown_text?.includes("look again")));
  expect(slack.posts().some((p) => p.markdown_text?.endsWith("@alice/human look"))).toBe(false);
}, 30_000);

test("unlink in Slack removes the human; the HTTP unlink then has nothing to remove", async () => {
  const alice = await login("alice@example.com");
  await link(alice);
  const be = await session(alice, "be");

  slack.say("unlink");
  await until(() => slack.posts().find((p) => p.markdown_text?.startsWith("Unlinked from `alice@example.com`")));
  const me = await api(alice, "GET", "/api/whoami");
  expect(me.body.identities).not.toContain("human");
  await expect(be.call("dm_send", { to: "human", body: "still there?" })).rejects.toThrow(/hasn't linked Slack/);
  expect((await api(alice, "POST", "/api/slack/unlink")).status).toBe(404);

  // Messages sent while unlinked don't reach the phone; Slack says who it isn't.
  slack.say("hello?");
  await until(() => slack.posts().find((p) => p.markdown_text?.startsWith("This Slack account isn't linked")));

  // Relinking works and starts fresh.
  await link(alice);
  expect((await be.call("dm_send", { to: "human", body: "back" })).delivered_now).toBe(true);
  await until(() => slack.posts().find((p) => p.markdown_text === "**be** back"));
}, 30_000);

// The id of the post on #e2e with this body, once it's there.
async function postId(s: Awaited<ReturnType<typeof session>>, body: string): Promise<number> {
  const end = Date.now() + 5000;
  for (;;) {
    const r = await s.call("board_read", { board: "e2e" });
    const p = (r.posts as { id: number; body: string }[]).find((p) => p.body === body);
    if (p) return p.id;
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(50);
  }
}

const posted = (text: string) => slack.posts().some((p) => p.markdown_text?.includes(text));

test("a thread reply reaches a human only as a DM could", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  await link(alice);
  const fe = await session(bob, "fe");
  await fe.call("board_create", { name: "e2e", purpose: "fixtures" });
  slack.say("#e2e which fixture?");
  const root = await postId(fe, "which fixture?");

  await fe.call("board_post", { board: "e2e", body: "not a teammate", parent_id: root });
  await Bun.sleep(500);
  expect(posted("not a teammate")).toBe(false);

  expect((await api(alice, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
  await api(alice, "POST", "/api/teams/eng/add", { email: "bob@example.com" });
  await fe.call("board_post", { board: "e2e", body: "now a teammate", parent_id: root });
  await until(() => posted("now a teammate"));
  expect(posted("not a teammate")).toBe(false);
}, 30_000);

test("thread replies while unlinked don't flood in at relink", async () => {
  const alice = await login("alice@example.com");
  await link(alice);
  const be = await session(alice, "be");
  await be.call("board_create", { name: "e2e", purpose: "fixtures" });
  slack.say("#e2e which fixture?");
  const root = await postId(be, "which fixture?");

  slack.say("unlink");
  await until(() => slack.posts().find((p) => p.markdown_text?.startsWith("Unlinked from")));
  await be.call("board_post", { board: "e2e", body: "while away", parent_id: root });
  await link(alice);
  await be.call("board_post", { board: "e2e", body: "after relink", parent_id: root });
  await until(() => posted("after relink"));
  expect(posted("while away")).toBe(false);
}, 30_000);

test("relinking from another Slack account starts new threads there", async () => {
  const alice = await login("alice@example.com");
  await link(alice);
  const be = await session(alice, "be");
  const q = await be.call("dm_send", { to: "human", body: "first" });
  await until(() => posted("first"));

  const r = await api(alice, "POST", "/api/slack/link");
  slack.say(`link ${r.body.code}`, { user: "U0OTHER", channel: "D0OTHER" });
  await until(() => slack.posts().find((p) => p.channel === "D0OTHER" && p.markdown_text?.startsWith("Linked to")));
  await be.call("dm_send", { to: "human", body: "second", parent_id: q.message_id });
  const post = await until(() => slack.posts().find((p) => p.markdown_text === "**be** second"));
  expect(post.channel).toBe("D0OTHER");
  expect(post.thread_ts).toBeUndefined();
}, 30_000);

test("disabling a user takes their human offline; enabling brings it back", async () => {
  const [alice, bob, root] = await Promise.all(["alice", "bob", "root"].map((n) => login(`${n}@example.com`)));
  await link(alice);
  // A teammate's agent, since disabling alice also closes her own agents' connections.
  await api(alice, "POST", "/api/teams", { name: "eng" });
  await api(alice, "POST", "/api/teams/eng/add", { email: "bob@example.com" });
  const fe = await session(bob, "fe");
  expect((await api(root, "POST", "/api/admin/disable-user", { email: "alice@example.com" })).status).toBe(200);
  expect(await fe.call("dm_send", { to: "alice@example.com/human", body: "while disabled" })).toMatchObject({ delivered_now: false });
  await Bun.sleep(500);
  expect(posted("while disabled")).toBe(false);
  expect((await api(root, "POST", "/api/admin/enable-user", { email: "alice@example.com" })).status).toBe(200);
  await until(() => posted("while disabled"));
}, 30_000);

test("a bridge that failed to start issues no codes", async () => {
  const down = serve("http://127.0.0.1:1/api/");
  await down.slackReady;
  try {
    const url = `http://localhost:${down.server.port}`;
    const t = ((await (await fetch(`${url}/api/auth/dev-login`, { method: "POST", body: JSON.stringify({ email: "alice@example.com" }) })).json()) as any).session_token;
    const r = await fetch(`${url}/api/slack/link`, { method: "POST", headers: { Authorization: `Bearer ${t}` } });
    expect(r.status).toBe(404);
    expect(((await r.json()) as any).message).toMatch(/isn't running/);
  } finally {
    down.stop();
  }
}, 30_000);
