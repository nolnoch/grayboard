// `grayboard setup` and `refresh-adapters` register Claude Code for the mode
// (#281): local mode the user-scope `grayboard mcp` entry and grayboard's
// hooks (#551), disabling an enabled hosted plugin; server mode the
// hosted plugin from this repo's marketplace, then removing the entry and the
// hooks. A stub `claude` keeps the state the real one does (2.1.316, measured
// in a scratch CLAUDE_CONFIG_DIR): the entry in ~/.claude.json, the plugin's
// enabled flag and userConfig in ~/.claude/settings.json, and its exit codes.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCli } from "./claude-setup.ts";
import { claudeHooks } from "./claude_hooks.ts";
import { REPO } from "./update.ts";
import pkg from "../../package.json" with { type: "json" };

const cli = join(import.meta.dir, "main.ts");
const SERVER = "http://127.0.0.1:9";

// argv → state, as Claude Code 2.1.316 does it. STUB_FAIL names a subcommand to fail;
// STUB_PIN is the version \`plugin marketplace update\` writes into the catalog,
// STUB_PLUGIN_VERSION the installed plugin's; STUB_PLUGIN_LIST replaces
// \`plugin list\`'s output.
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
  case "plugin marketplace add": break;
  case "plugin marketplace update": write(path.join(home, "marketplace", ".claude-plugin", "marketplace.json"), { name: "grayboard", plugins: [{ name: "grayboard", source: { source: "git-subdir", ref: "v" + process.env.STUB_PIN } }] }); break;
  case "plugin marketplace list": console.log(JSON.stringify([{ name: "grayboard", source: "github", installLocation: path.join(home, "marketplace") }])); break;
  case "plugin install": {
    s.enabledPlugins = { ...s.enabledPlugins, [args[2]]: true };
    s.pluginConfigs = { ...s.pluginConfigs, [args[2]]: { options: { server_url: args[4].slice("server_url=".length) } } };
    write(settings, s); break;
  }
  case "plugin update": if (s.enabledPlugins?.[args[2]] === undefined) { console.error("plugin not installed"); process.exit(1); } console.log("already at the latest version (" + process.env.STUB_PLUGIN_VERSION + ")"); break;
  case "plugin list": console.log(process.env.STUB_PLUGIN_LIST ?? JSON.stringify(Object.keys(s.enabledPlugins ?? {}).map((id) => ({ id, version: process.env.STUB_PLUGIN_VERSION, scope: "user", enabled: s.enabledPlugins[id] })))); break;
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
  const exec = (args: string[], extra: Record<string, string> = {}, cwd = root) => {
    const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config"), GRAYBOARD_CREDENTIALS: join(root, "credentials"), PI_CODING_AGENT_DIR: join(root, "pi"),
      PATH: join(root, "bin"), CLAUDE_CONFIG_DIR: undefined, GRAYBOARD_TOKEN: undefined, GRAYBOARD_SERVER: undefined, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", STUB_PIN: pkg.version, STUB_PLUGIN_VERSION: pkg.version, ...extra };
    const r = Bun.spawnSync([process.execPath, cli, ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
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
  const hook = () => settings().hooks;
  return { root, exec, run, signIn, argv, entry, settings, hook };
}

const PLUGIN_URL = `${SERVER}/mcp`;
const LOCAL = [`claude mcp remove --scope user grayboard`, `claude mcp add --scope user grayboard -- bun ${cli} mcp`];
const PLUGIN = [`claude plugin marketplace add ${REPO}`, "claude plugin marketplace update grayboard",
  `claude plugin install grayboard@grayboard --config server_url=${PLUGIN_URL}`, "claude mcp remove --scope user grayboard"];
// After an install or update, the pin and the installed plugin are read (#511).
const CHECK = ["claude plugin marketplace list --json", "claude plugin list --json"];
const UPDATE = ["claude plugin marketplace update grayboard", "claude plugin update grayboard@grayboard", ...CHECK];
const HOOK = claudeHooks(["bun", cli]);

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
  expect(out).toContain("Removed grayboard's hooks");
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
  expect(f.argv()).toEqual([...PLUGIN, ...CHECK]);
  expect(out).toContain(`Installed the Claude Code plugin grayboard@grayboard for ${PLUGIN_URL}`);
  expect(f.entry()).toBeUndefined();
  expect(f.hook()).toBeUndefined();
  // Migrated: nothing left to move, and the installed plugin updates (#443).
  const again = f.run("refresh-adapters");
  expect(f.argv()).toEqual(UPDATE);
  expect(again).toContain(`Claude Code plugin grayboard@grayboard: already at the latest version (${pkg.version}). Restart Claude Code sessions to load a new version.`);
});

