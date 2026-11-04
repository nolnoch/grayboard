// Actual pinned local runtimes, saved conversations and genuinely new processes (#195).
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { installClaudeHooks } from "../../src/cli/claude_hooks.ts";
import { localEnv } from "../support/env.ts";
import { messageText, onChannelDm, startFakeModel } from "../support/fake_model.ts";
import { onUserSteps, onUserText, startFakeAnthropic, toolResults, userTexts } from "../support/fake_anthropic.ts";
import { claudeCli, claudeCodeBin, claudeHome, claudeTty, CLAUDE_CODE_VERSION, type ClaudeTty } from "../support/claude_code.ts";
import { closeSessions, localSession } from "../support/mcp.ts";
import { installLocal, startLocalOmp } from "../support/omp.ts";
import { localOpenCode, opencodeTool, type LocalOpenCode } from "../support/opencode.ts";
import { scripted, startPi, stopAll, type Pi } from "../support/pi.ts";
import { CLI } from "../support/paths.ts";
import { keep } from "../support/run_dir.ts";
import { until } from "../support/until.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "gb-resume-195-")));
afterAll(async () => { await closeSessions(); keep("local-resume", scratch); rmSync(scratch, { recursive: true, force: true }); });
const dirFor = (name: string) => { const dir = join(scratch, name); mkdirSync(dir); return dir; };
const holds = (db: Database, id: string) => db.query<{ address: string }, [string]>("SELECT address FROM alias_holds WHERE id = ? ORDER BY bound_at, address").all(id).map(row => row.address);
const selected = (db: Database, session: string) => db.query<{ id: string; harness_session: string; ended_at: number | null }, [string]>("SELECT id,harness_session,ended_at FROM ids WHERE harness_session = ? AND local_resume=1 AND ended_at IS NULL ORDER BY started_at DESC,rowid DESC LIMIT 1").get(session);
const outgoingEnded = (db: Database, id: string) => db.query<{ ended_at: number | null; held_aliases_json: string }, [string]>("SELECT ended_at,held_aliases_json FROM ids WHERE id=?").get(id);
const saveRequests = (dir: string, requests: unknown[]) => writeFileSync(join(dir, "model.jsonl"), requests.map(r => JSON.stringify(r)).join("\n"));
const savedSummary = (dir: string, summary: object) => writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, 2));
const setupSteps = (prefix: string) => [
  { tool: prefix + "bind", args: { name: "old", create: true } },
  { tool: prefix + "bind", args: { name: "aux", create: true } },
  { tool: prefix + "bind", args: { name: "renamed", create: true } },
  { tool: prefix + "unbind", args: { name: "old" } },
  { tool: prefix + "board_create", args: { name: "resume", purpose: "resume ownership" } },
  { tool: prefix + "claim_take", args: { key: "resume-work", board: "resume" } },
];
const unbindSteps = (prefix: string) => [
  { tool: prefix + "unbind", args: { name: "aux" } },
  { tool: prefix + "unbind", args: { name: "renamed" } },
  { tool: prefix + "whoami", args: {} },
];

