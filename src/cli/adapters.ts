import { readFileSync } from "node:fs";

// Imported `with { type: "macro" }`: runs at bundle time, so the compiled
// binary carries the adapters' source without a checkout beside it.
export function adapterSource(harness: "omp" | "opencode" | "pi" | "pi-child"): string {
  const file = harness === "pi-child" ? "grayboard-child.ts" : "grayboard.ts";
  return readFileSync(new URL(`../../adapters/${harness === "pi-child" ? "pi" : harness}/${file}`, import.meta.url), "utf8");
}
