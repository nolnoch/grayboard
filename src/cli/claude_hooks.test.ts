import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { claudeHooks, hooksDisabledBy, installClaudeHooks, recordHookInstalled, removeClaudeHooks, sessionStartOutput } from "./claude_hooks.ts";

const title = (out: string) => JSON.parse(out).hookSpecificOutput.sessionTitle;

test("only an explicit BUS_IDENTITY titles the session: the rest start unbound (#182)", () => {
  const repo = join(mkdtempSync(join(tmpdir(), "gb-ss-")), "api");
  mkdirSync(join(repo, ".git"), { recursive: true });
  expect(sessionStartOutput(JSON.stringify({ cwd: repo }), {})).toBe("");
  expect(title(sessionStartOutput(JSON.stringify({ cwd: repo }), { BUS_IDENTITY: "be" }))).toBe("be");
  // A pin, alone or re-delivered as BUS_IDENTITY, is a candidate, not a binding.
  writeFileSync(join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { grayboard: { env: { BUS_IDENTITY: "fe" } } } }));
  expect(sessionStartOutput(JSON.stringify({ cwd: repo }), {})).toBe("");
  expect(sessionStartOutput(JSON.stringify({ cwd: repo }), { BUS_IDENTITY: "fe" })).toBe("");
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
  expect(sessionStartOutput(JSON.stringify({ cwd: repo }), { BUS_IDENTITY: "Gray!" })).toBe("");
});

test("bad input prints nothing rather than failing the session", () => {
  expect(sessionStartOutput("not json", {})).toBe("");
});

const BIN = ["/usr/local/bin/grayboard"];
const tmpSettings = (...sub: string[]) => join(mkdtempSync(join(tmpdir(), "gb-ss-")), ...sub, "settings.json");
const other = { matcher: "clear|compact", hooks: [{ type: "command", command: "~/.claude/hooks/other.sh" }] };
const otherTool = { matcher: "Bash", hooks: [{ type: "command", command: "~/.claude/hooks/bash.sh" }] };

test("the hooks: the title hook, and the four record hooks on the local tools (#551)", () => {
  const cmd = (event: string) => [{ type: "command", command: `/usr/local/bin/grayboard hook claude ${event}`, timeout: 10 }];
  expect(claudeHooks(BIN)).toEqual({
    SessionStart: [
      { matcher: "startup|resume|fork", hooks: [{ type: "command", command: "/usr/local/bin/grayboard session-start", timeout: 10 }] },
      { matcher: "startup|resume|clear|fork", hooks: cmd("session-start") },
    ],
    PreToolUse: [{ matcher: "mcp__grayboard__.*", hooks: cmd("pre-tool-use") }],
    SubagentStop: [{ hooks: cmd("subagent-stop") }],
    SessionEnd: [{ hooks: cmd("session-end") }],
  });
  // From source, and a path the shell would split.
  expect(claudeHooks(["bun", "/My Code/grayboard/src/cli/main.ts"]).SessionEnd![0]!.hooks[0]!.command).toBe("bun '/My Code/grayboard/src/cli/main.ts' hook claude session-end");
});

test("install replaces its own hooks, keeps everyone else's, and leaves an unchanged file alone", () => {
  const path = tmpSettings();
  // A pre-#551 install: the title hook alone, at an old path.
  writeFileSync(path, JSON.stringify({ model: "x", hooks: { SessionStart: [other, { matcher: "startup|resume|fork", hooks: [{ type: "command", command: "/old/grayboard session-start", timeout: 10 }] }], PreToolUse: [otherTool], Stop: [] } }));
  expect(installClaudeHooks(BIN, path)).toBe(true);
  const ours = claudeHooks(BIN);
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  expect(cfg.model).toBe("x");
  expect(cfg.hooks).toEqual({
    SessionStart: [other, ...ours.SessionStart!],
    PreToolUse: [otherTool, ...ours.PreToolUse!],
    Stop: [],
    SubagentStop: ours.SubagentStop,
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

test("the CLI command reads the hook input from stdin", () => {
  const repo = join(mkdtempSync(join(tmpdir(), "gb-ss-")), "web");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const r = Bun.spawnSync(["bun", join(import.meta.dir, "main.ts"), "session-start"], {
    stdin: new TextEncoder().encode(JSON.stringify({ cwd: repo, source: "startup" })),
    env: { ...process.env, BUS_IDENTITY: "web" },
  });
  expect(title(r.stdout.toString())).toBe("web");
});

test("`hook claude <event>` writes the record through the light entry, prints nothing and never fails (#551)", () => {
  const sock = mkdtempSync(join(tmpdir(), "gb-ss-"));
  const hook = (event: string, input: string) => Bun.spawnSync(["bun", join(import.meta.dir, "main.ts"), "hook", "claude", event], {
    stdin: new TextEncoder().encode(input),
    env: { ...process.env, BUS_SOCK_DIR: sock, CLAUDE_PID: String(process.pid) },
  });
  const dir = join(sock, "claude-agents", String(process.pid));
  for (const r of [
    hook("session-start", JSON.stringify({ source: "startup" })),
    hook("pre-tool-use", JSON.stringify({ tool_use_id: "toolu_1", agent_id: "a573e90bd84bce7ff" })),
    hook("pre-tool-use", JSON.stringify({ tool_use_id: "toolu_2" })),
    hook("pre-tool-use", "not json"),
    hook("no-such-event", "{}"),
  ]) {
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString() + r.stderr.toString()).toBe("");
  }
  expect(readFileSync(join(dir, "toolu_1"), "utf8")).toBe("a573e90bd84bce7ff");
  expect(readFileSync(join(dir, "toolu_2"), "utf8")).toBe("-");
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

test("the hook entry's static imports stay the record module's few: every one evaluates on every grayboard call (#551, 50 ms budget)", () => {
  const t = new Bun.Transpiler({ loader: "ts" });
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const i of t.scanImports(readFileSync(file, "utf8").replace(/^#!.*\n/, ""))) {
      if (i.kind !== "import-statement" || !i.path.startsWith(".")) continue;
      walk(join(dirname(file), i.path));
    }
  };
  walk(join(import.meta.dir, "main.ts"));
  const rel = [...seen].map((f) => relative(join(import.meta.dir, "..", ".."), f)).sort();
  expect(rel).toEqual(["src/cli/main.ts", "src/shared/claude_agents.ts", "src/shared/proc.ts", "src/shared/session_meta.ts", "src/shared/sockdir.ts"]);
});
