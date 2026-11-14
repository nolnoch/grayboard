// Delegation (#184): local-mode sessions (separate `grayboard mcp --mode
// local` children) over real processes, and the server's: a requester on a
// hosted MCP session, a launcher on an application session declared as a hosted
// request's launcher declaration is (#473). The launcher opt-in, the delegate
// tool's resolution rules, the payload's harness-neutrality, the human
// fallback, refusals and their audit rows (kept by a hosted call since #452),
// and result-return through the pending/promise machinery.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../support/cli.ts";
import { refusal, type AppSession } from "../support/app_session.ts";
import { direct } from "../support/events.ts";
import { localEnv } from "../support/env.ts";
import { call, closeSessions, localSession, stopSession } from "../support/mcp.ts";
import { TestServer } from "../support/server.ts";
import { until } from "../support/until.ts";

let dir: string;

type Peer = { handle: string; launcher?: true };
type Delegated = { to: string; message_id: number; delivered_now: boolean; human_fallback?: true; note: string };
type Inbox = { unanswered?: { id: number; from: string }[]; promised?: { to: string }[] };
// A server whose hosted sessions can poll their inbox freely.
const serve = (o: ConstructorParameters<typeof TestServer>[0] = {}) => new TestServer({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 }, ...o });

// A connected application session declared a launcher, as a hosted
// request's launcher declaration does (#473).
const launcher = (srv: TestServer, token: string, identity: string): Promise<AppSession> => srv.connected(token, identity, { launcher: true });

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

