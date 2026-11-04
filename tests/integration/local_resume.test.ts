// #195: selected-conversation restore and retained-child rotation over real
// local stdio consumers. A harness-session ID here exercises the local wire
// contract; actual harness discovery and fresh-process parity live in E2E.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { mintSessionKey } from "../../src/core/bindings.ts";
import { GRAYBOARD_AGENT_META } from "../../src/shared/session_meta.ts";
import { runCli } from "../support/cli.ts";
import { localEnv } from "../support/env.ts";
import { closeSessions, localSession, stopSession, type Push, type Session } from "../support/mcp.ts";
import { CLI } from "../support/paths.ts";
import { sigkill } from "../support/procs.ts";
import { until } from "../support/until.ts";

let dir: string;
const viewers: Bun.Subprocess[] = [];

beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "gb-resume-"))); });
afterEach(async () => {
  // Release a failed race before closing stdio: a synchronous pause cannot
  // read EOF until its file appears.
  for (const point of ["local:tool:in-gate", "bindgate:wait"]) writeFileSync(join(dir, `go-${point}`), "");
  for (const p of viewers.splice(0)) { p.kill("SIGKILL"); await p.exited; }
  await closeSessions();
  rmSync(dir, { recursive: true, force: true });
});

const OWNER = "resume-test-owner";
const session = (conversation: string, identity?: string, extra: Record<string, string> = {}) =>
  localSession(dir, identity, { extra: { BUS_HARNESS_SESSION: conversation, ...extra } });
const adapter = async (conversation: string, identity?: string, extra: Record<string, string> = {}) => {
  const s = await session(conversation, identity, { BUS_ADAPTER_OWNER: OWNER, ...extra });
  await ready(s, 0);
  return s;
};
const pauseEnv = (point: string) => ({ BUS_TEST_PAUSE: point, BUS_TEST_PAUSE_FILE: join(dir, `go-${point}`) });
const release = (point: string) => writeFileSync(join(dir, `go-${point}`), "");

function rows<T>(sql: string, ...args: (string | number)[]): T[] {
  const db = new Database(join(dir, "bus.db"), { readonly: true });
  try { return db.prepare(sql).all(...args) as T[]; }
  finally { db.close(); }
}

const WhoSchema = z.object({ id: z.string(), primary: z.string(), aliases: z.array(z.string()), root: z.string().optional(), child: z.boolean().optional(), writes_as: z.string().optional() }).passthrough();
type Who = z.infer<typeof WhoSchema>;
const ClaimsSchema = z.array(z.object({ key: z.string(), holder: z.string() }).passthrough());
const who = async (s: Session): Promise<Who> => WhoSchema.parse(await s.call("whoami"));
const held = (id: string) => rows<{ address: string }>(`SELECT address FROM alias_holds WHERE id = ? ORDER BY bound_at, address`, id).map(r => r.address);
const endedAt = (id: string) => rows<{ ended_at: number | null }>(`SELECT ended_at FROM ids WHERE id = ?`, id)[0]!.ended_at;
const snapshot = (id: string) => z.array(z.string()).parse(JSON.parse(rows<{ held_aliases_json: string }>(`SELECT held_aliases_json FROM ids WHERE id = ?`, id)[0]!.held_aliases_json));
const contents = (s: Session) => s.pushes.map(p => p.content);
const cursor = (reader: string) => rows<{ last_seen_id: number }>(`SELECT last_seen_id FROM cursors WHERE reader = ?`, reader)[0]?.last_seen_id ?? 0;
const delivered = (id: number) => rows<{ delivered_at: number | null }>(`SELECT delivered_at FROM messages WHERE id = ?`, id)[0]!.delivered_at;
const status = (id: string) => rows<{ status: string | null }>(`SELECT status FROM ids WHERE id = ?`, id)[0]!.status;
const activeConversation = (id: string) => rows<{ harness_session: string; local_resume: number; root_id: string | null }>(`SELECT harness_session, local_resume, root_id FROM ids WHERE id = ?`, id)[0]!;

const SelectedSchema = z.object({ id: z.string(), session: z.string(), epoch: z.number().int(), instructions: z.array(z.string()) }).passthrough();
const EmptySchema = z.object({}).passthrough();
const select = (s: Session, conversation: string, epoch: number, owner = OWNER) =>
  s.c.request({ method: "grayboard/session", params: { owner, epoch, session: conversation } }, SelectedSchema);
