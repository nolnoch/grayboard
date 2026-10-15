import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const MAX_LEN = 32;

/**
 * Where `cwd` sits in git: the repo's directory, and the linked worktree's
 * name if `cwd` is inside one. Null outside git.
 */
export function gitLocation(cwd: string): { repo: string; worktree: string | null } | null {
  for (let dir = cwd; ; dir = dirname(dir)) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      if (statSync(dotGit).isDirectory()) return { repo: dir, worktree: null };
      // A linked worktree's .git is a file: "gitdir: <repo>/.git/worktrees/<id>".
      // Submodules also use a .git file, pointing into .git/modules/ instead.
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
      const gitdir = m ? resolve(dir, m[1]!.trim()) : "";
      if (!/[\\/]worktrees[\\/][^\\/]+[\\/]?$/.test(gitdir)) return { repo: dir, worktree: null };
      // <repo>/.git, or <repo>.git for a bare repo.
      const common = dirname(dirname(gitdir));
      const repo = basename(common) === ".git" ? dirname(common) : common.replace(/\.git$/, "");
      return { repo, worktree: basename(dir) };
    }
    if (dirname(dir) === dir) return null;
  }
}

/** Name of the linked git worktree containing `cwd`, or null in a main checkout or outside git. */
export function linkedWorktreeName(cwd: string): string | null {
  return gitLocation(cwd)?.worktree ?? null;
}

/** `name` reduced to a valid identity: lowercase [a-z0-9_-], at most 32 chars. */
export function sanitizeIdentity(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_LEN)
    .replace(/-+$/, "");
}

/**
 * The base identity when BUS_IDENTITY isn't set: the git repo's directory
 * name, or the current directory's name outside git. A worktree counts as its
 * repo here; resolveIdentity adds the worktree suffix.
 */
export function defaultIdentity(cwd = process.cwd()): string {
  const name = sanitizeIdentity(basename(gitLocation(cwd)?.repo ?? cwd));
  if (!name) throw new Error(`can't derive an identity from ${cwd}; set BUS_IDENTITY`);
  return name;
}

/**
 * The identity this session claims. In a linked worktree, `base` gets the
 * worktree's name as a suffix so worktrees sharing one .mcp.json don't collide:
 * base "be" in worktree "stream" → "be-stream". A worktree already named
 * "be-…" is used as-is.
 */
export function resolveIdentity(base: string, cwd = process.cwd()): string {
  const wt = linkedWorktreeName(cwd);
  if (!wt) return base;
  const b = base.toLowerCase();
  const name = sanitizeIdentity(wt);
  if (!name || name === b) return base;
  return sanitizeIdentity(name.startsWith(`${b}-`) ? name : `${b}-${name}`);
}

/** BUS_IDENTITY if set, else the default; then the worktree suffix. */
export function sessionIdentity(env = process.env, cwd = process.cwd()): string {
  return resolveIdentity(env.BUS_IDENTITY || defaultIdentity(cwd), cwd);
}
