// Delegation (#184) over real processes: local-mode sessions (separate
// `grayboard mcp --mode local` children) and server-mode sessions on a
// TestServer. The launcher opt-in (BUS_LAUNCHER=1), the delegate tool's
// resolution rules, the payload's harness-neutrality, the human fallback,
// and result-return through the pending/promise machinery.
import { Database } from "bun:sqlite";
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
  // The delivered note is the builder's, the same string the server sends
  // (review 13).
  expect(r.note).toContain("Recipient was online; pushed.");
  expect(r.note).toContain("settle the thread");

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

    // A bare name resolves like dm_send's recipient (#184 review 7) — and a
    // mixed-case one too (review 15). The delivered note is the shared
    // builder's, the same string local sends (review 13).
    const r = await call(sim.c, "delegate", { persona: "a doc agent", task: "draft the README intro", to: "be", context: "audience: first-time users" });
    expect(r.to).toBe("you@example.com/be");
    expect(r.delivered_now).toBe(true);
    expect(r.note).toContain("Recipient was online; pushed.");
    expect(r.note).toContain("settle the thread");
    const mixed = await call(sim.c, "delegate", { persona: "a doc agent", task: "t2", to: "Be" });
    expect(mixed.to).toBe("you@example.com/be");
    await until(() => be.pushes.length > 1, 10_000, "the second push");
    // Each delegate's push carries its own brief: the first with its context,
    // the mixed-case one without.
    const payload = String(be.pushes[0]!.content);
    expect(payload).toContain('"persona": "a doc agent"');
    expect(payload).toContain('"context": "audience: first-time users"');
    expect(String(be.pushes[1]!.content)).toContain('"task": "t2"');

    // sim's dm_inbox shows be's report; one dm_ack settles the thread.
    await call(be.c, "dm_send", { to: "sim", body: "Result: drafted.", parent_id: r.message_id });
    await until(async () => {
      const after = await call(sim.c, "dm_inbox");
      return (after.unanswered ?? []).some((m: any) => m.from === "you@example.com/be");
    }, 10_000, "the result to arrive");
    const thread = await call(sim.c, "dm_thread", { thread: r.message_id });
    // Both delegations' threads are settled: the mixed-case one is its own
    // promise.
    await call(sim.c, "dm_ack", { message_id: [r.message_id, mixed.message_id, thread.at(-1).id] });
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
    await srv.session(bob, "be", { BUS_LAUNCHER: "1" });
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
    await srv.session(token, "be");
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
  const after = (await call(sim.c, "peer_list", { include_offline: true })).peers as { handle: string; launcher?: true }[];
  expect(after.find((p) => p.handle === "be")?.launcher).toBe(true);

  // And a push-off session that binds a fresh name is not a launcher either
  // (review 6, local half): it can't receive a delegation, so its flag never
  // reaches the roster, and its instructions carry no launcher sentence.
  const solo = await localSession(dir, "solo", { extra: { BUS_PUSH: "off", BUS_LAUNCHER: "1" } });
  const soloPeers = (await call(sim.c, "peer_list", { include_offline: true })).peers as { handle: string; launcher?: true }[];
  expect(soloPeers.find((p) => p.handle === "solo")?.launcher).toBeUndefined();
  // Its instructions carry no launcher sentence: it can't act on a request.
  expect(solo.c.getInstructions()).not.toContain("You're a launcher session");
  // The positive control proves both observables: a push launcher's
  // instructions do carry the sentence (review 6: the gate, both modes).
  expect(be.c.getInstructions()).toContain("You're a launcher session");

  // The flag is the session's: audited once per session that owns delivery,
  // under its ID, and never by a tools-only process (#284 audit W5).
  const db = new Database(join(dir, "bus.db"), { readonly: true });
  try {
    const idOf = (name: string) => (db.prepare(`SELECT id FROM alias_holds WHERE address = ?`).get(name) as { id: string }).id;
    expect(db.prepare(`SELECT actor, target, detail FROM audit_log WHERE action = 'handle.launcher_set' ORDER BY rowid`).all()).toEqual([
      { actor: idOf("be"), target: idOf("be"), detail: JSON.stringify({ on: true }) },
      { actor: idOf("sim"), target: idOf("sim"), detail: JSON.stringify({ on: false }) },
    ]);
  } finally {
    db.close();
  }
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

