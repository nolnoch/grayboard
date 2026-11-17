import { resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "../..");
export const CLI = resolve(ROOT, "src/cli/main.ts");
// A grayboard entry command wrapper whose `mcp` refuses every request (#1142).
export const REFUSING_MCP = resolve(ROOT, "tests/support/refusing_mcp.ts");
