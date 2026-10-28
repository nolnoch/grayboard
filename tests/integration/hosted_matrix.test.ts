import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { matrixCases, matrixCaseID, matrixLoopSHA, matrixObservation } from "../../scripts/hosted-matrix.ts";

const root = resolve(import.meta.dir, "../.."), roots: string[] = [];
afterAll(() => roots.forEach(path => rmSync(path, { recursive: true, force: true })));
const prepare = '{"phase":"prepare","state":"started"}\n';
const ready = prepare + '{"phase":"prepare","state":"finished","exit":0}\n';
const start = (id: number) => JSON.stringify({ phase: "case", id, state: "started" }) + "\n";
const end = (id: number, exit = 0) => JSON.stringify({ phase: "case", id, state: "finished", exit }) + "\n";
const all = ready + matrixCases.map((_, i) => start(i + 1) + end(i + 1)).join("");

test("matrix parser constructs bounded canonical states and requires every successful case", () => {
  expect(matrixObservation(all, 0)).toEqual({ phase: "complete", state: "finished", exit: 0, completed: 29, cases: matrixCases.map((_, i) => ({ id: i + 1, exit: 0 })) });
  expect(matrixObservation(prepare, 1)).toEqual({ phase: "prepare", state: "interrupted", exit: 1, completed: 0, cases: [] });
  expect(matrixObservation(ready + start(1), 137)).toEqual({ phase: "case", id: 1, state: "interrupted", exit: 137, completed: 0, cases: [] });
  expect(matrixObservation(ready + start(1) + end(1, 7), 7)).toEqual({ phase: "case", id: 1, state: "finished", exit: 7, completed: 1, cases: [{ id: 1, exit: 7 }] });
  expect(matrixObservation(all, 1).phase).toBe("complete");
  expect(matrixObservation(ready + start(1) + end(1), 1)).toEqual({ phase: "case", id: 1, state: "finished", exit: 0, completed: 1, cases: [{ id: 1, exit: 0 }] });
  for (const input of ["", prepare.slice(0, -1), "x".repeat(8193), ready, ready + start(2), ready + end(1), ready + start(1) + start(1), all + start(30), ready + start(1) + end(1, 1) + start(2), ready + start(1) + end(1, 256), ready + start(1) + end(1, -1), ready + start(1) + '{"phase":"case","id":1,"state":"finished","exit":0,"extra":"private"}\n', ready + start(1) + '{"phase":"case","id":1,"id":1,"state":"finished","exit":0}\n', ready + start(1) + end(1).replace('"exit":0', '"exit":0.0')]) {
    expect(() => matrixObservation(input, 0)).toThrow("Invalid matrix observations");
  }
  for (const code of [-1, 256, 0.1, NaN]) expect(() => matrixObservation(all, code)).toThrow();
  expect(() => matrixCaseID({ GRAYBOARD_TEST_REAL_RACE: "private-secret" })).toThrow("Invalid matrix invocation");
});

