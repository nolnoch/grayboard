// The installers, run as a user runs them, in a temp HOME: install.sh fetching
// from a local release server (GRAYBOARD_RELEASES_URL), `grayboard setup` with
// stub claude, omp, opencode and pi on PATH (claude records its argv; setup
// only looks the others up), and `grayboard update` from an older release to
// the build under test, which then refreshes the push adapters.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { adapterSource } from "../../src/cli/adapters.ts";
import { REPO, TARGET } from "../../src/cli/update.ts";
import { buildCli } from "../support/build.ts";
import { runCli, type CliResult } from "../support/cli.ts";
import { cleanEnv } from "../support/env.ts";
import { ROOT } from "../support/paths.ts";
import { ReleaseServer } from "../support/release_server.ts";
import { ownUpdater, previousRelease, releaseBinaries } from "../support/releases.ts";
import { keep } from "../support/run_dir.ts";
import { TestServer } from "../support/server.ts";

const ASSET = `grayboard-${TARGET}`;
const TAG = `v${pkg.version}`;
// The release the update test starts from (scripts/e2e.sh runs it per tag).
const FROM = process.env.GRAYBOARD_UPGRADE_FROM ?? (await previousRelease());

let buildDir: string;
let built: string;
let dir: string;
let label: string;
let home: string;
let bin: string;
let releases: ReleaseServer | undefined;
let srv: TestServer | undefined;

beforeAll(async () => {
  buildDir = mkdtempSync(join(tmpdir(), "grayboard-built-"));
  built = await buildCli(join(buildDir, "grayboard"));
}, 60_000);

afterAll(() => {
  rmSync(buildDir, { recursive: true, force: true });
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grayboard-installers-"));
  home = join(dir, "home");
  bin = join(home, ".local", "bin");
  mkdirSync(join(dir, "stubs"), { recursive: true });
  for (const name of ["claude", "omp", "opencode", "pi"]) {
    const p = join(dir, "stubs", name);
    writeFileSync(p, `#!/bin/sh\necho "${name} $*" >> "${join(dir, "argv.log")}"\n`);
    chmodSync(p, 0o755);
  }
});

// Under scripts/e2e.sh each test keeps its temp HOME (less the installed
// binaries), the stubs' argv.log and the release server's requests.
afterEach(() => {
  if (releases) writeFileSync(join(dir, "requests.log"), releases.requests.join("\n") + "\n");
  releases?.stop();
  releases = undefined;
  srv?.stop();
  srv = undefined;
  keep(label, dir, (p) => p.startsWith(bin + "/") || p.startsWith(join(dir, "grayboard-")));
  rmSync(dir, { recursive: true, force: true });
});

const env = (extra: Record<string, string> = {}): Record<string, string> =>
  cleanEnv({ HOME: home, PATH: `${join(dir, "stubs")}:${bin}:/usr/bin:/bin`, GRAYBOARD_RELEASES_URL: releases!.url, ...extra });

const install = (extra: Record<string, string> = {}): Promise<CliResult> =>
  runCli([join(ROOT, "install.sh")], { bin: "/bin/bash", env: env({ INSTALL_DIR: bin, GRAYBOARD_NO_SETUP: "1", ...extra }), timeoutMs: 30_000 });

const grayboard = (...args: string[]): Promise<CliResult> => runCli(args, { bin: join(bin, "grayboard"), env: env(), cwd: dir });

async function expectOk(r: Promise<CliResult>): Promise<string> {
  const { code, out, err } = await r;
  expect(code, `${out}\n${err}`).toBe(0);
  return out;
}

const json = (...path: string[]) => JSON.parse(readFileSync(join(home, ...path), "utf8"));
const ADAPTERS = {
  omp: [".omp", "agent", "extensions", "grayboard.ts"],
  opencode: [".config", "opencode", "plugin", "grayboard.ts"],
  pi: [".pi", "agent", "extensions", "grayboard.ts"],
} as const;
// The tools-only entries releases before the adapters served the tools wrote.
function writeOldEntries(exe: string, extraEnv: Record<string, string> = {}): void {
  mkdirSync(join(home, ".config", "opencode"), { recursive: true });
  writeFileSync(join(home, ".config", "opencode", "opencode.json"),
    JSON.stringify({ mcp: { grayboard: { type: "local", command: [exe, "mcp"], environment: { BUS_PUSH: "off", ...extraEnv } } } }));
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "mcp.json"),
    JSON.stringify({ mcpServers: { grayboard: { command: exe, args: ["mcp"], env: { BUS_PUSH: "off", ...extraEnv }, exposure: "direct" } } }));
}
const CREDENTIALS = () => join(home, ".grayboard", "credentials");

