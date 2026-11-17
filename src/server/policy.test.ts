// The authorization seam is one module (#806): every allow-or-deny decision
// goes through policy.ts decide(), so the pre-seam rule helpers live there
// and nothing else under src/ calls them. Unit tests may (can_send.test.ts,
// access.test.ts exercise each rule directly).
import { expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decidePure, type PureRequest } from "./policy.ts";

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

// The synchronous loader is SQLite-only (#807 P3 A7e1): every `authorizeNow(` and `.policyNow` outside tests is a
// caller #807 A7f/B must convert to the async `authorize`, so their count only falls. A file's count may drop (lower
// its row here); a new use fails until it's argued for.
const SYNC_TWIN = /authorizeNow\(|\.policyNow\b/g;
const SYNC_TWIN_CEILING: Record<string, number> = {
  "src/server/access.ts": 15,
  "src/server/application.ts": 12,
  "src/server/http.ts": 6,
  "src/server/policy.ts": 5,
};

test("the synchronous policy loader gains no callers", () => {
  const counts: Record<string, number> = {};
  for (const file of new Glob("src/**/*.ts").scanSync({ cwd: ROOT })) {
    if (file.endsWith(".test.ts")) continue;
    const code = readFileSync(join(ROOT, file), "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    const n = code.match(SYNC_TWIN)?.length ?? 0;
    if (n) counts[file] = n;
  }
  const over = Object.entries(counts).filter(([f, n]) => n > (SYNC_TWIN_CEILING[f] ?? 0)).map(([f, n]) => `${f}: ${n} > ${SYNC_TWIN_CEILING[f] ?? 0}`);
  expect(over).toEqual([]);
});

test("decidePure refuses a verb whose rule reads storage", () => {
  const p = { kind: "user", name: "a@example.com" } as const;
  const reading = { verb: "scope.act", principal: p, scope: { scope_kind: "team", scope_ref: "eng" } } as unknown as PureRequest;
  expect(() => decidePure({}, reading)).toThrow("scope.act asked for a storage read (principalByName)");
  expect(decidePure({ admins: ["a@example.com"] }, { verb: "admin", email: "a@example.com" })).toEqual({ allow: true, rule: "admin.env" });
});
