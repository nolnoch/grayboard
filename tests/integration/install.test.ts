// install.sh's server upgrade path, run for real under bash with curl, systemctl and
// sleep stubbed on PATH. The stubs record what they were asked; the release "served"
// is v9.9.9, and the scenario decides what the unit looks like and what /healthz says.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../support/paths.ts";

const INSTALL = join(ROOT, "install.sh");

let dir: string;

// What the curl stub "downloads": the digest install.sh must verify against,
// or a wrong one (STUB_DIGEST=wrong) that must refuse the install (#173).
const STUB_BIN = "#!/bin/sh\necho 9.9.9\n";
const STUB_SHA = `sha256:${new Bun.CryptoHasher("sha256").update(STUB_BIN).digest("hex")}`;
const WRONG_SHA = `sha256:${"0".repeat(64)}`;
const target = `${process.platform}-${process.arch}`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grayboard-install-"));
  mkdirSync(join(dir, "stubs"));
  mkdirSync(join(dir, "bin"));
  for (const [name, digest] of [["digests", STUB_SHA], ["digests-wrong", WRONG_SHA]] as const) {
    writeFileSync(
      join(dir, `${name}.json`),
      JSON.stringify({
        tag_name: "v9.9.9",
        assets: ["grayboard", "grayboard-server"].map((bin) => ({ name: `${bin}-${target}`, digest })),
      }),
    );
  }
  writeStub("sleep", "exit 0");
  // -w: resolving "latest"; /repos/: the release API (digest lookup); -o: a binary
  // download; else the /healthz probe.
  writeStub("curl", `
args="$*"
case "$args" in
  *"-w"*) echo "https://github.com/x/grayboard/releases/tag/v9.9.9"; exit 0 ;;
  *"/repos/"*) echo "$args" >> "${dir}/api.log"; [ "$STUB_DIGEST" = "wrong" ] && f=digests-wrong.json || f=digests.json; cat "${dir}/$f"; exit 0 ;;
esac
out=""
while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done
if [ -n "$out" ]; then printf '%s' '${STUB_BIN}' > "$out"; exit 0; fi
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

type Scenario = { unit?: boolean; exec?: string; state?: string; health?: string; restartRc?: number; releasesUrl?: string; digest?: string };

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
      ...(s.digest !== undefined ? { STUB_DIGEST: s.digest } : {}),
      ...(s.releasesUrl !== undefined ? { GRAYBOARD_RELEASES_URL: s.releasesUrl } : {}),
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
  // The install verified each binary against the release API's digest first (#173).
  expect(readFileSync(join(dir, "api.log"), "utf8")).toContain("/releases/tags/v9.9.9");
});

test("a binary whose sha256 doesn't match the release's digest is refused; the old binary stays", () => {
  const r = install({ digest: "wrong" });
  expect(r.code).toBe(1);
  expect(r.err).toContain(`sha256 ${STUB_SHA.slice(7)}, but the release lists ${WRONG_SHA}`);
  // Nothing replaced: the CLI never landed, the server binary is the old one, nothing restarted.
  expect(existsSync(join(dir, "bin", "grayboard"))).toBe(false);
  expect(readFileSync(join(dir, "bin", "grayboard-server"), "utf8")).toBe("old");
  expect(restarts()).toBe(0);
});

test("a release that lists no digest for the asset is refused", () => {
  writeFileSync(join(dir, "digests.json"), JSON.stringify({ tag_name: "v9.9.9", assets: [] }));
  const r = install({});
  expect(r.code).toBe(1);
  expect(r.err).toContain("the release lists no sha256 digest; refusing to install unverified");
  expect(existsSync(join(dir, "bin", "grayboard"))).toBe(false);
  expect(restarts()).toBe(0);
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

test("GRAYBOARD_RELEASES_URL: http only to this machine, trailing slashes dropped, empty means GitHub", () => {
  const refused = install({ releasesUrl: "http://mirror.example.com" });
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("GRAYBOARD_RELEASES_URL must be https (or http to localhost): http://mirror.example.com");
  expect(existsSync(join(dir, "healthz.log"))).toBe(false);

  const local = install({ releasesUrl: "http://127.0.0.1:8080//" });
  expect(local.code).toBe(0);
  expect(local.out).toMatch(/downloading http:\/\/127\.0\.0\.1:8080\/[^/]+\/[^/]+\/releases\/download\/v9\.9\.9\//);

  const empty = install({ releasesUrl: "" });
  expect(empty.code).toBe(0);
  expect(empty.out).toContain("downloading https://github.com/");
});
