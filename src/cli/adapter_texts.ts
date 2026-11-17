// The adapter texts setup and refresh-adapters write, built by the macros at
// bundle time. Loaded with `await import()` by those commands only: from
// source, every macro runs when its module loads (`adapterBundle` spawns a
// `bun build`), and a failing one would break every source command (#438).
import { adapterBundle, adapterSource } from "./adapters.ts" with { type: "macro" };

export const OPENCODE = adapterSource("opencode");
export const PI_LOCAL = adapterSource("pi");
export const PI_HOSTED = adapterBundle("pi");
export const OMP_LOCAL = adapterBundle("omp", "local");
export const OMP_HOSTED = adapterBundle("omp");
