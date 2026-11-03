// Session IDs as recipients over real local-mode processes (#284 PR 2 S4/S6):
// a DM to `id:…` reaches the session whatever name it later binds, an
// unknown or ended ID is refused, and the end settles a send it races. And
// child sessions (#523): a harness subagent's call is its root's child, whose
// ID attributes its writes (`via`) and is never an address.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeAttachment } from "../../src/core/attachments.ts";
import { mintSessionKey } from "../../src/core/bindings.ts";
import { GRAYBOARD_AGENT_META } from "../../src/shared/session_meta.ts";
import { SqliteBlobs } from "../../src/local/blobs.ts";
import { runCli } from "../support/cli.ts";
import { CLI } from "../support/paths.ts";
import { localEnv } from "../support/env.ts";
import { closeSessions, localSession, stopSession, type Session } from "../support/mcp.ts";
import { sigkill } from "../support/procs.ts";
import { releaseBinaries } from "../support/releases.ts";
import { until } from "../support/until.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grayboard-ids-"));
});

afterEach(async () => {
  await closeSessions();
  rmSync(dir, { recursive: true, force: true });
});

const session = (identity?: string): Promise<Session> => localSession(dir, identity);

function rows<T>(sql: string, ...args: (string | number)[]): T[] {
  const db = new Database(join(dir, "bus.db"), { readonly: true });
  try {
    return db.prepare(sql).all(...args) as T[];
  } finally {
    db.close();
  }
}

// An unbound session's own row in peer_list's unbound_sessions.
const sessionId = async (s: Session): Promise<string> => (((await s.call("peer_list", {})).unbound_sessions as { session_id: string; self?: true }[]).find((u) => u.self)!.session_id);
const pidOfId = (id: string) => rows<{ pid: number }>(`SELECT pid FROM bindings WHERE session_id = ?`, id)[0]!.pid;
const endedAt = (id: string) => rows<{ ended_at: number | null }>(`SELECT ended_at FROM ids WHERE id = ?`, id)[0]?.ended_at ?? null;

async function refusal(s: Session, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = await s.c.callTool({ name, arguments: args });
  const text = (r.content as { text: string }[])[0]!.text;
  if (!r.isError) throw new Error(`${name} succeeded: ${text}`);
  return text;
}

// A CLI process whose stderr is read as it runs, for a test pause.
function spawnCli(args: string[], extra: Record<string, string>) {
  const p = Bun.spawn([process.execPath, CLI, ...args], { cwd: dir, env: localEnv(dir, undefined, extra), stdout: "pipe", stderr: "pipe" });
  let err = "";
  (async () => {
    for await (const chunk of p.stderr) err += new TextDecoder().decode(chunk);
  })();
  return { p, stderr: () => err };
}

const pauseEnv = (point: string) => ({ BUS_TEST_PAUSE: point, BUS_TEST_PAUSE_FILE: join(dir, `go-${point}`) });
const release = (point: string) => writeFileSync(join(dir, `go-${point}`), "");

// #284 AC 1, S13: with no name the session is a full participant as its ID,
// and what it did as the ID stays its own after it binds.
test("an unbound session sends, uploads, posts, claims and takes queue work as its ID; after a bind it keeps all of it", async () => {
  writeFileSync(join(dir, "notes.md"), "# notes");
  const be = await session("be");
  await be.call("board_create", { name: "e2e", purpose: "fixtures" });
  await be.call("board_create", { name: "work", purpose: "queue", kind: "queue" });
  await (await session("gone")).c.close();
  const s = await session();
  const id = await sessionId(s);

  // Writes go as the ID.
  const sent = await s.call("dm_send", { to: "be", body: "from my id", attachments: ["notes.md"] });
  expect(sent.attachments).toEqual([expect.objectContaining({ filename: "notes.md" })]);
  await until(() => be.pushes.some((p) => p.content === "from my id"));
  expect(be.pushes.find((p) => p.content === "from my id")!.meta).toMatchObject({ from: id, attachments: expect.stringContaining("notes.md") });
  const posted = await s.call("board_post", { board: "e2e", body: "as my id" });
  expect((await be.call("board_read", { board: "e2e" })).posts).toContainEqual(expect.objectContaining({ id: posted.post_id, author: id }));
  const queued = await s.call("dm_send", { to: "gone", body: "take this back" });
  expect(queued.delivered_now).toBe(false);
  await s.call("claim_take", { key: "ticket:ENG-142", ttl_minutes: 30 });

  // Replies and queue work reach the ID.
  const reply = await be.call("dm_send", { to: id, body: "reply to your id", parent_id: sent.message_id });
  expect(reply.delivered_now).toBe(true);
  await until(() => s.pushes.some((p) => p.content === "reply to your id"));
  await s.call("board_subscribe", { board: "work", mode: "push" });
  const item = await be.call("board_post", { board: "work", body: "work item" });
  await until(() => s.pushes.some((p) => p.meta.post_id === String(item.post_id)));
  const queueKey = `queue:work:${item.post_id}`;
  expect(rows(`SELECT key, holder FROM claims ORDER BY key`)).toEqual([{ key: queueKey, holder: id }, { key: "ticket:ENG-142", holder: id }]);

  // After a bind, the ID's mail, claims and queue work are still this session's.
  await s.call("bind", { name: "fe", create: true });
  expect((await s.call("dm_thread", { thread: reply.message_id })).map((m: any) => m.body)).toEqual(["from my id", "reply to your id"]);
  expect(((await s.call("dm_inbox", {})).unanswered ?? []).map((m: any) => m.id)).toContain(reply.message_id);
  await s.call("dm_ack", { message_id: reply.message_id });
  expect(((await s.call("dm_inbox", {})).unanswered ?? []).map((m: any) => m.id)).not.toContain(reply.message_id);
  await s.call("dm_retract", { message_id: queued.message_id });
  expect(rows(`SELECT 1 FROM messages WHERE id = ?`, queued.message_id)).toEqual([]);

  const before = rows<{ expires_at: number }>(`SELECT expires_at FROM claims WHERE key = 'ticket:ENG-142'`)[0]!.expires_at;
  await s.call("claim_take", { key: "ticket:ENG-142", ttl_minutes: 120 });
  expect(rows<{ holder: string; expires_at: number }>(`SELECT holder, expires_at FROM claims WHERE key = 'ticket:ENG-142'`)[0]).toEqual({ holder: id, expires_at: expect.any(Number) });
  expect(rows<{ expires_at: number }>(`SELECT expires_at FROM claims WHERE key = 'ticket:ENG-142'`)[0]!.expires_at).toBeGreaterThan(before);
  await s.call("claim_release", { key: "ticket:ENG-142" });
  // A reply on the queue post acks and releases its claim; nothing is redelivered.
  await s.call("board_post", { board: "work", body: "done", parent_id: item.post_id });
  expect(rows(`SELECT key FROM claims`)).toEqual([]);
  expect(rows(`SELECT handle FROM outbox WHERE post_id = ?`, item.post_id)).toEqual([{ handle: id }]);
}, 30_000);