for (const kind of ["pi", "omp"] as const) test(`${kind}: saved conversation resumes ordered renamed holds, queued pushes and instructions; final unbind remains authoritative`, async () => {
  const dir = dirFor(kind), prefix = kind === "pi" ? "mcp__grayboard__" : "mcp__grayboard_";
  const procs: ChildProcess[] = [];
  const model = startFakeModel([
    onChannelDm("peer", id => ({ tool: prefix + "dm_send", args: { to: "peer", body: `resumed-${kind}`, parent_id: id } })),
    scripted("BUILD-195", setupSteps(prefix)), scripted("UNBIND-195", unbindSteps(prefix)), scripted("WHO-195", [{ tool: prefix + "whoami", args: {} }]),
  ]);
  let running: Pi | undefined;
  const launches: { pid: number; session: string; file: string; bus: string }[] = [];
  try {
    if (kind === "omp") installLocal(dir, model.port);
    const peer = await localSession(dir, "peer");
    using db = new Database(join(dir, "bus.db"), { readonly: true });
    const start = (session?: string, identity: string | null = null) => kind === "pi"
      ? startPi(dir, model.port, procs, { identity, persist: true, session })
      : startLocalOmp(dir, dir, procs, identity, {}, { persist: true, session });
    const settled = (p: Pi) => until(async () => { const state = await p.command({ type: "get_state" }); return kind === "omp" ? state.isSettled === true : !state.isStreaming && state.pendingMessageCount === 0; }, 45_000, `${kind} settled`);
    running = start();
    await running.command({ type: "get_state" }, 30_000);
    await running.command({ type: "prompt", message: "BUILD-195" });
    await until(() => db.query("SELECT key FROM claims WHERE key='resume-work'").get() !== null, 45_000, "scripted rename and alias claim");
    await settled(running);
    const first = await running.command({ type: "get_state" });
    expect(first.sessionId).toBeString();
    await until(() => existsSync(first.sessionFile), 10_000, "persisted conversation");
    const a = selected(db, first.sessionId)!;
    expect(holds(db, a.id)).toEqual(["aux", "renamed"]);
    launches.push({ pid: running.pid, session: first.sessionId, file: first.sessionFile, bus: a.id });
    await running.quit();
    await until(() => outgoingEnded(db, a.id)?.ended_at != null, 10_000, "clean outgoing end");
    expect(JSON.parse(outgoingEnded(db, a.id)!.held_aliases_json)).toEqual(["aux", "renamed"]);
    const queued = await peer.call("dm_send", { to: "aux", body: `QUEUED-195-${kind}` });
    const requestOffset = model.requests.length;
    running = start(first.sessionFile, "configured-fallback");
    const resumed = await running.command({ type: "get_state" }, 30_000);
    expect(resumed.sessionId).toBe(first.sessionId);
    const b = await until(() => { const row = selected(db, first.sessionId); return row && holds(db, row.id).length === 2 ? row : undefined; }, 30_000, "selected snapshot restored");
    expect(running.pid).not.toBe(launches[0]!.pid);
    expect(b.id).not.toBe(a.id);
    expect(holds(db, b.id)).toEqual(["aux", "renamed"]);
    launches.push({ pid: running.pid, session: resumed.sessionId, file: resumed.sessionFile, bus: b.id });
    await until(() => db.query("SELECT id FROM messages WHERE body=?").get(`resumed-${kind}`) !== null, 45_000, "real resumed push reply");
    const request = model.requests.slice(requestOffset).find(r => r.body.messages.some(m => messageText(m).includes(`message_id="${queued.message_id}"`)));
    expect(request).toBeDefined();
    const guidance = request!.body.messages.filter(m => m.role !== "tool").map(messageText).join("\n");
    expect(guidance).toContain('"aux"');
    expect(guidance).not.toContain('"configured-fallback"');
    expect(db.query<{ holder: string }, []>("SELECT holder FROM claims WHERE key='resume-work'").get()?.holder).toBe("aux");
    expect(db.query("SELECT handle FROM subscriptions WHERE board='resume' AND handle='aux'").get()).not.toBeNull();
    await settled(running);
    await running.command({ type: "prompt", message: "UNBIND-195" });
    await until(() => holds(db, b.id).length === 0, 30_000, "final unbind");
    await settled(running);
    await running.quit();
    await until(() => outgoingEnded(db, b.id)?.ended_at != null, 10_000, "unbound clean exit");
    expect(outgoingEnded(db, b.id)?.held_aliases_json).toBe("[]");
    running = start(first.sessionFile, "configured-fallback");
    const final = await running.command({ type: "get_state" }, 30_000);
    expect(final.sessionId).toBe(first.sessionId);
    const c = await until(() => selected(db, first.sessionId), 30_000, "unbound fresh resume");
    expect(holds(db, c.id)).toEqual([]);
    launches.push({ pid: running.pid, session: final.sessionId, file: final.sessionFile, bus: c.id });
    await running.command({ type: "prompt", message: "WHO-195" });
    await settled(running);
    expect(holds(db, c.id)).toEqual([]);
    expect(model.unhandled).toEqual([]);
    savedSummary(dir, { harness: kind, launches, restored: ["aux", "renamed"], delivery: queued.message_id, finalUnbound: true });
  } finally { await stopAll(procs); model.stop(); saveRequests(dir, model.requests); }
}, 180_000);

