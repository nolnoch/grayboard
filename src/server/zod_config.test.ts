import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CallToolRequestSchema, CallToolResultSchema, JSONRPCMessageSchema } from "@modelcontextprotocol/core";

// #940: zod reads the memoizer when a schema is built, so zod_config.ts only takes effect if it runs before every
// other module of the server: its first import.
test("src/server/main.ts imports zod_config.ts before anything else", () => {
  const source = readFileSync(join(import.meta.dir, "main.ts"), "utf8");
  expect(source.match(/^import .*$/m)?.[0]).toBe(`import "./zod_config.ts";`);
});

const request = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "board_post", arguments: { board: "e2e", body: "hi", parent_id: 12 }, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-06-18", "io.modelcontextprotocol/clientCapabilities": { roots: {}, sampling: {} } } } };
const result = { content: [{ type: "text", text: "{}" }], structuredContent: { nested: { list: [1, "a", null, { deep: true }] } }, _meta: { m: [{ x: 1 }] } };
const bad = { content: [{ type: "text" }], isError: "yes" };

// Under the default memoizer (this process) and with it off (a child that loads zod_config.ts first), the SDK's
// schemas give the same answers on the same JSON, failures included.
test("with the memoizer off, the SDK's schemas parse JSON exactly as with it on", () => {
  const verdicts = () => [
    JSONRPCMessageSchema.safeParse(request), CallToolRequestSchema.safeParse(request),
    CallToolResultSchema.safeParse(result), CallToolResultSchema.safeParse(bad),
  ].map((r) => (r.success ? { ok: true, data: r.data } : { ok: false, issues: r.error.issues }));
  const script = `
    import ${JSON.stringify(join(import.meta.dir, "zod_config.ts"))};
    const { globalConfig, memoizer } = await import("zod/v4/core");
    const { CallToolRequestSchema, CallToolResultSchema, JSONRPCMessageSchema } = await import("@modelcontextprotocol/core");
    const [request, result, bad] = ${JSON.stringify([request, result, bad])};
    const verdicts = [JSONRPCMessageSchema.safeParse(request), CallToolRequestSchema.safeParse(request),
      CallToolResultSchema.safeParse(result), CallToolResultSchema.safeParse(bad)]
      .map((r) => (r.success ? { ok: true, data: r.data } : { ok: false, issues: r.error.issues }));
    console.log(JSON.stringify({ off: globalConfig.memoizer !== memoizer(), verdicts }));
  `;
  const child = Bun.spawnSync([process.execPath, "-e", script], { cwd: join(import.meta.dir, "../.."), stderr: "pipe" });
  expect(child.stderr.toString()).toBe("");
  const out = JSON.parse(child.stdout.toString());
  expect(out.off).toBe(true);
  expect(out.verdicts).toEqual(JSON.parse(JSON.stringify(verdicts())));
});
