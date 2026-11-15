import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { repositoryGitEnv } from "./hosted-evidence.ts";

const [checkout, scratch, output] = process.argv.slice(2);
assert(checkout && scratch && output);
const digest = (path: string) => new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
// Tracked files only (#378 2): hosted-evidence.ts accepts a path only if `git ls-files` lists it, so an untracked
// file (a new uncommitted src/foo.ts, a .DS_Store) listed from the filesystem failed every hosted gate.
const files = (directory: string): string[] => {
  const listed = Bun.spawnSync(["git", "ls-files", "-z", "--", relative(checkout, directory)], { cwd: checkout, env: repositoryGitEnv() });
  assert.equal(listed.exitCode, 0, `Cannot enumerate tracked files under ${relative(checkout, directory)}`);
  // A tracked file deleted from the working tree but not staged (an unstaged rm or mv) has no bytes to digest.
  return listed.stdout.toString().split("\0").filter(Boolean).map(path => join(checkout, path)).filter(path => existsSync(path));
};
const packageRoot = join(checkout, "adapters/opencode-v2");
const installedFile = join(scratch, "installed.txt");
const prepared = existsSync(installedFile) ? scratch : join(scratch, "prepared");
const installed = existsSync(join(prepared, "installed.txt")) ? readFileSync(join(prepared, "installed.txt"), "utf8").trim() : undefined;
const expected = ["package.json", "index.js", "tui.js", "README.md", ...files(join(packageRoot, "src")).map(p => relative(packageRoot, p))];
const installedChecks = installed ? expected.map(path => ({ path, sha256: digest(join(installed, path)), expected: digest(join(packageRoot, path)) })) : [];
const configInstalledFile = join(scratch, "config-installed.txt");
const configInstalled = existsSync(configInstalledFile) ? readFileSync(configInstalledFile, "utf8").trim() : undefined;
const publicChecks = configInstalled ? expected.map(path => ({ path, sha256: digest(join(configInstalled, path)), expected: digest(join(packageRoot, path)) })) : [];
const mismatches = [...installedChecks, ...publicChecks].filter(x => x.sha256 !== x.expected);
const backend = files(join(checkout, "src")).map(path => ({ path: relative(checkout, path), sha256: digest(path) }));
// The fixtures that drive the host, including the transaction races' process helpers from tests/support (#383).
const drivers = [...files(join(packageRoot, "tests")), ...["tests/e2e/opencode-config.ts", "tests/support/transaction-process.ts", "tests/support/hosted-operation.ts"].map(path => join(checkout, path))].map(path => ({ path: relative(checkout, path), sha256: digest(path) }));
await Bun.write(output, JSON.stringify({ bun: Bun.version, installed: !!installed, publicInstalled: !!configInstalled, installedChecks, publicChecks, mismatches, backend, drivers }, null, 2) + "\n");
assert.equal(mismatches.length, 0, "Installed package bytes must match this source tree");
