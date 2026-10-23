import { chmodSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const REPO = process.env.GRAYBOARD_REPO ?? "nolnoch/grayboard";
// One origin serving GitHub's paths for both its API and its downloads (a
// mirror, or the upgrade tests' release server); GitHub itself by default.
const RELEASES = process.env.GRAYBOARD_RELEASES_URL?.replace(/\/+$/, "");
const API = RELEASES ?? "https://api.github.com";
const DOWNLOADS = RELEASES ?? "https://github.com";

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
 * Returns the new release's tag, or null if already current.
 */
export async function selfUpdate(current: string): Promise<string | null> {
  const self = process.execPath;
  if (/^bun(\.exe)?$/.test(basename(self))) {
    throw new Error("running from source; update with git pull instead");
  }
  const res = await fetch(`${API}/repos/${REPO}/releases/latest`, {
    headers: { accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`couldn't read the latest release (HTTP ${res.status})`);
  const tag = ((await res.json()) as { tag_name: string }).tag_name;
  if (!newer(tag, current)) return null;

  const target = `${process.platform}-${process.arch}`;
  const bin = await fetch(`${DOWNLOADS}/${REPO}/releases/download/${tag}/grayboard-${target}`);
  if (!bin.ok) throw new Error(`no ${tag} binary for ${target} (HTTP ${bin.status})`);

  // Download next to the binary so the rename stays on one filesystem.
  const tmp = join(dirname(self), `.grayboard-${tag}-${process.pid}`);
  try {
    writeFileSync(tmp, new Uint8Array(await bin.arrayBuffer()));
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
  return tag;
}
