import { resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "../..");
export const CLI = resolve(ROOT, "src/cli/main.ts");
