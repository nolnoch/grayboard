// The org Slack bridge (src/server/slack.ts) end to end: an in-memory server
// with a fake Slack, and agents as hosted MCP sessions (#282). Linking, the
// human identity's round trip, who may reach it, and unlinking.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { subscribe, type ReadResult } from "../../src/core/boards.ts";
import type { BoardPostResult } from "../../src/core/tools.ts";
import { ApplicationError } from "../../src/server/application.ts";
import type { SendResult } from "../../src/shared/protocol.ts";
import { createHash } from "node:crypto";

import { FakeSlack } from "./fake_slack.ts";
import { direct } from "../support/events.ts";
import { accessAudits, auditOrigins } from "../support/audit.ts";
import type { HostedSession } from "../support/hosted_session.ts";
import { closeSessions } from "../support/mcp.ts";
import { TestServer } from "../support/server.ts";
import { seed } from "../support/seed.ts";
import { until } from "../support/until.ts";
import { queueFor } from "../../src/server/store/queue.ts";
import type { Relay, RelayStore } from "../../src/bridge/relay.ts";
const DM = "D0ALICE";
const ALICE_SLACK = "U0ALICE";

let srv: TestServer;
let slack: FakeSlack;

// Inbox polling spends hosted requests.
const serve = (apiUrl: string) =>
  new TestServer({ admins: ["root@example.com"], slack: { appToken: "xapp-1-t", botToken: "xoxb-t", apiUrl }, hostedRequestLimit: { burst: 10_000, perSec: 10_000 } });

beforeEach(async () => {
  slack = new FakeSlack({ channel: DM, owner: ALICE_SLACK, channelType: "im" });
  slack.emails.set(ALICE_SLACK, "alice@example.com");
  srv = serve(slack.api);
  await srv.app.slackReady;
});

afterEach(async () => {
  await closeSessions();
  await srv.stop();
  slack.stop();
});

const login = (email: string) => srv.login(email);
const api = (token: string, method: string, path: string, body?: unknown) => srv.api(token, method, path, body);

// An agent: a hosted MCP session of `email`'s, bound to `identity`.
const hosted = (email: string, identity: string | null) => srv.hosted(email, identity);

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
  // Only a confirmation after this command: a relink would otherwise match the first link's (#466).
  const seen = slack.posts().length;
  slack.say(`link ${r.body.code}`);
  await until(() => slack.posts().slice(seen).find((p) => p.markdown_text?.startsWith("Linked to `alice@example.com`")));
}

test("link, then a hosted agent's DM to human is a Slack thread whose reply comes back from the human", async () => {
  const alice = await login("alice@example.com");
  await link(alice);
  const me = await api(alice, "GET", "/api/whoami");
  expect(me.body.identities).toContain("human");

  const be = await hosted("alice@example.com", "be");
  expect(await be.instructionsNow()).toContain('"human"');
  const q = await be.call<SendResult>("dm_send", { to: "human", body: "Return 204 or []?" });
  expect(q.delivered_now).toBe(true);
  const top = await until(() => slack.posts().find((p) => p.markdown_text?.includes("204")));
  expect(top).toMatchObject({ channel: DM, username: "be", markdown_text: "**be** Return 204 or []?" });
  expect(top.thread_ts).toBeUndefined();

  const { envelope } = slack.say("[] please", { thread_ts: tsOf(top) });
  const got = (await be.next(direct((m) => m.body === "[] please"), 5000)).event.message;
  expect(got).toMatchObject({ sender: "alice@example.com/human", parent_id: q.message_id });
  await until(() => slack.acks.includes(envelope));

  const follow = await be.call<SendResult>("dm_send", { to: "human", body: "done", parent_id: got.id });
  expect(follow.delivered_now).toBe(true);
  const post = await until(() => slack.posts().find((p) => p.markdown_text === "**be** done"));
  expect(post.thread_ts).toBe(tsOf(top));
}, 30_000);

// #523: a subagent's DM to human reads in Slack as its root's name followed
// by the child, labelled as what the harness asserted; the root's names itself alone.
test("a hosted child's DM to human names the subagent after the sender, as the harness's claim", async () => {
  const alice = await login("alice@example.com");
  await link(alice);
  const be = await hosted("alice@example.com", "be");
  const registered = await be.subscriber.call("session_register", { child: "reviewer-run" }) as { child: string };
  const child = await srv.hosted("alice@example.com", null, { sessionId: "reviewer-run", delivery: false });
  expect(await child.call<SendResult>("dm_send", { to: "human", body: "Reviewed: LGTM" })).toMatchObject({ delivered_now: true });
  const top = await until(() => slack.posts().find((p) => p.markdown_text?.includes("LGTM")));
  expect(top).toMatchObject({ channel: DM, username: "be", markdown_text: `**be** (subagent ${registered.child}, harness-asserted) Reviewed: LGTM` });
  await be.call<SendResult>("dm_send", { to: "human", body: "the root's own" });
  expect(await until(() => slack.posts().find((p) => p.markdown_text?.includes("the root's own")))).toMatchObject({ markdown_text: "**be** the root's own" });
}, 30_000);

// #470: delivered_at means the message reached Slack; one Slack refuses is
// given up (its cursor moves, so it isn't retried) but never stamped.
test("a DM Slack posts is stamped delivered_at; one Slack refuses is given up unstamped", async () => {
  const alice = await login("alice@example.com");
  await link(alice);
  const be = await hosted("alice@example.com", "be");
  const ok = await be.call<SendResult>("dm_send", { to: "human", body: "posted" });
  await until(() => slack.posts().find((p) => p.markdown_text === "**be** posted"));
  const stamp = (id: number) => srv.app.db.prepare(`SELECT delivered_at FROM messages WHERE id = ?`).get(id) as { delivered_at: number | null };
  await until(() => stamp(ok.message_id).delivered_at !== null);
  slack.refusePosts = "msg_too_long";
  const refused = await be.call<SendResult>("dm_send", { to: "human", body: "too long" });
  await until(async () => (await srv.app.repo.cursors.directFor(srv.app.repo.read, "alice@example.com/human")) >= refused.message_id);
  expect(stamp(refused.message_id).delivered_at).toBeNull();
}, 30_000);

