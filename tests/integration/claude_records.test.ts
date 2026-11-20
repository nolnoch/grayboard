// Local `grayboard mcp` under Claude Code (#551): the record its PreToolUse hook
// writes names the agent behind each call. These drive the error paths the
// e2e suite (tests/e2e/claude_local.e2e.ts) doesn't: a call with no usable
// record is refused and audited, never run as the root, and settings without
// the hooks run every call as the root, said once in the audit log and in
// whoami.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installClaudeHooks, sessionStartOutput } from "../../src/cli/claude_hooks.ts";
import { runHook, sessionDir, TOOL_USE_META } from "../../src/shared/claude_agents.ts";
import { syncIdentity } from "../../src/shared/claude_identity.ts";
import { localEnv } from "../support/env.ts";
import { closeSessions, localSession, mcpSession, stopSession, type Session } from "../support/mcp.ts";
import { CLI } from "../support/paths.ts";
import { processDescendants } from "../support/procs.ts";
import { until } from "../support/until.ts";
import { z } from "zod";
import { ErrorCode, McpError, PingRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ClientShape } from "../support/mcp.ts";

afterEach(closeSessions);

// `pid`: the Claude Code stand-in's, which its hook records are kept under.
type Bus = { dir: string; cfg: string; s: Session; db: Database; pid: number };

// A Claude Code session's grayboard on a fresh bus: `hooks` installs the record
// hooks in its user settings (else settings without them), and a peer to DM.
// Its parent is a stand-in for Claude Code, as local.test.ts's: bun under the
// name `claude`, started with channels, running grayboard mcp as its child on
// inherited stdio (CLAUDECODE alone isn't Claude Code: #1412). `harness`, in
// its place, runs grayboard under bun under that name instead (omp).
async function claudeBus(hooks: boolean, client?: ClientShape, harness?: string): Promise<Bus> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gb-cc-rec-")));
  const cfg = join(dir, "claude-config");
  mkdirSync(cfg);
  if (hooks) expect(installClaudeHooks([process.execPath, CLI], join(cfg, "settings.json"))).toBe(true);
  else writeFileSync(join(cfg, "settings.json"), "{}");
  await localSession(dir, "peer");
  const fake = join(dir, harness ?? "claude");
  symlinkSync(process.execPath, fake);
  const host = join(dir, "host.ts");
  writeFileSync(host, `const cmd = process.argv.slice(process.argv.indexOf("::") + 1);
Bun.spawn([process.execPath, ...cmd], { stdio: ["inherit", "inherit", "inherit"] }).exited.then((c) => process.exit(c ?? 0));`);
  const env = localEnv(dir, "cc", { CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CONFIG_DIR: cfg });
  const s = await mcpSession({ env, cwd: dir, args: ["mcp", "--mode", "local"], client, via: standIn(dir, harness) });
  await s.c.listTools();
  return { dir, cfg, s, db: new Database(join(dir, "bus.db"), { readonly: true }), pid: standInPid(dir, s) };
}

// The launcher prefix that runs grayboard under claudeBus's stand-in in `dir`,
// and that stand-in's pid under a session's harness.
const standIn = (dir: string, harness = "claude") =>
  [join(dir, harness), join(dir, "host.ts"), "--dangerously-load-development-channels", "server:grayboard", "::"];
const standInPid = (dir: string, s: Session) => processDescendants(s.harnessPid).find((p) => p.command.includes(join(dir, "host.ts")))!.pid;

// The hook events Claude Code would run for this session's harness.
const hook = (b: Bus, event: "session-start" | "pre-tool-use", input: Record<string, unknown>) =>
  runHook(event, JSON.stringify(input), { base: b.dir, env: { CLAUDE_PID: String(b.pid) }, hosted: false });

let seq = 0;
const toolUse = () => `toolu_rec${++seq}`;
const dm = (b: Bus, body: string, id: string) =>
  b.s.c.callTool({ name: "dm_send", arguments: { to: "peer", body }, _meta: { [TOOL_USE_META]: id } });
const sent = (b: Bus, body: string) =>
  b.db.query<{ via: string | null }, [string]>("SELECT via FROM messages WHERE body = ?").get(body);
const audits = (b: Bus, action: string) =>
  b.db.query<{ detail: string }, [string]>("SELECT detail FROM audit_log WHERE action = ? ORDER BY rowid").all(action).map((r) => JSON.parse(r.detail));
const textOf = (r: Awaited<ReturnType<typeof dm>>) => (r.content as { text: string }[])[0]!.text;

