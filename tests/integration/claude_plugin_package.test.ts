// The Claude Code plugin as a marketplace installs it (#281): the committed
// bundle is a fresh build of the source, the manifest's version is the
// release's, its server runs that bundle, and the marketplace pins a release
// tag's commit. Claude Code keeps a user on a plugin version until the
// manifest's changes, so a version that lagged package.json would strand
// every user on an old bundle.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BUNDLE, BUNDLES, bundle } from "../../scripts/build_claude_plugin.ts";
import { pinMarketplace, renderMarketplace, SHA_RE, TAG_RE, verifyPin } from "../../scripts/pin_claude_plugin.ts";
import pkg from "../../package.json" with { type: "json" };

const ROOT = resolve(import.meta.dir, "../..");
const PLUGIN = join(ROOT, "plugins/claude-code");
const manifest = JSON.parse(readFileSync(join(PLUGIN, ".claude-plugin/plugin.json"), "utf8"));
const marketplace = JSON.parse(readFileSync(join(ROOT, ".claude-plugin/marketplace.json"), "utf8"));

// The build resolves hosted-core's dependencies from the root install, so the
// bundle is the same whether or not hosted-core's own gate has installed
// adapters/hosted-core/node_modules, and carries one copy of each package.
test("the committed bundles are fresh builds of plugins/claude-code/src (run `bun scripts/build_claude_plugin.ts`)", async () => {
  for (const b of BUNDLES) {
    const fresh = await bundle(b.entry);
    expect(fresh.includes("// adapters/hosted-core/node_modules/")).toBe(false);
    expect({ path: b.path, fresh: readFileSync(b.path, "utf8") === fresh }).toEqual({ path: b.path, fresh: true });
  }
}, 60_000);

// The hooks that make a subagent's calls its own child session (#551): every
// grayboard tool's PreToolUse, and the session's start, end and subagent stops.
test("the plugin's hooks run the hook bundle with bun for each event", () => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN, "hooks/hooks.json"), "utf8")).hooks;
  const run = (event: string) => [{ type: "command", command: `bun "\${CLAUDE_PLUGIN_ROOT}/dist/hook.js" ${event} --data "\${CLAUDE_PLUGIN_DATA}"`, timeout: 10 }];
  expect(hooks).toEqual({
    SessionStart: [{ matcher: "startup|resume|clear|fork", hooks: run("session-start") }],
    PreToolUse: [{ matcher: "mcp__plugin_grayboard_grayboard__.*", hooks: run("pre-tool-use") }],
    SubagentStop: [{ hooks: run("subagent-stop") }],
    SessionEnd: [{ hooks: run("session-end") }],
  });
});

test("the manifest carries package.json's version and runs the bundle with bun, with the server URL from userConfig", () => {
  expect(manifest.name).toBe("grayboard");
  expect(manifest.version).toBe(pkg.version);
  expect(manifest.mcpServers).toEqual({
    grayboard: { command: "bun", args: ["${CLAUDE_PLUGIN_ROOT}/dist/grayboard.js"], env: { GRAYBOARD_SERVER_URL: "${user_config.server_url}" } },
  });
  // `claude plugin install --config server_url=…` sets only top-level userConfig.
  expect(manifest.userConfig.server_url).toMatchObject({ type: "string", required: true });
  expect(manifest.channels).toEqual([{ server: "grayboard", displayName: "Grayboard" }]);
  const skill = readFileSync(join(PLUGIN, "skills/logout/SKILL.md"), "utf8");
  expect(skill).toContain("\ndisable-model-invocation: true\n");
  expect(skill).toContain('!`bun "${CLAUDE_PLUGIN_ROOT}/dist/grayboard.js" logout --data "${CLAUDE_PLUGIN_DATA}"`');
});

const expectPinned = (doc: { name: string; plugins: { name: string; source: unknown }[] }) => {
  expect(doc.name).toBe("grayboard");
  for (const entry of doc.plugins) {
    expect(entry.name).toBe("grayboard");
    expect(entry.source).toEqual({ source: "git-subdir", url: "https://github.com/nolnoch/grayboard.git", path: "plugins/claude-code", ref: expect.stringMatching(TAG_RE), sha: expect.stringMatching(SHA_RE) });
  }
  expect(doc.plugins.length).toBeLessThanOrEqual(1);
};

test("the marketplace's grayboard entry, once the release job pins one, names a release tag's commit in this repo's plugin directory", () => {
  expectPinned(marketplace);
});

test("the release job's pin writes that entry, replacing any earlier pin, and refuses a malformed tag or commit", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const first = pinMarketplace(marketplace, "v2.3.0", sha);
  expectPinned(first);
  expect(first.plugins).toHaveLength(1);
  const next = pinMarketplace(first, "v2.4.0-rc1", sha.replace("0", "f"));
  expectPinned(next);
  expect(next.plugins).toEqual([{ name: "grayboard", source: expect.objectContaining({ ref: "v2.4.0-rc1" }) }]);
  // Everything else in the file is kept.
  expect({ ...next, plugins: [] }).toEqual({ ...marketplace, plugins: [] });
  expect(() => pinMarketplace(marketplace, "2.3.0", sha)).toThrow("isn't a release tag");
  expect(() => pinMarketplace(marketplace, "v2.3.0", sha.slice(1))).toThrow("isn't a full 40-hex commit");
});

