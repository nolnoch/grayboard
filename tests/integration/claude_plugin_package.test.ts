// The Claude Code plugin as a marketplace installs it (#281): the committed
// bundle is a fresh build of the source, the manifest's version is the
// release's, its server runs that bundle, and the marketplace pins a release
// tag's commit. Claude Code keeps a user on a plugin version until the
// manifest's changes, so a version that lagged package.json would strand
// every user on an old bundle.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BUNDLE, bundle } from "../../scripts/build_claude_plugin.ts";
import { pinMarketplace, SHA_RE, TAG_RE } from "../../scripts/pin_claude_plugin.ts";
import pkg from "../../package.json" with { type: "json" };

const ROOT = resolve(import.meta.dir, "../..");
const PLUGIN = join(ROOT, "plugins/claude-code");
const manifest = JSON.parse(readFileSync(join(PLUGIN, ".claude-plugin/plugin.json"), "utf8"));
const marketplace = JSON.parse(readFileSync(join(ROOT, ".claude-plugin/marketplace.json"), "utf8"));

test("the committed bundle is a fresh build of plugins/claude-code/src (run `bun scripts/build_claude_plugin.ts`)", () => {
  expect(readFileSync(BUNDLE, "utf8") === bundle()).toBe(true);
}, 60_000);

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