// #284 audit F10: a status set as the ID shows on that session's unbound row.
test("an unbound session's peer_status shows on its row in peer_list", async () => {
  const be = await session("be");
  const s = await session();
  const id = await sessionId(s);
  await s.call("peer_status", { text: "scoping auth" });
  const row = ((await be.call("peer_list", {})).unbound_sessions as { session_id: string; status?: string; status_age?: string }[]).find((u) => u.session_id === id);
  expect(row).toMatchObject({ status: "scoping auth", status_age: "0m" });
}, 30_000);

// #284 audit P6: a board's roster lists a subscription taken as the ID with
// that session's facts, and under its name once it binds.
test("a board's peer_list shows an ID subscriber with its facts, then under the name it binds", async () => {
  const be = await session("be");
  const s = await session();
  const id = await sessionId(s);
  await be.call("board_create", { name: "e2e", purpose: "x" });
  await s.call("board_subscribe", { board: "e2e", mode: "push" });
  await s.call("peer_status", { text: "on e2e" });
  const before = (await be.call("peer_list", { board: "e2e" })).peers as { handle: string }[];
  expect(before.find((p) => p.handle === id)).toMatchObject({ online: true, mode: "push", status: "on e2e" });
  expect(before.find((p) => p.handle === id)).toHaveProperty("where");

  await s.call("bind", { name: "fe", create: true });
  const after = (await be.call("peer_list", { board: "e2e" })).peers as { handle: string }[];
  expect(after.map((p) => p.handle)).toEqual(["be", "fe"]);
  expect(after.find((p) => p.handle === "fe")).toMatchObject({ online: true, mode: "push", status: "on e2e" });
}, 30_000);

test("a DM to an unbound session's ID is pushed now, and follows it into the name it binds", async () => {
  const be = await session("be");
  const s = await session();
  const id = await sessionId(s);

  const sent = await be.call("dm_send", { to: id, body: "to your id" });
  expect(sent.delivered_now).toBe(true);
  await until(() => s.pushes.some((p) => p.content === "to your id"));
  expect(s.pushes.find((p) => p.content === "to your id")!.meta.from).toBe("be");

  await s.call("bind", { name: "fe", create: true });
  const inbox = await s.call("dm_inbox", {});
  expect((inbox.unanswered ?? []).map((m: any) => m.id)).toContain(sent.message_id);
  const thread = await s.call("dm_thread", { thread: sent.message_id });
  expect(thread.map((m: any) => m.body)).toEqual(["to your id"]);

  const reply = await s.call("dm_send", { to: "be", body: "got it", parent_id: sent.message_id });
  await until(() => be.pushes.some((p) => p.content === "got it" && p.meta.parent_id === String(sent.message_id)));
  expect(reply.message_id).toBeGreaterThan(sent.message_id);
  await s.call("dm_ack", { message_id: sent.message_id });
  expect(((await s.call("dm_inbox", {})).unanswered ?? []).map((m: any) => m.id)).not.toContain(sent.message_id);
}, 30_000);

test("a DM to an ID that never existed is not_found; to an ended one, id_ended naming what it held", async () => {
  const be = await session("be");
  expect(await refusal(be, "dm_send", { to: "id:0123456789abc", body: "x" })).toContain("not_found: no session id:0123456789abc");

  const s = await session();
  const id = await sessionId(s);
  await s.call("bind", { name: "fe", create: true });
  await sigkill(pidOfId(id));
  // The next opener ends it.
  const r = await runCli(["claims"], { cwd: dir, env: localEnv(dir) });
  expect(r.code).toBe(0);
  expect(endedAt(id)).not.toBeNull();
  const err = await refusal(be, "dm_send", { to: id, body: "x" });
  expect(err).toContain(`id_ended: ${id} ended at`);
  expect(err).toContain("it held `fe`");
}, 30_000);

