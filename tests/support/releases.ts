// Published grayboard releases, for the upgrade tier: which tag came before
// this tree, and that release's CLI and server binaries for this machine.
// Binaries are downloaded once into .e2e-cache/releases/<tag>/ and reused;
// each, cached or fresh, must match the sha256 GitHub lists for the asset, so
// a re-tagged release or a truncated file is fetched again, never trusted. A
// download that fails fails the test (no stand-in binary).
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { newer, REPO, TARGET } from "../../src/cli/update.ts";
import { ROOT } from "./paths.ts";

export const CACHE = join(ROOT, ".e2e-cache");

// The support floor: older databases aren't expected to open under HEAD.
export const FLOOR = "v1.0.0";

// The last release whose `grayboard update` ignores GRAYBOARD_RELEASES_URL:
// from it back, the update test runs a build of this tree versioned 0.0.0.
export const LAST_WITHOUT_RELEASES_URL = "v1.10.0";

// Whether the release's own `grayboard update` can run against a local
// release server.
export const ownUpdater = (tag: string): boolean => newer(tag, LAST_WITHOUT_RELEASES_URL);

type Asset = { name: string; digest: string | null };
type Release = { tag_name: string; draft: boolean; prerelease: boolean; assets: Asset[] };

let listed: Promise<Release[]> | undefined;

// Every release, all pages, once per process. CI passes GITHUB_TOKEN, which
// lifts the API's anonymous rate limit.
function listAll(): Promise<Release[]> {
  listed ??= (async () => {
    const headers: Record<string, string> = { accept: "application/vnd.github+json" };
    if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const all: Release[] = [];
    for (let url: string | undefined = `https://api.github.com/repos/${REPO}/releases?per_page=100`; url; ) {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`listing ${REPO} releases (${url}): HTTP ${r.status} ${await r.text()}`);
      all.push(...((await r.json()) as Release[]));
      url = /<([^>]+)>;\s*rel="next"/.exec(r.headers.get("link") ?? "")?.[1];
    }
    return all;
  })();
  return listed;
}

// Every published v1.x release at or above the floor, newest first.
export async function releases(): Promise<string[]> {
  return (await listAll())
    .filter((x) => !x.draft && !x.prerelease && !newer(FLOOR, x.tag_name))
    .map((x) => x.tag_name)
    .sort((a, b) => (newer(a, b) ? -1 : newer(b, a) ? 1 : 0));
}

// The newest release: what a user's databases were last written by. Between a
// release and the next version bump it carries this tree's own version.
export async function latestRelease(): Promise<string> {
  const [tag] = await releases();
  if (!tag) throw new Error(`no release at or above ${FLOOR}`);
  return tag;
}

// The newest release other than this tree's own version: what `grayboard
// update` can update from to this tree.
export async function previousRelease(): Promise<string> {
  const tag = (await releases()).find((t) => t !== `v${pkg.version}`);
  if (!tag) throw new Error(`no release at or above ${FLOOR} other than v${pkg.version}`);
  return tag;
}

export type ReleaseBinaries = { tag: string; cli: string; server: string };

const sha256 = async (path: string): Promise<string> =>
  `sha256:${new Bun.CryptoHasher("sha256").update(await Bun.file(path).arrayBuffer()).digest("hex")}`;

// The release's CLI and server for this platform, from the cache or downloaded.
export async function releaseBinaries(tag: string): Promise<ReleaseBinaries> {
  const release = (await listAll()).find((x) => x.tag_name === tag);
  if (!release) throw new Error(`${REPO} has no release ${tag}`);
  const dir = join(CACHE, "releases", tag);
  mkdirSync(dir, { recursive: true });
  const get = async (asset: string): Promise<string> => {
    const want = release.assets.find((a) => a.name === asset)?.digest;
    if (!want) throw new Error(`${tag} lists no sha256 for ${asset}`);
    const path = join(dir, asset);
    if (existsSync(path) && (await sha256(path)) === want) return path;
    const url = `https://github.com/${REPO}/releases/download/${tag}/${asset}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!r.ok) throw new Error(`downloading ${url}: HTTP ${r.status}`);
    // Written aside, checked and renamed, so a bad download never looks cached.
    const part = `${path}.${process.pid}.part`;
    writeFileSync(part, new Uint8Array(await r.arrayBuffer()));
    const got = await sha256(part);
    if (got !== want) throw new Error(`${url}: ${got}, but the release lists ${want}`);
    chmodSync(part, 0o755);
    renameSync(part, path);
    return path;
  };
  const [cli, server] = await Promise.all([get(`grayboard-${TARGET}`), get(`grayboard-server-${TARGET}`)]);
  return { tag, cli, server };
}
