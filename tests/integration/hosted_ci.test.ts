import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

test("hosted gates remain independent, mandatory and release-blocking", () => {
  const pkg = JSON.parse(read("package.json"));
  expect(pkg.scripts.test).toBe("bun test ./src ./tests");
  const hosted = read(".github/workflows/hosted.yml");
  expect(hosted).toContain("suite: [strict, git, config, host, matrix, native, durable]");
  expect(hosted).toContain("timeout-minutes: 60");
  expect(hosted).toContain("bun install --frozen-lockfile");
  expect(hosted).not.toContain("GRAYBOARD_PUBLIC_REVISION");
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
  expect(read(".github/workflows/release.yml")).toContain("needs: [build, e2e, upgrade-matrix, hosted-network]");
  expect(read(".github/workflows/test.yml")).toContain("RestartBogus=1");
});

test("the stable hosted aggregator runs even when matrix dependencies fail, cancel or skip", () => {
  const workflow = Bun.YAML.parse(read(".github/workflows/hosted.yml")) as any;
  const job = workflow.jobs.required;
  expect(job.name).toBe("Hosted required"); expect(job.needs).toBe("hosted");
  expect(job.if).toBe("${{ always() }}"); expect(job.steps).toHaveLength(1);
  expect(job.steps[0].env.RESULT).toBe("${{ needs.hosted.result }}");
  expect(workflow.jobs.hosted.if).toBeUndefined();
  expect(workflow.jobs.hosted.strategy["fail-fast"]).toBe(false);
  expect(workflow.jobs.hosted["continue-on-error"]).toBeUndefined();
  expect(workflow.jobs.hosted.strategy.matrix.suite).toEqual(["strict", "git", "config", "host", "matrix", "native", "durable"]);
  const caller = Bun.YAML.parse(read(".github/workflows/test.yml")) as any;
  expect(caller.jobs.hosted.name).toBeUndefined();
  expect(caller.jobs.hosted.uses).toBe("./.github/workflows/hosted.yml");
  for (const result of ["success", "failure", "cancelled", "skipped", ""]) {
    const process = Bun.spawnSync(["bash", "-c", job.steps[0].run], { env: { ...Bun.env, RESULT: result } });
    expect(process.exitCode === 0).toBe(result === "success");
  }
});

test("hosted gates preserve the signed tag-only release boundary", () => {
  const release = Bun.YAML.parse(read(".github/workflows/release.yml")) as any;
  expect(Object.keys(release.on)).toEqual(["push"]);
  expect(release.on.push.tags).toEqual(["v*"]);
  expect(release.permissions).toEqual({ contents: "read" });
  expect(release.jobs.build.needs).toEqual(["test", "hosted"]);
  expect(release.jobs.release.needs).toEqual(["build", "e2e", "upgrade-matrix", "hosted-network"]);
  expect(release.jobs.release.environment).toBe("release");
  expect(release.jobs.release.permissions).toEqual({ contents: "write", "id-token": "write", attestations: "write", "artifact-metadata": "write" });
  for (const name of ["Sign SHA256SUMS", "Remove the signing key", "Verify the signature against assets/release-keys", "Attest build provenance"]) {
    expect(release.jobs.release.steps.some((step: any) => step.name === name)).toBe(true);
  }
  for (const [id, job] of Object.entries(release.jobs) as [string, any][]) {
    if (id !== "release") expect(JSON.stringify(job)).not.toContain("RELEASE_SIGNING_KEY");
    for (const dependency of job.needs ? Array.isArray(job.needs) ? job.needs : [job.needs] : []) expect(release.jobs[dependency]).toBeDefined();
  }
  const config = read("tests/e2e/opencode-config.ts");
  expect(config).toContain("helloLimit: DEFAULT_HELLO_LIMIT");
  expect(config).toContain("authFailLimit: DEFAULT_AUTH_FAIL_LIMIT");
  expect(config).toContain("trustedProxies: DEFAULT_TRUSTED_PROXIES");
  expect(config).toContain('app.repo.aliases.find("you@example.com", "be")');
  expect(config).not.toMatch(/FROM handles|repo\.identities/);
});

