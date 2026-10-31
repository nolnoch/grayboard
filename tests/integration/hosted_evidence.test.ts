import { afterEach, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { junit, provenance, repositoryGitEnv } from "../../scripts/hosted-evidence.ts";

const checkout = resolve(import.meta.dir, "../.."), roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const texts = (path: string): string => readdirSync(path, { withFileTypes: true }).map(e => e.isDirectory() ? texts(join(path, e.name)) : readFileSync(join(path, e.name), "utf8")).join("\n");

function fixtureEnv(root: string, inherited: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const hooks = join(root, "empty-hooks"); mkdirSync(hooks, { recursive: true });
  return { ...repositoryGitEnv(inherited), GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: hooks };
}
function fixtureGit(root: string, env: Record<string, string>, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, env });
  if (result.exitCode !== 0) throw new Error("Owned fixture Git setup failed; subprocess diagnostics withheld");
  return result.stdout.toString().trim();
}
const metadata = (directory: string): string => new Bun.CryptoHasher("sha256").update(readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry => entry.name + ":" + (entry.isDirectory() ? metadata(join(directory, entry.name)) : new Bun.CryptoHasher("sha256").update(readFileSync(join(directory, entry.name))).digest("hex"))).join("\n")).digest("hex");
const identity = ["-c", "user.name=Fixture", "-c", "user.email=you@example.com", "-c", "commit.gpgsign=false"];

