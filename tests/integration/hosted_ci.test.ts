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
  const publicRevision = "4604e8b8fe0cdcbacfc5edf3ef8f169a6733ac58";
  expect(hosted).toContain(`GRAYBOARD_PUBLIC_REVISION: "${publicRevision}"`);
  expect(read("README.md")).toContain(`github:nolnoch/grayboard#${publicRevision}::path:adapters/opencode-v2`);
  expect(hosted).toContain("persist-credentials: false");
  expect(hosted).toContain("contents: read");
  expect(hosted).toContain("if: always()");
  expect(hosted).toContain("retention-days: 7");
  expect(hosted).toContain("path: ${{ runner.temp }}/hosted-run/evidence");
  expect(read("scripts/e2e.sh")).toContain("bun scripts/hosted-evidence.ts");
  expect(read("scripts/e2e.sh")).not.toContain("tee \"$run/hosted.log\"");
  expect(hosted).not.toContain("continue-on-error");
  expect(hosted).not.toContain("secrets: inherit");
  for (const workflow of ["test", "release"]) expect(read(`.github/workflows/${workflow}.yml`)).toContain("uses: ./.github/workflows/hosted.yml");
  expect(read(".github/workflows/release.yml")).toContain("needs: [test, hosted]");
  expect(read(".github/workflows/release.yml")).toContain("needs: [build, e2e, upgrade-matrix]");
  expect(read(".github/workflows/test.yml")).toContain("RestartBogus=1");
});

test("hosted gates preserve the signed tag-only release boundary", () => {
  const release = Bun.YAML.parse(read(".github/workflows/release.yml")) as any;
  expect(Object.keys(release.on)).toEqual(["push"]);
  expect(release.on.push.tags).toEqual(["v*"]);
  expect(release.permissions).toEqual({ contents: "read" });
  expect(release.jobs.build.needs).toEqual(["test", "hosted"]);
  expect(release.jobs.release.needs).toEqual(["build", "e2e", "upgrade-matrix"]);
  expect(release.jobs.release.environment).toBe("release");
  expect(release.jobs.release.permissions).toEqual({ contents: "write", "id-token": "write", attestations: "write", "artifact-metadata": "write" });
  for (const name of ["Sign SHA256SUMS", "Remove the signing key", "Verify the signature against assets/release-keys", "Attest build provenance"]) {
    expect(release.jobs.release.steps.some((step: any) => step.name === name)).toBe(true);
  }
  const config = read("tests/e2e/opencode-config.ts");
  expect(config).toContain("helloLimit: DEFAULT_HELLO_LIMIT");
  expect(config).toContain("authFailLimit: DEFAULT_AUTH_FAIL_LIMIT");
  expect(config).toContain("trustedProxies: DEFAULT_TRUSTED_PROXIES");
  expect(config).toContain('app.repo.aliases.find("you@example.com", "be")');
  expect(config).not.toMatch(/FROM handles|repo\.identities/);
});

test("hosted entry point uses frozen package commands and retains no private state in evidence", () => {
  const runner = read("scripts/hosted-e2e.sh");
  const pkg = JSON.parse(read("adapters/opencode-v2/package.json"));
  for (const command of ["typecheck", "test", "build:package", "test:git", "test:host", "test:host-races", "test:native-host", "test:durable-host"]) {
    expect(pkg.scripts[command]).toBeString();
    expect(runner).toContain(`bun run ${command}`);
  }
  expect(runner).toContain('npm_config_ignore_scripts=true');
  expect(runner).toContain('"$GRAYBOARD_E2E_RUN_DIR/unit.xml" tests/reload-state.test.ts');
  expect(runner).toContain('"$root/scripts/hosted-provenance.ts"');
  expect(read(".github/workflows/hosted.yml")).not.toContain("path: adapters/opencode-v2");
  expect(read(".github/workflows/hosted.yml")).not.toContain("path: ${{ runner.temp }}/grayboard-hosted");
  for (const script of ["scripts/e2e.sh", "scripts/hosted-e2e.sh", "scripts/hooks/pre-push"]) {
    const result = Bun.spawnSync(["bash", "-n", resolve(root, script)]);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  }
});