test("outside-network hosted suites run only nightly, explicitly, or across the release boundary", () => {
  const hosted = Bun.YAML.parse(read(".github/workflows/hosted.yml")) as any;
  expect(hosted.on).toEqual({ workflow_call: null });
  expect(JSON.stringify(hosted)).not.toMatch(/hosted-(?:live|public)|CIMD_LIVE|PUBLIC_REVISION/);
  const nightly = Bun.YAML.parse(read(".github/workflows/e2e.yml")) as any;
  expect(Object.keys(nightly.on)).toEqual(["schedule", "workflow_dispatch", "workflow_call"]);
  const expression = nightly.jobs.e2e.strategy.matrix.suite;
  expect(expression).toContain('github.event_name == \'schedule\' && \'["upgrade-matrix","hosted-live","hosted-public"]\'');
  expect(expression).toContain('inputs.suite == \'hosted-network\' && \'["hosted-live","hosted-public"]\'');
  expect(nightly.jobs["tracking-issue"].strategy.matrix.suite).toEqual(["upgrade-matrix", "hosted-live", "hosted-public"]);
  const steps = nightly.jobs.e2e.steps;
  const resolve = steps.find((s: any) => s.id === "public");
  expect(resolve.if).toBe("matrix.suite == 'hosted-public'");
  expect(resolve.run).toContain('revision="$(bash scripts/hosted-public-revision.sh)"');
  const checkout = steps.find((s: any) => s.with?.ref);
  expect(checkout.with.ref).toBe("${{ steps.public.outputs.revision }}");
  expect(checkout.if).toBe(resolve.if);
  expect(steps.find((s: any) => s.name === "Run ${{ matrix.suite }}").env.GRAYBOARD_PUBLIC_REVISION).toBe(checkout.with.ref);
  const upload = steps.find((s: any) => s.uses?.startsWith("actions/upload-artifact@"));
  expect(upload.with.name).toBe("e2e-${{ matrix.suite }}-${{ github.run_id }}-${{ github.run_attempt }}");
  expect(upload.with.path).toContain("${{ runner.temp }}/e2e-run/evidence");
  expect(upload.with.path).toContain("!startsWith(matrix.suite, 'hosted-')");
  expect(steps.find((s: any) => s.name === "Require hosted package in the selected release").run).toContain("exit 1");
  expect(read(".github/workflows/e2e.yml")).not.toMatch(/GRAYBOARD_PUBLIC_REVISION: "[a-f0-9]{40}"/);
  const release = Bun.YAML.parse(read(".github/workflows/release.yml")) as any;
  for (const id of ["hosted-network", "hosted-post-release"]) {
    expect(release.jobs[id].uses).toBe("./.github/workflows/e2e.yml");
    expect(release.jobs[id].with.suite).toBe("hosted-network");
    expect(release.jobs[id]["continue-on-error"]).toBeUndefined();
  }
  expect(release.jobs.release.needs).toContain("hosted-network");
  expect(release.jobs["hosted-post-release"].needs).toBe("release");
  for (const workflow of ["test", "hosted"]) expect(read(`.github/workflows/${workflow}.yml`)).not.toMatch(/hosted-(?:live|public)|CIMD_LIVE/);
  const runner = read("scripts/hosted-e2e.sh");
  expect(runner).toContain('live) GRAYBOARD_TEST_CODEMODE=1 GRAYBOARD_TEST_CIMD_LIVE=1');
  expect(runner).toContain('if [[ "$1" == public ]]; then');
});

test("public source resolves the latest release's peeled commit and fails closed without fallbacks", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "gb-public-revision-"));
  try {
    const bin = resolve(directory, "bin"); mkdirSync(bin);
    for (const [command, body] of Object.entries({
      gh: 'test "$*" = "release view --repo nolnoch/grayboard --json tagName --jq .tagName" || exit 81\nprintf "%s\\n" "$TEST_TAG"\nexit "${TEST_GH_EXIT:-0}"',
      git: 'test "$*" = "ls-remote https://github.com/nolnoch/grayboard.git refs/tags/$TEST_TAG refs/tags/$TEST_TAG^{}" || exit 82\nprintf "%s\\n" "$TEST_REFS"\nexit "${TEST_GIT_EXIT:-0}"',
    })) { const path = resolve(bin, command); writeFileSync(path, "#!/bin/bash\n" + body + "\n"); chmodSync(path, 0o700); }
    const direct = "a".repeat(40), peeled = "b".repeat(40);
    const run = (overrides: Record<string, string>) => Bun.spawnSync(["bash", resolve(root, "scripts/hosted-public-revision.sh")], { env: { ...Bun.env, PATH: bin + ":" + Bun.env.PATH, TEST_TAG: "v2.0.0", TEST_REFS: `${direct}\trefs/tags/v2.0.0\n${peeled}\trefs/tags/v2.0.0^{}`, ...overrides } });
    expect(run({}).stdout.toString().trim()).toBe(peeled);
    expect(run({ TEST_REFS: `${direct}\trefs/tags/v2.0.0` }).stdout.toString().trim()).toBe(direct);
    const failures: Record<string, string>[] = [{ TEST_GH_EXIT: "1" }, { TEST_GIT_EXIT: "1" }, { TEST_TAG: "main" }, { TEST_TAG: "v2.0.0;false" }, { TEST_REFS: "" }, { TEST_REFS: `${direct}\trefs/heads/main` }, { TEST_REFS: "bad\trefs/tags/v2.0.0" }];
    for (const overrides of failures) {
      const result = run(overrides); expect(result.exitCode).not.toBe(0); expect(result.stdout.toString()).toBe("");
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
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
  for (const script of ["scripts/e2e.sh", "scripts/hosted-e2e.sh", "scripts/hosted-public-revision.sh", "scripts/hooks/pre-push"]) {
    const result = Bun.spawnSync(["bash", "-n", resolve(root, script)]);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  }
});
