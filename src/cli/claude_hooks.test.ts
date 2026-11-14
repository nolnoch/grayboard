import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeHooks, hooksDisabledBy, installClaudeHooks, recordHookInstalled, removeClaudeHooks, sessionStartOutput } from "./claude_hooks.ts";
import type { SessionStartOutput } from "./claude_hooks.ts";
import { sessionDir, takeRecord } from "../shared/claude_agents.ts";
import { procStart } from "../shared/proc.ts";
import { listenIdentity } from "../shared/claude_identity.ts";
import { recordPath, writeRecord } from "../shared/namerecord.ts";

const title = (out: SessionStartOutput | null) => out!.hookSpecificOutput.sessionTitle;

test("only an explicit BUS_IDENTITY titles the session: the rest start unbound (#182)", () => {
  const repo = join(mkdtempSync(join(tmpdir(), "gb-ss-")), "api");
  mkdirSync(join(repo, ".git"), { recursive: true });
  expect(sessionStartOutput(JSON.stringify({ cwd: repo }), {})).toBeNull();
  expect(title(sessionStartOutput(JSON.stringify({ cwd: repo }), { BUS_IDENTITY: "be" }))).toBe("be");
  // A pin, alone or re-delivered as BUS_IDENTITY, is a candidate, not a binding.
  writeFileSync(join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { grayboard: { env: { BUS_IDENTITY: "fe" } } } }));
  expect(sessionStartOutput(JSON.stringify({ cwd: repo }), {})).toBeNull();
  expect(sessionStartOutput(JSON.stringify({ cwd: repo }), { BUS_IDENTITY: "fe" })).toBeNull();
});

test("an explicit BUS_IDENTITY titles a linked worktree verbatim: no suffix", () => {
  const root = mkdtempSync(join(tmpdir(), "gb-ss-"));
  mkdirSync(join(root, "api", ".git", "worktrees", "stream"), { recursive: true });
  const wt = join(root, "stream");
  mkdirSync(wt);
  writeFileSync(join(wt, ".git"), `gitdir: ${join(root, "api", ".git", "worktrees", "stream")}\n`);
  writeFileSync(join(root, "api", ".mcp.json"), JSON.stringify({ mcpServers: { grayboard: { env: { BUS_IDENTITY: "be" } } } }));
  expect(title(sessionStartOutput(JSON.stringify({ cwd: wt }), { BUS_IDENTITY: "sim" }))).toBe("sim");
});

test("an explicit BUS_IDENTITY is lowercased, the server's rule (#181)", () => {
  const repo = join(mkdtempSync(join(tmpdir(), "gb-ss-")), "api");
  mkdirSync(join(repo, ".git"), { recursive: true });
  expect(title(sessionStartOutput(JSON.stringify({ cwd: repo }), { BUS_IDENTITY: "Gray" }))).toBe("gray");
  // A name invalid after lowercasing refuses `grayboard mcp` at startup, so
  // the hook — which must never block a session — titles nothing.
  expect(sessionStartOutput(JSON.stringify({ cwd: repo }), { BUS_IDENTITY: "Gray!" })).toBeNull();
});

test("bad input prints nothing rather than failing the session", () => {
  expect(sessionStartOutput("not json", {})).toBeNull();
});

test("a title read honors valid PID carry without creating a bus or deleting a stale record", () => {
  const sock = mkdtempSync(join(tmpdir(), "gb-ss-")), bus = join(sock, "bus.db");
  const env = { BUS_IDENTITY: "web", BUS_SOCK_DIR: sock, BUS_DB_PATH: bus, CLAUDE_PID: String(process.pid) };
  const input = JSON.stringify({ cwd: sock, source: "startup", session_id: "new-title-read" });
  try {
    expect(title(sessionStartOutput(input, env))).toBe("web");
    expect(existsSync(bus)).toBe(false);
    const record = writeRecord(sock, { names: ["aux"], session_id: "id:0123456789abg", harness_pid: process.pid, bus })!;
    expect(record).not.toBeNull();
    expect(sessionStartOutput(input, env)).toBeNull();
    const stale = JSON.stringify({ ...record, harness_start: "a prior process" });
    writeFileSync(recordPath(sock, process.pid), stale);
    expect(title(sessionStartOutput(input, env))).toBe("web");
    expect(readFileSync(recordPath(sock, process.pid), "utf8")).toBe(stale);
    expect(existsSync(bus)).toBe(false);
  } finally { rmSync(sock, { recursive: true, force: true }); }
});

