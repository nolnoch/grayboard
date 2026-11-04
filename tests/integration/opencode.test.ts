// The opencode adapter at the plugin level (#182 decision 13, AC 10): it serves
// grayboard's tools as zod from `grayboard tools`, proxies calls to its one
// grayboard process, adds the instructions to the system prompt, and refuses
// an enabled MCP entry. The plugin driver forces abort and stability-clock
// seams; tests/support/opencode.ts runs real local/V1 OpenCode for lifecycle regressions.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localEnv } from "../support/env.ts";
import { closeSessions, localSession } from "../support/mcp.ts";
import { CLI, ROOT } from "../support/paths.ts";
import { grayboardChildren, grayboardChildPids, processDescendants, sigkill } from "../support/procs.ts";
import { localOpenCode, opencodeTool, type LocalOpenCode, type OpenCodeMessage } from "../support/opencode.ts";
import { onChannelDm, promptText, startFakeModel, type Rule } from "../support/fake_model.ts";
import { until } from "../support/until.ts";

let dir: string;
const drivers: ChildProcess[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grayboard-oc-"));
});

afterEach(async () => {
  for (const d of drivers.splice(0)) {
    for (const child of processDescendants(d.pid!)) {
      try { await sigkill(child.pid); } catch {}
    }
    d.kill("SIGKILL");
  }
  await closeSessions();
  rmSync(dir, { recursive: true, force: true });
});

type Driver = { pid: number; stderr: string; send(op: string, args?: Record<string, unknown>): Promise<any> };

// The entry grayboard setup writes, in a user-level opencode.json under dir.
function entry(over: Record<string, unknown> = {}) {
  return { type: "local", command: [process.execPath, CLI, "mcp", "--mode", "local"], environment: { BUS_PUSH: "off" }, enabled: false, ...over };
}

function driver(identity: string | undefined, e: Record<string, unknown>, runtime = process.execPath): Driver {
  const config = join(dir, "config");
  mkdirSync(join(config, "opencode"), { recursive: true });
  writeFileSync(join(config, "opencode", "opencode.json"), JSON.stringify({ mcp: { grayboard: e } }));
  const proc = spawn(runtime, [join(ROOT, "tests/support/opencode_driver.ts")], {
    cwd: dir,
    env: localEnv(dir, identity, { XDG_CONFIG_HOME: config }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  drivers.push(proc);
  let stderr = "";
  proc.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const replies = new Map<number, any>();
  let buf = "";
  proc.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const r = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      replies.set(r.id, r);
    }
  });
  let n = 0;
  return {
    pid: proc.pid!,
    get stderr() { return stderr; },
    async send(op, args = {}) {
      const id = ++n;
      proc.stdin!.write(JSON.stringify({ id, op, ...args }) + "\n");
      const r = await until(() => replies.get(id), 15_000, `driver ${op}`);
      if (!r.ok) throw new Error(r.error);
      return r.value;
    },
  };
}

// What zod's JSON Schema adds that grayboard's schemas leave implicit.
function normalize(s: any): any {
  if (Array.isArray(s)) return s.map(normalize);
  if (!s || typeof s !== "object") return s;
  const { $schema, additionalProperties, propertyNames, ...rest } = s;
  if (Array.isArray(rest.required) && rest.required.length === 0) delete rest.required;
  if (rest.type === "object" && !rest.properties) rest.properties = {};
  return Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, normalize(v)]));
}

test("opencode: every tool `grayboard tools` lists converts to zod with the same schema", async () => {
  const listed = JSON.parse(Bun.spawnSync([process.execPath, CLI, "tools", "--mode", "local"], { env: localEnv(dir) }).stdout.toString()) as { name: string; inputSchema: unknown }[];
  const { tools } = await driver("oc", entry()).send("init");
  expect(Object.keys(tools).sort()).toEqual(listed.map((t) => `grayboard_${t.name}`).sort());
  for (const t of listed) expect([t.name, normalize(tools[`grayboard_${t.name}`])]).toEqual([t.name, normalize(t.inputSchema)]);
});

test("opencode: a free-map argument (bind's meta, peer_list's match) keeps its keys through the zod parse", async () => {
  const oc = driver("oc", entry());
  await oc.send("init");
  expect(await oc.send("parse", { tool: "grayboard_bind", args: { name: "x", meta: { task: "t", owner: "o" } } })).toEqual({ name: "x", meta: { task: "t", owner: "o" } });
  expect(await oc.send("parse", { tool: "grayboard_peer_list", args: { match: { model: "m" } } })).toEqual({ match: { model: "m" } });
});

