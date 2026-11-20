// The server's floating-promise check (#1107, #1115): the repo itself, then the rule on a scratch tree.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { floatingPromises } from "../../scripts/check_floating_promises.ts";
import { ROOT } from "../support/paths.ts";

test("the server has no floating promises", () => {
  expect(floatingPromises(ROOT)).toEqual([]);
}, 60_000);

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

// A scratch repo whose tsconfig covers src/, holding `files` (repo path → contents).
function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "gb-floating-"));
  root = dir;
  const all = { "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ESNext", module: "ESNext", strict: true, noEmit: true, lib: ["ESNext"], types: [] }, include: ["src/**/*.ts"] }), ...files };
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const HEAD = "declare function write(): Promise<void>;\ndeclare function maybe(): Promise<number> | number;\ndeclare function sync(): number;\n";

test("an unawaited promise statement is reported; awaited, voided, caught and assigned ones aren't", () => {
  tree({
    "src/server/a.ts": `${HEAD}export async function f() {
  write();
  maybe();
  (write());
  write().then(() => 1);
  write().finally(() => 1);
  await write();
  void write();
  write().catch(() => {});
  write().then(() => 1, () => 2);
  write().catch(() => {}).finally(() => 1);
  let p: Promise<void>;
  p = write();
  sync();
  return p;
}
`,
  });
  expect(floatingPromises(root!)).toEqual([
    "src/server/a.ts:5: write();",
    "src/server/a.ts:6: maybe();",
    "src/server/a.ts:7: (write());",
    "src/server/a.ts:8: write().then(() => 1);",
    "src/server/a.ts:9: write().finally(() => 1);",
  ]);
});

test("only src/server/ is checked", () => {
  tree({ "src/core/b.ts": `${HEAD}export function g() { write(); }\n`, "src/server/c.ts": `${HEAD}export function h() { write(); }\n` });
  expect(floatingPromises(root!)).toEqual(["src/server/c.ts:4: write();"]);
});
