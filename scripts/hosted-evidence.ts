import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const suites = ["strict", "git", "config", "public", "host", "live", "matrix", "native", "durable"];
const hex = (value: unknown, length: number): value is string => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const root = resolve(import.meta.dir, "..");

export function junit(raw: string | undefined, failed: boolean): string {
  let tests = 1, failures = failed ? 1 : 0, skipped = 0;
  if (raw !== undefined) {
    const tag = /^\s*(?:<\?xml[^?]*\?>\s*)?<testsuites\b([^>]*)>/.exec(raw);
    if (!tag || !raw.trimEnd().endsWith("</testsuites>")) throw new Error("Invalid JUnit");
    const count = (key: string) => {
      const value = new RegExp(`\\b${key}="([0-9]{1,6})"`).exec(tag[1]!)?.[1];
      if (value === undefined || Number(value) > 10000) throw new Error("Invalid JUnit count");
      return Number(value);
    };
    tests = count("tests"); failures = count("failures"); skipped = count("skipped");
    if (failures + skipped > tests) throw new Error("Invalid JUnit totals");
    if (failed && failures === 0) { tests++; failures++; }
  }
  // Names, messages, paths, excerpts and expected/received values are never copied.
  const cases = Array.from({ length: tests }, (_, i) => `<testcase name="case-${i + 1}">${i < failures ? '<failure message="Private diagnostics withheld"/>' : i < failures + skipped ? "<skipped/>" : ""}</testcase>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="${tests}" failures="${failures}" skipped="${skipped}"><testsuite name="hosted-gate" tests="${tests}" failures="${failures}" skipped="${skipped}">\n${cases}\n</testsuite></testsuites>\n`;
}

export function provenance(value: any, checkout = root) {
  if (value?.bun !== "1.4.4" || typeof value.installed !== "boolean" || typeof value.publicInstalled !== "boolean") throw new Error("Invalid provenance");
  const tracked = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: checkout });
  if (tracked.exitCode) throw new Error("Cannot enumerate public paths");
  const paths = new Set(tracked.stdout.toString().split("\0"));
  const entries = (items: any, compare: boolean) => {
    if (!Array.isArray(items)) throw new Error("Invalid provenance entries");
    return items.map((entry: any) => {
      const path = compare ? "adapters/opencode-v2/" + entry?.path : entry?.path;
      if (!paths.has(path) || !hex(entry?.sha256, 64) || (compare && !hex(entry?.expected, 64))) throw new Error("Invalid provenance entry");
      return compare ? { path: entry.path, sha256: entry.sha256, expected: entry.expected } : { path: entry.path, sha256: entry.sha256 };
    });
  };
  const installedChecks = entries(value.installedChecks, true), publicChecks = entries(value.publicChecks, true);
  const mismatches = [...installedChecks, ...publicChecks].filter(e => e.sha256 !== e.expected);
  return { bun: "1.4.4", installed: value.installed, publicInstalled: value.publicInstalled, installedChecks, publicChecks, mismatches, backend: entries(value.backend, false), drivers: entries(value.drivers, false) };
}

async function main() {
  const [suite, destination] = process.argv.slice(2);
  if (!suite || !suites.includes(suite) || !destination) throw new Error("Invalid invocation");
  const output = resolve(destination, "evidence");
  if (existsSync(output)) throw new Error("Evidence destination occupied");
  const privateRoot = mkdtempSync(join(tmpdir(), "grayboard-evidence-"));
  const raw = join(privateRoot, "raw"), safe = join(privateRoot, "safe");
  mkdirSync(raw, { mode: 0o700 });
  const log = Bun.file(join(privateRoot, "diagnostics.log"));
  const child = Bun.spawn(["bash", join(root, "scripts/hosted-e2e.sh"), suite], { cwd: root, env: { ...process.env, GRAYBOARD_E2E_RUN_DIR: raw, GRAYBOARD_EVIDENCE_PRIVATE: "1" }, stdout: log, stderr: log });
  const runtimeExit = await child.exited;
  mkdirSync(safe, { mode: 0o700 });
  let exit = runtimeExit, processed = false;
  let xml = junit(undefined, true);
  try {
    const data = provenance(JSON.parse(readFileSync(join(raw, "provenance.json"), "utf8")));
    if (data.mismatches.length) exit = 1;
    if (suite === "strict" && runtimeExit === 0 && !existsSync(join(raw, "unit.xml"))) throw new Error("Missing JUnit");
    xml = junit(existsSync(join(raw, "unit.xml")) ? readFileSync(join(raw, "unit.xml"), "utf8") : undefined, exit !== 0);
    if (/failures="[1-9]/.test(xml)) exit = 1;
    const revision = readFileSync(join(raw, "source-revision"), "utf8").trim();
    if (!hex(revision, 40)) throw new Error("Invalid revision");
    writeFileSync(join(safe, "provenance.json"), JSON.stringify(data, null, 2) + "\n");
    writeFileSync(join(safe, "source-revision"), revision + "\n");
    writeFileSync(join(safe, "source-status"), readFileSync(join(raw, "source-status"), "utf8").length ? "modified\n" : "clean\n");
    processed = true;
  } catch {
    exit = 1;
    xml = junit(undefined, true);
  }
  const summary = { suite, runtimeExit, exit, evidenceProcessed: processed, diagnostics: "withheld; private TMPDIR/grayboard-evidence-* only" };
  writeFileSync(join(safe, "unit.xml"), xml);
  writeFileSync(join(safe, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  writeFileSync(join(safe, "hosted.log"), `Hosted ${suite}: ${exit === 0 ? "passed" : "failed"}; raw diagnostics withheld\n`);
  writeFileSync(join(safe, "exit"), `exit=${exit}\n`);
  writeFileSync(join(safe, "result"), exit === 0 ? "passed\n" : "failed\n");
  mkdirSync(resolve(destination), { recursive: true });
  renameSync(safe, output);
  console.log(`Hosted ${suite}: ${exit === 0 ? "passed" : "failed"}; private diagnostics withheld`);
  process.exitCode = exit === 0 ? 0 : 1;
}

if (import.meta.main) {
  try { await main(); } catch { console.error("Hosted evidence failed; private diagnostics withheld"); process.exitCode = 1; }
}
