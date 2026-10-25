// The factory module's isolation (#293, #323; principle 7, docs/boards.md §1):
// nothing under src/ imports adapters/factory/, and the module imports nothing
// in the repo beyond itself and the published client and protocol (its tests
// may also use tests/support/). tests/integration/factory_isolation.test.ts
// runs it against the repo, so bun test, the pre-push hook and CI enforce it.
//
//   bun scripts/check_factory_isolation.ts [root]   (default: this repo)
//
// Imports come from TypeScript's own scanner, which sees every static form
// (type-only, multi-line, re-export, side-effect, `import =`, `import()` types,
// `/// <reference path>`) plus dynamic import and require with a literal path,
// and nothing in comments or strings. Specs resolve as Bun resolves them
// (extensionless, `.js` for `.ts`, `file://` URLs), then to the real, canonically
// cased path. Not covered: a computed `import(expr)`, and code loaded other
// than by import or require (`new Worker(url)`, `Bun.spawn`, `import.meta.resolve`).
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const FACTORY = "adapters/factory";
// The published surface: the only src/ files the module may import.
const PUBLISHED = new Set(["src/plugin/client.ts", "src/shared/protocol.ts"]);
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TEST = /\.test\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** Repo-relative posix path, or null outside `root`. */
function repoPath(root: string, abs: string): string | null {
  const rel = relative(root, abs);
  return rel.startsWith("..") || isAbsolute(rel) ? null : rel.split(sep).join("/");
}

const under = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

/**
 * `abs` with symlinks followed and case canonical (a case-insensitive disk
 * opens `Adapters/Factory`), so it compares with the real `root`. A path that
 * doesn't exist yet keeps its missing tail under its nearest real ancestor.
 */
function canonical(abs: string): string {
  if (existsSync(abs)) return realpathSync.native(abs);
  const parent = dirname(abs);
  return parent === abs ? abs : join(canonical(parent), basename(abs));
}

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

/** Where `spec` in `file` loads from, as Bun resolves it; a missing target resolves as a plain path. */
function resolveSpec(file: string, spec: string): string {
  const path = spec.startsWith("file:") ? fileURLToPath(spec) : spec;
  try {
    return canonical(Bun.resolveSync(path, dirname(file)));
  } catch {
    return canonical(resolve(dirname(file), path));
  }
}

/** The repo paths `file` imports; packages (bare specifiers) are skipped. */
function importsOf(root: string, file: string): { spec: string; target: string | null }[] {
  const info = ts.preProcessFile(readFileSync(file, "utf8"), true, true);
  const local = (spec: string) => spec.startsWith(".") || spec.startsWith("file:") || isAbsolute(spec);
  // A reference path is relative to its file even without a leading `./`.
  const specs = [
    ...info.importedFiles.map((f) => f.fileName).filter(local),
    ...info.referencedFiles.map((f) => (local(f.fileName) ? f.fileName : `./${f.fileName}`)),
  ];
  return specs.map((spec) => ({ spec, target: repoPath(root, resolveSpec(file, spec)) }));
}

/** Each way `root`'s tree breaks the boundary, one line per import or link. */
export function isolationViolations(root: string): string[] {
  root = realpathSync.native(root);
  const out: string[] = [];
  const where = (abs: string) => repoPath(root, abs)!;

  for (const { path, link } of walk(join(root, "src"))) {
    if (link) {
      // Checked by where it points, so a link committed before its target lands is caught too.
      const real = repoPath(root, canonical(resolve(dirname(path), readlinkSync(path))));
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
