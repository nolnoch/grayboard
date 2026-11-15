import { expect, test } from "bun:test";
import { isLegacyRequest, PROTOCOL_VERSION_META_KEY } from "@modelcontextprotocol/server";
import { claimsModern } from "./mcp.ts";

// #940: claimsModern skips the SDK's isLegacyRequest (four strict zod parses) for bodies it can only call modern.
// Pinned against the SDK itself, so an SDK bump that changes the routing rule fails here rather than misroutes.
const claim = { [PROTOCOL_VERSION_META_KEY]: "2026-07-28" };
const post = (headers: Record<string, string> = {}) => new Request("http://x/mcp", { method: "POST", headers: { "content-type": "application/json", ...headers } });
const bodies: Array<[string, unknown]> = [
  ["modern tools/call", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: {}, _meta: { ...claim, "io.modelcontextprotocol/clientCapabilities": {} } } }],
  ["modern listen", { jsonrpc: "2.0", id: 2, method: "subscriptions/listen", params: { notifications: {}, _meta: claim } }],
  ["claim with an invalid envelope", { jsonrpc: "2.0", id: 3, method: "tools/list", params: { _meta: { [PROTOCOL_VERSION_META_KEY]: 7 } } }],
  ["claim naming an unserved revision", { jsonrpc: "2.0", id: 4, method: "tools/list", params: { _meta: { [PROTOCOL_VERSION_META_KEY]: "1999-01-01" } } }],
  ["modern notification", { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1, _meta: claim } }],
  ["claim on a malformed message", { id: 5, method: "tools/list", params: { _meta: claim } }],
  ["legacy initialize", { jsonrpc: "2.0", id: 6, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } } }],
  ["initialize with an invalid claim", { jsonrpc: "2.0", id: 7, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" }, _meta: { [PROTOCOL_VERSION_META_KEY]: 7 } } }],
  ["legacy tools/call", { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "whoami", arguments: {} } }],
  ["legacy notification", { jsonrpc: "2.0", method: "notifications/initialized" }],
  ["response", { jsonrpc: "2.0", id: 9, result: {} }],
  ["batch with a claim", [{ jsonrpc: "2.0", id: 10, method: "tools/list", params: { _meta: claim } }]],
  ["_meta not an object", { jsonrpc: "2.0", id: 11, method: "tools/list", params: { _meta: "x" } }],
];

// claimsModern reads only the body, so the SDK must say modern for a fired body whatever headers ride with it: a
// legacy client's protocol-version or session header, or an Mcp-Method that disagrees with the body's method (#952).
const headerVariants: Array<[string, Record<string, string>]> = [
  ["no headers", {}],
  ["legacy protocol header", { "Mcp-Protocol-Version": "2025-06-18" }],
  ["legacy session header", { "Mcp-Session-Id": "x" }],
  ["mismatched Mcp-Method", { "Mcp-Method": "initialize" }],
];

test("claimsModern never says modern where the SDK's isLegacyRequest says legacy, and does fire on modern traffic", async () => {
  const fired: string[] = [];
  for (const [name, body] of bodies) {
    if (!claimsModern(body)) continue;
    fired.push(name);
    for (const [variant, headers] of headerVariants) {
      expect({ name, variant, legacy: await isLegacyRequest(post(headers), body) }).toEqual({ name, variant, legacy: false });
    }
  }
  expect(fired).toEqual(["modern tools/call", "modern listen", "claim with an invalid envelope", "claim naming an unserved revision", "modern notification", "claim on a malformed message"]);
  // The bodies it leaves to the SDK include ones the SDK does route legacy, so the corpus exercises both answers.
  expect(await isLegacyRequest(post(), bodies[6]![1])).toBe(true);
  expect(await isLegacyRequest(post(), bodies[7]![1])).toBe(true);
});
