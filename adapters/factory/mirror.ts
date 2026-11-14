// Mirrored tree claims (#675, docs/factory.md §10): a subtask's tree claim
// also held on the bus, under the factory's name, so lanes outside the tree
// (your own sessions, another factory on a worktree of the same repo) see
// it and the subtask sees theirs. One way: nothing on the bus becomes a
// tree claim. The bus key names the repository, so two worktrees of one
// repo collide and two repos don't: `path:<repo id>/<tree key>`.
import { execFile } from "node:child_process";
import { basename, dirname, resolve } from "node:path";

// What the relay asks of the bus. `take` resolves null when the claim is
// the factory's, or the holder when someone else has it; both throw when
// the bus can't answer.
export interface BusMirror {
  take(key: string, note: string | null): Promise<null | { holder: string; note: string | null; expiresAt: number }>;
  release(key: string): Promise<void>;
}

// A mirrored claim's TTL on the bus. A live one is renewed well inside it
// (RENEW_MS), and a crashed factory's lapse on their own within it.
export const MIRROR_TTL_MIN = 30;
export const RENEW_MS = 10 * 60_000;

// Git's repository-locating variables (`git rev-parse --local-env-vars`):
// inherited (a factory started from a git hook), they'd aim every call at
// that repository instead of `dir`.
const LOCAL_GIT = new Set(["GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE", "GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_PREFIX", "GIT_SHALLOW_FILE", "GIT_COMMON_DIR"]);
const own = (env: NodeJS.ProcessEnv) => Object.fromEntries(Object.entries(env).filter(([k]) => !LOCAL_GIT.has(k) && !/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)));
const git = (dir: string, args: string[], env: NodeJS.ProcessEnv = process.env) =>
  new Promise<string>((ok, fail) => execFile("git", ["-C", dir, ...args], { timeout: 10_000, env: own(env) }, (e, out) => (e ? fail(e) : ok(out.trim()))));

// `origin`'s URL without scheme, user or `.git` (`git@github.com:o/r.git`
// and `https://github.com/o/r` are both `github.com/o/r`), else where the
// repository's shared git directory lives: the main checkout's top level,
// which every worktree of it shares. Throws when `dir` isn't in a git checkout.
export async function repoId(dir: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const common = resolve(dir, await git(dir, ["rev-parse", "--git-common-dir"], env));
  const url = await git(dir, ["remote", "get-url", "origin"], env).catch(() => "");
  if (url) return normalizeRemote(url);
  return basename(common) === ".git" ? dirname(common) : common;
}

export function normalizeRemote(url: string): string {
  let u = url.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, ""); // scheme
  u = u.replace(/^[^@/]+@/, ""); // user
  if (!url.includes("://")) u = u.replace(/^([^:/]+):(?!\/)/, "$1/"); // scp-like host:path
  u = u.replace(/:\d+(?=\/)/, ""); // port
  return u.replace(/\/+$/, "").replace(/\.git$/, "").replace(/\/+$/, "");
}

export const busKey = (prefix: string, key: string) => `${prefix}${key.replace(/^(\.\/)+/, "")}`;
export const mirrorPrefix = (id: string) => `path:${id}/`;
// A mirrored claim's note on the bus is the factory's words, never the
// child's: other lanes read it, and a child's note could steer them.
export const mirrorNote = (holder: number) => `held for factory subtask ${holder}`;
