// Published grayboard releases, for the upgrade tier: which tag came before
// this tree, and that release's CLI and server binaries for this machine.
// Binaries are downloaded once into .e2e-cache/releases/<tag>/ and reused; a
// download that fails fails the test (no stand-in binary).
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { newer } from "../../src/cli/update.ts";
import { ROOT } from "./paths.ts";

const REPO = "nolnoch/grayboard";
export const CACHE = join(ROOT, ".e2e-cache");

// The support floor: older databases aren't expected to open under HEAD.
export const FLOOR = "v1.0.0";

type Release = { tag_name: string; draft: boolean; prerelease: boolean };

// Every published v1.x release at or above the floor, newest first. CI passes
// GITHUB_TOKEN, which lifts the API's anonymous rate limit.
export async function releases(): Promise<string[]> {
  const headers: Record<string, string> = { accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, { headers });
  if (!r.ok) throw new Error(`listing ${REPO} releases: HTTP ${r.status} ${await r.text()}`);
  return ((await r.json()) as Release[])
    .filter((x) => !x.draft && !x.prerelease && !newer(FLOOR, x.tag_name))
    .map((x) => x.tag_name)
    .sort((a, b) => (newer(a, b) ? -1 : newer(b, a) ? 1 : 0));
}

// The newest release other than this tree's own version: what a user upgrades from.
export async function previousRelease(): Promise<string> {
  const tag = (await releases()).find((t) => t !== `v${pkg.version}`);
  if (!tag) throw new Error(`no release at or above ${FLOOR} other than v${pkg.version}`);
  return tag;
}

export type ReleaseBinaries = { tag: string; cli: string; server: string };

// The release's CLI and server for this platform, from the cache or downloaded.
export async function releaseBinaries(tag: string): Promise<ReleaseBinaries> {
  const dir = join(CACHE, "releases", tag);
  mkdirSync(dir, { recursive: true });
  const target = `${process.platform}-${process.arch}`;
  const get = async (asset: string): Promise<string> => {
    const path = join(dir, asset);
    if (existsSync(path)) return path;
    const r = await fetch(`https://github.com/${REPO}/releases/download/${tag}/${asset}`);
    if (!r.ok) throw new Error(`downloading ${tag}/${asset}: HTTP ${r.status}`);
    // Written aside and renamed, so an interrupted download never looks cached.
    const part = `${path}.${process.pid}.part`;
    writeFileSync(part, new Uint8Array(await r.arrayBuffer()));
    chmodSync(part, 0o755);
    renameSync(part, path);
    return path;
  };
  const [cli, server] = await Promise.all([get(`grayboard-${target}`), get(`grayboard-server-${target}`)]);
  return { tag, cli, server };
}
