// #807 P3 C1: the Postgres store stands alone. db.ts (the SQLite store, which imports bun:sqlite) goes at P5, so
// nothing under store/pg/ may import it or bun:sqlite; shared pieces live in store/ (errors.ts, tx.ts).
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

test("no non-test file under src/server/store/pg/ imports bun:sqlite or the SQLite store", () => {
  const dir = import.meta.dir;
  const offenders: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.ts$/.test(e.name) || /\.test\.ts$/.test(e.name)) continue;
      const text = readFileSync(p, "utf8");
      for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
        const spec = m[1]!;
        if (spec === "bun:sqlite" || /(^|\/)db(\.ts)?$/.test(spec)) offenders.push(`${p}: ${spec}`);
      }
    }
  };
  walk(dir);
  expect(offenders).toEqual([]);
  // The scan sees this directory's modules (a scan that read nothing would pass vacuously).
  expect(readdirSync(dir).filter(f => /^(sql|errors|migrate)\.ts$/.test(f)).sort()).toEqual(["errors.ts", "migrate.ts", "sql.ts"]);
});
