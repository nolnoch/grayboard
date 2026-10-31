// `grayboard setup` and `refresh-adapters` install pi's adapter for the mode
// (#279): local mode the child adapter and its disabled mcp.json entry, server
// mode the hosted extension bundle and its config.json, with no entry. Each
// install removes the other variant.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "main.ts");
const localSource = readFileSync(new URL("../../adapters/pi/grayboard.ts", import.meta.url), "utf8");
// Refused connections: setup's sign-out call fails fast and is ignored.
const SERVER = "http://127.0.0.1:9";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "gb-pi-setup-"));
  roots.push(root);
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "pi"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(root, "bin", "pi"), 0o755);
  const pi = join(root, "pi");
  const paths = { local: join(pi, "extensions", "grayboard.ts"), hosted: join(pi, "extensions", "grayboard.js"), mcp: join(pi, "mcp.json"), config: join(pi, "grayboard", "config.json") };
  const run = (...args: string[]) => {
    const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config"), GRAYBOARD_CREDENTIALS: join(root, "credentials"), PI_CODING_AGENT_DIR: pi,
      PATH: join(root, "bin"), GRAYBOARD_TOKEN: undefined, GRAYBOARD_SERVER: undefined, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
    const r = Bun.spawnSync([process.execPath, cli, ...args], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode, r.stderr.toString()).toBe(0);
    return r.stdout.toString();
  };
  // A signed-in credentials file, as `grayboard login` writes it.
  const signIn = () => writeFileSync(join(root, "credentials"), JSON.stringify({ server: SERVER, session_token: "t", user_email: "you@example.com" }));
  const entry = () => (JSON.parse(readFileSync(paths.mcp, "utf8")) as { mcpServers?: Record<string, unknown> }).mcpServers?.grayboard;
  return { root, paths, run, signIn, entry };
}

// From source the command is bun, as mcpCommand() names it.
const localEntry = { command: "bun", args: [cli, "mcp"], enabled: false, env: { BUS_PUSH: "off" } };

function expectLocal(f: ReturnType<typeof fixture>) {
  expect(readFileSync(f.paths.local, "utf8")).toBe(localSource);
  expect(existsSync(f.paths.hosted)).toBe(false);
  expect(f.entry()).toEqual(localEntry);
}

function expectHosted(f: ReturnType<typeof fixture>) {
  const bundle = readFileSync(f.paths.hosted, "utf8");
  // A Node bundle of the hosted extension: nothing Bun-only, no runtime import of pi.
  expect(bundle).toContain("adapters/pi-family/entry-pi.ts");
  expect(bundle).not.toMatch(/from ["']bun(:[a-z]+)?["']/);
  expect(bundle).not.toMatch(/from ["']@earendil-works\//);
  expect(existsSync(f.paths.local)).toBe(false);
  expect(f.entry()).toBeUndefined();
  expect(JSON.parse(readFileSync(f.paths.config, "utf8"))).toEqual({ url: `${SERVER}/mcp` });
}

test("setup switches pi's adapter local → server → local, with the entry and config.json each mode needs", () => {
  const f = fixture();
  f.run("setup", "--local", "-y");
  expectLocal(f);

  f.signIn();
  // A user's own MCP servers stay.
  writeFileSync(f.paths.mcp, JSON.stringify({ mcpServers: { other: { command: "x" }, grayboard: localEntry } }));
  expect(f.run("setup", "--server", SERVER, "-y")).toContain("Run /grayboard login in pi");
  expectHosted(f);
  expect(JSON.parse(readFileSync(f.paths.mcp, "utf8")).mcpServers.other).toEqual({ command: "x" });

  f.run("setup", "--local", "-y");
  expectLocal(f);
}, 60_000);

test("refresh-adapters installs the current mode's pi adapter where either is installed, and leaves symlinks and absent installs alone", () => {
  const f = fixture();
  // Nothing installed: nothing written.
  f.signIn();
  f.run("refresh-adapters");
  expect(existsSync(f.paths.local) || existsSync(f.paths.hosted)).toBe(false);

  // An old local install migrates to the hosted extension in server mode.
  mkdirSync(join(f.paths.local, ".."), { recursive: true });
  writeFileSync(f.paths.local, "// stale");
  writeFileSync(f.paths.mcp, JSON.stringify({ mcpServers: { grayboard: localEntry } }));
  expect(f.run("refresh-adapters")).toContain(`Refreshed ${f.paths.hosted}`);
  expectHosted(f);

  // Back in local mode the entry the local adapter reads is recreated.
  rmSync(join(f.root, "credentials"));
  f.run("refresh-adapters");
  expectLocal(f);

  // A checkout linked in on purpose is left, and the other variant isn't added.
  rmSync(f.paths.local);
  writeFileSync(join(f.root, "checkout.ts"), "// mine");
  symlinkSync(join(f.root, "checkout.ts"), f.paths.local);
  f.signIn();
  f.run("refresh-adapters");
  expect(lstatSync(f.paths.local).isSymbolicLink()).toBe(true);
  expect(existsSync(f.paths.hosted)).toBe(false);
}, 60_000);
