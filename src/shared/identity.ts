import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const MAX_LEN = 32;

/** Name of the linked git worktree containing `cwd`, or null in a main checkout or outside git. */
export function linkedWorktreeName(cwd: string): string | null {
  for (let dir = cwd; ; dir = dirname(dir)) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      if (statSync(dotGit).isDirectory()) return null;
      // A linked worktree's .git is a file: "gitdir: <repo>/.git/worktrees/<id>".
      // Submodules also use a .git file, pointing into .git/modules/ instead.
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
      if (!m || !/[\\/]worktrees[\\/][^\\/]+[\\/]?$/.test(m[1]!.trim())) return null;
      return basename(dir);
    }
    if (dirname(dir) === dir) return null;
  }
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
  const name = wt.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!name || name === b) return base;
  const full = name.startsWith(`${b}-`) ? name : `${b}-${name}`;
  return full.slice(0, MAX_LEN).replace(/-+$/, "");
}
