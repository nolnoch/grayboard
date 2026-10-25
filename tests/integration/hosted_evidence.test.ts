import { afterEach, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { junit } from "../../scripts/hosted-evidence.ts";

const checkout = resolve(import.meta.dir, "../.."), roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const texts = (path: string): string => readdirSync(path, { withFileTypes: true }).map(e => e.isDirectory() ? texts(join(path, e.name)) : readFileSync(join(path, e.name), "utf8")).join("\n");

for (const mode of ["assertion", "truncated", "crash", "provenance", "success"]) test(`hosted evidence allowlist: ${mode} never publishes raw diagnostics`, () => {
  const root = mkdtempSync(join(tmpdir(), "gb-evidence-test-")); roots.push(root);
  for (const dir of ["scripts", "src", "tests/e2e", "adapters/opencode-v2/src", "adapters/opencode-v2/tests", "bin", "private"]) mkdirSync(join(root, dir), { recursive: true });
  for (const file of ["e2e.sh", "hosted-e2e.sh", "hosted-evidence.ts", "hosted-provenance.ts"]) cpSync(join(checkout, "scripts", file), join(root, "scripts", file));
  writeFileSync(join(root, "src/fixture.ts"), "export {};\n");
  writeFileSync(join(root, "tests/e2e/opencode-config.ts"), "export {};\n");
  writeFileSync(join(root, "adapters/opencode-v2/package.json"), '{"name":"fixture","version":"1.0.0"}');
  const secrets = ["access-" + crypto.randomUUID(), "refresh-" + crypto.randomUUID(), "lease-" + crypto.randomUUID(), "fake-access-one", "synthetic-json-secret"];
  const payload = `import { test, expect } from "bun:test";\n${secrets.map((s, i) => `test(${JSON.stringify(s)}, () => { console.log(${JSON.stringify(s)}); expect(${JSON.stringify(s)}).toBe("other-${i}"); });`).join("\n")}`;
  writeFileSync(join(root, "probe.ts"), mode === "success" ? 'import { test, expect } from "bun:test"; test("ok", () => expect(1).toBe(1));' : payload);
  const bun = JSON.stringify(process.execPath);
  writeFileSync(join(root, "bin/bun"), `#!/bin/sh
case "$1" in
install) exit 0 ;;
run)
 shift
 if [ "$1" != test ]; then exit 0; fi
 shift
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
  const git = (...args: string[]) => { const r = Bun.spawnSync(["git", ...args], { cwd: root }); expect(r.exitCode).toBe(0); };
  git("init", "-q"); git("add", "scripts", "src", "tests", "adapters");
  git("-c", "user.name=Fixture", "-c", "user.email=you@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  const result = Bun.spawnSync(["bash", "scripts/e2e.sh", "hosted-strict"], { cwd: root, env: { ...process.env, PATH: join(root, "bin") + ":" + process.env.PATH, TMPDIR: join(root, "private"), GRAYBOARD_E2E_RUN_DIR: join(root, "public"), PROBE_ROOT: root, PROBE_MODE: mode } });
  const terminal = result.stdout.toString() + result.stderr.toString(), published = texts(join(root, "public"));
  for (const value of secrets) { expect(terminal.includes(value)).toBe(false); expect(published.includes(value)).toBe(false); }
  expect(result.exitCode).toBe(mode === "success" ? 0 : 1);
  expect(readFileSync(join(root, "public/result"), "utf8")).toContain(mode === "success" ? "passed" : "failed");
  const xml = readFileSync(join(root, "public/evidence/unit.xml"), "utf8");
  expect(xml).toContain(mode === "success" ? 'failures="0"' : '<failure message="Private diagnostics withheld"/>');
  if (mode === "assertion") {
    expect(texts(join(root, "private"))).toContain(secrets[0]!);
    expect(xml).toContain('tests="5" failures="5"');
  }
  const summary = JSON.parse(readFileSync(join(root, "public/evidence/summary.json"), "utf8"));
  expect(summary.evidenceProcessed).toBe(mode === "assertion" || mode === "success");
}, 30_000);

test("JUnit rejects partial metadata and strips all names, diagnostics and attributes", () => {
  expect(() => junit('<testsuites tests="1" failures="0" skipped="0">', false)).toThrow();
  const xml = junit('<testsuites tests="1" failures="0" skipped="0" name="arbitrary-secret"><testcase name="arbitrary-secret"/></testsuites>', true);
  expect(xml).not.toContain("arbitrary-secret"); expect(xml).toContain('tests="2" failures="1"');
});
