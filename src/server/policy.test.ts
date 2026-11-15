// The authorization seam is one module (#806): every allow-or-deny decision
// goes through policy.ts authorize(), so the pre-seam rule helpers live there
// and nothing else under src/ calls them. Unit tests may (can_send.test.ts,
// access.test.ts exercise each rule directly).
import { expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const HELPERS = /\b(canSend|mayActIn|canAdmin|reachesHuman)\b/;

test("no source file outside policy.ts calls a pre-seam rule helper", () => {
  const offenders: string[] = [];
  for (const file of new Glob("src/**/*.ts").scanSync({ cwd: ROOT })) {
    if (file.endsWith(".test.ts") || file === "src/server/policy.ts") continue;
    const text = readFileSync(join(ROOT, file), "utf8");
    text.split("\n").forEach((line, i) => { if (HELPERS.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`); });
  }
  expect(offenders).toEqual([]);
});
