import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { normalizeAliasName } from "../core/addresses.ts";
import { gitLocation, isExplicitIdentity, sessionIdentity } from "./naming.ts";

export { defaultIdentity, gitLocation, isExplicitIdentity, linkedWorktreeName, pinnedIdentities, pinnedIdentity, resolveIdentity, sanitizeIdentity, sessionIdentity } from "./naming.ts";

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

/**
 * The name a hosted adapter binds at start (#443): an explicit BUS_IDENTITY,
 * normalized as a server bind is (a bare name or `scope/name`). Nothing
 * without one (a pin echo counts as none); an error for a value the naming
 * rule refuses.
 */
export function configuredIdentity(env: Record<string, string | undefined> = process.env, cwd = process.cwd()): { name: string } | { error: string } | undefined {
  try {
    if (!isExplicitIdentity(env, cwd)) return undefined;
    const n = normalizeAliasName(sessionIdentity(env, cwd));
    return n.ok ? { name: n.name } : { error: n.error };
  } catch (e) { return { error: (e as Error).message }; }
}
