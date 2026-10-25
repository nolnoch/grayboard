import { randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { sha256Hex } from "../shared/hash.ts";
import { HTTP_TIMEOUT_MS, describeFetchError, transferTimeoutMs } from "../shared/http.ts";
import { RELEASE_TAG, SIG, SUMS, verifySums } from "../shared/release_verify.ts";

export const REPO = process.env.GRAYBOARD_REPO || "nolnoch/grayboard";
// This machine's release target, as the assets name it: grayboard-<target>.
export const TARGET = `${process.platform}-${process.arch}`;
// How long the downloaded binary gets to answer --version before it is refused.
const VERSION_CHECK_MS = 30_000;

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

// A fetch and its body, under one deadline, whose failure names the URL, so a
// stale or wrong origin, or a stalled one, shows.
async function get(url: string, what: string, ms: number, init?: RequestInit): Promise<Uint8Array<ArrayBuffer>> {
  let status: number;
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
    status = res.status;
  } catch (e) {
    throw new Error(`couldn't fetch ${what} from ${url}: ${describeFetchError(e, ms)}`);
  }
  throw new Error(`couldn't fetch ${what} from ${url} (HTTP ${status})`);
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

// What selfUpdate did: nothing (already current), or installed `tag`, whose
// SHA256SUMS key `keyId` signed. `origin` is where the release came from.
export type UpdateResult =
  | { updated: false; origin: string }
  | { updated: true; origin: string; tag: string; keyId: string };

/**
 * Replace this binary with the latest release, in place. The release's tag
 * must be a release tag's shape, its SHA256SUMS must be signed by a
 * compiled-in key and name that tag, and the binary must match both its
 * SHA256SUMS line and the API digest, before it's written (#162, #173). The
 * rename is atomic, so sessions running the old binary keep it until they
 * reconnect.
 */
export async function selfUpdate(current: string): Promise<UpdateResult> {
  const self = process.execPath;
  if (/^bun(\.exe)?$/.test(basename(self))) {
    throw new Error("running from source; update with git pull instead");
  }
  const mirror = releasesOrigin();
  const api = mirror ?? "https://api.github.com";
  const downloads = mirror ?? "https://github.com";
  const res = await get(`${api}/repos/${REPO}/releases/latest`, "the latest release", HTTP_TIMEOUT_MS, {
    headers: { accept: "application/vnd.github+json" },
  });
  const release = JSON.parse(new TextDecoder().decode(res)) as {
    tag_name: unknown;
    assets?: { name: string; size?: number; digest?: string | null }[];
  };
  const tag = release.tag_name;
  // The tag goes into URLs and the temp file's name.
  if (typeof tag !== "string" || !RELEASE_TAG.test(tag)) {
    throw new Error(`the latest release's tag ${JSON.stringify(tag)} isn't a release tag; not updating`);
  }
  if (!newer(tag, current)) return { updated: false, origin: downloads };

  const base = `${downloads}/${REPO}/releases/download/${tag}`;
  let signed;
  try {
    // A release without either file is refused like a bad signature.
    const [sums, sig] = await Promise.all([
      get(`${base}/${SUMS}`, `the ${tag} ${SUMS}`, HTTP_TIMEOUT_MS),
      get(`${base}/${SIG}`, `the ${tag} ${SIG}`, HTTP_TIMEOUT_MS),
    ]);
    signed = await verifySums(tag, sums, new TextDecoder().decode(sig));
  } catch (e) {
    throw new Error(`the ${tag} release failed verification: ${(e as Error).message}; not updating`);
  }

  const asset = `grayboard-${TARGET}`;
  const listed = signed.digests.get(asset);
  if (!listed) throw new Error(`the ${tag} ${SUMS} lists no ${asset}; not updating`);
  const meta = release.assets?.find((a) => a.name === asset);
  if (typeof meta?.size !== "number") throw new Error(`the release API lists no size for ${asset}; not updating`);
  const body = await get(`${base}/${asset}`, `the ${tag} binary for ${TARGET}`, transferTimeoutMs(meta.size));

  // Verified before it's ever written, let alone run.
  const got = sha256Hex(body);
  if (got !== listed) {
    throw new Error(`${asset} failed verification: sha256 ${got}, but ${SUMS} lists ${listed}; not updating`);
  }
  if (meta.digest !== `sha256:${got}`) {
    throw new Error(
      `${asset} failed verification: sha256 ${got}, but the release API lists ${meta.digest ?? "no digest"}; not updating`,
    );
  }

  // Beside the binary so the rename stays on one filesystem; a fresh random
  // name opened exclusively, so nothing planted there is written through.
  const tmp = join(dirname(self), `.grayboard-${tag}-${randomBytes(8).toString("hex")}`);
  try {
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o755);
    try {
      for (let off = 0; off < body.length; ) {
        const n = writeSync(fd, body, off);
        if (n <= 0) throw new Error(`writing ${tmp} stopped at ${off} of ${body.length} bytes; not updating`);
        off += n;
      }
      fchmodSync(fd, 0o755); // the umask may have narrowed the mode at creation
    } finally {
      closeSync(fd);
    }
    const check = Bun.spawnSync([tmp, "--version"], { timeout: VERSION_CHECK_MS });
    const reported = check.stdout.toString().trim();
    if (check.exitedDueToTimeout) {
      throw new Error(`the downloaded ${tag} binary didn't answer --version within ${VERSION_CHECK_MS / 1000}s; not updating`);
    }
    if (check.exitCode !== 0 || reported !== tag.replace(/^v/, "")) {
      throw new Error(`the downloaded ${tag} binary reports '${reported}', not ${tag}; not updating`);
    }
    renameSync(tmp, self);
  } catch (e) {
    rmSync(tmp, { force: true });
    if ((e as NodeJS.ErrnoException).code === "EACCES") {
      throw new Error(`can't write to ${dirname(self)}; rerun with permission to replace ${self}`);
    }
    throw e;
  }
  return { updated: true, origin: downloads, tag, keyId: signed.keyId };
}
