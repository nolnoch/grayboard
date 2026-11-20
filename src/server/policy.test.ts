// The authorization seam is one module (#806): every allow-or-deny decision
// goes through policy.ts decide(), so the pre-seam rule helpers live there
// and nothing else under src/ calls them.
import { expect, test } from "bun:test";
import { Glob } from "bun";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decidePure, recordDecision, type PureRequest } from "./policy.ts";
import { openDatabase } from "./db.ts";
import { scratchDbPath } from "../../tests/support/scratch_db.ts";

const ROOT = join(import.meta.dir, "..", "..");
const HELPERS = /\b(canSend|mayActIn|canAdmin|reachesHuman|canReadAttachment|attachmentReach)\b/;

test("no source file outside policy.ts calls a pre-seam rule helper", () => {
  const offenders: string[] = [];
  for (const file of new Glob("src/**/*.ts").scanSync({ cwd: ROOT })) {
    // Core defines the attachment rule; local mode calls it directly; the server's one caller builds its request.
    if (file.endsWith(".test.ts") || ["src/server/policy.ts", "src/core/attachments.ts", "src/local/mcp.ts", "src/server/attachments.ts"].includes(file)) continue;
    const text = readFileSync(join(ROOT, file), "utf8");
    text.split("\n").forEach((line, i) => { if (HELPERS.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`); });
  }
  expect(offenders).toEqual([]);
});

// The synchronous loader is gone (#807 P3 C10d2-a deleted authorizeNow, policyNow and the server's synchronous core
// Access): nothing outside policy.ts may name either, nor drive `decide(` by hand. policy.ts's three are authorize's
// driver, decidePure's and decide itself. tests/support/sync_access.ts keeps a synchronous oracle for the parity tests.
const SYNC_TWIN = /\bauthorizeNow\b|\bpolicyNow\b|\bdecide\(/g;
const SYNC_TWIN_CEILING: Record<string, number> = {
  "src/server/policy.ts": 3,
};

test("no synchronous policy loader comes back", () => {
  const counts: Record<string, number> = {};
  for (const file of new Glob("src/**/*.ts").scanSync({ cwd: ROOT })) {
    if (file.endsWith(".test.ts")) continue;
    const code = readFileSync(join(ROOT, file), "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    const n = code.match(SYNC_TWIN)?.length ?? 0;
    if (n) counts[file] = n;
  }
  expect(counts).toEqual(SYNC_TWIN_CEILING);
});

// The synchronous access oracle (tests/support/sync_access.ts) is the parity tests' alone: no production module loads it.
test("only tests import the synchronous access oracle", () => {
  const importers: string[] = [];
  for (const file of new Glob("src/**/*.ts").scanSync({ cwd: ROOT })) {
    if (file.endsWith(".test.ts")) continue;
    if (/sync_access(\.ts)?["']/.test(readFileSync(join(ROOT, file), "utf8"))) importers.push(file);
  }
  expect(importers).toEqual([]);
});

test("decidePure refuses a verb whose rule reads storage", () => {
  const p = { kind: "user", name: "a@example.com" } as const;
  const reading = { verb: "scope.act", principal: p, scope: { scope_kind: "team", scope_ref: "eng" } } as unknown as PureRequest;
  expect(() => decidePure({}, reading)).toThrow("scope.act asked for a storage read (principalByName)");
  // admin reads the caller's org_admin binding once the env list doesn't decide (#927): it isn't pure.
  const admin = { verb: "admin", user: { id: 1, email: "a@example.com", kind: "user" } } as unknown as PureRequest;
  expect(decidePure({ admins: ["a@example.com"] }, admin)).toEqual({ allow: true, rule: "admin.env" });
  expect(() => decidePure({}, admin)).toThrow("admin asked for a storage read (roleBinding)");
});

// recordDecision stays synchronous (#807 P3 A7f1): its deny limiter points the audit writer at the caller's handle
// (`suppressedOn`) for the duration of one call, so an await inside it would leave that pointer set for whatever
// runs meanwhile. Callers await their decision first, then record it.
test("recordDecision returns nothing, not a promise", async () => {
  const blobDir = mkdtempSync(join(tmpdir(), "gb-blobs-"));
  const { repo, db } = openDatabase(scratchDbPath(), { blobDir });
  try {
    const req: PureRequest = { verb: "session.act", user: "a@example.com", session: "id:1", row: undefined };
    const results = await repo.write(async tx => [
      recordDecision(repo, tx, { user: "a@example.com" }, req, decidePure({}, req)),
      recordDecision(repo, tx, { user: "a@example.com" }, req, decidePure({}, { ...req, row: { principal: "a@example.com", viewer: false, ended_at: null } })),
    ]);
    expect(results).toEqual([undefined, undefined]);
  } finally {
    db.close();
    rmSync(blobDir, { recursive: true, force: true });
  }
});