test("attachments cross the org bridge both ways for a hosted session, and the audit log says where they went", async () => {
  const alice = await login("alice@example.com");
  await link(alice);
  const be = await hosted("alice@example.com", "be");
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);
  const upload = await be.upload("shot.png", png);
  const q = await be.call<SendResult>("dm_send", { to: "human", body: "look", attachment_ids: [upload] });
  const s = await until(() => slack.shares()[0]);
  expect(s).toMatchObject({ channel_id: DM, blocks: [{ type: "markdown", text: "**be** look" }] });
  // Slack ignores username on completeUploadExternal (measured); the name rides in the text.
  expect(s.username).toBeUndefined();
  expect(s.thread_ts).toBeUndefined();
  expect(slack.uploaded.get(s.files[0].id)).toEqual(png);

  // The relay maps the thread once files.info shows the share's ts, which lags the upload.
  await until(() => srv.app.db.prepare(`SELECT 1 FROM slack_threads WHERE thread_ts = ?`).get(s.ts));
  slack.say("here", { thread_ts: s.ts, extra: { subtype: "file_share", files: [slack.host("reply.md", "ok\n")] } });
  const got = (await be.next(direct((m) => m.body === "here"), 5000)).event.message;
  expect(got).toMatchObject({ sender: "alice@example.com/human", parent_id: q.message_id });
  expect(got.attachments).toEqual([{ id: expect.any(Number), filename: "reply.md", type: "text/markdown", size: 3, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
  const id = got.attachments![0]!.id;
  expect(new TextDecoder().decode(await be.download(id))).toBe("ok\n");

  const audit = (action: string) => accessAudits(srv.app.db, action);
  const sent = await until(() => audit("attachment.sent_to_slack")[0]);
  expect(sent.actor).toBe("alice@example.com");
  // The relay's drain started inside be's /mcp request, but carries every
  // queued item: its rows carry no request's address (security audit F-19).
  expect(auditOrigins(srv.app.db, "attachment.sent_to_slack")).toEqual([{ ip: null, ua: null, client_id: null }]);
  const sha256 = createHash("sha256").update(png).digest("hex");
  expect(sent.detail).toEqual({ identity: "alice@example.com/human", channel: DM, thread_ts: s.ts, slack_file: s.files[0].id, sha256 });
  // Binding says which message carried each file, to whom: be's to the human, the human's reply to be.
  const bound = audit("attachment.bound").map((r): Record<string, unknown> => ({ target: r.target, ...r.detail }));
  expect(bound).toEqual([
    { target: `attachment:${q.attachments![0]!.id}`, identity: "alice@example.com/be", message_id: q.message_id, recipient: "alice@example.com/human" },
    { target: `attachment:${id}`, identity: "alice@example.com/human", message_id: got.id, recipient: "alice@example.com/be" },
  ]);
  const fromSlack = audit("attachment.uploaded").find((r) => r.target === `attachment:${id}`)!;
  expect(fromSlack.detail).toMatchObject({ identity: "alice@example.com/human", filename: "reply.md", size: 3, slack_file: expect.stringMatching(/^FH/) });
}, 30_000);

test("a file Slack refuses goes back to its sender, and the text carries the warning", async () => {
  const alice = await login("alice@example.com");
  await link(alice);
  const be = await hosted("alice@example.com", "be");
  slack.refuseUploads = "file_type_not_allowed";
  const upload = await be.upload("shot.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]));
  const q = await be.call<SendResult>("dm_send", { to: "human", body: "look", attachment_ids: [upload] });
  const top = await until(() => slack.posts().find((p) => p.markdown_text?.startsWith("**be** look")));
  expect(top.markdown_text).toBe("**be** look\n\n⚠️ not delivered to Slack: shot.png: file_type_not_allowed");
  const back = (await be.next(direct((m) => m.sender === "alice@example.com/human"), 5000)).event.message;
  expect(back.parent_id).toBe(q.message_id);
  expect(back.body).toStartWith(`[Slack bridge] Files on your message ${q.message_id} didn't reach Slack`);
  const refused = await until(() => srv.app.db.prepare(`SELECT actor, target, detail FROM access_log WHERE action = 'attachment.slack_refused'`).get() as { actor: string; target: string; detail: string } | null);
  expect(refused.actor).toBe("alice@example.com");
  expect(JSON.parse(refused.detail)).toMatchObject({ identity: "alice@example.com/human", channel: DM, filename: "shot.png", reason: "file_type_not_allowed", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  // Done items leave no progress behind.
  await until(() => (srv.app.db.prepare(`SELECT COUNT(*) AS n FROM slack_progress`).get() as { n: number }).n === 0);
}, 30_000);

test("files on a Slack message the bus refuses are released, not left holding the quota", async () => {
  const alice = await login("alice@example.com");
  await link(alice);
  const { ts } = slack.say("@nobody look", { extra: { subtype: "file_share", files: [slack.host("n.md", "x")] } });
  const reply = await until(() => slack.posts().find((p) => p.thread_ts === ts));
  expect(reply.markdown_text).toStartWith("⚠️ not sent:");
  const actions = srv.app.db.prepare(`SELECT action, detail FROM access_log WHERE action LIKE 'attachment.%' ORDER BY id`).all() as { action: string; detail: string }[];
  expect(actions.map((a) => a.action)).toEqual(["attachment.uploaded", "attachment.released"]);
  expect(JSON.parse(actions[1]!.detail)).toMatchObject({ identity: "alice@example.com/human", filename: "n.md", via: "slack" });
  expect(srv.app.db.prepare(`SELECT COUNT(*) AS n FROM attachments`).get()).toEqual({ n: 0 });
}, 30_000);

test("a post Slack refuses is retried and lands once", async () => {
  const alice = await login("alice@example.com");
  await link(alice);
  const be = await hosted("alice@example.com", "be");
  slack.failPosts = 1;
  await be.call("dm_send", { to: "human", body: "flaky" });
  // The relay retries after 5s; the refused attempt is in posts() but got no ts.
  const landed = () => slack.posts().filter((p) => p.markdown_text === "**be** flaky" && slack.postTs.has(p));
  await until(() => landed().length > 0, 10_000);
  await Bun.sleep(300);
  expect(landed()).toHaveLength(1);
  expect(slack.posts().filter((p) => p.markdown_text === "**be** flaky")).toHaveLength(2);
}, 30_000);

test("only the bridge may hold human: no session binds it", async () => {
  const alice = await login("alice@example.com");
  await expect(srv.appSession(alice, "human").connect()).rejects.toMatchObject({ code: "forbidden" });
  // And not over HTTP either.
  expect((await api(alice, "POST", "/api/identities", { name: "human" })).status).toBe(400);
}, 30_000);

test("unexpected bridge bus failures log once and reply generically; expected refusals retain their message", async () => {
  const alice = await login("alice@example.com");
  await link(alice);
  const be = await hosted("alice@example.com", "be");
  expect(await be.call<SendResult>("dm_send", { to: "human", body: "diagnostic fixture" })).toMatchObject({ message_id: expect.any(Number) });
  const top = await until(() => slack.posts().find(p => p.markdown_text === "**be** diagnostic fixture"));
  const original = srv.app.application.send;
  const logs = spyOn(console, "error").mockImplementation(() => {});
  const secret = `Bearer ${alice} client_secret=hidden https://user:password@example.com/?token=hidden`;
  const multiline = new Error(`${secret}\n    at send (/private/server/${alice}.ts:12:34)\n    at send (/private/server/slack.ts:12:34)`);
  const forged = new Error(secret);
  forged.stack = `Error: failure\n    at send (/private/server/${alice}.js:12:34)`;
  forged.cause = forged;
  const getters = new Error("untrusted properties");
  let reads = 0;
  for (const key of ["message", "stack", "cause"]) Object.defineProperty(getters, key, { get() { reads++; throw new Error(secret); } });
  const named = Object.assign(new Error(secret), { name: "hidden Error", code: "ENOENT hidden" });
  const errno = Object.assign(new Error(secret), { code: "ENOENT" });
  const classes = new Map<Error, string>([[named, '\\"class\\":\\"[unrecognized]\\"}'], [errno, '\\"class\\":\\"Error\\",\\"code\\":\\"ENOENT\\"}']]);
  try {
    for (const error of [multiline, forged, getters, named, errno]) {
      logs.mockClear();
      srv.app.application.send = () => { throw error; };
      const before = slack.posts().length;
      const failed = slack.say("private body", { thread_ts: tsOf(top) });
      const reply = await until(() => slack.posts().slice(before).find(p => p.thread_ts === tsOf(top) && p.markdown_text?.includes("internal error")));
      await until(() => slack.acks.includes(failed.envelope));
      expect(logs).toHaveBeenCalledTimes(1);
      const text = JSON.stringify([reply, logs.mock.calls]);
      expect(text).toContain("dm_send");
      expect(text).toContain('\\"source\\":\\"src/server/slack.ts\\",\\"operation\\":\\"bus.call\\",\\"category\\":\\"unexpected\\"');
      expect(text).toContain(classes.get(error) ?? '\\"class\\":\\"Error\\"}');
      expect(text.length).toBeLessThan(2048);
      for (const hidden of [alice, "password", "hidden", "private body", "client_secret", "12:34"]) expect(text).not.toContain(hidden);
    }
    expect(reads).toBe(0);
    logs.mockClear();
    srv.app.application.send = () => { throw new ApplicationError("forbidden", "safe expected refusal"); };
    const refused = slack.say("second reply", { thread_ts: tsOf(top) });
    await until(() => slack.posts().find(p => p.markdown_text?.includes("safe expected refusal")));
    await until(() => slack.acks.includes(refused.envelope));
    expect(logs).not.toHaveBeenCalled();
  } finally { srv.app.application.send = original; logs.mockRestore(); }
});

test("another user's agents reach a human only as teammates", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  await link(alice);
  const fe = await hosted("bob@example.com", "fe");
  // bob hasn't linked, so his sessions pay nothing for the human sentence.
  expect(await fe.instructionsNow()).not.toContain('dm_send(to="human")');

  await expect(fe.call("dm_send", { to: "alice@example.com/human", body: "hi" })).rejects.toThrow(/reachable only by their teammates/);
  // A bare "human" is your own, and bob hasn't linked.
  await expect(fe.call("dm_send", { to: "human", body: "hi" })).rejects.toThrow(/hasn't linked Slack/);
  await fe.call("board_create", { name: "e2e", purpose: "fixtures" });
  const blocked = await fe.call<BoardPostResult>("board_post", { board: "e2e", body: "@alice@example.com/human look" });
  expect(blocked.unresolved).toEqual(["alice@example.com/human"]);

  expect((await api(alice, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
  await api(alice, "POST", "/api/teams/eng/add", { email: "bob@example.com" });

  expect((await fe.call<SendResult>("dm_send", { to: "alice@example.com/human", body: "hi alice" })).delivered_now).toBe(true);
  const dm = await until(() => slack.posts().find((p) => p.markdown_text?.endsWith("hi alice")));
  expect(dm.username).toBe("bob@example.com/fe");
  const ok = await fe.call<BoardPostResult>("board_post", { board: "e2e", body: "@alice@example.com/human look again" });
  expect(ok.unresolved ?? []).toEqual([]);
  await until(() => slack.posts().find((p) => p.markdown_text?.includes("look again")));
  expect(slack.posts().some((p) => p.markdown_text?.endsWith("@alice@example.com/human look"))).toBe(false);
}, 30_000);

test("unlink in Slack removes the human; the HTTP unlink then has nothing to remove", async () => {
  const alice = await login("alice@example.com");
  await link(alice);
  const be = await hosted("alice@example.com", "be");

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
  expect((await be.call<SendResult>("dm_send", { to: "human", body: "back" })).delivered_now).toBe(true);
  await until(() => slack.posts().find((p) => p.markdown_text === "**be** back"));
}, 30_000);

// The id of the post on #e2e with this body, once it's there.
function postId(s: HostedSession, body: string): Promise<number> {
  return until(async () => (await s.call<ReadResult>("board_read", { board: "e2e" })).posts.find((p) => p.body === body)?.id);
}

const posted = (text: string) => slack.posts().some((p) => p.markdown_text?.includes(text));

// #332: the org bridge's refusal for an @id: that can't receive reaches the Slack thread, and nothing is posted. A
// hosted session_end keeps its ID (#451 decision 7), so the undeliverable ID here is one that never existed.
test("a Slack post mentioning an @id: that can't receive is refused in its thread", async () => {
  const alice = await login("alice@example.com");
  await link(alice);
  const be = await hosted("alice@example.com", "be");
  await be.call("board_create", { name: "e2e", purpose: "fixtures" });

  const top = slack.say("#e2e ping @id:0123456789abz");
  const reply = await until(() => slack.posts().find((p) => p.thread_ts === top.ts));
  expect(reply.markdown_text).toBe("⚠️ not posted: no session id:0123456789abz");
  await until(() => slack.acks.includes(top.envelope));
  expect((await be.call<ReadResult>("board_read", { board: "e2e" })).posts).toEqual([]);
}, 30_000);

test("a thread reply reaches a human only as a DM could", async () => {
  const alice = await login("alice@example.com");
  const bob = await login("bob@example.com");
  await link(alice);
  const fe = await hosted("bob@example.com", "fe");
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

// #807 D4: an unlink is one transaction through the server's write queue, and the human goes offline only after it commits.
// `started`: once it holds the queue (a busy queue starts it later); a release before then frees it as it starts.
function holdQueue(): { release: () => void; started: Promise<void>; done: Promise<void> } {
  let released = false;
  let free: (() => void) | undefined;
  let begin!: () => void;
  const started = new Promise<void>((r) => { begin = r; });
  const done = queueFor(srv.app.db).run(() => new Promise<void>((r) => { begin(); if (released) r(); else free = r; }));
  return { release: () => { released = true; free?.(); }, started, done };
}
const ticks = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

test("#807: an HTTP unlink while another body holds the write queue waits, then removes the link", async () => {
  const alice = await login("alice@example.com");
  await link(alice);
  const userId = (await srv.app.repo.users.findByEmail(srv.app.repo.read, "alice@example.com"))!.id;
  const holder = holdQueue();
  const unlinked = srv.app.slack!.unlink(userId);
  await ticks();
  expect(srv.app.repo.slack.linkFor(srv.app.repo.read, userId)).toBeDefined();
  holder.release();
  await holder.done;
  expect(await unlinked).toBe(true);
  expect(srv.app.repo.slack.linkFor(srv.app.repo.read, userId)).toBeUndefined();
});

// #807 D4: a Slack user's tool call is one transaction through the write queue, as a hosted call is.
test("#807: a Slack user's dm_send and board_post run inside a write-queue transaction", async () => {
  const alice = await login("alice@example.com");
  await link(alice);
  const be = await hosted("alice@example.com", "be");
  await be.call("board_create", { name: "e2e", purpose: "fixtures" });
  const app = srv.app.application;
  const { call, send } = app;
  const seen: Record<string, boolean> = {};
  const queued = () => srv.app.db.inTransaction && queueFor(srv.app.db).mine;
  app.call = (tx, s, n, a, p) => { seen[n] = queued(); return call.call(app, tx, s, n, a, p); };
  app.send = (tx, s, to, body, o) => { seen.dm_send = queued(); return send.call(app, tx, s, to, body, o); };
  try {
    slack.say("#e2e queued post");
    slack.say("@be queued dm");
    await until(() => "board_post" in seen && "dm_send" in seen, 5000, "both calls reached the application");
  } finally { app.call = call; app.send = send; }
  expect(seen).toEqual({ board_post: true, dm_send: true });
});

// A refusal's row (rowAfterRollback, application.ts) is written after the rollback that drops the call's other
// writes (#452), as a hosted call's are (#981): a real msg.send deny (policy.ts humanRule), the Slack human DMing
// another person's human it isn't a teammate of.
test("#807: a Slack user's refused call keeps its refusal row", async () => {
  const alice = await login("alice@example.com");
  await login("bob@example.com");
  await link(alice);
  // bob's human, as his link would make it: without it the send is a missing identity, refused before policy.
  const repo = srv.app.repo;
  await seed(repo, tx => repo.aliases.create(tx, { scope_kind: "person", scope_ref: "bob@example.com", name: "human" }, "bob@example.com"));
  const top = slack.say("@bob@example.com/human hello");
  const reply = await until(() => slack.posts().find((p) => p.thread_ts === top.ts), 5000, "the refusal reached Slack");
  expect(reply.markdown_text).toContain("reachable only by their teammates");
  const rows = accessAudits(srv.app.db, "authz.decision");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ actor: "alice@example.com", detail: { verb: "msg.send", allow: false, rule: "human.teammates", address: "alice@example.com/human" } });
});

// #981: the relay's dm_thread (dmRoot, for a reply that reaches the human) runs inside a write-queue transaction, as
// dm_send does.
test("#807: a Slack user's dm_thread runs inside a write-queue transaction", async () => {
  const alice = await login("alice@example.com");
  await link(alice);
  const be = await hosted("alice@example.com", "be");
  const app = srv.app.application;
  const { thread } = app;
  const seen: boolean[] = [];
  app.thread = (tx, s, id) => { seen.push(srv.app.db.inTransaction && queueFor(srv.app.db).mine); return thread.call(app, tx, s, id); };
  try {
    const root = await be.call<SendResult>("dm_send", { to: "human", body: "thread root" });
    await until(() => posted("thread root"), 5000, "the root reached Slack");
    await be.call("dm_send", { to: "human", body: "thread reply", parent_id: root.message_id });
    await until(() => posted("thread reply"), 5000, "the reply reached Slack");
  } finally { app.thread = thread; }
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every(Boolean)).toBe(true);
});

// Holds the write queue as the first repo.post named `what` is made, so that write queues behind the holder; each
// such post's return (true: it ran at once) is pushed to `ran`.
function holdAtPost(what: string): { ran: boolean[]; holder: () => ReturnType<typeof holdQueue> | undefined; restore: () => void } {
  const repo = srv.app.repo;
  const { post } = repo;
  const ran: boolean[] = [];
  let holder: ReturnType<typeof holdQueue> | undefined;
  repo.post = (fn, committed, label) => {
    if (label === what && !holder) holder = holdQueue();
    const now = (post as (...a: unknown[]) => boolean).call(repo, fn, committed, label);
    if (label === what) ran.push(now);
    return now;
  };
  return { ran, holder: () => holder, restore: () => { repo.post = post; holder?.release(); } };
}

// The human's hello replay (application.replay, which slack.ts attach calls after its hello commits) drains outside
// any body, so its posted writes wait for a held queue; a drain a commit's wake runs is the holder's and runs at once.
// Disabling and enabling alice re-attaches her human (#981).
async function reattach(root: string, hold: () => void): Promise<void> {
  expect((await api(root, "POST", "/api/admin/disable-user", { email: "alice@example.com" })).status).toBe(200);
  hold();
  expect((await api(root, "POST", "/api/admin/enable-user", { email: "alice@example.com" })).status).toBe(200);
}

// #981: a digest the Slack human is sent is acknowledged by a receipt through the write queue (#807 D4, slack.ts
// sink): the hello replay's drain, outside any body, marks the digest sent.
test("#807: a Slack digest the human's replay drains is marked sent", async () => {
  const [alice, , root] = await Promise.all(["alice", "bob", "root"].map((n) => login(`${n}@example.com`)));
  await link(alice);
  // Another user's agent: disabling alice also closes her own agents' connections.
  const fe = await hosted("bob@example.com", "fe");
  await fe.call("board_create", { name: "noise", purpose: "chatter" });
  const repo = srv.app.repo;
  const human = "alice@example.com/human";
  await seed(repo, tx => subscribe(repo.coreOn(tx), human, "noise", "digest"));
  // A digest-board post wakes nobody: the digest waits for the human's next drain.
  const chatter = await fe.call<BoardPostResult>("board_post", { board: "noise", body: "chatter" });
  const notified = () => (srv.app.db.prepare(`SELECT notified_id FROM subscriptions WHERE handle = ? AND board = 'noise'`).get(human) as { notified_id: number }).notified_id;
  expect(notified()).toBeLessThan(chatter.post_id);
  await reattach(root, () => {});
  await until(() => notified() === chatter.post_id, 5000, "the receipt marked the digest sent");
  expect(posted("chatter")).toBe(false);
}, 30_000);

// #807 P3 A7u1 audit: a commit's wake drains the human's pending digests from the write queue's holder, where an
// async post throws; the receipt is a queued write, so it lands after the holder and marks the digest sent.
test("#807: a Slack digest drained by a mention's wake, from the queue's holder, is marked sent", async () => {
  const alice = await login("alice@example.com");
  await link(alice);
  const be = await hosted("alice@example.com", "be");
  await be.call("board_create", { name: "noise", purpose: "chatter" });
  await be.call("board_create", { name: "desk", purpose: "questions" });
  const repo = srv.app.repo;
  const human = "alice@example.com/human";
  await seed(repo, tx => subscribe(repo.coreOn(tx), human, "noise", "digest"));
  const chatter = await be.call<BoardPostResult>("board_post", { board: "noise", body: "chatter" });
  const notified = () => (srv.app.db.prepare(`SELECT notified_id FROM subscriptions WHERE handle = ? AND board = 'noise'`).get(human) as { notified_id: number }).notified_id;
  expect(notified()).toBeLessThan(chatter.post_id);
  // A mention on another board wakes the human inside its commit: that drain carries the noise digest too.
  await be.call("board_post", { board: "desk", body: "@human a question" });
  await until(() => posted("a question"), 5000, "the mention reached Slack");
  await until(() => notified() === chatter.post_id, 5000, "the receipt marked the digest sent");
  expect(posted("chatter")).toBe(false);
}, 30_000);

// #981: a push the human can no longer see is acknowledged as drainBoards finds it (lostAck, application.ts), posted
// through the write queue (#807 D4): behind a held queue it waits, then stamps the outbox row.
test("#807: a push the Slack human can no longer see is acked through the write queue", async () => {
  const [alice, bob, root] = await Promise.all(["alice", "bob", "root"].map((n) => login(`${n}@example.com`)));
  await link(alice);
  const fe = await hosted("bob@example.com", "fe");
  expect((await api(bob, "POST", "/api/teams", { name: "ops" })).status).toBe(201);
  await fe.call("board_create", { name: "ops-room", purpose: "ops only", team: "ops" });
  const hidden = await fe.call<BoardPostResult>("board_post", { board: "ops-room", body: "not for alice" });
  // A push alice's human can't see (she isn't in ops), as an undelivered mention left from before she lost the board would be.
  const human = "alice@example.com/human";
  const db = srv.app.db;
  await seed(db, () => db.prepare(`INSERT INTO outbox (handle, post_id, reason) VALUES (?, ?, 'mention')`).run(human, hidden.post_id));
  const deliveredAt = () => (db.prepare(`SELECT delivered_at FROM outbox WHERE handle = ? AND post_id = ?`).get(human, hidden.post_id) as { delivered_at: number | null }).delivered_at;
  let hold: ReturnType<typeof holdAtPost> | undefined;
  try {
    await reattach(root, () => { hold = holdAtPost("lost-visibility push ack"); });
    await until(() => hold!.ran.length > 0, 5000, "the drain posted the lost-visibility ack");
    expect(hold!.ran).toEqual([false]);
    await hold!.holder()!.started;
    expect(deliveredAt()).toBeNull();
    hold!.holder()!.release();
    await hold!.holder()!.done;
    await until(() => deliveredAt() !== null, 5000, "the ack stamped the push delivered");
  } finally { hold?.restore(); }
  expect(posted("not for alice")).toBe(false);
}, 30_000);

// #807 D4: a delivered item's receipt and progress clear are one posted write: behind a held queue it waits, and
// reads the progress written before it.
test("#807: a Slack delivery receipt waits for the write queue, then stamps the message delivered", async () => {
  const alice = await login("alice@example.com");
  await link(alice);
  const be = await hosted("alice@example.com", "be");
  const repo = srv.app.repo;
  const { post } = repo;
  const receipts: boolean[] = [];
  repo.post = (fn, committed, what) => {
    const now = (post as (...a: unknown[]) => boolean).call(repo, fn, committed, what);
    if (what === "Slack receipt") receipts.push(now);
    return now;
  };
  let holder: ReturnType<typeof holdQueue> | undefined;
  // Held as Slack takes the post, so the progress write and the receipt both queue behind it.
  slack.onPost = (body) => { if (!holder && String(body.markdown_text).includes("receipt fixture")) holder = holdQueue(); };
  try {
    const sent = await be.call<SendResult>("dm_send", { to: "human", body: "receipt fixture" });
    await until(() => receipts.length > 0, 5000, "the relay posted the receipt");
    expect(receipts).toEqual([false]);
    const deliveredAt = () => (srv.app.db.prepare(`SELECT delivered_at FROM messages WHERE id = ?`).get(sent.message_id) as { delivered_at: number | null }).delivered_at;
    expect(deliveredAt()).toBeNull();
    holder!.release();
    await holder!.done;
    await until(() => deliveredAt() !== null, 5000, "the receipt stamped the message delivered");
  } finally { repo.post = post; slack.onPost = null; holder?.release(); }
});

// #1016: the relay's thread row is a posted write. A Slack reply that arrives while the row waits in the write queue
// reads it from the store's pending writes, so it reaches the agent rather than being refused as an unconnected thread.
test("#1016: a Slack reply in a thread whose row waits in the write queue reaches the agent", async () => {
  const alice = await login("alice@example.com");
  await link(alice);
  const be = await hosted("alice@example.com", "be");
  let holder: ReturnType<typeof holdQueue> | undefined;
  // Held as Slack takes the post, so the thread row queues behind it.
  slack.onPost = (body) => { if (!holder && String(body.markdown_text).includes("thread fixture")) holder = holdQueue(); };
  try {
    const q = await be.call<SendResult>("dm_send", { to: "human", body: "thread fixture" });
    const top = await until(() => slack.posts().find((p) => p.markdown_text?.includes("thread fixture") && slack.postTs.has(p)), 5000, "Slack answered the post");
    const userId = (await srv.app.repo.users.findByEmail(srv.app.repo.read, "alice@example.com"))!.id;
    expect(await srv.app.repo.slack.threadByTs(srv.app.repo.read, userId, tsOf(top))).toBeUndefined();
    // The reply's dm_send queues behind the hold too: a write the Slack bridge starts is the sign the relay read the
    // thread's row. Its bus call reaches repo.write before any await, so the bridge is on the stack.
    const repo = srv.app.repo, { write } = repo;
    let writes = 0;
    repo.write = ((...a: Parameters<typeof write>) => {
      if (new Error().stack?.includes("/src/server/slack.ts")) writes++;
      return write.apply(repo, a);
    }) as typeof write;
    const seen = slack.posts().length;
    try {
      slack.say("queued reply", { thread_ts: tsOf(top) });
      await until(() => writes > 0 || slack.posts().length > seen, 5000, "the relay took the reply");
    } finally { repo.write = write; }
    holder!.release();
    await holder!.done;
    const got = (await be.next(direct((m) => m.body === "queued reply"), 5000)).event.message;
    expect(got).toMatchObject({ sender: "alice@example.com/human", parent_id: q.message_id });
    expect(slack.posts().slice(seen).map((p) => p.markdown_text)).not.toContainEqual(expect.stringContaining("isn't connected"));
  } finally { slack.onPost = null; holder?.release(); }
});

test("#807: an unlink for one Slack account leaves a link that moved to another account while it waited", async () => {
  const alice = await login("alice@example.com");
  await link(alice);
  const userId = (await srv.app.repo.users.findByEmail(srv.app.repo.read, "alice@example.com"))!.id;
  expect(await srv.app.slack!.unlink(userId, "U0SOMEONEELSE")).toBe(false);
  expect(srv.app.repo.slack.linkFor(srv.app.repo.read, userId)).toMatchObject({ slack_user: ALICE_SLACK });
  expect(await srv.app.slack!.unlink(userId, ALICE_SLACK)).toBe(true);
});

test("#807: a rolled-back unlink leaves the link and its human online", async () => {
  const alice = await login("alice@example.com");
  await link(alice);
  const userId = (await srv.app.repo.users.findByEmail(srv.app.repo.read, "alice@example.com"))!.id;
  const be = await hosted("alice@example.com", "be");
  srv.app.db.run(`CREATE TRIGGER fail_unlink BEFORE INSERT ON access_log WHEN NEW.action = 'slack.unlinked' BEGIN SELECT RAISE(ABORT, 'audit refused'); END`);
  const spy = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect((await api(alice, "POST", "/api/slack/unlink")).status).not.toBe(200);
  } finally { spy.mockRestore(); }
  expect(srv.app.repo.slack.linkFor(srv.app.repo.read, userId)).toBeDefined();
  expect(await srv.app.repo.aliases.find(srv.app.repo.read, "alice@example.com/human")).toBeDefined();
  const sent = await be.call<SendResult>("dm_send", { to: "human", body: "still linked?" });
  expect(sent.delivered_now).toBe(true);
  await until(() => slack.posts().find((p) => p.markdown_text?.includes("still linked?")));
});

test("#807: a rolled-back link leaves no link, no human identity and nothing attached", async () => {
  const alice = await login("alice@example.com");
  const userId = (await srv.app.repo.users.findByEmail(srv.app.repo.read, "alice@example.com"))!.id;
  srv.app.db.run(`CREATE TRIGGER fail_link BEFORE INSERT ON access_log WHEN NEW.action = 'slack.linked' BEGIN SELECT RAISE(ABORT, 'audit refused'); END`);
  const spy = spyOn(console, "error").mockImplementation(() => {});
  try {
    const r = await api(alice, "POST", "/api/slack/link");
    slack.say(`link ${r.body.code}`);
    await until(() => spy.mock.calls.some((c) => c.map(String).join(" ").includes("audit refused")), 5000, "the link's failure was logged");
  } finally { spy.mockRestore(); }
  expect(srv.app.repo.slack.linkFor(srv.app.repo.read, userId)).toBeUndefined();
  expect(await srv.app.repo.aliases.find(srv.app.repo.read, "alice@example.com/human")).toBeUndefined();
  expect((await api(alice, "GET", "/api/whoami")).body.identities).not.toContain("human");
});

// #807 P1c-13: the link's human create and the unlink's remove run on their body's Tx.
test("#807 P1c-13: link and unlink read and write the human alias on their body's Tx", async () => {
  const repo = srv.app.repo;
  const checks: { op: string; inTxn: boolean; handle: "pool" | "tx" }[] = [];
  const spies = (["find", "create", "remove"] as const).map((name) => {
    const original = repo.aliases[name].bind(repo.aliases) as (...a: unknown[]) => unknown;
    return spyOn(repo.aliases, name).mockImplementation(((r: unknown, ...rest: unknown[]) => {
      if (new Error().stack?.includes("/slack.ts:")) checks.push({ op: name, inTxn: srv.app.db.inTransaction, handle: r === repo.read ? "pool" : "tx" });
      return original(r, ...rest);
    }) as never);
  });
  try {
    const alice = await login("alice@example.com");
    await link(alice);
    expect((await api(alice, "POST", "/api/slack/unlink")).status).toBe(200);
  } finally { for (const spy of spies) spy.mockRestore(); }
  expect(checks).toEqual([{ op: "find", inTxn: true, handle: "tx" }, { op: "create", inTxn: true, handle: "tx" }, { op: "remove", inTxn: true, handle: "tx" }]);
});

// #807 P1c-14b: the link's newest-message read (where the new human's cursor starts) and the Slack receipt's
// message read run on their body's Tx.
test("#807 P1c-14b: link and the Slack receipt read messages on their body's Tx", async () => {
  const repo = srv.app.repo;
  const checks: { op: string; inTxn: boolean; handle: "pool" | "tx" }[] = [];
  const spies = (["history", "getById"] as const).map((name) => {
    const original = repo.messages[name].bind(repo.messages) as (...a: unknown[]) => unknown;
    return spyOn(repo.messages, name).mockImplementation(((r: unknown, ...rest: unknown[]) => {
      if (new Error().stack?.includes("/slack.ts:")) checks.push({ op: name, inTxn: srv.app.db.inTransaction, handle: r === repo.read ? "pool" : "tx" });
      return original(r, ...rest);
    }) as never);
  });
  try {
    const alice = await login("alice@example.com");
    await link(alice);
    const be = await hosted("alice@example.com", "be");
    await be.call<SendResult>("dm_send", { to: "human", body: "receipt check" });
    await until(() => checks.some((c) => c.op === "getById"));
  } finally { for (const spy of spies) spy.mockRestore(); }
  expect(checks).toEqual([{ op: "history", inTxn: true, handle: "tx" }, { op: "getById", inTxn: true, handle: "tx" }]);
});

test("thread replies while unlinked don't flood in at relink", async () => {
  const alice = await login("alice@example.com");
  await link(alice);
  const be = await hosted("alice@example.com", "be");
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

test("relinking from another Slack account with the same email starts new threads there, and tells the old one", async () => {
  const alice = await login("alice@example.com");
  await link(alice);
  const be = await hosted("alice@example.com", "be");
  const q = await be.call<SendResult>("dm_send", { to: "human", body: "first" });
  await until(() => posted("first"));

  slack.emails.set("U0OTHER", "Alice@Example.com");
  const r = await api(alice, "POST", "/api/slack/link");
  slack.say(`link ${r.body.code}`, { user: "U0OTHER", channel: "D0OTHER" });
  await until(() => slack.posts().find((p) => p.channel === "D0OTHER" && p.markdown_text?.startsWith("Linked to")));
  // #805 F-05: a link never moves silently.
  expect(slack.posts().find((p) => p.channel === DM && p.markdown_text?.includes("now linked to another Slack account"))).toBeDefined();
  expect(accessAudits(srv.app.db, "slack.relinked").map((row) => [row.actor, row.target, row.detail])).toEqual([["alice@example.com", "U0OTHER", { from: ALICE_SLACK }]]);
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
  const fe = await hosted("bob@example.com", "fe");
  expect((await api(root, "POST", "/api/admin/disable-user", { email: "alice@example.com" })).status).toBe(200);
  expect(await fe.call("dm_send", { to: "alice@example.com/human", body: "while disabled" })).toMatchObject({ delivered_now: false });
  await Bun.sleep(500);
  expect(posted("while disabled")).toBe(false);
  expect((await api(root, "POST", "/api/admin/enable-user", { email: "alice@example.com" })).status).toBe(200);
  await until(() => posted("while disabled"));
}, 30_000);

// #533: a relink starts the new human past what queued for the old one, and
// that skipped mail is never stamped delivered_at: it never reached Slack.
test("a relink skips mail queued for the earlier link's human without stamping it delivered", async () => {
  const [alice, , root] = await Promise.all(["alice", "bob", "root"].map((n) => login(`${n}@example.com`)));
  await link(alice);
  await api(alice, "POST", "/api/teams", { name: "eng" });
  await api(alice, "POST", "/api/teams/eng/add", { email: "bob@example.com" });
  const fe = await hosted("bob@example.com", "fe");
  expect((await api(root, "POST", "/api/admin/disable-user", { email: "alice@example.com" })).status).toBe(200);
  const queued = await fe.call<SendResult>("dm_send", { to: "alice@example.com/human", body: "while disabled" });
  expect(queued.delivered_now).toBe(false);
  slack.say("unlink");
  await until(() => slack.posts().find((p) => p.markdown_text?.startsWith("Unlinked from")));
  expect((await api(root, "POST", "/api/admin/enable-user", { email: "alice@example.com" })).status).toBe(200);
  // Disabling revoked alice's CLI tokens (security audit F-14), so she signs in again.
  await link(await login("alice@example.com"));
  expect((await fe.call<SendResult>("dm_send", { to: "alice@example.com/human", body: "after relink" })).delivered_now).toBe(true);
  await until(() => posted("after relink"));
  expect(posted("while disabled")).toBe(false);
  const row = srv.app.db.prepare(`SELECT delivered_at FROM messages WHERE id = ?`).get(queued.message_id) as { delivered_at: number | null };
  expect(row.delivered_at).toBeNull();
}, 30_000);

// The notice the owner used to get on their next WSS hello is gone with it
// (#282): no hosted session carries it, so what stays is the durable record.
test("a bridge that fails at boot records its death for its linked users, via the durable links", async () => {
  const alice = await login("alice@example.com");
  await link(alice);
  // A fresh bridge against a dead Slack URL throws at auth.test before any
  // link is attached: exactly the boot-time failure app.ts makes fatal. The
  // notify loop must run over the durable links, whose map is not empty.
  const { SlackBridge } = await import("../../src/server/slack.ts");
  const boot = new SlackBridge({
    repo: srv.app.repo, application: srv.app.application,
    appToken: "xapp-1-t", botToken: "xoxb-t", apiUrl: "http://127.0.0.1:1/api/",
  });
  await boot.start().catch((e) => boot.stop({ fatal: true, detail: `not started: ${(e as Error).message}` }));
  // stop()'s posted write awaits the links read (#807 P3 A6b), so it commits after stop() returns: a write queued
  // behind it runs once it has.
  await srv.app.repo.write(() => {});

  const row = await srv.app.repo.audit.last(srv.app.repo.read, "bridge.stopped", "alice@example.com/human");
  expect(row).toBeDefined();
  expect(JSON.parse(row!.detail!)).toMatchObject({ reason: expect.stringMatching(/not started/) });
});

test("a deliberate bridge teardown stays silent (no audit row)", async () => {
  const alice = await login("alice@example.com");
  await link(alice);
  srv.app.slack!.stop();
  expect(await srv.app.repo.audit.last(srv.app.repo.read, "bridge.stopped", "alice@example.com/human")).toBeUndefined();
});

test("a bridge that failed to start issues no codes", async () => {
  const down = serve("http://127.0.0.1:1/api/");
  try {
    await down.app.slackReady;
    const r = await down.api(await down.login("alice@example.com"), "POST", "/api/slack/link");
    expect(r.status).toBe(404);
    expect(r.body.message).toMatch(/isn't running/);
  } finally {
    await down.stop();
  }
}, 30_000);

test("a fatal stop with no linked users writes nothing user-facing", async () => {
  const down = serve("http://127.0.0.1:1/api/");
  try {
    await down.app.slackReady;
    // The start failure is fatal, but with zero linked users there is nobody
    // to tell and no user-facing row to write: the notify loop never runs.
    // Its posted write commits after stop() returns (#807 P3 A6b): a write queued behind it runs once it has.
    await down.app.repo.write(() => {});
    const rows = down.app.db.prepare("SELECT COUNT(*) AS n FROM access_log WHERE action = 'bridge.stopped'").get() as { n: number };
    expect(rows.n).toBe(0);
  } finally {
    await down.stop();
  }
}, 30_000);

// A session's facts say so; a hosted session's instructions, built from the
// same fact, drop the human sentence.
test("a session's human.linked is false while the bridge is down", async () => {
  const alice = await login("alice@example.com");
  await link(alice);
  srv.app.slack!.stop({ fatal: true, detail: "recheck" });
  const hello = await srv.appSession(alice, "be").connect();
  expect(hello.human?.linked).toBe(false);
  expect(await (await hosted("alice@example.com", "fe")).instructionsNow()).not.toContain('dm_send(to="human")');
});

test("a fatal bridge stop tells the owner on their next bind, once", async () => {
  const alice = await login("alice@example.com");
  await link(alice);
  srv.app.slack!.stop({ fatal: true, detail: "Socket Mode was disabled for this Slack app (link_disabled)" });
  await until(async () => !!(await srv.app.repo.audit.last(srv.app.repo.read, "bridge.stopped", "alice@example.com/human")));

  const hello = await srv.appSession(alice, "be").connect();
  const bridgeNotices = (hello.bind?.notices ?? []).filter((n) => n.includes("your Slack bridge stopped"));
  expect(bridgeNotices).toHaveLength(1);
  expect(bridgeNotices[0]).toContain("your Slack bridge stopped at ");
  expect(bridgeNotices[0]).toContain("link_disabled");
});

test("a hosted bind carries the owed bridge notice in its answer, once", async () => {
  const alice = await login("alice@example.com");
  await link(alice);
  srv.app.slack!.stop({ fatal: true, detail: "Socket Mode was disabled for this Slack app (link_disabled)" });
  await until(async () => !!(await srv.app.repo.audit.last(srv.app.repo.read, "bridge.stopped", "alice@example.com/human")));

  const first = await hosted("alice@example.com", null);
  const answer = JSON.stringify(await first.bind("be"));
  expect(answer).toContain("your Slack bridge stopped at ");
  expect(answer).toContain("link_disabled");
  // The row that marks it delivered is the one the answer carried.
  expect(JSON.stringify(await (await hosted("alice@example.com", null)).bind("fe"))).not.toContain("your Slack bridge stopped");
});

test("the bridge notice comes before the claims notice, so a cut takes the claims", async () => {
  const alice = await login("alice@example.com");
  await link(alice);
  const { claim } = await import("../../src/core/claims.ts");
  await seed(srv.app.repo, () => claim(srv.app.db, "alice@example.com/sim", "ticket:ENG-142"));
  srv.app.slack!.stop({ fatal: true, detail: "first fatal" });
  const notices = (await srv.appSession(alice, "be").connect()).bind?.notices ?? [];
  const bridge = notices.findIndex((n) => n.includes("your Slack bridge stopped"));
  const claims = notices.findIndex((n) => n.includes("ticket:ENG-142"));
  expect(bridge).toBeGreaterThanOrEqual(0);
  expect(claims).toBe(notices.length - 1);
  expect(bridge).toBeLessThan(claims);
});

test("a second fatal within the dedup window records the death but doesn't re-notify", async () => {
  const alice = await login("alice@example.com");
  await link(alice);
  srv.app.slack!.stop({ fatal: true, detail: "first fatal" });
  const first = await srv.appSession(alice, "be").connect();
  expect((first.bind?.notices ?? []).filter((n) => n.includes("your Slack bridge stopped"))).toHaveLength(1);

  // A second bridge instance (the server-restart analog) re-attaches the same
  // user and dies fatally again inside the dedup window: the death records,
  // the notice doesn't repeat.
  const { SlackBridge } = await import("../../src/server/slack.ts");
  const second = new SlackBridge({
    repo: srv.app.repo, application: srv.app.application,
    appToken: "xapp-1-t", botToken: "xoxb-t", apiUrl: slack.api,
  });
  await second.start();
  second.stop({ fatal: true, detail: "second fatal" });

  const hello = await srv.appSession(alice, "fe").connect();
  const againNotices = (hello.bind?.notices ?? []).filter((n) => n.includes("your Slack bridge stopped"));
  expect(againNotices).toHaveLength(0);
  const count = srv.app.db.prepare("SELECT COUNT(*) AS n FROM access_log WHERE action = 'bridge.stopped' AND target = 'alice@example.com/human'").get() as { n: number };
  expect(count.n).toBe(2);
});

// #385 item 23: an attach that fails undoes only its own attempt. Here a second attach for the
// same user went live while the first was still waiting on attachHuman; the first's failure
// must not tear the live one down.
test("an attach that fails after a newer one for the same user went live leaves that one online", async () => {
  const alice = await login("alice@example.com");
  await link(alice);
  const bridge = srv.app.slack!, application = srv.app.application;
  const id = (await seed(srv.app.repo, tx => srv.app.repo.users.upsertByEmail(tx, "alice@example.com", null))).id;
  let fail: ((e: Error) => void) | undefined;
  const attach = spyOn(application, "attachHuman").mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
  try {
    const first = bridge.userChanged(id);
    // attach reads the user first (#807 P3 A7u2), so attachHuman is reached after that await.
    await until(() => fail, 5000, "the first attach reached attachHuman");
    await bridge.userChanged(id);
    fail!(new Error("raced"));
    await first;
  } finally { attach.mockRestore(); }
  const be = await hosted("alice@example.com", "be");
  const q = await be.call<SendResult>("dm_send", { to: "human", body: "still there?" });
  expect(q.delivered_now).toBe(true);
  await until(() => slack.posts().find((p) => p.markdown_text?.includes("still there?")));
}, 30_000);

// #805 F-05: a link code proves the CLI's token, not who sends it. Only the
// Slack account whose email is the user's may redeem it; a stolen code sent
// from another account is refused, used up, and leaves the link as it was.
test("a link code redeemed from a Slack account with another email is refused and used up", async () => {
  const alice = await login("alice@example.com");
  await link(alice);
  slack.emails.set("U0MALLORY", "mallory@example.com");
  const r = await api(alice, "POST", "/api/slack/link");
  const seen = slack.posts().length;
  slack.say(`link ${r.body.code}`, { user: "U0MALLORY", channel: "D0MALLORY" });
  await until(() => slack.posts().slice(seen).find((p) => p.channel === "D0MALLORY" && p.markdown_text?.includes("email isn't `alice@example.com`")));
  expect(srv.app.repo.slack.linkFor(srv.app.repo.read, (await srv.app.repo.users.findByEmail(srv.app.repo.read, "alice@example.com"))!.id)).toMatchObject({ slack_user: ALICE_SLACK, dm_channel: DM });
  expect(accessAudits(srv.app.db, "slack.link_refused").map((row) => [row.actor, row.target, row.detail])).toEqual([["alice@example.com", "U0MALLORY", { reason: "email_mismatch" }]]);

  // Used up: the right account can't redeem it after the refusal.
  slack.emails.set("U0MALLORY", "alice@example.com");
  const again = slack.posts().length;
  slack.say(`link ${r.body.code}`, { user: "U0MALLORY", channel: "D0MALLORY" });
  await until(() => slack.posts().slice(again).find((p) => p.markdown_text?.includes("isn't valid or has expired")));
}, 30_000);

test("without the email scope, a link is refused with what the admin must add", async () => {
  const alice = await login("alice@example.com");
  slack.emailScope = false;
  const r = await api(alice, "POST", "/api/slack/link");
  slack.say(`link ${r.body.code}`);
  await until(() => slack.posts().find((p) => p.markdown_text?.includes("users:read.email")));
  expect(srv.app.repo.slack.linkFor(srv.app.repo.read, (await srv.app.repo.users.findByEmail(srv.app.repo.read, "alice@example.com"))!.id)).toBeUndefined();
  expect(accessAudits(srv.app.db, "slack.link_refused").map((row) => row.detail)).toEqual([{ reason: "no_email" }]);
}, 30_000);

// An unreachable Slack isn't a missing scope: the user is told to retry, not
// to ask the admin, and the refusal is audited.
test("when Slack can't be reached to check the email, the link is refused with a retry", async () => {
  const alice = await login("alice@example.com");
  slack.usersInfoDown = true;
  const r = await api(alice, "POST", "/api/slack/link");
  slack.say(`link ${r.body.code}`);
  const reply = await until(() => slack.posts().find((p) => p.markdown_text?.includes("couldn't reach Slack")));
  expect(reply.markdown_text).not.toContain("users:read.email");
  expect(srv.app.repo.slack.linkFor(srv.app.repo.read, (await srv.app.repo.users.findByEmail(srv.app.repo.read, "alice@example.com"))!.id)).toBeUndefined();
  expect(accessAudits(srv.app.db, "slack.link_refused").map((row) => row.detail)).toEqual([{ reason: "slack_unavailable" }]);
}, 30_000);

// #856: a Slack DM to another user's agent that no grant lets this person wake (#806) says so in its thread; one
// to the person's own agent doesn't. The relay handles Slack events in order (Relay.inbound), so once the second
// DM's note is in Slack the first DM's handling is done.
test("a Slack DM to another user's agent says it won't wake it; one to your own agent doesn't", async () => {
  const alice = await login("alice@example.com");
  await login("bob@example.com");
  await link(alice);
  const be = await hosted("alice@example.com", "be");
  const fe = await hosted("bob@example.com", "fe");
  const inThread = (ts: string) => slack.posts().filter((p) => p.thread_ts === ts);

  const mine = slack.say("@be hi my agent");
  await be.next(direct((m) => m.body === "hi my agent"), 5000);
  const theirs = slack.say("@bob@example.com/fe hi bob's agent");
  await fe.next(direct((m) => m.body === "hi bob's agent"), 5000);
  const note = await until(() => inThread(theirs.ts).find((p) => p.markdown_text?.includes("Delivered as mail")), 5000, "the wake note reached Slack");
  expect(note.markdown_text).toContain("bob@example.com's agent won't act on it until its user does");
  expect(slack.reactions().map((r) => r.timestamp)).toEqual([mine.ts, theirs.ts]);
  expect(inThread(mine.ts)).toEqual([]);

  // A reply in the mapped thread gets the note too; with fe ended (its person alias stays), after the queued line.
  await fe.end();
  slack.say("still there?", { thread_ts: theirs.ts });
  await until(() => inThread(theirs.ts).length === 3, 5000, "the reply's two lines reached Slack");
  const [queued, again] = inThread(theirs.ts).slice(1).map((p) => p.markdown_text);
  expect(queued).toStartWith("queued: bob@example.com/fe is offline");
  expect(again).toBe(note.markdown_text);
});

// #1062: the RelayStore's overlay of pending writes (#1016), driven at the store. The thread() overlay and the advance
// projection sit on the outbound reply path, whose root lookup is itself a queued read, so FIFO commits the posted row
// first today: they guard a Repo whose reads leave the queue, and no end-to-end path reaches them yet.
// Relay.store is private: read through a cast.
const attached = (userId: number) => {
  const relay = (srv.app.slack as unknown as { linked: Map<number, { relay: Relay }> }).linked.get(userId)!.relay;
  return { relay, store: (relay as unknown as { store: RelayStore }).store };
};

async function linkedAlice(): Promise<{ userId: number; relay: Relay; store: RelayStore }> {
  await link(await login("alice@example.com"));
  const userId = (await srv.app.repo.users.findByEmail(srv.app.repo.read, "alice@example.com"))!.id;
  return { userId, ...attached(userId) };
}

test("#1062: a thread row and its advance, waiting in the write queue, read back as they will commit", async () => {
  const { userId, store } = await linkedAlice();
  const repo = srv.app.repo;
  const committed = () => repo.slack.thread(repo.read, userId, "dm", null, 41);
  const holder = holdQueue();
  try {
    await store.addThread({ thread_ts: "1700000000.000100", kind: "dm", board: null, root_id: 41, peer: "alice@example.com/be", last_id: 41 });
    expect(await committed()).toBeUndefined();
    // A second item in the just-opened thread finds the row, so it posts threaded.
    expect(await store.thread("dm", null, 41)).toMatchObject({ thread_ts: "1700000000.000100", peer: "alice@example.com/be", last_id: 41 });
    // A newer item moves last_id and the peer; an older one moves neither.
    await store.advance("1700000000.000100", 45, "alice@example.com/fe");
    await store.advance("1700000000.000100", 43, "alice@example.com/sim");
    const want = { thread_ts: "1700000000.000100", kind: "dm" as const, board: null, root_id: 41, peer: "alice@example.com/fe", last_id: 45 };
    expect(await store.thread("dm", null, 41)).toEqual(want);
    expect(await store.byTs("1700000000.000100")).toEqual(want);
    expect(await committed()).toBeUndefined();
    holder.release();
    await holder.done;
    await until(async () => (await committed())?.last_id === 45, 5000, "the thread row and its advances committed");
    expect(await committed()).toEqual(want);
    expect(await store.thread("dm", null, 41)).toEqual(want);
  } finally { holder.release(); }
});

// #807 P3 A6b: two advances that start together, the thread row in the overlay, each build on the other's row: one
// that read its row before the await would post a projection from 41, so the older item's would win (43, sim).
test("#807: two advances resolving together never regress the overlay's last_id or peer", async () => {
  const { userId, store } = await linkedAlice();
  const repo = srv.app.repo;
  const ts = "1700000000.000200";
  const want = { thread_ts: ts, kind: "dm" as const, board: null, root_id: 51, peer: "alice@example.com/fe", last_id: 55 };
  const holder = holdQueue();
  try {
    await store.addThread({ thread_ts: ts, kind: "dm", board: null, root_id: 51, peer: "alice@example.com/be", last_id: 51 });
    await Promise.all([store.advance(ts, 55, "alice@example.com/fe"), store.advance(ts, 53, "alice@example.com/sim")]);
    expect(await store.byTs(ts)).toEqual(want);
  } finally { holder.release(); }
  await holder.done;
  await until(async () => (await repo.slack.threadByTs(repo.read, userId, ts))?.last_id === 55, 5000, "the row and its advances committed");
  // The committed read delayed: both advances await it, and the second to resolve reads the first's overlay row.
  const original = repo.slack.threadByTs.bind(repo.slack);
  const slow = spyOn(repo.slack, "threadByTs").mockImplementation(async (h, u, t) => { const row = await original(h, u, t); await ticks(3); return row; });
  const later = holdQueue();
  try {
    await Promise.all([store.advance(ts, 59, "alice@example.com/sim"), store.advance(ts, 57, "alice@example.com/be")]);
    expect(await store.byTs(ts)).toEqual({ ...want, peer: "alice@example.com/sim", last_id: 59 });
  } finally { later.release(); slow.mockRestore(); }
});

test("#1062: queued progress reads back as saved, and the receipt drops it", async () => {
  const { userId, store } = await linkedAlice();
  const repo = srv.app.repo;
  const meta = { board: "e2e", post_id: "990001", from: "alice@example.com/be" };
  const committed = () => repo.slack.progress(repo.read, userId, "post:990001");
  const holder = holdQueue();
  try {
    const id = store.enqueue({ content: "progress fixture", meta });
    const progress: Record<string, unknown> = { posted: true, error: null };
    store.setProgress(id, progress);
    // The relay keeps mutating its object after a save; the queued value is the one saved.
    progress.told = true;
    expect(store.progress(id)).toEqual({ posted: true, error: null });
    // And a reader's copy is its own.
    (store.progress(id) as Record<string, unknown>).posted = false;
    expect(store.progress(id)).toEqual({ posted: true, error: null });
    expect(await committed()).toBeUndefined();
    store.done(id, null);
    expect(store.pending()).toEqual([]);
    // The same item enqueued again before the receipt commits still reads the progress, so it isn't posted twice.
    const again = store.enqueue({ content: "progress fixture", meta });
    expect(store.progress(again)).toEqual({ posted: true, error: null });
    holder.release();
    await holder.done;
    // The progress write's commit dropped the overlay; the receipt's cleared the row.
    await until(async () => (await store.progress(again)) === undefined, 5000, "the queued progress committed and was cleared");
    expect(await committed()).toBeUndefined();
  } finally { holder.release(); }
});

// End to end: a drain that fails after Slack took the post leaves the item in the outbox, and the next drain reads its
// queued { posted: true } rather than posting it again.
test("#1062: a redelivery while the item's progress waits in the write queue doesn't post it twice", async () => {
  const { userId, relay, store } = await linkedAlice();
  const be = await hosted("alice@example.com", "be");
  const { done } = store;
  let failed = false;
  store.done = (id, error) => {
    if (!failed) { failed = true; throw new Error("receipt fixture failure"); }
    done(id, error);
  };
  let holder: ReturnType<typeof holdQueue> | undefined;
  // Held as Slack takes the post, so the progress write queues behind it.
  slack.onPost = (body) => { if (!holder && String(body.markdown_text).includes("redelivery fixture")) holder = holdQueue(); };
  const count = () => slack.posts().filter((p) => p.markdown_text?.includes("redelivery fixture")).length;
  try {
    const sent = await be.call<SendResult>("dm_send", { to: "human", body: "redelivery fixture" });
    await until(() => failed, 5000, "the first drain reached the receipt");
    expect(store.pending()).toHaveLength(1);
    // The redelivery must read the queued progress, not a committed row.
    expect(holder).toBeDefined();
    expect(await srv.app.repo.slack.progress(srv.app.repo.read, userId, `dm:${sent.message_id}`)).toBeUndefined();
    // A drain() while the failed one is still unwinding would only set its again flag.
    await until(() => !(relay as unknown as { draining: boolean }).draining, 5000, "the failed drain ended");
    await relay.drain();
    expect(store.pending()).toEqual([]);
    expect(count()).toBe(1);
  } finally { store.done = done; slack.onPost = null; holder?.release(); await holder?.done; }
});

// A progress write that failed leaves its overlay entry (the relay did what it records); the receipt's commit drops it.
test("#1062: the receipt drops the overlay of a progress write that failed", async () => {
  const { userId, store } = await linkedAlice();
  srv.app.db.run(`CREATE TRIGGER fail_progress BEFORE INSERT ON slack_progress BEGIN SELECT RAISE(ABORT, 'progress refused'); END`);
  const meta = { board: "e2e", post_id: "990002", from: "alice@example.com/be" };
  const errors = spyOn(console, "error");
  const holder = holdQueue();
  try {
    const id = store.enqueue({ content: "failed progress fixture", meta });
    store.setProgress(id, { posted: true, error: null });
    store.done(id, null);
    holder.release();
    await holder.done;
    // The progress write failed, so only the receipt's commit can drop its overlay.
    const again = store.enqueue({ content: "failed progress fixture", meta });
    await until(() => errors.mock.calls.some((c) => String(c[0]).includes("Slack progress failed")), 5000, "the progress write failed");
    expect(await srv.app.repo.slack.progress(srv.app.repo.read, userId, "post:990002")).toBeUndefined();
    await until(async () => (await store.progress(again)) === undefined, 5000, "the receipt dropped the failed write's overlay");
  } finally { holder.release(); errors.mockRestore(); }
});

// #848: the Slack human archives and reopens with "archive #board"/"reopen #board", but only a board its own user's
// agent created: on a server the human override doesn't cross users.
test("the Slack human archives and reopens its own user's boards, not another user's", async () => {
  const alice = await login("alice@example.com");
  await login("bob@example.com");
  await link(alice);
  const be = await hosted("alice@example.com", "be");
  const fe = await hosted("bob@example.com", "fe");
  await be.call("board_create", { name: "mine", purpose: "alice's" });
  await fe.call("board_create", { name: "theirs", purpose: "bob's" });
  const listed = async () => (await be.call<{ name: string }[]>("board_list")).map((b) => b.name);
  const reply = (ts: string) => until(() => slack.posts().find((p) => p.thread_ts === ts), 5000, "the reply reached Slack");
  const reacted = (ts: string) => until(() => slack.reactions().some((r) => r.timestamp === ts), 5000, "the reaction reached Slack");

  const refused = slack.say("archive #theirs");
  expect((await reply(refused.ts)).markdown_text).toBe("⚠️ not archived: only #theirs's creator (bob@example.com/fe) or its user (bob@example.com, from Slack: archive #theirs / reopen #theirs) can archive or reopen it");
  expect(await listed()).toContain("theirs");

  await reacted(slack.say("archive #mine").ts);
  expect(await listed()).not.toContain("mine");
  const again = slack.say("ARCHIVE #mine");
  expect((await reply(again.ts)).markdown_text).toStartWith("#mine was already archived at ");
  await reacted(slack.say("reopen #mine").ts);
  expect(await listed()).toContain("mine");
  const missing = slack.say("archive #nope");
  expect((await reply(missing.ts)).markdown_text).toStartWith("⚠️ not archived: no board #nope");
});

// #807 P3 A6b: the socket calls the bridge in arrival order without awaiting it, and the relay's queue keeps that
// order only if each event reaches it with no await first. The store's link lookup, made slow for the first event,
// must not let the second overtake it.
test("#807: Slack events reach the relay in arrival order, however slow the store's link lookup", async () => {
  await link(await login("alice@example.com"));
  const be = await hosted("alice@example.com", "be");
  const repo = srv.app.repo;
  const original = repo.slack.linkBySlackUser.bind(repo.slack);
  let first = true;
  const slow = spyOn(repo.slack, "linkBySlackUser").mockImplementation(async (h, u) => {
    if (first) { first = false; await new Promise((r) => setTimeout(r, 100)); }
    return original(h, u);
  });
  try {
    slack.say("@be one");
    slack.say("@be two");
    await be.next(direct((m) => m.body === "one"), 5000);
    await be.next(direct((m) => m.body === "two"), 5000);
  } finally { slow.mockRestore(); }
  const rows = srv.app.db.query("SELECT body FROM messages WHERE body IN ('one', 'two') ORDER BY id").all() as { body: string }[];
  expect(rows.map((r) => r.body)).toEqual(["one", "two"]);
});
