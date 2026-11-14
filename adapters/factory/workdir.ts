// Working directories (docs/factory.md §5, #641): where a child runs.
// A profile picks the mode. `scratch` (the default) gives each task tree a
// directory of its own and each subtask one inside it, so parallel subtasks
// can't overwrite each other and a task never sees another's leftovers.
// `worktree` does the same with git worktrees of a repository. `shared` runs
// every child in the configured directory, for read-only profiles.
//
// Layout, under $FACTORY_DATA_DIR/trees: `<tree>/main` for the request's own
// run and its synthesis, `<tree>/<seq>` for each subtask, where <tree> is the
// request's store seq. Synthesis gets `<tree>` as an extra directory, so it
// reads every subtask's files. A tree goes when the store has pruned its
// request (`sweep`).
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const WORKDIR_MODES = ["scratch", "worktree", "shared"] as const;
export type WorkdirMode = (typeof WORKDIR_MODES)[number];
// `repo`: the git checkout a worktree-mode tree branches from.
export type Workdir = { mode: WorkdirMode; repo?: string };
// What a runner needs: the child's working directory and any other
// directory its file tools may reach.
export type Place = { cwd: string; addDirs: string[] };

// Which run of a tree: the request's own (a run or its synthesis), or a subtask's.
export type Slot = { tree: number; sub: number | null; synthesis: boolean };

export class Workspaces {
  private chain: Promise<unknown> = Promise.resolve(); // git worktree calls, one at a time

  // `root`: the trees' directory. `shared`: shared mode's directory.
  constructor(private readonly root: string, private readonly shared: string) {}

  // The run's place, made if missing (a restart reuses what's there).
  // Throws why it couldn't.
  async place(w: Workdir, s: Slot): Promise<Place> {
    if (w.mode === "shared") return { cwd: this.shared, addDirs: [] };
    const tree = join(this.root, String(s.tree));
    const own = join(tree, s.sub === null ? "main" : String(s.sub));
    if (w.mode === "scratch") mkdirSync(own, { recursive: true });
    else await this.serial(() => this.worktree(w, tree, own));
    return { cwd: own, addDirs: s.synthesis ? [tree] : [] };
  }

  // A detached worktree at `own`: the request's from the repository's HEAD,
  // a subtask's from its request's worktree's HEAD (what the run that
  // planned it committed), so subtasks start where the plan was made.
  private async worktree(w: Workdir, tree: string, own: string): Promise<void> {
    if (!w.repo) throw new Error("worktree mode needs a repo");
    if (existsSync(own)) {
      if (existsSync(join(own, ".git"))) return;
      throw new Error(`${own} exists but isn't a worktree`);
    }
    const main = join(tree, "main");
    const from = own !== main && existsSync(join(main, ".git")) ? main : w.repo;
    const base = (await git(from, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    mkdirSync(tree, { recursive: true });
    await git(w.repo, ["worktree", "add", "--detach", own, base]);
  }

  // Hands a worktree-mode tree's result back as a branch in its repository
  // (#683): `name` at the tree's main worktree's HEAD, when that HEAD has
  // commits no branch holds. A name already taken gets the commit's short id
  // appended. The branch is the requester's: nothing here deletes it.
  // Null when there's no worktree or nothing new; throws why it couldn't.
  async handBack(w: Workdir, tree: number, name: string): Promise<{ branch: string; sha: string } | null> {
    if (w.mode !== "worktree") return null;
    const main = join(this.root, String(tree), "main");
    if (!existsSync(join(main, ".git"))) return null;
    return this.serial(async () => {
      const sha = (await git(main, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
      if ((await git(main, ["rev-list", "--count", sha, "--not", "--branches"])).trim() === "0") return null;
      for (const branch of [name, `${name}-${sha.slice(0, 7)}`]) {
        if (await git(main, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).then(() => true, () => false)) continue;
        await git(main, ["branch", branch, sha]);
        return { branch, sha };
      }
      throw new Error(`branches ${name} and ${name}-${sha.slice(0, 7)} both exist`);
    });
  }

  // Removes every tree whose request the store no longer holds, worktrees
  // included (their repository forgets them). Returns how many went.
  async sweep(keep: (tree: number) => boolean): Promise<number> {
    let entries: string[];
    try { entries = readdirSync(this.root); } catch { return 0; }
    let n = 0;
    for (const e of entries) {
      if (!/^\d+$/.test(e) || keep(Number(e))) continue;
      await this.serial(() => this.remove(join(this.root, e)));
      n++;
    }
    return n;
  }

  private async remove(tree: string): Promise<void> {
    const repos = new Set<string>();
    for (const e of safeList(tree)) {
      const dotgit = join(tree, e, ".git");
      try {
        if (!statSync(dotgit).isFile()) continue;
        // `gitdir: <common>/worktrees/<name>`
        const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotgit, "utf8"))?.[1]?.trim();
        if (gitdir) repos.add(dirname(dirname(resolve(join(tree, e), gitdir))));
      } catch {}
    }
    rmSync(tree, { recursive: true, force: true });
    for (const common of repos) await git(common, ["worktree", "prune"], true).catch(() => {});
  }

  private serial<T>(f: () => Promise<T>): Promise<T> {
    const p = this.chain.then(f, f);
    this.chain = p.catch(() => {});
    return p;
  }
}

function safeList(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

// git with none of the caller's GIT_* variables: a factory started from a
// git hook would otherwise aim every call at the hook's repository.
function git(at: string, args: string[], gitDir = false): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  const where = gitDir ? ["--git-dir", at] : ["-C", at];
  return new Promise((ok, fail) => {
    execFile("git", [...where, ...args], { env, maxBuffer: 1 << 20 }, (e, stdout, stderr) => {
      if (e) fail(new Error(`git ${args[0]} in ${at}: ${String(stderr).trim() || e.message}`));
      else ok(String(stdout));
    });
  });
}