// #284 step 8: @id: mentions the session itself, bound or not; one that
// can't receive refuses the post, as a DM to it would.
test("an @id: mention reaches that session whatever it's bound to; an unknown, ended or tools-only ID refuses the post", async () => {
  const be = await session("be");
  await be.call("board_create", { name: "e2e", purpose: "fixtures" });
  const s = await session();
  const id = await sessionId(s);
  const posted = await be.call("board_post", { board: "e2e", body: `@${id.toUpperCase()} look` });
  expect(posted.notified).toEqual([id]);
  await until(() => s.pushes.some((p) => p.content === `@${id.toUpperCase()} look`));
  expect(s.pushes.find((p) => p.content === `@${id.toUpperCase()} look`)!.meta.reason).toBe("mention");
  await s.call("bind", { name: "fe", create: true });
  await be.call("board_post", { board: "e2e", body: `@${id} again` });
  await until(() => s.pushes.some((p) => p.content === `@${id} again`));

  const before = (await be.call("board_read", { board: "e2e" })).posts.length;
  expect(await refusal(be, "board_post", { board: "e2e", body: "@id:0123456789abc hi" })).toBe("error: not_found: no session id:0123456789abc");
  const tools = await localSession(dir, "sim", { extra: { BUS_PUSH: "off" } });
  await tools.call("peer_list", {});
  const toolsId = rows<{ id: string }>(`SELECT id FROM ids WHERE delivery = 'none'`)[0]!.id;
  expect(await refusal(be, "board_post", { board: "e2e", body: `@${toolsId} hi` })).toBe(`error: no_delivery: ${toolsId} is a tools-only session and receives nothing; send to sim`);
  await sigkill(pidOfId(id));
  await session();
  expect(await refusal(be, "board_post", { board: "e2e", body: `@${id} hi` })).toContain(`error: id_ended: ${id} ended at`);
  expect((await be.call("board_read", { board: "e2e" })).posts.length).toBe(before);
}, 30_000);

// #284 PR 2 step 2: an upload a session dropped mid-send goes with its end,
// bytes included, as soon as the end commits.
test("an ended session's unsent upload is deleted, and its bytes swept, by the opener that ends it", async () => {
  const s = await session();
  const id = await sessionId(s);
  await sigkill(pidOfId(id));
  // What a send leaves when its process dies between the upload and the send's commit.
  const db = new Database(join(dir, "bus.db"));
  try {
    await storeAttachment(db, new SqliteBlobs(db), id, { filename: "half.txt", type: "text/plain", data: new TextEncoder().encode("never sent") });
  } finally {
    db.close();
  }
  expect(rows(`SELECT 1 FROM attachment_bytes`).length).toBe(1);
  const r = await runCli(["claims"], { cwd: dir, env: localEnv(dir) });
  expect(r.code).toBe(0);
  expect(endedAt(id)).not.toBeNull();
  expect(rows(`SELECT 1 FROM attachments WHERE uploader = ?`, id)).toEqual([]);
  expect(rows(`SELECT 1 FROM attachment_bytes`)).toEqual([]);
  expect(rows(`SELECT 1 FROM attachment_blobs`)).toEqual([]);
}, 30_000);

// #284 audit P5(a): the end releases a queue claim the ID held, and the
// release hands the post to the next lane.
test("a queue post claimed by an ID that ends is redelivered to the next lane", async () => {
  const be = await session("be");
  await be.call("board_create", { name: "work", purpose: "queue", kind: "queue" });
  const s = await session();
  const id = await sessionId(s);
  await s.call("board_subscribe", { board: "work", mode: "push" });
  const item = await be.call("board_post", { board: "work", body: "work item" });
  const key = `queue:work:${item.post_id}`;
  await until(() => s.pushes.some((p) => p.meta.post_id === String(item.post_id)));
  expect(rows(`SELECT holder FROM claims WHERE key = ?`, key)).toEqual([{ holder: id }]);

  const fe = await session("fe");
  await fe.call("board_subscribe", { board: "work", mode: "push" });
  await sigkill(pidOfId(id));
  // The next opener ends it; `claims` exits 2 because the redelivered claim is active.
  const r = await runCli(["claims"], { cwd: dir, env: localEnv(dir) });
  expect(r.code).toBe(2);
  expect(r.err).toContain(`queue:work:${item.post_id} held by fe`);
  expect(endedAt(id)).not.toBeNull();
  await until(() => fe.pushes.some((p) => p.meta.post_id === String(item.post_id)));
  expect(rows(`SELECT holder FROM claims WHERE key = ?`, key)).toEqual([{ holder: "fe" }]);
}, 30_000);

test("race: a send that commits before the end's transaction is bounced to its sender", async () => {
  const be = await session("be");
  const s = await session();
  const id = await sessionId(s);
  await sigkill(pidOfId(id));

  // The opener has found the dead session and waits before its write lock.
  const opener = spawnCli(["claims"], pauseEnv("end:before-txn"));
  await until(() => opener.stderr().includes("test pause hit: end:before-txn"));
  const sent = await be.call("dm_send", { to: id, body: "just in time" });
  expect(sent.delivered_now).toBe(false);
  release("end:before-txn");
  expect(await opener.p.exited).toBe(0);

  expect(endedAt(id)).not.toBeNull();
  await until(() => be.pushes.some((p) => p.meta.kind === "bounce"));
  const bounce = be.pushes.find((p) => p.meta.kind === "bounce")!;
  expect(bounce.meta.parent_id).toBe(String(sent.message_id));
  expect(bounce.content).toContain(`${id} ended at`);
  expect((await be.call("dm_inbox", {})).unanswered).toContainEqual(expect.objectContaining({ id: Number(bounce.meta.message_id), from: id, kind: "bounce" }));
}, 30_000);

