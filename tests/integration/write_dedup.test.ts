// Append-write dedup and state-derived repeats (#254): a write whose answer
// was lost, called again, returns the first result instead of landing twice.
// Dedup is the application's (dedupWrite in src/server/application.ts). The
// lost-answer window itself (committed, not yet answered or delivered) is
// forced on a hosted MCP session against the server as its own process, so
// the write:after-commit pause blocks only the server: the caller is gone
// when delivery and the answer run. The rest drive it in process through
// AppSession, where a lost answer is a write whose result the caller never
// read, and the retry is the same call again from the same session.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mintSessionKey } from "../../src/core/bindings.ts";
import { WRITE_DEDUP_WINDOW_MS } from "../../src/shared/dedup.ts";
import type { SendResult } from "../../src/server/application.ts";
import { openDatabase } from "../../src/server/db.ts";
import { issueOAuth } from "../helpers/oauth.ts";
import { call, closeSessions, localSession } from "../support/mcp.ts";
import { localEnv } from "../support/env.ts";
import { runCli } from "../support/cli.ts";
import type { AppSession } from "../support/app_session.ts";
import { board, direct } from "../support/events.ts";
import { HOSTED_CLIENT, HOSTED_SCOPES, HostedSession } from "../support/hosted_session.ts";
import { ROOT } from "../support/paths.ts";
import { ServerProcess, TestServer } from "../support/server.ts";
import { until } from "../support/until.ts";

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
// A replay's marker; absent on a write that landed.
type Replayed = { replayed?: { ref: { kind: string; id: number }; first_at: string }; note?: string };

