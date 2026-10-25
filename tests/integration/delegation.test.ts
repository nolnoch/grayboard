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
  expect(payload).toContain("Persona: a researcher");
  expect(payload).toContain("Task: read docs/delegation.md and summarize the launch rules");
  expect(payload).toContain("never names a model");
  expect(payload).toContain("one delivery owner per handle");
  expect(payload).not.toMatch(/glm|sonnet|opus|gpt-/i);

  // The requester sees the delegation as an open promise...
  const inbox = await call(sim.c, "dm_inbox");
  expect((inbox.promised ?? []).some((p: any) => p.to === "be")).toBe(true);

  // ...and the launcher's report answers it: the result shows unanswered, and
  // one dm_ack (the request + the result) clears the thread.
  const result = await call(be.c, "dm_send", { to: "sim", body: "Result: the launch rules are X.", parent_id: r.message_id });
  expect(result.delivered_now).toBe(true);
  await until(async () => {
    const after = await call(sim.c, "dm_inbox");
    return (after.unanswered ?? []).some((m: any) => m.id === result.message_id);
  }, 10_000, "the result to arrive");
  await call(sim.c, "dm_ack", { message_id: [r.message_id, result.message_id] });
  const settled = await call(sim.c, "dm_inbox");
  expect((settled.promised ?? []).some((p: any) => p.to === "be")).toBe(false);
  expect((settled.unanswered ?? []).some((m: any) => m.id === result.message_id)).toBe(false);
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

    const r = await call(sim.c, "delegate", { persona: "a doc agent", task: "draft the README intro" });
    expect(r.to).toBe("you@example.com/be");
    expect(r.delivered_now).toBe(true);
    await until(() => be.pushes.length > 0, 10_000, "the launcher's push");
    expect(String(be.pushes[be.pushes.length - 1]!.content)).toContain("Persona: a doc agent");

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