test("a subagent's record makes the call its child session's; a root record leaves it the root's", async () => {
  const b = await claudeBus(true);
  hook(b, "session-start", {});
  const root = toolUse();
  hook(b, "pre-tool-use", { tool_use_id: root });
  expect((await dm(b, "from-root", root)).isError).toBeFalsy();
  expect(sent(b, "from-root")).toEqual({ via: null });
  const child = toolUse();
  hook(b, "pre-tool-use", { tool_use_id: child, agent_id: "agent-a1" });
  expect((await dm(b, "from-child", child)).isError).toBeFalsy();
  expect(sent(b, "from-child")!.via).toBeString();
  // A record is taken once: the same tool_use_id again has none.
  const again = await dm(b, "replayed", child);
  expect(again.isError).toBe(true);
  expect(sent(b, "replayed")).toBeNull();
});

test("a call with no usable record is refused and audited, never run as the root", async () => {
  const b = await claudeBus(true);
  // No SessionStart yet: no record dir for this harness.
  const early = toolUse();
  let r = await dm(b, "no-session", early);
  expect(r.isError).toBe(true);
  expect(textOf(r)).toContain("no SessionStart record");
  hook(b, "session-start", {});

  // The PreToolUse hook didn't run for this call.
  r = await dm(b, "absent", toolUse());
  expect(r.isError).toBe(true);
  expect(textOf(r)).toContain("wrote no record");

  // An old record is still the call's: it may have waited on the permission prompt.
  const old = toolUse();
  hook(b, "pre-tool-use", { tool_use_id: old, agent_id: "agent-a1" });
  const then = new Date(Date.now() - 60 * 60_000);
  utimesSync(join(sessionDir(b.dir, b.pid), old), then, then);
  r = await dm(b, "approved-late", old);
  expect(r.isError).toBeFalsy();
  expect(sent(b, "approved-late")!.via).toBeString();

  // The dir's start time is another process's: a recycled pid.
  const recycled = toolUse();
  hook(b, "pre-tool-use", { tool_use_id: recycled, agent_id: "agent-a1" });
  writeFileSync(join(sessionDir(b.dir, b.pid), "start"), "Thu Jan  1 00:00:00 1970");
  r = await dm(b, "recycled", recycled);
  expect(r.isError).toBe(true);
  expect(textOf(r)).toContain("earlier process with the same pid");

  for (const body of ["no-session", "absent", "recycled"]) expect(sent(b, body)).toBeNull();
  expect(audits(b, "claude.agent_record_missing").map((d) => [d.tool, d.cause])).toEqual([
    ["dm_send", "no_session"], ["dm_send", "absent"], ["dm_send", "recycled_pid"],
  ]);
  expect(audits(b, "claude.attribution_off")).toEqual([]);
});

test("a missing record names the project setting that turned hooks off", async () => {
  const b = await claudeBus(true);
  mkdirSync(join(b.dir, ".claude"));
  writeFileSync(join(b.dir, ".claude", "settings.local.json"), JSON.stringify({ disableAllHooks: true }));
  const r = await dm(b, "disabled", toolUse());
  expect(r.isError).toBe(true);
  expect(textOf(r)).toContain("settings.local.json sets disableAllHooks");
  expect(audits(b, "claude.agent_record_missing")[0].layer).toBe(join(b.dir, ".claude", "settings.local.json") + " sets disableAllHooks");
});

test("settings without the hooks run every call as the root, audited once and said in whoami", async () => {
  const b = await claudeBus(false);
  for (const body of ["off-1", "off-2"]) expect((await dm(b, body, toolUse())).isError).toBeFalsy();
  for (const body of ["off-1", "off-2"]) expect(sent(b, body)).toEqual({ via: null });
  expect(audits(b, "claude.attribution_off")).toEqual([{ tool: "dm_send" }]);
  expect(audits(b, "claude.agent_record_missing")).toEqual([]);
  expect((await b.s.call("whoami")).note).toContain("subagent attribution is off");
  expect(b.s.c.getInstructions()).toContain("subagent attribution is off");
});

