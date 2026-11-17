// `grayboard setup` and `refresh-adapters` install pi's and omp's adapter for
// the mode (#279, #280): local mode the local adapter and its disabled
// mcp.json entry (#523: omp's adapter serves the tools too), server mode the
// hosted extension bundle and its config.json, with no entry. Each install
// removes the other variant. A server URL the hosted extension would refuse
// changes nothing for pi, and leaving a hosted install's server signs the
// harness out of it, revoking its grant.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Login } from "../../adapters/hosted-core/src/login.ts";
import { writeJsonAtomic } from "../../adapters/hosted-core/src/storage.ts";
import { adapterBundle } from "./adapters.ts" with { type: "macro" };

type Harness = "pi" | "omp";
const HARNESSES: Harness[] = ["pi", "omp"];
const cli = join(import.meta.dir, "main.ts");
const OMP_LOCAL_BUNDLE = adapterBundle("omp", "local");
const localSource = (h: Harness) => h === "omp" ? OMP_LOCAL_BUNDLE : readFileSync(new URL("../../adapters/pi/grayboard.ts", import.meta.url), "utf8");
// Refused connections: setup's sign-out call and pi's grant revoke fail fast.
const SERVER = "http://127.0.0.1:9";
const CANONICAL_RULE = "canonical HTTPS (or loopback HTTP) server URL, without credentials, query or fragment";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(h: Harness = "pi") {
  const root = mkdtempSync(join(tmpdir(), `gb-${h}-setup-`));
  roots.push(root);
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", h), "#!/bin/sh\nexit 0\n");
  chmodSync(join(root, "bin", h), 0o755);
  // pi's agentDir comes from PI_CODING_AGENT_DIR, set only for pi: omp
  // honors it too (#439), so an omp run without it uses ~/.omp/agent.
  const pi = join(root, "pi");
  const dir = h === "pi" ? pi : join(root, ".omp", "agent");
  const paths = { local: join(dir, "extensions", "grayboard.ts"), hosted: join(dir, "extensions", "grayboard.js"), mcp: join(dir, "mcp.json"), config: join(dir, "grayboard", "config.json") };
  const exec = (args: string[], piDir: string | undefined = h === "pi" ? pi : undefined, extra: Record<string, string> = {}) => {
    const env = { ...process.env, OMP_PROFILE: undefined, PI_PROFILE: undefined, PI_CONFIG_DIR: undefined, ...extra,
      HOME: root, XDG_CONFIG_HOME: join(root, "config"), GRAYBOARD_CREDENTIALS: join(root, "credentials"), PI_CODING_AGENT_DIR: piDir,
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
  // The harness's grant store for `resource`, as the hosted extension's Login names it.
  const grant = (resource = `${SERVER}/mcp`) => new Login({ resource, clientId: `grayboard-${h}`, stateDir: join(dir, "grayboard"), harness: h, loginAction: "run /grayboard login", present: () => {}, notify: () => {}, diagnostic: () => {} });
  // A finished /grayboard login's store (tests/support/hosted_oauth.ts seedGrant).
  const seedGrant = async () => {
    const resource = `${SERVER}/mcp`;
    await writeJsonAtomic(grant(resource).path, { version: 1, resource, clientId: `grayboard-${h}`, epoch: "seeded", issuer: SERVER, scope: "grayboard:tools grayboard:delivery",
      access: "a", accessExpiresAt: Date.now() + 3_600_000, refresh: "r" });
  };
  return { h, root, dir, paths, exec, run, signIn, entry, grant, seedGrant };
}

// From source the command is bun, as mcpCommand() names it. The entry is
// disabled: the adapter serves the tools.
const localEntry = { command: "bun", args: [cli, "mcp"], enabled: false, env: { BUS_PUSH: "off" } };

function expectLocal(f: ReturnType<typeof fixture>) {
  expect(readFileSync(f.paths.local, "utf8")).toBe(localSource(f.h));
  if (f.h === "omp") {
    const bundle = readFileSync(f.paths.local, "utf8");
    expect(bundle).toContain("adapters/omp/grayboard.ts");
    expect(bundle).toContain("adapters/hosted-core/src/channel.ts");
    expect(bundle).toContain("adapters/pi-family/omp-instructions.ts");
    expect(bundle).toMatch(/from ["']@oh-my-pi\/pi-coding-agent["']/);
    expect(bundle).not.toMatch(/from ["']\.\.?\//);
  }
  expect(existsSync(f.paths.hosted)).toBe(false);
  expect(f.entry()).toEqual(localEntry);
}

function expectHosted(f: ReturnType<typeof fixture>) {
  const bundle = readFileSync(f.paths.hosted, "utf8");
  // A Node-target bundle of the hosted extension: nothing Bun-only; pi's
  // imports pi as types only, omp's leaves omp's package to the host.
  expect(bundle).toContain(`adapters/pi-family/entry-${f.h}.ts`);
  expect(bundle).not.toMatch(/from ["']bun(:[a-z]+)?["']/);
  expect(bundle).not.toMatch(/from ["']@earendil-works\//);
  if (f.h === "omp") expect(bundle).toMatch(/from ["']@oh-my-pi\/pi-coding-agent["']/);
  expect(existsSync(f.paths.local)).toBe(false);
  expect(f.entry()).toBeUndefined();
  expect(JSON.parse(readFileSync(f.paths.config, "utf8"))).toEqual({ url: `${SERVER}/mcp` });
}

for (const h of HARNESSES) test(`setup switches ${h}'s adapter local → server → local, with the entry and config.json each mode needs`, () => {
  const f = fixture(h);
  f.run("setup", "--local", "-y");
  expectLocal(f);

  f.signIn();
  // A user's own MCP servers stay.
  writeFileSync(f.paths.mcp, JSON.stringify({ mcpServers: { other: { command: "x" }, grayboard: localEntry } }));
  expect(f.run("setup", "--server", SERVER, "-y")).toContain(`Run /grayboard login in ${h}`);
  expectHosted(f);
  expect(JSON.parse(readFileSync(f.paths.mcp, "utf8")).mcpServers.other).toEqual({ command: "x" });

  // A never-signed-in harness: no grant to revoke, so none is created.
  const out = f.run("setup", "--local", "-y");
  expectLocal(f);
  expect(existsSync(f.paths.config)).toBe(false);
  expect(existsSync(join(f.dir, "grayboard", "grants"))).toBe(false);
  expect(out).not.toContain(`Signed ${h} out`);
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
  expect(out).toContain(`Signed ${f.h} out of ${SERVER}/mcp; revoking its grant failed and stays queued for its next login there (`);
}

for (const h of HARNESSES) test(`setup --local signs ${h} out of its server, revoking its grant, and removes config.json`, async () => {
  const f = fixture(h);
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

for (const h of HARNESSES) test(`refresh-adapters installs the current mode's ${h} adapter where either is installed, and leaves symlinks and absent installs alone`, () => {
  const f = fixture(h);
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

// Before #523 omp's local entry was enabled (omp's client served its tools
// and a relay adapter woke the session). `update` runs refresh-adapters, which
// disables it beside the new adapter, keeping the user's own env.
test("refresh-adapters migrates an omp local install's enabled entry to the disabled one the adapter reads", () => {
  const f = fixture("omp");
  mkdirSync(join(f.paths.local, ".."), { recursive: true });
  writeFileSync(f.paths.local, "// the relay adapter");
  writeFileSync(f.paths.mcp, JSON.stringify({ mcpServers: { other: { command: "x" }, grayboard: { command: "bun", args: [cli, "mcp"], env: { BUS_MODEL: "m" } } } }));
  expect(f.run("refresh-adapters")).toContain(`Disabled the grayboard entry in ${f.paths.mcp} (the adapter serves the tools)`);
  expect(readFileSync(f.paths.local, "utf8")).toBe(localSource("omp"));
  expect(f.entry()).toEqual({ command: "bun", args: [cli, "mcp"], enabled: false, env: { BUS_MODEL: "m", BUS_PUSH: "off" } });
  expect(JSON.parse(readFileSync(f.paths.mcp, "utf8")).mcpServers.other).toEqual({ command: "x" });
  // A second refresh changes nothing.
  expect(f.run("refresh-adapters")).not.toContain("Disabled the grayboard entry");
}, 60_000);

// #439: setup installs omp's adapter where omp's getAgentDir() points: a
// named profile has its own agent dir.
test("setup installs omp's adapter in an OMP_PROFILE's agent dir", () => {
  const f = fixture("omp");
  const dir = join(f.root, ".omp", "profiles", "work", "agent");
  const r = f.exec(["setup", "--local", "-y"], undefined, { OMP_PROFILE: "work" });
  expect(r.exitCode, r.stderr).toBe(0);
  expect(readFileSync(join(dir, "extensions", "grayboard.ts"), "utf8")).toBe(localSource("omp"));
  expect(JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8")).mcpServers.grayboard).toEqual(localEntry);
  expect(existsSync(f.dir)).toBe(false);
}, 60_000);

// With PI_CODING_AGENT_DIR set, omp's default profile uses pi's agent dir,
// where each harness would load the other's adapter: setup refuses omp's and
// still installs pi's; refresh-adapters leaves the files to pi.
test("setup refuses omp's adapter in an agent dir it shares with pi; refresh leaves it to pi", () => {
  const f = fixture("omp");
  writeFileSync(join(f.root, "bin", "pi"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(f.root, "bin", "pi"), 0o755);
  const shared = join(f.root, "shared");
  const setup = f.exec(["setup", "--local", "-y"], shared);
  expect(setup.exitCode).toBe(1);
  expect(setup.stderr).toContain(`omp's agent directory is pi's (${shared}: omp reads PI_CODING_AGENT_DIR too)`);
  expect(setup.stderr).toContain("OMP_PROFILE=<name> grayboard setup");
  expect(readFileSync(join(shared, "extensions", "grayboard.ts"), "utf8")).toBe(localSource("pi"));
  expect(existsSync(f.dir)).toBe(false);
  const refresh = f.exec(["refresh-adapters"], shared);
  expect(refresh.exitCode, refresh.stderr).toBe(0);
  expect(refresh.stdout).toBe(`Refreshed ${join(shared, "extensions", "grayboard.ts")}\n`);
  expect(refresh.stderr).not.toContain("omp's");
  expect(readFileSync(join(shared, "extensions", "grayboard.ts"), "utf8")).toBe(localSource("pi"));
}, 60_000);

// In a shared dir only pi's entry is checked: an enabled push-on entry with
// no adapter warns once, as pi, never as omp.
test("refresh-adapters in an agent dir omp shares with pi warns about an undelivered entry once, as pi's", () => {
  const f = fixture("omp");
  const shared = join(f.root, "shared");
  mkdirSync(shared, { recursive: true });
  writeFileSync(join(shared, "mcp.json"), JSON.stringify({ mcpServers: { grayboard: { command: "grayboard", args: ["mcp"] } } }));
  const r = f.exec(["refresh-adapters"], shared);
  expect(r.exitCode, r.stderr).toBe(0);
  const warnings = r.stdout.split("\n").filter(l => l.includes("no grayboard adapter is installed"));
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toStartWith("[grayboard] pi: ");
}, 60_000);

// omp's named profile exports its agent dir as PI_CODING_AGENT_DIR to every
// child (setProfile), so `grayboard` run from omp's bash sees omp's dir there:
// it's omp's, and pi's stays its default.
test("setup and refresh-adapters run inside an omp profile session keep omp's adapter in the profile dir and pi's in its default", () => {
  const f = fixture("omp");
  writeFileSync(join(f.root, "bin", "pi"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(f.root, "bin", "pi"), 0o755);
  const dir = join(f.root, ".omp", "profiles", "work", "agent");
  const pi = join(f.root, ".pi", "agent");
  const setup = f.exec(["setup", "--local", "-y"], dir, { OMP_PROFILE: "work" });
  expect(setup.exitCode, setup.stderr).toBe(0);
  expect(readFileSync(join(dir, "extensions", "grayboard.ts"), "utf8")).toBe(localSource("omp"));
  expect(readFileSync(join(pi, "extensions", "grayboard.ts"), "utf8")).toBe(localSource("pi"));
  const refresh = f.exec(["refresh-adapters"], dir, { OMP_PROFILE: "work" });
  expect(refresh.exitCode, refresh.stderr).toBe(0);
  expect(readFileSync(join(dir, "extensions", "grayboard.ts"), "utf8")).toBe(localSource("omp"));
  expect(readFileSync(join(pi, "extensions", "grayboard.ts"), "utf8")).toBe(localSource("pi"));
}, 60_000);

// omp path-resolves a relative default-profile PI_CODING_AGENT_DIR against
// its own start directory, so setup can't know the dir and refuses.
test("setup refuses omp's adapter for a relative or ~ PI_CODING_AGENT_DIR in the default profile", () => {
  for (const value of ["~/omp", "rel/omp"]) {
    const f = fixture("omp");
    const r = f.exec(["setup", "--local", "-y"], value);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(`omp resolves PI_CODING_AGENT_DIR (${value}) against the directory omp starts in`);
    expect(existsSync(join(f.root, value))).toBe(false);
  }
}, 120_000);

test("setup upgrades an existing raw local omp adapter in place to the bundle", () => {
  const f = fixture("omp");
  mkdirSync(join(f.paths.local, ".."), { recursive: true });
  writeFileSync(f.paths.local, readFileSync(new URL("../../adapters/omp/grayboard.ts", import.meta.url), "utf8"));
  writeFileSync(f.paths.mcp, JSON.stringify({ mcpServers: { grayboard: localEntry } }));
  f.run("setup", "--local", "-y");
  expectLocal(f);
}, 60_000);

// #95: an enabled push-mode entry with no adapter consumes pushes into a void.
for (const h of HARNESSES) test(`setup and refresh-adapters warn when ${h}'s grayboard entry is enabled with push on and no adapter is installed`, () => {
  const f = fixture(h);
  const warning = `${h}: the grayboard entry in ${f.paths.mcp} is enabled with push on, but no grayboard adapter is installed`;
  mkdirSync(f.dir, { recursive: true });
  writeFileSync(f.paths.mcp, JSON.stringify({ mcpServers: { grayboard: { command: "bun", args: [cli, "mcp"] } } }));
  const refresh = f.exec(["refresh-adapters"]);
  expect(refresh.exitCode, refresh.stderr).toBe(0);
  expect(refresh.stdout).toContain(warning);
  // Declining every harness at setup (--no-register) still warns.
  const setup = f.exec(["setup", "--local", "-y", "--no-register"]);
  expect(setup.exitCode, setup.stderr).toBe(0);
  expect(setup.stderr).toContain(warning);
  // BUS_PUSH=off, a disabled entry, or an installed adapter: no warning.
  for (const e of [{ env: { BUS_PUSH: "off" } }, { enabled: false }]) {
    writeFileSync(f.paths.mcp, JSON.stringify({ mcpServers: { grayboard: { command: "bun", args: [cli, "mcp"], ...e } } }));
    expect(f.run("refresh-adapters")).not.toContain(warning);
  }
  writeFileSync(f.paths.mcp, JSON.stringify({ mcpServers: { grayboard: { command: "bun", args: [cli, "mcp"] } } }));
  const fixed = f.exec(["setup", "--local", "-y"]);
  expect(fixed.exitCode, fixed.stderr).toBe(0);
  expect(fixed.stderr + fixed.stdout).not.toContain(warning);
  expect(f.entry()).toEqual(localEntry);
}, 60_000);
