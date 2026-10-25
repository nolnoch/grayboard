// The opencode adapter at the plugin level (#182 decision 13, AC 10): it serves
// grayboard's tools as zod from `grayboard tools`, proxies calls to its one
// grayboard process, adds the instructions to the system prompt, and refuses
// an enabled MCP entry. tests/support/opencode_driver.ts runs it with a fake
// opencode client; the real opencode CLI is #141's.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localEnv } from "../support/env.ts";
import { closeSessions, localSession } from "../support/mcp.ts";
import { CLI, ROOT } from "../support/paths.ts";
import { grayboardChildren } from "../support/procs.ts";
import { until } from "../support/until.ts";

let dir: string;
const drivers: ChildProcess[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grayboard-oc-"));
});

afterEach(async () => {
  for (const d of drivers.splice(0)) d.kill("SIGKILL");
  await closeSessions();
  rmSync(dir, { recursive: true, force: true });
});

type Driver = { pid: number; send(op: string, args?: Record<string, unknown>): Promise<any> };

// The entry grayboard setup writes, in a user-level opencode.json under dir.
function entry(mode: "local" | "server", over: Record<string, unknown> = {}) {
  return { type: "local", command: [process.execPath, CLI, "mcp", "--mode", mode], environment: { BUS_PUSH: "off" }, enabled: false, ...over };
}

function driver(identity: string | undefined, e: Record<string, unknown>): Driver {
  const config = join(dir, "config");
  mkdirSync(join(config, "opencode"), { recursive: true });
  writeFileSync(join(config, "opencode", "opencode.json"), JSON.stringify({ mcp: { grayboard: e } }));
  const proc = spawn(process.execPath, [join(ROOT, "tests/support/opencode_driver.ts")], {
    cwd: dir,
    env: localEnv(dir, identity, { XDG_CONFIG_HOME: config }),
    stdio: ["pipe", "pipe", "inherit"],
  });
  drivers.push(proc);
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
  const { $schema, additionalProperties, ...rest } = s;
  if (Array.isArray(rest.required) && rest.required.length === 0) delete rest.required;
  if (rest.type === "object" && !rest.properties) rest.properties = {};
  return Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, normalize(v)]));
}

for (const mode of ["local", "server"] as const) {
  test(`opencode (${mode}): every tool \`grayboard tools\` lists converts to zod with the same schema`, async () => {
    const listed = JSON.parse(Bun.spawnSync([process.execPath, CLI, "tools", "--mode", mode], { env: localEnv(dir) }).stdout.toString()) as { name: string; inputSchema: unknown }[];
    const { tools } = await driver("oc", entry(mode)).send("init");
    expect(Object.keys(tools).sort()).toEqual(listed.map((t) => `grayboard_${t.name}`).sort());
    for (const t of listed) expect([t.name, normalize(tools[`grayboard_${t.name}`])]).toEqual([t.name, normalize(t.inputSchema)]);
  });
}

test("opencode: an unbound session acts as its ID; bind and rebind move the one grayboard process and the system prompt follows in full", async () => {
  const peer = await localSession(dir, "peer");
  const oc = driver(undefined, entry("local"));
  await oc.send("init");
  await oc.send("config", { cfg: { mcp: { grayboard: entry("local") } } });
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
  // A rebind replaces the prompt section with the full set, not just the name's part.
  expect(await oc.send("call", { tool: "grayboard_bind", args: { name: "oc-task", create: true } })).toContain('Bound to "oc-task" (was "oc-tmp")');
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
  const oc = driver("oc", entry("local"));
  await oc.send("init");
  await oc.send("config", { cfg: { mcp: { grayboard: entry("local", { command: [evil, "mcp"], environment: { BUS_IDENTITY: "evil" } }) } } });
  await oc.send("event", { event: { type: "session.created", properties: { info: { id: "s1" } } } });
  expect(await oc.send("call", { tool: "grayboard_peer_list", args: {} })).toContain('"you": "oc"');
  expect(existsSync(marker)).toBe(false);
  await oc.send("dispose");
});

test("opencode: an enabled grayboard MCP entry is refused: calls fail with the fix and nothing starts", async () => {
  const oc = driver("oc", entry("local"));
  await oc.send("init");
  await oc.send("config", { cfg: { mcp: { grayboard: entry("local", { enabled: true }) } } });
  expect((await oc.send("state")).toasts.join("\n")).toContain("is enabled");
  await oc.send("event", { event: { type: "session.created", properties: { info: { id: "s1" } } } });
  await expect(oc.send("call", { tool: "grayboard_board_list", args: {} })).rejects.toThrow('Set "enabled": false');
  expect(await oc.send("system", { sessionID: "s1" })).toEqual([]);
  expect(grayboardChildren(oc.pid)).toHaveLength(0);
});

test("opencode: no grayboard at the entry's command fails the plugin's init with the reason", async () => {
  const missing = join(dir, "no-such-grayboard");
  const oc = driver("oc", entry("local", { command: [missing, "mcp"] }));
  await expect(oc.send("init")).rejects.toThrow(`\`${missing} tools\` failed to run`);
});