describe("a lost answer, then the same call from the same session", () => {
  let srv: TestServer;
  let alice: string;
  let bob: string;
  const n = (sql: string, ...args: (string | number)[]) => (srv.app.db.prepare(sql).get(...args) as { n: number }).n;

  beforeAll(async () => {
    srv = new TestServer();
    alice = await srv.login("alice@example.com");
    bob = await srv.login("bob@example.com");
  });
  afterAll(() => srv.stop());

  // The first call commits and its answer is lost: the session drops it
  // and closes. The same session (its key) comes back tools-only and makes
  // the same call.
  async function lostThenRepeated<T>(identity: string, write: (s: AppSession) => Promise<T>): Promise<{ again: AppSession; retry: T }> {
    const key = mintSessionKey();
    const first = srv.appSession(alice, identity, { push: false, key });
    await first.connect();
    await write(first);
    first.close();
    const again = srv.appSession(alice, identity, { push: false, key });
    await again.connect();
    expect(again.id).toBe(first.id);
    return { again, retry: await write(again) };
  }

  // The events `s` has once `sentinel`, sent after the repeat, has landed.
  async function pushedBefore(s: AppSession, sentinel: () => Promise<unknown>, body: string) {
    await sentinel();
    await s.next(direct((m) => m.body === body), 5000);
    return s.events;
  }

  test("dm_send: one row, the repeat answered as replayed, one push, one request.replayed", async () => {
    const fe = srv.appSession(bob, "fe");
    await fe.connect();
    const { again, retry } = await lostThenRepeated("be", (s) => s.send("bob@example.com/fe", "lost answer dm"));
    const rows = srv.app.db.prepare("SELECT id FROM messages WHERE body = 'lost answer dm'").all() as { id: number }[];
    expect(rows.length).toBe(1);
    const id = rows[0]!.id;
    const r = retry as SendResult & Replayed;
    expect(r.replayed!.first_at).toMatch(ISO);
    expect(r).toMatchObject({ message_id: id, delivered_now: true, replayed: { ref: { kind: "message", id } } });
    expect(r.note).toBe(`already sent to bob@example.com/fe at ${r.replayed!.first_at} as message ${id}; this repeat was not sent. To send it again on purpose, call with resend: true.`);
    const replays = srv.app.db.prepare("SELECT actor, target, detail FROM access_log WHERE action = 'request.replayed'").all() as { actor: string; target: string; detail: string }[];
    expect(replays.length).toBe(1);
    expect(replays[0]).toMatchObject({ actor: "alice@example.com", target: "alice@example.com/be" });
    expect(JSON.parse(replays[0]!.detail)).toMatchObject({ tool: "dm_send", ref_kind: "message", ref_id: id, transport: "hosted", first_at: r.replayed!.first_at });
    const events = await pushedBefore(fe, () => again.send("bob@example.com/fe", "sentinel 1"), "sentinel 1");
    expect(events.filter(direct((m) => m.id === id)).length).toBe(1);
  });

  test("board_post on a queue board: one post, one queue claim, one delivery", async () => {
    const lane = srv.appSession(bob, "lane");
    await lane.connect();
    await lane.call("board_create", { name: "work", purpose: "a queue", kind: "queue" });
    const { again, retry } = await lostThenRepeated("poster", (s) => s.call<{ post_id: number; board: string; note: string } & Replayed>("board_post", { board: "#Work", body: "process next batch" }));
    const posts = srv.app.db.prepare("SELECT id FROM posts WHERE body = 'process next batch'").all() as { id: number }[];
    expect(posts.length).toBe(1);
    const id = posts[0]!.id;
    expect(retry).toMatchObject({ post_id: id, board: "work", replayed: { ref: { kind: "post", id } } });
    expect(retry.note).toStartWith(`already posted to #work at ${retry.replayed!.first_at} as post ${id}; this repeat was not posted.`);
    expect(srv.app.db.prepare("SELECT holder FROM claims WHERE key LIKE 'queue:work:%'").all()).toEqual([{ holder: "bob@example.com/lane" }]);
    expect(srv.app.db.prepare("SELECT event FROM claim_events WHERE key = ?").all(`queue:work:${id}`)).toEqual([{ event: "take" }]);
    const events = await pushedBefore(lane, () => again.send("bob@example.com/lane", "sentinel 2"), "sentinel 2");
    expect(events.filter(board((i) => i.kind === "push" && i.post.id === id)).length).toBe(1);
  });

  test("delegate: one pending DM, one delegation.requested, one launcher push", async () => {
    const lx = srv.appSession(alice, "lx", { launcher: true });
    await lx.connect();
    const { again, retry } = await lostThenRepeated("asker", (s) => s.delegate({ persona: "a researcher", task: "survey the options", to: "lx" }));
    const rows = srv.app.db.prepare("SELECT id, pending FROM messages WHERE recipient = 'alice@example.com/lx' AND sender = 'alice@example.com/asker'").all() as { id: number; pending: number }[];
    expect(rows).toEqual([{ id: expect.any(Number), pending: 1 }]);
    const id = rows[0]!.id;
    const r = retry as typeof retry & Replayed;
    expect(r).toMatchObject({ message_id: id, to: "alice@example.com/lx", pending: true, replayed: { ref: { kind: "message", id } } });
    expect(r.note).toStartWith(`already delegated to alice@example.com/lx at ${r.replayed!.first_at} as message ${id}; this repeat was not sent.`);
    expect(n("SELECT COUNT(*) AS n FROM access_log WHERE action = 'delegation.requested' AND target = 'alice@example.com/lx'")).toBe(1);
    expect(n("SELECT COUNT(*) AS n FROM access_log WHERE action = 'request.replayed'")).toBe(3);
    const events = await pushedBefore(lx, () => again.send("lx", "sentinel 3"), "sentinel 3");
    expect(events.filter(direct((m) => m.id === id)).length).toBe(1);
  });
});

