// pi and omp load hosted-core bundled `--target node` (#430): the repo modules
// the proxy and the adapters import must carry no Bun-only API, or the bundle
// fails at runtime under Node (pi) where Bun's typecheck can't see it.
import { expect, test } from "bun:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const entries = ["src/shared/attachments.ts", "src/core/bindings.ts", "src/core/tools.ts", "src/shared/inbox.ts", "adapters/hosted-core/src/proxy.ts", "adapters/hosted-core/src/channel.ts"];

for (const entry of entries) test(`a --target node bundle of ${entry} has no bun:sqlite and no Bun. reference`, async () => {
  const built = await Bun.build({ entrypoints: [resolve(root, entry)], target: "node" });
  expect(built.logs.map(String)).toEqual([]);
  expect(built.success).toBe(true);
  expect(built.outputs).toHaveLength(1);
  const code = await built.outputs[0]!.text();
  expect(code.length).toBeGreaterThan(0);
  expect(code).not.toContain("bun:sqlite");
  expect(code.match(/\bBun\./g)).toBeNull();
});
