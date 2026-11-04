import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Both are imported `with { type: "macro" }`: they run at bundle time, so the
// compiled binary carries the adapters without a checkout beside it.
export function adapterSource(harness: "opencode" | "pi"): string {
  return readFileSync(new URL(`../../adapters/${harness}/grayboard.ts`, import.meta.url), "utf8");
}

/**
 * An extension bundled for Node (pi) or for omp's Bun runtime, which runs
 * Node-target output: the hosted `adapters/pi-family/entry-<harness>.ts` or
 * local `adapters/omp/grayboard.ts`, built by `bun build`. omp's bundles leave
 * `@oh-my-pi/pi-coding-agent` external: omp resolves it to the running host (its agent
 * directory); pi's imports pi as types only. A subprocess, because Bun
 * refuses `Bun.build` inside a macro (it would deadlock the bundler). Run
 * from the repo root: the bundle's module comments are cwd-relative paths,
 * and a build from a throwaway cwd would embed the builder's absolute paths.
 * A failed build throws, failing the build that imports this.
 */
export function adapterBundle(harness: "pi" | "omp", mode: "hosted" | "local" = "hosted"): string {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const external = harness === "omp" ? ["--external", "@oh-my-pi/pi-coding-agent"] : [];
  const entry = mode === "local" ? `adapters/${harness}/grayboard.ts` : `adapters/pi-family/entry-${harness}.ts`;
  const r = Bun.spawnSync([process.execPath, "build", entry, "--target=node", "--format=esm", ...external], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`bundling ${entry} failed (exit ${r.exitCode}): ${r.stderr.toString()}`);
  return r.stdout.toString();
}