const document = (body = '<testcase name="fixture"/>', root = 'tests="1" failures="0" skipped="0"', suite = "") => `<testsuites ${root}><testsuite ${suite}>${body}</testsuite></testsuites>`;
const invalidXML: Record<string, string> = {
  "malformed-xml": '<testsuites tests="1" failures="0" skipped="0"><testcase name="fixture">UNTERMINATED</testsuites>',
  "error-count": '<testsuites tests="1" failures="0" skipped="0" errors="1"><testsuite><testcase><error>fixture</error></testcase></testsuite></testsuites>',
  "root-count": document(undefined, 'tests="2" failures="0" skipped="0"'),
  "suite-count": document(undefined, undefined, 'tests="2"'),
  "case-count": document('<testcase tests="2"/>'),
  "failure-count": document('<testcase><failure>private failure</failure></testcase>'),
  "skipped-count": document('<testcase><skipped/></testcase>'),
  "negative-count": document(undefined, 'tests="-1" failures="0" skipped="0"'),
  "noninteger-count": document(undefined, 'tests="1.5" failures="0" skipped="0"'),
  "negative-suite": document(undefined, undefined, 'errors="-1"'),
  "case-errors": document('<testcase errors="1"/>'),
  "duplicate-root": document(undefined, 'tests="1" tests="1" failures="0" skipped="0"'),
  "duplicate-case": document('<testcase name="one" name="two"/>'),
  "mismatched-nesting": document('<testcase></testsuite>'),
  "invalid-entity": document('<testcase name="&unknown;"/>'),
  "invalid-codepoint": document('<testcase><system-out>&#0;</system-out></testcase>'),
  "multiple-roots": document() + document(),
  "trailing-data": document() + "private trailing data",
  "doctype": '<!DOCTYPE testsuites [<!ENTITY x "private">]>' + document(),
  "namespace": document(undefined, 'xmlns="https://example.com/unsupported" tests="1" failures="0" skipped="0"'),
  "invalid-utf8": document('<testcase><system-out>UTF8MARKER</system-out></testcase>'),
  "oversize": " ".repeat(8 * 1024 * 1024) + document(),
  "multiple-outcomes": document('<testcase><failure/><skipped/></testcase>'),
  "properties-unclosed": document('<properties><property name="ci" value="private"/><testcase/>'),
  "properties-duplicate": document('<properties/><properties/><testcase/>'),
  "property-duplicate": document('<properties><property name="ci" value="private"/><property name="ci" value="private"/></properties><testcase/>'),
  "property-unknown": document('<properties><property name="unknown" value="private"/></properties><testcase/>'),
  "property-missing-value": document('<properties><property name="commit"/></properties><testcase/>'),
  "property-extra-attribute": document('<properties><property name="ci" value="private" extra="private"/></properties><testcase/>'),
  "property-nested-outcome": document('<properties><property name="ci" value="private"><failure/></property></properties><testcase/>'),
  "property-text": document('<properties><property name="ci" value="private">private</property></properties><testcase/>'),
  "properties-count": document('<properties tests="1"/><testcase/>'),
};
for (const key of ["tests", "failures", "errors", "skipped"]) {
  const value = key === "tests" ? 2 : 1;
  const root = ["tests", "failures", "errors", "skipped"].map(k => `${k}="${k === key ? value : k === "tests" ? 1 : 0}"`).join(" ");
  invalidXML[`root-${key}`] = document(undefined, root);
  invalidXML[`suite-${key}`] = document(undefined, undefined, `${key}="${value}"`);
  invalidXML[`case-${key}`] = document(`<testcase ${key}="${value}"/>`);
}
const matrixReady = '{"phase":"prepare","state":"started"}\n{"phase":"prepare","state":"finished","exit":0}\n';
const matrixModes: Record<string, { raw: string; exit: number }> = {
  "matrix-success": { raw: matrixReady + Array.from({ length: 29 }, (_, i) => JSON.stringify({ phase: "case", id: i + 1, state: "started" }) + "\n" + JSON.stringify({ phase: "case", id: i + 1, state: "finished", exit: 0 }) + "\n").join(""), exit: 0 },
  "matrix-prepare": { raw: matrixReady.split("\n")[0]! + "\n", exit: 1 },
  "matrix-interrupted": { raw: matrixReady + '{"phase":"case","id":1,"state":"started"}\n', exit: 143 },
  "matrix-exit": { raw: matrixReady + '{"phase":"case","id":1,"state":"started"}\n{"phase":"case","id":1,"state":"finished","exit":7}\n', exit: 7 },
  "matrix-malformed": { raw: matrixReady + '{"secret":"SECRET"}\n', exit: 0 },
  "matrix-truncated": { raw: matrixReady.slice(0, -1), exit: 0 },
  "matrix-oversized": { raw: "SECRET".repeat(2000), exit: 0 },
};
for (const mode of ["assertion", "truncated", "crash", "provenance", "success", "cross-filesystem", ...Object.keys(invalidXML), ...Object.keys(matrixModes)]) test.skipIf(mode === "cross-filesystem" && process.platform !== "linux")(`hosted evidence allowlist: ${mode} never publishes raw diagnostics`, () => {
  const matrixMode = matrixModes[mode];
  const success = mode === "success" || mode === "cross-filesystem" || mode === "matrix-success";
  const root = mkdtempSync(join(tmpdir(), "gb-evidence-test-")); roots.push(root);
  const output = mode === "cross-filesystem" ? mkdtempSync("/dev/shm/gb-evidence-public-") : join(root, "public");
  if (mode === "cross-filesystem") { roots.push(output); expect(statSync(root).dev === statSync(output).dev).toBe(false); }
  for (const dir of ["scripts", "src", "tests/e2e", "tests/integration", "adapters/opencode-v2/src", "adapters/opencode-v2/tests", "adapters/hosted-core", "bin", "private"]) mkdirSync(join(root, dir), { recursive: true });
  for (const file of ["e2e.sh", "hosted-e2e.sh", "hosted-evidence.ts", "hosted-provenance.ts", "hosted-matrix.ts", "hosted-matrix-shell.ts"]) cpSync(join(checkout, "scripts", file), join(root, "scripts", file));
  writeFileSync(join(root, "src/fixture.ts"), "export {};\n");
  writeFileSync(join(root, "tests/e2e/opencode-config.ts"), "export {};\n");
  writeFileSync(join(root, "adapters/opencode-v2/package.json"), '{"name":"fixture","version":"1.0.0"}');
  writeFileSync(join(root, "adapters/hosted-core/package.json"), '{"name":"fixture-core","version":"1.0.0"}');
  writeFileSync(join(root, "tests/integration/hosted_core_sync.test.ts"), 'import { test } from "bun:test"; test("sync", () => {});\n');
  for (const file of ["index.js", "tui.js", "README.md", "src/index.ts"]) writeFileSync(join(root, "adapters/opencode-v2", file), "fixture\n");
  const secrets = ["access-" + crypto.randomUUID(), "refresh-" + crypto.randomUUID(), "lease-" + crypto.randomUUID(), "fake-access-one", "synthetic-json-secret"];
  if (matrixMode) {
    writeFileSync(join(root, "injected-matrix"), matrixMode.raw.replaceAll("SECRET", secrets[0]!));
    cpSync(join(checkout, "adapters/opencode-v2/tests/real-races.sh"), join(root, "adapters/opencode-v2/tests/real-races.sh"));
  }
  const payload = `import { test, expect } from "bun:test";\n${secrets.map((s, i) => `test(${JSON.stringify(s)}, () => { console.log(${JSON.stringify(s)}); expect(${JSON.stringify(s)}).toBe("other-${i}"); });`).join("\n")}`;
  writeFileSync(join(root, "probe.ts"), success ? 'import { test, expect } from "bun:test"; test("ok", () => expect(1).toBe(1));' : payload);
  if (invalidXML[mode]) {
    const parts = invalidXML[mode]!.split("UTF8MARKER");
    writeFileSync(join(root, "injected.xml"), mode === "invalid-utf8" ? Buffer.concat([Buffer.from(parts[0]!), Buffer.from([0xff]), Buffer.from(parts[1]!)]) : invalidXML[mode]!);
  }
  const bun = JSON.stringify(process.execPath);
  writeFileSync(join(root, "bin/bun"), `#!/bin/sh
case "$1" in
install)
 child="$GRAYBOARD_E2E_RUN_DIR/child-repository"
 [ -e "$child" ] && exit 0
 mkdir "$child" || exit 1
 git -C "$child" init -q || exit 1
 printf 'child fixture\\n' > "$child/sentinel"
 git -C "$child" add sentinel || exit 1
 git -C "$child" -c user.name=Fixture -c user.email=you@example.com -c commit.gpgsign=false commit -qm child || exit 1
 exit 0 ;;
run)
 shift
 if [ "$1" = test:host-races ]; then mkdir -p "$GRAYBOARD_PACKAGE_TEST_DIR"; printf '%s' "$PROBE_ROOT/adapters/opencode-v2" > "$GRAYBOARD_PACKAGE_TEST_DIR/installed.txt"; cp "$PROBE_ROOT/injected-matrix" "$GRAYBOARD_E2E_RUN_DIR/matrix.jsonl"; printf '%s' '${secrets[0]}' >&2; exit ${matrixMode?.exit ?? 1}; fi
 if [ "$1" != test ]; then exit 0; fi
 shift
 if [ -f "$PROBE_ROOT/injected.xml" ]; then cp "$PROBE_ROOT/injected.xml" "$GRAYBOARD_E2E_RUN_DIR/unit.xml"; printf '%s' '${secrets[0]}' >&2; exit 0; fi
 ${bun} test "$PROBE_ROOT/probe.ts" "$@"
 code=$?
 printf '%s' '${secrets[2]}' > "$GRAYBOARD_E2E_RUN_DIR/unrecognized.log"
 if [ "$PROBE_MODE" = truncated ] || [ "$PROBE_MODE" = crash ]; then printf '<testsuites tests="9">${secrets[0]}' > "$GRAYBOARD_E2E_RUN_DIR/unit.xml"; fi
 if [ "$PROBE_MODE" = crash ]; then kill -KILL $$; fi
 exit "$code" ;;
*)
 if [ "$(basename "$1")" = hosted-provenance.ts ] && [ "$PROBE_MODE" = provenance ]; then printf '%s' '${JSON.stringify({ access_token: secrets[1] })}' > "$4"; exit 1; fi
 exec ${bun} "$@" ;;
esac
`);
  chmodSync(join(root, "bin/bun"), 0o700);
  const parent = join(root, "parent"); mkdirSync(parent);
  const parentEnv = fixtureEnv(parent), parentGit = (...args: string[]) => fixtureGit(parent, parentEnv, ...args);
  parentGit("init", "-q"); writeFileSync(join(parent, "sentinel"), "parent metadata must not change\n");
  parentGit("add", "sentinel"); parentGit(...identity, "commit", "-qm", "parent");
  const before = metadata(join(parent, ".git"));
  const hooks = join(root, "scripts/hooks"); mkdirSync(hooks);
  writeFileSync(join(hooks, "pre-commit"), `#!/bin/sh\ntouch "${join(root, "fixture-hook-ran")}"\nexit 97\n`); chmodSync(join(hooks, "pre-commit"), 0o700);
  const inherited = { ...process.env, GIT_DIR: join(parent, ".git"), GIT_COMMON_DIR: join(parent, ".git"), GIT_WORK_TREE: parent, GIT_INDEX_FILE: join(parent, ".git/index"), GIT_OBJECT_DIRECTORY: join(parent, ".git/objects"), GIT_ALTERNATE_OBJECT_DIRECTORIES: join(parent, ".git/objects"), GIT_CONFIG_PARAMETERS: "'core.hooksPath'='scripts/hooks'", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: hooks, GIT_CONFIG_KEY_91: "core.worktree", GIT_CONFIG_VALUE_91: parent };
  const env = fixtureEnv(root, inherited), git = (...args: string[]) => fixtureGit(root, env, ...args);
  git("init", "-q"); git("add", "scripts", "src", "tests", "adapters");
  git(...identity, "commit", "-qm", "fixture");
  expect(git("rev-parse", "--absolute-git-dir") === realpathSync(join(root, ".git"))).toBe(true);
  const result = Bun.spawnSync(["bash", "scripts/e2e.sh", matrixMode ? "hosted-matrix" : "hosted-strict"], { cwd: root, env: { ...inherited, PATH: join(root, "bin") + ":" + env.PATH, TMPDIR: join(root, "private"), GRAYBOARD_E2E_RUN_DIR: output, GITHUB_SHA: secrets[1]!, GITHUB_SERVER_URL: "https://ci.example.com", GITHUB_REPOSITORY: "example/fixture", GITHUB_RUN_ID: secrets[0]!, PROBE_ROOT: root, PROBE_MODE: mode } });
  expect(metadata(join(parent, ".git"))).toBe(before);
  expect(existsSync(join(root, "fixture-hook-ran"))).toBe(false);
  const terminal = result.stdout.toString() + result.stderr.toString(), published = texts(output);
  for (const value of secrets) { expect(terminal.includes(value)).toBe(false); expect(published.includes(value)).toBe(false); }
  expect(result.exitCode).toBe(success ? 0 : 1);
  expect(readFileSync(join(output, "result"), "utf8")).toContain(success ? "passed" : "failed");
  const xml = readFileSync(join(output, "evidence/unit.xml"), "utf8");
  expect(xml).toContain(success ? 'failures="0"' : '<failure message="Private diagnostics withheld"/>');
  if (mode === "assertion") {
    expect(texts(join(root, "private"))).toContain(secrets[0]!);
    expect(xml).toContain('tests="5" failures="5"');
  }
  const summary = JSON.parse(readFileSync(join(output, "evidence/summary.json"), "utf8"));
  expect(summary.evidenceProcessed).toBe(mode === "assertion" || success || ["matrix-prepare", "matrix-interrupted", "matrix-exit"].includes(mode));
  const names = readdirSync(join(output, "evidence"));
  const allowlist = ["exit", "hosted.log", "provenance.json", "result", "source-revision", "source-status", "summary.json", "unit.xml", ...(matrixMode ? ["matrix.json"] : [])];
  expect(names.every(name => allowlist.includes(name))).toBe(true);
  expect(names.includes("matrix.json")).toBe(!!matrixMode);
  if (matrixMode) {
    const data = JSON.parse(readFileSync(join(output, "evidence/matrix.json"), "utf8"));
    expect(data.phase).toBe(mode === "matrix-success" ? "complete" : mode === "matrix-prepare" ? "prepare" : ["matrix-interrupted", "matrix-exit"].includes(mode) ? "case" : "invalid");
    expect(summary.runtimeExit).toBe(matrixMode.exit);
    expect(names.length).toBe(summary.evidenceProcessed ? 9 : 6);
  }
  if (invalidXML[mode]) { expect(summary.runtimeExit).toBe(0); expect(summary.exit).toBe(1); expect(readFileSync(join(output, "evidence/result"), "utf8")).toBe("failed\n"); }
}, 30_000);