test("race: a send that reaches the write lock after the end is refused with id_ended", async () => {
  const be = await localSession(dir, "be", { extra: pauseEnv("send:before-txn") });
  const s = await session();
  const id = await sessionId(s);
  await sigkill(pidOfId(id));

  // The send has done everything before its own transaction while the ID
  // was live; then the opener takes the write lock and marks it ended, and
  // only then does the send go on. A check made outside the send's
  // transaction would pass and store mail to an ended ID (audit P4: the send
  // must provably start before the end commits, or the test proves nothing).
  const send = refusal(be, "dm_send", { to: id, body: "too late" });
  await until(() => be.stderr().includes("test pause hit: send:before-txn"));
  const opener = spawnCli(["claims"], pauseEnv("end:in-txn"));
  await until(() => opener.stderr().includes("test pause hit: end:in-txn"));
  release("send:before-txn");
  release("end:in-txn");
  expect(await send).toContain(`id_ended: ${id} ended at`);
  expect(await opener.p.exited).toBe(0);
  expect(be.pushes.filter((p) => p.meta.kind === "bounce")).toEqual([]);
}, 30_000);

// Audit F3 (#329): `grayboard claim` as a name acts as the session holding
// it, address set and all, so it can release a claim that session took
// under its ID before it bound.
test("the CLI acting as a bound name releases a claim its session took as the ID", async () => {
  const s = await session();
  const id = await sessionId(s);
  await s.call("claim_take", { key: "ticket:ENG-9" });
  await s.call("bind", { name: "fe", create: true });
  expect(rows<{ holder: string }>(`SELECT holder FROM claims WHERE key = 'ticket:ENG-9'`)).toEqual([{ holder: id }]);
  const r = await runCli(["--as", "fe", "claim", "release", "ticket:ENG-9"], { cwd: dir, env: localEnv(dir) });
  expect(r.code).toBe(0);
  expect(rows(`SELECT key FROM claims`)).toEqual([]);
}, 30_000);

// ── child sessions (#523) ────────────────────────────────────────────────────

// A tool call a harness subagent makes through its root's `grayboard mcp`,
// naming itself in `_meta` as omp's local adapter does.
async function childCall(s: Session, raw: unknown, name: string, args: Record<string, unknown> = {}) {
  return s.c.callTool({ name, arguments: args, _meta: { [GRAYBOARD_AGENT_META]: raw } });
}
// A child's tool result: its JSON, or its text when it isn't JSON. T is the
// shape the caller expects; nothing checks it.
async function asChild<T = unknown>(s: Session, raw: unknown, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await childCall(s, raw, name, args);
  const text = (r.content as { text: string }[])[0]!.text;
  if (r.isError) throw new Error(text);
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}
type Who = { id: string; root?: string; child?: true };
type Sent = { message_id: number; delivered_now: boolean };
async function childRefusal(s: Session, raw: unknown, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = await childCall(s, raw, name, args);
  const text = (r.content as { text: string }[])[0]!.text;
  if (!r.isError) throw new Error(`${name} succeeded: ${text}`);
  return text;
}
const childSeen = () => rows<{ actor: string; target: string; detail: string }>(`SELECT actor, target, detail FROM audit_log WHERE action = 'id.child_seen'`)
  .map((r) => ({ ...r, detail: JSON.parse(r.detail) }));