test("refresh-adapters in local mode installs the hooks on a pre-#551 setup, keeping the user's own, without asking", () => {
  const f = fixture();
  f.run("setup", "--local", "-y");
  f.argv();
  const own = { matcher: "Bash", hooks: [{ type: "command", command: "~/.claude/hooks/bash.sh" }] };
  // What setup wrote before #551: the title hook alone.
  const settings = join(f.root, ".claude", "settings.json");
  writeFileSync(settings, JSON.stringify({ model: "x", hooks: { SessionStart: [HOOK.SessionStart![0]], PreToolUse: [own] } }));
  const out = f.run("refresh-adapters");
  expect(out).toContain(`Installed grayboard's hooks in ${settings}`);
  expect(f.argv()).toEqual([]);
  expect(f.settings().model).toBe("x");
  expect(f.hook()).toEqual({ ...HOOK, PreToolUse: [own, ...HOOK.PreToolUse!] });
  // Current: nothing to say, nothing rewritten.
  expect(f.run("refresh-adapters")).not.toContain("Installed grayboard's hooks");
});

test("refresh-adapters in server mode updates an enabled plugin, skips a disabled or absent one, reports a failed update, and warns about a repo .mcp.json entry (#443)", () => {
  const f = fixture();
  f.signIn();
  writeFileSync(join(f.root, ".mcp.json"), JSON.stringify({ mcpServers: { grayboard: { command: "grayboard", args: ["mcp"] } } }));
  // Absent: nothing to update, and the entry may be the user's only grayboard, so no warning.
  expect(f.run("refresh-adapters")).not.toContain("has a grayboard entry");
  expect(f.argv()).toEqual([]);
  f.run("setup", "-y");
  f.argv();
  // The entry is found from a subdirectory too, and the update's own report is printed.
  mkdirSync(join(f.root, "sub"));
  const out = f.exec(["refresh-adapters"], {}, join(f.root, "sub"));
  expect(out.exitCode, out.stderr).toBe(0);
  expect(f.argv()).toEqual(UPDATE);
  expect(out.stdout).toContain(`Claude Code plugin grayboard@grayboard: already at the latest version (${pkg.version}). Restart Claude Code sessions to load a new version.`);
  expect(out.stdout).toContain(`${join(f.root, ".mcp.json")} has a grayboard entry`);
  // A failed update names the command and fails the run, and the warning still prints.
  const failed = f.exec(["refresh-adapters"], { STUB_FAIL: "plugin update" });
  expect(failed.exitCode).toBe(1);
  expect(failed.stdout).toContain("`claude plugin update grayboard@grayboard` failed: stub: plugin update failed");
  expect(failed.stdout).toContain(`${join(f.root, ".mcp.json")} has a grayboard entry`);
  f.argv();
  // Another project's unparseable .mcp.json is named, and doesn't fail the run.
  writeFileSync(join(f.root, ".mcp.json"), "{ // not JSON");
  expect(f.run("refresh-adapters")).toContain(`${join(f.root, ".mcp.json")} isn't valid JSON, so it wasn't checked for a grayboard entry`);
  f.argv();
  // Disabled: left alone.
  writeFileSync(join(f.root, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "grayboard@grayboard": false } }));
  f.run("refresh-adapters");
  expect(f.argv()).toEqual([]);
});