test("each hosted suite requires its complete actual installation inventory and flags", () => {
  const root = mkdtempSync(join(tmpdir(), "gb-install-proof-")); roots.push(root);
  const pkg = join(root, "adapters/opencode-v2"); mkdirSync(join(pkg, "src"), { recursive: true });
  const files = ["package.json", "index.js", "tui.js", "README.md", "src/index.ts", "src/controller.ts"];
  const checks = files.map(path => {
    writeFileSync(join(pkg, path), path);
    const sha256 = new Bun.CryptoHasher("sha256").update(path).digest("hex");
    return { path, sha256, expected: sha256 };
  });
  const env = fixtureEnv(root), git = (...args: string[]) => fixtureGit(root, env, ...args);
  git("init", "-q"); git("add", "adapters"); git(...identity, "commit", "-qm", "fixture");
  const base = { bun: "1.4.4", backend: [], drivers: [], installed: false, publicInstalled: false, installedChecks: [] as typeof checks, publicChecks: [] as typeof checks };
  expect(provenance(base, root, "strict").installedChecks).toEqual([]);
  expect(() => provenance({ ...base, installed: true, installedChecks: checks }, root, "strict")).toThrow();
  for (const suite of ["git", "config", "public", "host", "live", "matrix", "native", "durable"]) {
    const valid = { ...base, installed: true, publicInstalled: suite === "public", installedChecks: checks, publicChecks: suite === "public" ? checks : [] };
    expect(provenance(valid, root, suite).mismatches).toEqual([]);
    for (const change of [
      { installed: false }, { installed: false, installedChecks: [] }, { installedChecks: [] },
      { installedChecks: checks.slice(1) }, { installedChecks: [...checks, checks[0]!] },
      { installedChecks: checks.map((c, i) => i === 1 ? checks[0]! : c) },
      { installedChecks: checks.map(c => ({ ...c, expected: "a".repeat(64), sha256: "a".repeat(64) })) },
      { publicInstalled: !valid.publicInstalled },
      ...(suite === "public" ? [{ publicChecks: [] }, { publicChecks: checks.slice(1) }, { publicChecks: checks.map((c, i) => i === 1 ? checks[0]! : c) }] : [{ publicChecks: checks }]),
    ]) expect(() => provenance({ ...valid, ...change }, root, suite)).toThrow();
    const mismatched = checks.map((c, i) => i ? c : { ...c, sha256: "a".repeat(64) });
    expect(provenance({ ...valid, installedChecks: mismatched }, root, suite).mismatches).toHaveLength(1);
  }
});

