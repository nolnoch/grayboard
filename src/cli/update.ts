import { chmodSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const REPO = process.env.GRAYBOARD_REPO || "nolnoch/grayboard";
// This machine's release target, as the assets name it: grayboard-<target>.
export const TARGET = `${process.platform}-${process.arch}`;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

// GRAYBOARD_RELEASES_URL: one origin serving GitHub's paths for both its API
// and its downloads (a mirror, or the upgrade tests' release server), without
// trailing slashes; unset or empty means GitHub. It serves the binary update
// runs, so it must be https, or http to this machine.
export function releasesOrigin(raw = process.env.GRAYBOARD_RELEASES_URL): string | undefined {
  if (!raw) return undefined;
  const origin = raw.replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(`GRAYBOARD_RELEASES_URL isn't a URL: ${raw}`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new Error(`GRAYBOARD_RELEASES_URL must be https (or http to localhost): ${raw}`);
  }
  return origin;
}

// A fetch whose failure names the URL, so a stale or wrong origin shows.
async function get(url: string, what: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new Error(`couldn't fetch ${what} from ${url}: ${(e as Error).message}`);
  }
  if (!res.ok) throw new Error(`couldn't fetch ${what} from ${url} (HTTP ${res.status})`);
  return res;
}

/** True if version `a` is newer than `b` ("v1.2.0" vs "1.10.0" compares numerically). */
export function newer(a: string, b: string): boolean {
  const parts = (v: string) => v.replace(/^v/, "").split(/[.-]/).map((p) => Number.parseInt(p, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

/**
 * Replace this binary with the latest release, in place. The rename is
 * atomic, so sessions running the old binary keep it until they reconnect.
 * Returns the new release's tag (null if already current) and the origin it
 * came from.
 */
export async function selfUpdate(current: string): Promise<{ tag: string | null; origin: string }> {
  const self = process.execPath;
  if (/^bun(\.exe)?$/.test(basename(self))) {
    throw new Error("running from source; update with git pull instead");
  }
  const mirror = releasesOrigin();
  const api = mirror ?? "https://api.github.com";
  const downloads = mirror ?? "https://github.com";
  const res = await get(`${api}/repos/${REPO}/releases/latest`, "the latest release", {
    headers: { accept: "application/vnd.github+json" },
  });
  const release = (await res.json()) as { tag_name: string; assets?: { name: string; digest?: string | null }[] };
  const tag = release.tag_name;
  if (!newer(tag, current)) return { tag: null, origin: downloads };

  const asset = `grayboard-${TARGET}`;
  const digest = release.assets?.find((a) => a.name === asset)?.digest;
  const bin = await get(`${downloads}/${REPO}/releases/download/${tag}/${asset}`, `the ${tag} binary for ${TARGET}`);
  const body = new Uint8Array(await bin.arrayBuffer());

  // Verified before it's ever written, let alone run: a wrong or missing
  // digest refuses the update (#173).
  const got = `sha256:${new Bun.CryptoHasher("sha256").update(body).digest("hex")}`;
  if (digest !== got) {
    throw new Error(
      `the ${tag} binary failed verification: ${got}, but the release lists ${digest ?? "no digest"}; not updating`,
    );
  }

  // Download next to the binary so the rename stays on one filesystem.
  const tmp = join(dirname(self), `.grayboard-${tag}-${process.pid}`);
  try {
    writeFileSync(tmp, body);
    chmodSync(tmp, 0o755);
    const check = Bun.spawnSync([tmp, "--version"]);
    if (check.exitCode !== 0 || !check.stdout.toString().includes(tag.replace(/^v/, ""))) {
      throw new Error(`the downloaded ${tag} binary didn't run on this machine`);
    }
    renameSync(tmp, self);
  } catch (e) {
    rmSync(tmp, { force: true });
    if ((e as NodeJS.ErrnoException).code === "EACCES") {
      throw new Error(`can't write to ${dirname(self)}; rerun with permission to replace ${self}`);
    }
    throw e;
  }
  return { tag, origin: downloads };
}