test("opencode: an unbound session acts as its ID; bind and rebind move the one grayboard process and the system prompt follows in full", async () => {
  const peer = await localSession(dir, "peer");
  const oc = driver(undefined, entry());
  await oc.send("init");
  await oc.send("config", { cfg: { mcp: { grayboard: entry() } } });
  // The first turn can start before the child's initialize: it waits for it.
  expect((await oc.send("system", { sessionID: "s1" })).join("\n")).toContain("This session has no bus name yet, so it acts as its ID");
  expect(grayboardChildren(oc.pid)).toHaveLength(1);

  // #284 S13: unbound, it writes and receives as its ID.
  expect(await oc.send("call", { tool: "grayboard_board_list", args: {} })).toBeString();
  const id = JSON.parse(await oc.send("call", { tool: "grayboard_peer_list", args: {} })).you as string;
  expect(id).toMatch(/^id:/);
  expect(await oc.send("call", { tool: "grayboard_dm_send", args: { to: "peer", body: "as my id" } })).toContain("message_id");
  await oc.send("event", { event: { type: "message.updated", properties: { info: { role: "user", sessionID: "s1" } } } });
  const toId = await peer.call("dm_send", { to: id, body: "to your id" });
  await until(async () => (await oc.send("state")).prompts.some((p: any) => p.text.includes(`message_id="${toId.message_id}"`)), 15_000, "DM to the ID delivered");
  expect(await oc.send("call", { tool: "grayboard_bind", args: { name: "oc-tmp", create: true } })).toContain('Bound to "oc-tmp"');
  // Moving to another name (#284 S1: bind it, unbind the old) replaces the
  // prompt section with the full set, not just the name's part.
  expect(await oc.send("call", { tool: "grayboard_bind", args: { name: "oc-task", create: true } })).toContain('you hold "oc-tmp", "oc-task" and send as "oc-tmp"');
  expect(await oc.send("call", { tool: "grayboard_unbind", args: { name: "oc-tmp" } })).toContain('"oc-task"');
  const system = (await oc.send("system", { sessionID: "s1" })).join("\n");
  expect(system).toContain('You are identity "oc-task" on the grayboard bus');
  expect(system).toContain('Direct messages arrive as <channel source="grayboard"');
  expect(system).toContain("Messages are durable");
  expect(system).not.toContain("oc-tmp");
  expect(system).not.toContain("no bus name yet");

  // The bound name receives, into the session the user wrote in.
  await oc.send("event", { event: { type: "message.updated", properties: { info: { role: "user", sessionID: "s1" } } } });
  const sent = await peer.call("dm_send", { to: "oc-task", body: "ping" });
  const prompt = await until(async () => (await oc.send("state")).prompts.find((p: any) => p.text.includes(`message_id="${sent.message_id}"`)), 15_000, "DM delivered");
  expect([prompt.session, prompt.noReply]).toEqual(["s1", false]);
  expect(await oc.send("call", { tool: "grayboard_dm_send", args: { to: "peer", body: "pong", parent_id: sent.message_id } })).toContain("message_id");
  expect(grayboardChildren(oc.pid)).toHaveLength(1);
  await oc.send("dispose");
}, 60_000);