test("a subagent's call is its root's child: its DM and post are stored with its ID and shown as via in pushes and reads; the root's carry none", async () => {
  const be = await session("be");
  const fe = await session("fe");
  await be.call("board_create", { name: "e2e", purpose: "fixtures" });
  await be.call("board_subscribe", { board: "e2e", mode: "push" });
  const root = (await fe.call("whoami")).id as string;

  // whoami names the child, its root, and the root's addresses it acts under.
  const who = await asChild<Who>(fe, "reviewer-1", "whoami");
  const child = who.id;
  expect(child).toMatch(/^id:[0-9a-hjkmnp-tv-z]{13}$/);
  expect(who).toEqual({ id: child, primary: "fe", aliases: ["fe"], principal: null, root, child: true });
  expect(rows(`SELECT root_id, delivery, ended_at FROM ids WHERE id = ?`, child)).toEqual([{ root_id: root, delivery: "none", ended_at: null }]);

  // The DM: sent as the root's primary, stored with the child's sender_id and via, pushed with via.
  const sent = await asChild<Sent>(fe, "reviewer-1", "dm_send", { to: "be", body: "from the subagent" });
  expect(sent.delivered_now).toBe(true);
  expect(sent).not.toHaveProperty("bind_hint");
  await until(() => be.pushes.some((p) => p.content === "from the subagent"));
  expect(be.pushes.find((p) => p.content === "from the subagent")!.meta).toMatchObject({ from: "fe", via: child, message_id: String(sent.message_id) });
  expect(rows(`SELECT sender, sender_id, via FROM messages WHERE id = ?`, sent.message_id)).toEqual([{ sender: "fe", sender_id: child, via: child }]);
  // The root's own DM carries none, stored or shown.
  const own = await fe.call("dm_send", { to: "be", body: "from the root" });
  await until(() => be.pushes.some((p) => p.content === "from the root"));
  expect(be.pushes.find((p) => p.content === "from the root")!.meta).not.toHaveProperty("via");
  expect(rows(`SELECT sender_id, via FROM messages WHERE id = ?`, own.message_id)).toEqual([{ sender_id: root, via: null }]);

  // Every read the recipient and the root have shows via on the child's message alone.
  const history = (await be.call("dm_history", { peer: "fe" })) as { id: number; via?: string }[];
  expect(history.map((m) => [m.id, m.via])).toEqual([[sent.message_id, child], [own.message_id, undefined]]);
  expect(history[1]).not.toHaveProperty("via");
  expect(((await fe.call("dm_history", { peer: "be" })) as { via?: string }[]).map((m) => m.via)).toEqual([child, undefined]);
  expect(await be.call("dm_thread", { thread: sent.message_id })).toEqual([expect.objectContaining({ id: sent.message_id, via: child })]);
  const owed = (await be.call("dm_inbox", {})).unanswered as { id: number; from: string; via?: string }[];
  expect(owed.find((m) => m.id === sent.message_id)).toMatchObject({ from: "fe", via: child });
  expect(owed.find((m) => m.id === own.message_id)).not.toHaveProperty("via");

  // The post: authored as the root's primary, stored with the child's ID, pushed and read with via.
  const posted = await asChild<{ post_id: number }>(fe, "reviewer-1", "board_post", { board: "e2e", body: "subagent post" });
  await until(() => be.pushes.some((p) => p.content === "subagent post"));
  expect(be.pushes.find((p) => p.content === "subagent post")!.meta).toMatchObject({ board: "e2e", from: "fe", via: child, post_id: String(posted.post_id) });
  expect(rows(`SELECT author, author_id, via FROM posts WHERE id = ?`, posted.post_id)).toEqual([{ author: "fe", author_id: child, via: child }]);
  await fe.call("board_post", { board: "e2e", body: "root post" });
  await until(() => be.pushes.some((p) => p.content === "root post"));
  expect(be.pushes.find((p) => p.content === "root post")!.meta).not.toHaveProperty("via");

  // A claim's announcement and its release are the child's posts too; the claim is the root's primary's.
  await asChild(fe, "reviewer-1", "claim_take", { key: "ticket:ENG-142", board: "e2e" });
  expect(rows(`SELECT holder FROM claims WHERE key = 'ticket:ENG-142'`)).toEqual([{ holder: "fe" }]);
  await asChild(fe, "reviewer-1", "claim_release", { key: "ticket:ENG-142" });
  const read = (await be.call("board_read", { board: "e2e", limit: 10 })).posts as { id: number; author: string; body: string; via?: string }[];
  expect(read.map((p) => [p.body, p.author, p.via])).toEqual([
    ["subagent post", "fe", child],
    ["root post", "fe", undefined],
    ["[claim] ticket:ENG-142", "fe", child],
    ["[release] ticket:ENG-142", "fe", child],
  ]);
  expect(read[1]).not.toHaveProperty("via");

  // The first sight was audited once, however many calls the child made.
  expect(childSeen()).toEqual([{ actor: root, target: child, detail: { child, root, raw: "reviewer-1", pid: pidOfId(root), liveness_pid: pidOfId(root) } }]);
  // A second subagent is a second child.
  const other = (await asChild<Who>(fe, "reviewer-2", "whoami")).id;
  expect(other).not.toBe(child);
  expect(childSeen().map((r) => r.detail.raw)).toEqual(["reviewer-1", "reviewer-2"]);
}, 30_000);

test("a child's bind and unbind are refused child_session; its raw ID must be 1–1024 characters with no control characters", async () => {
  const fe = await session("fe");
  const root = (await fe.call("whoami")).id as string;
  const refused = `error: child_session: this session acts under its root ${root}; bind and unbind are the root's. Call them from the root session.`;
  expect(await childRefusal(fe, "reviewer-1", "bind", { name: "qa", create: true })).toBe(refused);
  expect(await childRefusal(fe, "reviewer-1", "unbind", { name: "fe" })).toBe(refused);
  // The root's names are untouched.
  expect(await fe.call("whoami")).toMatchObject({ id: root, primary: "fe", aliases: ["fe"] });
  expect(rows(`SELECT address, id FROM alias_holds`)).toEqual([{ address: "fe", id: root }]);

  const invalid = `error: _meta["${GRAYBOARD_AGENT_META}"] must be a string of 1 to 1024 characters with no control characters`;
  for (const raw of ["", "bad\nid", "tab\tid", "del\x7f", "x".repeat(1025), 42, null, { id: "x" }]) {
    expect(await childRefusal(fe, raw, "dm_send", { to: "fe", body: "never" })).toBe(invalid);
  }
  expect(rows(`SELECT 1 FROM messages`)).toEqual([]);
  // Only the valid one is a child: first sight registers it whatever the call, so its refused bind did.
  expect(childSeen().map((r) => r.detail.raw)).toEqual(["reviewer-1"]);
  // The longest valid raw ID is a child.
  expect(await asChild(fe, "x".repeat(1024), "whoami")).toMatchObject({ root, child: true });
  expect(childSeen()).toHaveLength(2);
}, 30_000);