const ready = (s: Session, epoch: number, owner = OWNER) =>
  s.c.request({ method: "grayboard/session/ready", params: { owner, epoch } }, EmptySchema);
const receipt = (s: Session, p: Push, accepted: boolean, owner = OWNER) => {
  expect(p.meta.grayboard_delivery).toBeString();
  return s.c.request({ method: "grayboard/delivery", params: { owner, token: p.meta.grayboard_delivery, accepted } }, EmptySchema);
};
async function rpcRefused(request: Promise<unknown>, code = ErrorCode.InternalError) {
  let error: unknown;
  try { await request; } catch (caught) { error = caught; }
  expect(error).toMatchObject({ code });
}
async function childWho(s: Session, raw: string): Promise<Who> {
  const result = await s.c.callTool({ name: "whoami", arguments: {}, _meta: { [GRAYBOARD_AGENT_META]: raw } });
  expect(result.isError).toBeFalsy();
  return WhoSchema.parse(JSON.parse((result.content as { text: string }[])[0]!.text));
}

for (const exit of ["clean", "crash"] as const) {
  test(`fresh local child restores ordered multiholds and alias state after ${exit} exit`, async () => {
    const peer = await localSession(dir, "peer");
    const previous = await session(`fresh-${exit}`);
    await previous.call("bind", { name: "zed", create: true });
    await previous.call("bind", { name: "alpha", create: true });
    await previous.call("peer_status", { text: "mid-conversation" });
    await previous.call("board_create", { name: "work", purpose: "resume ownership" });
    await previous.call("board_subscribe", { board: "work", mode: "quiet" });
    await previous.call("claim_take", { key: "resume:alias", as: "alpha", ttl_minutes: 30 });
    const prior = await who(previous);
    expect(prior).toMatchObject({ primary: "zed", aliases: ["zed", "alpha"] });
    if (exit === "clean") await stopSession(previous.c);
    else {
      await sigkill(rows<{ pid: number }>(`SELECT pid FROM bindings WHERE session_id = ?`, prior.id)[0]!.pid);
      // No opener has reaped the row yet.
      expect(endedAt(prior.id)).toBeNull();
    }
    for (const name of prior.aliases) await peer.call("dm_send", { to: name, body: `queued-${name}` });
    if (exit === "crash") expect(endedAt(prior.id)).toBeNull();
    const restored = await session(`fresh-${exit}`);
    expect(restored.harnessPid).not.toBe(previous.harnessPid);
    const current = await who(restored);
    expect(current.id).not.toBe(prior.id);
    expect(current).toMatchObject({ primary: "zed", aliases: ["zed", "alpha"] });
    expect(held(current.id)).toEqual(["zed", "alpha"]);
    expect(endedAt(prior.id)).not.toBeNull();
    expect(snapshot(prior.id)).toEqual(["zed", "alpha"]);
    expect(status(current.id)).toBe("mid-conversation");
    expect(ClaimsSchema.parse(await restored.call("claim_list")).map(c => [c.key, c.holder])).toEqual([["resume:alias", "alpha"]]);
    expect(rows(`SELECT handle, board, mode FROM subscriptions WHERE handle = 'zed'`)).toEqual([{ handle: "zed", board: "work", mode: "quiet" }]);
    await until(() => contents(restored).length === 2);
    expect(contents(restored)).toEqual(["queued-zed", "queued-alpha"]);
    expect(rows(`SELECT session_id, event FROM binding_events WHERE name = 'zed' ORDER BY id`)).toEqual([
      { session_id: prior.id, event: "bound" }, { session_id: prior.id, event: "released" }, { session_id: current.id, event: "bound" },
    ]);
  }, 30_000);
}

test("final unbind's empty snapshot outranks outgoing PID carry and configured identity together", async () => {
  let s = await adapter("empty-selected", "configured");
  await s.call("unbind", { name: "configured" });
  const empty = await who(s);
  expect(empty.aliases).toEqual([]);
  const outgoing = await select(s, "outgoing-conversation", 1);
  expect(snapshot(empty.id)).toEqual([]);
  await ready(s, 1);
  await s.call("bind", { name: "outgoing", create: true });
  await s.call("peer_status", { text: "outgoing-only" });
  const recordPath = join(dir, `bind.${s.harnessPid}`);
  expect(JSON.parse(readFileSync(recordPath, "utf8"))).toMatchObject({ names: ["outgoing"], session_id: outgoing.id });
  // Reconnect retains this harness's outgoing PID record, while its launch
  // environment still selects empty-selected and BUS_IDENTITY=configured.
  s = await s.restart("reconnect");
  await ready(s, 0);
  const resumed = await who(s);
  expect(resumed).toMatchObject({ primary: resumed.id, aliases: [] });
  expect(status(resumed.id)).toBeNull();
  expect(held(outgoing.id)).toEqual([]);
  expect(rows(`SELECT address FROM alias_holds WHERE address IN ('configured', 'outgoing')`)).toEqual([]);
  expect(JSON.parse(readFileSync(recordPath, "utf8"))).toMatchObject({ names: [], session_id: resumed.id });
  await stopSession(s.c);
  const fresh = await session("empty-selected", "configured");
  expect((await who(fresh)).aliases).toEqual([]);
}, 30_000);

