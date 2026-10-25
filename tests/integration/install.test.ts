// install.sh's verification and server upgrade path, run for real under bash with
// curl, systemctl and sleep stubbed on PATH. The stubs record what they were asked;
// the release "served" is v9.9.9 (signed by test key a, #162), and the scenario
// decides what the unit looks like and what /healthz says. Each run uses a copy of
// install.sh whose key block lists test keys a and b.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../support/paths.ts";
import { sign, signSums, testInstallSh, testKey, type TestKey } from "../support/release_keys.ts";

let dir: string;
let INSTALL: string;

// What the curl stub "downloads": a binary reporting the tag's version.
const STUB_BIN = "#!/bin/sh\necho 9.9.9\n";
const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
const STUB_SHA = sha(STUB_BIN);
const target = `${process.platform}-${process.arch}`;
const BINS = ["grayboard", "grayboard-server"] as const;
type Bins = Partial<Record<(typeof BINS)[number], string>>;

/**
 * Publish the release the curl stub serves: `bins` as the assets; the API's
 * digests over `api` and a SHA256SUMS for `sumsTag` over `sums` (each
 * defaulting to `bins`; a bin left out isn't listed), signed by `key`.
 */
function publish(bins: Bins = { grayboard: STUB_BIN, "grayboard-server": STUB_BIN }, o: { api?: Bins; sums?: Bins; sumsTag?: string; key?: TestKey } = {}) {
  const rel = join(dir, "release");
  rmSync(rel, { recursive: true, force: true });
  mkdirSync(join(rel, "signed"), { recursive: true });
  for (const [bin, body] of Object.entries(bins)) writeFileSync(join(rel, `${bin}-${target}`), body);
  writeFileSync(
    join(dir, "digests.json"),
    // Pretty-printed, like api.github.com serves (#173: the awk parse must
    // survive GitHub's real shape, not just compact JSON).
    JSON.stringify({ tag_name: "v9.9.9", assets: Object.entries(o.api ?? bins).map(([bin, body]) => ({ name: `${bin}-${target}`, digest: `sha256:${sha(body)}` })) }, null, 2),
  );
  const files: Record<string, string> = {};
  for (const [bin, body] of Object.entries(o.sums ?? bins)) {
    files[`${bin}-${target}`] = join(rel, "signed", bin);
    writeFileSync(files[`${bin}-${target}`]!, body);
  }
  const { sums, sig } = signSums(o.sumsTag ?? "v9.9.9", files, o.key);
  writeFileSync(join(rel, "SHA256SUMS"), sums);
  writeFileSync(join(rel, "SHA256SUMS.sig"), sig);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grayboard-install-"));
  mkdirSync(join(dir, "stubs"));
  mkdirSync(join(dir, "bin"));
  INSTALL = testInstallSh(dir);
  publish();
  writeStub("sleep", "exit 0");
  // -w: resolving "latest"; /repos/: the release API (digest lookup); -o: a
  // download, served from release/ by name (absent: a 404); else the /healthz probe.
  writeStub("curl", `
args="$*"
# " -w " as its own word: the temp dir's random name can hold "-w".
case " $args " in
  *" -w "*) echo "\${STUB_LATEST:-https://github.com/x/grayboard/releases/tag/v9.9.9}"; exit 0 ;;
  *"/repos/"*) echo "$args" >> "${dir}/api.log"; cat "${dir}/digests.json"; exit 0 ;;
esac
out="" url=""
while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; url="$1"; shift; done
if [ -n "$out" ]; then echo "$url" >> "${dir}/downloads.log"; [ -f "${dir}/release/\${url##*/}" ] || exit 22; cp "${dir}/release/\${url##*/}" "$out"; exit 0; fi
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

type Scenario = { unit?: boolean; exec?: string; state?: string; health?: string; restartRc?: number; releasesUrl?: string; script?: string; path?: string; latest?: string };

function install(s: Scenario = {}) {
  const p = Bun.spawnSync(["/bin/bash", s.script ?? INSTALL], {
    env: {
      PATH: s.path ?? `${join(dir, "stubs")}:${process.env.PATH}`,
      HOME: dir,
      INSTALL_SERVER: "1",
      INSTALL_DIR: join(dir, "bin"),
      STUB_UNIT: s.unit === false ? "0" : "1",
      STUB_EXEC: s.exec ?? join(dir, "bin", "grayboard-server"),
      STUB_STATE: s.state ?? "active",
      STUB_HEALTH: s.health ?? "ok",
      STUB_RESTART_RC: String(s.restartRc ?? 0),
      ...(s.latest !== undefined ? { STUB_LATEST: s.latest } : {}),
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

// Nothing replaced: no CLI landed, the server binary is the old one, nothing restarted.
function expectUntouched(): void {
  expect(existsSync(join(dir, "bin", "grayboard"))).toBe(false);
  expect(readFileSync(join(dir, "bin", "grayboard-server"), "utf8")).toBe("old");
  expect(existsSync(join(dir, "bin", "grayboard-server.prev"))).toBe(false);
  expect(restarts()).toBe(0);
}

function expectRefused(r: ReturnType<typeof install>, why: string): void {
  expect(r.code, r.out + r.err).toBe(1);
  expect(r.err).toContain(why);
  expect(r.err).toContain("not installing");
  expectUntouched();
}

test("a release signed by either listed key installs, naming the tag and key it verified", () => {
  expect(install().out).toContain(`verified v9.9.9 (SHA256SUMS signed by key ${testKey("a").id})`);
  publish(undefined, { key: testKey("b") });
  const r = install();
  expect(r.code, r.err).toBe(0);
  expect(r.out).toContain(`verified v9.9.9 (SHA256SUMS signed by key ${testKey("b").id})`);
  // The temp dir inside INSTALL_DIR is gone.
  expect(readFileSync(join(dir, "downloads.log"), "utf8")).toContain("/releases/download/v9.9.9/SHA256SUMS.sig");
  expect(Bun.spawnSync(["ls", "-A", join(dir, "bin")]).stdout.toString().trim().split("\n").sort()).toEqual(["grayboard", "grayboard-server", "grayboard-server.prev"]);
});

test("a bad signature, or a missing SHA256SUMS or .sig, is refused", () => {
  writeFileSync(join(dir, "release", "SHA256SUMS"), readFileSync(join(dir, "release", "SHA256SUMS"), "utf8").replace(STUB_SHA, "0".repeat(64)));
  expectRefused(install(), `the signature doesn't verify against SHA256SUMS with key ${testKey("a").id}`);
  publish();
  rmSync(join(dir, "release", "SHA256SUMS.sig"));
  expectRefused(install(), "couldn't download https://github.com/nolnoch/grayboard/releases/download/v9.9.9/SHA256SUMS.sig;");
  publish();
  rmSync(join(dir, "release", "SHA256SUMS"));
  expectRefused(install(), "couldn't download https://github.com/nolnoch/grayboard/releases/download/v9.9.9/SHA256SUMS;");
  publish();
  writeFileSync(join(dir, "release", "SHA256SUMS.sig"), "nonsense\n");
  expectRefused(install(), `SHA256SUMS.sig isn't "<key id> <base64 signature>"`);
});

