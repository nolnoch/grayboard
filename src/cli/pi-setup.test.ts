// `grayboard setup` and `refresh-adapters` install pi's adapter for the mode
// (#279): local mode the child adapter and its disabled mcp.json entry, server
// mode the hosted extension bundle and its config.json, with no entry. Each
// install removes the other variant. A server URL the hosted extension would
// refuse changes nothing for pi, and leaving a hosted install's server signs
// pi out of it, revoking its grant.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Login } from "../../adapters/hosted-core/src/login.ts";
import { writeJsonAtomic } from "../../adapters/hosted-core/src/storage.ts";

const cli = join(import.meta.dir, "main.ts");
const localSource = readFileSync(new URL("../../adapters/pi/grayboard.ts", import.meta.url), "utf8");
// Refused connections: setup's sign-out call and pi's grant revoke fail fast.
const SERVER = "http://127.0.0.1:9";
const CANONICAL_RULE = "canonical HTTPS (or loopback HTTP) server URL, without credentials, query or fragment";

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
  const exec = (args: string[], piDir = pi) => {
    const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config"), GRAYBOARD_CREDENTIALS: join(root, "credentials"), PI_CODING_AGENT_DIR: piDir,
      PATH: join(root, "bin"), GRAYBOARD_TOKEN: undefined, GRAYBOARD_SERVER: undefined, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
    const r = Bun.spawnSync([process.execPath, cli, ...args], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  };
  const run = (...args: string[]) => {
    const r = exec(args);
    expect(r.exitCode, r.stderr).toBe(0);
    return r.stdout;
  };
  // A signed-in credentials file, as `grayboard login` writes it.
  const signIn = (server = SERVER) => writeFileSync(join(root, "credentials"), JSON.stringify({ server, session_token: "t", user_email: "you@example.com" }));
  const entry = () => (JSON.parse(readFileSync(paths.mcp, "utf8")) as { mcpServers?: Record<string, unknown> }).mcpServers?.grayboard;
  // pi's grant store for `resource`, as the hosted extension's Login names it.
  const grant = (resource = `${SERVER}/mcp`) => new Login({ resource, clientId: "grayboard-pi", stateDir: join(pi, "grayboard"), harness: "pi", loginAction: "run /grayboard login", present: () => {}, notify: () => {}, diagnostic: () => {} });
  // A finished /grayboard login's store (tests/support/hosted_oauth.ts seedGrant).
  const seedGrant = async () => {
    const resource = `${SERVER}/mcp`;
    await writeJsonAtomic(grant(resource).path, { version: 1, resource, clientId: "grayboard-pi", epoch: "seeded", issuer: SERVER, scope: "grayboard:tools grayboard:delivery",
      access: "a", accessExpiresAt: Date.now() + 3_600_000, refresh: "r" });
  };
  return { root, pi, paths, exec, run, signIn, entry, grant, seedGrant };
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

  // A never-signed-in pi: no grant to revoke, so none is created.
  const out = f.run("setup", "--local", "-y");
  expectLocal(f);
  expect(existsSync(f.paths.config)).toBe(false);
  expect(existsSync(join(f.pi, "grayboard", "grants"))).toBe(false);
  expect(out).not.toContain("Signed pi out");
}, 60_000);

test("setup resolves PI_CODING_AGENT_DIR as pi does: a leading ~ is the home directory", () => {
  const f = fixture();
  const r = f.exec(["setup", "--local", "-y"], "~/pi");
  expect(r.exitCode, r.stderr).toBe(0);
  expectLocal(f);
}, 60_000);

test("a server URL the hosted extension would refuse changes nothing for pi", () => {
  const f = fixture();
  f.run("setup", "--local", "-y");
  const before = { local: readFileSync(f.paths.local, "utf8"), mcp: readFileSync(f.paths.mcp, "utf8") };
  const unchanged = () => {
    expect(readFileSync(f.paths.local, "utf8")).toBe(before.local);
    expect(readFileSync(f.paths.mcp, "utf8")).toBe(before.mcp);
    expect(existsSync(f.paths.hosted)).toBe(false);
    expect(existsSync(f.paths.config)).toBe(false);
  };
  // Plain HTTP off loopback: the CLI login accepts it, the extension doesn't.
  const bad = "http://10.0.0.5:8080";
  f.signIn(bad);
  const setup = f.exec(["setup", "--server", bad, "-y"]);
  expect(setup.exitCode).toBe(1);
  expect(setup.stderr).toContain(CANONICAL_RULE);
  unchanged();

  // `update`'s refresh reports on stdout, since update drops its stderr.
  const refresh = f.exec(["refresh-adapters"]);
  expect(refresh.exitCode).toBe(1);
  expect(refresh.stdout).toContain(CANONICAL_RULE);
  unchanged();
}, 60_000);

// The store a logout leaves: signed out under a new epoch, its refresh token
// queued for revoking because SERVER refuses connections.
async function expectLoggedOut(f: ReturnType<typeof fixture>, out: string) {
  const s = await f.grant().read();
  expect(s).toMatchObject({ loginRequired: { reason: "logged_out" }, revoke: ["r"] });
  expect(s?.refresh).toBeUndefined();
  expect(s?.epoch).not.toBe("seeded");
  expect(out).toContain(`Signed pi out of ${SERVER}/mcp; revoking its grant failed and stays queued for its next login there (`);
}

test("setup --local signs pi out of its server, revoking its grant, and removes config.json", async () => {
  const f = fixture();
  f.signIn();
  f.run("setup", "--server", SERVER, "-y");
  await f.seedGrant();
  const out = f.run("setup", "--local", "-y");
  await expectLoggedOut(f, out);
  expectLocal(f);
  expect(existsSync(f.paths.config)).toBe(false);
}, 60_000);

test("setup --server <another server> signs pi out of the old one and points config.json at the new one", async () => {
  const f = fixture();
  f.signIn();
  f.run("setup", "--server", SERVER, "-y");
  await f.seedGrant();
  const other = "http://localhost:9";
  f.signIn(other);
  const out = f.run("setup", "--server", other, "-y");
  await expectLoggedOut(f, out);
  expect(JSON.parse(readFileSync(f.paths.config, "utf8"))).toEqual({ url: `${other}/mcp` });
  expect(existsSync(f.paths.hosted)).toBe(true);
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