test("OpenCode V1: new server on the same data store resumes the original ID, aliases, queued push and instructions", async () => {
  const dir = dirFor("opencode"), prefix = "grayboard_";
  const model = startFakeModel([
    onChannelDm("peer", id => ({ tool: prefix + "dm_send", args: { to: "peer", body: "resumed-opencode", parent_id: id } })),
    scripted("BUILD-195", setupSteps(prefix)), scripted("UNBIND-195", unbindSteps(prefix)), scripted("WHO-195", [{ tool: prefix + "whoami", args: {} }]),
  ]);
  let oc: LocalOpenCode | undefined;
  const launches: { pid: number; session: string; bus: string }[] = [];
  try {
    const peer = await localSession(dir, "peer");
    using db = new Database(join(dir, "bus.db"), { readonly: true });
    oc = await localOpenCode(dir, model.port);
    const session = await oc.create();
    await oc.prompt(session, "BUILD-195");
    const a = selected(db, session)!;
    expect(holds(db, a.id)).toEqual(["aux", "renamed"]);
    launches.push({ pid: oc.pid, session, bus: a.id });
    await oc.stop();
    await until(() => outgoingEnded(db, a.id)?.ended_at != null, 10_000, "OpenCode outgoing root ended");
    const queued = await peer.call("dm_send", { to: "aux", body: "QUEUED-195-opencode" });
    const offset = model.requests.length;
    oc = await localOpenCode(dir, model.port);
    expect((await oc.request(`/session/${session}`) as { id: string }).id).toBe(session);
    await oc.prompt(session, "RESUME-195");
    const b = selected(db, session)!;
    expect(oc.pid).not.toBe(launches[0]!.pid);
    expect(b.id).not.toBe(a.id);
    launches.push({ pid: oc.pid, session, bus: b.id });
    await until(() => db.query("SELECT id FROM messages WHERE body='resumed-opencode'").get() !== null, 45_000, "OpenCode real resumed push reply");
    const who = await oc.prompt(session, "WHO-195");
    expect(JSON.parse(opencodeTool(who, "whoami").state.output!)).toMatchObject({ aliases: ["aux", "renamed"], primary: "aux" });
    const request = model.requests.slice(offset).find(r => r.body.messages.some(m => messageText(m).includes(`message_id="${queued.message_id}"`)));
    expect(request).toBeDefined();
    expect(request!.body.messages.filter(m => m.role === "system").map(messageText).join("\n")).toContain('"aux"');
    expect(db.query<{ holder: string }, []>("SELECT holder FROM claims WHERE key='resume-work'").get()?.holder).toBe("aux");
    await oc.prompt(session, "UNBIND-195");
    expect(holds(db, b.id)).toEqual([]);
    await oc.stop();
    await until(() => outgoingEnded(db, b.id)?.ended_at != null, 10_000, "OpenCode unbound root ended");
    expect(outgoingEnded(db, b.id)?.held_aliases_json).toBe("[]");
    // Explicit configured identity is present at spawn, but cannot override selected [].
    oc = await localOpenCode(dir, model.port, { identity: "configured-fallback" });
    const final = await oc.prompt(session, "WHO-195");
    const identity = JSON.parse(opencodeTool(final, "whoami").state.output!);
    expect(identity.aliases).toEqual([]);
    expect(identity.primary).toBe(identity.id);
    launches.push({ pid: oc.pid, session, bus: identity.id });
    expect(model.unhandled).toEqual([]);
    savedSummary(dir, { harness: "OpenCode V1", launches, restored: ["aux", "renamed"], delivery: queued.message_id, finalUnbound: true });
  } finally { await oc?.stop(); model.stop(); saveRequests(dir, model.requests); }
}, 180_000);

