import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLocalDb } from "./open.ts";
import { BUS_DIR_NAME, privateDir } from "./perms.ts";

const roots: string[] = [];
function root(): string {
  const r = mkdtempSync(join(tmpdir(), "gb-perms-"));
  roots.push(r);
  return r;
}
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const mode = (p: string) => statSync(p).mode & 0o777;

test("a new bus directory is 0700 and the database, -wal and -shm are 0600", () => {
  const dir = join(root(), BUS_DIR_NAME);
  const path = join(dir, "bus.db");
  const { db } = openLocalDb(path);
  try {
    db.run("CREATE TABLE IF NOT EXISTS perms_probe (x)");
    db.run("INSERT INTO perms_probe VALUES (1)");
    expect(mode(dir)).toBe(0o700);
    for (const f of [path, `${path}-wal`, `${path}-shm`]) expect([f, mode(f)]).toEqual([f, 0o600]);
  } finally { db.close(); }
});

test("an existing loose bus directory and database are tightened", () => {
  const dir = join(root(), BUS_DIR_NAME);
  mkdirSync(dir, { mode: 0o755 });
  chmodSync(dir, 0o755);
  const path = join(dir, "bus.db");
  openLocalDb(path).db.close();
  chmodSync(path, 0o644);
  chmodSync(dir, 0o755);
  const { db } = openLocalDb(path);
  db.close();
  expect(mode(dir)).toBe(0o700);
  expect(mode(path)).toBe(0o600);
});

test("an existing directory not named for the bus is left alone", () => {
  const dir = join(root(), "shared");
  mkdirSync(dir);
  chmodSync(dir, 0o755);
  privateDir(dir);
  expect(mode(dir)).toBe(0o755);
  const path = join(dir, "bus.db");
  writeFileSync(path, "");
  chmodSync(path, 0o644);
  openLocalDb(path).db.close();
  expect(mode(dir)).toBe(0o755);
  expect(mode(path)).toBe(0o600);
});