// #337: a fresh launcher can take work before it picks a name: delegation
// reaches it by its session ID, by auto-pick and by an explicit to.
test("local: an unbound launcher is delegable by its ID", async () => {
  const fresh = await localSession(dir, undefined, { extra: { BUS_LAUNCHER: "1" } });
  const sim = await localSession(dir, "sim");
  const id = (await call(fresh.c, "whoami")).id as string;
  expect(id).toMatch(/^id:/);

  const auto = await call(sim.c, "delegate", { persona: "a researcher", task: "t1" });
  expect(auto.to).toBe(id);
  expect(auto.delivered_now).toBe(true);
  const named = await call(sim.c, "delegate", { persona: "a researcher", task: "t2", to: id });
  expect(named.to).toBe(id);
  await until(() => fresh.pushes.length >= 2, 10_000, "both requests pushed to the unbound launcher");
  expect(String(fresh.pushes[0]!.content)).toContain("[delegation request from sim]");
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

test("local: a launcher naming itself is refused as self-delegation, not as offline (#253)", async () => {
  const be = await localSession(dir, "be", { extra: { BUS_LAUNCHER: "1" } });
  try {
    await call(be.c, "delegate", { persona: "p", task: "t", to: "be" });
    throw new Error("expected a refusal");
  } catch (e) {
    expect((e as Error).message).toContain("can't delegate to itself");
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

test("server: the launcher flag on a session's ID records the capability; delegate delivers", async () => {
  const srv = serve();
  try {
    const token = await srv.login("you@example.com");
    const be = await launcher(srv, token, "be");
    const sim = await srv.hosted("you@example.com", "sim");

    const peers = (await sim.call<{ peers: Peer[] }>("peer_list")).peers;
    expect(peers.find((p) => p.handle === "you@example.com/be")?.launcher).toBe(true);

    // A bare name resolves like dm_send's recipient (#184 review 7) — and a
    // mixed-case one too (review 15). The delivered note is the shared
    // builder's, the same string local sends (review 13).
    const r = await sim.call<Delegated>("delegate", { persona: "a doc agent", task: "draft the README intro", to: "be", context: "audience: first-time users" });
    expect(r.to).toBe("you@example.com/be");
    expect(r.delivered_now).toBe(true);
    expect(r.note).toContain("Recipient was online; pushed.");
    expect(r.note).toContain("settle the thread");
    const mixed = await sim.call<Delegated>("delegate", { persona: "a doc agent", task: "t2", to: "Be" });
    expect(mixed.to).toBe("you@example.com/be");
    // Each delegate's push carries its own brief: the first with its context,
    // the mixed-case one without.
    const payload = (await be.next(direct(), 10_000)).message.body;
    expect(payload).toContain('"persona": "a doc agent"');
    expect(payload).toContain('"context": "audience: first-time users"');
    expect((await be.next(direct(), 10_000)).message.body).toContain('"task": "t2"');

    // sim's dm_inbox shows be's report; one dm_ack settles the thread.
    await be.send("sim", "Result: drafted.", { parent_id: r.message_id });
    await until(async () => {
      const after = await sim.call<Inbox>("dm_inbox");
      return (after.unanswered ?? []).some((m) => m.from === "you@example.com/be");
    }, 10_000, "the result to arrive");
    const thread = await sim.call<{ id: number }[]>("dm_thread", { thread: r.message_id });
    // Both delegations' threads are settled: the mixed-case one is its own
    // promise.
    await sim.call("dm_ack", { message_id: [r.message_id, mixed.message_id, thread.at(-1)!.id] });
    const settled = await sim.call<Inbox>("dm_inbox");
    expect((settled.promised ?? []).some((p) => p.to === "you@example.com/be")).toBe(false);
  } finally {
    await srv.stop();
  }
}, 30_000);

test("server: a launcher naming itself is refused as self-delegation, and nothing is sent (#253)", async () => {
  const srv = serve();
  try {
    const token = await srv.login("you@example.com");
    const be = await launcher(srv, token, "be");
    // Its primary, and a second alias it holds: before the fix the second
    // was online to the server and the request went to the session itself.
    expect((await refusal(be.delegate({ persona: "p", task: "t", to: "be" }))).message).toContain("can't delegate to itself");
    await be.bind("be2", { create: true });
    expect((await refusal(be.delegate({ persona: "p", task: "t", to: "be2" }))).message).toContain("can't delegate to itself");
    expect((srv.app.db.query(`SELECT COUNT(*) AS n FROM messages`).get() as { n: number }).n).toBe(0);
  } finally {
    await srv.stop();
  }
}, 30_000);

test("server: delegation stays within the requester's user (review 1-2)", async () => {
  const srv = serve();
  try {
    // Two users, one launcher each. alice's launcher sorts before bob's.
    const alice = await srv.login("alice@example.com");
    const bob = await srv.login("bob@b.com");
    const aliceBe = await launcher(srv, alice, "be");
    await launcher(srv, bob, "be");
    const bobSim = await srv.hosted("bob@b.com", "sim");

    // Auto-pick: bob's own launcher takes it, never alice's (whose handle
    // sorts first), and the human fallback doesn't fire while bob's launcher
    // is live.
    const r = await bobSim.call<Delegated>("delegate", { persona: "a researcher", task: "t" });
    expect(r.to).toBe("bob@b.com/be");
    expect(r.human_fallback).toBeUndefined();

    // An explicit cross-user `to` is refused, naming the scope...
    await expect(bobSim.call("delegate", { persona: "p", task: "t", to: "alice@example.com/be" })).rejects.toThrow(/own user|authority ruling/);
    // ...and nothing landed on alice's launcher.
    await aliceBe.none(direct());

    // The audit names the refusals and the request (review 4).
    const audits = srv.app.db.query(`SELECT action, actor, target FROM access_log WHERE action LIKE 'delegation.%' ORDER BY rowid`).all() as any[];
    expect(audits.some((a) => a.action === "delegation.requested" && a.target === "bob@b.com/be")).toBe(true);
    expect(audits.some((a) => a.action === "delegation.refused")).toBe(true);
  } finally {
    await srv.stop();
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
  const srv = serve();
  try {
    const sim = await srv.hosted("you@example.com", "sim");
    await expect(sim.call("delegate", { persona: "p", task: "t" })).rejects.toThrow(/no live launcher session/);
    // The refusal is audited with its reason.
    const refused = srv.app.db.query(`SELECT detail FROM access_log WHERE action = 'delegation.refused' ORDER BY rowid DESC`).get() as any;
    expect(JSON.parse(refused.detail).reason).toMatch(/no live launcher session/);
  } finally {
    await srv.stop();
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

test("server: a reachable human fallback delivers end to end, and every refusal is audited (review 4/10)", async () => {
  const { FakeSlack } = await import("./fake_slack.ts");
  const slack = new FakeSlack({ channel: "D0ALICE", owner: "U0ALICE", channelType: "im" });
  const srv = serve({ slack: { appToken: "xapp-1-t", botToken: "xoxb-t", apiUrl: slack.api } });
  try {
    await srv.app.slackReady;
    const token = await srv.login("alice@example.com");
    // Link, so the human is really reachable: the bridge is running and the
    // user is linked (review 10's reachability, not a last_seen row).
    const r = await srv.api(token, "POST", "/api/slack/link");
    slack.say(`link ${r.body.code}`);
    await until(() => slack.posts().find((p) => p.markdown_text?.startsWith("Linked to `alice@example.com`")));

    const sim = await srv.hosted("alice@example.com", "sim");
    const req = await sim.call<Delegated>("delegate", { persona: "a researcher", task: "t" });
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
    await expect(sim.call("delegate", { persona: "p", task: "t" })).rejects.toThrow(/not found/);
    const after = srv.app.db.query(`SELECT action, detail FROM access_log WHERE action LIKE 'delegation.%' ORDER BY rowid`).all() as any[];
    expect(after.filter((a) => a.action === "delegation.requested")).toHaveLength(1);
    const lastRefused = after.filter((a) => a.action === "delegation.refused").at(-1)!;
    expect(JSON.parse(lastRefused.detail).reason).toMatch(/not found/);

    // An unresolvable `to` is audited as a refusal too (review 4).
    await expect(sim.call("delegate", { persona: "p", task: "t", to: "ghost" })).rejects.toThrow();
    const final = srv.app.db.query(`SELECT action, detail FROM access_log WHERE action = 'delegation.refused' ORDER BY rowid`).all() as any[];
    expect(JSON.parse(final.at(-1)!.detail).reason).toBeTruthy();
  } finally {
    await srv.stop();
    slack.stop();
  }
}, 40_000);

// #272: a local `to` resolves as the server resolves it: case doesn't matter,
// for delegate and dm_send alike.
test("local: a mixed-case to reaches the launcher, by delegate and by dm_send", async () => {
  const be = await localSession(dir, "be", { extra: { BUS_LAUNCHER: "1" } });
  const sim = await localSession(dir, "sim");
  const r = await call(sim.c, "delegate", { persona: "p", task: "mixed t", to: "Be" });
  expect(r).toMatchObject({ to: "be", delivered_now: true });
  await until(() => be.pushes.some((p) => String(p.content).includes('"task": "mixed t"')), 10_000, "the delegate push");
  const d = await call(sim.c, "dm_send", { to: "BE", body: "mixed dm" });
  expect(d).toMatchObject({ delivered_now: true });
  await until(() => be.pushes.some((p) => String(p.content).includes("mixed dm")), 10_000, "the dm push");
}, 40_000);

// #284 PR 4: the launcher flag is the session's, so it stands behind every
// alias the session holds; a delegate to its second alias lands on it.
test("local and server: a delegate to a launcher session's second alias is accepted", async () => {
  const be = await localSession(dir, "be", { extra: { BUS_LAUNCHER: "1" } });
  await call(be.c, "bind", { name: "be2", create: true });
  const sim = await localSession(dir, "sim");
  const r = await call(sim.c, "delegate", { persona: "p", task: "local t", to: "be2" });
  expect(r).toMatchObject({ to: "be2", delivered_now: true });
  await until(() => be.pushes.some((p) => String(p.content).includes('"task": "local t"')), 10_000, "the local push");

  const srv = serve();
  try {
    const token = await srv.login("you@example.com");
    const sbe = await launcher(srv, token, "be");
    await sbe.bind("be2", { create: true });
    const ssim = await srv.hosted("you@example.com", "sim");
    const peers = (await ssim.call<{ peers: Peer[] }>("peer_list")).peers;
    expect(peers.find((p) => p.handle === "you@example.com/be2")?.launcher).toBe(true);
    const s = await ssim.call("delegate", { persona: "p", task: "server t", to: "be2" });
    expect(s).toMatchObject({ to: "you@example.com/be2", delivered_now: true });
    await sbe.next(direct((m) => m.body.includes('"task": "server t"')), 10_000);
  } finally {
    await srv.stop();
  }
}, 40_000);
