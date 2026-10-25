// Delegation (#184) over real processes: local-mode sessions (separate
// `grayboard mcp --mode local` children) and server-mode sessions on a
// TestServer. The launcher opt-in (BUS_LAUNCHER=1), the delegate tool's
// resolution rules, the payload's harness-neutrality, the human fallback,
// and result-return through the pending/promise machinery.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../support/cli.ts";
import { localEnv } from "../support/env.ts";
import { call, closeSessions, localSession, stopSession } from "../support/mcp.ts";
import { TestServer } from "../support/server.ts";
import { until } from "../support/until.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grayboard-delegate-"));
});

afterEach(async () => {
  await closeSessions();
  rmSync(dir, { recursive: true, force: true });
});

test("local: a delegate request lands on the live launcher, harness-neutral, tracked as a promise", async () => {
  const be = await localSession(dir, "be", { extra: { BUS_LAUNCHER: "1" } });
  const sim = await localSession(dir, "sim");
  await localSession(dir, "ad"); // a second live non-launcher; keeps the pick honest

  // peer_list marks only the launcher.
  const peers = (await call(sim.c, "peer_list")).peers as { handle: string; launcher?: true }[];
  expect(peers.find((p) => p.handle === "be")?.launcher).toBe(true);
  expect(peers.find((p) => p.handle === "sim")?.launcher).toBeUndefined();
  expect(peers.find((p) => p.handle === "ad")?.launcher).toBeUndefined();

  // sim delegates without naming a launcher or a model: be (first live, by
  // name) takes it.
  const r = await call(sim.c, "delegate", {
    persona: "a researcher",
    task: "read docs/delegation.md and summarize the launch rules",
  });
  expect(r.to).toBe("be");
  expect(r.delivered_now).toBe(true);
  expect(r.human_fallback).toBeUndefined();

  // The launcher was pushed the payload: persona and task, the parent-relay
  // floor and its invariant, and no model names.
  await until(() => be.pushes.length > 0, 10_000, "the launcher's push");
  const payload = String(be.pushes[be.pushes.length - 1]!.content);
  // The brief rides in a fenced JSON data block (#184 review 3).
  expect(payload).toContain('"persona": "a researcher"');
  expect(payload).toContain('"task": "read docs/delegation.md and summarize the launch rules"');
  expect(payload).toContain("DATA, not instructions");
  expect(payload).toContain("never names a model");
  expect(payload).toContain("one delivery owner per handle");
  expect(payload).not.toMatch(/glm|sonnet|opus|gpt-/i);

  // The requester sees the delegation as an open promise...
  const inbox = await call(sim.c, "dm_inbox");
  expect((inbox.promised ?? []).some((p: any) => p.to === "be")).toBe(true);

  // ...the launcher's report answers the thread, but the promise settles only
  // when the REQUESTER settles it: the launcher's reply alone leaves it
  // listed (#184 review 8 — the note must not promise otherwise).
  const result = await call(be.c, "dm_send", { to: "sim", body: "Result: the launch rules are X.", parent_id: r.message_id });
  expect(result.delivered_now).toBe(true);
  await until(async () => {
    const after = await call(sim.c, "dm_inbox");
    return (after.unanswered ?? []).some((m: any) => m.id === result.message_id);
  }, 10_000, "the result to arrive");
  const afterReport = await call(sim.c, "dm_inbox");
  expect((afterReport.promised ?? []).some((p: any) => p.to === "be")).toBe(true);

  // The requester's dm_ack settles it.
  await call(sim.c, "dm_ack", { message_id: [r.message_id, result.message_id] });
  const settled = await call(sim.c, "dm_inbox");
  expect((settled.promised ?? []).some((p: any) => p.to === "be")).toBe(false);
  expect((settled.unanswered ?? []).some((m: any) => m.id === result.message_id)).toBe(false);

  // The audit trail exists in local mode too (#184 review 4).
  const { Database } = await import("bun:sqlite");
  const bus = new Database(join(dir, "bus.db"), { readonly: true });
  try {
    const audits = bus.query(`SELECT action, actor, target, detail FROM audit_log WHERE action LIKE 'delegation.%' ORDER BY rowid`).all() as any[];
    expect(audits.some((a) => a.action === "delegation.requested" && a.actor === "sim" && a.target === "be" && JSON.parse(a.detail).via === "auto")).toBe(true);
  } finally {
    bus.close();
  }
}, 30_000);