function fixture(body: string) {
  const path = mkdtempSync(join(tmpdir(), "gb-matrix-test-")); roots.push(path);
  mkdirSync(join(path, "tests")); mkdirSync(join(path, "bin"));
  writeFileSync(join(path, "tests/real-run.sh"), body);
  const observations = join(path, "observations"); writeFileSync(observations, prepare);
  writeFileSync(join(path, "bin/sh"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(root, "scripts/hosted-matrix-shell.ts"))} "$@"\n`); chmodSync(join(path, "bin/sh"), 0o700);
  const env = { ...process.env, PATH: join(path, "bin") + ":" + process.env.PATH, GRAYBOARD_MATRIX_PACKAGE: path, GRAYBOARD_MATRIX_SHELL: "/bin/sh", GRAYBOARD_MATRIX_OBSERVATIONS: observations, GRAYBOARD_TEST_REAL_RACE: "pause", GRAYBOARD_TEST_RACE_BOUNDARY: "before", GRAYBOARD_TEST_CRASH_BOUNDARY: "", GIT_DIR: join(path, "not-a-repository"), GIT_INDEX_FILE: join(path, "untouched-index"), GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: path };
  writeFileSync(env.GIT_INDEX_FILE, "untouched");
  return { path, observations, env };
}

test("observer delegates the unchanged reviewed parent loop and maps its actual invocations", () => {
  const loop = readFileSync(join(root, "adapters/opencode-v2/tests/real-races.sh"));
  expect(new Bun.CryptoHasher("sha256").update(loop).digest("hex")).toBe(matrixLoopSHA);
  const f = fixture('test "$0" = tests/real-run.sh || exit 91\nexit 0\n');
  writeFileSync(join(f.path, "tests/real-races.sh"), loop); writeFileSync(join(f.path, "tests/real-prepare.sh"), "exit 0\n");
  const result = Bun.spawnSync(["/bin/sh", "tests/real-races.sh"], { cwd: f.path, env: { ...f.env, GRAYBOARD_PACKAGE_TEST_DIR: f.path, GRAYBOARD_TEST_REAL_RACE: "", GRAYBOARD_TEST_RACE_BOUNDARY: "" } });
  expect(result.exitCode).toBe(0);
  expect(matrixObservation(readFileSync(f.observations, "utf8"), result.exitCode).completed).toBe(29);
  expect(readFileSync(f.env.GIT_INDEX_FILE, "utf8")).toBe("untouched");
});

test("observed and unobserved shells preserve argv, stdin, stdout and numeric exit without publishing secrets", () => {
  const secret = "private-" + crypto.randomUUID();
  const f = fixture('read -r input\nprintf "%s\\n" "$input"\nexit 23\n');
  const result = Bun.spawnSync([join(f.path, "bin/sh"), "tests/real-run.sh"], { cwd: f.path, env: f.env, stdin: Buffer.from(secret + "\n") });
  expect(result.exitCode).toBe(23); expect(result.stdout.toString().includes(secret)).toBe(true);
  const raw = readFileSync(f.observations, "utf8"), safe = JSON.stringify(matrixObservation(raw, 23));
  expect(raw.includes(secret)).toBe(false); expect(safe.includes(secret)).toBe(false);
  const delegated = Bun.spawnSync([join(f.path, "bin/sh"), "-c", 'printf "%s" "$1"; exit 17', "private-name", secret], { cwd: f.path, env: f.env });
  expect(delegated.exitCode).toBe(17); expect(delegated.stdout.toString().includes(secret)).toBe(true); expect(readFileSync(f.observations, "utf8") === raw).toBe(true);
});

test("observer preserves a child's signal and rejects unknown scenario values without exposing them", () => {
  const f = fixture('kill -TERM $$\n');
  const result = Bun.spawnSync([join(f.path, "bin/sh"), "tests/real-run.sh"], { cwd: f.path, env: f.env });
  expect(result.signalCode).toBe("SIGTERM");
  expect(result.exitCode).toBeNull();
  expect(matrixObservation(readFileSync(f.observations, "utf8"), 143).exit).toBe(143);
  writeFileSync(f.observations, prepare);
  const secret = "private-" + crypto.randomUUID();
  const invalid = Bun.spawnSync([join(f.path, "bin/sh"), "tests/real-run.sh"], { cwd: f.path, env: { ...f.env, GRAYBOARD_TEST_REAL_RACE: secret } });
  expect(invalid.exitCode).toBe(1);
  expect((invalid.stdout.toString() + invalid.stderr.toString() + readFileSync(f.observations, "utf8")).includes(secret)).toBe(false);
});

test("cancellation reaps a signal-resistant direct child without changing the signal reported to its caller", async () => {
  const f = fixture('trap "" TERM\nprintf "%s" "$$" > "$GRAYBOARD_MATRIX_PACKAGE/child-pid"\nprintf ready > "$GRAYBOARD_MATRIX_PACKAGE/ready"\nwhile :; do sleep 1; done\n');
  const child = Bun.spawn([join(f.path, "bin/sh"), "tests/real-run.sh"], { cwd: f.path, env: f.env, stdout: "pipe", stderr: "pipe" });
  try {
    const until = Date.now() + 5000;
    while (!existsSync(join(f.path, "ready"))) { if (Date.now() > until) throw new Error("Fixture did not start"); await Bun.sleep(10); }
    const pid = Number(readFileSync(join(f.path, "child-pid"), "utf8"));
    child.kill("SIGTERM");
    expect(await child.exited).toBe(143);
    expect(matrixObservation(readFileSync(f.observations, "utf8"), 143).exit).toBe(143);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { child.kill("SIGKILL"); }
}, 10_000);

for (const signal of ["SIGTERM", "SIGINT"] as const) test(`observer forwards ${signal}, reaps its child and preserves signal status`, async () => {
  const f = fixture('printf "%s" "$$" > "$GRAYBOARD_MATRIX_PACKAGE/child-pid"\nprintf ready > "$GRAYBOARD_MATRIX_PACKAGE/ready"\nwhile :; do sleep 1; done\n');
  const child = Bun.spawn([join(f.path, "bin/sh"), "tests/real-run.sh"], { cwd: f.path, env: f.env, stdout: "pipe", stderr: "pipe" });
  try {
    const until = Date.now() + 5000;
    while (!existsSync(join(f.path, "ready"))) { if (Date.now() > until) throw new Error("Fixture did not start"); await Bun.sleep(10); }
    const pid = Number(readFileSync(join(f.path, "child-pid"), "utf8"));
    child.kill(signal);
    expect(await child.exited).toBe(signal === "SIGTERM" ? 143 : 130);
    expect(matrixObservation(readFileSync(f.observations, "utf8"), signal === "SIGTERM" ? 143 : 130).exit).toBe(signal === "SIGTERM" ? 143 : 130);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { child.kill("SIGKILL"); }
}, 10_000);