test("a DM or @mention to a child's ID is refused child_session naming its root's primary; the child ends with its root and stays refused", async () => {
  const be = await session("be");
  await be.call("board_create", { name: "e2e", purpose: "fixtures" });
  const fe = await session("fe");
  const root = (await fe.call("whoami")).id as string;
  const child = (await asChild<Who>(fe, "reviewer-1", "whoami")).id;
  const refused = `error: child_session: ${child} is a subagent acting under session ${root} and receives nothing; send to fe`;

  expect(await refusal(be, "dm_send", { to: child, body: "to the subagent" })).toBe(refused);
  expect(await refusal(be, "board_post", { board: "e2e", body: `@${child} look` })).toBe(refused);
  expect(await refusal(be, "board_post", { board: "e2e", body: `@${child.toUpperCase()} look` })).toBe(refused);
  // Nor can the child's sibling reach it by its ID.
  const sibling = (await asChild<Who>(fe, "reviewer-2", "whoami")).id;
  expect(await childRefusal(fe, "reviewer-2", "dm_send", { to: child, body: "sibling" })).toBe(refused);
  expect(rows(`SELECT 1 FROM messages`)).toEqual([]);
  expect(rows(`SELECT 1 FROM posts`)).toEqual([]);
  // peer_list never offers it as an address.
  const listed = JSON.stringify(await be.call("peer_list", {}));
  expect(listed).not.toContain(child);

  // Another process's read of live sessions leaves a live root's child alone: it is judged by its root, never by its own row.
  const qa = await session("qa");
  await qa.call("peer_list", {});
  expect(await runCli(["claims"], { cwd: dir, env: localEnv(dir) })).toMatchObject({ code: 0 });
  expect(endedAt(child)).toBeNull();
  await asChild(fe, "reviewer-1", "dm_send", { to: "be", body: "still here" });
  await until(() => be.pushes.some((p) => p.content === "still here"));

  // Its root's end ends it, audited on both.
  await stopSession(fe.c);
  await until(() => endedAt(root) !== null && endedAt(child) !== null);
  const ended = rows<{ target: string; detail: string }>(`SELECT target, detail FROM audit_log WHERE action = 'id.ended' AND target IN (?, ?) ORDER BY rowid`, root, child)
    .map((r) => ({ target: r.target, detail: JSON.parse(r.detail) }));
  expect(ended.map((r) => r.target)).toEqual([child, root]);
  expect(ended[1]!.detail).toMatchObject({ held: ["fe"], children: [child, sibling].sort() });
  expect(ended[0]!.detail).toMatchObject({ held: [], why: `its root ${root} ended` });
  expect(ended[0]!.detail).not.toHaveProperty("children");
  // Their copies of its liveness row (#539) went in the same end.
  expect(rows(`SELECT session_id FROM bindings WHERE session_id IN (?, ?, ?)`, root, child, sibling)).toEqual([]);
  // Ended or not, a child's ID is never an address: still child_session, naming the name its root held.
  expect(await refusal(be, "dm_send", { to: child, body: "after" })).toBe(refused);
  expect(await refusal(be, "board_post", { board: "e2e", body: `@${child} after` })).toBe(refused);
}, 30_000);

// #539: v2.0.0–v2.3.1 end, on every open, each unended ID with no bindings
// row (their ORPHAN_SQL, src/local/binding.ts:286). A child's liveness row is
// a copy of its root's (registerChild), so the last of them, sharing the bus,
// finds the child live: at its own start, at its peer_list, and in a CLI run
// while the root's grayboard restarts under its harness. The child keeps
// working as the same ID, and neither version lists it.
const CHILDLESS_SWEEP = "v2.3.1";
const endWhy = (id: string) => rows<{ detail: string }>(`SELECT detail FROM audit_log WHERE action = 'id.ended' AND target = ?`, id).map((r) => JSON.parse(r.detail).why);

test(`${CHILDLESS_SWEEP} sharing the bus leaves a live root's child live through the root's keyed restart; the root's end ends it and drops its row`, async () => {
  const old = await releaseBinaries(CHILDLESS_SWEEP);
  let fe = await localSession(dir, "fe", { extra: { BUS_SESSION_KEY: mintSessionKey(), ...pauseEnv("attach:before-txn") } });
  const root = (await fe.call("whoami")).id as string;
  const child = (await asChild<Who>(fe, "reviewer-1", "whoami")).id;
  // The release's grayboard mcp (an older Claude Code plugin) starts on the bus, then lists peers.
  const be = await localSession(dir, "be", { bin: old.cli });
  expect(JSON.stringify(await be.call("peer_list", {}))).not.toContain(child);
  const sent = await asChild<Sent>(fe, "reviewer-1", "dm_send", { to: "be", body: "after the sweep" });
  expect(rows(`SELECT sender_id, via FROM messages WHERE id = ?`, sent.message_id)).toEqual([{ sender_id: child, via: child }]);

  // The root's grayboard crashes and restarts under its live harness; the release's CLI opens the bus while it's down.
  const restarted = fe.restart("crash");
  await until(() => fe.stderr().includes("test pause hit: attach:before-txn"));
  expect(await runCli(["claims"], { bin: old.cli, cwd: dir, env: localEnv(dir) })).toMatchObject({ code: 0 });
  release("attach:before-txn");
  fe = await restarted;
  // The restarted root resolves the subagent anew: the same child, live, listed by neither version.
  expect(await asChild<Who>(fe, "reviewer-1", "whoami")).toMatchObject({ id: child, root, child: true });
  expect(endedAt(child)).toBeNull();
  expect(JSON.stringify(await fe.call("peer_list", {}))).not.toContain(child);
  expect(JSON.stringify(await be.call("peer_list", {}))).not.toContain(child);
  // Its liveness row is its root's process (the harness): no name, no process of its own.
  expect(rows(`SELECT name, pid, harness_rule, attached_pid FROM bindings WHERE session_id = ?`, child)).toEqual([{ name: null, pid: fe.harnessPid, harness_rule: "ancestor", attached_pid: null }]);

  // The root ends when its harness exits (found by this tree's next open): the child with it, and its row goes.
  await stopSession(be.c);
  await stopSession(fe.c);
  expect(await runCli(["claims"], { cwd: dir, env: localEnv(dir) })).toMatchObject({ code: 0 });
  expect(endedAt(root)).not.toBeNull();
  expect(endWhy(child)).toEqual([`its root ${root} ended`]);
  expect(rows(`SELECT session_id FROM bindings WHERE session_id IN (?, ?)`, root, child)).toEqual([]);
}, 120_000);

