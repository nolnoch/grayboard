import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";


// #940: zod reads the memoizer when a schema is built, so zod_config.ts only takes effect if it runs before every
// other module of the server: its first import.
test("src/server/main.ts imports zod_config.ts before anything else", () => {
  const source = readFileSync(join(import.meta.dir, "main.ts"), "utf8");
  expect(source.match(/^import .*$/m)?.[0]).toBe(`import "./zod_config.ts";`);
});

const request = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "board_post", arguments: { board: "e2e", body: "hi", parent_id: 12 }, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-06-18", "io.modelcontextprotocol/clientCapabilities": { roots: {}, sampling: {} } } } };
const result = { content: [{ type: "text", text: "{}" }], structuredContent: { nested: { list: [1, "a", null, { deep: true }] } }, _meta: { m: [{ x: 1 }] } };
const bad = { content: [{ type: "text" }], isError: "yes" };

// Under the default memoizer and with it off (zod_config.ts loaded first), the SDK's schemas give the same answers on
// the same JSON, failures included. Each half runs in its own child: zod keeps its config on globalThis, shared by every
// zod copy a process loads (root, hosted-core's, opencode-v2's), so in this process the installed memoizer depends on
// which test files ran first (#992).
test("with the memoizer off, the SDK's schemas parse JSON exactly as with it on", () => {
  const run = (off: boolean) => {
    const script = `
      ${off ? `import ${JSON.stringify(join(import.meta.dir, "zod_config.ts"))};` : ""}
      const { globalConfig, memoizer } = await import("zod/v4/core");
      const { CallToolRequestSchema, CallToolResultSchema, JSONRPCMessageSchema } = await import("@modelcontextprotocol/core");
      const [request, result, bad] = ${JSON.stringify([request, result, bad])};
      const verdicts = [JSONRPCMessageSchema.safeParse(request), CallToolRequestSchema.safeParse(request),
        CallToolResultSchema.safeParse(result), CallToolResultSchema.safeParse(bad)]
        .map((r) => (r.success ? { ok: true, data: r.data } : { ok: false, issues: r.error.issues }));
      console.log(JSON.stringify({ zodDefault: globalConfig.memoizer === memoizer(), verdicts }));
    `;
    const child = Bun.spawnSync([process.execPath, "-e", script], { cwd: join(import.meta.dir, "../.."), stderr: "pipe", timeout: 20_000 });
    expect(child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
    return JSON.parse(child.stdout.toString()) as { zodDefault: boolean; verdicts: unknown[] };
  };
  const on = run(false), off = run(true);
  expect([on.zodDefault, off.zodDefault]).toEqual([true, false]);
  expect(off.verdicts).toEqual(on.verdicts);
  expect(on.verdicts.map((v) => (v as { ok: boolean }).ok)).toEqual([true, true, true, false]);
});
