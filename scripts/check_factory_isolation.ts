// The factory module's isolation (#293, #323; principle 7, docs/boards.md §1):
// nothing under src/ imports adapters/factory/, and the module imports nothing
// in the repo beyond itself and the published client and protocol (its tests
// may also use tests/support/). tests/integration/factory_isolation.test.ts
// runs it against the repo, so bun test, the pre-push hook and CI enforce it.
//
//   bun scripts/check_factory_isolation.ts [root]   (default: this repo)
//
// Imports come from TypeScript's own scanner, which sees every static form
// (type-only, multi-line, re-export, side-effect, `import =`, `import()` types)
// plus dynamic import and require with a literal path, and nothing in comments
// or strings. A computed `import(expr)` can't be resolved and isn't covered.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

const FACTORY = "adapters/factory";
// The published surface: the only src/ files the module may import.
const PUBLISHED = new Set(["src/plugin/client.ts", "src/shared/protocol.ts"]);
const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const TEST = /\.test\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

/** Repo-relative posix path, or null outside `root`. */
function repoPath(root: string, abs: string): string | null {
  const rel = relative(root, abs);
  return rel.startsWith("..") || isAbsolute(rel) ? null : rel.split(sep).join("/");
}

const under = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

/** Every file and symlink under `dir`, without following symlinks. */
function* walk(dir: string): Generator<{ path: string; link: boolean }> {
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) yield { path: p, link: true };
    else if (st.isDirectory()) yield* walk(p);
    else if (SOURCE.test(e)) yield { path: p, link: false };
  }
}

/** The repo paths `file` imports; packages (bare specifiers) are skipped. */
function importsOf(root: string, file: string): { spec: string; target: string | null }[] {
  return ts
    .preProcessFile(readFileSync(file, "utf8"), true, true)
    .importedFiles.map((f) => f.fileName)
    .filter((spec) => spec.startsWith(".") || isAbsolute(spec))
    .map((spec) => {
      // Real paths on both sides, so `root` and a target reached through a
      // symlinked prefix (macOS's /var → /private/var) compare.
      const abs = resolve(dirname(file), spec);
      return { spec, target: repoPath(root, existsSync(abs) ? realpathSync(abs) : abs) };
    });
}

/** Each way `root`'s tree breaks the boundary, one line per import or link. */
export function isolationViolations(root: string): string[] {
  root = realpathSync(root);
  const out: string[] = [];
  const where = (abs: string) => repoPath(root, abs)!;

  for (const { path, link } of walk(join(root, "src"))) {
    if (link) {
      const real = existsSync(path) ? repoPath(root, realpathSync(path)) : null;
      if (real && under(real, FACTORY)) out.push(`${where(path)}: a symlink into ${FACTORY}/`);
      continue;
    }
    for (const { spec, target } of importsOf(root, path)) {
      if (target && under(target, FACTORY)) out.push(`${where(path)}: src/ imports the factory module (${spec})`);
    }
  }

  const factory = join(root, FACTORY);
  if (!existsSync(factory)) return out;
  for (const { path, link } of walk(factory)) {
    if (link) {
      out.push(`${where(path)}: a symlink in the factory module; the import check can't see through it`);
      continue;
    }
    const test = TEST.test(path);
    for (const { spec, target } of importsOf(root, path)) {
      if (target === null) out.push(`${where(path)}: imports ${spec}, outside the repo`);
      else if (under(target, FACTORY) || PUBLISHED.has(target)) continue;
      else if (test && under(target, "tests/support")) continue;
      else out.push(`${where(path)}: imports ${target}, beyond the published client and protocol (${[...PUBLISHED].join(", ")})`);
    }
  }
  return out;
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? join(import.meta.dir, ".."));
  const violations = isolationViolations(root);
  for (const v of violations) console.error(`factory isolation: ${v}`);
  if (violations.length) process.exit(1);
  console.log(`factory isolation: clean (${root})`);
}
