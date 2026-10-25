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

async function sigkill(pid: number): Promise<void> {
  process.kill(pid, "SIGKILL");
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
}

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
  const be = await session("be");
  const s = await session();
  const id = await sessionId(s);
  await sigkill(pidOfId(id));

  // The opener holds the write lock with the ID marked ended.
  const opener = spawnCli(["claims"], pauseEnv("end:in-txn"));
  await until(() => opener.stderr().includes("test pause hit: end:in-txn"));
  const send = refusal(be, "dm_send", { to: id, body: "too late" });
  release("end:in-txn");
  expect(await send).toContain(`id_ended: ${id} ended at`);
  expect(await opener.p.exited).toBe(0);
  expect(be.pushes.filter((p) => p.meta.kind === "bounce")).toEqual([]);
}, 30_000);
