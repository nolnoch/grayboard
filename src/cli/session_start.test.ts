import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSessionStartHook, sessionStartOutput } from "./session_start.ts";

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

test("an explicit BUS_IDENTITY titles a linked worktree verbatim, plus its lane", () => {
  const root = mkdtempSync(join(tmpdir(), "gb-ss-"));
  mkdirSync(join(root, "api", ".git", "worktrees", "stream"), { recursive: true });
  const wt = join(root, "stream");
  mkdirSync(wt);
  writeFileSync(join(wt, ".git"), `gitdir: ${join(root, "api", ".git", "worktrees", "stream")}\n`);
  writeFileSync(join(root, "api", ".mcp.json"), JSON.stringify({ mcpServers: { grayboard: { env: { BUS_IDENTITY: "be" } } } }));
  // The handle is what dm_send takes, and both sessions of the fleet share
  // it; the worktree distinguishes itself as a lane, not a second handle —
  // and the title carries the lane, so fleet lanes are told apart in the
  // agent list.
  expect(title(sessionStartOutput(JSON.stringify({ cwd: wt }), { BUS_IDENTITY: "sim" }))).toBe("sim · stream");
  // The main checkout keeps the plain handle (no lane to distinguish).
  expect(title(sessionStartOutput(JSON.stringify({ cwd: join(root, "api") }), { BUS_IDENTITY: "sim" }))).toBe("sim");
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

test("install replaces its own hook and keeps everyone else's", () => {
  const path = join(mkdtempSync(join(tmpdir(), "gb-ss-")), "settings.json");
  const other = { matcher: "clear|compact", hooks: [{ type: "command", command: "~/.claude/hooks/other.sh" }] };
  writeFileSync(path, JSON.stringify({ model: "x", hooks: { SessionStart: [other], Stop: [] } }));
  installSessionStartHook("/old/grayboard session-start", path);
  installSessionStartHook("/usr/local/bin/grayboard session-start", path);
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  expect(cfg.model).toBe("x");
  expect(cfg.hooks.Stop).toEqual([]);
  expect(cfg.hooks.SessionStart).toEqual([
    other,
    { matcher: "startup|resume|fork", hooks: [{ type: "command", command: "/usr/local/bin/grayboard session-start", timeout: 10 }] },
  ]);
});

test("install creates the settings file when there is none", () => {
  const path = join(mkdtempSync(join(tmpdir(), "gb-ss-")), "new", "settings.json");
  installSessionStartHook("grayboard session-start", path);
  expect(JSON.parse(readFileSync(path, "utf8")).hooks.SessionStart).toHaveLength(1);
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