test("a live holder refuses the latest snapshot without older/configured fallback or status inheritance", async () => {
  const older = await session("refused", "older");
  await older.call("peer_status", { text: "older-status" });
  await stopSession(older.c);
  const latest = await session("refused");
  await latest.call("unbind", { name: "older" });
  await latest.call("bind", { name: "latest", create: true });
  await latest.call("peer_status", { text: "remembered-status" });
  const remembered = await who(latest);
  await stopSession(latest.c);
  const holder = await localSession(dir, "latest");
  await holder.call("peer_status", { text: "live-owner-status" });
  const owner = await who(holder);
  const resumed = await session("refused", "configured");
  const current = await who(resumed);
  expect(current).toMatchObject({ primary: current.id, aliases: [] });
  expect(status(current.id)).toBeNull();
  expect(status(owner.id)).toBe("live-owner-status");
  expect(snapshot(remembered.id)).toEqual(["latest"]);
  expect(held(owner.id)).toEqual(["latest"]);
  expect(rows(`SELECT address FROM alias_holds WHERE address IN ('older', 'configured')`)).toEqual([]);
  expect(resumed.c.getInstructions()).toContain("latest");
  expect(resumed.c.getInstructions()).toContain(owner.id);
  expect(rows(`SELECT session_id, event FROM binding_events WHERE name = 'latest' ORDER BY id DESC LIMIT 1`)).toEqual([{ session_id: current.id, event: "refused" }]);
  const peer = await localSession(dir, "peer");
  await peer.call("dm_send", { to: "older", body: "older-mail" });
  await peer.call("dm_send", { to: "latest", body: "owner-mail" });
  await peer.call("dm_send", { to: current.id, body: "unbound-barrier" });
  await until(() => contents(resumed).includes("unbound-barrier") && contents(holder).includes("owner-mail"));
  expect(contents(resumed)).toEqual(["unbound-barrier"]);
  expect(cursor("older")).toBe(0);
}, 30_000);

test("a snapshot reacquired after an intervening holder does not inherit that conversation's stale status", async () => {
  const remembered = await session("intervened", "alias");
  await remembered.call("peer_status", { text: "remembered-status" });
  await stopSession(remembered.c);
  const intervening = await localSession(dir, "alias");
  await intervening.call("peer_status", { text: "other-status" });
  await stopSession(intervening.c);
  const resumed = await session("intervened");
  expect((await who(resumed)).aliases).toEqual(["alias"]);
  expect(status((await who(resumed)).id)).toBeNull();
}, 20_000);

test("keyed, human and tools-only roots never become remembered ordinary conversations", async () => {
  const remembered = await session("provenance", "remembered");
  const original = await who(remembered);
  await stopSession(remembered.c);
  const cases: { name: string; extra: Record<string, string>; facts: { keyed: number; delivery: string } }[] = [
    { name: "keyed", extra: { BUS_SESSION_KEY: mintSessionKey() }, facts: { keyed: 1, delivery: "push" } },
    { name: "tools", extra: { BUS_PUSH: "off" }, facts: { keyed: 0, delivery: "none" } },
  ];
  for (const entry of cases) {
    const excluded = await session("provenance", entry.name, entry.extra);
    const own = await who(excluded);
    expect(own.primary).toBe(entry.name);
    expect(rows(`SELECT harness_session, local_resume, keyed, delivery FROM ids WHERE id = ?`, own.id)).toEqual([
      { harness_session: "provenance", local_resume: 0, ...entry.facts },
    ]);
    await stopSession(excluded.c);
  }
  expect((await runCli(["human", "boss"], { cwd: dir, env: localEnv(dir) })).code).toBe(0);
  const human = await session("provenance", "boss", { BUS_HUMAN: "1" });
  const humanId = (await who(human)).id;
  expect(activeConversation(humanId)).toEqual({ harness_session: "provenance", local_resume: 0, root_id: null });
  await stopSession(human.c);
  const resumed = await session("provenance");
  expect((await who(resumed)).aliases).toEqual(["remembered"]);
  expect(snapshot(original.id)).toEqual(["remembered"]);
}, 40_000);

