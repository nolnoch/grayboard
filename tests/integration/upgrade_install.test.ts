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
import { newer } from "../../src/cli/update.ts";
import { buildCli } from "../support/build.ts";
import { runCli, type CliResult } from "../support/cli.ts";
import { cleanEnv } from "../support/env.ts";
import { ROOT } from "../support/paths.ts";
import { ReleaseServer } from "../support/release_server.ts";
import { previousRelease, releaseBinaries } from "../support/releases.ts";
import { TestServer } from "../support/server.ts";

const REPO = "nolnoch/grayboard";
const ASSET = `grayboard-${process.platform}-${process.arch}`;
const TAG = `v${pkg.version}`;
// The last release whose `grayboard update` ignores GRAYBOARD_RELEASES_URL:
// from it back, a build of this tree versioned 0.0.0 runs the update instead.
const LAST_WITHOUT_RELEASES_URL = "v1.10.0";

let buildDir: string;
let built: string;
let dir: string;
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

afterEach(() => {
  releases?.stop();
  releases = undefined;
  srv?.stop();
  srv = undefined;
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
  expect(json(".config", "opencode", "opencode.json").mcp.grayboard).toEqual({ type: "local", command: [exe, "mcp"], environment: { BUS_PUSH: "off" } });
  expect(json(".pi", "agent", "mcp.json").mcpServers.grayboard).toEqual({ command: exe, args: ["mcp"], env: { BUS_PUSH: "off" }, exposure: "direct" });
  for (const [harness, path] of Object.entries(ADAPTERS)) {
    expect(readFileSync(join(home, ...path), "utf8"), harness).toBe(adapterSource(harness as keyof typeof ADAPTERS));
  }
}

test("install.sh installs the latest release; setup --local registers it with every harness", async () => {
  releases = new ReleaseServer(REPO, TAG, { [TAG]: { [ASSET]: built } });
  expect(await expectOk(install())).toContain(`installing ${TAG}`);
  expect(releases.requests).toEqual(expect.arrayContaining([`HEAD /${REPO}/releases/latest`, `GET /${REPO}/releases/download/${TAG}/${ASSET}`]));
  expect((await expectOk(grayboard("--version"))).trim()).toBe(pkg.version);

  expect(await expectOk(grayboard("setup", "-y", "--local"))).toContain("Using local mode.");
  expectRegistered();
  expect(existsSync(CREDENTIALS())).toBe(false);
}, 60_000);

test("setup --server keeps the sign-in at mode 600; logout truncates it; setup --local removes it", async () => {
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

test("update replaces an older release with the build under test and refreshes its adapters", async () => {
  const from = process.env.GRAYBOARD_UPGRADE_FROM ?? (await previousRelease());
  const old = newer(from, LAST_WITHOUT_RELEASES_URL)
    ? { tag: from, cli: (await releaseBinaries(from)).cli }
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

  const out = await expectOk(grayboard("update"));
  expect(out).toContain(`Updated grayboard ${old.tag.slice(1)} → ${TAG}.`);
  expect(out).toContain(`Refreshed ${omp}`);
  expect(releases.requests).toEqual(expect.arrayContaining([`GET /repos/${REPO}/releases/latest`, `GET /${REPO}/releases/download/${TAG}/${ASSET}`]));
  expect((await expectOk(grayboard("--version"))).trim()).toBe(pkg.version);
  expect(readFileSync(omp, "utf8")).toBe(adapterSource("omp"));
  expect(lstatSync(opencode).isSymbolicLink()).toBe(true);
  expect(readlinkSync(opencode)).toBe(join(dir, "checkout.ts"));
  expect(existsSync(join(home, ...ADAPTERS.pi))).toBe(false);
}, 60_000);