test(`${CHILDLESS_SWEEP} ends a dead root's child with it: the child's row is its root's process`, async () => {
  const old = await releaseBinaries(CHILDLESS_SWEEP);
  const fe = await session("fe");
  const root = (await fe.call("whoami")).id as string;
  const child = (await asChild<Who>(fe, "reviewer-1", "whoami")).id;
  const [{ pid }] = rows(`SELECT pid FROM bindings WHERE session_id = ?`, child) as { pid: number }[];
  await sigkill(pidOfId(root));
  expect(await runCli(["claims"], { bin: old.cli, cwd: dir, env: localEnv(dir) })).toMatchObject({ code: 0 });
  expect(endedAt(root)).not.toBeNull();
  expect(endWhy(child)).toEqual([`reaped: pid ${pid} is gone`]);
  expect(rows(`SELECT session_id FROM bindings WHERE session_id IN (?, ?)`, root, child)).toEqual([]);
}, 120_000);

// The root's read state, as the rows a read or an ack would move.
const readState = () => ({
  subscriptions: rows(`SELECT handle, board, mode, cursor, notified_id FROM subscriptions ORDER BY handle, board`),
  mutes: rows(`SELECT * FROM thread_mutes ORDER BY root_id`),
  outbox: rows(`SELECT handle, post_id, delivered_at FROM outbox ORDER BY handle, post_id`),
  cursors: rows(`SELECT reader, last_seen_id FROM cursors ORDER BY reader`),
  acks: rows(`SELECT reader, message_id FROM dm_acks ORDER BY reader, message_id`),
  messages: rows(`SELECT id, delivered_at FROM messages ORDER BY id`),
});

test("a child reads its root's boards and mail without consuming them; dm_inbox, dm_ack and board_subscribe are its root's", async () => {
  const be = await session("be");
  await be.call("board_create", { name: "e2e", purpose: "fixtures" });
  const fe = await session("fe");
  await fe.call("board_subscribe", { board: "e2e", mode: "digest" });
  const child = (await asChild<Who>(fe, "reviewer-1", "whoami")).id;
  const first = await be.call("board_post", { board: "e2e", body: "unread one" });
  const sent = await be.call("dm_send", { to: "fe", body: "owed by the root" });
  // The DM's push has been handed over and its cursor moved.
  await until(() => rows<{ last_seen_id: number }>(`SELECT last_seen_id FROM cursors WHERE reader = 'fe'`)[0]?.last_seen_id === sent.message_id);
  const unread = async () => ((await fe.call("board_list", {})) as { name: string; unread: number }[]).find((b) => b.name === "e2e")!.unread;
  const inbox = async () => ((await fe.call("dm_inbox", {})).unanswered as { id: number; body: string }[]).map((m) => [m.id, m.body]);
  const owed = await inbox();
  expect(owed).toEqual([[sent.message_id, "owed by the root"]]);
  expect(await unread()).toBe(1);
  const before = readState();

  // Its default board_read is the latest page with no unread view; thread and before_id read as usual.
  expect(await asChild(fe, "reviewer-1", "board_read", { board: "e2e" })).toMatchObject({ posts: [{ id: first.post_id, body: "unread one" }], unread_remaining: 0 });
  expect(await asChild(fe, "reviewer-1", "board_read", { board: "e2e", thread: first.post_id })).toMatchObject({ posts: [{ id: first.post_id }] });
  expect(await asChild(fe, "reviewer-1", "board_read", { board: "e2e", before_id: first.post_id + 1 })).toMatchObject({ posts: [{ id: first.post_id }] });
  // dm_history and dm_thread are its.
  expect((await asChild<{ id: number }[]>(fe, "reviewer-1", "dm_history", { peer: "be" })).map((m) => m.id)).toEqual([sent.message_id]);
  expect((await asChild<{ id: number }[]>(fe, "reviewer-1", "dm_thread", { thread: sent.message_id })).map((m) => m.id)).toEqual([sent.message_id]);
  // dm_inbox and dm_ack are the root's.
  const refused = `error: child_session: ${child} is a subagent of fe; its root owns this inbox. dm_thread a thread you wrote to see its replies.`;
  expect(await childRefusal(fe, "reviewer-1", "dm_inbox")).toBe(refused);
  expect(await childRefusal(fe, "reviewer-1", "dm_ack", { message_id: sent.message_id })).toBe(refused);
  expect(await childRefusal(fe, "reviewer-1", "dm_ack", { message_id: [sent.message_id] })).toBe(refused);
  // So are its board subscriptions and thread mutes.
  const subs = `error: child_session: ${child} is a subagent of fe; its root owns its board subscriptions and thread mutes. board_read reads a board without marking anything read.`;
  expect(await childRefusal(fe, "reviewer-1", "board_subscribe", { board: "e2e", mode: "push" })).toBe(subs);
  expect(await childRefusal(fe, "reviewer-1", "board_subscribe", { board: "e2e", mode: "off" })).toBe(subs);
  expect(await childRefusal(fe, "reviewer-1", "board_subscribe", { board: "e2e", mode: "off", thread: first.post_id })).toBe(subs);

  // Nothing the child did moved the root's read state.
  expect(readState()).toEqual(before);
  expect(await unread()).toBe(1);
  expect(await inbox()).toEqual(owed);
  // The root's own read takes its unread post.
  expect(await fe.call("board_read", { board: "e2e" })).toMatchObject({ posts: [{ id: first.post_id }], unread_remaining: 0 });
  expect(await unread()).toBe(0);
}, 30_000);

