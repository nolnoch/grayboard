import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isolationViolations } from "../../scripts/check_factory_isolation.ts";
import { ROOT } from "../support/paths.ts";

// The boundary itself (#323): this repo's tree, as bun test and CI see it.
test("this repo keeps the factory module isolated", () => {
  expect(isolationViolations(ROOT)).toEqual([]);
});

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

/** A scratch repo holding `files` (repo path → contents). */
function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "gb-isolation-"));
  root = dir;
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const BASE = {
  "src/plugin/client.ts": "export const client = 1;\n",
  "src/shared/protocol.ts": "export type Frame = {};\n",
  "src/core/boards.ts": "export const boards = 1;\n",
  "tests/support/until.ts": "export const until = 1;\n",
};

describe("isolationViolations", () => {
  test("the published client and protocol, module-internal files, packages, and tests/support from tests pass", () => {
    tree({
      ...BASE,
      "adapters/factory/bus.ts": 'import { client } from "../../src/plugin/client.ts";\nimport type { Frame } from "../../src/shared/protocol.ts";\nimport ts from "typescript";\n',
      "adapters/factory/main.ts": 'import "./bus.ts";\n',
      "adapters/factory/bus.test.ts": 'import { until } from "../../tests/support/until.ts";\n',
      // Text that only looks like an import.
      "adapters/factory/notes.ts": '// import "../../src/core/boards.ts";\nconst s = "import x from \'../../src/core/boards.ts\'";\n',
    });
    expect(isolationViolations(root!)).toEqual([]);
  });

  test("no factory module yet: only src/ is checked", () => {
    tree(BASE);
    expect(isolationViolations(root!)).toEqual([]);
  });

  test("every import form reaching past the published surface is caught", () => {
    const forms = {
      "type-only": 'import type { B } from "../../src/core/boards.ts";',
      "multi-line": 'import {\n  boards,\n} from "../../src/core/boards.ts";',
      "re-export": 'export * from "../../src/core/boards.ts";',
      "named re-export": 'export { boards } from "../../src/core/boards.ts";',
      "side-effect": 'import "../../src/core/boards.ts";',
      "dynamic": 'const m = await import("../../src/core/boards.ts");',
      "require": 'const m = require("../../src/core/boards.ts");',
      "import =": 'import m = require("../../src/core/boards.ts");',
      "import() type": 'type M = typeof import("../../src/core/boards.ts");',
    };
    for (const [form, code] of Object.entries(forms)) {
      const dir = tree({ ...BASE, "adapters/factory/x.ts": `${code}\n` });
      expect(isolationViolations(dir), form).toEqual([
        "adapters/factory/x.ts: imports src/core/boards.ts, beyond the published client and protocol (src/plugin/client.ts, src/shared/protocol.ts)",
      ]);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the module's sources can't use tests/support, other repo files, or anything outside the repo", () => {
    tree({
      ...BASE,
      "adapters/pi/grayboard.ts": "export const pi = 1;\n",
      "adapters/factory/a.ts": 'import { until } from "../../tests/support/until.ts";\n',
      "adapters/factory/b.ts": 'import { pi } from "../pi/grayboard.ts";\n',
      "adapters/factory/c.ts": 'import x from "../../../elsewhere.ts";\n',
    });
    expect(isolationViolations(root!)).toEqual([
      "adapters/factory/a.ts: imports tests/support/until.ts, beyond the published client and protocol (src/plugin/client.ts, src/shared/protocol.ts)",
      "adapters/factory/b.ts: imports adapters/pi/grayboard.ts, beyond the published client and protocol (src/plugin/client.ts, src/shared/protocol.ts)",
      "adapters/factory/c.ts: imports ../../../elsewhere.ts, outside the repo",
    ]);
  });

  test("an absolute path is resolved like a relative one", () => {
    tree(BASE);
    writeFileSync(join(root!, "src/core/boards.ts"), "");
    mkdirSync(join(root!, "adapters/factory"), { recursive: true });
    writeFileSync(join(root!, "adapters/factory/x.ts"), `import "${join(root!, "src/core/boards.ts")}";\n`);
    expect(isolationViolations(root!)).toEqual([
      "adapters/factory/x.ts: imports src/core/boards.ts, beyond the published client and protocol (src/plugin/client.ts, src/shared/protocol.ts)",
    ]);
  });

  test("src/ importing the factory module is caught, in any form", () => {
    tree({
      ...BASE,
      "adapters/factory/main.ts": "export const factory = 1;\n",
      "src/core/delegation.ts": 'import type { F } from "../../adapters/factory/main.ts";\n',
      "src/cli/main.ts": 'const f = await import("../../adapters/factory/main.ts");\n',
    });
    expect(isolationViolations(root!)).toEqual([
      "src/cli/main.ts: src/ imports the factory module (../../adapters/factory/main.ts)",
      "src/core/delegation.ts: src/ imports the factory module (../../adapters/factory/main.ts)",
    ]);
  });

  test("symlinks that would hide an import across the boundary are refused", () => {
    tree({ ...BASE, "adapters/factory/main.ts": "export const factory = 1;\n" });
    symlinkSync(join(root!, "src/core"), join(root!, "adapters/factory/core"));
    symlinkSync(join(root!, "adapters/factory"), join(root!, "src/factory"));
    expect(isolationViolations(root!)).toEqual([
      "src/factory: a symlink into adapters/factory/",
      "adapters/factory/core: a symlink in the factory module; the import check can't see through it",
    ]);
  });
});
