/// <reference types="node" />
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

/** The branch checked out at `cwd` (short sha if detached), or null outside git. */
export function gitBranch(cwd: string): string | null {
  for (let dir = cwd; ; dir = dirname(dir)) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      let gitdir = dotGit;
      if (!statSync(dotGit).isDirectory()) {
        const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
        if (!m) return null;
        gitdir = resolve(dir, m[1]!.trim());
      }
      const head = readFileSync(join(gitdir, "HEAD"), "utf8").trim();
      return head.startsWith("ref: refs/heads/") ? head.slice(16) : head.slice(0, 7);
    }
    if (dirname(dir) === dir) return null;
  }
}

/**
 * Where a session runs, for peer_list: "api on main" or
 * "api worktree be-stream on worktree-be-stream". Read live, so the
 * branch is current. Null if `cwd` is gone.
 */
export function describeLocation(cwd: string): string | null {
  try {
    const loc = gitLocation(cwd);
    if (!loc) return basename(cwd);
    const branch = gitBranch(cwd);
    return `${basename(loc.repo)}${loc.worktree ? ` worktree ${loc.worktree}` : ""}${branch ? ` on ${branch}` : ""}`;
  } catch {
    return null;
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

/**
 * The name pinned in the repo's .mcp.json (mcpServers.grayboard.env.BUS_IDENTITY).
 * Harnesses disagree on whether a repo's .mcp.json beats a user-level entry
 * (omp's user config wins), so grayboard reads the pin itself. Worktrees use
 * the main checkout's file, since .mcp.json is usually untracked.
 */
export function pinnedIdentity(cwd = process.cwd()): string | undefined {
  try {
    const file = join(gitLocation(cwd)?.repo ?? cwd, ".mcp.json");
    const pin = JSON.parse(readFileSync(file, "utf8"))?.mcpServers?.grayboard?.env?.BUS_IDENTITY;
    return typeof pin === "string" && pin ? pin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The identity this session claims. With an explicit BUS_IDENTITY the name
 * is literal — no worktree suffix — so a session launched from a worktree
 * joins that identity's fleet instead of forking a look-alike; the worktree
 * becomes the lane key instead (sessionLane). Derived identities (pin or
 * directory name) keep the suffix in the name, as they always have.
 */
export function sessionIdentity(env = process.env, cwd = process.cwd()): string {
  if (env.BUS_IDENTITY) return env.BUS_IDENTITY;
  return resolveIdentity(pinnedIdentity(cwd) || defaultIdentity(cwd), cwd);
}

const LANE_RE = /^[a-z0-9_-]{1,32}$/;

/**
 * This session's lane key within its identity's fleet, or null for the
 * default. BUS_LANE wins; else an explicit BUS_IDENTITY launched inside a
 * linked worktree uses the worktree's name as the implicit lane (the free
 * migration path for worktree users); derived identities already carry the
 * suffix in the name, so their lane is the default.
 */
export function sessionLane(env = process.env, cwd = process.cwd()): string | null {
  const raw = env.BUS_LANE;
  if (raw) {
    const lane = raw.toLowerCase();
    if (!LANE_RE.test(lane)) throw new Error(`invalid BUS_LANE "${raw}": 1–32 chars, a-z 0-9 _ -`);
    return lane;
  }
  if (env.BUS_IDENTITY) {
    const wt = linkedWorktreeName(cwd);
    return wt ? sanitizeIdentity(wt) || null : null;
  }
  return null;
}
