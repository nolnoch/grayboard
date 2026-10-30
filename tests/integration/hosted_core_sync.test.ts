// #430: opencode-v2 carries a generated copy of the hosted-core modules it
// imports (src/core/); it must match hosted-core byte for byte, and no other
// module may exist in both packages.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SOURCE, TARGET, generated } from "../../scripts/sync_hosted_core.ts";

test("opencode-v2's src/core is exactly the generated hosted-core copy (run `bun scripts/sync_hosted_core.ts`)", () => {
  const files = generated();
  expect(readdirSync(TARGET).sort()).toEqual([...files.keys()].sort());
  for (const [name, text] of files) expect(readFileSync(join(TARGET, name), "utf8"), name).toBe(text);
});

test("no module exists in both opencode-v2/src and hosted-core/src outside the generated copy", () => {
  const modules = (dir: string) => readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name);
  const opencode = new Set(modules(join(TARGET, "..")));
  expect(modules(SOURCE).filter(name => opencode.has(name))).toEqual([]);
});