test("a child's results carry none of its root's notices: no bind hint, no fresh instructions", async () => {
  const s = await session();
  const raw = await childCall(s, "reviewer-1", "dm_send", { to: (await s.call("whoami")).id, body: "from the subagent" });
  expect(raw.isError).toBeFalsy();
  expect(raw.structuredContent).toBeUndefined();
  expect(JSON.parse((raw.content as { text: string }[])[0]!.text)).not.toHaveProperty("bind_hint");
  // The hint is still the root's for its first write.
  expect(await s.call("claim_take", { key: "ticket:ENG-1" })).toHaveProperty("bind_hint");
  // A bind makes the root's next result carry fresh instructions; a child's call neither gets nor takes them.
  await s.call("bind", { name: "fe", create: true });
  const after = await childCall(s, "reviewer-1", "whoami");
  expect(after.structuredContent).toBeUndefined();
  expect(after.content).toHaveLength(1);
}, 30_000);

// #523 audit 6: a child's delegate request and refusal name the child in
// their audit rows, under `child`, beside the routing `via`; a root's name none.
test("a child's delegation audit rows name the child; the root's don't", async () => {
  await localSession(dir, "be", { extra: { BUS_LAUNCHER: "1" } });
  await session("ad"); // live, not a launcher
  const fe = await session("fe");
  const child = (await asChild<Who>(fe, "reviewer-1", "whoami")).id;
  const task = { persona: "a reviewer", task: "review the diff" };
  const sent = await asChild<Sent>(fe, "reviewer-1", "delegate", task);
  expect(await childRefusal(fe, "reviewer-1", "delegate", { ...task, to: "ad" })).toContain("isn't a launcher session");
  const own = await fe.call("delegate", { ...task, task: "the root's own" });
  const audits = rows<{ action: string; actor: string; target: string | null; detail: string }>(`SELECT action, actor, target, detail FROM audit_log WHERE action LIKE 'delegation.%' ORDER BY rowid`)
    .map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
  expect(audits).toEqual([
    { action: "delegation.requested", actor: "fe", target: "be", detail: { via: "auto", message_id: sent.message_id, child } },
    { action: "delegation.refused", actor: "fe", target: null, detail: { reason: expect.stringContaining("isn't a launcher session"), child } },
    { action: "delegation.requested", actor: "fe", target: "be", detail: { via: "auto", message_id: own.message_id } },
  ]);
  // The request is the child's DM, as any it sends.
  expect(rows(`SELECT sender, sender_id, via FROM messages WHERE id = ?`, sent.message_id)).toEqual([{ sender: "fe", sender_id: child, via: child }]);
}, 30_000);

test("a child's post and claim announcement are its root's own: none of the root's names is pushed one or shown it unread; others get them with via", async () => {
  const be = await session("be");
  await be.call("board_create", { name: "e2e", purpose: "fixtures" });
  await be.call("board_create", { name: "ops", purpose: "digests" });
  await be.call("board_subscribe", { board: "e2e", mode: "push" });
  const fe = await session("fe");
  await fe.call("board_subscribe", { board: "e2e", mode: "push" });
  await fe.call("board_subscribe", { board: "ops", mode: "digest" });
  await fe.call("bind", { name: "qa", create: true });
  const root = (await fe.call("whoami")).id as string;
  const child = (await asChild<Who>(fe, "reviewer-1", "whoami")).id;
  // As the root's other name, so the subscribed name isn't the author.
  const posted = await asChild<{ post_id: number; notified: string[] }>(fe, "reviewer-1", "board_post", { board: "e2e", body: "subagent post", as: "qa" });
  expect(posted.notified).toEqual(["be"]);
  await asChild(fe, "reviewer-1", "board_post", { board: "ops", body: "subagent digest", as: "qa" });
  await asChild(fe, "reviewer-1", "claim_take", { key: "ticket:ENG-7", board: "e2e", as: "qa" });
  await until(() => be.pushes.some((p) => p.content === "[claim] ticket:ENG-7"));
  for (const body of ["subagent post", "[claim] ticket:ENG-7"]) expect(be.pushes.find((p) => p.content === body)!.meta).toMatchObject({ from: "qa", via: child });

  // None of the root's addresses was queued a push or counts one unread.
  expect(rows(`SELECT DISTINCT handle FROM outbox`)).toEqual([{ handle: "be" }]);
  const unread = async () => Object.fromEntries(((await fe.call("board_list", {})) as { name: string; unread: number }[]).filter((b) => b.name !== "announce").map((b) => [b.name, b.unread]));
  expect(await unread()).toEqual({ e2e: 0, ops: 0 });
  expect(fe.pushes.filter((p) => p.meta.via !== undefined)).toEqual([]);
  expect(rows(`SELECT 1 FROM outbox WHERE handle IN ('fe', 'qa', ?)`, root)).toEqual([]);
  // Another session's post is the root's to read, as before.
  await be.call("board_post", { board: "ops", body: "from be" });
  expect(await unread()).toEqual({ e2e: 0, ops: 1 });
}, 30_000);