// The same shapes src/shared/release_verify.ts refuses (release_verify.test.ts):
// the two verifiers accept one format.
test("a .sig or SHA256SUMS in any shape but the exact one is refused, even when signed", () => {
  const sig = () => readFileSync(join(dir, "release", "SHA256SUMS.sig"), "utf8");
  const id = testKey("a").id;
  for (const bad of [sig().replace(" ", "  "), `${sig()}\n`, sig().replace("\n", "\r\n"), ` ${sig()}`]) {
    publish();
    writeFileSync(join(dir, "release", "SHA256SUMS.sig"), bad);
    expectRefused(install(), `SHA256SUMS.sig isn't "<key id> <base64 signature>"`);
  }
  publish();
  writeFileSync(join(dir, "release", "SHA256SUMS.sig"), `${id} AAAA\n`);
  expectRefused(install(), "SHA256SUMS.sig: malformed signature (3 bytes decoded)");
  const line = `${STUB_SHA}  grayboard-${target}`;
  for (const [sums, why] of [
    [`# grayboard v9.9.9\n${line}\n${line}\n`, `SHA256SUMS lists grayboard-${target} twice`],
    [`# grayboard v9.9.9\n${line.replace("  ", " ")}\n`, "SHA256SUMS has a malformed line"],
    [`# grayboard v9.9.9\n${line}\r\n`, "SHA256SUMS has a malformed line"],
    [`${line}\n`, `SHA256SUMS has no "# grayboard <tag>" first line`],
  ] as const) {
    writeFileSync(join(dir, "release", "SHA256SUMS"), sums);
    writeFileSync(join(dir, "release", "SHA256SUMS.sig"), sign(sums));
    expectRefused(install(), why);
  }
});

test("a latest release whose tag isn't vX.Y.Z is refused before anything is fetched", () => {
  const r = install({ latest: "https://github.com/x/grayboard/releases/tag/v9.9.9-..%2F" });
  expect(r.code).toBe(1);
  expect(r.err).toContain("isn't a release tag (vX.Y.Z)");
  expect(existsSync(join(dir, "downloads.log"))).toBe(false);
  expectUntouched();
});

