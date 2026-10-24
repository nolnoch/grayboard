import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keep } from "./run_dir.ts";

let dir: string;
let sock: Server | undefined;
const saved = process.env.GRAYBOARD_E2E_RUN_DIR;

afterEach(() => {
  sock?.close();
  sock = undefined;
  if (saved === undefined) delete process.env.GRAYBOARD_E2E_RUN_DIR;
  else process.env.GRAYBOARD_E2E_RUN_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});

test("keep copies a bus dir's files and skips its socket and caches", async () => {
  dir = mkdtempSync(join(tmpdir(), "grayboard-run-dir-"));
  const bus = join(dir, "bus");
  mkdirSync(join(bus, "home", ".cache"), { recursive: true });
  writeFileSync(join(bus, "bus.db"), "db");
  writeFileSync(join(bus, "home", ".cache", "big"), "cache");
  sock = createServer();
  await new Promise<void>((r) => sock!.listen(join(bus, "sock.be"), r));
  process.env.GRAYBOARD_E2E_RUN_DIR = join(dir, "run");

  keep("bus", bus);

  expect(readFileSync(join(dir, "run", "bus", "bus.db"), "utf8")).toBe("db");
  expect(existsSync(join(dir, "run", "bus", "sock.be"))).toBe(false);
  expect(existsSync(join(dir, "run", "bus", "home", ".cache"))).toBe(false);
});