test("fixture Git filtering covers documented local variables without clearing transport settings", () => {
  const result = Bun.spawnSync(["git", "rev-parse", "--local-env-vars"], { cwd: checkout, env: repositoryGitEnv() });
  expect(result.exitCode).toBe(0);
  const names = [...result.stdout.toString().trim().split("\n"), "GIT_CONFIG_KEY_91", "GIT_CONFIG_VALUE_91", "GIT_NAMESPACE", "GIT_QUARANTINE_PATH", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM", "GIT_TEMPLATE_DIR"];
  expect(repositoryGitEnv({ ...Object.fromEntries(names.map(name => [name, "fixture-only"])), PATH: "/fixture/bin", GIT_SSH_COMMAND: "ssh" })).toEqual({ PATH: "/fixture/bin", GIT_SSH_COMMAND: "ssh" });
});

test("JUnit rejects partial metadata and strips all names, diagnostics and attributes", () => {
  expect(() => junit('<testsuites tests="1" failures="0" skipped="0">', false)).toThrow();
  const xml = junit(document('<testcase name="arbitrary-secret"><system-out>&amp;&lt;&gt;&quot;&apos;&#65;&#x1F600;</system-out></testcase>'), true);
  expect(xml).not.toContain("arbitrary-secret"); expect(xml).toContain('tests="2" failures="1"');
  const properties = junit(document('<properties><property name="ci" value="https://ci.example.com/&amp;private-property"/><property name="commit" value="private-property"/></properties><testcase/>'), false);
  expect(properties).toContain('tests="1" failures="0"'); expect(properties.includes("private-property")).toBe(false); expect(properties.includes("property")).toBe(false);
  expect(() => junit(" ".repeat(8 * 1024 * 1024) + document(), false)).toThrow();
  expect(() => junit(document('<testcase><system-out>\u0000</system-out></testcase>'), false)).toThrow();
});