// Every registration setup writes, each naming the installed binary.
function expectRegistered(): void {
  // A compiled binary's execPath is its resolved path.
  const exe = realpathSync(join(bin, "grayboard"));
  const argv = readFileSync(join(dir, "argv.log"), "utf8").trim().split("\n");
  expect(argv).toEqual(["claude mcp remove --scope user grayboard", `claude mcp add --scope user grayboard -- ${exe} mcp`]);
  expect(json(".claude", "settings.json").hooks.SessionStart).toEqual([
    { matcher: "startup|resume|fork", hooks: [{ type: "command", command: `${exe} session-start`, timeout: 10 }] },
  ]);
  expect(json(".omp", "agent", "mcp.json").mcpServers.grayboard).toEqual({ command: exe, args: ["mcp"] });
  // Disabled: the opencode and pi adapters serve the tools and read their command here.
  expect(json(".config", "opencode", "opencode.json").mcp.grayboard).toEqual({ type: "local", command: [exe, "mcp"], enabled: false, environment: { BUS_PUSH: "off" } });
  expect(json(".pi", "agent", "mcp.json").mcpServers.grayboard).toEqual({ command: exe, args: ["mcp"], enabled: false, env: { BUS_PUSH: "off" } });
  for (const [harness, path] of Object.entries(ADAPTERS)) {
    expect(readFileSync(join(home, ...path), "utf8"), harness).toBe(adapterSource(harness as keyof typeof ADAPTERS));
  }
}

test("install.sh installs the latest release; setup --local registers it with every harness", async () => {
  label = "install-setup-local";
  releases = new ReleaseServer(REPO, TAG, { [TAG]: { [ASSET]: built } });
  expect(await expectOk(install())).toContain(`installing ${TAG}`);
  expect(releases.requests).toEqual(expect.arrayContaining([`HEAD /${REPO}/releases/latest`, `GET /${REPO}/releases/download/${TAG}/${ASSET}`]));
  expect((await expectOk(grayboard("--version"))).trim()).toBe(pkg.version);

  writeOldEntries(realpathSync(join(bin, "grayboard")), { GRAYBOARD_X: "1" });
  const out = await expectOk(grayboard("setup", "-y", "--local"));
  expect(out).toContain("Using local mode.");
  expect(out).toContain(`Registered in ${join(home, ".config", "opencode", "opencode.json")} (disabled: the plugin serves the tools)`);
  expect(out).toContain(`Registered in ${join(home, ".pi", "agent", "mcp.json")} (disabled: the extension serves the tools)`);
  expectRegistered();
  expect(existsSync(CREDENTIALS())).toBe(false);
}, 60_000);

test("setup --server keeps the sign-in at mode 600; logout truncates it; setup --local removes it", async () => {
  label = "setup-server-logout";
  srv = new TestServer();
  releases = new ReleaseServer(REPO, TAG, { [TAG]: { [ASSET]: built } });
  await expectOk(install({ GRAYBOARD_VERSION: TAG }));
  await expectOk(grayboard("login", "--dev", "you@example.com", "--server", srv.base));
  expect(statSync(CREDENTIALS()).mode & 0o777).toBe(0o600);

  expect(await expectOk(grayboard("setup", "-y", "--server", srv.base))).toContain(`Signed in to ${srv.base} as you@example.com.`);
  expectRegistered();

  await expectOk(grayboard("logout"));
  // Still there, so `grayboard mcp` stays in server mode and says why it can't start.
  expect(statSync(CREDENTIALS()).size).toBe(0);
  expect(statSync(CREDENTIALS()).mode & 0o777).toBe(0o600);
  const mcp = await grayboard("mcp");
  expect(mcp.code).not.toBe(0);
  expect(mcp.err).toContain("signed out");

  await expectOk(grayboard("setup", "-y", "--local"));
  expect(existsSync(CREDENTIALS())).toBe(false);
}, 60_000);

