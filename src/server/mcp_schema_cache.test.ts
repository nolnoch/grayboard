import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { HostedMcpServer } from "./mcp.ts";

// #950: HostedMcpServer shares one JSON Schema conversion per inputSchema object across per-request servers.
const INPUT = z.strictObject({ board: z.string(), limit: z.number().optional() });
const make = <T extends McpServer>(Server: new (info: { name: string; version: string }) => T) => {
  const server = new Server({ name: "t", version: "1" });
  server.registerTool("read", { description: "r", inputSchema: INPUT }, () => ({ content: [] }));
  return server;
};

describe("HostedMcpServer.toolInputSchemaJson", () => {
  test("the SDK's private registry the override reads still exists with the fields it reads", () => {
    const tools = (make(McpServer) as unknown as { _registeredTools?: Record<string, { enabled?: unknown; inputSchema?: unknown }> })._registeredTools;
    expect(tools?.read?.enabled).toBe(true);
    expect(tools?.read?.inputSchema).toBe(INPUT);
  });

  test("a second server reuses the first server's conversion, equal to the SDK's own", () => {
    const first = make(HostedMcpServer).toolInputSchemaJson("read");
    const second = make(HostedMcpServer).toolInputSchemaJson("read");
    expect(first).toBeDefined();
    expect(second).toBe(first!);
    expect(first).toEqual(make(McpServer).toolInputSchemaJson("read")!);
    // The SDK alone converts again for each server. If this starts failing, the SDK caches by schema itself and
    // HostedMcpServer's override can be deleted.
    expect(make(McpServer).toolInputSchemaJson("read")).not.toBe(make(McpServer).toolInputSchemaJson("read"));
  });

  test("the cache is keyed by schema object, not tool name: an updated paramsSchema gets its own conversion", () => {
    const server = make(HostedMcpServer);
    const before = server.toolInputSchemaJson("read");
    const NEXT = z.strictObject({ post: z.number() });
    const tool = server.registerTool("read2", { description: "r", inputSchema: INPUT }, () => ({ content: [] }));
    expect(server.toolInputSchemaJson("read2")).toBe(before!);
    tool.update({ paramsSchema: NEXT });
    const after = server.toolInputSchemaJson("read2");
    expect(after).not.toBe(before!);
    const plain = new McpServer({ name: "t", version: "1" });
    plain.registerTool("read2", { description: "r", inputSchema: NEXT }, () => ({ content: [] }));
    expect(after).toEqual(plain.toolInputSchemaJson("read2")!);
    expect(after).not.toEqual(before!);
  });

  test("a tool with no inputSchema defers to the SDK", () => {
    const server = make(HostedMcpServer);
    server.registerTool("bare", { description: "b" }, () => ({ content: [] }));
    const plain = make(McpServer);
    plain.registerTool("bare", { description: "b" }, () => ({ content: [] }));
    expect(server.toolInputSchemaJson("bare")).toEqual(plain.toolInputSchemaJson("bare"));
  });

  test("unknown and disabled tools defer to the SDK", () => {
    const server = make(HostedMcpServer);
    expect(server.toolInputSchemaJson("missing")).toBeUndefined();
    const tool = server.registerTool("off", { description: "o", inputSchema: INPUT }, () => ({ content: [] }));
    tool.disable();
    expect(server.toolInputSchemaJson("off")).toBeUndefined();
  });
});