test("a real tail viewer is never eligible to restore an ordinary conversation", async () => {
  const remembered = await session("viewer-conversation", "remembered");
  await remembered.call("board_create", { name: "work", purpose: "viewer provenance" });
  await stopSession(remembered.c);
  const p = Bun.spawn([process.execPath, CLI, "tail", "work"], {
    cwd: dir, env: localEnv(dir, undefined, { BUS_HARNESS_SESSION: "viewer-conversation" }), stdout: "ignore", stderr: "ignore",
  });
  viewers.push(p);
  await until(() => rows(`SELECT i.id FROM ids i JOIN bindings b ON b.session_id = i.id WHERE i.viewer = 1 AND b.pid = ?`, p.pid).length === 1);
  const [viewer] = rows<{ id: string; local_resume: number }>(`SELECT i.id, i.local_resume FROM ids i JOIN bindings b ON b.session_id = i.id WHERE i.viewer = 1 AND b.pid = ?`, p.pid);
  expect(viewer!.local_resume).toBe(0);
  p.kill("SIGINT");
  expect(await p.exited).toBe(0);
  viewers.splice(viewers.indexOf(p), 1);
  expect(endedAt(viewer!.id)).not.toBeNull();
  const resumed = await session("viewer-conversation");
  expect((await who(resumed)).aliases).toEqual(["remembered"]);
}, 20_000);

test("runner discovery remains available, but fallback and promoted runner roots stay excluded", async () => {
  // The test process is every stand-in's ancestor, matching existing runner
  // consumer tests without mutating a process row to manufacture ancestry.
  const root = await session("runner-parent", "parent", {
    BUS_SESSION_KEY: mintSessionKey(), BUS_HARNESS_PID: String(process.pid),
  });
  const parent = await who(root);
  expect(activeConversation(parent.id)).toEqual({ harness_session: "runner-parent", local_resume: 0, root_id: null });
  const runner = await session("runner-selected", undefined, { BUS_ADAPTER_OWNER: OWNER, BUS_PARENT_SESSION: "runner-parent" });
  const child = await who(runner);
  expect(child).toMatchObject({ root: parent.id, child: true, primary: "parent" });
  expect(activeConversation(child.id)).toEqual({ harness_session: "runner-selected", local_resume: 0, root_id: parent.id });
  await rpcRefused(select(runner, "forbidden-before-promotion", 1));
  await runner.call("bind", { name: "runner-alias", create: true });
  const promoted = await who(runner);
  expect(promoted.id).not.toBe(child.id);
  expect(promoted.aliases).toEqual(["runner-alias"]);
  expect(activeConversation(promoted.id)).toEqual({ harness_session: "runner-selected", local_resume: 0, root_id: null });
  await rpcRefused(select(runner, "forbidden-after-promotion", 1));
  await stopSession(runner.c);
  expect(snapshot(promoted.id)).toEqual(["runner-alias"]);
  const ordinary = await session("runner-selected");
  expect((await who(ordinary)).aliases).toEqual([]);
  const fallback = await session("fallback-selected", undefined, { BUS_ADAPTER_OWNER: OWNER, BUS_PARENT_SESSION: "absent-parent" });
  const own = await who(fallback);
  expect(own.root).toBeUndefined();
  expect(activeConversation(own.id)).toEqual({ harness_session: "fallback-selected", local_resume: 0, root_id: null });
  expect(rows(`SELECT target FROM audit_log WHERE action = 'id.child_fallback' AND actor = ?`, own.id)).toEqual([{ target: own.id }]);
  await fallback.call("bind", { name: "fallback-alias", create: true });
  await rpcRefused(select(fallback, "forbidden-fallback", 1));
  await stopSession(fallback.c);
  const afterFallback = await session("fallback-selected");
  expect((await who(afterFallback)).aliases).toEqual([]);
}, 40_000);