const BIN = ["/usr/local/bin/grayboard"];
const tmpSettings = (...sub: string[]) => join(mkdtempSync(join(tmpdir(), "gb-ss-")), ...sub, "settings.json");
const other = { matcher: "clear|compact", hooks: [{ type: "command", command: "~/.claude/hooks/other.sh" }] };
const otherTool = { matcher: "Bash", hooks: [{ type: "command", command: "~/.claude/hooks/bash.sh" }] };

test("installed hook commands quote a CLI path the shell would split", () => {
  expect(claudeHooks(["bun", "/My Code/grayboard/src/cli/main.ts"]).SessionEnd![0]!.hooks[0]!.command).toBe("bun '/My Code/grayboard/src/cli/main.ts' hook claude session-end");
});

test("install replaces its own hooks, keeps everyone else's, and leaves an unchanged file alone", () => {
  const path = tmpSettings();
  // A pre-#551 install: the title hook alone, at an old path; and an older release's
  // SubagentStop, which local mode no longer installs (#555 item 12).
  writeFileSync(path, JSON.stringify({ model: "x", hooks: { SessionStart: [other, { matcher: "startup|resume|fork", hooks: [{ type: "command", command: "/old/grayboard session-start", timeout: 10 }] }], PreToolUse: [otherTool], Stop: [], SubagentStop: [{ hooks: [{ type: "command", command: "/old/grayboard hook claude subagent-stop", timeout: 10 }] }] } }));
  expect(installClaudeHooks(BIN, path)).toBe(true);
  const ours = claudeHooks(BIN);
  expect(ours).not.toHaveProperty("SubagentStop");
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  expect(cfg.model).toBe("x");
  expect(cfg.hooks).toEqual({
    SessionStart: [other, ...ours.SessionStart!],
    PreToolUse: [otherTool, ...ours.PreToolUse!],
    Stop: [],
    SessionEnd: ours.SessionEnd,
  });
  expect(installClaudeHooks(BIN, path)).toBe(false);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(cfg);
});

test("remove drops only its own hooks and reports whether they were there", () => {
  const path = tmpSettings();
  const before = { model: "x", hooks: { SessionStart: [other], PreToolUse: [otherTool], Stop: [] } };
  writeFileSync(path, JSON.stringify(before));
  installClaudeHooks(BIN, path);
  expect(removeClaudeHooks(path)).toBe(true);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(before);
  expect(removeClaudeHooks(path)).toBe(false);
  // Ours alone: the emptied hooks object goes too.
  writeFileSync(path, JSON.stringify({ model: "x" }));
  installClaudeHooks(["grayboard"], path);
  expect(removeClaudeHooks(path)).toBe(true);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ model: "x" });
});

test("a from-source CLI whose path doesn't say grayboard: install replaces, remove removes, and the record hook counts as installed (#555)", () => {
  const path = tmpSettings();
  const src = ["/usr/local/bin/bun", "/home/me/dev/bus/src/cli/main.ts"];
  installClaudeHooks(src, path);
  expect(installClaudeHooks(src, path)).toBe(false);
  // A move of the checkout replaces the old entries rather than adding to them.
  installClaudeHooks(["/usr/local/bin/bun", "/srv/bus2/src/cli/main.ts"], path);
  const hooks = JSON.parse(readFileSync(path, "utf8")).hooks;
  for (const event of Object.keys(claudeHooks(src))) expect(hooks[event]).toHaveLength(1);
  expect(recordHookInstalled(path)).toBe(true);
  expect(removeClaudeHooks(path)).toBe(true);
  expect(JSON.parse(readFileSync(path, "utf8")).hooks).toBeUndefined();
});