test(`Claude Code ${CLAUDE_CODE_VERSION}: ordinary user-scope fresh --resume selects actual saved identity and authoritative final unbind`, async () => {
  const dir = dirFor("claude"), tool = (name: string) => `mcp__grayboard__${name}`;
  const model = startFakeAnthropic([
    onUserText("QUEUED-195-claude", "grayboard", tool("dm_send"), { to: "peer", body: "resumed-claude" }),
    onUserSteps("BUILD-195-CC", "grayboard", setupSteps("").map(step => ({ tool: tool(step.tool), input: step.args }))),
    onUserSteps("UNBIND-195-CC", "grayboard", unbindSteps("").map(step => ({ tool: tool(step.tool), input: step.args }))),
    onUserSteps("WHO-195-CC", "grayboard", [{ tool: tool("whoami"), input: {} }]),
  ]);
  const h = claudeHome(dir, model.url, ["mcp__grayboard"]), bus = join(dir, "bus");
  mkdirSync(bus);
  const busEnv = localEnv(bus);
  for (const key of ["BUS_DB_PATH", "BUS_SOCK_DIR", "GRAYBOARD_CREDENTIALS", "GRAYBOARD_ATTACHMENTS_DIR"]) h.env[key] = busEnv[key]!;
  // Preserve Claude's isolated config and provider settings; no synthetic conversation ID.
  const bin = claudeCodeBin();
  const args = ["--dangerously-load-development-channels", "server:grayboard", "--permission-mode", "default"];
  let tty: ClaudeTty | undefined;
  const launches: { pid: number; session: string; bus: string }[] = [];
  try {
    claudeCli(bin, h, ["mcp", "add", "--scope", "user", "grayboard", "--", process.execPath, CLI, "mcp", "--mode", "local"]);
    expect(installClaudeHooks([process.execPath, CLI], join(h.config, "settings.json"))).toBe(true);
    const peer = await localSession(bus, "peer");
    using db = new Database(join(bus, "bus.db"), { readonly: true });
    const start = async (session?: string) => {
      const debug = join(dir, "debug.log");
      const offset = existsSync(debug) ? readFileSync(debug, "utf8").length : 0;
      tty = claudeTty(bin, h, [...(session ? ["--resume", session] : []), ...args]);
      await until(() => tty!.screen().includes(`v${CLAUDE_CODE_VERSION}`), 60_000, "Claude main screen");
      await until(() => existsSync(debug) && readFileSync(debug, "utf8").slice(offset).includes('MCP server "grayboard": Successfully connected'), 60_000, "Claude user-scope MCP connected");
      return tty;
    };
    const exit = async () => { await tty!.submit("/exit"); expect(await tty!.proc.exited).toBe(0); };
    await start();
    await tty!.submit("BUILD-195-CC");
    await until(() => toolResults(model, "toolu_BUILD_195_CC_5").length > 0, 90_000, "Claude rename and claim complete");
    const a = db.query<{ id: string; harness_session: string }, [number]>("SELECT i.id,i.harness_session FROM ids i JOIN bindings b ON b.session_id=i.id WHERE i.local_resume=1 AND i.ended_at IS NULL AND b.harness_pid=?").get(tty!.proc.pid)!;
    expect(holds(db, a.id)).toEqual(["aux", "renamed"]);
    launches.push({ pid: tty!.proc.pid, session: a.harness_session, bus: a.id });
    await exit();
    await until(() => outgoingEnded(db, a.id)?.ended_at != null, 10_000, "Claude clean outgoing end");
    const queued = await peer.call("dm_send", { to: "aux", body: "QUEUED-195-claude" });
    const offset = model.requests.length;
    h.env.BUS_IDENTITY = "configured-fallback";
    await start(a.harness_session);
    const b = await until(() => { const row = selected(db, a.harness_session); return row && holds(db, row.id).length === 2 ? row : undefined; }, 45_000, "Claude selected snapshot restored");
    expect(tty!.proc.pid).not.toBe(launches[0]!.pid);
    expect(holds(db, b.id)).toEqual(["aux", "renamed"]);
    launches.push({ pid: tty!.proc.pid, session: b.harness_session, bus: b.id });
    await until(() => db.query("SELECT id FROM messages WHERE body='resumed-claude'").get() !== null, 90_000, "Claude actual queued channel reply");
    const request = model.requests.slice(offset).find(r => userTexts(r.body).some(text => text.includes(`message_id="${queued.message_id}"`)));
    expect(request).toBeDefined();
    const guidance = userTexts(request!.body).filter(text => text.includes("Current grayboard instructions")).at(-1);
    expect(guidance).toContain(b.id);
    expect(guidance).toContain('identity "aux"');
    expect(guidance).toContain('"renamed"');
    expect(guidance).not.toContain('"configured-fallback"');
    expect(db.query<{ holder: string }, []>("SELECT holder FROM claims WHERE key='resume-work'").get()?.holder).toBe("aux");
    await tty!.submit("UNBIND-195-CC");
    await until(() => toolResults(model, "toolu_UNBIND_195_CC_2").length > 0, 60_000, "Claude final unbind and whoami");
    expect(holds(db, b.id)).toEqual([]);
    await exit();
    await until(() => outgoingEnded(db, b.id)?.ended_at != null, 10_000, "Claude unbound clean exit");
    expect(outgoingEnded(db, b.id)?.held_aliases_json).toBe("[]");
    await start(a.harness_session);
    const c = await until(() => selected(db, a.harness_session), 45_000, "Claude final fresh resume");
    expect(holds(db, c.id)).toEqual([]);
    launches.push({ pid: tty!.proc.pid, session: c.harness_session, bus: c.id });
    await tty!.submit("WHO-195-CC");
    await until(() => toolResults(model, "toolu_WHO_195_CC_0").length > 0, 60_000, "Claude unbound whoami");
    expect(holds(db, c.id)).toEqual([]);
    expect(model.unhandled).toEqual([]);
    await exit();
    savedSummary(dir, { harness: `Claude Code ${CLAUDE_CODE_VERSION}`, launches, restored: ["aux", "renamed"], delivery: queued.message_id, finalUnbound: true });
  } finally { await tty?.stop(); model.stop(); saveRequests(dir, model.requests); }
}, 300_000);
