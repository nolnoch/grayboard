import { randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, lstatSync, openSync, readdirSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { LOOPBACK } from "../shared/endpoint.ts";
import { sha256Hex } from "../shared/hash.ts";
import { HTTP_TIMEOUT_MS, describeFetchError, transferTimeoutMs } from "../shared/http.ts";
import { RELEASE_TAG, SIG, SUMS, verifySums } from "../shared/release_verify.ts";

export const REPO = process.env.GRAYBOARD_REPO || "nolnoch/grayboard";
// This machine's release target, as the assets name it: grayboard-<target>.
export const TARGET = `${process.platform}-${process.arch}`;
// How long the downloaded binary gets to answer --version before it is refused.
const VERSION_CHECK_MS = 30_000;

// GRAYBOARD_RELEASES_URL: one origin serving GitHub's paths for both its API
// and its downloads (a mirror, or the upgrade tests' release server), without
// trailing slashes; unset or empty means GitHub. It serves the binary update
// runs, so it must be https, or http to this machine, with no user info
// (`http://localhost:@evil.example.com` is evil's host, as install.sh refuses).
export function releasesOrigin(raw = process.env.GRAYBOARD_RELEASES_URL): string | undefined {
  if (!raw) return undefined;
  const origin = raw.replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(`GRAYBOARD_RELEASES_URL isn't a URL: ${raw}`);
  }
  if (origin.includes("@")) throw new Error(`GRAYBOARD_RELEASES_URL must not carry user info: ${raw}`);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new Error(`GRAYBOARD_RELEASES_URL must be https (or http to localhost): ${raw}`);
  }
  return origin;
}

// What a release origin may send, so a broken or hostile one is refused by
// name instead of exhausting memory (#316). The binary's own bound is the
// API's size for it, which may itself be at most MAX_BINARY.
export const MAX_API = 4 * 1024 * 1024;
export const MAX_SUMS = 64 * 1024;
export const MAX_BINARY = 512 * 1024 * 1024;

// A fetch and its body, under one deadline, whose failure names the URL, so a
// stale or wrong origin, or a stalled one, shows. A body over `max` bytes is
// refused, by its Content-Length when it states one, else as it streams.
export async function get(url: string, what: string, ms: number, max: number, init?: RequestInit): Promise<Uint8Array<ArrayBuffer>> {
  let got: { status: number } | { body: Uint8Array<ArrayBuffer> | null };
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
    got = res.ok ? { body: await capped(res, max) } : { status: res.status };
  } catch (e) {
    throw new Error(`couldn't fetch ${what} from ${url}: ${describeFetchError(e, ms)}`);
  }
  if ("status" in got) throw new Error(`couldn't fetch ${what} from ${url} (HTTP ${got.status})`);
  if (got.body === null) throw new Error(`${what} from ${url} is larger than ${max} bytes; not updating`);
  return got.body;
}

/** The body, or null once it's over `max` bytes (stated or streamed), having stopped reading. */
async function capped(res: Response, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (Number(res.headers.get("content-length") ?? NaN) > max) {
    await res.body?.cancel();
    return null;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** A release version, `X.Y.Z[-pre]` with an optional leading `v`: a release tag or a `package.json` version. */
export const VERSION = /^v?\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

/**
 * Semver order of versions `a` and `b` (negative, zero, positive), so a
 * pre-release sorts before its release ("2.3.1-rc1" < "2.3.1"). Throws on
 * anything that isn't a {@link VERSION}, naming it.
 */
export function versionOrder(a: string, b: string): number {
  for (const v of [a, b]) if (!VERSION.test(v)) throw new Error(`${JSON.stringify(v)} isn't a release version`);
  return Bun.semver.order(a.replace(/^v/, ""), b.replace(/^v/, ""));
}

/** True if version `a` is newer than `b` ("v1.2.0" vs "1.10.0" compares numerically). */
export const newer = (a: string, b: string): boolean => versionOrder(a, b) > 0;

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
  const res = await get(`${api}/repos/${REPO}/releases/latest`, "the latest release", HTTP_TIMEOUT_MS, MAX_API, {
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
      get(`${base}/${SUMS}`, `the ${tag} ${SUMS}`, HTTP_TIMEOUT_MS, MAX_SUMS),
      get(`${base}/${SIG}`, `the ${tag} ${SIG}`, HTTP_TIMEOUT_MS, MAX_SUMS),
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
  if (meta.size > MAX_BINARY) throw new Error(`the release API lists ${asset} at ${meta.size} bytes, over ${MAX_BINARY}; not updating`);
  const body = await get(`${base}/${asset}`, `the ${tag} binary for ${TARGET}`, transferTimeoutMs(meta.size), meta.size);

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
  for (const path of sweepStaleTemps(dirname(self))) console.error(`[grayboard] removed ${path}, left by an interrupted update`);
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

// An update's temp binary: `.grayboard-<tag>-<16 hex>` (above).
const UPDATE_TEMP = /^\.grayboard-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?-[0-9a-f]{16}$/;
export const STALE_TEMP_MS = 60 * 60 * 1000;

/**
 * Removes update temp binaries in `dir` that a killed update left (#317): only
 * regular files of this user, named as update names them, untouched for an
 * hour, so an update running alongside keeps its own. Returns what it removed;
 * a file it can't inspect or remove is left.
 */
export function sweepStaleTemps(dir: string, now = Date.now()): string[] {
  const removed: string[] = [];
  let names: string[];
  try { names = readdirSync(dir); } catch { return removed; }
  const uid = process.getuid?.();
  for (const name of names) {
    if (!UPDATE_TEMP.test(name)) continue;
    const path = join(dir, name);
    try {
      const st = lstatSync(path);
      if (!st.isFile() || (uid !== undefined && st.uid !== uid) || now - st.mtimeMs < STALE_TEMP_MS) continue;
      rmSync(path);
      removed.push(path);
    } catch {
      // Gone already, or not ours to remove.
    }
  }
  return removed;
}
