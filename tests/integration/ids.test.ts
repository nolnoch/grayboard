// Session IDs as recipients over real local-mode processes (#284 PR 2 S4/S6):
// a DM to `id:…` reaches the session whatever name it later binds, an
// unknown or ended ID is refused, and the end settles a send it races.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../support/cli.ts";
import { CLI } from "../support/paths.ts";
import { localEnv } from "../support/env.ts";
import { closeSessions, localSession, type Session } from "../support/mcp.ts";
import { sigkill } from "../support/procs.ts";
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
