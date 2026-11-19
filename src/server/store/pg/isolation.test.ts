// #807 P3 C1: the Postgres store stands alone. db.ts (the SQLite store) and bun:sqlite go at P5, so no module
// under store/pg/ may reach either, directly or through the relative modules it imports (store/tx.ts, for
// example, reaches bun:sqlite through core/sqlite.ts). Type-only imports are erased at build and don't count.
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SRC = resolve(import.meta.dir, "../../..");
const SQLITE_STORE = join(SRC, "server/db.ts");

// The runtime import specifiers of a module: static imports and re-exports (less `import type`/`export type`),
// side-effect imports and dynamic import().
function runtimeImports(text: string): string[] {
  const specs: string[] = [];
  for (const m of text.matchAll(/^\s*(?:import|export)\s+(type\s+)?[^;'"]*?\bfrom\s*["']([^"']+)["']/gm)) {
    if (!m[1]) specs.push(m[2]!);
  }
  for (const m of text.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) specs.push(m[1]!);
  for (const m of text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) specs.push(m[1]!);
  return specs;
}

// Every path from `roots` that reaches bun:sqlite or a `forbidden` module (by default the SQLite store), as
// "a -> b -> spec" chains.
function forbiddenReach(roots: string[], forbidden: ReadonlySet<string> = new Set([SQLITE_STORE])): string[] {
  const offenders: string[] = [];
  const seen = new Set<string>();
  const visit = (file: string, chain: string[]) => {
    if (seen.has(file)) return;
    seen.add(file);
    const here = [...chain, relative(SRC, file)];
    for (const spec of runtimeImports(readFileSync(file, "utf8"))) {
      if (spec === "bun:sqlite") { offenders.push([...here, spec].join(" -> ")); continue; }
      if (!spec.startsWith(".")) continue;
      const target = resolve(dirname(file), spec);
      const path = existsSync(target) ? target : `${target}.ts`;
      if (forbidden.has(path)) { offenders.push([...here, relative(SRC, path)].join(" -> ")); continue; }
      if (!existsSync(path)) throw new Error(`${relative(SRC, file)}: unresolved import ${spec}`);
      visit(path, here);
    }
  };
  for (const r of roots) visit(r, []);
  return offenders;
}

function pgModules(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.ts$/.test(e.name) && !/\.(test|d)\.ts$/.test(e.name)) out.push(p);
    }
  };
  walk(import.meta.dir);
  return out.sort();
}

test("no non-test module under src/server/store/pg/ reaches bun:sqlite or the SQLite store, even transitively", () => {
  const roots = pgModules();
  // The scan sees this directory's modules (a scan that read nothing would pass vacuously).
  expect(roots.map(p => relative(import.meta.dir, p))).toEqual(expect.arrayContaining(["aliases.ts", "attachment_rows.ts", "audit_row.ts", "errors.ts", "hosted_port.ts", "identity.ts", "messages.ts", "migrate.ts", "oauth.ts", "sql.ts", "tx.ts"]));
  expect(forbiddenReach(roots)).toEqual([]);
});

test("the walk follows relative imports and skips type-only ones", () => {
  // store/tx.ts reaches bun:sqlite through core/sqlite.ts: a pg module importing it at runtime must fail.
  expect(forbiddenReach([join(SRC, "server/store/tx.ts")])).toEqual(["server/store/tx.ts -> core/sqlite.ts -> bun:sqlite"]);
  // The neutral handle base a pg module may import (#807 P3 C2a): nothing at runtime.
  expect(forbiddenReach([join(SRC, "server/store/tx_base.ts")])).toEqual([]);
  // The identity groups' types and their Postgres implementation (#807 P3 C3): db.ts re-exports the types, never the
  // other way round, and pg/identity.ts reaches core/addresses.ts and request_context.ts, neither of which reaches
  // bun:sqlite.
  expect(forbiddenReach([join(SRC, "server/store/identity.ts")])).toEqual([]);
  expect(forbiddenReach([join(import.meta.dir, "identity.ts")])).toEqual([]);
  // The OAuth input rules both stores run (#807 P3 C4a): pg/oauth.ts imports them, so they reach neither.
  expect(forbiddenReach([join(SRC, "server/oauth-rules.ts")])).toEqual([]);
  // The Postgres OAuth store (#807 P3 C4b) and what it reaches beyond the rules: oauth-config.ts (the scopes) and the
  // audit row's request_context.ts.
  expect(forbiddenReach([join(SRC, "server/oauth-config.ts")])).toEqual([]);
  expect(forbiddenReach([join(import.meta.dir, "oauth.ts")])).toEqual([]);
  // The aliases and messages groups' types, and the cap refusal both stores' callers run over the aliases group
  // (#807 P3 C5a): the Postgres store and its contract runner import them.
  expect(forbiddenReach([join(SRC, "server/store/aliases.ts")])).toEqual([]);
  expect(forbiddenReach([join(SRC, "server/store/messages.ts")])).toEqual([]);
  expect(forbiddenReach([join(SRC, "server/alias_cap.ts")])).toEqual([]);
  // The cursors, write receipts, audit and Slack groups' types, and the NUL and surrogate replacement both stores' audit
  // and progress writes run (#807 P3 C67a): the Postgres stores and their contract runners import them.
  for (const m of ["cursors.ts", "write_receipts.ts", "audit.ts", "slack.ts", "json_safe.ts"]) expect(forbiddenReach([join(SRC, "server/store", m)])).toEqual([]);
  // The Postgres aliases and messages stores and the attachment rows they share with C10c (#807 P3 C5b), which restate
  // core/boards.ts's and core/attachments.ts's SQL (those take a bun:sqlite Database and go with local mode).
  for (const m of ["aliases.ts", "messages.ts", "attachment_rows.ts"]) expect(forbiddenReach([join(import.meta.dir, m)])).toEqual([]);
  expect(runtimeImports(`import type { X } from "../tx.ts";\nexport type { Y } from "../db.ts";`)).toEqual([]);
  expect(runtimeImports(`import {\n  a,\n  b,\n} from "../tx.ts";\nexport { c } from "./d.ts";\nimport "./e.ts";\nconst f = await import("../db.ts");`))
    .toEqual(["../tx.ts", "./d.ts", "./e.ts", "../db.ts"]);
});

// #807 P3 C5 decision 11: the Postgres stores restate core's board and attachment SQL. core/boards.ts and
// core/attachments.ts run statements on a bun:sqlite Database (type-only, so the walk above passes them); a pg module
// importing one at runtime, directly or through a module that re-exports it, would be calling SQLite code with a
// Postgres handle.
test("no non-test module under src/server/store/pg/ reaches core/boards.ts or core/attachments.ts at runtime, even transitively", () => {
  const core = new Set(["core/boards.ts", "core/attachments.ts"].map(p => join(SRC, p)));
  expect(forbiddenReach(pgModules(), core)).toEqual([]);
});
