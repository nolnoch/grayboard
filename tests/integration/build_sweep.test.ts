// scripts/build_sweep.sh: bun build --compile leaves a read-only
// .<hash>-00000000.bun-build scratch file in the cwd when the running bun
// binary is not writable (mode 555, as Homebrew installs it; oven-sh/bun#14020).
// The wrapper must sweep the scratch after success AND after failure, propagate
// the command's exit code, and leave nested directories alone.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../support/paths.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// A stand-in for bun's scratch file: hidden, named like the real one, read-only.
function scratch(dir: string): string {
  const p = join(dir, ".54d9c40a6a9ceffc-00000000.bun-build");
  writeFileSync(p, "scratch");
  chmodSync(p, 0o444);
  return p;
}

function sweep(cwd: string, cmd: string[]): Promise<number> {
  const p = Bun.spawn(["bash", join(ROOT, "scripts", "build_sweep.sh"), ...cmd], { cwd, stdout: "ignore", stderr: "ignore" });
  return p.exited;
}

test("sweeps the scratch after a successful command and keeps its output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-sweep-"));
  dirs.push(dir);
  const litter = scratch(dir);
  expect(await sweep(dir, ["sh", "-c", "echo built > out.bin"])).toBe(0);
  expect(existsSync(litter)).toBe(false);
  expect(existsSync(join(dir, "out.bin"))).toBe(true);
});

test("sweeps the scratch after a failed command and propagates the exit code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-sweep-"));
  dirs.push(dir);
  const litter = scratch(dir);
  expect(await sweep(dir, ["sh", "-c", "exit 3"])).toBe(3);
  expect(existsSync(litter)).toBe(false);
});

test("only the cwd is swept: nested scratch files are left alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-sweep-"));
  dirs.push(dir);
  const nested = join(dir, "sub");
  mkdirSync(nested);
  const litter = scratch(nested);
  expect(await sweep(dir, ["true"])).toBe(0);
  expect(existsSync(litter)).toBe(true);
});

test("the real trigger: a 555-mode bun leaves the scratch; the sweep removes it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-sweep-"));
  dirs.push(dir);
  // process.execPath under `bun test` is the running bun binary; a read-only
  // copy of it reproduces the Homebrew layout that strands the scratch file.
  const bun555 = join(dir, "bun");
  cpSync(process.execPath, bun555);
  chmodSync(bun555, 0o555);
  writeFileSync(join(dir, "mini.ts"), 'console.log("hi");\n');
  expect(await sweep(dir, [bun555, "build", "--compile", "mini.ts", "--outfile", "out"])).toBe(0);
  expect(existsSync(join(dir, "out"))).toBe(true);
  expect(readdirSync(dir).filter((f) => f.endsWith(".bun-build"))).toEqual([]);
});