// #507: a pin-only PR skips the suites, so its check must prove the file is
// only a forward pin: anything else beside the pin, or a downgrade, fails.
test("the pin PR's check accepts exactly the script's re-pin of the base to a newer release", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const base = renderMarketplace(pinMarketplace(marketplace, "v2.3.0", sha));
  const pinned = (ref: string, doc = JSON.parse(base)) => renderMarketplace(pinMarketplace(doc, ref, sha.replace("0", "f")));
  expect(verifyPin(base, pinned("v2.3.1"))).toEqual({ ref: "v2.3.1", sha: sha.replace("0", "f") });
  expect(verifyPin(renderMarketplace({ ...marketplace, plugins: [] }), pinned("v2.3.0"))).toEqual({ ref: "v2.3.0", sha: sha.replace("0", "f") });
  const head = JSON.parse(pinned("v2.3.1"));
  const changed = (edit: (doc: any) => void) => { const doc = structuredClone(head); edit(doc); return renderMarketplace(doc); };
  expect(() => verifyPin(base, changed((doc) => { doc.plugins[0].mcpServers = { x: { command: "sh" } }; }))).toThrow("changes more than the base's pin");
  expect(() => verifyPin(base, changed((doc) => { doc.plugins[0].source.extra = 1; }))).toThrow("changes more than the base's pin");
  expect(() => verifyPin(base, changed((doc) => { doc.owner = { name: "someone" }; }))).toThrow("changes more than the base's pin");
  expect(() => verifyPin(base, changed((doc) => { doc.plugins.push(doc.plugins[0]); }))).toThrow("changes more than the base's pin");
  expect(() => verifyPin(base, changed((doc) => { doc.plugins[0].source.url = "https://example.com/x.git"; }))).toThrow("changes more than the base's pin");
  expect(() => verifyPin(base, JSON.stringify(head))).toThrow("changes more than the base's pin");
  expect(() => verifyPin(base, pinned("v2.3.0"))).toThrow("v2.3.0 isn't newer than the base's pin v2.3.0");
  expect(() => verifyPin(base, pinned("v2.2.9"))).toThrow("isn't newer");
  expect(() => verifyPin(base, pinned("v2.3.0-rc1"))).toThrow("isn't newer");
  expect(() => verifyPin(base, changed((doc) => { doc.plugins[0].source.sha = "HEAD"; }))).toThrow("isn't a full 40-hex commit");
  expect(() => verifyPin(base, renderMarketplace({ ...head, plugins: [] }))).toThrow("no pinned grayboard entry");
});

test("`verify <base>` checks the committed marketplace against a base file and exits 1 naming the failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-pin-verify-"));
  try {
    const run = (base: string) => {
      writeFileSync(join(dir, "base.json"), base);
      return Bun.spawnSync([process.execPath, join(ROOT, "scripts/pin_claude_plugin.ts"), "verify", join(dir, "base.json")], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
    };
    const ok = run(renderMarketplace({ ...marketplace, plugins: [] }));
    expect(ok.stderr.toString()).toBe("");
    expect(ok.stdout.toString()).toContain(`only moves the pin, to ${marketplace.plugins[0].source.ref}`);
    expect(ok.exitCode).toBe(0);
    const same = run(readFileSync(join(ROOT, ".claude-plugin/marketplace.json"), "utf8"));
    expect(same.stderr.toString()).toContain("pin check failed:");
    expect(same.stderr.toString()).toContain("isn't newer than the base's pin");
    expect(same.exitCode).toBe(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the bundle runs under bun: logout on an empty data dir has nothing to sign out of", () => {
  const data = mkdtempSync(join(tmpdir(), "gb-claude-bundle-"));
  try {
    const r = Bun.spawnSync([process.execPath, BUNDLE, "logout", "--data", data], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
    expect(r.stderr.toString()).toBe("");
    expect(r.stdout.toString()).toBe("Not signed in to grayboard; nothing to sign out of.\n");
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(data, "grants"))).toBe(false);
  } finally { rmSync(data, { recursive: true, force: true }); }
});

test("logout with an unreadable grant file fails instead of claiming nothing to sign out of", () => {
  const data = mkdtempSync(join(tmpdir(), "gb-claude-bundle-"));
  try {
    mkdirSync(join(data, "grants"));
    writeFileSync(join(data, "grants", `${"a".repeat(64)}.json`), "{not json");
    const r = Bun.spawnSync([process.execPath, BUNDLE, "logout", "--data", data], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
    expect(r.stderr.toString()).toContain("couldn't read");
    expect(r.stdout.toString()).toBe("");
    expect(r.exitCode).toBe(1);
  } finally { rmSync(data, { recursive: true, force: true }); }
});
