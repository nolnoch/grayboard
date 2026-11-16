// Writes adapters/hosted-core/src/native-tools.json: the server's native
// tools/list (name, description, inputSchema, _meta), which a hosted adapter
// registers before login, since every /mcp request needs a bearer (#430).
// It also writes the Rust SDK's schema copies (#929): sdk/rust/schema/
// native-tools.json and subscriber-tools.json, each tool's name and
// inputSchema with every description stripped, so an instruction-text edit
// never moves the SDK but an argument change does. The subscriber copy is the
// subscriber role's tools/list (X-Grayboard-Client: subscriber).
// It lists them from an in-process server built the way the hosted tests
// build one, over the proxy's own wires; the drift test
// (tests/integration/hosted_core_snapshot.test.ts) fails when a committed
// file differs. Run: bun scripts/snapshot_native_tools.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Tool } from "@modelcontextprotocol/client";
import { nativeTool, type NativeTool } from "../adapters/hosted-core/src/proxy.ts";
import { NativeWire, Wire, type WireOptions } from "../adapters/hosted-core/src/wire.ts";
import { GRAYBOARD_SESSION_META } from "../src/shared/session_meta.ts";
import { issueOAuth } from "../tests/helpers/oauth.ts";
import { TestServer } from "../tests/support/server.ts";

export const NATIVE_TOOLS_PATH = resolve(import.meta.dir, "../adapters/hosted-core/src/native-tools.json");
export const SDK_NATIVE_SCHEMA_PATH = resolve(import.meta.dir, "../sdk/rust/schema/native-tools.json");
export const SDK_SUBSCRIBER_SCHEMA_PATH = resolve(import.meta.dir, "../sdk/rust/schema/subscriber-tools.json");

export type ToolLists = { native: NativeTool[]; subscriber: Tool[] };
export type SchemaTool = { name: string; inputSchema: unknown };

export async function liveToolLists(): Promise<ToolLists> {
  const server = new TestServer();
  const signal = new AbortController();
  try {
    const { token } = issueOAuth(server.app.repo, server.app.oauth.resource, "you@example.com", ["grayboard:tools", "grayboard:delivery"], Date.now(), "grayboard-pi");
    const options: WireOptions = { url: `${server.base}/mcp`, sessionKey: GRAYBOARD_SESSION_META, client: { name: "grayboard-snapshot", version: "1" } };
    const auth = { token: async () => token };
    const native = new NativeWire(options, auth, signal.signal);
    const subscriber = new Wire(options, auth, signal.signal, "snapshot");
    try {
      await native.connect();
      await subscriber.connect();
      const subscriberTools: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await subscriber.client.listTools(cursor === undefined ? {} : { cursor }, subscriber.options());
        subscriberTools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      return { native: (await native.listTools()).map(nativeTool), subscriber: subscriberTools };
    } finally { await native.close(); await subscriber.close(); }
  } finally {
    signal.abort();
    await server.stop();
  }
}

export async function liveNativeTools(): Promise<NativeTool[]> { return (await liveToolLists()).native; }

// Drops every string-valued `description`. A property named `description`
// survives: its value in a `properties` map is a schema object, not a string.
function stripDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDescriptions);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([k, v]) => !(k === "description" && typeof v === "string")).map(([k, v]) => [k, stripDescriptions(v)]));
}

export const schemaTools = (tools: { name: string; inputSchema: unknown }[]): SchemaTool[] =>
  tools.map(t => ({ name: t.name, inputSchema: stripDescriptions(t.inputSchema) })).sort((a, b) => a.name.localeCompare(b.name));

export const formatNativeTools = (tools: unknown): string => `${JSON.stringify(tools, null, 2)}\n`;

if (import.meta.main) {
  const lists = await liveToolLists();
  writeFileSync(NATIVE_TOOLS_PATH, formatNativeTools(lists.native));
  mkdirSync(dirname(SDK_NATIVE_SCHEMA_PATH), { recursive: true });
  writeFileSync(SDK_NATIVE_SCHEMA_PATH, formatNativeTools(schemaTools(lists.native)));
  writeFileSync(SDK_SUBSCRIBER_SCHEMA_PATH, formatNativeTools(schemaTools(lists.subscriber)));
  console.log(`wrote ${lists.native.length} native and ${lists.subscriber.length} subscriber tools`);
}
