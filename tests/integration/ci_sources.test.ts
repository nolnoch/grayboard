// #379: configuration the CI gates repeat across workflows, scripts and docs.
// Each has one source; these tests fail when a copy drifts from it.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BUN_VERSION, HOSTED_SUITES } from "../../scripts/hosted-evidence.ts";

const root = resolve(import.meta.dir, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

// The hosted suites that reach outside networks run only from e2e.yml (nightly, by hand, the release).
const NETWORK = ["live", "public"];

test("the Bun pin lives in .bun-version, and every copy that can't read it matches it", () => {
  expect(read(".bun-version")).toMatch(/^\d+\.\d+\.\d+\n$/);
  expect(BUN_VERSION).toBe(read(".bun-version").trim());
  const setup = Bun.YAML.parse(read(".github/actions/setup/action.yml")) as any;
  const bun = setup.runs.steps.find((s: any) => s.uses?.startsWith("oven-sh/setup-bun@"));
  expect(bun.with).toEqual({ "bun-version-file": ".bun-version" });
  // setup-bun installs the latest Bun when the file is missing; the action refuses that.
  const steps = setup.runs.steps.map((s: any) => s.name ?? s.uses);
  expect(steps.indexOf("Require .bun-version")).toBeLessThan(steps.indexOf(bun.uses));
  expect(steps.indexOf("Check the installed Bun")).toBeGreaterThan(steps.indexOf(bun.uses));
  for (const script of ["scripts/hooks/pre-push", "scripts/hosted-e2e.sh"]) {
    expect(read(script)).toContain(".bun-version");
    expect(read(script)).not.toContain(BUN_VERSION);
  }
  // The package's host fixtures run from a prepared copy without the checkout root, so they keep a literal.
  const fixtures = [...new Bun.Glob("adapters/opencode-v2/tests/*.ts").scanSync(root), "tests/e2e/opencode-config.ts"];
  let asserted = 0;
  for (const file of fixtures) {
    for (const [, version] of read(file).matchAll(/Bun\.version, "([^"]+)"/g)) {
      expect(`${file}: ${version}`).toBe(`${file}: ${BUN_VERSION}`);
      asserted++;
    }
  }
  expect(asserted).toBeGreaterThan(0);
  // The user guide states the Bun the hosted OpenCode package is tested with ("with Bun x", "use Bun x");
  // a note on one release's behaviour ("Bun x can …") is not a pin.
  const guide = [...read("docs/guide/harnesses.md").matchAll(/\b(?:with|use) Bun (\d+\.\d+\.\d+)/g)].map((m) => m[1]);
  expect(guide.length).toBeGreaterThan(0);
  for (const version of guide) expect(version).toBe(BUN_VERSION);
});

test("the hosted suite list agrees across hosted-evidence.ts, hosted-e2e.sh, e2e.sh and the workflows", () => {
  // hosted-e2e.sh: the case labels of its suite dispatch.
  const runner = read("scripts/hosted-e2e.sh");
  const dispatch = runner.slice(runner.indexOf('case "${1:-}" in'), runner.indexOf("\nesac"));
  const labels = [...dispatch.matchAll(/^ {2}([a-z|]+)\)/gm)].flatMap((m) => m[1]!.split("|"));
  expect(labels.toSorted()).toEqual(HOSTED_SUITES.toSorted());
  // e2e.sh: the accepted names and the usage line.
  const e2e = read("scripts/e2e.sh");
  const accepted = /^ {2}(upgrade-matrix \|[^)]*)\) suite="\$1"/m.exec(e2e)![1]!.split(" | ");
  expect(accepted.filter((s) => s.startsWith("hosted-")).toSorted()).toEqual(HOSTED_SUITES.map((s) => `hosted-${s}`).toSorted());
  const usage = /usage: \$0 ([^ "]+)/.exec(e2e)![1]!.replace(/hosted-\{([a-z,]+)\}/, (_, list: string) => list.split(",").map((s) => `hosted-${s}`).join("|")).split("|");
  expect(usage.toSorted()).toEqual(accepted.toSorted());
  // hosted.yml: every hosted suite but the outside-network ones, plus claude-hosted (#501); each an e2e.sh name.
  const matrix: string[] = (Bun.YAML.parse(read(".github/workflows/hosted.yml")) as any).jobs.hosted.strategy.matrix.suite;
  expect(matrix.filter((s) => s.startsWith("hosted-")).toSorted()).toEqual(HOSTED_SUITES.filter((s) => !NETWORK.includes(s)).map((s) => `hosted-${s}`).toSorted());
  expect(matrix.filter((s) => !s.startsWith("hosted-"))).toEqual(["claude-hosted"]);
  for (const s of matrix) expect(accepted).toContain(s);
  // e2e.yml: the outside-network suites, by hand and nightly.
  const nightly = Bun.YAML.parse(read(".github/workflows/e2e.yml")) as any;
  const options: string[] = nightly.on.workflow_dispatch.inputs.suite.options;
  for (const s of NETWORK) expect(options).toContain(`hosted-${s}`);
  for (const s of options) expect([...accepted, "hosted-network"]).toContain(s);
});

test("the MCP client pin agrees across the root, hosted-core and the hosted OpenCode package", () => {
  // Dependabot moves the hosted OpenCode package's pin alone; hosted-core's modules ship vendored into it,
  // so a pin that moved in one place fails here and the bump PR finishes the others.
  const pin = (path: string) => { const pkg = JSON.parse(read(path)); return pkg.dependencies?.["@modelcontextprotocol/client"] ?? pkg.devDependencies?.["@modelcontextprotocol/client"]; };
  const pins = ["package.json", "adapters/hosted-core/package.json", "adapters/opencode-v2/package.json"].map((path) => [path, pin(path)]);
  for (const [path, pin] of pins) expect(`${path}: ${pin}`).toBe(`${path}: ${pins[0]![1]}`);
});