test(`update from ${FROM} replaces it with the build under test and refreshes its adapters`, async () => {
  label = `update-from-${FROM}`;
  const old = ownUpdater(FROM)
    ? { tag: FROM, cli: (await releaseBinaries(FROM)).cli }
    : { tag: "v0.0.0", cli: await buildCli(join(dir, "grayboard-v0.0.0"), "0.0.0") };
  releases = new ReleaseServer(REPO, TAG, { [TAG]: { [ASSET]: built }, [old.tag]: { [ASSET]: old.cli } });
  await expectOk(install({ GRAYBOARD_VERSION: old.tag }));
  expect((await expectOk(grayboard("--version"))).trim()).toBe(old.tag.slice(1));

  // An adapter the old release installed, one a checkout links in on purpose, and one never installed.
  const omp = join(home, ...ADAPTERS.omp);
  mkdirSync(join(omp, ".."), { recursive: true });
  writeFileSync(omp, "// stale");
  const opencode = join(home, ...ADAPTERS.opencode);
  mkdirSync(join(opencode, ".."), { recursive: true });
  writeFileSync(join(dir, "checkout.ts"), "// mine");
  symlinkSync(join(dir, "checkout.ts"), opencode);
  // Their entries stay as they are: the checkout's adapter, or none, is what reads them.
  writeOldEntries(realpathSync(join(bin, "grayboard")));
  const entries = [json(".config", "opencode", "opencode.json"), json(".pi", "agent", "mcp.json")];

  const out = await expectOk(grayboard("update"));
  expect(out).toContain(`Updated grayboard ${old.tag.slice(1)} → ${TAG} from ${releases.url}.`);
  expect(out).toContain(`Refreshed ${omp}`);
  expect(releases.requests).toEqual(expect.arrayContaining([`GET /repos/${REPO}/releases/latest`, `GET /${REPO}/releases/download/${TAG}/${ASSET}`]));
  expect((await expectOk(grayboard("--version"))).trim()).toBe(pkg.version);
  expect(readFileSync(omp, "utf8")).toBe(adapterSource("omp"));
  expect(lstatSync(opencode).isSymbolicLink()).toBe(true);
  expect(readlinkSync(opencode)).toBe(join(dir, "checkout.ts"));
  expect(existsSync(join(home, ...ADAPTERS.pi))).toBe(false);
  expect([json(".config", "opencode", "opencode.json"), json(".pi", "agent", "mcp.json")]).toEqual(entries);
  expect(out).not.toContain("Disabled the grayboard entry");
}, 60_000);

test("refresh-adapters disables the grayboard entry of each adapter it rewrites, once", async () => {
  label = "refresh-adapters-entries";
  releases = new ReleaseServer(REPO, TAG, { [TAG]: { [ASSET]: built } });
  await expectOk(install({ GRAYBOARD_VERSION: TAG }));
  const exe = realpathSync(join(bin, "grayboard"));
  for (const h of ["opencode", "pi"] as const) {
    mkdirSync(join(home, ...ADAPTERS[h], ".."), { recursive: true });
    writeFileSync(join(home, ...ADAPTERS[h]), "// stale");
  }
  writeOldEntries(exe, { GRAYBOARD_X: "1" });
  const oc = join(home, ".config", "opencode", "opencode.json");
  const pi = join(home, ".pi", "agent", "mcp.json");

  const out = await expectOk(grayboard("refresh-adapters"));
  expect(out).toContain(`Disabled the grayboard entry in ${oc} (the adapter serves the tools)`);
  expect(out).toContain(`Disabled the grayboard entry in ${pi} (the adapter serves the tools)`);
  // The entry's own command and environment are kept; pi's exposure goes with the tools.
  expect(json(".config", "opencode", "opencode.json").mcp.grayboard).toEqual({ type: "local", command: [exe, "mcp"], enabled: false, environment: { BUS_PUSH: "off", GRAYBOARD_X: "1" } });
  expect(json(".pi", "agent", "mcp.json").mcpServers.grayboard).toEqual({ command: exe, args: ["mcp"], enabled: false, env: { BUS_PUSH: "off", GRAYBOARD_X: "1" } });

  expect(await expectOk(grayboard("refresh-adapters"))).not.toContain("Disabled the grayboard entry");
}, 60_000);
