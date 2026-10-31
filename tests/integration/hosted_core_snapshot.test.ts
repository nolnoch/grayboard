// The tools a hosted adapter registers before login come from a committed
// snapshot of the server's native tools/list (#430). This fails when the
// server's list changed without the snapshot: run
// `bun scripts/snapshot_native_tools.ts` and commit the result.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { formatNativeTools, liveNativeTools, NATIVE_TOOLS_PATH } from "../../scripts/snapshot_native_tools.ts";
import { ALWAYS_LOAD, snapshotTools } from "../../adapters/hosted-core/src/proxy.ts";

test("the pre-login snapshot matches the live native tools/list", async () => {
  const live = await liveNativeTools();
  expect(readFileSync(NATIVE_TOOLS_PATH, "utf8")).toBe(formatNativeTools(live));
  expect(snapshotTools()).toEqual(live);
  // The alwaysLoad marker the server sets (src/server/mcp.ts) is in the snapshot.
  expect(live.filter(t => t._meta?.[ALWAYS_LOAD] === true).map(t => t.name)).toEqual(expect.arrayContaining(["dm_inbox", "dm_ack"]));
});
