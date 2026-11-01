// `grayboard setup` and `refresh-adapters` register Claude Code for the mode
// (#281): local mode the user-scope `grayboard mcp` entry and the
// SessionStart hook, disabling an enabled hosted plugin; server mode the
// hosted plugin from this repo's marketplace, then removing the entry and the
// hook. A stub `claude` keeps the state the real one does (2.1.316, measured
// in a scratch CLAUDE_CONFIG_DIR): the entry in ~/.claude.json, the plugin's
// enabled flag and userConfig in ~/.claude/settings.json, and its exit codes.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO } from "./update.ts";

const cli = join(import.meta.dir, "main.ts");
const SERVER = "http://127.0.0.1:9";

// argv → state, as Claude Code 2.1.316 does it. STUB_FAIL names a subcommand to fail.
const STUB = `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
const home = process.env.HOME, args = process.argv.slice(2);
fs.appendFileSync(path.join(home, "argv.log"), "claude " + args.join(" ") + "\\n");
const read = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; } };
const write = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v)); };
const user = path.join(home, ".claude.json"), settings = path.join(home, ".claude", "settings.json");
const cmd = args.slice(0, args[0] === "plugin" && args[1] === "marketplace" ? 3 : 2).join(" ");
if (process.env.STUB_FAIL === cmd) { console.error("stub: " + cmd + " failed"); process.exit(1); }
const u = read(user), s = read(settings);
switch (cmd) {
  case "mcp add": u.mcpServers = { ...u.mcpServers, grayboard: { type: "stdio", command: args[6], args: args.slice(7) } }; write(user, u); break;
  case "mcp remove": if (!u.mcpServers?.grayboard) { console.error("No MCP server named grayboard"); process.exit(1); } delete u.mcpServers.grayboard; write(user, u); break;
  case "plugin marketplace add": case "plugin marketplace update": break;
  case "plugin install": {
    s.enabledPlugins = { ...s.enabledPlugins, [args[2]]: true };
    s.pluginConfigs = { ...s.pluginConfigs, [args[2]]: { options: { server_url: args[4].slice("server_url=".length) } } };
    write(settings, s); break;
  }
  case "plugin disable": if (s.enabledPlugins?.[args[2]] !== true) { console.error("already disabled"); process.exit(1); } s.enabledPlugins[args[2]] = false; write(settings, s); break;
  default: console.error("stub: unexpected " + cmd); process.exit(2);
}
`;

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture({ bun = true, claude = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gb-claude-setup-"));
  roots.push(root);
  mkdirSync(join(root, "bin"));
  if (claude) {
    writeFileSync(join(root, "bin", "claude"), STUB);
    chmodSync(join(root, "bin", "claude"), 0o755);
  }
  if (bun) symlinkSync(process.execPath, join(root, "bin", "bun"));
  const exec = (args: string[], extra: Record<string, string> = {}) => {
    const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config"), GRAYBOARD_CREDENTIALS: join(root, "credentials"), PI_CODING_AGENT_DIR: join(root, "pi"),
      PATH: join(root, "bin"), CLAUDE_CONFIG_DIR: undefined, GRAYBOARD_TOKEN: undefined, GRAYBOARD_SERVER: undefined, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", ...extra };
    const r = Bun.spawnSync([process.execPath, cli, ...args], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  };
  const run = (...args: string[]) => {
    const r = exec(args);
    expect(r.exitCode, r.stderr).toBe(0);
    return r.stdout;
  };
  const signIn = () => writeFileSync(join(root, "credentials"), JSON.stringify({ server: SERVER, session_token: "t", user_email: "you@example.com" }));
  const json = (...p: string[]) => (existsSync(join(root, ...p)) ? JSON.parse(readFileSync(join(root, ...p), "utf8")) : {});
  // Every `claude` call since the last one, then forgotten.
  const argv = () => {
    const log = join(root, "argv.log");
    const lines = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
    rmSync(log, { force: true });
    return lines;
  };
  const entry = () => json(".claude.json").mcpServers?.grayboard;
  const settings = () => json(".claude", "settings.json");
  const hook = () => settings().hooks?.SessionStart;
  return { root, exec, run, signIn, argv, entry, settings, hook };
}

const PLUGIN_URL = `${SERVER}/mcp`;
const LOCAL = [`claude mcp remove --scope user grayboard`, `claude mcp add --scope user grayboard -- bun ${cli} mcp`];
const PLUGIN = [`claude plugin marketplace add ${REPO}`, "claude plugin marketplace update grayboard",
  `claude plugin install grayboard@grayboard --config server_url=${PLUGIN_URL}`, "claude mcp remove --scope user grayboard"];
const HOOK = [{ matcher: "startup|resume|fork", hooks: [{ type: "command", command: `bun ${cli} session-start`, timeout: 10 }] }];

test("setup switches Claude Code local → server → local: the entry and hook, then the plugin, then the entry with the plugin disabled", () => {
  const f = fixture();
  expect(f.run("setup", "--local", "-y")).toContain("claude --dangerously-load-development-channels server:grayboard");
  expect(f.argv()).toEqual(LOCAL);
  expect(f.entry()).toEqual({ type: "stdio", command: "bun", args: [cli, "mcp"] });
  expect(f.hook()).toEqual(HOOK);

  f.signIn();
  const out = f.run("setup", "--server", SERVER, "-y");
  expect(f.argv()).toEqual(PLUGIN);
  expect(out).toContain(`Installed the Claude Code plugin grayboard@grayboard for ${PLUGIN_URL}`);
  expect(out).toContain("Removed the user-scope grayboard MCP entry");
  expect(out).toContain("Removed grayboard's SessionStart hook");
  expect(out).toContain("claude --dangerously-load-development-channels plugin:grayboard@grayboard");
  expect(f.entry()).toBeUndefined();
  expect(f.hook()).toBeUndefined();
  expect(f.settings().enabledPlugins).toEqual({ "grayboard@grayboard": true });
  expect(f.settings().pluginConfigs["grayboard@grayboard"]).toEqual({ options: { server_url: PLUGIN_URL } });

  const back = f.run("setup", "--local", "-y");
  expect(f.argv()).toEqual([...LOCAL, "claude plugin disable grayboard@grayboard"]);
  expect(back).toContain("Disabled the Claude Code plugin grayboard@grayboard (its sign-in is kept");
  expect(f.entry()).toEqual({ type: "stdio", command: "bun", args: [cli, "mcp"] });
  expect(f.hook()).toEqual(HOOK);
  expect(f.settings().enabledPlugins).toEqual({ "grayboard@grayboard": false });

  // Already disabled: no `disable`, which would fail.
  f.run("setup", "--local", "-y");
  expect(f.argv()).toEqual(LOCAL);
});

test("server mode without Bun refuses with an install hint and leaves Claude Code as it was", () => {
  const f = fixture({ bun: false });
  f.run("setup", "--local", "-y");
  f.argv();
  f.signIn();
  const r = f.exec(["setup", "--server", SERVER, "-y"]);
  expect(r.exitCode).toBe(1);
  expect(r.stderr).toContain("the grayboard Claude Code plugin runs on Bun; install it (https://bun.sh");
  expect(f.argv()).toEqual([]);
  expect(f.entry()).toEqual({ type: "stdio", command: "bun", args: [cli, "mcp"] });
  expect(f.hook()).toEqual(HOOK);
});

test("a failed plugin install keeps the local entry and hook, and names the failed command", () => {
  const f = fixture();
  f.run("setup", "--local", "-y");
  f.argv();
  f.signIn();
  const r = f.exec(["setup", "--server", SERVER, "-y"], { STUB_FAIL: "plugin install" });
  expect(r.exitCode).toBe(1);
  expect(r.stderr).toContain(`\`claude plugin install grayboard@grayboard --config server_url=${PLUGIN_URL}\` failed: stub: plugin install failed`);
  expect(f.argv()).toEqual(PLUGIN.slice(0, 3));
  expect(f.entry()).toBeDefined();
  expect(f.hook()).toEqual(HOOK);
});

test("refresh-adapters moves a server-mode user's Claude Code entry to the plugin, once; local mode keeps the entry", () => {
  const f = fixture();
  f.run("setup", "--local", "-y");
  f.argv();
  // Local mode: the entry is the registration.
  f.run("refresh-adapters");
  expect(f.argv()).toEqual([]);
  // Server mode set up before the plugin existed: the entry and hook remain.
  f.signIn();
  const out = f.run("refresh-adapters");
  expect(f.argv()).toEqual(PLUGIN);
  expect(out).toContain(`Installed the Claude Code plugin grayboard@grayboard for ${PLUGIN_URL}`);
  expect(f.entry()).toBeUndefined();
  expect(f.hook()).toBeUndefined();
  // Migrated: nothing left to move.
  f.run("refresh-adapters");
  expect(f.argv()).toEqual([]);
});

test("without claude on PATH, setup prints the mode's commands", () => {
  const f = fixture({ claude: false });
  f.signIn();
  const out = f.run("setup", "--server", SERVER, "-y");
  expect(out).toContain(`Claude Code's \`claude\` command wasn't found. Once it's installed, run:\n  ${PLUGIN.join("\n  ")}`);
  expect(f.run("setup", "--local", "-y")).toContain(`run:\n  claude mcp add --scope user grayboard -- bun ${cli} mcp`);
});

test("a server URL the plugin would refuse changes nothing for Claude Code", () => {
  const f = fixture();
  f.run("setup", "--local", "-y");
  f.argv();
  const bad = "http://example.com";
  writeFileSync(join(f.root, "credentials"), JSON.stringify({ server: bad, session_token: "t", user_email: "you@example.com" }));
  const r = f.exec(["setup", "--server", bad, "-y"]);
  expect(r.exitCode).toBe(1);
  expect(r.stderr).toContain("the Claude Code plugin needs a canonical HTTPS (or loopback HTTP) server URL");
  expect(r.stderr).not.toContain(bad);
  expect(f.argv()).toEqual([]);
  expect(f.entry()).toBeDefined();
});
