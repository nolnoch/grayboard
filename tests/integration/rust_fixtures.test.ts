// The Rust SDK's wire fixture (sdk/rust/schema/wire/requests.json) is what
// hosted-core's reference client sends today. Re-recorded here, so a change to
// the envelope (an MCP SDK bump, a new header or _meta key) fails this root
// test, with no cargo, until `bun scripts/record_rust_fixtures.ts` rewrites it
// and the Rust tests (scripts/e2e.sh rust-sdk) agree with it (#929 R1).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { FIXTURE_PATH, recordWire, serialize } from "../../scripts/record_rust_fixtures.ts";

test("the Rust SDK's wire fixture matches what the reference client sends", async () => {
  expect(readFileSync(FIXTURE_PATH, "utf8")).toBe(serialize(await recordWire()));
}, 30_000);