// #1412: a harness launched from a Claude Code shell (omp here) passes
// CLAUDECODE on to its grayboard. That grayboard isn't Claude Code's: it
// neither warns that attribution is off nor reads hook records, even one
// written under its harness's pid. Under the claude stand-in, both hold.
for (const harness of ["omp", "claude"]) test(`under ${harness} with CLAUDECODE=1, Claude hook records and the attribution-off note ${harness === "claude" ? "apply" : "don't apply"}`, async () => {
  const claude = harness === "claude";
  const off = await claudeBus(false, undefined, harness);
  expect((await dm(off, "no-hooks", toolUse())).isError).toBeFalsy();
  expect(off.s.c.getInstructions()!.includes("subagent attribution is off")).toBe(claude);
  expect(((await off.s.call("whoami")).note ?? "").includes("subagent attribution is off")).toBe(claude);
  expect(audits(off, "claude.attribution_off")).toEqual(claude ? [{ tool: "dm_send" }] : []);

  const on = await claudeBus(true, undefined, harness);
  hook(on, "session-start", {});
  const sub = toolUse();
  hook(on, "pre-tool-use", { tool_use_id: sub, agent_id: "agent-a1" });
  expect((await dm(on, "recorded", sub)).isError).toBeFalsy();
  // Claude's: the subagent's child session sent it. Not Claude's: the root did.
  expect(sent(on, "recorded")!.via === null).toBe(!claude);
  // No record for this call: refused under Claude, the root's call elsewhere.
  expect(!!(await dm(on, "unrecorded", toolUse())).isError).toBe(claude);
  expect(audits(on, "claude.agent_record_missing").length).toBe(claude ? 1 : 0);
});

test("Claude's acknowledged clear barrier selects remembered B before calls/pushes and rejects an A call", async () => {
  const b = await claudeBus(true);
  const remembered = await localSession(b.dir, undefined, { extra: { BUS_HARNESS_SESSION: "B" } });
  await remembered.call("bind", { name: "selected", create: true });
  await stopSession(remembered.c);
  const env = { CLAUDE_PID: String(b.pid) };
  hook(b, "session-start", { session_id: "A" });
  await syncIdentity("session-start", JSON.stringify({ session_id: "A" }), b.dir, env);
  const a = await b.s.call("whoami");
  const oldCall = toolUse();
  hook(b, "pre-tool-use", { session_id: "A", tool_use_id: oldCall });
  runHook("session-end", JSON.stringify({ reason: "clear" }), { base: b.dir, env, hosted: false });
  await syncIdentity("session-end", JSON.stringify({ reason: "clear" }), b.dir, env);
  const peer = await localSession(b.dir, "sender");
  const pending = await peer.call("dm_send", { to: "cc", body: "paused-A" });
  expect(b.db.query<{ delivered_at: number | null }, [number]>("SELECT delivered_at FROM messages WHERE id=?").get(pending.message_id)?.delivered_at).toBeNull();
  hook(b, "session-start", { source: "clear", session_id: "B" });
  await syncIdentity("session-start", JSON.stringify({ session_id: "B" }), b.dir, env);
  const current = await b.s.call("whoami");
  expect(current.id).not.toBe(a.id);
  expect(current.aliases).toEqual(["selected"]);
  expect(b.db.query<{ ended_at: number | null }, [string]>("SELECT ended_at FROM ids WHERE id=?").get(a.id)?.ended_at).not.toBeNull();
  const stale = await dm(b, "stale-A-must-not-write", oldCall);
  expect(stale.isError).toBe(true);
  expect(sent(b, "stale-A-must-not-write")).toBeNull();
  expect(b.db.query<{ delivered_at: number | null }, [number]>("SELECT delivered_at FROM messages WHERE id=?").get(pending.message_id)?.delivered_at).toBeNull();
  await peer.call("dm_send", { to: "selected", body: "push-selected-B" });
  await until(() => b.s.pushes.some(p => p.content === "push-selected-B"));
  expect(b.s.pushes.some(p => p.content === "paused-A")).toBe(false);
});

test("failed authoritative B publication does not reactivate A or deliver its queued mail", async () => {
  const b = await claudeBus(true);
  const env = { CLAUDE_PID: String(b.pid) };
  hook(b, "session-start", { session_id: "A" });
  await syncIdentity("session-start", JSON.stringify({ session_id: "A" }), b.dir, env);
  const a = await b.s.call("whoami");
  await syncIdentity("session-end", JSON.stringify({ reason: "clear" }), b.dir, env);
  const peer = await localSession(b.dir, "sender");
  const mail = await peer.call("dm_send", { to: "cc", body: "must-stay-paused-A" });
  mkdirSync(join(sessionDir(b.dir, b.pid), `current.tmp.${process.pid}`));
  let publicationError: unknown, barrierError: unknown;
  try { hook(b, "session-start", { session_id: "B", source: "clear" }); } catch (error) { publicationError = error; }
  try { await syncIdentity("session-start", JSON.stringify({ session_id: "B" }), b.dir, env); } catch (error) { barrierError = error; }
  expect(publicationError).toBeInstanceOf(Error);
  expect(barrierError).toBeInstanceOf(Error);
  expect(b.db.query<{ harness_session: string }, [string]>("SELECT harness_session FROM ids WHERE id=?").get(a.id)?.harness_session).toBe("A");
  expect(b.db.query<{ delivered_at: number | null }, [number]>("SELECT delivered_at FROM messages WHERE id=?").get(mail.message_id)?.delivered_at).toBeNull();
  expect(b.s.pushes.some(push => push.content === "must-stay-paused-A")).toBe(false);
});

