// The tools a hosted adapter registers before login come from a committed
// snapshot of the server's native tools/list (#430), and the Rust SDK's
// request types are checked against stripped copies of both roles' lists
// (#929). This fails when the server's list changed without the snapshots:
// run `bun scripts/snapshot_native_tools.ts` and commit the result.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { formatNativeTools, liveToolLists, NATIVE_TOOLS_PATH, schemaTools, SDK_NATIVE_SCHEMA_PATH, SDK_SUBSCRIBER_SCHEMA_PATH } from "../../scripts/snapshot_native_tools.ts";
import { ALWAYS_LOAD, snapshotTools } from "../../adapters/hosted-core/src/proxy.ts";

test("the pre-login snapshot and the SDK schema copies match the live tools/list", async () => {
  const live = await liveToolLists();
  expect(readFileSync(NATIVE_TOOLS_PATH, "utf8")).toBe(formatNativeTools(live.native));
  expect(snapshotTools()).toEqual(live.native);
  // The alwaysLoad marker the server sets (src/server/mcp.ts) is in the snapshot.
  expect(live.native.filter(t => t._meta?.[ALWAYS_LOAD] === true).map(t => t.name)).toEqual(expect.arrayContaining(["dm_inbox", "dm_ack"]));
  expect(readFileSync(SDK_NATIVE_SCHEMA_PATH, "utf8")).toBe(formatNativeTools(schemaTools(live.native)));
  expect(readFileSync(SDK_SUBSCRIBER_SCHEMA_PATH, "utf8")).toBe(formatNativeTools(schemaTools(live.subscriber)));
  // The subscriber role's list is the delivery surface, not the agent tools.
  expect(live.subscriber.map(t => t.name)).toEqual(expect.arrayContaining(["delivery_open", "delivery_receipt", "session_end"]));
  expect(live.subscriber.map(t => t.name)).not.toContain("board_post");
});

test("the SDK copies drop description text but keep an argument named description", () => {
  const [tool] = schemaTools([{ name: "t", inputSchema: { type: "object", description: "tool text", properties: { description: { type: "string", description: "arg text" }, n: { type: "integer", description: "x" } }, required: ["description"] } }]);
  expect(tool).toEqual({ name: "t", inputSchema: { type: "object", properties: { description: { type: "string" }, n: { type: "integer" } }, required: ["description"] } });
});