// awk stopping early SIGPIPEs the writer; under pipefail that read as a missing digest.
test("a release API response far larger than a pipe buffer still yields the digest", () => {
  const api = JSON.parse(readFileSync(join(dir, "digests.json"), "utf8"));
  writeFileSync(join(dir, "digests.json"), JSON.stringify({ ...api, body: "x, ".repeat(200_000) }, null, 2));
  const r = install();
  expect(r.code, r.err).toBe(0);
});

test("a server binary that can't be backed up refuses before anything is replaced", () => {
  writeFileSync(join(dir, "bin", "grayboard-server.prev"), "older");
  chmodSync(join(dir, "bin", "grayboard-server.prev"), 0o444);
  const r = install();
  expect(r.code).toBe(1);
  expect(r.err).toContain("couldn't back up");
  expect(existsSync(join(dir, "bin", "grayboard"))).toBe(false);
  expect(readFileSync(join(dir, "bin", "grayboard-server"), "utf8")).toBe("old");
  expect(restarts()).toBe(0);
});

test("a key no list holds is refused, as is the test key by the real install.sh", () => {
  publish(undefined, { key: testKey("c") });
  expectRefused(install(), `SHA256SUMS.sig: unknown key id ${testKey("c").id}`);
  publish();
  expectRefused(install({ script: join(ROOT, "install.sh") }), `SHA256SUMS.sig: unknown key id ${testKey("a").id}`);
});

test("another release's SHA256SUMS and .sig served under this tag are refused", () => {
  publish(undefined, { sumsTag: "v9.9.8" });
  expectRefused(install(), "SHA256SUMS is signed for v9.9.8, not v9.9.9");
});

test("a binary SHA256SUMS doesn't list is refused, and nothing is installed (the first binary included)", () => {
  publish(undefined, { sums: { grayboard: STUB_BIN } });
  expectRefused(install(), `grayboard-server-${target}: SHA256SUMS lists no sha256`);
});

// The forged asset: a replaced binary whose API digest GitHub recomputed.
test("a binary that doesn't match SHA256SUMS is refused even when the API digest matches it", () => {
  const forged = "#!/bin/sh\necho 9.9.9 # forged\n";
  publish({ grayboard: STUB_BIN, "grayboard-server": forged }, { sums: { grayboard: STUB_BIN, "grayboard-server": STUB_BIN } });
  expectRefused(install(), `grayboard-server-${target}: sha256 ${sha(forged)}, but SHA256SUMS lists ${STUB_SHA}`);
});

test("a binary whose sha256 doesn't match the release API's digest is refused", () => {
  const other = "other";
  publish(undefined, { api: { grayboard: other, "grayboard-server": STUB_BIN } });
  expectRefused(install(), `grayboard-${target}: sha256 ${STUB_SHA}, but the release API lists sha256:${sha(other)}`);
  // The install verified each binary against the release API's digest (#173).
  expect(readFileSync(join(dir, "api.log"), "utf8")).toContain("/releases/tags/v9.9.9");
});

test("a release that lists no API digest for the asset is refused", () => {
  // Pretty-printed, like the real API: the refusal is about the missing asset,
  // not a parse quirk.
  writeFileSync(join(dir, "digests.json"), JSON.stringify({ tag_name: "v9.9.9", assets: [] }, null, 2));
  expectRefused(install(), "the release API lists no sha256 digest");
});

test("a signed CLI that doesn't report the tag is refused", () => {
  const stale = "#!/bin/sh\necho 9.9.8\n";
  publish({ grayboard: stale, "grayboard-server": STUB_BIN });
  expectRefused(install(), "the downloaded grayboard reports '9.9.8', not v9.9.9");
});

test("without openssl, install.sh refuses before downloading anything", () => {
  const r = install({ path: join(dir, "stubs") });
  expect(r.code).toBe(1);
  expect(r.err).toContain("openssl is required");
  expect(existsSync(join(dir, "downloads.log"))).toBe(false);
  expectUntouched();
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
  // curl would read "localhost:" as user info and connect to mirror.example.com.
  const userinfo = install({ releasesUrl: "http://localhost:@mirror.example.com" });
  expect(userinfo.code).toBe(1);
  expect(userinfo.err).toContain("must not carry user info");

  const local = install({ releasesUrl: "http://127.0.0.1:8080//" });
  expect(local.code).toBe(0);
  expect(local.out).toMatch(/downloading http:\/\/127\.0\.0\.1:8080\/[^/]+\/[^/]+\/releases\/download\/v9\.9\.9\//);

  const empty = install({ releasesUrl: "" });
  expect(empty.code).toBe(0);
  expect(empty.out).toContain("downloading https://github.com/");
});
