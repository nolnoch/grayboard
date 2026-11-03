// Board, peer, claim, DM and attachment semantics over hosted MCP sessions
// (#282): an in-process server with dev auth, and sessions of two or three
// users through a built-in client's OAuth grant, delivering through the
// lease's inbox. Covers the distributed board semantics in
// docs/architecture.md §4–5. Moved from ws.test.ts; hub mechanics are in
// hub.test.ts, routes in http_routes.test.ts.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ReadResult, WhoResult } from "../../src/core/boards.ts";
import type { BoardPostResult } from "../../src/core/tools.ts";
import type { DirectMessage, HistoryMessage, InboxResult, SendResult } from "../../src/server/application.ts";
import type { Config } from "../../src/server/config.ts";
import { ATTACHMENT_LIMITS_CAPABILITY } from "../../src/shared/attachments.ts";
import type { Pending } from "../../src/shared/notifications.ts";
import { board, direct } from "../support/events.ts";
import { HostedToolError } from "../support/hosted_session.ts";
import { TestServer } from "../support/server.ts";

const A = "alice@example.com";
const B = "bob@example.com";
const C = "carol@example.com";

// Inbox polling spends hosted requests.
const start = (overrides: Partial<Config> = {}) => new TestServer({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 }, ...overrides });
let srv: TestServer;

// A test that needs other config replaces the server.
const restart = async (overrides: Partial<Config> = {}) => {
  await srv.stop();
  srv = start(overrides);
};

beforeEach(() => {
  srv = start();
});

afterEach(() => srv.stop());

const login = (email: string) => srv.login(email);
const api = (token: string, method: string, path: string, body?: unknown) => srv.api(token, method, path, body);
const upload = (token: string, identity: string, filename: string, data: Uint8Array | string) => srv.upload(token, identity, filename, data);
const postOf = (item: Pending) => {
  if (item.kind !== "push") throw new Error(`expected a push, got a ${item.kind}`);
  return item.post;
};

