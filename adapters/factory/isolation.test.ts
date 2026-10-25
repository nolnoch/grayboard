// The isolation check's own tests (#293): the real repo is clean, and each
// rule fails on a fixture that violates it. The script takes a root argument
// exactly so these fixtures can exercise it without touching the repo.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "check_factory_isolation.ts");

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "factory-iso-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function check(root: string): { code: number; out: string } {
  const p = Bun.spawnSync([process.execPath, SCRIPT, root], { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: `${p.stdout}${p.stderr}` };
}

const CLIENT = `import { GrayboardClient } from "../../src/plugin/client.ts";\nexport const c = GrayboardClient;\n`;
const PROTOCOL = `import type { Message } from "../../src/shared/protocol.ts";\nexport type M = Message;\n`;

describe("factory isolation", () => {
  test("the real repo is clean", () => {
    const r = check(join(import.meta.dir, "..", ".."));
    expect(r.out).toContain("clean");
    expect(r.code).toBe(0);
  });

  test("src/ importing the factory module is refused (principle 7)", () => {
    const root = fixture({
      "src/core/t.ts": `import { x } from "../../adapters/factory/bus.ts";\nexport const y = x;\n`,
      "adapters/factory/bus.ts": CLIENT,
    });
    try {
      const r = check(root);
      expect(r.code).toBe(1);
      expect(r.out).toContain("src/ imports the factory module");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the module importing src/ beyond the allowlist is refused", () => {
    const root = fixture({
      "src/core/boards.ts": `export const db = 1;\n`,
      "adapters/factory/feature.ts": `import { db } from "../../src/core/boards.ts";\nexport const v = db;\n`,
      "adapters/factory/bus.ts": CLIENT,
    });
    try {
      const r = check(root);
      expect(r.code).toBe(1);
      expect(r.out).toContain("beyond the published client and protocol types");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the allowlisted imports pass; module-internal imports pass", () => {
    const root = fixture({
      "src/plugin/client.ts": `export class GrayboardClient {}\n`,
      "src/shared/protocol.ts": `export type Message = { id: number };\n`,
      "adapters/factory/bus.ts": CLIENT + PROTOCOL,
      "adapters/factory/main.ts": `import { ClientBus } from "./bus.ts";\nexport const B = ClientBus;\n`,
    });
    try {
      const r = check(root);
      expect(r.code).toBe(0);
      expect(r.out).toContain("clean");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("module tests may use tests/support but still only the allowlisted src/", () => {
    const ok = fixture({
      "src/plugin/client.ts": `export class GrayboardClient {}\n`,
      "tests/support/until.ts": `export const until = 1;\n`,
      "adapters/factory/bus.test.ts": `import { until } from "../../tests/support/until.ts";\nimport { GrayboardClient } from "../../src/plugin/client.ts";\nexport const t = [until, GrayboardClient];\n`,
    });
    const bad = fixture({
      "src/core/boards.ts": `export const db = 1;\n`,
      "adapters/factory/bus.test.ts": `import { db } from "../../src/core/boards.ts";\nexport const t = db;\n`,
      "adapters/factory/bus.ts": CLIENT,
    });
    try {
      expect(check(ok).code).toBe(0);
      const r = check(bad);
      expect(r.code).toBe(1);
      expect(r.out).toContain("beyond the published client and protocol types");
    } finally {
      rmSync(ok, { recursive: true, force: true });
      rmSync(bad, { recursive: true, force: true });
    }
  });
});
