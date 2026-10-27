// Append-write dedup and state-derived repeats (#254): a write whose answer
// was lost, called again, returns the first result instead of landing twice.
// The lost-answer cases run the server as its own process, so the
// write:after-commit pause blocks only the server; the rest run in process.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mintSessionKey } from "../../src/core/bindings.ts";
import type { Conn, WsData } from "../../src/server/ws.ts";
import { WRITE_DEDUP_WINDOW_MS } from "../../src/shared/dedup.ts";
import { PROTO } from "../../src/shared/protocol.ts";
import { call, closeSessions, localSession } from "../support/mcp.ts";
import { localEnv } from "../support/env.ts";
import { runCli } from "../support/cli.ts";
import { ROOT } from "../support/paths.ts";
import { ServerProcess, TestServer } from "../support/server.ts";
import { until } from "../support/until.ts";
import { WsClient, type Any } from "../support/ws_client.ts";

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

describe("a lost answer over WSS, then the same call (server process)", () => {
  const PAUSE = "write:after-commit";
  let dir: string;
  let srv: ServerProcess;
  let alice: string;
  let bob: string;
  const go = () => join(dir, "go");
  const db = () => new Database(join(dir, "bus.db"), { readonly: true });
  const hits = (what: "hit" | "released") => srv.log().split(`test pause ${what}: ${PAUSE}`).length - 1;
  const clients: WsClient[] = [];
  const client = (token: string, identity: string, hello: Record<string, unknown> = {}, push = true) => {
    const c = new WsClient(srv.base, token, identity, { hello, ...(push ? {} : { push: false }) });
    clients.push(c);
    return c;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "gb-dedup-"));
    srv = await ServerProcess.start([process.execPath, join(ROOT, "src/server/main.ts")], join(dir, "bus.db"), {
      BUS_TEST_PAUSE: PAUSE, BUS_TEST_PAUSE_FILE: go(),
    });
    alice = await srv.login("alice@example.com");
    bob = await srv.login("bob@example.com");
  });
  afterAll(async () => {
    for (const c of clients) c.close();
    writeFileSync(go(), "");
    await srv.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  // The first call commits and pauses before its answer; its socket closes;
  // the pause releases (the answer goes nowhere); the same session reconnects
  // and makes the same call, answered by its own req_id.
  async function lostThenRepeated(identity: string, frame: Record<string, unknown>): Promise<{ again: WsClient; retry: Any }> {
    const session_key = mintSessionKey();
    rmSync(go(), { force: true });
    const first = client(alice, identity, { session_key }, false);
    expect((await first.connect()).type).toBe("hello_ok");
    const before = hits("hit");
    first.ws.send(JSON.stringify({ ...frame, req_id: "lost" }));
    await until(() => hits("hit") > before, 10_000, "the pause after the commit");
    first.close();
    const released = hits("released");
    writeFileSync(go(), "");
    await until(() => hits("released") > released, 10_000, "the pause's release");
    // Tools-only on both sides (a re-attach is the kind its row registered, S1),
    // so the reconnect needn't wait out the old holder's probe.
    const again = client(alice, identity, { session_key, resume: true }, false);
    expect(await again.connect()).toMatchObject({ type: "hello_ok" });
    const retry = await again.request(frame);
    expect(retry.req_id).toBe("r1");
    return { again, retry };
  }

  // Everything pushed to `c` before `sentinel` lands, which is sent after the repeat.
  async function pushedBefore(c: WsClient, sentinel: () => Promise<unknown>, body: string): Promise<Any[]> {
    await sentinel();
    await c.next((m) => m.type === "push" && m.message.body === body, 5000);
    return c.inbox;
  }

  test("dm_send: one row, the repeat answered as replayed, one push, one request.replayed", async () => {
    const fe = client(bob, "fe");
    await fe.connect();
    const { again, retry } = await lostThenRepeated("be", { type: "send", recipient: "bob@example.com/fe", body: "lost answer dm" });
    const d = db();
    const rows = d.prepare("SELECT id FROM messages WHERE body = 'lost answer dm'").all() as { id: number }[];
    expect(rows.length).toBe(1);
    const id = rows[0]!.id;
    expect(retry.replayed.first_at).toMatch(ISO);
    expect(retry).toMatchObject({ type: "send_ok", message_id: id, delivered_now: true, replayed: { ref: { kind: "message", id } } });
    expect(retry.note).toBe(`already sent to bob@example.com/fe at ${retry.replayed.first_at} as message ${id}; this repeat was not sent. To send it again on purpose, call with resend: true.`);
    const replays = d.prepare("SELECT actor, target, detail FROM access_log WHERE action = 'request.replayed'").all() as { actor: string; target: string; detail: string }[];
    expect(replays.length).toBe(1);
    expect(replays[0]).toMatchObject({ actor: "alice@example.com", target: "alice@example.com/be" });
    expect(JSON.parse(replays[0]!.detail)).toMatchObject({ tool: "dm_send", ref_kind: "message", ref_id: id, transport: "wss", first_at: retry.replayed.first_at });
    d.close();
    const inbox = await pushedBefore(fe, () => again.request({ type: "send", recipient: "bob@example.com/fe", body: "sentinel 1" }), "sentinel 1");
    expect(inbox.filter((m) => m.type === "push" && m.message.id === id).length).toBe(1);
  }, 30_000);

  test("board_post on a queue board: one post, one queue claim, one delivery", async () => {
    const lane = client(bob, "lane");
    await lane.connect();
    expect((await lane.call("board_create", { name: "work", purpose: "a queue", kind: "queue" })).type).toBe("call_ok");
    const { again, retry } = await lostThenRepeated("poster", { type: "call", tool: "board_post", args: { board: "#Work", body: "process next batch" } });
    const d = db();
    const posts = d.prepare("SELECT id FROM posts WHERE body = 'process next batch'").all() as { id: number }[];
    expect(posts.length).toBe(1);
    const id = posts[0]!.id;
    expect(retry).toMatchObject({ type: "call_ok", result: { post_id: id, board: "work", replayed: { ref: { kind: "post", id } } } });
    expect(retry.result.note).toStartWith(`already posted to #work at ${retry.result.replayed.first_at} as post ${id}; this repeat was not posted.`);
    expect(d.prepare("SELECT holder FROM claims WHERE key LIKE 'queue:work:%'").all()).toEqual([{ holder: "bob@example.com/lane" }]);
    expect(d.prepare("SELECT event FROM claim_events WHERE key = ?").all(`queue:work:${id}`)).toEqual([{ event: "take" }]);
    d.close();
    const inbox = await pushedBefore(lane, () => again.request({ type: "send", recipient: "bob@example.com/lane", body: "sentinel 2" }), "sentinel 2");
    expect(inbox.filter((m) => m.type === "board_push" && m.item.post?.id === id).length).toBe(1);
  }, 30_000);

  test("delegate: one pending DM, one delegation.requested, one launcher push", async () => {
    const lx = client(alice, "lx", { launcher: true });
    await lx.connect();
    const { again, retry } = await lostThenRepeated("asker", { type: "delegate", persona: "a researcher", task: "survey the options", to: "lx" });
    const d = db();
    const rows = d.prepare("SELECT id, pending FROM messages WHERE recipient = 'alice@example.com/lx' AND sender = 'alice@example.com/asker'").all() as { id: number; pending: number }[];
    expect(rows).toEqual([{ id: expect.any(Number), pending: 1 }]);
    const id = rows[0]!.id;
    expect(retry).toMatchObject({ type: "send_ok", message_id: id, to: "alice@example.com/lx", pending: true, replayed: { ref: { kind: "message", id } } });
    expect(retry.note).toStartWith(`already delegated to alice@example.com/lx at ${retry.replayed.first_at} as message ${id}; this repeat was not sent.`);
    expect(d.prepare("SELECT COUNT(*) AS n FROM access_log WHERE action = 'delegation.requested' AND target = 'alice@example.com/lx'").get()).toEqual({ n: 1 });
    expect(d.prepare("SELECT COUNT(*) AS n FROM access_log WHERE action = 'request.replayed'").get()).toEqual({ n: 3 });
    d.close();
    const inbox = await pushedBefore(lx, () => again.request({ type: "send", recipient: "lx", body: "sentinel 3" }), "sentinel 3");
    expect(inbox.filter((m) => m.type === "push" && m.message.id === id).length).toBe(1);
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
  // A session of `identity`'s: its connections share session_key, so its calls share a session.
  const session = async (identity: string, opts: { push?: boolean; session_key?: string } = {}) => {
    const c = srv.client(you, identity, { hello: { session_key: opts.session_key ?? mintSessionKey() }, ...(opts.push === false ? { push: false } : {}) });
    expect((await c.connect()).type).toBe("hello_ok");
    return c;
  };
  // An identity that exists and is offline, so its messages stay queued.
  const offline = async (identity: string) => (await session(identity)).close();
  const dm = (c: WsClient, body: string, extra: Record<string, unknown> = {}) => c.request({ type: "send", recipient: "you@example.com/fe", body, ...extra });

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
    expect((await dm(be, "ok")).replayed.ref.id).toBe(forced.message_id);
    expect(await be.request({ type: "send", recipient: "fe", body: "x", resend: "yes" })).toMatchObject({ type: "error", code: "bad_request", message: expect.stringContaining("resend must be boolean") });
  });

  test("a repeat after the original was retracted sends anew; dm_retract repeats answer from its audit row", async () => {
    await offline("fe");
    const be = await session("be");
    const first = await dm(be, "oops");
    expect(await be.request({ type: "dm_retract", message_id: first.message_id })).toEqual({ type: "ack_ok", req_id: expect.any(String) });
    const row = q("SELECT at, actor, target, detail FROM access_log WHERE action = 'message.retracted'") as { at: number; actor: string; target: string; detail: string }[];
    expect(row.length).toBe(1);
    expect(row[0]).toMatchObject({ actor: "you@example.com", target: `message:${first.message_id}` });
    expect(JSON.parse(row[0]!.detail)).toEqual({ message_id: first.message_id, sender: "you@example.com/be", recipient: "you@example.com/fe" });
    expect(await be.request({ type: "dm_retract", message_id: first.message_id })).toMatchObject({ type: "ack_ok", note: `already retracted by you at ${new Date(row[0]!.at).toISOString()}` });
    // Another sender's repeat is still refused.
    const sim = await session("sim");
    expect(await sim.request({ type: "dm_retract", message_id: first.message_id })).toMatchObject({ type: "error", code: "not_found" });
    const again = await dm(be, "oops");
    expect(again.replayed).toBeUndefined();
    expect(again.message_id).not.toBe(first.message_id);
  });

  test("resolved spellings and re-uploaded files collide; other files and another session don't", async () => {
    await offline("fe");
    const key = mintSessionKey();
    const be = await session("be", { session_key: key });
    const first = await be.request({ type: "send", recipient: "fe", body: "hello" });
    expect((await be.request({ type: "send", recipient: "you@example.com/fe", body: "hello" })).replayed.ref.id).toBe(first.message_id);
    expect((await be.request({ type: "send", recipient: "FE", body: "hello" })).replayed.ref.id).toBe(first.message_id);

    const up = async (bytes: string) => {
      const r = await srv.upload(you, "be", "notes.md", bytes);
      expect(r.status).toBe(201);
      return r.body.id as number;
    };
    const withFile = await dm(be, "files", { attachment_ids: [await up("v1")] });
    // A retry uploads afresh: a new id, the same blob.
    const retryUpload = await up("v1");
    const reup = await dm(be, "files", { attachment_ids: [retryUpload] });
    expect(reup.replayed.ref.id).toBe(withFile.message_id);
    expect(reup.attachments).toEqual(withFile.attachments);
    // The replay released the retry's upload, audited; the first copy keeps the blob.
    expect(n(`SELECT COUNT(*) AS n FROM attachments WHERE id = ${retryUpload}`)).toBe(0);
    expect(n(`SELECT COUNT(*) AS n FROM access_log WHERE action = 'attachment.released' AND target = 'attachment:${retryUpload}' AND detail LIKE '%"reason":"replayed"%'`)).toBe(1);
    expect(n(`SELECT COUNT(*) AS n FROM attachment_blobs WHERE sha256 = '${withFile.attachments[0].sha256}'`)).toBe(1);
    const other = await dm(be, "files", { attachment_ids: [await up("v2")] });
    expect(other.replayed).toBeUndefined();
    // Files are refused as bindAttachments would refuse them.
    expect(await dm(be, "files", { attachment_ids: [withFile.attachments[0].id] })).toMatchObject({ type: "error", code: "bad_request", message: expect.stringContaining("isn't an unsent upload of yours") });

    // A sibling session writing under the same name is its own session.
    const sibling = await session("be", { push: false });
    expect((await sibling.request({ type: "send", recipient: "fe", body: "hello" })).replayed).toBeUndefined();
    // The same session on a new connection (a reconnect) still collides.
    be.close();
    const reconnect = await session("be", { session_key: key });
    expect((await reconnect.request({ type: "send", recipient: "fe", body: "hello" })).replayed.ref.id).toBe(first.message_id);
    expect(n("SELECT COUNT(*) AS n FROM messages WHERE body = 'hello'")).toBe(2);
  });

  test("board_post: a replay releases the retry's upload; a non-string body is a bad request", async () => {
    const be = await session("be");
    expect((await be.call("board_create", { name: "e2e", purpose: "files" })).type).toBe("call_ok");
    const up = async () => (await srv.upload(you, "be", "notes.md", "v1")).body.id as number;
    const first = await be.call("board_post", { board: "e2e", body: "see file", attachment_ids: [await up()] });
    const retryUpload = await up();
    const retry = await be.call("board_post", { board: "e2e", body: "see file", attachment_ids: [retryUpload] });
    expect(retry.result.replayed.ref.id).toBe(first.result.post_id);
    expect(n(`SELECT COUNT(*) AS n FROM attachments WHERE id = ${retryUpload}`)).toBe(0);
    expect(n("SELECT COUNT(*) AS n FROM access_log WHERE action = 'attachment.released'")).toBe(1);
    expect(await be.call("board_post", { board: "e2e", body: [[1]] })).toMatchObject({ type: "error", code: "bad_request", message: "body must be a string" });
    expect(await be.call("board_post", { board: "e2e", body: "reply", parent_id: "1" })).toMatchObject({ type: "error", code: "bad_request", message: "parent_id must be a number" });
  });

  // #296: the access checks run before the receipt lookup, so a repeat from a
  // caller who has since lost the board is refused, not answered with the first post's result.
  test("board_post: a repeat after the caller lost the board is refused, not replayed", async () => {
    expect((await srv.api(you, "POST", "/api/teams", { name: "eng" })).status).toBe(201);
    const be = await session("be");
    const first = await be.call("board_post", { board: "eng", body: "ship it" });
    expect(first.type).toBe("call_ok");
    const postId = first.result.post_id as number;
    // The same session, still inside the window, repeats: replayed while the board is visible.
    expect((await be.call("board_post", { board: "eng", body: "ship it" })).result.replayed.ref.id).toBe(postId);

    expect((await srv.api(you, "POST", "/api/teams/eng/leave")).status).toBe(200);
    expect(await be.call("board_post", { board: "eng", body: "ship it" })).toMatchObject({ type: "error", code: "bad_request", message: "no such board #eng; see board_list" });
    expect(n("SELECT COUNT(*) AS n FROM posts WHERE body = 'ship it'")).toBe(1);
  });

  test("the window runs on the hub's clock: a repeat after it sends", async () => {
    await offline("fe");
    const be = await session("be");
    const first = await dm(be, "tick");
    clock += WRITE_DEDUP_WINDOW_MS - 1;
    expect((await dm(be, "tick")).replayed.ref.id).toBe(first.message_id);
    clock += 1;
    const later = await dm(be, "tick");
    expect(later.replayed).toBeUndefined();
    expect(later.message_id).not.toBe(first.message_id);
    // Prune-on-write took the expired receipt with it.
    expect(q("SELECT ref_id FROM write_receipts")).toEqual([{ ref_id: later.message_id }]);
  });

  test("delegate's inner send isn't a dm_send: the same body sent plainly afterwards sends", async () => {
    await srv.client(you, "lx", { hello: { launcher: true } }).connect();
    await offline("sim");
    const be = await session("be");
    const d = await be.request({ type: "delegate", persona: "a researcher", task: "t", to: "lx" });
    expect(d).toMatchObject({ type: "send_ok", to: "you@example.com/lx" });
    const body = (q("SELECT body FROM messages WHERE id = ?", d.message_id) as { body: string }[])[0]!.body;
    const plain = await be.request({ type: "send", recipient: "lx", body, pending: true });
    expect(plain.replayed).toBeUndefined();
    // A refusal inside the dedup'd write rolls back and is still audited.
    expect(await be.request({ type: "delegate", persona: "a researcher", task: "t", to: "sim" })).toMatchObject({ type: "error", message: expect.stringContaining("isn't a launcher") });
    expect(n("SELECT COUNT(*) AS n FROM access_log WHERE action = 'delegation.refused'")).toBe(1);
    expect(n("SELECT COUNT(*) AS n FROM write_receipts WHERE tool = 'delegate'")).toBe(1);
  });

  test("claim_release and board_create repeats answer from state", async () => {
    const be = await session("be");
    await be.call("claim_take", { key: "ticket:ENG-142" });
    expect((await be.call("claim_release", { key: "ticket:ENG-142" })).result).toBe("released ticket:ENG-142");
    const again = await be.call("claim_release", { key: "ticket:ENG-142" });
    expect(again.result).toMatch(/^already released by you at \d{4}-/);
    const sim = await session("sim");
    await sim.call("claim_take", { key: "ticket:ENG-142" });
    await sim.call("claim_release", { key: "ticket:ENG-142" });
    expect(await be.call("claim_release", { key: "ticket:ENG-142" })).toMatchObject({ type: "error", message: expect.stringContaining("no active claim") });

    const made = (await be.call("board_create", { name: "e2e", purpose: "fixtures" })).result;
    const repeat = (await be.call("board_create", { name: "e2e", purpose: "fixtures" })).result;
    expect(repeat).toEqual({ ...made, note: `you created #e2e at ${new Date(made.created_at).toISOString()}` });
    expect(await sim.call("board_create", { name: "e2e", purpose: "fixtures" })).toMatchObject({ type: "error", message: expect.stringContaining("already exists") });
  });

  test("the Slack bridge's human is exempt: a line typed twice is sent twice", async () => {
    await offline("be");
    const user = srv.app.repo.users.findByEmail("you@example.com")!;
    const out: Any[] = [];
    const conn: Conn = {
      data: { authed: { user_id: user.id, user_email: user.email, session_id: 0 }, primary: "", addresses: [], ready: false, human: true } as WsData,
      readyState: 1,
      send: (raw) => void out.push(JSON.parse(raw)),
      close: () => {},
    };
    const frame = (m: Record<string, unknown>) => srv.app.handlers.message(conn as never, JSON.stringify(m));
    frame({ type: "hello", req_id: "h", proto: PROTO });
    await until(() => out.find((m) => m.req_id === "h"));
    frame({ type: "send", req_id: "a", recipient: "you@example.com/be", body: "yes" });
    frame({ type: "send", req_id: "b", recipient: "you@example.com/be", body: "yes" });
    const [a, b] = ["a", "b"].map((id) => out.find((m) => m.req_id === id)!);
    expect(a!.type).toBe("send_ok");
    expect(b!.replayed).toBeUndefined();
    expect(b!.message_id).not.toBe(a!.message_id);
    expect(n("SELECT COUNT(*) AS n FROM write_receipts")).toBe(0);
    // Its relay treats a successful board_create as a fresh create, so a
    // repeat keeps answering "already exists".
    frame({ type: "call", req_id: "c1", tool: "board_create", args: { name: "slack-made", purpose: "fixtures" } });
    frame({ type: "call", req_id: "c2", tool: "board_create", args: { name: "slack-made", purpose: "fixtures" } });
    await until(() => out.find((m) => m.req_id === "c2"));
    expect(out.find((m) => m.req_id === "c1")!.type).toBe("call_ok");
    expect(out.find((m) => m.req_id === "c2")).toMatchObject({ type: "error", message: expect.stringContaining("already exists") });
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