for (const empty of [false, true]) test(`a ${empty ? "remembered empty" : "remembered ordered"} conversation never titles itself as configured fallback, before or after selection`, async () => {
  const b = await claudeBus(true);
  const remembered = await localSession(b.dir, undefined, { extra: { BUS_HARNESS_SESSION: "remembered-title" } });
  await remembered.call("bind", { name: "aux", create: true });
  await remembered.call("bind", { name: "renamed", create: true });
  if (empty) {
    await remembered.call("unbind", { name: "aux" });
    await remembered.call("unbind", { name: "renamed" });
  }
  await stopSession(remembered.c);
  const env = { CLAUDE_PID: String(b.pid), BUS_SOCK_DIR: b.dir, BUS_DB_PATH: join(b.dir, "bus.db"), BUS_IDENTITY: "configured-fallback" };
  for (const source of ["startup", "resume", "fork"]) {
    const input = JSON.stringify({ cwd: b.dir, source, session_id: "remembered-title" });
    expect(sessionStartOutput(input, env)).toBeNull();
    hook(b, "session-start", { source, session_id: "remembered-title" });
    await syncIdentity("session-start", input, b.dir, env);
    expect((await b.s.call("whoami")).aliases).toEqual(empty ? [] : ["aux", "renamed"]);
    expect(sessionStartOutput(input, env)).toBeNull();
  }
});

test("an absent selected snapshot still puts outgoing PID carry ahead of configured title", async () => {
  const b = await claudeBus(true);
  await b.s.call("bind", { name: "aux", create: true });
  await b.s.call("unbind", { name: "cc" });
  const env = { CLAUDE_PID: String(b.pid), BUS_SOCK_DIR: b.dir, BUS_DB_PATH: join(b.dir, "bus.db"), BUS_IDENTITY: "configured-fallback" };
  const input = JSON.stringify({ cwd: b.dir, source: "fork", session_id: "new-carried" });
  expect(sessionStartOutput(input, env)).toBeNull();
  hook(b, "session-start", { source: "fork", session_id: "new-carried" });
  await syncIdentity("session-start", input, b.dir, env);
  expect((await b.s.call("whoami")).aliases).toEqual(["aux"]);
  expect(sessionStartOutput(input, env)!.hookSpecificOutput.sessionTitle).toBe("aux");
});

