// Pins the Claude Code plugin's marketplace entry to a published release
// (#281): `bun scripts/pin_claude_plugin.ts vX.Y.Z <40-hex tag commit>`
// rewrites .claude-plugin/marketplace.json so `plugins` holds one grayboard
// entry whose Git-subdirectory source names that tag and commit. The release
// workflow's plugin-pin job runs it once the release is immutable (its tag
// can then never move) and pushes the result to a branch the maintainer
// opens as a PR (AGENTS.md §Releasing step 5).
//
// `bun scripts/pin_claude_plugin.ts verify <base marketplace.json>` is that
// PR's check (#507): the checked-out file must be exactly what this script
// writes from the base's file, pinned to a release newer than the base's.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { versionOrder } from "../src/cli/update.ts";
import { RELEASE_TAG } from "../src/shared/release_verify.ts";

export const MARKETPLACE = join(resolve(import.meta.dir, ".."), ".claude-plugin/marketplace.json");
export const PLUGIN_GIT_URL = "https://github.com/nolnoch/grayboard.git";
export const PLUGIN_PATH = "plugins/claude-code";
export const TAG_RE = RELEASE_TAG;
export const SHA_RE = /^[0-9a-f]{40}$/;

type Marketplace = { name: string; plugins: unknown[]; [k: string]: unknown };

/** `doc` with its one grayboard entry pinned to `tag` at `sha`. Throws on a malformed tag or sha. */
export function pinMarketplace(doc: Marketplace, tag: string, sha: string): Marketplace {
  if (!TAG_RE.test(tag)) throw new Error(`${JSON.stringify(tag)} isn't a release tag (v<semver>)`);
  if (!SHA_RE.test(sha)) throw new Error(`${JSON.stringify(sha)} isn't a full 40-hex commit`);
  const source = { source: "git-subdir", url: PLUGIN_GIT_URL, path: PLUGIN_PATH, ref: tag, sha };
  return { ...doc, plugins: [{ name: "grayboard", source }] };
}

/** The file text this script writes for `doc`. */
export const renderMarketplace = (doc: Marketplace): string => JSON.stringify(doc, null, 2) + "\n";

const pinOf = (doc: Marketplace): { ref?: unknown; sha?: unknown } | undefined =>
  (doc.plugins?.[0] as { source?: { ref?: unknown; sha?: unknown } } | undefined)?.source;

/**
 * The pin `head` makes, if `head` is byte for byte what {@link pinMarketplace}
 * writes from `base` and its tag is newer than `base`'s pin (if any). Throws
 * naming the difference otherwise: a key added or changed beside the pin, a
 * reformatted file, or a pin that doesn't move forward.
 */
export function verifyPin(base: string, head: string): { ref: string; sha: string } {
  const { ref, sha } = pinOf(JSON.parse(head) as Marketplace) ?? {};
  if (typeof ref !== "string" || typeof sha !== "string") throw new Error("the marketplace has no pinned grayboard entry");
  const baseDoc = JSON.parse(base) as Marketplace;
  const expected = renderMarketplace(pinMarketplace(baseDoc, ref, sha));
  if (head !== expected) throw new Error(`the marketplace changes more than the base's pin; pinning ${ref} writes:\n${expected}`);
  const was = pinOf(baseDoc)?.ref;
  if (was !== undefined && versionOrder(ref, String(was)) <= 0) throw new Error(`${ref} isn't newer than the base's pin ${String(was)}`);
  return { ref, sha };
}

if (import.meta.main) {
  const [first, second] = process.argv.slice(2);
  if (!first || !second) {
    console.error("usage: bun scripts/pin_claude_plugin.ts vX.Y.Z <40-hex tag commit>\n       bun scripts/pin_claude_plugin.ts verify <base marketplace.json>");
    process.exit(2);
  }
  if (first === "verify") {
    try {
      const { ref, sha } = verifyPin(readFileSync(second, "utf8"), readFileSync(MARKETPLACE, "utf8"));
      console.log(`${MARKETPLACE} only moves the pin, to ${ref} (${sha})`);
    } catch (e) {
      console.error(`pin check failed: ${(e as Error).message}`);
      process.exit(1);
    }
  } else {
    const next = pinMarketplace(JSON.parse(readFileSync(MARKETPLACE, "utf8")), first, second);
    writeFileSync(MARKETPLACE, renderMarketplace(next));
    console.log(`pinned ${MARKETPLACE} to ${first} (${second})`);
  }
}
