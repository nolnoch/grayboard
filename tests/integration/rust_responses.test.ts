// The Rust SDK's response fixtures (sdk/rust/schema/responses/) are what a
// real server answers each native tool today. Re-recorded here, so a change to
// a tool's result (a renamed field, a text result turned JSON) fails this root
// test, with no cargo, until `bun scripts/record_rust_responses.ts` rewrites
// them and the crate's `every_recorded_response_reads` (scripts/e2e.sh
// rust-sdk) still reads each one (#929; docs/sdk-rust.md §3).
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RESPONSES_DIR, recordResponses, serialize } from "../../scripts/record_rust_responses.ts";

const SNAPSHOT = join(import.meta.dir, "../../sdk/rust/schema/native-tools.json");

test("the Rust SDK's response fixtures match what a real server answers, one per native tool", async () => {
  const recorded = await recordResponses();
  const committed = Object.fromEntries(readdirSync(RESPONSES_DIR).map((f) => [f.replace(/\.json$/, ""), readFileSync(join(RESPONSES_DIR, f), "utf8")]));
  expect(Object.fromEntries(Object.entries(recorded).map(([tool, value]) => [tool, serialize(value)]))).toEqual(committed);
  const native = (JSON.parse(readFileSync(SNAPSHOT, "utf8")) as { name: string }[]).map((t) => t.name).sort();
  expect(Object.keys(recorded).sort()).toEqual(native);
}, 30_000);