test("a genuinely new configured root has the same correct title before and after authoritative selection", async () => {
  const b = await claudeBus(true);
  const env = { CLAUDE_PID: String(b.pid), BUS_SOCK_DIR: b.dir, BUS_DB_PATH: join(b.dir, "bus.db"), BUS_IDENTITY: "cc" };
  const input = JSON.stringify({ cwd: b.dir, source: "startup", session_id: "genuinely-new-title" });
  expect(sessionStartOutput(input, env)!.hookSpecificOutput.sessionTitle).toBe("cc");
  hook(b, "session-start", { source: "startup", session_id: "genuinely-new-title" });
  await syncIdentity("session-start", input, b.dir, env);
  expect((await b.s.call("whoami")).aliases).toEqual(["cc"]);
  expect(sessionStartOutput(input, env)!.hookSpecificOutput.sessionTitle).toBe("cc");
  const child = Bun.spawn([process.execPath, CLI, "hook", "claude", "session-start"], { env: { ...process.env, ...env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(input);
  child.stdin.end();
  const [code, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).toBe(0);
  expect(error).toBe("");
  expect(out.trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(out).hookSpecificOutput.sessionTitle).toBe("cc");
});

test("an adapter's selected identity ignores inherited Claude environment and needs no Claude hook record", async () => {
  const b = await claudeBus(true);
  const owner = "adapter-not-claude";
  // Under the claude stand-in, with hooks installed, so only BUS_ADAPTER_OWNER
  // keeps Claude's conversation record from steering it: no BUS_HARNESS_SESSION
  // at start; the adapter selects its conversation as an adapter does.
  const adapter = await localSession(b.dir, "adapter", { via: standIn(b.dir), extra: {
    BUS_ADAPTER_OWNER: owner,
    CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ID: "claude-stale", CLAUDE_CONFIG_DIR: b.cfg,
  } });
  await adapter.c.listTools();
  // Claude's hook says the conversation under this harness is claude-stale.
  runHook("session-start", JSON.stringify({ session_id: "claude-stale" }), { base: b.dir, env: { CLAUDE_PID: String(standInPid(b.dir, adapter)) }, hosted: false });
  await adapter.c.request({ method: "grayboard/session", params: { owner, epoch: 1, session: "pi-current" } }, z.object({}).passthrough());
  await adapter.c.request({ method: "grayboard/session/ready", params: { owner, epoch: 1 } }, z.object({}).passthrough());
  const identity = await adapter.call("whoami");
  expect(identity.aliases).toEqual(["adapter"]);
  expect(b.db.query<{ harness_session: string }, [string]>("SELECT harness_session FROM ids WHERE id=?").get(identity.id)?.harness_session).toBe("pi-current");
  const peer = await localSession(b.dir, "sender");
  await peer.call("dm_send", { to: "adapter", body: "adapter-current-push" });
  await until(() => adapter.pushes.length === 1);
  const push = adapter.pushes[0]!;
  expect(push.meta.grayboard_session).toBe("pi-current");
  await adapter.c.request({ method: "grayboard/delivery", params: { owner, token: push.meta.grayboard_delivery, accepted: true } }, z.object({}).passthrough());
});

for (const fail of [false, true]) test(`native post-list activation ${fail ? "refusal preserves pending mail and surfaces failure" : "acknowledgement releases current guidance before mail"}`, async () => {
  const entered = Promise.withResolvers<void>(), acknowledge = Promise.withResolvers<void>();
  const b = await claudeBus(true, { setup: client => client.setRequestHandler(PingRequestSchema, async () => {
    entered.resolve();
    await acknowledge.promise;
    if (fail) throw new McpError(ErrorCode.InternalError, "native activation refused");
    return {};
  }) });
  await entered.promise;
  hook(b, "session-start", { session_id: "activation" });
  await syncIdentity("session-start", JSON.stringify({ session_id: "activation" }), b.dir, { CLAUDE_PID: String(b.pid) });
  const peer = await localSession(b.dir, "sender");
  const mail = await peer.call("dm_send", { to: "cc", body: "queued-until-native-activation" });
  const delivery = () => b.db.query<{ delivered_at: number | null }, [number]>("SELECT delivered_at FROM messages WHERE id=?").get(mail.message_id)?.delivered_at;
  const cursor = () => b.db.query<{ last_seen_id: number }, []>("SELECT last_seen_id FROM cursors WHERE reader='cc'").get()?.last_seen_id ?? 0;
  expect(delivery()).toBeNull();
  expect(cursor()).toBe(0);
  expect(b.s.pushes).toEqual([]);
  acknowledge.resolve();
  const call = await b.s.c.callTool({ name: "whoami", arguments: {} });
  if (fail) {
    expect(call.isError).toBe(true);
    const text = (call.content as { text: string }[])[0]!.text;
    expect(text).toStartWith("error: Claude channel activation failed; queued mail remains pending: ");
    expect(text).toContain("native activation refused");
    expect((call.structuredContent as { code?: unknown } | undefined)?.code).toBe("internal");
    expect(b.s.stderr()).toContain("native activation refused");
    expect(delivery()).toBeNull();
    expect(cursor()).toBe(0);
    expect(b.s.pushes).toEqual([]);
  } else {
    expect(call.isError).toBeFalsy();
    await until(() => delivery() != null);
    const current = b.db.query<{ id: string }, []>("SELECT id FROM ids WHERE harness_session='activation' AND ended_at IS NULL").get()!;
    expect(b.s.pushes.map(push => push.meta.kind ?? "mail")).toEqual(["guidance", "mail"]);
    expect(b.s.pushes[0]!.content).toContain(current.id);
    expect(b.s.pushes[0]!.content).toContain('identity "cc"');
    // Not fenced (security audit F-07): it shows the genuine channel form.
    expect(b.s.pushes[0]!.content).toContain('<channel source="grayboard"');
    expect(b.s.pushes[1]!.content).toBe("queued-until-native-activation");
    expect(cursor()).toBe(mail.message_id);
  }
});