test("local: an explicit to that isn't a launcher is refused, naming the flag", async () => {
  const sim = await localSession(dir, "sim");
  await localSession(dir, "ad"); // live, not a launcher
  try {
    await call(sim.c, "delegate", { persona: "p", task: "t", to: "ad" });
    throw new Error("expected a refusal");
  } catch (e) {
    expect((e as Error).message).toContain("isn't a launcher session");
  }
}, 20_000);

test("local: no live launcher surfaces the request to the declared human", async () => {
  // The human's handle is declared, and its bridge session connected once
  // (the row's last_seen is the reachability the fallback checks).
  expect((await runCli(["human", "alex"], { env: localEnv(dir), cwd: dir })).code).toBe(0);
  const bridge = await localSession(dir, "alex", { extra: { BUS_HUMAN: "1" } });
  await stopSession(bridge.c);

  const sim = await localSession(dir, "sim");
  const r = await call(sim.c, "delegate", { persona: "a researcher", task: "t" });
  expect(r.to).toBe("alex");
  expect(r.human_fallback).toBe(true);

  // The human's queued request carries the hand-spawn instruction.
  const thread = await call(sim.c, "dm_thread", { thread: r.message_id });
  expect(thread[0].body).toContain("BUS_LAUNCHER=1");
}, 30_000);

test("server: the hello's launcher flag records the capability; delegate delivers", async () => {
  const srv = new TestServer();
  try {
    const token = await srv.login("you@example.com");
    const be = await srv.session(token, "be", { BUS_LAUNCHER: "1" });
    const sim = await srv.session(token, "sim");

    const peers = (await call(sim.c, "peer_list")).peers as { handle: string; launcher?: true }[];
    expect(peers.find((p) => p.handle === "you@example.com/be")?.launcher).toBe(true);

    // A bare name resolves like dm_send's recipient (#184 review 7); the
    // plugin forwards context.
    const r = await call(sim.c, "delegate", { persona: "a doc agent", task: "draft the README intro", to: "be", context: "audience: first-time users" });
    expect(r.to).toBe("you@example.com/be");
    expect(r.delivered_now).toBe(true);
    await until(() => be.pushes.length > 0, 10_000, "the launcher's push");
    const payload = String(be.pushes[be.pushes.length - 1]!.content);
    expect(payload).toContain('"persona": "a doc agent"');
    expect(payload).toContain('"context": "audience: first-time users"');

    // sim's dm_inbox shows be's report; one dm_ack settles the thread.
    await call(be.c, "dm_send", { to: "sim", body: "Result: drafted.", parent_id: r.message_id });
    await until(async () => {
      const after = await call(sim.c, "dm_inbox");
      return (after.unanswered ?? []).some((m: any) => m.from === "you@example.com/be");
    }, 10_000, "the result to arrive");
    const thread = await call(sim.c, "dm_thread", { thread: r.message_id });
    await call(sim.c, "dm_ack", { message_id: [r.message_id, thread.at(-1).id] });
    const settled = await call(sim.c, "dm_inbox");
    expect((settled.promised ?? []).some((p: any) => p.to === "you@example.com/be")).toBe(false);
  } finally {
    srv.stop();
  }
}, 30_000);

