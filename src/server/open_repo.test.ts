// #807 P3 C11b: app.ts never reaches the Postgres modules. adapters/opencode-v2's fixtures import app.ts and typecheck
// it under that package's own @types/bun, which lacks Bun.SQL's listen/notify; openRepo (open_repo.ts) holds the
// Postgres import instead, for main.ts and the test harness.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const transpiler = new Bun.Transpiler({ loader: "ts" });

// Every repo module `entry` imports, transitively (type-only imports included: tsc reads those too).
function graph(entry: string): Set<string> {
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    const specs = [...text.matchAll(/(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1] ?? m[2]!);
    for (const { path } of transpiler.scanImports(text)) specs.push(path);
    for (const spec of specs) if (spec.startsWith(".") && spec.endsWith(".ts")) walk(resolve(dirname(file), spec));
  };
  walk(entry);
  return seen;
}

test("app.ts's import graph reaches neither pg_repo.ts, src/server/store/pg/ nor the S3 store's Bun.S3Client", () => {
  const files = [...graph(join(import.meta.dir, "app.ts"))].map((f) => relative(ROOT, f));
  expect(files).toContain("src/server/db.ts");
  expect(files.filter((f) => f === "src/server/pg_repo.ts" || f === "src/server/s3_blobs.ts" || f.startsWith("src/server/store/pg/"))).toEqual([]);
});

test("open_repo.ts does reach pg_repo.ts (the walk can see it)", () => {
  expect([...graph(join(import.meta.dir, "open_repo.ts"))].map((f) => relative(ROOT, f))).toContain("src/server/pg_repo.ts");
});
