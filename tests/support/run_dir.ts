// The e2e run directory: scripts/e2e.sh sets GRAYBOARD_E2E_RUN_DIR and CI
// uploads it after every run, so a failure (or a flaky pass) keeps its
// evidence. Under plain `bun test` it's unset and nothing is kept.
import { cpSync, lstatSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// A temp HOME's caches (macOS ~/Library/Caches, XDG ~/.cache) hold bun's
// transpiler cache: megabytes per test, no evidence.
const isCache = (p: string) => basename(p) === ".cache" || (basename(p) === "Caches" && basename(dirname(p)) === "Library");

// Files, directories and symlinks only: cpSync throws on a socket (a local
// bus's sock.<identity>, left behind by a killed session) or a FIFO.
function copyable(p: string): boolean {
  const s = lstatSync(p);
  return s.isFile() || s.isDirectory() || s.isSymbolicLink();
}

// Copies `path` (a file or a directory, less caches and sockets) to <run dir>/<name>.
export function keep(name: string, path: string): void {
  const run = process.env.GRAYBOARD_E2E_RUN_DIR;
  if (!run) return;
  mkdirSync(run, { recursive: true });
  cpSync(path, join(run, name), { recursive: true, filter: (p) => !isCache(p) && copyable(p) });
}