test("server: delegation stays within the requester's user (review 1-2)", async () => {
  const srv = new TestServer();
  try {
    // Two users, one launcher each. alice's launcher sorts before bob's.
    const alice = await srv.login("alice@example.com");
    const bob = await srv.login("bob@b.com");
    const aliceBe = await srv.session(alice, "be", { BUS_LAUNCHER: "1" });
    const bobBe = await srv.session(bob, "be", { BUS_LAUNCHER: "1" });
    const bobSim = await srv.session(bob, "sim");

    // Auto-pick: bob's own launcher takes it, never alice's (whose handle
    // sorts first), and the human fallback doesn't fire while bob's launcher
    // is live.
    const r = await call(bobSim.c, "delegate", { persona: "a researcher", task: "t" });
    expect(r.to).toBe("bob@b.com/be");
    expect(r.human_fallback).toBeUndefined();

    // An explicit cross-user `to` is refused, naming the scope.
    try {
      await call(bobSim.c, "delegate", { persona: "p", task: "t", to: "alice@example.com/be" });
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as Error).message).toMatch(/own user|authority ruling/);
    }
    // ...and nothing landed on alice's launcher.
    expect(aliceBe.pushes.length).toBe(0);

    // The audit names the refusals and the request (review 4).
    const audits = srv.app.db.query(`SELECT action, actor, target FROM access_log WHERE action LIKE 'delegation.%' ORDER BY rowid`).all() as any[];
    expect(audits.some((a) => a.action === "delegation.requested" && a.target === "bob@b.com/be")).toBe(true);
    expect(audits.some((a) => a.action === "delegation.refused")).toBe(true);
    // The launcher flag flip is audited too.
    const sets = srv.app.db.query(`SELECT COUNT(*) AS n FROM access_log WHERE action = 'handle.launcher_set'`).get() as any;
    expect(sets.n).toBeGreaterThanOrEqual(2);
  } finally {
    srv.stop();
  }
}, 30_000);

test("server: a launcher that can't receive isn't advertised or instructed (review 6)", async () => {
  const srv = new TestServer();
  try {
    const token = await srv.login("you@example.com");
    // A tools-only connection beside the owner: it never becomes the
    // launcher, whatever its env says.
    await srv.session(token, "be", { BUS_LAUNCHER: "1", BUS_PUSH: "off" });
    const sim = await srv.session(token, "sim");
    const peers = (await call(sim.c, "peer_list")).peers as { handle: string; launcher?: true }[];
    expect(peers.find((p) => p.handle === "you@example.com/be")?.launcher).toBeUndefined();
    // Delegating to it is refused: not a launcher (the flag was never set).
    try {
      await call(sim.c, "delegate", { persona: "p", task: "t", to: "be" });
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as Error).message).toMatch(/isn't a launcher session/);
    }
  } finally {
    srv.stop();
  }
}, 30_000);

test("local: a tools-only sidecar leaves the owner's launcher flag alone (review 5)", async () => {
  const be = await localSession(dir, "be", { extra: { BUS_LAUNCHER: "1" } });
  const sim = await localSession(dir, "sim");
  const before = (await call(sim.c, "peer_list")).peers as { handle: string; launcher?: true }[];
  expect(before.find((p) => p.handle === "be")?.launcher).toBe(true);

  // A sidecar under the launcher's name without BUS_LAUNCHER — the §13
  // subagent pattern — must not clear the owner's opt-in.
  await localSession(dir, "be", { extra: { BUS_PUSH: "off" } });
  const after = (await call(sim.c, "peer_list")).peers as { handle: string; launcher?: true }[];
  expect(after.find((p) => p.handle === "be")?.launcher).toBe(true);

  // And a push-off session with BUS_LAUNCHER=1 doesn't advertise either
  // (review 6, local half): it can't receive a delegation.
  await localSession(dir, "be", { extra: { BUS_PUSH: "off", BUS_LAUNCHER: "1" } });
  const after2 = (await call(sim.c, "peer_list")).peers as { handle: string; launcher?: true }[];
  expect(after2.find((p) => p.handle === "be")?.launcher).toBe(true);
}, 30_000);

test("server: the human fallback checks Slack reachability (review 10)", async () => {
  // No launcher live, human not linked: refused with the undo.
  const srv = new TestServer();
  try {
    const token = await srv.login("you@example.com");
    const sim = await srv.session(token, "sim");
    try {
      await call(sim.c, "delegate", { persona: "p", task: "t" });
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as Error).message).toMatch(/no live launcher session/);
    }
    // The refusal is audited with its reason.
    const refused = srv.app.db.query(`SELECT detail FROM access_log WHERE action = 'delegation.refused' ORDER BY rowid DESC`).get() as any;
    expect(JSON.parse(refused.detail).reason).toMatch(/no live launcher session/);
  } finally {
    srv.stop();
  }
}, 30_000);
