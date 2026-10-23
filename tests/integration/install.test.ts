// install.sh's server upgrade path, run for real under bash with curl, systemctl and
// sleep stubbed on PATH. The stubs record what they were asked; the release "served"
// is v9.9.9, and the scenario decides what the unit looks like and what /healthz says.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const INSTALL = resolve(import.meta.dir, "../../install.sh");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grayboard-install-"));
  mkdirSync(join(dir, "stubs"));
  mkdirSync(join(dir, "bin"));
  writeStub("sleep", "exit 0");
  // -w: resolving "latest"; -o: a binary download; else the /healthz probe.
  writeStub("curl", `
args="$*"
case "$args" in
  *"-w"*) echo "https://github.com/x/grayboard/releases/tag/v9.9.9"; exit 0 ;;
esac
out=""
while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done
if [ -n "$out" ]; then printf '#!/bin/sh\\necho 9.9.9\\n' > "$out"; exit 0; fi
echo "$args" >> "${dir}/healthz.log"
case "$STUB_HEALTH" in
  ok)    echo '{"ok":true,"version":"9.9.9"}' ;;
  stale) echo '{"ok":true,"version":"1.0.0"}' ;;
  *)     exit 7 ;;
esac`);
  writeStub("systemctl", `
case "$1 $2 $3" in
  "cat grayboard "*) [ "$STUB_UNIT" = 1 ] ;;
  "show -p ExecStart") echo "{ path=$STUB_EXEC ; argv[]=$STUB_EXEC ; ignore_errors=no }" ;;
  "show -p ActiveState") echo "$STUB_STATE" ;;
  "show -p EnvironmentFiles") echo "${dir}/env (ignore_errors=no)" ;;
  "restart grayboard "*) echo restart >> "${dir}/systemctl.log"; exit "$STUB_RESTART_RC" ;;
  *) echo "unexpected systemctl $*" >&2; exit 2 ;;
esac`);
  writeFileSync(join(dir, "env"), "GRAYBOARD_DB_PATH=/x\nGRAYBOARD_HTTP_PORT=9123\n");
  writeFileSync(join(dir, "bin", "grayboard-server"), "old");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeStub(name: string, body: string) {
  const p = join(dir, "stubs", name);
  writeFileSync(p, `#!/bin/bash\n${body}\n`);
  chmodSync(p, 0o755);
}

type Scenario = { unit?: boolean; exec?: string; state?: string; health?: string; restartRc?: number };

function install(s: Scenario) {
  const p = Bun.spawnSync(["bash", INSTALL], {
    env: {
      PATH: `${join(dir, "stubs")}:${process.env.PATH}`,
      HOME: dir,
      INSTALL_SERVER: "1",
      INSTALL_DIR: join(dir, "bin"),
      STUB_UNIT: s.unit === false ? "0" : "1",
      STUB_EXEC: s.exec ?? join(dir, "bin", "grayboard-server"),
      STUB_STATE: s.state ?? "active",
      STUB_HEALTH: s.health ?? "ok",
      STUB_RESTART_RC: String(s.restartRc ?? 0),
    },
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

const restarts = () => (existsSync(join(dir, "systemctl.log")) ? readFileSync(join(dir, "systemctl.log"), "utf8").trim().split("\n").length : 0);

test("an upgrade restarts the unit and waits for /healthz on the env file's port to report the tag", () => {
  const r = install({});
  expect(r.code).toBe(0);
  expect(r.out).toContain("installing v9.9.9");
  expect(r.out).toContain("/healthz reports 9.9.9");
  expect(restarts()).toBe(1);
  expect(readFileSync(join(dir, "healthz.log"), "utf8")).toContain("http://127.0.0.1:9123/healthz");
  expect(readFileSync(join(dir, "bin", "grayboard-server.prev"), "utf8")).toBe("old");
});

test("a server still reporting the old version fails the install with a rollback", () => {
  const r = install({ health: "stale" });
  expect(r.code).toBe(1);
  expect(r.err).toContain("reports '1.0.0', not 9.9.9");
  expect(r.err).toContain(`Roll back: cp -p ${join(dir, "bin", "grayboard-server.prev")}`);
});

test("a server that never answers fails the install", () => {
  const r = install({ health: "down" });
  expect(r.code).toBe(1);
  expect(r.err).toContain("reports 'no answer', not 9.9.9");
});

test("a failed systemctl restart is reported as such", () => {
  const r = install({ restartRc: 1 });
  expect(r.code).toBe(1);
  expect(r.err).toContain("systemctl restart failed");
});

test("a crash-looping (failed) unit is restarted and checked", () => {
  const r = install({ state: "failed" });
  expect(r.code).toBe(0);
  expect(restarts()).toBe(1);
});

test("a stopped unit isn't started", () => {
  const r = install({ state: "inactive" });
  expect(r.code).toBe(0);
  expect(r.out).toContain("The grayboard unit is stopped");
  expect(restarts()).toBe(0);
});

test("a unit running a different binary isn't restarted", () => {
  const r = install({ exec: "/usr/local/bin/grayboard-server" });
  expect(r.code).toBe(0);
  expect(r.out).toContain("not restarted");
  expect(restarts()).toBe(0);
});

test("with no unit, the installer gives first-install steps and restarts nothing", () => {
  const r = install({ unit: false });
  expect(r.code).toBe(0);
  expect(r.out).toContain("no grayboard systemd unit found");
  expect(restarts()).toBe(0);
});
