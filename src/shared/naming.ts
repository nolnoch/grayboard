// The name a session gets with no explicit one: the git repo (or directory), a
// worktree suffix, and the repo pin. No imports outside node: OpenCode V2 carries
// a generated copy (scripts/sync_hosted_core.ts) so its suggested name matches
// local mode's (#696).
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

// The repo files that can pin grayboard's name, in precedence order: the
// `.mcp.json` every harness reads, then omp's `.omp/mcp.json` (same shape).
const PIN_FILES = [".mcp.json", ".omp/mcp.json"] as const;

// The `mcpServers.grayboard.env.BUS_IDENTITY` in the repo's `file`, enabled
// or not. Worktrees use the main checkout's files, since both are usually
// untracked. Undefined when there's no such file, it's unparseable, or it
// pins nothing.
function readPin(cwd: string, file: string): string | undefined {
  try {
    const pin = JSON.parse(readFileSync(join(gitLocation(cwd)?.repo ?? cwd, file), "utf8"))?.mcpServers?.grayboard?.env?.BUS_IDENTITY;
    return typeof pin === "string" && pin ? pin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every identity the repo pins for grayboard, in `PIN_FILES` order.
 * Harnesses disagree on whether a repo's `.mcp.json` beats a user-level
 * entry (omp's user config wins), so grayboard reads the pins itself. A
 * BUS_IDENTITY equal to ANY of these is a harness re-delivering that pin,
 * not an explicit override — comparing against the first pin alone would
 * treat omp's own pin as explicit and drop its worktree suffix, orphaning
 * that handle's mail and claims.
 *
 * Echo detection only: `isExplicitIdentity` alone reads this. Default
 * naming is `pinnedIdentity`'s.
 */
export function pinnedIdentities(cwd = process.cwd()): string[] {
  return PIN_FILES.flatMap((file) => readPin(cwd, file) ?? []);
}

/**
 * The name the repo pins for default naming, and the file it came from:
 * `.mcp.json`; under omp (`BUS_HARNESS=omp`, which omp's local adapter sets
 * on the grayboard it runs), `.omp/mcp.json` after it. omp's adapter refuses
 * an enabled entry that runs grayboard, so the `.omp/mcp.json` pin names an
 * omp session from a disabled entry, as it did when omp ran the entry
 * (#523). Other harnesses never read `.omp/mcp.json`, so a repo pinned only
 * there keeps their directory-derived default (#182).
 */
export function pinnedIdentity(cwd = process.cwd(), env: Record<string, string | undefined> = process.env): { name: string; file: string } | undefined {
  for (const file of env.BUS_HARNESS === "omp" ? PIN_FILES : PIN_FILES.slice(0, 1)) {
    const name = readPin(cwd, file);
    if (name) return { name, file };
  }
  return undefined;
}

/**
 * Whether BUS_IDENTITY is a true explicit override, not a harness re-
 * delivering one of the repo's pins as env (docs/guide/local.md: harnesses load pins
 * into BUS_IDENTITY). Literal — no worktree suffix — only when it differs
 * from every pin source. When it equals any pin the identity is derived like
 * the pin itself, so existing worktree identities (`be-stream`) keep their
 * name, mail and claims.
 */
export function isExplicitIdentity(env = process.env, cwd = process.cwd()): boolean {
  if (!env.BUS_IDENTITY) return false;
  return !pinnedIdentities(cwd).includes(env.BUS_IDENTITY);
}

/**
 * The identity this session claims. A true explicit BUS_IDENTITY (differs
 * from every repo pin) is used verbatim — no worktree suffix — so a session
 * launched from a worktree joins that identity instead of forking a
 * look-alike handle with its own empty mailbox. Everything else — no
 * BUS_IDENTITY, or one that merely re-delivers a pin — is derived and
 * keeps the suffix in the name, as worktree sessions always have.
 */
export function sessionIdentity(env = process.env, cwd = process.cwd()): string {
  if (isExplicitIdentity(env, cwd)) return env.BUS_IDENTITY!;
  // `||`, not `??`: an EMPTY BUS_IDENTITY (a cleared or mistyped value) falls
  // through to the pin and then the default, as it always did — with `??` it
  // skipped the pin and silently changed the handle.
  return resolveIdentity(env.BUS_IDENTITY || pinnedIdentity(cwd, env)?.name || defaultIdentity(cwd), cwd);
}