test("opencode: a project config's grayboard command never runs; the user-level entry's does", async () => {
  // A cloned repo's opencode.json, merged into the config hook's entry.
  const marker = join(dir, "project-command-ran");
  const evil = join(dir, "evil.sh");
  writeFileSync(evil, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  const oc = driver("oc", entry());
  await oc.send("init");
  await oc.send("config", { cfg: { mcp: { grayboard: entry({ command: [evil, "mcp"], environment: { BUS_IDENTITY: "evil" } }) } } });
  await oc.send("event", { event: { type: "session.created", properties: { info: { id: "s1" } } } });
  expect(await oc.send("call", { tool: "grayboard_peer_list", args: {} })).toContain('"you": "oc"');
  expect(existsSync(marker)).toBe(false);
  await oc.send("dispose");
});

test("opencode: an enabled grayboard MCP entry is refused: calls fail with the fix and nothing starts", async () => {
  const oc = driver("oc", entry());
  await oc.send("init");
  await oc.send("config", { cfg: { mcp: { grayboard: entry({ enabled: true }) } } });
  expect((await oc.send("state")).toasts.join("\n")).toContain("is enabled");
  await oc.send("event", { event: { type: "session.created", properties: { info: { id: "s1" } } } });
  await expect(oc.send("call", { tool: "grayboard_board_list", args: {} })).rejects.toThrow('Set "enabled": false');
  expect(await oc.send("system", { sessionID: "s1" })).toEqual([]);
  expect(grayboardChildren(oc.pid)).toHaveLength(0);
});

test("opencode: no grayboard at the entry's command fails the plugin's init with the reason", async () => {
  const missing = join(dir, "no-such-grayboard");
  const oc = driver("oc", entry({ command: [missing, "mcp"] }));
  await expect(oc.send("init")).rejects.toThrow(`\`${missing} tools\` failed to run`);
});

const scriptedTool = (prompt: string, tool: string, args: Record<string, unknown>): Rule => req => {
  const at = req.messages.findLastIndex(m => m.role === "user" && promptText(m) === prompt);
  if (at < 0 || req.messages.slice(at + 1).some(m => m.role === "assistant")) return undefined;
  return { tool: `grayboard_${tool}`, args };
};

test("opencode real: child restarts restore held names, tool calls and delivery, then exhaust", async () => {
  const model = startFakeModel([
    scriptedTool("bind", "bind", { name: "oc-carry", create: true }),
    scriptedTool("who", "whoami", {}),
    onChannelDm("peer", id => ({ tool: "grayboard_dm_send", args: { to: "peer", body: "pong", parent_id: id } })),
  ]);
  let oc: LocalOpenCode | undefined;
  let db: Database | undefined;
  try {
    const peer = await localSession(dir, "peer");
    oc = await localOpenCode(dir, model.port);
    const session = await oc.create();
    const bound = opencodeTool(await oc.prompt(session, "bind"), "bind");
    expect(bound.state.status).toBe("completed");
    db = new Database(join(dir, "bus.db"), { readonly: true });
    const holder = () => db!.query<{ id: string }, []>("SELECT id FROM alias_holds WHERE address = 'oc-carry'").get()?.id;
    let previous = holder()!;
    expect(previous).toBeDefined();
    for (let attempt = 0; attempt < 3; attempt++) {
      const [dead] = grayboardChildPids(oc.pid);
      expect(dead).toBeDefined();
      await sigkill(dead!);
      // Calls reach the plugin without waiting out the backoff first.
      const result = opencodeTool(await oc.prompt(session, "who"), "whoami");
      expect(result.state.status).toBe("completed");
      const who = JSON.parse(result.state.output!);
      expect(who.primary).toBe("oc-carry");
      expect(who.aliases).toEqual(["oc-carry"]);
      expect(who.id).not.toBe(previous);
      expect(holder()).toBe(who.id);
      previous = who.id;
      expect(grayboardChildPids(oc.pid)).toHaveLength(1);
      expect(grayboardChildPids(oc.pid)[0]).not.toBe(dead);
    }
    const sent = await peer.call("dm_send", { to: "oc-carry", body: "ping" });
    await until(() => peer.pushes.find(p => p.content.includes("pong")), 15_000, "delivery resumes after restart");
    expect((await peer.call("dm_thread", { thread: sent.message_id })).map((m: { sender: string; body: string }) => [m.sender, m.body])).toEqual([["peer", "ping"], ["oc-carry", "pong"]]);
    expect((await oc.messages(session)).flatMap(m => m.parts).filter(p => "text" in p && p.text?.includes(`message_id="${sent.message_id}"`))).toHaveLength(1);
    await sigkill(grayboardChildPids(oc.pid)[0]!);
    const failed = opencodeTool(await oc.prompt(session, "who"), "whoami");
    expect(failed.state.status).toBe("error");
    expect(failed.state.error).toContain("after 3 restarts; restart opencode to reconnect");
    expect(grayboardChildPids(oc.pid)).toEqual([]);
    expect(oc.notices().some(n => n.includes("after 3 restarts; restart opencode to reconnect"))).toBe(true);
    const fresh = await oc.create();
    const reset = opencodeTool(await oc.prompt(fresh, "who"), "whoami");
    expect(reset.state.status).toBe("completed");
    expect(JSON.parse(reset.state.output!).primary).toBe("oc-carry");
    expect(model.unhandled).toEqual([]);
  } finally {
    // A failed regression must not leave the original delivery owner alive.
    for (const pid of oc ? grayboardChildPids(oc.pid) : []) await sigkill(pid);
    await oc?.stop();
    db?.close();
    model.stop();
  }
}, 120_000);

for (const mode of ["switch", "shutdown"] as const) {
  test(`opencode real: ${mode} during backoff cancels the outgoing restart without an orphan`, async () => {
    const model = startFakeModel([
      scriptedTool("bind", "bind", { name: "oc-cancel", create: true }),
      scriptedTool("who", "whoami", {}),
    ]);
    let oc: LocalOpenCode | undefined;
    try {
      oc = await localOpenCode(dir, model.port);
      const current = oc;
      const first = await oc.create();
      expect(opencodeTool(await oc.prompt(first, "bind"), "bind").state.status).toBe("completed");
      for (let attempt = 0; attempt < 2; attempt++) {
        await sigkill(grayboardChildPids(oc.pid)[0]!);
        expect(opencodeTool(await oc.prompt(first, "who"), "whoami").state.status).toBe("completed");
      }
      await sigkill(grayboardChildPids(oc.pid)[0]!);
      await until(() => current.notices().some(n => n.includes("restarting it (3 of 3)")), 1_000, "the longest backoff scheduled");
      let waiting: Promise<OpenCodeMessage> | undefined;
      if (mode === "switch") {
        // The old root's tool has entered the restart wait, not just queued a prompt.
        waiting = oc.prompt(first, "who");
        // Teardown may cancel HTTP after an assertion fails; keep that
        // rejection handled while still asserting its result below.
        void waiting.catch(() => {});
        await until(async () => (await current.messages(first)).flatMap(m => m.parts).some(p => p.type === "tool" && "tool" in p && p.tool === "grayboard_whoami" && p.state.status === "running"), 1_000, "the tool waiting during backoff");
      } else {
        await oc.request("/instance/dispose", "POST");
        expect(grayboardChildPids(oc.pid)).toEqual([]);
      }
      const fresh = await oc.create();
      const before = Date.now();
      const result = opencodeTool(await oc.prompt(fresh, "who"), "whoami");
      expect(result.state.status).toBe("completed");
      expect(JSON.parse(result.state.output!).primary).toBe("oc-cancel");
      if (waiting) {
        const old = opencodeTool(await waiting, "whoami");
        expect(old.state.status).toBe("error");
        expect(old.state.error).toContain("root session changed");
      }
      expect(Date.now() - before).toBeLessThan(2_000);
      // Exercise a complete fresh retry cycle instead of sleeping past the
      // cancelled timer: its 5 s restart outlasts the outgoing deadline.
      for (let attempt = 0; attempt < 3; attempt++) {
        await sigkill(grayboardChildPids(oc.pid)[0]!);
        const who = opencodeTool(await oc.prompt(fresh, "who"), "whoami");
        expect(who.state.status).toBe("completed");
        expect(JSON.parse(who.state.output!).primary).toBe("oc-cancel");
        expect(grayboardChildPids(oc.pid)).toHaveLength(1);
      }
      await oc.request("/instance/dispose", "POST");
      await until(() => grayboardChildPids(current.pid).length === 0, 2_000, "the delivery owner stopped on shutdown");
      expect(grayboardChildPids(oc.pid)).toEqual([]);
      expect(model.unhandled).toEqual([]);
    } finally {
      for (const pid of oc ? grayboardChildPids(oc.pid) : []) await sigkill(pid);
      await oc?.stop();
      model.stop();
    }
  }, 120_000);
}

test("opencode: aborting a tool waiting during backoff returns without spawning a replacement; shutdown also releases waiting calls", async () => {
  const oc = driver("oc", entry());
  await oc.send("init");
  await oc.send("system", { sessionID: "s1" });
  for (let attempt = 0; attempt < 2; attempt++) {
    await sigkill(grayboardChildPids(oc.pid)[0]!);
    expect(JSON.parse(await oc.send("call", { tool: "grayboard_whoami", args: {} })).primary).toBe("oc");
  }
  await sigkill(grayboardChildPids(oc.pid)[0]!);
  await until(async () => (await oc.send("state")).toasts.some((n: string) => n.includes("restarting it (3 of 3)")), 1_000, "the longest backoff scheduled");
  const waiting = oc.send("call", { tool: "grayboard_whoami", args: {}, key: "abort-backoff" }).then(() => "resolved", (e: unknown) => e instanceof Error ? e.message : String(e));
  await until(async () => (await oc.send("state")).calls.includes("abort-backoff"), 1_000, "the tool waiting on restart");
  await oc.send("abort", { key: "abort-backoff" });
  expect(await waiting).toBe("aborted");
  expect(grayboardChildPids(oc.pid)).toEqual([]);
  const shuttingDown = oc.send("call", { tool: "grayboard_whoami", args: {}, key: "shutdown-backoff" }).then(() => "resolved", (e: unknown) => e instanceof Error ? e.message : String(e));
  await until(async () => (await oc.send("state")).calls.includes("shutdown-backoff"), 1_000, "the shutdown waiter entered");
  await oc.send("dispose");
  expect(await shuttingDown).toContain("shut down");
  await oc.send("event", { event: { type: "message.updated", properties: { info: { role: "user", sessionID: "s2" } } } });
  await expect(oc.send("call", { tool: "grayboard_whoami", args: {} })).rejects.toThrow("shut down");
  expect(processDescendants(oc.pid)).toEqual([]);
});

test("opencode: a child stable for 60 seconds resets the consecutive restart count", async () => {
  const oc = driver("oc", entry());
  await oc.send("init");
  await oc.send("system", { sessionID: "s1" });
  for (let attempt = 0; attempt < 3; attempt++) {
    await sigkill(grayboardChildPids(oc.pid)[0]!);
    expect(JSON.parse(await oc.send("call", { tool: "grayboard_whoami", args: {} })).primary).toBe("oc");
  }
  // Only Date.now changes; child exit, stdio, and restart timers remain real.
  await oc.send("advanceClock", { ms: 60_000 });
  await sigkill(grayboardChildPids(oc.pid)[0]!);
  expect(JSON.parse(await oc.send("call", { tool: "grayboard_whoami", args: {} })).primary).toBe("oc");
  const notices: string[] = (await oc.send("state")).toasts;
  expect(notices.at(-1)).toContain("restarting it (1 of 3)");
  expect(notices.some(n => n.includes("after 3 restarts"))).toBe(false);
  await oc.send("dispose");
});

test("opencode: EPIPE kills a still-live child before retrying and exhaustion leaves no delivery owner", async () => {
  // Bun 1.4.4's node:child_process stdin silently accepts writes after its
  // peer closes; Node emits the real EPIPE event this lifecycle must handle.
  const oc = driver("oc", entry({ command: [join(ROOT, "tests/support/stdin_closed.sh"), process.execPath, CLI, "mcp", "--mode", "local"] }), "node");
  await oc.send("init");
  await oc.send("event", { event: { type: "session.created", properties: { info: { id: "s1" } } } });
  const notice = await until(async () => (await oc.send("state")).toasts.find((n: string) => n.includes("stopped reading") && n.includes("after 3 restarts")), 15_000, "EPIPE restart exhaustion");
  expect(notice).toContain("restart opencode to reconnect");
  await until(() => processDescendants(oc.pid).length === 0, 1_000, "the EPIPE owner killed on give-up");
  expect(processDescendants(oc.pid)).toEqual([]);
  await expect(oc.send("call", { tool: "grayboard_whoami", args: {} })).rejects.toThrow("after 3 restarts");
  await oc.send("dispose");
});

test("opencode: aborting a tool blocked in initialize does not wait for the child's paused bind", async () => {
  const oc = driver("oc", entry({ environment: { BUS_PUSH: "off", BUS_TEST_PAUSE: "bind:before-txn", BUS_TEST_PAUSE_FILE: join(dir, "release-bind") } }));
  await oc.send("init");
  await oc.send("event", { event: { type: "session.created", properties: { info: { id: "s1" } } } });
  await until(() => oc.stderr.includes("test pause hit: bind:before-txn"), 15_000, "initialize paused before binding");
  const waiting = oc.send("call", { tool: "grayboard_whoami", args: {}, key: "abort-initialize" }).then(() => "resolved", (e: unknown) => e instanceof Error ? e.message : String(e));
  await until(async () => (await oc.send("state")).calls.includes("abort-initialize"), 1_000, "the initialization waiter entered");
  await oc.send("abort", { key: "abort-initialize" });
  expect(await waiting).toBe("aborted");
  expect(grayboardChildPids(oc.pid)).toHaveLength(1);
  await oc.send("dispose");
  expect(processDescendants(oc.pid)).toEqual([]);
});