test("after the plugin update, the marketplace pin, the installed plugin and this grayboard are compared; a mismatch or an unreadable version fails the run after the update's report (#511)", () => {
  const f = fixture();
  f.signIn();
  f.run("setup", "-y");
  f.argv();
  const report = `Claude Code plugin grayboard@grayboard: already at the latest version`;
  const unmerged = `the plugin pin for v${pkg.version} hasn't merged into the marketplace yet. Run \`grayboard update\` again later.`;
  // All three agree: the report alone.
  const same = f.run("refresh-adapters");
  expect(f.argv()).toEqual(UPDATE);
  expect(same).toContain(`${report} (${pkg.version}).`);
  expect(same).not.toContain("The marketplace pins");
  // The pin is older (its plugin-pin PR hasn't merged): said, and the run passes.
  const older = f.exec(["refresh-adapters"], { STUB_PIN: "1.0.0", STUB_PLUGIN_VERSION: "1.0.0" });
  expect(older.exitCode, older.stderr).toBe(0);
  expect(older.stdout).toContain(`The marketplace pins the plugin at 1.0.0, older than this grayboard (${pkg.version}): ${unmerged}`);
  // Newer: said, not acted on.
  const newer = f.exec(["refresh-adapters"], { STUB_PIN: "999.0.0", STUB_PLUGIN_VERSION: "999.0.0" });
  expect(newer.exitCode, newer.stderr).toBe(0);
  expect(newer.stdout).toContain(`The marketplace pins the plugin at 999.0.0, newer than this grayboard (${pkg.version}).`);
  expect(newer.stdout).not.toContain(unmerged);
  f.argv();
  // The pin moved but the plugin didn't: no false "hasn't merged", and the run fails.
  const stuck = f.exec(["refresh-adapters"], { STUB_PLUGIN_VERSION: "1.0.0" });
  expect(stuck.exitCode).toBe(1);
  expect(stuck.stdout).toContain(`${report} (1.0.0).`);
  expect(stuck.stdout).toContain(`The marketplace pins grayboard@grayboard at ${pkg.version}, but the installed plugin is 1.0.0; run \`claude plugin update grayboard@grayboard\``);
  expect(stuck.stdout).not.toContain(unmerged);
  // Versions that can't be read fail the run, keep the update's report, and name what failed.
  const unchecked = `, so the plugin's version wasn't checked against this grayboard (${pkg.version})`;
  for (const [extra, message] of [
    [{ STUB_FAIL: "plugin list" }, "`claude plugin list --json` failed: stub: plugin list failed"],
    [{ STUB_FAIL: "plugin marketplace list" }, "`claude plugin marketplace list --json` failed: stub: plugin marketplace list failed"],
    [{ STUB_PLUGIN_LIST: JSON.stringify([{ id: "grayboard@grayboard", version: pkg.version, scope: "project" }]) }, "`claude plugin list --json` lists no user-scope grayboard@grayboard with a release version"],
    [{ STUB_PLUGIN_VERSION: "abc" }, "`claude plugin list --json` lists no user-scope grayboard@grayboard with a release version"],
    [{ STUB_PLUGIN_LIST: "not json" }, "`claude plugin list --json` printed something other than JSON"],
    [{ STUB_PIN: "main" }, `the marketplace catalog ${join(f.root, "marketplace", ".claude-plugin", "marketplace.json")} pins no grayboard release tag`],
  ] as const) {
    const r = f.exec(["refresh-adapters"], extra);
    expect(r.exitCode, JSON.stringify(extra)).toBe(1);
    expect(r.stdout).toContain(report);
    expect(r.stdout).toContain(`${message}${unchecked}`);
  }
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

test("a claude command past its timeout is killed and fails, saying so", () => {
  const started = Date.now();
  const r = claudeCli("/bin/sleep", 200)(["5"]);
  expect(r).toEqual({ exitCode: 1, out: "timed out after 0.2s" });
  expect(Date.now() - started).toBeLessThan(4000);
});