test("root selection isolates remembered holds and ID state, same-ID is a no-op, and owner/epoch fences reject stale selection", async () => {
  const rememberedB = await session("conversation-b", "b-name");
  await rememberedB.call("bind", { name: "b-extra", create: true });
  await rememberedB.call("peer_status", { text: "b-status" });
  await stopSession(rememberedB.c);
  const s = await adapter("conversation-a");
  await s.call("board_create", { name: "work", purpose: "root state isolation" });
  const a = await who(s);
  await s.call("board_subscribe", { board: "work", mode: "quiet" });
  await s.call("bind", { name: "a-name", create: true });
  await s.call("bind", { name: "a-extra", create: true });
  await s.call("claim_take", { key: "a:alias", as: "a-name", ttl_minutes: 30 });
  await s.call("claim_take", { key: "a:id", as: a.id, ttl_minutes: 30 });
  await s.call("board_create", { name: "alias-work", purpose: "alias-owned state" });
  const childA = await childWho(s, "reviewer");
  const before = rows(`SELECT id, started_at, ended_at FROM ids WHERE id = ?`, a.id);
  const beforeEvents = rows(`SELECT session_id, name, event FROM binding_events ORDER BY id`);
  await rpcRefused(select(s, "conversation-b", 1, "not-owner"));
  await rpcRefused(select(s, "conversation-b", 0));
  await expect(select(s, "conversation-b", -1)).rejects.toThrow();
  await expect(select(s, "conversation-b", 1.5)).rejects.toThrow();
  expect(activeConversation(a.id).harness_session).toBe("conversation-a");
  const same = await select(s, "conversation-a", 1);
  expect(same).toMatchObject({ id: a.id, session: "conversation-a", epoch: 1 });
  expect(same.instructions.length).toBeGreaterThan(0);
  expect(rows(`SELECT id, started_at, ended_at FROM ids WHERE id = ?`, a.id)).toEqual(before);
  expect(rows(`SELECT session_id, name, event FROM binding_events ORDER BY id`)).toEqual(beforeEvents);
  await ready(s, 1);
  expect(await childWho(s, "reviewer")).toEqual(childA);
  const b = await select(s, "conversation-b", 2);
  expect(b.id).not.toBe(a.id);
  expect(b).toMatchObject({ session: "conversation-b", epoch: 2 });
  expect(endedAt(a.id)).not.toBeNull();
  expect(endedAt(childA.id)).not.toBeNull();
  expect(snapshot(a.id)).toEqual(["a-name", "a-extra"]);
  expect(held(b.id)).toEqual(["b-name", "b-extra"]);
  expect(status(b.id)).toBe("b-status");
  expect(rows(`SELECT key, holder FROM claims ORDER BY key`)).toEqual([{ key: "a:alias", holder: "a-name" }]);
  expect(rows(`SELECT handle FROM subscriptions WHERE board = 'alias-work' ORDER BY handle`)).toEqual([{ handle: "a-name" }]);
  expect(rows(`SELECT handle FROM subscriptions WHERE board = 'work'`)).toEqual([]);
  await rpcRefused(ready(s, 1));
  await rpcRefused(ready(s, 2, "not-owner"));
  await rpcRefused(select(s, "conversation-a", 1));
  await rpcRefused(select(s, "conversation-a", 2));
  expect(activeConversation(b.id).harness_session).toBe("conversation-b");
  await ready(s, 2);
  expect((await who(s)).aliases).toEqual(["b-name", "b-extra"]);
  const childB = await childWho(s, "reviewer");
  expect(childB).toMatchObject({ root: b.id, child: true });
  expect(childB.id).not.toBe(childA.id);
  // The adapter transition is not a model-visible tool. A child cannot
  // request root association by presenting tool arguments or attribution.
  expect((await s.c.listTools()).tools.map(t => t.name)).not.toContain("grayboard/session");
  await rpcRefused(s.c.callTool({ name: "grayboard/session", arguments: { owner: OWNER, epoch: 3, session: "conversation-a" }, _meta: { [GRAYBOARD_AGENT_META]: "reviewer" } }));
  await rpcRefused(s.c.request({ method: "grayboard/session", params: { owner: OWNER, epoch: 3, session: "conversation-a", _meta: { [GRAYBOARD_AGENT_META]: "reviewer" } } }, SelectedSchema));
  expect((await who(s)).id).toBe(b.id);
  const fresh = await select(s, "new-conversation", 3);
  await ready(s, 3);
  expect((await who(s)).aliases).toEqual(["b-name", "b-extra"]);
  expect(activeConversation(fresh.id).harness_session).toBe("new-conversation");
  const aAgain = await select(s, "conversation-a", 4);
  await ready(s, 4);
  expect(aAgain.id).not.toBe(a.id);
  expect((await who(s)).aliases).toEqual(["a-name", "a-extra"]);
  expect(ClaimsSchema.parse(await s.call("claim_list")).map(c => c.key)).toEqual(["a:alias"]);
  expect(rows(`SELECT id FROM ids WHERE local_resume = 1 AND harness_session = 'conversation-a' AND ended_at IS NULL`)).toEqual([{ id: aAgain.id }]);
}, 40_000);