test("install creates the settings file when there is none", () => {
  const path = tmpSettings("new");
  installClaudeHooks(["grayboard"], path);
  expect(JSON.parse(readFileSync(path, "utf8")).hooks.PreToolUse).toHaveLength(1);
});

test("installed means the PreToolUse record hook on the local tools is in user settings", () => {
  const path = tmpSettings();
  expect(recordHookInstalled(path)).toBe(false);
  writeFileSync(path, JSON.stringify({ hooks: { SessionStart: claudeHooks(BIN).SessionStart } }));
  expect(recordHookInstalled(path)).toBe(false);
  installClaudeHooks(BIN, path);
  expect(recordHookInstalled(path)).toBe(true);
  // Another matcher doesn't record grayboard's calls.
  writeFileSync(path, JSON.stringify({ hooks: { PreToolUse: [{ ...claudeHooks(BIN).PreToolUse![0], matcher: "Bash" }] } }));
  expect(recordHookInstalled(path)).toBe(false);
  // Unreadable settings: installed, so calls fail visibly rather than act as the root.
  writeFileSync(path, "{ nope");
  expect(recordHookInstalled(path)).toBe(true);
});

test("one SessionStart hook waits for acknowledgement and merges the valid new title with current guidance", async () => {
  const sock = mkdtempSync(join(tmpdir(), "gb-ss-")), repo = join(sock, "web");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const stop = await listenIdentity(sock, process.pid, async request => {
    expect(request.current?.session).toBe("new-configured");
    entered.resolve();
    await release.promise;
    return { instructions: ["acknowledged web guidance"] };
  });
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts"), "hook", "claude", "session-start"], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, BUS_IDENTITY: "web", BUS_SOCK_DIR: sock, BUS_DB_PATH: join(sock, "bus.db"), CLAUDE_PID: String(process.pid) },
  });
  child.stdin.write(JSON.stringify({ cwd: repo, source: "startup", session_id: "new-configured" }));
  child.stdin.end();
  let finished = false;
  const exited = child.exited.then(code => { finished = true; return code; });
  try {
    await entered.promise;
    expect(finished).toBe(false);
    release.resolve();
    const [code, out, error] = await Promise.all([exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(0);
    expect(error).toBe("");
    expect(out.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(out).hookSpecificOutput).toEqual({ hookEventName: "SessionStart", sessionTitle: "web", additionalContext: "acknowledged web guidance" });
  } finally { release.resolve(); child.kill(); stop(); rmSync(sock, { recursive: true, force: true }); }
});

test("clear still runs the identity hook without introducing a new title event", () => {
  const sock = mkdtempSync(join(tmpdir(), "gb-ss-"));
  try {
    const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "main.ts"), "hook", "claude", "session-start"], {
      stdin: new TextEncoder().encode(JSON.stringify({ cwd: sock, source: "clear", session_id: "cleared" })),
      env: { ...process.env, BUS_IDENTITY: "web", BUS_SOCK_DIR: sock, BUS_DB_PATH: join(sock, "bus.db"), CLAUDE_PID: String(process.pid) },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toBe("");
  } finally { rmSync(sock, { recursive: true, force: true }); }
});

test("CLI hooks publish current root/child records and refuse malformed tool input", () => {
  const sock = mkdtempSync(join(tmpdir(), "gb-ss-"));
  const hook = (event: string, input: string) => Bun.spawnSync(["bun", join(import.meta.dir, "main.ts"), "hook", "claude", event], {
    stdin: new TextEncoder().encode(input),
    env: { ...process.env, BUS_IDENTITY: "", BUS_SOCK_DIR: sock, BUS_DB_PATH: join(sock, "bus.db"), CLAUDE_PID: String(process.pid) },
  });
  for (const r of [
    hook("session-start", JSON.stringify({ source: "startup", session_id: "current" })),
    hook("pre-tool-use", JSON.stringify({ session_id: "current", tool_use_id: "toolu_1", agent_id: "a573e90bd84bce7ff" })),
    hook("pre-tool-use", JSON.stringify({ session_id: "current", tool_use_id: "toolu_2" })),
    hook("no-such-event", "{}"),
  ]) {
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString() + r.stderr.toString()).toBe("");
  }
  expect(takeRecord(sock, process.pid, procStart(process.pid) ?? null, "toolu_1")).toEqual({ agent: "a573e90bd84bce7ff", session: "current" });
  expect(takeRecord(sock, process.pid, procStart(process.pid) ?? null, "toolu_2")).toEqual({ agent: null, session: "current" });
  const denied = hook("pre-tool-use", "not json");
  expect(denied.exitCode).toBe(1);
  expect(JSON.parse(denied.stdout.toString()).hookSpecificOutput.permissionDecision).toBe("deny");
});

