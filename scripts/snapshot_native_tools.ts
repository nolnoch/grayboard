// Writes adapters/hosted-core/src/native-tools.json: the server's native
// tools/list (name, description, inputSchema, _meta), which a hosted adapter
// registers before login, since every /mcp request needs a bearer (#430).
// It lists them from an in-process server built the way the hosted tests
// build one, over the proxy's own NativeWire; the drift test
// (tests/integration/hosted_core_snapshot.test.ts) fails when the committed
// file differs. Run: bun scripts/snapshot_native_tools.ts
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { nativeTool, type NativeTool } from "../adapters/hosted-core/src/proxy.ts";
import { NativeWire } from "../adapters/hosted-core/src/wire.ts";
import { GRAYBOARD_SESSION_META } from "../src/server/oauth-config.ts";
import { issueOAuth } from "../tests/helpers/oauth.ts";
import { TestServer } from "../tests/support/server.ts";

export const NATIVE_TOOLS_PATH = resolve(import.meta.dir, "../adapters/hosted-core/src/native-tools.json");

export async function liveNativeTools(): Promise<NativeTool[]> {
  const server = new TestServer();
  const signal = new AbortController();
  try {
    const { token } = issueOAuth(server.app.repo, server.app.oauth.resource, "you@example.com", ["grayboard:tools", "grayboard:delivery"], Date.now(), "grayboard-pi");
    const wire = new NativeWire({ url: `${server.base}/mcp`, sessionKey: GRAYBOARD_SESSION_META, client: { name: "grayboard-snapshot", version: "1" } }, { token: async () => token }, signal.signal);
    try {
      await wire.connect();
      return (await wire.listTools()).map(nativeTool);
    } finally { await wire.close(); }
  } finally {
    signal.abort();
    await server.stop();
  }
}

export const formatNativeTools = (tools: NativeTool[]): string => `${JSON.stringify(tools, null, 2)}\n`;

if (import.meta.main) {
  const tools = await liveNativeTools();
  writeFileSync(NATIVE_TOOLS_PATH, formatNativeTools(tools));
  console.log(`wrote ${tools.length} tools to ${NATIVE_TOOLS_PATH}`);
}
