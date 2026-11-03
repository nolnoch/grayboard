// Local `grayboard mcp` under Claude Code (#551): the record its PreToolUse hook
// writes names the agent behind each call. These drive the error paths the
// e2e suite (tests/e2e/claude_local.e2e.ts) doesn't: a call with no usable
// record is refused and audited, never run as the root, and settings without
// the hooks run every call as the root, said once in the audit log and in
// whoami.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installClaudeHooks } from "../../src/cli/claude_hooks.ts";
import { runHook, sessionDir, TOOL_USE_META } from "../../src/shared/claude_agents.ts";
import { localEnv } from "../support/env.ts";
import { closeSessions, localSession, mcpSession, type Session } from "../support/mcp.ts";
import { CLI } from "../support/paths.ts";

afterEach(closeSessions);

type Bus = { dir: string; cfg: string; s: Session; db: Database };

// A Claude Code session's grayboard on a fresh bus: `hooks` installs the record
// hooks in its user settings (else settings without them), and a peer to DM.
async function claudeBus(hooks: boolean): Promise<Bus> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gb-cc-rec-")));
  const cfg = join(dir, "claude");
  mkdirSync(cfg);
  if (hooks) expect(installClaudeHooks([process.execPath, CLI], join(cfg, "settings.json"))).toBe(true);
  else writeFileSync(join(cfg, "settings.json"), "{}");
  await localSession(dir, "peer");
  const s = await mcpSession({ env: localEnv(dir, "cc", { CLAUDECODE: "1", CLAUDE_CONFIG_DIR: cfg }), cwd: dir, args: ["mcp", "--mode", "local"] });
  return { dir, cfg, s, db: new Database(join(dir, "bus.db"), { readonly: true }) };
}

// The hook events Claude Code would run for this session's harness.
const hook = (b: Bus, event: "session-start" | "pre-tool-use", input: Record<string, unknown>) =>
  runHook(event, JSON.stringify(input), { base: b.dir, env: { CLAUDE_PID: String(b.s.harnessPid) }, hosted: false });

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
  utimesSync(join(sessionDir(b.dir, b.s.harnessPid), old), then, then);
  r = await dm(b, "approved-late", old);
  expect(r.isError).toBeFalsy();
  expect(sent(b, "approved-late")!.via).toBeString();

  // The dir's start time is another process's: a recycled pid.
  const recycled = toolUse();
  hook(b, "pre-tool-use", { tool_use_id: recycled, agent_id: "agent-a1" });
  writeFileSync(join(sessionDir(b.dir, b.s.harnessPid), "start"), "Thu Jan  1 00:00:00 1970");
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