test("team board: members see it and get pushes; non-members can't see or be mentioned", async () => {
  const alice = await login(A);
  const bob = await login(B);
  await login(C);
  await api(bob, "POST", "/api/identities", { name: "fe" });
  expect((await api(alice, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
  await api(alice, "POST", "/api/teams/eng/add", { email: C });

  const a = await srv.hosted(A, "be");
  const b = await srv.hosted(B, "fe");
  const c = await srv.hosted(C, "sim");

  const posted = await a.call<BoardPostResult>("board_post", { board: "eng", body: "@sim @bob/fe secret plan" });
  expect(posted.unresolved).toEqual(["bob/fe"]);

  const pushed = await c.next(board());
  expect(pushed.event.item).toMatchObject({
    kind: "push",
    reason: "mention",
    post: { board: "eng", author: `${A}/be`, body: "@sim @bob/fe secret plan" },
  });
  await b.none(board());

  expect((await b.call<{ name: string }[]>("board_list")).map((x) => x.name)).toEqual([]);
  await expect(b.call("board_read", { board: "eng" })).rejects.toMatchObject({ message: "no such board #eng; see board_list" });
  expect(await c.call("board_list")).toMatchObject([{ name: "eng", scope: "team:eng", mode: "digest" }]);
});

test("who: live sessions are online; a closed one is offline with last_seen; team board scopes it", async () => {
  const alice = await login(A);
  await login(B);
  await api(alice, "POST", "/api/teams", { name: "eng" });
  await api(alice, "POST", "/api/teams/eng/add", { email: B });

  await srv.hosted(A, "be");
  // A hosted name's last_seen is its session's last request, so it's bounded by the session's life.
  const before = Date.now();
  const a2 = await srv.hosted(A, "be-stream");
  const b = await srv.hosted(B, "fe");
  const c = await srv.hosted(C, "sim");

  const online = await c.call<WhoResult>("peer_list");
  expect(online.you).toBe(`${C}/sim`);
  expect(online.peers.map((p) => p.handle)).toEqual([`${A}/be`, `${A}/be-stream`, `${B}/fe`, `${C}/sim`]);

  await a2.close();
  const closed = Date.now();
  const after = await c.call<WhoResult>("peer_list");
  expect(after.offline_hidden).toBe(1);
  const all = await c.call<WhoResult>("peer_list", { include_offline: true });
  const gone = all.peers.find((p) => p.handle === `${A}/be-stream`)!;
  expect(gone.online).toBe(false);
  expect(gone.last_seen).toBeGreaterThanOrEqual(before);
  expect(gone.last_seen).toBeLessThanOrEqual(closed);

  const team = await b.call<WhoResult>("peer_list", { board: "eng", include_offline: true });
  expect(team.peers.map((p) => [p.handle, p.online])).toEqual([
    [`${A}/be`, true],
    [`${A}/be-stream`, false],
    [`${B}/fe`, true],
  ]);
  await expect(c.call("peer_list", { board: "eng" })).rejects.toMatchObject({ message: "no such board #eng; see board_list" });
});

test("leaving a team drops its board and pending pushes", async () => {
  const alice = await login(A);
  const carol = await login(C);
  await api(alice, "POST", "/api/teams", { name: "eng" });
  await api(alice, "POST", "/api/teams/eng/add", { email: C });
  const a = await srv.hosted(A, "be");
  // carol is offline when mentioned, then leaves before connecting.
  await api(carol, "POST", "/api/identities", { name: "sim" });
  await a.call("board_post", { board: "eng", body: `@${C}/sim are you there` });
  await api(carol, "POST", "/api/teams/eng/leave");

  const c = await srv.hosted(C, "sim");
  await c.none(board());
  expect(await c.call("board_list")).toEqual([]);
});

test("removing a member drops their board and pending pushes", async () => {
  const alice = await login(A);
  const carol = await login(C);
  await api(alice, "POST", "/api/teams", { name: "eng" });
  await api(alice, "POST", "/api/teams/eng/add", { email: C });
  const a = await srv.hosted(A, "be");
  await api(carol, "POST", "/api/identities", { name: "sim" });
  await a.call("board_post", { board: "eng", body: `@${C}/sim are you there` });
  expect((await api(alice, "POST", "/api/teams/eng/remove", { email: C })).status).toBe(200);

  const c = await srv.hosted(C, "sim");
  await c.none(board());
  expect(await c.call("board_list")).toEqual([]);
  expect((await api(carol, "GET", "/api/teams/eng/members")).status).toBe(404);
});

test("org boards are open to everyone; bare @name prefers the author's own identity", async () => {
  const a = await srv.hosted(A, "be");
  const as = await srv.hosted(A, "sim");
  const bs = await srv.hosted(B, "sim");

  await a.call("board_create", { name: "general", purpose: "Everyone" });
  await a.call("board_post", { board: "general", body: "@sim run the fixtures" });
  expect((await as.next(board())).event.item).toMatchObject({ reason: "mention" });
  await bs.none(board());

  const r = await bs.call<ReadResult>("board_read", { board: "general" });
  expect(r.posts).toHaveLength(1);
  await expect(bs.call("board_create", { name: "x", purpose: "y", team: "eng" })).rejects.toMatchObject({ message: 'no such team "eng"' });
});

test("claims are org-wide and atomic across users", async () => {
  const a = await srv.hosted(A, "be");
  const b = await srv.hosted(B, "be");
  expect((await a.call<{ ok: boolean }>("claim_take", { key: "ticket:ENG-1", note: "on it" })).ok).toBe(true);
  expect(await b.call("claim_take", { key: "ticket:ENG-1" })).toMatchObject({
    ok: false,
    held_by: `${A}/be`,
    note: "on it",
  });
  expect((await b.call<{ key: string }[]>("claim_list")).map((c) => c.key)).toEqual(["ticket:ENG-1"]);
});

test("direct messages still deliver live", async () => {
  const a = await srv.hosted(A, "be");
  const b = await srv.hosted(B, "fe");
  expect(await a.call("dm_send", { to: `${B}/fe`, body: "hi" })).toMatchObject({ delivered_now: true });
  expect((await b.next(direct())).event.message.body).toBe("hi");
});

// The hosted half of ws.test.ts's handler test: a receipt (the lease's ack)
// whose write fails inside is refused as internal, and the session goes on.
test("a receipt that fails inside answers an internal error and keeps the session", async () => {
  const be = await srv.hosted(A, "be");
  const fe = await srv.hosted(A, "fe", { receipt: "manual" });
  await be.call("dm_send", { to: "fe", body: "hi" });
  const item = await fe.next(direct());
  // A read-point table gone from under the live server makes the receipt's cursor write fail.
  srv.app.db.exec(`ALTER TABLE mailbox_cursors RENAME TO mailbox_cursors_gone`);
  await expect(fe.receipt([item.id])).rejects.toMatchObject({ code: "internal_error" });
  await fe.call("board_list");
});

test("a bare DM recipient is your own identity of that name, else the only one with it", async () => {
  const a = await srv.hosted(A, "be");
  const a2 = await srv.hosted(A, "be-stream");
  await srv.hosted(B, "be-stream");
  await srv.hosted(B, "fe");
  const c = await srv.hosted(C, "fe");

  // alice and bob both have be-stream: alice's bare name means her own.
  await a.call("dm_send", { to: "be-stream", body: "mine" });
  expect((await a2.next(direct())).event.message.body).toBe("mine");
  // carol has no be: the only be is alice's.
  await c.call("dm_send", { to: "be", body: "only one" });
  expect((await a.next(direct())).event.message.body).toBe("only one");
  // alice has no fe, and bob and carol each have one: ambiguous.
  await expect(a.call("dm_send", { to: "fe", body: "?" })).rejects.toMatchObject({
    message: `several identities are named "fe": ${B}/fe, ${C}/fe; peer_list shows exact handles`,
  });
  await expect(a.call("dm_send", { to: "nobody", body: "?" })).rejects.toMatchObject({
    message: `no identity is named "nobody"; peer_list shows exact handles`,
  });
});

test("dm_history: peer resolves like dm_send's recipient, oldest first, limit clamped; empty bodies refused", async () => {
  const a = await srv.hosted(A, "be");
  await srv.hosted(B, "fe");
  for (const body of ["one", "two", "three"]) await a.call("dm_send", { to: "fe", body });
  await expect(a.call("dm_send", { to: "fe", body: "  " })).rejects.toMatchObject({ message: "body is required" });

  const bodies = async (peer: string, limit?: number) =>
    (await a.call<HistoryMessage[]>("dm_history", { peer, ...(limit !== undefined ? { limit } : {}) })).map((m) => m.body);
  expect(await bodies("fe")).toEqual(["one", "two", "three"]);
  expect(await bodies("Bob@Example.com/FE")).toEqual(["one", "two", "three"]);
  expect(await bodies("fe", 2)).toEqual(["two", "three"]);
  expect(await bodies("fe", 0)).toEqual(["three"]);
  await expect(a.call("dm_history", { peer: "nobody" })).rejects.toMatchObject({
    message: `no identity is named "nobody"; peer_list shows exact handles`,
  });
});

test("senders see what hasn't reached an offline peer", async () => {
  const b = await srv.hosted(B, "fe");
  await b.close();
  const a = await srv.hosted(A, "be");
  await a.call("dm_send", { to: `${B}/fe`, body: "one" });
  const sent = await a.call("dm_send", { to: `${B}/fe`, body: "two" });
  expect(sent).toMatchObject({ delivered_now: false, recipient_last_seen: expect.stringMatching(/ago$/), undelivered_from_you: 2 });
  const delivered = async () =>
    (await a.call<HistoryMessage[]>("dm_history", { peer: `${B}/fe` })).map((m) => m.delivered);
  expect(await delivered()).toEqual([false, false]);

  // The lease's receipt is the ack: it moves the read point.
  const b2 = await srv.hosted(B, "fe", { receipt: "manual" });
  const items = [await b2.next(direct()), await b2.next(direct())];
  await b2.receipt(items.map((i) => i.id));
  expect(await delivered()).toEqual([true, true]);
});

test("dm_retract withdraws a queued message; one the recipient is holding or has acked stays", async () => {
  const b = await srv.hosted(B, "fe");
  await b.close();
  const a = await srv.hosted(A, "be");
  const fresh = await a.call<SendResult>("dm_send", { to: `${B}/fe`, body: "fresh" });
  expect(fresh.note).toMatch(/^Recipient offline/);
  srv.app.db.prepare("UPDATE aliases SET last_seen = ? WHERE address = ?").run(Date.now() - 22 * 3_600_000, `${B}/fe`);
  const wrong = await a.call<SendResult>("dm_send", { to: `${B}/fe`, body: "wrong" });
  expect(wrong.note).toMatch(/^Queued: bob@example.com\/fe last seen 22h ago\. .*dm_retract/);

  const other = await srv.hosted(B, "sim");
  await expect(other.call("dm_retract", { message_id: wrong.message_id })).rejects.toMatchObject({
    message: `no message ${wrong.message_id} from you`,
  });
  await a.call("dm_retract", { message_id: wrong.message_id });
  expect((await a.call<HistoryMessage[]>("dm_history", { peer: `${B}/fe` })).map((m) => m.body)).toEqual(["fresh"]);

  // Delivered but not receipted: the cursor hasn't moved, but bob is live.
  const b2 = await srv.hosted(B, "fe", { receipt: "manual" });
  expect((await b2.next(direct())).event.message.body).toBe("fresh");
  await b2.none(direct());
  await expect(a.call("dm_retract", { message_id: fresh.message_id })).rejects.toMatchObject({ message: expect.stringContaining("already reached") });
});

test("dm_inbox: replied and acked messages drop out; only the recipient can ack", async () => {
  const a = await srv.hosted(A, "be");
  const b = await srv.hosted(B, "fe");
  const q = await b.call<SendResult>("dm_send", { to: `${A}/be`, body: "question?" });
  const fyi = await b.call<SendResult>("dm_send", { to: `${A}/be`, body: "FYI" });
  const inbox = async () => (await a.call<InboxResult>("dm_inbox")).unanswered.map((m) => m.id);
  expect(await inbox()).toEqual([q.message_id, fyi.message_id]);

  await a.call("dm_send", { to: `${B}/fe`, body: "answer", parent_id: q.message_id });
  await expect(b.call("dm_ack", { message_id: fyi.message_id })).rejects.toMatchObject({
    message: `no message ${fyi.message_id} to you or pending from you; dm_inbox lists them`,
  });
  await a.call("dm_ack", { message_id: fyi.message_id });
  expect(await inbox()).toEqual([]);
});

test("a pending send is echoed, listed as promised until the sender's next message, and ackable by the sender", async () => {
  const a = await srv.hosted(A, "be");
  const b = await srv.hosted(B, "fe");
  const p = await a.call<SendResult>("dm_send", { to: `${B}/fe`, body: "results by noon", pending: true });
  expect(p).toMatchObject({ pending: true });
  const plain = await a.call<SendResult>("dm_send", { to: `${B}/fe`, body: "fyi" });
  expect(plain.pending).toBeUndefined();
  const promises = async () => (await a.call<InboxResult>("dm_inbox", { days: 1 })).promised?.map((m) => m.id);
  expect(await promises()).toEqual([p.message_id]);
  // History is oldest first; only the pending row says so.
  expect((await a.call<HistoryMessage[]>("dm_history", { peer: `${B}/fe` })).map((m) => m.pending)).toEqual([true, undefined]);

  // Bob's reply doesn't keep it, and his ack (as its recipient) doesn't drop it.
  await b.call("dm_send", { to: `${A}/be`, body: "thanks", parent_id: p.message_id });
  await b.call("dm_ack", { message_id: p.message_id });
  expect(await promises()).toEqual([p.message_id]);
  await a.call("dm_send", { to: `${B}/fe`, body: "done", parent_id: p.message_id });
  expect(await promises()).toBeUndefined();

  const p2 = await a.call<SendResult>("dm_send", { to: `${B}/fe`, body: "later", pending: true });
  await expect(a.call("dm_ack", { message_id: plain.message_id })).rejects.toMatchObject({
    message: `no message ${plain.message_id} to you or pending from you; dm_inbox lists them`,
  });
  await a.call("dm_ack", { message_id: p2.message_id });
  expect(await promises()).toBeUndefined();
});

test("only a message's sender and recipient can read its thread or reply to it", async () => {
  const a = await srv.hosted(A, "be");
  const b = await srv.hosted(B, "fe");
  const c = await srv.hosted(C, "sim");
  const root = await a.call<SendResult>("dm_send", { to: `${B}/fe`, body: "private" });
  const reply = await b.call<SendResult>("dm_send", { to: `${A}/be`, body: "re", parent_id: root.message_id });
  expect((await b.call<DirectMessage[]>("dm_thread", { thread: root.message_id })).map((m) => m.id)).toEqual([
    root.message_id,
    reply.message_id,
  ]);
  await expect(c.call("dm_thread", { thread: reply.message_id })).rejects.toMatchObject({
    message: `message ${reply.message_id} not found`,
  });
  await expect(c.call("dm_send", { to: `${A}/be`, body: "x", parent_id: root.message_id })).rejects.toMatchObject({
    message: `parent_id ${root.message_id} is not a message you sent or received`,
  });
  await expect(a.call("dm_send", { to: `${B}/fe`, body: "x", parent_id: 99999 })).rejects.toBeInstanceOf(HostedToolError);
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);

const download = (token: string, identity: string, id: number) =>
  fetch(`${srv.base}/api/attachments/${id}?as=${identity}`, { headers: { Authorization: `Bearer ${token}` } });

const audits = (action: string) =>
  (srv.app.db.prepare(`SELECT actor, target, detail FROM access_log WHERE action = ? ORDER BY at`).all(action) as { actor: string; target: string; detail: string }[]);

test("attachments on a DM: uploaded as your identity, bound by the send, pushed and read, fetched by its two parties", async () => {
  const alice = await login(A);
  const bob = await login(B);
  const carol = await login(C);
  const a = await srv.hosted(A, "be");
  const b = await srv.hosted(B, "fe");
  const c = await srv.hosted(C, "sim");

  // An unknown identity is refused as `grayboard claim` refuses one.
  expect(await upload(alice, "nope", "x.png", PNG)).toMatchObject({ status: 404, body: { code: "unknown_identity" } });
  expect((await upload(alice, "human", "x.png", PNG)).status).toBe(403);
  expect((await upload(alice, "be", "x.bin", new Uint8Array([0, 1, 2]))).body.message).toMatch(/not an image/);
  expect((await upload(alice, "be", "x.txt", new Uint8Array(0))).body.message).toBe("file x.txt: empty file");
  // The upload runs the checks an agent's path gets: names, key material, an extension matching the type.
  expect((await upload(alice, "be", ".env", "A=1")).body.message).toMatch(/dotfiles/);
  expect((await upload(alice, "be", "id_rsa", "x")).body.message).toMatch(/key or credentials/);
  expect((await upload(alice, "be", "n.txt", "-----BEGIN RSA PRIVATE KEY-----")).body.message).toMatch(/key material/);

  const up = await upload(alice, "be", "../shot.png", PNG);
  expect(up.status).toBe(201);
  expect(up.body).toEqual({ id: expect.any(Number), filename: "shot.png", type: "image/png", size: PNG.length, sha256: expect.any(String) });
  const info = { id: up.body.id, filename: "shot.png", type: "image/png", size: PNG.length, sha256: up.body.sha256 };
  expect(audits("attachment.uploaded")).toEqual([
    { actor: A, target: `attachment:${up.body.id}`, detail: expect.stringContaining(`"identity":"${A}/be"`) },
  ]);

  // Only the uploader's identity can send it.
  await expect(c.call("dm_send", { to: `${B}/fe`, body: "mine now", attachment_ids: [up.body.id] })).rejects.toMatchObject({
    message: `attachment ${up.body.id} isn't an unsent upload of yours`,
  });
  const sent = await a.call<SendResult>("dm_send", { to: `${B}/fe`, body: "see shot", attachment_ids: [up.body.id] });
  expect(sent).toMatchObject({ delivered_now: true, attachments: [info] });
  expect((await b.next(direct())).event.message).toMatchObject({ body: "see shot", attachments: [info] });
  // Once bound, it can't ride a second message.
  await expect(a.call("dm_send", { to: `${B}/fe`, body: "again", attachment_ids: [up.body.id] })).rejects.toBeInstanceOf(HostedToolError);

  expect((await b.call<DirectMessage[]>("dm_thread", { thread: sent.message_id }))[0]!.attachments).toEqual([info]);
  expect((await b.call<HistoryMessage[]>("dm_history", { peer: `${A}/be` }))[0]!.attachments).toEqual([info]);
  expect((await b.call<InboxResult>("dm_inbox")).unanswered[0]!.attachments).toEqual([info]);

  const got = await download(bob, "fe", up.body.id);
  expect(got.status).toBe(200);
  expect(got.headers.get("content-type")).toBe("image/png");
  expect(got.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''shot.png");
  expect(got.headers.get("repr-digest")).toBe(`sha-256=:${createHash("sha256").update(PNG).digest("base64")}:`);
  expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG);
  expect((await download(alice, "be", up.body.id)).status).toBe(200);
  // Not a party: reads as missing, and is logged.
  const refused = await download(carol, "sim", up.body.id);
  expect(refused.status).toBe(404);
  expect(await refused.json()).toMatchObject({ message: `no attachment ${up.body.id} on a message or post you can read` });
  expect(audits("attachment.download_refused")).toMatchObject([{ actor: C, target: `attachment:${up.body.id}` }]);
  expect(audits("attachment.downloaded").map((r) => r.actor)).toEqual([B, A]);
});

test("attachments: a failed blob read or write is audited; a swept blob is a 404, a fault a bare 500", async () => {
  const { blobDir } = srv.config;
  const alice = await login(A);
  const bob = await login(B);
  const a = await srv.hosted(A, "be");
  await srv.hosted(B, "fe");

  const up = await upload(alice, "be", "shot.png", PNG);
  await a.call("dm_send", { to: `${B}/fe`, body: "see shot", attachment_ids: [up.body.id] });
  // Swept between the read check and the read.
  rmSync(join(blobDir, up.body.sha256.slice(0, 2), up.body.sha256));
  const gone = await download(bob, "fe", up.body.id);
  expect(gone.status).toBe(404);
  expect(await gone.json()).toEqual({ code: "not_found", message: `attachment ${up.body.id}'s bytes are gone` });
  expect(audits("attachment.download_failed")).toMatchObject([{ actor: B, target: `attachment:${up.body.id}`, detail: expect.stringContaining("are missing") }]);
  expect(audits("attachment.downloaded")).toEqual([]);

  // An unwritable blob directory: the client hears nothing of the path or errno.
  chmodSync(join(blobDir, "tmp"), 0o500);
  try {
    const failed = await upload(alice, "be", "other.png", new Uint8Array([...PNG, 1]));
    expect(failed).toEqual({ status: 500, body: { code: "internal", message: "internal error" } });
  } finally {
    chmodSync(join(blobDir, "tmp"), 0o700);
  }
  expect(audits("attachment.upload_failed")).toMatchObject([{ actor: A, target: null, detail: expect.stringMatching(/"filename":"other.png".*EACCES/) }]);
});

test("attachments on a team board post follow the board; a retracted DM takes its files; uploads are capped", async () => {
  const alice = await login(A);
  const bob = await login(B);
  const carol = await login(C);
  await api(alice, "POST", "/api/teams", { name: "eng" });
  await api(alice, "POST", "/api/teams/eng/add", { email: C });
  await api(bob, "POST", "/api/identities", { name: "fe" });
  const a = await srv.hosted(A, "be");
  const c = await srv.hosted(C, "sim");

  const up = await upload(alice, "be", "plan.md", "# plan");
  expect(up.body.type).toBe("text/markdown");
  // A client can't name paths for the server to read: the hosted board_post
  // has no attachments field (attachment_ids only), and refuses one.
  await expect(a.call("board_post", { board: "eng", body: "x", attachments: ["/etc/hosts"] })).rejects.toMatchObject({ message: "Input validation error: Invalid arguments for tool board_post: data must NOT have additional properties" });
  const posted = await a.call<BoardPostResult>("board_post", { board: "eng", body: "@sim plan attached", attachment_ids: [up.body.id] });
  const info = { id: up.body.id, filename: "plan.md", type: "text/markdown", size: 6, sha256: up.body.sha256 };
  expect(posted.attachments).toEqual([info]);
  expect(postOf((await c.next(board())).event.item).attachments).toEqual([info]);
  expect((await download(carol, "sim", up.body.id)).status).toBe(200);
  expect((await download(bob, "fe", up.body.id)).status).toBe(404);

  // bob/fe is offline, so the DM stays retractable.
  const note = await upload(alice, "be", "note.txt", "retract me");
  const queued = await a.call<SendResult>("dm_send", { to: `${B}/fe`, body: "oops", attachment_ids: [note.body.id] });
  expect(queued.delivered_now).toBe(false);
  await a.call("dm_retract", { message_id: queued.message_id });
  expect((await download(alice, "be", note.body.id)).status).toBe(404);
  expect(srv.app.db.prepare(`SELECT COUNT(*) AS n FROM attachment_blobs WHERE sha256 = ?`).get(note.body.sha256)).toEqual({ n: 0 });

  const big = new Uint8Array(10 * 1024 * 1024).fill(0x61);
  expect((await upload(alice, "be", "big.txt", new Uint8Array(big.length + 1).fill(0x61))).status).toBe(413);
  // 50MB of unsent uploads per user, across their identities.
  for (let i = 0; i < 5; i++) {
    big[0] = 0x62 + i;
    expect((await upload(alice, "be", `big${i}.txt`, big)).status).toBe(201);
  }
  const over = await upload(alice, "be", "one-more.txt", "x");
  expect(over.status).toBe(413);
  expect(over.body.message).toMatch(/unsent uploads would exceed 50MB/);
  expect((await upload(carol, "sim", "theirs.txt", "x")).status).toBe(201);
});

test("a server's own attachment limits: sent at initialize, enforced per file, per message and on unsent uploads", async () => {
  await restart({ attachmentLimits: { file: 100, total: 150 } });
  const alice = await login(A);
  const a = await srv.hosted(A, "be");
  expect(a.native.client.getServerCapabilities()?.experimental?.[ATTACHMENT_LIMITS_CAPABILITY]).toEqual({ file: 100, total: 150 });

  expect((await upload(alice, "be", "big.txt", "x".repeat(101))).body.message).toBe("file big.txt: 101B exceeds the 100B limit per file");
  expect((await upload(alice, "be", "page.html", "<script>")).body.filename).toBe("page.html.txt");
  const one = await upload(alice, "be", "a.txt", "a".repeat(80));
  const two = await upload(alice, "be", "b.txt", "b".repeat(80));
  await expect(a.call("dm_send", { to: "be", body: "both", attachment_ids: [one.body.id, two.body.id] })).rejects.toMatchObject({
    message: "attachments exceed 150B in all",
  });
  // Unsent uploads are capped at twice the per-message total.
  await upload(alice, "be", "c.txt", "c".repeat(80));
  expect((await upload(alice, "be", "d.txt", "d".repeat(80))).body.message).toMatch(/unsent uploads would exceed 300B/);
});

test("a user's stored attachments are capped, sent or not; an upload needs a length; refusals are audited", async () => {
  await restart({ attachmentLimits: { file: 100, total: 150 }, attachmentUserQuota: 200 });
  const alice = await login(A);
  const a = await srv.hosted(A, "be");
  for (const n of ["a", "b"]) {
    const up = await upload(alice, "be", `${n}.txt`, n.repeat(90));
    await a.call("dm_send", { to: "be", body: n, attachment_ids: [up.body.id] });
  }
  const over = await upload(alice, "be", "c.txt", "c".repeat(30));
  expect(over).toMatchObject({ status: 413, body: { message: "your stored attachments would exceed 200B; they're freed as their messages and posts age out" } });
  expect((await upload(alice, "be", "d.txt", "d".repeat(20))).status).toBe(201);

  // A streamed body declares no length.
  const streamed = await fetch(`${srv.base}/api/attachments?as=be&filename=e.txt`, {
    method: "POST",
    headers: { Authorization: `Bearer ${alice}` },
    body: new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode("e")), c.close()) }),
  });
  expect(streamed.status).toBe(411);

  expect(audits("attachment.upload_refused").map((r) => ({ actor: r.actor, ...JSON.parse(r.detail) }))).toEqual([
    { actor: A, identity: `${A}/be`, filename: "c.txt", size: 30, reason: over.body.message },
  ]);
});
