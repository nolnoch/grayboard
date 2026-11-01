// Pins the Claude Code plugin's marketplace entry to a published release
// (#281): `bun scripts/pin_claude_plugin.ts vX.Y.Z <40-hex tag commit>`
// rewrites .claude-plugin/marketplace.json so `plugins` holds one grayboard
// entry whose Git-subdirectory source names that tag and commit. The release
// workflow's plugin-pin job runs it once the release is immutable (its tag
// can then never move) and pushes the result to a branch the maintainer
// opens as a PR (AGENTS.md §Releasing step 5).
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const MARKETPLACE = join(resolve(import.meta.dir, ".."), ".claude-plugin/marketplace.json");
export const PLUGIN_GIT_URL = "https://github.com/nolnoch/grayboard.git";
export const PLUGIN_PATH = "plugins/claude-code";
export const TAG_RE = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;
export const SHA_RE = /^[0-9a-f]{40}$/;

type Marketplace = { name: string; plugins: unknown[]; [k: string]: unknown };

/** `doc` with its one grayboard entry pinned to `tag` at `sha`. Throws on a malformed tag or sha. */
export function pinMarketplace(doc: Marketplace, tag: string, sha: string): Marketplace {
  if (!TAG_RE.test(tag)) throw new Error(`${JSON.stringify(tag)} isn't a release tag (v<semver>)`);
  if (!SHA_RE.test(sha)) throw new Error(`${JSON.stringify(sha)} isn't a full 40-hex commit`);
  const source = { source: "git-subdir", url: PLUGIN_GIT_URL, path: PLUGIN_PATH, ref: tag, sha };
  return { ...doc, plugins: [{ name: "grayboard", source }] };
}

if (import.meta.main) {
  const [tag, sha] = process.argv.slice(2);
  if (!tag || !sha) {
    console.error("usage: bun scripts/pin_claude_plugin.ts vX.Y.Z <40-hex tag commit>");
    process.exit(2);
  }
  const next = pinMarketplace(JSON.parse(readFileSync(MARKETPLACE, "utf8")), tag, sha);
  writeFileSync(MARKETPLACE, JSON.stringify(next, null, 2) + "\n");
  console.log(`pinned ${MARKETPLACE} to ${tag} (${sha})`);
}