describe("a lost answer over hosted MCP, then the same call (server process)", () => {
  const PAUSE = "write:after-commit";
  let dir: string;
  let srv: ServerProcess;
  let alice: string;
  let bob: string;
  const go = () => join(dir, "go");
  const db = () => new Database(join(dir, "bus.db"), { readonly: true });
  const hits = (what: "hit" | "released") => srv.log().split(`test pause ${what}: ${PAUSE}`).length - 1;
  const sessions: HostedSession[] = [];
  const session = async (token: string, identity: string, opts: { sessionId?: string; delivery?: boolean } = {}) => {
    const s = new HostedSession(`${srv.base}/mcp`, token, identity, opts);
    sessions.push(s);
    await s.connect();
    return s;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "gb-dedup-"));
    srv = await ServerProcess.start([process.execPath, join(ROOT, "src/server/main.ts")], join(dir, "bus.db"), {
      BUS_TEST_PAUSE: PAUSE, BUS_TEST_PAUSE_FILE: go(),
      // Inbox polling spends hosted requests.
      GRAYBOARD_HOSTED_REQUEST_BURST: "10000", GRAYBOARD_HOSTED_REQUEST_PER_SEC: "10000",
    });
    // Grants written through the server's database beside the running
    // process (WAL), as a finished hosted login leaves them. ServerProcess's
    // public URL is http://localhost, so its OAuth resource is http://localhost/mcp.
    const store = openDatabase(join(dir, "bus.db"), { blobDir: join(dir, "blobs") });
    try {
      const token = (email: string) => issueOAuth(store.repo, "http://localhost/mcp", email, HOSTED_SCOPES, Date.now(), HOSTED_CLIENT).token;
      alice = token("alice@example.com");
      bob = token("bob@example.com");
    } finally {
      store.db.close();
    }
  });
  afterAll(async () => {
    writeFileSync(go(), "");
    await Promise.allSettled(sessions.splice(0).map((s) => s.close()));
    await srv.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  // The first call commits and pauses before its answer and its delivery;
  // its client drops (the request aborted, both wires closed); the pause
  // releases, so delivery runs and the answer goes nowhere; the same raw
  // session comes back and makes the same call. No lease on either side,
  // so the caller holds nothing a re-attach must wait out.
  // `hints`: the recipient's wake-up count, none while the pause holds.
  async function lostThenRepeated<T>(identity: string, tool: string, args: Record<string, unknown>, hints: () => number): Promise<{ again: HostedSession; retry: T }> {
    rmSync(go(), { force: true });
    const first = await session(alice, identity, { delivery: false });
    const before = hits("hit");
    const lost = first.callRaw(tool, args).then(() => "answered", () => "lost");
    await until(() => hits("hit") > before, 10_000, "the pause after the commit");
    await first.drop();
    expect(await lost).toBe("lost");
    expect(hints()).toBe(0);
    const released = hits("released");
    writeFileSync(go(), "");
    await until(() => hits("released") > released, 10_000, "the pause's release");
    // The paused call's delivery, run after its caller dropped.
    await until(() => hints() > 0, 5000, "the recipient's wake-up");
    const again = await session(alice, identity, { sessionId: first.sessionId, delivery: false });
    return { again, retry: await again.call<T>(tool, args) };
  }

  test("dm_send: one row, the repeat answered as replayed, delivered once, one request.replayed", async () => {
    const fe = await session(bob, "fe");
    const watch = await fe.watch();
    const { retry } = await lostThenRepeated<SendResult & Replayed>("be", "dm_send", { to: "bob@example.com/fe", body: "lost answer dm" }, watch.hints);
    await watch.close();
    const d = db();
    try {
      const rows = d.prepare("SELECT id FROM messages WHERE body = 'lost answer dm'").all() as { id: number }[];
      expect(rows.length).toBe(1);
      const id = rows[0]!.id;
      expect(retry.replayed!.first_at).toMatch(ISO);
      expect(retry).toMatchObject({ message_id: id, delivered_now: true, replayed: { ref: { kind: "message", id } } });
      expect(retry.note).toBe(`already sent to bob@example.com/fe at ${retry.replayed!.first_at} as message ${id}; this repeat was not sent. To send it again on purpose, call with resend: true.`);
      const replays = d.prepare("SELECT actor, target, detail FROM access_log WHERE action = 'request.replayed'").all() as { actor: string; target: string; detail: string }[];
      expect(replays.length).toBe(1);
      expect(replays[0]).toMatchObject({ actor: "alice@example.com", target: "alice@example.com/be" });
      expect(JSON.parse(replays[0]!.detail)).toMatchObject({ tool: "dm_send", ref_kind: "message", ref_id: id, transport: "hosted", first_at: retry.replayed!.first_at });
      // The inbox is the message rows, so one row is one delivery.
      expect((await fe.next(direct((m) => m.id === id), 5000)).event.message.sender).toBe("alice@example.com/be");
    } finally {
      d.close();
    }
  }, 30_000);

  test("board_post on a queue board: one post, one queue claim, one delivery", async () => {
    const lane = await session(bob, "lane");
    await lane.call("board_create", { name: "work", purpose: "a queue", kind: "queue" });
    const watch = await lane.watch();
    const { retry } = await lostThenRepeated<{ post_id: number; board: string; note: string } & Replayed>("poster", "board_post", { board: "#Work", body: "process next batch" }, watch.hints);
    await watch.close();
    const d = db();
    try {
      const posts = d.prepare("SELECT id FROM posts WHERE body = 'process next batch'").all() as { id: number }[];
      expect(posts.length).toBe(1);
      const id = posts[0]!.id;
      expect(retry).toMatchObject({ post_id: id, board: "work", replayed: { ref: { kind: "post", id } } });
      expect(retry.note).toStartWith(`already posted to #work at ${retry.replayed!.first_at} as post ${id}; this repeat was not posted.`);
      expect(d.prepare("SELECT holder FROM claims WHERE key LIKE 'queue:work:%'").all()).toEqual([{ holder: "bob@example.com/lane" }]);
      expect(d.prepare("SELECT event FROM claim_events WHERE key = ?").all(`queue:work:${id}`)).toEqual([{ event: "take" }]);
      await lane.next(board((i) => i.kind === "push" && i.post.id === id), 5000);
    } finally {
      d.close();
    }
  }, 30_000);
});

