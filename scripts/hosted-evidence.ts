import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const suites = ["strict", "git", "config", "public", "host", "live", "matrix", "native", "durable"];
const hex = (value: unknown, length: number): value is string => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const root = resolve(import.meta.dir, "..");

type Counts = { tests: number; failures: number; skipped: number };
type Element = { name: string; attributes: Map<string, string>; counts: Counts; outcomes: number };

// Bounded Bun JUnit subset, not a general XML parser: no DTD, PI, CDATA or namespaces.
function junitCounts(raw: string): Counts {
  const invalid: () => never = () => { throw new Error("Unsupported or invalid JUnit"); };
  if (raw.length > 8 * 1024 * 1024) invalid();
  const validCodePoint = (n: number) => n === 9 || n === 10 || n === 13 || (n >= 32 && n <= 0xd7ff) || (n >= 0xe000 && n <= 0xfffd) || (n >= 0x10000 && n <= 0x10ffff);
  const entityPattern = /&(?:amp|lt|gt|apos|quot|#([0-9]{1,8})|#x([a-fA-F0-9]{1,6}));/y;
  const text = (value: string) => {
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff\p{Surrogate}]/u.test(value) || value.includes("]]>")) invalid();
    for (let i = value.indexOf("&"); i !== -1; i = value.indexOf("&", i)) {
      entityPattern.lastIndex = i;
      const entity = entityPattern.exec(value);
      if (!entity) invalid();
      if (entity[1] !== undefined && !validCodePoint(Number(entity[1]))) invalid();
      if (entity[2] !== undefined && !validCodePoint(parseInt(entity[2], 16))) invalid();
      i += entity[0].length;
    }
  };
  let offset = raw.startsWith("\ufeff") ? 1 : 0, nodes = 0;
  const whitespace = () => { while (/[\t\r\n ]/.test(raw[offset] ?? "!")) offset++; };
  const namePattern = /[A-Za-z_][A-Za-z0-9_.-]*/y;
  const name = () => { namePattern.lastIndex = offset; const match = namePattern.exec(raw); if (!match) invalid(); offset = namePattern.lastIndex; return match[0]; };
  if (raw.startsWith("<?xml", offset)) {
    const declaration = /^<\?xml version=(?:"1\.0"|'1\.0')(?: encoding=(?:"UTF-8"|'UTF-8'))?\?>/.exec(raw.slice(offset));
    if (!declaration) invalid();
    offset += declaration[0].length;
  }
  const stack: Element[] = [];
  let result: Counts | undefined;
  const allowed: Record<string, string[]> = { testsuites: ["testsuite"], testsuite: ["testcase", "system-out", "system-err"], testcase: ["failure", "skipped", "system-out", "system-err"], failure: [], skipped: [], "system-out": [], "system-err": [] };
  const close = () => {
    const node = stack.pop(); if (!node) invalid();
    if (node.name === "testcase") node.counts.tests = 1;
    for (const key of ["tests", "failures", "errors", "skipped"] as const) {
      const value = node.attributes.get(key);
      if (value === undefined) { if (node.name === "testsuites" && key !== "errors") invalid(); continue; }
      if (!/^[0-9]{1,6}$/.test(value) || Number(value) > 10000 || Number(value) !== (key === "errors" ? 0 : node.counts[key])) invalid();
    }
    const parent = stack.at(-1);
    if (!parent) { if (result) invalid(); result = node.counts; return; }
    if (node.name === "failure" || node.name === "skipped") {
      if (++parent.outcomes > 1) invalid();
      parent.counts[node.name === "failure" ? "failures" : "skipped"]++;
    } else {
      for (const key of ["tests", "failures", "skipped"] as const) { parent.counts[key] += node.counts[key]; if (parent.counts[key] > 10000) invalid(); }
    }
  };
  while (offset < raw.length) {
    if (raw[offset] !== "<") {
      const end = raw.indexOf("<", offset), value = raw.slice(offset, end === -1 ? raw.length : end);
      text(value);
      if ((!stack.length || ["testsuites", "testsuite", "testcase"].includes(stack.at(-1)!.name)) && !/^[\t\r\n ]*$/.test(value)) invalid();
      offset += value.length; continue;
    }
    offset++;
    if (raw[offset] === "/") {
      offset++; const closing = name(); whitespace();
      if (raw[offset++] !== ">" || stack.at(-1)?.name !== closing) invalid();
      close(); continue;
    }
    const opening = name(), parent = stack.at(-1);
    if (++nodes > 50000 || stack.length >= 4 || (parent ? !allowed[parent.name]?.includes(opening) : opening !== "testsuites" || result !== undefined)) invalid();
    const attributes = new Map<string, string>();
    while (true) {
      const before = offset; whitespace();
      if (raw[offset] === ">" || raw.startsWith("/>", offset)) break;
      if (before === offset || attributes.size >= 64) invalid();
      const key = name(); if (attributes.has(key) || key === "xmlns") invalid();
      whitespace(); if (raw[offset++] !== "=") invalid(); whitespace();
      const quote = raw[offset++]; if (quote !== '"' && quote !== "'") invalid();
      const end = raw.indexOf(quote, offset); if (end === -1) invalid();
      const value = raw.slice(offset, end); if (value.includes("<")) invalid(); text(value);
      attributes.set(key, value); offset = end + 1;
    }
    stack.push({ name: opening, attributes, counts: { tests: 0, failures: 0, skipped: 0 }, outcomes: 0 });
    if (raw.startsWith("/>", offset)) { offset += 2; close(); } else offset++;
  }
  if (stack.length || !result) invalid();
  return result;
}

export function junit(raw: string | undefined, failed: boolean): string {
  let { tests, failures, skipped } = raw === undefined ? { tests: 1, failures: failed ? 1 : 0, skipped: 0 } : junitCounts(raw);
  if (failed && failures === 0) { tests++; failures++; }
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

function readJUnit(path: string): string {
  const maximum = 8 * 1024 * 1024, bytes = Buffer.alloc(maximum + 1), fd = openSync(path, "r");
  let length = 0;
  try {
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
  } finally { closeSync(fd); }
  if (length > maximum) throw new Error("JUnit input limit exceeded");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
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
    xml = junit(existsSync(join(raw, "unit.xml")) ? readJUnit(join(raw, "unit.xml")) : undefined, exit !== 0);
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