test("local: a re-pick retracts the missed pick's message and returns the new one's id (review 16/12)", async () => {
  const be = await localSession(dir, "be", { extra: { BUS_LAUNCHER: "1" } });
  const bo = await localSession(dir, "bo", { extra: { BUS_LAUNCHER: "1" } });
  // sim pauses between resolution and delivery — the exact window the re-pick
  // races (review 12: the liveness snapshot is a poke, delivery pokes again).
  const goFile = join(dir, "pause-release");
  const sim = await localSession(dir, "sim", { extra: { BUS_TEST_PAUSE: "delegate:after-resolve", BUS_TEST_PAUSE_FILE: goFile } });

  const pending = call(sim.c, "delegate", { persona: "a researcher", task: "t" });
  await until(() => sim.stderr().includes("test pause hit: delegate:after-resolve"), 10_000, "sim to hit the pause");

  // be was the pick (first by name) and its socket dies inside the window:
  // the snapshot called it live, the delivery poke misses.
  rmSync(join(dir, "sock.be"));
  const { writeFileSync } = await import("node:fs");
  writeFileSync(goFile, "go");
  const r = await pending;
  expect(r.to).toBe("bo");
  expect(r.delivered_now).toBe(true);

  // The result's message id is the message bo took, and nothing for be
  // remains queued.
  const { Database } = await import("bun:sqlite");
  const bus = new Database(join(dir, "bus.db"), { readonly: true });
  try {
    const row = bus.query(`SELECT recipient FROM messages WHERE id = ?`).get(r.message_id) as any;
    expect(row.recipient).toBe("bo");
    const stranded = bus.query(`SELECT COUNT(*) AS n FROM messages WHERE sender = 'sim' AND recipient = 'be'`).get() as any;
    expect(stranded.n).toBe(0);
  } finally {
    bus.close();
  }
  await until(() => bo.pushes.length > 0, 10_000, "the re-picked launcher's push");
  expect(be.pushes.length).toBe(0);

  // The promise tracks the launcher that took the work.
  const inbox = await call(sim.c, "dm_inbox");
  expect((inbox.promised ?? []).some((p: any) => p.to === "bo")).toBe(true);
  expect((inbox.promised ?? []).some((p: any) => p.to === "be")).toBe(false);
}, 30_000);

test("server: a hold owner with the launcher flag isn't advertised or instructed (review 6)", async () => {
  const srv = new TestServer();
  try {
    const token = await srv.login("you@example.com");
    // A hold connection owns its name but can't receive pushes: the flag and
    // the instruction are gated on push mode (review 6). The positive
    // control proves both observables: a push launcher is advertised and
    // instructed.
    const pusher = srv.client(token, "be", { hello: { launcher: true } });
    const pushHello = await pusher.connect();
    expect(pushHello.type).toBe("hello_ok");
    expect((pushHello.notices ?? []).join("\n")).toContain("You're a launcher session");

    const held = srv.client(token, "bo", { push: false, hold: true, hello: { launcher: true } });
    const heldHello = await held.connect();
    expect(heldHello).toMatchObject({ type: "hello_ok" });
    expect((heldHello.notices ?? []).join("\n")).not.toContain("You're a launcher session");

    const sim = await srv.session(token, "sim");
    const peers = (await call(sim.c, "peer_list", { include_offline: true })).peers as { handle: string; launcher?: true }[];
    expect(peers.find((p) => p.handle === "you@example.com/bo")?.launcher).toBeUndefined();
    await expect(call(sim.c, "delegate", { persona: "p", task: "t", to: "bo" })).rejects.toThrow(/isn't a launcher session/);
  } finally {
    srv.stop();
  }
}, 30_000);

test("server: a reachable human fallback delivers end to end, and every refusal is audited (review 4/10)", async () => {
  const { FakeSlack } = await import("./fake_slack.ts");
  const slack = new FakeSlack({ channel: "D0ALICE", owner: "U0ALICE", channelType: "im" });
  const srv = new TestServer({ slack: { appToken: "xapp-1-t", botToken: "xoxb-t", apiUrl: slack.api } });
  try {
    await srv.app.slackReady;
    const token = await srv.login("alice@example.com");
    // Link, so the human is really reachable: the bridge is running and the
    // user is linked (review 10's reachability, not a last_seen row).
    const r = await srv.api(token, "POST", "/api/slack/link");
    slack.say(`link ${r.body.code}`);
    await until(() => slack.posts().find((p) => p.markdown_text?.startsWith("Linked to `alice@example.com`")));

    const sim = await srv.session(token, "sim");
    const req = await call(sim.c, "delegate", { persona: "a researcher", task: "t" });
    expect(req.to).toBe("alice@example.com/human");
    expect(req.human_fallback).toBe(true);
    expect(req.note).toContain("settle the thread");

    // The request is audited with its via (review 4).
    const audits = srv.app.db.query(`SELECT action, target, detail FROM access_log WHERE action LIKE 'delegation.%' ORDER BY rowid`).all() as any[];
    const requested = audits.filter((a) => a.action === "delegation.requested");
    expect(requested).toHaveLength(1);
    expect(JSON.parse(requested[0]!.detail).via).toBe("human_fallback");
    expect(requested[0]!.target).toBe("alice@example.com/human");

    // A refusal never masquerades as a request: with the human's alias
    // row gone (a broken unlink's state), the send is refused — and the
    // audit says refused, with no id-less requested row beside it.
    srv.app.db.exec(`DELETE FROM aliases WHERE name = 'human'`);
    await expect(call(sim.c, "delegate", { persona: "p", task: "t" })).rejects.toThrow(/not found/);
    const after = srv.app.db.query(`SELECT action, detail FROM access_log WHERE action LIKE 'delegation.%' ORDER BY rowid`).all() as any[];
    expect(after.filter((a) => a.action === "delegation.requested")).toHaveLength(1);
    const lastRefused = after.filter((a) => a.action === "delegation.refused").at(-1)!;
    expect(JSON.parse(lastRefused.detail).reason).toMatch(/not found/);

    // An unresolvable `to` is audited as a refusal too (review 4).
    await expect(call(sim.c, "delegate", { persona: "p", task: "t", to: "ghost" })).rejects.toThrow();
    const final = srv.app.db.query(`SELECT action, detail FROM access_log WHERE action = 'delegation.refused' ORDER BY rowid`).all() as any[];
    expect(JSON.parse(final.at(-1)!.detail).reason).toBeTruthy();
  } finally {
    srv.stop();
    slack.stop();
  }
}, 40_000);