test("the CLI fails visibly when an authoritative SessionStart publication cannot replace current", () => {
  const sock = mkdtempSync(join(tmpdir(), "gb-ss-"));
  const current = join(sessionDir(sock, process.pid), "current");
  mkdirSync(current, { recursive: true });
  const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "main.ts"), "hook", "claude", "session-start"], {
    stdin: new TextEncoder().encode(JSON.stringify({ source: "clear", session_id: "B" })),
    env: { ...process.env, BUS_SOCK_DIR: sock, BUS_DB_PATH: join(sock, "bus.db"), CLAUDE_PID: String(process.pid) },
  });
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("current conversation barrier failed");
  expect(r.stdout.toString()).toBe("");
});

test("hooksDisabledBy names the first layer that turns user hooks off (#551)", () => {
  const root = mkdtempSync(join(tmpdir(), "gb-hd-"));
  const managed = join(root, "managed");
  const cwd = join(root, "proj");
  mkdirSync(join(managed, "managed-settings.d"), { recursive: true });
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  const user = join(root, "user-settings.json");
  expect(hooksDisabledBy(cwd, managed, user)).toBeNull();
  // allowManagedHooksOnly counts only in managed settings.
  writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ allowManagedHooksOnly: true }));
  expect(hooksDisabledBy(cwd, managed, user)).toBeNull();
  writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ disableAllHooks: true }));
  expect(hooksDisabledBy(cwd, managed, user)).toBe(`${join(cwd, ".claude", "settings.json")} sets disableAllHooks`);
  // Local project settings come before shared ones; unparseable files are skipped.
  writeFileSync(join(cwd, ".claude", "settings.local.json"), "{not json");
  expect(hooksDisabledBy(cwd, managed, user)).toBe(`${join(cwd, ".claude", "settings.json")} sets disableAllHooks`);
  writeFileSync(join(cwd, ".claude", "settings.local.json"), JSON.stringify({ disableAllHooks: true }));
  expect(hooksDisabledBy(cwd, managed, user)).toBe(`${join(cwd, ".claude", "settings.local.json")} sets disableAllHooks`);
  // User settings come before the project's.
  writeFileSync(user, JSON.stringify({ disableAllHooks: true }));
  expect(hooksDisabledBy(cwd, managed, user)).toBe(`${user} sets disableAllHooks`);
  // Managed drop-ins, in name order, come before user and project settings.
  writeFileSync(join(managed, "managed-settings.d", "20-b.json"), JSON.stringify({ disableAllHooks: true }));
  writeFileSync(join(managed, "managed-settings.d", "10-a.json"), JSON.stringify({ allowManagedHooksOnly: true }));
  expect(hooksDisabledBy(cwd, managed, user)).toBe(`${join(managed, "managed-settings.d", "10-a.json")} sets allowManagedHooksOnly`);
  writeFileSync(join(managed, "managed-settings.json"), JSON.stringify({ disableAllHooks: true }));
  expect(hooksDisabledBy(cwd, managed, user)).toBe(`${join(managed, "managed-settings.json")} sets disableAllHooks`);
  // A platform with no managed dir reads only the project.
  expect(hooksDisabledBy(cwd, null, null)).toBe(`${join(cwd, ".claude", "settings.local.json")} sets disableAllHooks`);
});
