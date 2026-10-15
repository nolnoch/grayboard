import { readFileSync } from "node:fs";

// Imported `with { type: "macro" }`: runs at bundle time, so the compiled
// binary carries the adapter's source without a checkout beside it.
export function ompAdapterSource(): string {
  return readFileSync(new URL("../../adapters/omp/grayboard.ts", import.meta.url), "utf8");
}
