import { readFileSync } from "node:fs";

// Imported `with { type: "macro" }`: runs at bundle time, so the compiled
// binary carries the adapters' source without a checkout beside it.
export function adapterSource(harness: "omp" | "opencode"): string {
  return readFileSync(new URL(`../../adapters/${harness}/grayboard.ts`, import.meta.url), "utf8");
}
