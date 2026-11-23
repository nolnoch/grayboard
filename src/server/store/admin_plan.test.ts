// #1651 D6: every admin read on SQLite is one index range scan that sorts nothing. EXPLAIN QUERY PLAN on a server
// database as openDatabase leaves it: no full-table SCAN of the read's table (a SEARCH on an index, or the primary key)
// and no TEMP B-TREE (a sort the index should have made unnecessary). The thread walk's recursive CTE scans its own
// queue and sorts the walk's rows, bounded by the thread: those lines are its plan, not a table scan.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, USER_SQL_FOR_TESTS } from "../db.ts";
import { scratchDbPath } from "../../../tests/support/scratch_db.ts";
import { ADMIN_SQL } from "./admin_sqlite.ts";
import { sqliteOf } from "./tx.ts";

const plan = (sql: string) => {
  const { repo } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  try {
    const n = (sql.match(/\?/g) ?? []).length;
    return sqliteOf(repo.read).query<{ detail: string }, (number | string)[]>(`EXPLAIN QUERY PLAN ${sql}`).all(...Array(n).fill(1)).map(r => r.detail);
  } finally { void repo.close(); }
};

const statements: [string, string][] = [
  ...Object.entries(ADMIN_SQL).filter(([k]) => k !== "thread"),
  ["users", `${USER_SQL_FOR_TESTS} WHERE u.id > ? ORDER BY u.id LIMIT ?`],
];

for (const [name, sql] of statements) {
  test(`${name}: an index range, no table scan, no sort`, () => {
    const lines = plan(sql);
    expect(lines.filter(l => /^SCAN /.test(l) && !/^SCAN CONSTANT ROW/.test(l))).toEqual([]);
    expect(lines.filter(l => l.includes("TEMP B-TREE"))).toEqual([]);
    expect(lines.some(l => /^SEARCH /.test(l))).toBe(true);
  });
}

test("thread: the walk searches posts by id and by parent, never scans posts", () => {
  const lines = plan(ADMIN_SQL.thread);
  expect(lines.filter(l => /SCAN p\b|SCAN posts\b/.test(l))).toEqual([]);
  expect(lines.some(l => l.includes("idx_posts_parent"))).toBe(true);
});