describe("dedup and state answers (in process)", () => {
  let srv: TestServer;
  let clock: number;
  let you: string;
  beforeEach(async () => {
    clock = Date.now();
    srv = new TestServer({}, { now: () => clock });
    you = await srv.login("you@example.com");
  });
  afterEach(() => srv.stop());

  const q = (sql: string, ...args: (string | number)[]) => srv.app.db.prepare(sql).all(...args);
  const n = (sql: string, ...args: (string | number)[]) => (srv.app.db.prepare(sql).get(...args) as { n: number }).n;
  // A session of `identity`'s: one key, so a reconnect with it is the same session.
  const session = async (identity: string, opts: { push?: boolean; key?: string } = {}) => {
    const s = srv.appSession(you, identity, { key: opts.key ?? mintSessionKey(), ...(opts.push === false ? { push: false } : {}) });
    await s.connect();
    return s;
  };
  // An identity that exists and is offline, so its messages stay queued.
  const offline = async (identity: string) => (await session(identity)).close();
  type Sent = SendResult & Replayed & { attachments?: { id: number; sha256: string }[] };
  const dm = (s: AppSession, body: string, extra: Parameters<AppSession["send"]>[2] = {}) => s.send("you@example.com/fe", body, extra) as Promise<Sent>;

  test("resend: true writes a second row and a request.resent row", async () => {
    await offline("fe");
    const be = await session("be");
    const first = await dm(be, "ok");
    const forced = await dm(be, "ok", { resend: true });
    expect(forced.replayed).toBeUndefined();
    expect(forced.message_id).not.toBe(first.message_id);
    expect(n("SELECT COUNT(*) AS n FROM messages WHERE body = 'ok'")).toBe(2);
    const resent = q("SELECT detail FROM access_log WHERE action = 'request.resent'") as { detail: string }[];
    expect(resent.map((r) => JSON.parse(r.detail))).toEqual([{ tool: "dm_send", fp: expect.stringMatching(/^[0-9a-f]{64}$/), ref_kind: "message", ref_id: forced.message_id, session: expect.any(String) }]);
    // A later plain repeat replays the forced one.
    expect((await dm(be, "ok")).replayed!.ref.id).toBe(forced.message_id);
  });

  test("hosted dm_send: following the replay note's resend: true writes a second row (#460)", async () => {
    await offline("fe");
    const be = await srv.hosted("you@example.com", "be");
    const send = (extra: Record<string, unknown> = {}) => be.call<Sent>("dm_send", { to: "fe", body: "hosted ok", ...extra });
    const first = await send();
    const replay = await send();
    expect(replay.note).toEndWith("To send it again on purpose, call with resend: true.");
    const forced = await send({ resend: true });
    expect(forced.replayed).toBeUndefined();
    expect(forced.message_id).not.toBe(first.message_id);
    expect(n("SELECT COUNT(*) AS n FROM messages WHERE body = 'hosted ok'")).toBe(2);
    const resent = q("SELECT detail FROM access_log WHERE action = 'request.resent'") as { detail: string }[];
    expect(resent.map((r) => JSON.parse(r.detail))).toEqual([expect.objectContaining({ tool: "dm_send", ref_kind: "message", ref_id: forced.message_id })]);
  });

  test("a repeat after the original was retracted sends anew; dm_retract repeats answer from its audit row", async () => {
    await offline("fe");
    const be = await session("be");
    const first = await dm(be, "oops");
    expect(await be.retract(first.message_id)).toEqual({});
    const row = q("SELECT at, actor, target, detail FROM access_log WHERE action = 'message.retracted'") as { at: number; actor: string; target: string; detail: string }[];
    expect(row.length).toBe(1);
    expect(row[0]).toMatchObject({ actor: "you@example.com", target: `message:${first.message_id}` });
    expect(JSON.parse(row[0]!.detail)).toEqual({ message_id: first.message_id, sender: "you@example.com/be", recipient: "you@example.com/fe", session: be.id });
    expect(await be.retract(first.message_id)).toMatchObject({ note: `already retracted by you at ${new Date(row[0]!.at).toISOString()}` });
    // Another sender's repeat is still refused.
    const sim = await session("sim");
    await expect(sim.retract(first.message_id)).rejects.toMatchObject({ code: "not_found" });
    const again = await dm(be, "oops");
    expect(again.replayed).toBeUndefined();
    expect(again.message_id).not.toBe(first.message_id);
    const stale = q("SELECT detail FROM access_log WHERE action = 'request.receipt_stale'") as { detail: string }[];
    expect(stale.map((r) => JSON.parse(r.detail))).toEqual([expect.objectContaining({ tool: "dm_send", ref_kind: "message", ref_id: first.message_id, session: be.id })]);
  });

  test("resolved spellings and re-uploaded files collide; other files and another session don't", async () => {
    await offline("fe");
    const key = mintSessionKey();
    const be = await session("be", { key });
    const first = (await be.send("fe", "hello")) as Sent;
    expect(((await be.send("you@example.com/fe", "hello")) as Sent).replayed!.ref.id).toBe(first.message_id);
    expect(((await be.send("FE", "hello")) as Sent).replayed!.ref.id).toBe(first.message_id);

    const up = async (bytes: string) => {
      const r = await srv.upload(you, "be", "notes.md", bytes);
      expect(r.status).toBe(201);
      return r.body.id as number;
    };
    const withFile = await dm(be, "files", { attachment_ids: [await up("v1")] });
    // A retry uploads afresh: a new id, the same blob.
    const retryUpload = await up("v1");
    const reup = await dm(be, "files", { attachment_ids: [retryUpload] });
    expect(reup.replayed!.ref.id).toBe(withFile.message_id);
    expect(reup.attachments).toEqual(withFile.attachments);
    // The replay released the retry's upload, audited; the first copy keeps the blob.
    expect(n(`SELECT COUNT(*) AS n FROM attachments WHERE id = ${retryUpload}`)).toBe(0);
    expect(n(`SELECT COUNT(*) AS n FROM access_log WHERE action = 'attachment.released' AND target = 'attachment:${retryUpload}' AND detail LIKE '%"reason":"replayed"%'`)).toBe(1);
    expect(n(`SELECT COUNT(*) AS n FROM attachment_blobs WHERE sha256 = '${withFile.attachments![0]!.sha256}'`)).toBe(1);
    const other = await dm(be, "files", { attachment_ids: [await up("v2")] });
    expect(other.replayed).toBeUndefined();
    // Files are refused as bindAttachments would refuse them.
    await expect(dm(be, "files", { attachment_ids: [withFile.attachments![0]!.id] })).rejects.toMatchObject({ code: "bad_request", message: expect.stringContaining("isn't an unsent upload of yours") });

    // A sibling session writing under the same name is its own session.
    const sibling = await session("be", { push: false });
    expect(((await sibling.send("fe", "hello")) as Sent).replayed).toBeUndefined();
    // The same session on a new connection (a reconnect) still collides.
    be.close();
    const reconnect = await session("be", { key });
    expect(((await reconnect.send("fe", "hello")) as Sent).replayed!.ref.id).toBe(first.message_id);
    expect(n("SELECT COUNT(*) AS n FROM messages WHERE body = 'hello'")).toBe(2);
  });

  test("board_post: a replay releases the retry's upload; a non-string body is a bad request", async () => {
    const be = await session("be");
    await be.call("board_create", { name: "e2e", purpose: "files" });
    const up = async () => (await srv.upload(you, "be", "notes.md", "v1")).body.id as number;
    type Post = { post_id: number } & Replayed;
    const first = await be.call<Post>("board_post", { board: "e2e", body: "see file", attachment_ids: [await up()] });
    const retryUpload = await up();
    const retry = await be.call<Post>("board_post", { board: "e2e", body: "see file", attachment_ids: [retryUpload] });
    expect(retry.replayed!.ref.id).toBe(first.post_id);
    expect(n(`SELECT COUNT(*) AS n FROM attachments WHERE id = ${retryUpload}`)).toBe(0);
    expect(n("SELECT COUNT(*) AS n FROM access_log WHERE action = 'attachment.released'")).toBe(1);
    await expect(be.call("board_post", { board: "e2e", body: [[1]] })).rejects.toMatchObject({ code: "bad_request", message: "body must be a string" });
    await expect(be.call("board_post", { board: "e2e", body: "reply", parent_id: "1" })).rejects.toMatchObject({ code: "bad_request", message: "parent_id must be a number" });
  });

  // #296: the access checks run before the receipt lookup, so a repeat from a
  // caller who has since lost the board is refused, not answered with the first post's result.
  test("board_post: a repeat after the caller lost the board is refused, not replayed", async () => {
    expect((await srv.api(you, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
    const be = await session("be");
    const first = await be.call<{ post_id: number }>("board_post", { board: "eng", body: "ship it" });
    const postId = first.post_id;
    // The same session, still inside the window, repeats: replayed while the board is visible.
    expect((await be.call<Replayed>("board_post", { board: "eng", body: "ship it" })).replayed!.ref.id).toBe(postId);

    expect((await srv.api(you, "POST", "/api/teams/eng/leave")).status).toBe(200);
    await expect(be.call("board_post", { board: "eng", body: "ship it" })).rejects.toMatchObject({ code: "bad_request", message: "no such board #eng; see board_list" });
    expect(n("SELECT COUNT(*) AS n FROM posts WHERE body = 'ship it'")).toBe(1);
  });

  test("the window runs on the hub's clock: a repeat after it sends", async () => {
    await offline("fe");
    const be = await session("be");
    const first = await dm(be, "tick");
    clock += WRITE_DEDUP_WINDOW_MS - 1;
    expect((await dm(be, "tick")).replayed!.ref.id).toBe(first.message_id);
    clock += 1;
    const later = await dm(be, "tick");
    expect(later.replayed).toBeUndefined();
    expect(later.message_id).not.toBe(first.message_id);
    // Prune-on-write took the expired receipt with it.
    expect(q("SELECT ref_id FROM write_receipts")).toEqual([{ ref_id: later.message_id }]);
  });

  // #297: rows, audit and receipts read the one clock, so a replay's first_at is its row's own created_at.
  test("under a moved clock, first_at, the row's created_at and the audit's at agree", async () => {
    clock -= 86_400_000;
    await offline("fe");
    const be = await session("be");
    const sentAt = clock;
    const first = await dm(be, "clocked");
    clock += 1_000;
    const again = await dm(be, "clocked");
    expect(again.replayed!.ref.id).toBe(first.message_id);
    expect(q("SELECT created_at FROM messages WHERE id = ?", first.message_id)).toEqual([{ created_at: sentAt }]);
    expect(again.replayed!.first_at).toBe(new Date(sentAt).toISOString());
    expect(q("SELECT at FROM access_log WHERE action = 'request.replayed'")).toEqual([{ at: clock }]);
  });

  test("delegate's inner send isn't a dm_send: the same body sent plainly afterwards sends", async () => {
    const lx = srv.appSession(you, "lx", { launcher: true });
    await lx.connect();
    await offline("sim");
    const be = await session("be");
    const d = await be.delegate({ persona: "a researcher", task: "t", to: "lx" });
    expect(d).toMatchObject({ to: "you@example.com/lx" });
    const body = (q("SELECT body FROM messages WHERE id = ?", d.message_id) as { body: string }[])[0]!.body;
    const plain = (await be.send("lx", body, { pending: true })) as Sent;
    expect(plain.replayed).toBeUndefined();
    // A refusal inside the dedup'd write rolls back and is still audited.
    await expect(be.delegate({ persona: "a researcher", task: "t", to: "sim" })).rejects.toMatchObject({ message: expect.stringContaining("isn't a launcher") });
    expect(n("SELECT COUNT(*) AS n FROM access_log WHERE action = 'delegation.refused'")).toBe(1);
    expect(n("SELECT COUNT(*) AS n FROM write_receipts WHERE tool = 'delegate'")).toBe(1);
  });

  // #302 (#254 AC3): delegate takes resend like the other append writes, in
  // process and over hosted MCP: a second pending DM, a second
  // delegation.requested, and a request.resent row.
  test("delegate with resend: true delegates again, in process and over hosted MCP", async () => {
    const lx = srv.appSession(you, "lx", { launcher: true });
    await lx.connect();
    const be = await session("be");
    const req = { persona: "a researcher", task: "survey", to: "lx" };
    const first = await be.delegate(req);
    const forced = (await be.delegate({ ...req, resend: true })) as typeof first & Replayed;
    expect(forced.replayed).toBeUndefined();
    expect(forced.message_id).not.toBe(first.message_id);

    const hosted = await srv.hosted("you@example.com", "qa");
    const h1 = await hosted.call<typeof first & Replayed>("delegate", req);
    expect((await hosted.call<typeof first & Replayed>("delegate", req)).replayed!.ref.id).toBe(h1.message_id);
    const h2 = await hosted.call<typeof first & Replayed>("delegate", { ...req, resend: true });
    expect(h2.replayed).toBeUndefined();
    expect(h2.message_id).not.toBe(h1.message_id);

    expect(n("SELECT COUNT(*) AS n FROM messages WHERE recipient = 'you@example.com/lx' AND pending = 1")).toBe(4);
    expect(n("SELECT COUNT(*) AS n FROM access_log WHERE action = 'delegation.requested'")).toBe(4);
    const resent = (q("SELECT detail FROM access_log WHERE action = 'request.resent'") as { detail: string }[]).map((r) => JSON.parse(r.detail));
    expect(resent).toEqual([
      expect.objectContaining({ tool: "delegate", ref_kind: "message", ref_id: forced.message_id }),
      expect.objectContaining({ tool: "delegate", ref_kind: "message", ref_id: h2.message_id }),
    ]);
  });

  test("claim_release and board_create repeats answer from state", async () => {
    const be = await session("be");
    await be.call("claim_take", { key: "ticket:ENG-142" });
    expect(await be.call("claim_release", { key: "ticket:ENG-142" })).toBe("released ticket:ENG-142");
    expect(await be.call("claim_release", { key: "ticket:ENG-142" })).toMatch(/^already released by you at \d{4}-/);
    const sim = await session("sim");
    await sim.call("claim_take", { key: "ticket:ENG-142" });
    await sim.call("claim_release", { key: "ticket:ENG-142" });
    await expect(be.call("claim_release", { key: "ticket:ENG-142" })).rejects.toMatchObject({ message: expect.stringContaining("no active claim") });

    const made = await be.call<{ created_at: number }>("board_create", { name: "e2e", purpose: "fixtures" });
    const repeat = await be.call("board_create", { name: "e2e", purpose: "fixtures" });
    expect(repeat).toEqual({ ...made, note: `you created #e2e at ${new Date(made.created_at).toISOString()}` });
    await expect(sim.call("board_create", { name: "e2e", purpose: "fixtures" })).rejects.toMatchObject({ message: expect.stringContaining("already exists") });
  });

  test("the Slack bridge's human is exempt: a line typed twice is sent twice", async () => {
    await offline("be");
    const user = srv.app.repo.users.findByEmail("you@example.com")!;
    const { session } = await srv.app.application.attachHuman(
      { user_id: user.id, user_email: user.email, session_id: 0 },
      { deliver() {}, closed() {} },
    );
    const a = srv.app.application.send(session, "you@example.com/be", "yes");
    const b = srv.app.application.send(session, "you@example.com/be", "yes") as SendResult & Replayed;
    expect(a.message_id).toBeGreaterThan(0);
    expect(b.replayed).toBeUndefined();
    expect(b.message_id).not.toBe(a.message_id);
    expect(n("SELECT COUNT(*) AS n FROM write_receipts")).toBe(0);
    const args = { name: "slack-made", purpose: "fixtures" };
    expect(srv.app.application.call(session, "board_create", args)).toHaveProperty("name", "slack-made");
    expect(() => srv.app.application.call(session, "board_create", args)).toThrow("already exists");
    srv.app.application.close(session);
  });
});

describe("state answers in local mode", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gb-dedup-local-"));
  });
  afterEach(async () => {
    await closeSessions();
    rmSync(dir, { recursive: true, force: true });
  });

  test("dm_retract, claim_release and board_create repeats answer from state; resend is accepted", async () => {
    await localSession(dir, "fe");
    await closeSessions(); // fe offline: its messages stay queued
    const { c: be } = await localSession(dir, "be");
    const sent = await call(be, "dm_send", { to: "fe", body: "oops" });
    // Local has no dedup: resend is accepted and sends as any send does.
    const resent = await call(be, "dm_send", { to: "fe", body: "oops", resend: true });
    expect(resent.message_id).not.toBe(sent.message_id);
    expect(await call(be, "dm_retract", { message_id: sent.message_id })).toBe("ok");
    const db = new Database(join(dir, "bus.db"), { readonly: true });
    try {
      const rows = db.prepare("SELECT at, actor, target, detail FROM audit_log WHERE action = 'message.retracted'").all() as { at: number; actor: string; target: string; detail: string }[];
      expect(rows.length).toBe(1);
      expect(rows[0]).toMatchObject({ actor: "be", target: `message:${sent.message_id}` });
      expect(JSON.parse(rows[0]!.detail)).toEqual({ message_id: sent.message_id, recipient: "fe" });
      expect(await call(be, "dm_retract", { message_id: sent.message_id })).toBe(`ok: already retracted by you at ${new Date(rows[0]!.at).toISOString()}`);
    } finally {
      db.close();
    }

    await call(be, "claim_take", { key: "ticket:ENG-142" });
    expect(await call(be, "claim_release", { key: "ticket:ENG-142" })).toBe("released ticket:ENG-142");
    expect(await call(be, "claim_release", { key: "ticket:ENG-142" })).toMatch(/^already released by you at \d{4}-/);

    const made = await call(be, "board_create", { name: "e2e", purpose: "fixtures" });
    expect(await call(be, "board_create", { name: "e2e", purpose: "fixtures" })).toEqual({ ...made, note: `you created #e2e at ${new Date(made.created_at).toISOString()}` });

    expect(await call(be, "board_post", { board: "e2e", body: "x", resend: true })).toMatchObject({ post_id: expect.any(Number) });
  }, 30_000);

  test("the local Slack bridge's human keeps \"already exists\" on a board_create repeat", async () => {
    expect((await runCli(["human", "alex"], { env: localEnv(dir), cwd: dir })).code).toBe(0);
    const { c: bridge } = await localSession(dir, "alex", { extra: { BUS_HUMAN: "1" } });
    await call(bridge, "board_create", { name: "slack-made", purpose: "fixtures" });
    await expect(call(bridge, "board_create", { name: "slack-made", purpose: "fixtures" })).rejects.toThrow("already exists");
  }, 30_000);
});
