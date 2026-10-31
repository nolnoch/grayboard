import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Both are imported `with { type: "macro" }`: they run at bundle time, so the
// compiled binary carries the adapters without a checkout beside it.
export function adapterSource(harness: "omp" | "opencode" | "pi"): string {
  return readFileSync(new URL(`../../adapters/${harness}/grayboard.ts`, import.meta.url), "utf8");
}

/**
 * A hosted extension bundled for Node: `adapters/pi-family/entry-<harness>.ts`
 * built by `bun build`. A subprocess, because Bun refuses `Bun.build` inside a
 * macro (it would deadlock the bundler). Run from the repo root: the bundle's
 * module comments are cwd-relative paths, and a build from a throwaway cwd
 * would embed the builder's absolute paths. A failed build throws, failing
 * the build that imports this.
 */
export function adapterBundle(harness: "pi"): string {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const r = Bun.spawnSync([process.execPath, "build", `adapters/pi-family/entry-${harness}.ts`, "--target=node", "--format=esm"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`bundling entry-${harness}.ts failed (exit ${r.exitCode}): ${r.stderr.toString()}`);
  return r.stdout.toString();
}
