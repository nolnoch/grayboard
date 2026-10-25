// Keyed sessions over real local-mode processes (#284 decision 3, PR 2 S2):
// BUS_SESSION_KEY makes a session an attachment to its harness. A child
// restart under the live harness is the same session; the harness's exit
// ends it.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { idAddress, mintSessionKey } from "../../src/core/bindings.ts";
import { closeSessions, localSession, stopSession as stop } from "../support/mcp.ts";
import { until } from "../support/until.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grayboard-key-"));
});

afterEach(async () => {
  await closeSessions();
  rmSync(dir, { recursive: true, force: true });
});

function rows<T>(sql: string, ...args: (string | number)[]): T[] {
  const db = new Database(join(dir, "bus.db"), { readonly: true });
  try {
    return db.prepare(sql).all(...args) as T[];
  } finally {
    db.close();
  }
}

const audit = (action: string, target: string) =>
  rows<{ detail: string | null }>(`SELECT detail FROM audit_log WHERE action = ? AND target = ? ORDER BY rowid`, action, target).map((r) => JSON.parse(r.detail ?? "null"));
const binding = (id: string) =>
  rows<{ pid: number; harness_rule: string | null; attached_pid: number | null; detached_at: number | null }>(
    `SELECT pid, harness_rule, attached_pid, detached_at FROM bindings WHERE session_id = ?`, id,
  )[0];
const pauseEnv = (point: string) => ({ BUS_TEST_PAUSE: point, BUS_TEST_PAUSE_FILE: join(dir, `go-${point}`) });
const release = (point: string) => writeFileSync(join(dir, `go-${point}`), "");
// A launcher between the harness and grayboard: the harness is found past it.
// (Restart tests don't use it: the stand-in harness would kill the shell,
// orphaning grayboard on the harness's own stdin, which never closes.)
const SH = ["sh", "-c", `"$@"; exit $?`, "sh", process.execPath];

test("a SIGKILLed child restarted under its live harness re-attaches: same ID, name, status and queued mail, no bounce", async () => {
  const key = mintSessionKey();
  const id = idAddress(key);
  let s = await localSession(dir, undefined, { extra: { BUS_SESSION_KEY: key, ...pauseEnv("attach:before-txn") } });
  const peer = await localSession(dir, "fe");
  await s.call("bind", { name: "api", create: true });
  await s.call("peer_status", { text: "mid-task" });
  // Liveness is the harness's, with this child attached.
  const first = binding(id)!;
  expect(first).toMatchObject({ pid: s.harnessPid, harness_rule: "ancestor", detached_at: null });
  expect(audit("id.registered", id)).toEqual([expect.objectContaining({ keyed: true, harness_rule: "ancestor", harness_pid: s.harnessPid })]);

  // Down between the crash and the attach: mail to its name waits.
  const restarted = s.restart("crash");
  await until(() => s.stderr().includes("test pause hit: attach:before-txn"));
  await peer.call("dm_send", { to: "api", body: "while down" });
  release("attach:before-txn");
  s = await restarted;

  expect(s.c.getInstructions()).toStartWith(`You are identity "api"`);
  await until(() => s.pushes.some((p) => p.content === "while down"));
  expect(rows<{ id: string }>(`SELECT id FROM alias_holds WHERE address = 'api'`)).toEqual([{ id }]);
  expect(rows<{ status: string; ended_at: number | null }>(`SELECT status, ended_at FROM ids WHERE id = ?`, id)).toEqual([{ status: "mid-task", ended_at: null }]);
  const now = binding(id)!;
  expect(now.pid).toBe(first.pid);
  expect(now.attached_pid).not.toBe(first.attached_pid);
  expect(audit("id.reattached", id)).toEqual([{ old_pid: first.attached_pid, new_pid: now.attached_pid, harness_pid: s.harnessPid }]);
  expect(audit("id.ended", id)).toEqual([]);
  expect(peer.pushes.filter((p) => p.meta.kind === "bounce")).toEqual([]);
}, 30_000);