test("a held tool finishes as the outgoing root; selection fences later calls until refreshed guidance is ready", async () => {
  const rememberedB = await session("held-b", "b-name");
  await stopSession(rememberedB.c);
  const peer = await localSession(dir, "peer");
  const s = await adapter("held-a", "a-name", pauseEnv("local:tool:in-gate"));
  const [a] = rows<{ id: string }>(`SELECT id FROM ids WHERE harness_session = 'held-a' AND ended_at IS NULL`);
  const active = s.call("dm_send", { to: "peer", body: "held-before-switch" });
  await until(() => s.stderr().includes("test pause hit: local:tool:in-gate"));
  const selecting = select(s, "held-b", 2);
  // An immediately rejected control request is a wire barrier: the earlier
  // selection handler has closed the gate, but cannot end its active call.
  await rpcRefused(ready(s, 99));
  expect(endedAt(a!.id)).toBeNull();
  expect(rows(`SELECT id FROM messages WHERE body = 'held-before-switch'`)).toEqual([]);
  const later = s.c.callTool({ name: "dm_send", arguments: { to: "peer", body: "held-after-switch" }, _meta: { [GRAYBOARD_AGENT_META]: "reviewer" } });
  await rpcRefused(ready(s, 99));
  release("local:tool:in-gate");
  await active;
  const b = await selecting;
  expect(b.instructions.join("\n")).toContain("b-name");
  expect(rows(`SELECT sender, sender_id, via FROM messages WHERE body = 'held-before-switch'`)).toEqual([{ sender: "a-name", sender_id: a!.id, via: null }]);
  expect(rows(`SELECT id FROM messages WHERE body = 'held-after-switch'`)).toEqual([]);
  expect(snapshot(a!.id)).toEqual(["a-name"]);
  await ready(s, 2);
  expect((await later).isError).toBeFalsy();
  const child = await childWho(s, "reviewer");
  expect(rows(`SELECT sender, sender_id, via FROM messages WHERE body = 'held-after-switch'`)).toEqual([{ sender: "b-name", sender_id: child.id, via: child.id }]);
  expect(child.root).toBe(b.id);
  await until(() => contents(peer).includes("held-before-switch") && contents(peer).includes("held-after-switch"));
}, 30_000);

