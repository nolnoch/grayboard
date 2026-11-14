import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { journalModeWarning, openSqlite } from "./sqlite.ts";

let dir = "";
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

// What openSqlite printed on stderr while opening `path` with `pragmas` (#178).
function opened(path: string, pragmas: string): string[] {
  const spy = spyOn(console, "error").mockImplementation(() => {});
  try { openSqlite(path, pragmas, () => {}).close(); return spy.mock.calls.map((c) => String(c[0])); }
  finally { spy.mockRestore(); }
}

test("an open that gets the WAL it asked for says nothing", () => {
  dir = mkdtempSync(join(tmpdir(), "gb-sqlite-"));
  expect(opened(join(dir, "a.db"), "PRAGMA journal_mode = WAL;")).toEqual([]);
  expect(opened(":memory:", "PRAGMA journal_mode = WAL;")).toEqual([]);
});

test("an open left in another journal mode names the file and both modes", () => {
  dir = mkdtempSync(join(tmpdir(), "gb-sqlite-"));
  const path = join(dir, "a.db");
  // The second pragma stands in for SQLite refusing the switch: the first is what was asked for.
  const lines = opened(path, "PRAGMA journal_mode = WAL; PRAGMA journal_mode = DELETE;");
  expect(lines).toEqual([`[grayboard] ${path} is in journal_mode delete, not wal: SQLite couldn't switch it (a filesystem without shared-memory locking, such as a network mount, can't use WAL)`]);
});

test("journalModeWarning: no journal_mode asked, in-memory and temporary databases, and case", () => {
  expect(journalModeWarning("/x.db", "PRAGMA synchronous = NORMAL;", "delete")).toBeUndefined();
  expect(journalModeWarning(":memory:", "PRAGMA journal_mode = WAL;", "memory")).toBeUndefined();
  expect(journalModeWarning("", "PRAGMA journal_mode = WAL;", "memory")).toBeUndefined();
  expect(journalModeWarning("/x.db", "pragma JOURNAL_MODE=wal", "WAL")).toBeUndefined();
  expect(journalModeWarning("/x.db", "PRAGMA journal_mode = WAL;", undefined)).toContain("journal_mode unknown, not wal");
});