test("a clean exit under a live harness detaches; the harness's exit ends the session at the next open, and the key is refused", async () => {
  const key = mintSessionKey();
  const id = idAddress(key);
  const s = await localSession(dir, undefined, { extra: { BUS_SESSION_KEY: key } });
  const child = binding(id)!.attached_pid;
  // Closing ends the harness's stdin: the child exits first, while the
  // harness still runs, so it detaches; then the harness exits.
  await stop(s.c);
  expect(audit("id.detached", id)).toEqual([{ pid: child }]);
  expect(rows(`SELECT ended_at FROM ids WHERE id = ? AND ended_at IS NULL`, id)).toHaveLength(1);

  const err = await localSession(dir, undefined, { extra: { BUS_SESSION_KEY: key } }).then(() => "started", (e: Error) => e.message);
  expect(err).toContain(`id_collision: ${id} ended at`);
  expect(audit("id.ended", id)).toHaveLength(1);
  expect(binding(id)).toBeUndefined();
}, 30_000);

test("a key already served by a live process under another harness is refused at once", async () => {
  const key = mintSessionKey();
  const id = idAddress(key);
  const owner = await localSession(dir, undefined, { extra: { BUS_SESSION_KEY: key } });
  const t0 = Date.now();
  const err = await localSession(dir, undefined, { extra: { BUS_SESSION_KEY: key } }).then(() => "started", (e: Error) => e.message);
  expect(err).toContain(`id_collision: ${id} belongs to a session under harness pid ${owner.harnessPid}`);
  // Not the predecessor wait: that's only for a child of the same harness.
  expect(Date.now() - t0).toBeLessThan(4000);
  expect(audit("id.collision", id)).toEqual([expect.objectContaining({ harness_pid: owner.harnessPid })]);
  // The owner is untouched.
  expect(binding(id)).toMatchObject({ pid: owner.harnessPid, detached_at: null });
  await owner.call("peer_list", {});
}, 30_000);

test("a tools-only process sharing a live session's key is refused: it never attaches", async () => {
  const key = mintSessionKey();
  const id = idAddress(key);
  const owner = await localSession(dir, "api", { extra: { BUS_SESSION_KEY: key } });
  const err = await localSession(dir, "api", { extra: { BUS_SESSION_KEY: key, BUS_PUSH: "off" } }).then(() => "started", (e: Error) => e.message);
  expect(err).toContain(`id_collision: ${id} is a live session's; start with a new session key`);
  expect(audit("id.collision", id)).toEqual([expect.objectContaining({ ended_at: null, tools_only: true })]);
  expect(binding(id)).toMatchObject({ pid: owner.harnessPid, detached_at: null });
  expect(rows(`SELECT delivery, ended_at FROM ids WHERE id = ?`, id)).toEqual([{ delivery: "push", ended_at: null }]);
}, 30_000);

test("a session keyed like a live tools-only process is refused: the key is the tools-only process's ID", async () => {
  const key = mintSessionKey();
  const id = idAddress(key);
  const tools = await localSession(dir, "api", { extra: { BUS_SESSION_KEY: key, BUS_PUSH: "off" } });
  const err = await localSession(dir, "api", { extra: { BUS_SESSION_KEY: key } }).then(() => "started", (e: Error) => e.message);
  expect(err).toContain(`id_collision: ${id} is a tools-only session's (pid ${binding(id)!.pid}); start with a new session key`);
  expect(rows(`SELECT delivery, ended_at FROM ids WHERE id = ?`, id)).toEqual([{ delivery: "none", ended_at: null }]);
  await tools.call("peer_list", {});
}, 30_000);

test("the harness is the first ancestor past a launcher, or BUS_HARNESS_PID; a bad key or a harness pid without a key refuses to start", async () => {
  const viaSh = mintSessionKey();
  const sh = await localSession(dir, undefined, { via: SH, extra: { BUS_SESSION_KEY: viaSh } });
  expect(binding(idAddress(viaSh))).toMatchObject({ pid: sh.harnessPid, harness_rule: "ancestor" });

  const key = mintSessionKey();
  const id = idAddress(key);
  await localSession(dir, undefined, { extra: { BUS_SESSION_KEY: key, BUS_HARNESS_PID: String(process.pid) } });
  expect(binding(id)).toMatchObject({ pid: process.pid, harness_rule: "env" });

  const fail = (extra: Record<string, string>) => localSession(dir, undefined, { extra }).then(() => "started", (e: Error) => e.message);
  expect(await fail({ BUS_SESSION_KEY: "abc" })).toContain("BUS_SESSION_KEY must be 64 lowercase hex characters");
  expect(await fail({ BUS_HARNESS_PID: String(process.pid) })).toContain("set BUS_SESSION_KEY with it");
  expect(await fail({ BUS_SESSION_KEY: mintSessionKey(), BUS_HARNESS_PID: "0" })).toContain("BUS_HARNESS_PID must be a process id");
}, 30_000);