test("an outstanding delivery receipt fences selection; a decline preserves mail until its conversation resumes", async () => {
  const previousB = await session("receipt-b", "b-name");
  await previousB.call("claim_take", { key: "b:guidance", ttl_minutes: 30 });
  await stopSession(previousB.c);
  const peer = await localSession(dir, "peer");
  const s = await adapter("receipt-a", "a-name");
  const a = await who(s);
  const sent = await peer.call("dm_send", { to: "a-name", body: "declined-in-a" });
  await until(() => s.pushes.length === 1);
  const declined = s.pushes[0]!;
  expect(declined.meta).toMatchObject({ grayboard_session: "receipt-a", grayboard_epoch: "0", message_id: String(sent.message_id) });
  const selecting = select(s, "receipt-b", 1);
  // Both selections enter while epoch zero is current; only the first may commit.
  const duplicate = rpcRefused(select(s, "must-not-be-selected", 1));
  await rpcRefused(ready(s, 99));
  expect(endedAt(a.id)).toBeNull();
  expect(cursor("a-name")).toBe(0);
  expect(delivered(sent.message_id)).toBeNull();
  await rpcRefused(receipt(s, declined, true, "not-owner"));
  // Receipt handling must bypass BindGate, otherwise both requests deadlock.
  await receipt(s, declined, false);
  const b = await selecting;
  await duplicate;
  expect(rows(`SELECT id FROM ids WHERE harness_session = 'must-not-be-selected'`)).toEqual([]);
  expect(b.instructions.join("\n")).toContain("b-name");
  expect(b.instructions.join("\n")).toContain("b:guidance");
  expect(cursor("a-name")).toBe(0);
  expect(delivered(sent.message_id)).toBeNull();
  await rpcRefused(receipt(s, declined, true));
  const queuedB = await peer.call("dm_send", { to: "b-name", body: "queued-in-b" });
  const heldCall = s.call("whoami");
  await rpcRefused(ready(s, 0));
  // Guidance has returned, but neither tools nor delivery resume before the
  // adapter acknowledges the same epoch after applying it.
  expect(contents(s)).toEqual(["declined-in-a"]);
  expect(cursor("b-name")).toBe(0);
  await ready(s, 1);
  expect((await heldCall).id).toBe(b.id);
  await until(() => s.pushes.length === 2);
  const acceptedB = s.pushes[1]!;
  expect(acceptedB.content).toBe("queued-in-b");
  expect(acceptedB.meta).toMatchObject({ grayboard_session: "receipt-b", grayboard_epoch: "1", message_id: String(queuedB.message_id) });
  expect(cursor("b-name")).toBe(0);
  await receipt(s, acceptedB, true);
  await until(() => cursor("b-name") === queuedB.message_id);
  expect(delivered(queuedB.message_id)).not.toBeNull();
  const resumedA = await select(s, "receipt-a", 2);
  expect(resumedA.instructions.join("\n")).toContain("a-name");
  expect(contents(s)).toEqual(["declined-in-a", "queued-in-b"]);
  await ready(s, 2);
  await until(() => s.pushes.length === 3);
  const acceptedA = s.pushes[2]!;
  expect(acceptedA.content).toBe("declined-in-a");
  expect(acceptedA.meta).toMatchObject({ grayboard_session: "receipt-a", grayboard_epoch: "2", message_id: String(sent.message_id) });
  expect(acceptedA.meta.grayboard_delivery).not.toBe(declined.meta.grayboard_delivery);
  await receipt(s, acceptedA, true);
  await until(() => cursor("a-name") === sent.message_id);
  expect(delivered(sent.message_id)).not.toBeNull();
}, 30_000);

test("a bind-held delivery and waiting selection use the exclusive gate without mixing ownership", async () => {
  const previousB = await session("gate-b", "b-name");
  await stopSession(previousB.c);
  const peer = await localSession(dir, "peer");
  const s = await adapter("gate-a", "a-name", pauseEnv("bindgate:wait"));
  const sent = await peer.call("dm_send", { to: "a-name", body: "held-delivery" });
  await until(() => s.pushes.length === 1);
  const inFlight = s.pushes[0]!;
  const binding = s.call("bind", { name: "a-extra", create: true });
  // The bind owns the gate while awaiting the outstanding channel receipt.
  // This barrier guarantees its handler precedes the selection on stdio.
  await rpcRefused(ready(s, 99));
  const selecting = select(s, "gate-b", 2);
  await until(() => s.stderr().includes("test pause hit: bindgate:wait"));
  release("bindgate:wait");
  await until(() => s.stderr().includes("test pause released: bindgate:wait"));
  await receipt(s, inFlight, false);
  await binding;
  const b = await selecting;
  const [endedA] = rows<{ id: string }>(`SELECT id FROM ids WHERE harness_session = 'gate-a' AND ended_at IS NOT NULL ORDER BY started_at DESC, rowid DESC`);
  expect(snapshot(endedA!.id)).toEqual(["a-name", "a-extra"]);
  expect(held(b.id)).toEqual(["b-name"]);
  expect(cursor("a-name")).toBe(0);
  expect(delivered(sent.message_id)).toBeNull();
  expect(contents(s)).toEqual(["held-delivery"]);
  await ready(s, 2);
  expect((await who(s)).aliases).toEqual(["b-name"]);
}, 30_000);

