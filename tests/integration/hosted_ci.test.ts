import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

test("hosted gates remain independent, mandatory and release-blocking", () => {
  const pkg = JSON.parse(read("package.json"));
  expect(pkg.scripts.test).toBe("bun test ./src ./tests");
  const hosted = read(".github/workflows/hosted.yml");
  expect(hosted).toContain("suite: [strict, git, config, public, host, live, matrix, native, durable]");
  expect(hosted).toContain("timeout-minutes: 60");
  expect(hosted).toContain("bun install --frozen-lockfile");
  expect(hosted).toContain("persist-credentials: false");
  expect(hosted).toContain("contents: read");
  expect(hosted).toContain("if: always()");
  expect(hosted).toContain("retention-days: 7");
  expect(hosted).not.toContain("continue-on-error");
  expect(hosted).not.toContain("secrets: inherit");
  for (const workflow of ["test", "release"]) expect(read(`.github/workflows/${workflow}.yml`)).toContain("uses: ./.github/workflows/hosted.yml");
  expect(read(".github/workflows/release.yml")).toContain("needs: [test, hosted]");
  expect(read(".github/workflows/release.yml")).toContain("needs: [build, e2e, upgrade-matrix]");
  expect(read(".github/workflows/test.yml")).toContain("RestartBogus=1");
});

test("hosted entry point uses frozen package commands and retains no private state in evidence", () => {
  const runner = read("scripts/hosted-e2e.sh");
  const pkg = JSON.parse(read("adapters/opencode-v2/package.json"));
  for (const command of ["typecheck", "test", "build:package", "test:git", "test:host", "test:host-races", "test:native-host", "test:durable-host"]) {
    expect(pkg.scripts[command]).toBeString();
    expect(runner).toContain(`bun run ${command}`);
  }
  expect(runner).toContain('npm_config_ignore_scripts=true');
  expect(runner).toContain('"$root/scripts/hosted-provenance.ts"');
  expect(read(".github/workflows/hosted.yml")).not.toContain("path: adapters/opencode-v2");
  expect(read(".github/workflows/hosted.yml")).not.toContain("path: ${{ runner.temp }}/grayboard-hosted");
  for (const script of ["scripts/e2e.sh", "scripts/hosted-e2e.sh", "scripts/hooks/pre-push"]) {
    const result = Bun.spawnSync(["bash", "-n", resolve(root, script)]);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  }
});