test("declined board receipts retain notification/read points; accepted retry advances them", async () => {
  const peer = await localSession(dir, "peer");
  await peer.call("board_create", { name: "work", purpose: "receipt cursors" });
  const s = await adapter("board-receipt", "subscriber");
  await s.call("board_subscribe", { board: "work", mode: "push" });
  const root = await who(s);
  const before = rows(`SELECT cursor, notified_id FROM subscriptions WHERE handle = 'subscriber' AND board = 'work'`);
  const posted = await peer.call("board_post", { board: "work", body: "unaccepted-post" });
  await until(() => s.pushes.length === 1);
  const first = s.pushes[0]!;
  expect(first.meta.post_id).toBe(String(posted.post_id));
  const selecting = select(s, "board-receipt", 1);
  await rpcRefused(ready(s, 99));
  await receipt(s, first, false);
  const selected = await selecting;
  expect(selected.id).toBe(root.id);
  expect(selected.instructions.join("\n")).toContain("subscriber");
  expect(rows(`SELECT cursor, notified_id FROM subscriptions WHERE handle = 'subscriber' AND board = 'work'`)).toEqual(before);
  expect(contents(s)).toEqual(["unaccepted-post"]);
  await ready(s, 1);
  await until(() => s.pushes.length === 2);
  const retry = s.pushes[1]!;
  expect(retry.meta).toMatchObject({ post_id: String(posted.post_id), grayboard_session: "board-receipt", grayboard_epoch: "1" });
  expect(retry.meta.grayboard_delivery).not.toBe(first.meta.grayboard_delivery);
  await receipt(s, retry, true);
  await until(() => rows<{ notified_id: number }>(`SELECT notified_id FROM subscriptions WHERE handle = 'subscriber' AND board = 'work'`)[0]!.notified_id === posted.post_id);
  expect(rows(`SELECT cursor, notified_id FROM subscriptions WHERE handle = 'subscriber' AND board = 'work'`)).toEqual([{ cursor: posted.post_id, notified_id: posted.post_id }]);
}, 30_000);

test("rotation bounces declined direct-ID mail and refuses the ended ID without losing alias reach", async () => {
  const peer = await localSession(dir, "peer");
  const s = await adapter("direct-a", "alias");
  const a = await who(s);
  const sent = await peer.call("dm_send", { to: a.id, body: "direct-to-outgoing-id" });
  await until(() => s.pushes.length === 1);
  const selecting = select(s, "direct-b", 1);
  await rpcRefused(ready(s, 99));
  await receipt(s, s.pushes[0]!, false);
  const b = await selecting;
  expect(b.id).not.toBe(a.id);
  expect(held(b.id)).toEqual(["alias"]);
  await until(() => peer.pushes.some(p => p.meta.parent_id === String(sent.message_id)));
  expect(rows(`SELECT sender, recipient, parent_id FROM messages WHERE parent_id = ?`, sent.message_id)).toEqual([{ sender: a.id, recipient: "peer", parent_id: sent.message_id }]);
  const refused = await peer.c.callTool({ name: "dm_send", arguments: { to: a.id, body: "not-a-live-id" } });
  expect(refused.isError).toBe(true);
  expect((refused.content as { text: string }[])[0]!.text).toContain("id_ended:");
  await ready(s, 1);
  const aliasMail = await peer.call("dm_send", { to: "alias", body: "alias-survives-switch" });
  await until(() => s.pushes.length === 2);
  const accepted = s.pushes[1]!;
  expect(accepted.content).toBe("alias-survives-switch");
  expect(accepted.meta).toMatchObject({ grayboard_session: "direct-b", grayboard_epoch: "1" });
  await receipt(s, accepted, true);
  await until(() => cursor("alias") === aliasMail.message_id);
}, 30_000);

test("owner bootstrap holds delivery and tools until initialize guidance has been applied", async () => {
  const peer = await localSession(dir, "peer");
  const s = await session("bootstrap-conversation", "bootstrap-alias", { BUS_ADAPTER_OWNER: OWNER });
  expect(s.c.getInstructions()).toContain("bootstrap-alias");
  const heldCall = s.call("claim_take", { key: "bootstrap:held", ttl_minutes: 30 });
  const sent = await peer.call("dm_send", { to: "bootstrap-alias", body: "bootstrap-mail" });
  await rpcRefused(ready(s, 99));
  expect(rows(`SELECT key FROM claims WHERE key = 'bootstrap:held'`)).toEqual([]);
  expect(contents(s)).toEqual([]);
  expect(cursor("bootstrap-alias")).toBe(0);
  expect(delivered(sent.message_id)).toBeNull();
  await ready(s, 0);
  expect(await heldCall).toMatchObject({ ok: true });
  expect(rows(`SELECT holder FROM claims WHERE key = 'bootstrap:held'`)).toEqual([{ holder: "bootstrap-alias" }]);
  await until(() => s.pushes.length === 1);
  const accepted = s.pushes[0]!;
  expect(accepted.meta).toMatchObject({ grayboard_session: "bootstrap-conversation", grayboard_epoch: "0", message_id: String(sent.message_id) });
  await receipt(s, accepted, true);
  await until(() => cursor("bootstrap-alias") === sent.message_id);
}, 30_000);
