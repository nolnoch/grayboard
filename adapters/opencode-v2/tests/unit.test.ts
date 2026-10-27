import { expect, test } from "bun:test";
import type { Context } from "@opencode/plugin/promise/plugin";
import { Controller } from "../src/controller.js";
import { Wire, SubscriberError, LeaseUnavailable, subscriberError } from "../src/wire.js";
import { METADATA, admitPrefix, enrollmentHash, identityOf, itemsOf, leaseOf, render, stableID, type Enrollment } from "../src/model.js";
test("typed unknown-name suggestions are bounded validated account names, not arbitrary error data", () => {
  expect(subscriberError({ code: "identity_unknown", known: ["be", "fe", "be"] }, false).known).toEqual(["be", "fe"]);
  expect(subscriberError({ code: "identity_unknown", known: ["_task", "-task", ...Array(254).fill("be")] }, false).known).toEqual(["_task", "-task", "be"]);
  for (const known of [["secret\nstack"], ["https://token.example.com"], Array(257).fill("be"), [42], "secret"]) {
    const error = subscriberError({ code: "identity_unknown", known }, false);
    expect(error.known).toBeUndefined();
    expect(error.message).toBe("Subscriber refused (identity_unknown)");
  }
  expect(subscriberError({ code: "bad_request", known: ["be"] }, false).known).toBeUndefined();
  expect(subscriberError({ code: "receipt_capacity" }, true).code).toBe("receipt_capacity");
});
export const enrollment: Enrollment = { version: 2, sessionID: "ses_root", mcpName: "grayboard", configuration: { type: "remote", url: "https://grayboard.example.com/mcp", issuer: "https://grayboard.example.com", clientID: "opencode", scope: "grayboard:delivery grayboard:tools", configHash: "config" }, integrationID: "native", connectionID: "selected", name: "be" };
export const identity = { user: { email: "you@example.com" }, identity: "be", identity_full: "you@example.com/be", issuer: enrollment.configuration.issuer, resource: enrollment.configuration.url };
async function retryWire(mode: "success" | "guard" | "abort" | "untyped") {
  const original = globalThis.fetch, abort = new AbortController();
  const requests: { token: string | null; body: string }[] = [];
  let tokens = 0, guards = 0;
  const wire = new Wire(enrollment.configuration, { token: async () => `native-${++tokens}` }, abort.signal, enrollment.sessionID, async () => { guards++; if (mode === "guard") throw new Error("Observed root drift"); });
  wire.client.connect = async transport => {
    await transport.start();
    try { await transport.send({ jsonrpc: "2.0", method: "notifications/test" }); }
    finally { await transport.close(); }
  };
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    requests.push({ token: request.headers.get("Authorization"), body: await request.text() });
    if (requests.length > 1) return new Response(null, { status: 202 });
    if (mode === "abort") setTimeout(() => abort.abort(), 1);
    return Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "limited", data: { code: mode === "untyped" ? "other" : "rate_limited", retry_after_ms: mode === "abort" ? 1000 : 5 } } }, { status: 429 });
  }) as typeof fetch;
  try {
    if (mode === "success") await wire.connect();
    else await expect(wire.connect()).rejects.toThrow();
    return { requests, tokens, guards, retryAfter: wire.admissionRetryAfterMs };
  } finally { globalThis.fetch = original; abort.abort(); }
}
test("typed HTTP429 retries the identical request only after guard and fresh native access", async () => {
  const result = await retryWire("success");
  expect(result.requests.map(r => r.token)).toEqual(["Bearer native-1", "Bearer native-2"]);
  expect(result.requests[0]!.body).toBe(result.requests[1]!.body);
  expect(result.guards).toBe(1); expect(result.retryAfter).toBe(5);
});
test("HTTP429 retry stops on observed drift or abort and ignores untyped refusals", async () => {
  for (const mode of ["guard", "abort", "untyped"] as const) {
    const result = await retryWire(mode);
    expect(result.requests).toHaveLength(1);
    expect(result.tokens).toBe(1);
    expect(result.guards).toBe(mode === "guard" ? 1 : 0);
  }
});
test("subscriber errors use structured tool codes and SDK resource data, never human prose or numeric codes", async () => {
  const wire = new Wire(enrollment.configuration, { token: async () => "native-secret" }, new AbortController().signal, enrollment.sessionID);
  for (const code of ["identity_unknown", "identity_in_use", "not_found", "unbound", "refused", "internal_error"]) {
    wire.client.callTool = async () => ({ isError: true, structuredContent: { code }, content: [{ type: "text", text: "Bearer native-secret\n at secret-token.ts:123" }] });
    try { await wire.call("delivery_renew"); throw new Error("expected refusal"); }
    catch (error) {
      expect(error).toBeInstanceOf(SubscriberError);
      expect((error as SubscriberError).code).toBe(code);
      expect(error instanceof LeaseUnavailable).toBe(code === "not_found" || code === "unbound");
      expect((error as Error).message).not.toContain("native-secret");
      expect((error as Error).message).not.toContain("secret-token.ts");
    }
    wire.client.readResource = async () => { throw Object.assign(new Error("untrusted resource prose"), { code: -32602, data: { code } }); };
    await expect(wire.read("grayboard://inbox")).rejects.toMatchObject({ code });
  }
  wire.client.callTool = async () => ({ isError: true, content: [{ type: "text", text: "identity_unknown: no live delivery lease" }] });
  await expect(wire.call("delivery_renew")).rejects.toMatchObject({ code: "invalid_response" });
  wire.client.readResource = async () => { throw Object.assign(new Error("transport failure"), { code: "not_found" }); };
  await expect(wire.read("grayboard://inbox")).rejects.toMatchObject({ message: "transport failure" });
});
test("enrollment fingerprint pins all logical fields independently of key order", () => {
  const hash = enrollmentHash(enrollment);
  expect(enrollmentHash({ ...enrollment, configuration: Object.fromEntries(Object.entries(enrollment.configuration).reverse()) as typeof enrollment.configuration })).toBe(hash);
  for (const changed of [{ ...enrollment, sessionID: "other" }, { ...enrollment, name: "fe" }, { ...enrollment, connectionID: "other" }, { ...enrollment, configuration: { ...enrollment.configuration, clientID: "other" } }]) expect(enrollmentHash(changed)).not.toBe(hash);
});
test("edited root metadata cannot manufacture restored approval", async () => {
  const stored: Record<string, unknown> = { rootSessionIDs: [enrollment.sessionID], [`enrollmentHash:${enrollment.sessionID}`]: enrollmentHash(enrollment) };
  const ctx = { location: { directory: "/worktree" }, storage: { get: async (key: string) => stored[key] }, session: { get: async () => ({ id: enrollment.sessionID, time: {}, metadata: { [METADATA]: { enabled: true, enrollment: { ...enrollment, connectionID: "forged" } } } }) } } as unknown as Context;
  const controller = new Controller(ctx, { mcpName: "grayboard" });
  let checked = false;
  controller.binding.check = async () => { checked = true; };
  await controller.restore();
  expect(checked).toBe(false);
  expect(controller.status()).toMatchObject({ state: "paused", sessionID: enrollment.sessionID, message: "Saved enrollment invalid; explicitly enroll again" });
});
export const items = [{ id: "direct:1", actionable: true, event: { body: "untrusted" }, ownership: 1, bind_gen: 1, name: "be" }, { id: "direct:2", actionable: false, event: {}, ownership: 1, bind_gen: 1, name: "be" }];
test("stable admission IDs pin principal/name/root but survive new capability/generation", () => {
  const id = stableID(enrollment, "direct:1", identity);
  expect(id).toMatch(/^msg_[a-f0-9]{64}$/);
  expect(stableID({ ...enrollment, connectionID: "new" }, "direct:1", identity)).toBe(id);
  expect(stableID({ ...enrollment, sessionID: "other" }, "direct:1", identity)).not.toBe(id);
  expect(stableID(enrollment, "direct:1", { ...identity, user: { email: "other@example.com" } })).not.toBe(id);
});
test("admission failure stops prefix with no receipt", async () => {
  const receipts: string[] = [];
  await expect(admitPrefix(items, async () => { throw new Error("failed"); }, async ids => { receipts.push(...ids); })).rejects.toThrow("failed");
  expect(receipts).toEqual([]);
});
test("receipt failure replays the same durable ID before later items", async () => {
  const admitted: string[] = [], receipts: string[] = [];
  await expect(admitPrefix(items, async i => { admitted.push(stableID(enrollment, i.id, identity)); }, async () => { throw new Error("lost response"); })).rejects.toThrow();
  await admitPrefix(items, async i => { admitted.push(stableID(enrollment, i.id, identity)); }, async ids => { receipts.push(...ids); });
  expect(admitted[0]).toBe(admitted[1]); expect(receipts).toEqual(["direct:1", "direct:2"]);
});
test("lease projection and issued batches require ownership, generation, name and authenticated principal", () => {
  const lease = { capability: "a".repeat(43), identity: { user_email: identity.user.email, identity_full: identity.identity_full }, ownership: 1, bind_gen: 1, expiresAt: Date.now() + 30_000 };
  expect(leaseOf(lease, enrollment).ownership).toBe(1);
  expect(() => leaseOf({ ...lease, bind_gen: 0 }, enrollment)).toThrow();
  expect(() => leaseOf({ ...lease, identity: { user_email: "other@example.com", identity_full: identity.identity_full } }, enrollment)).toThrow();
  expect(itemsOf({ items })).toEqual(items);
  expect(() => itemsOf({ items: [{ id: "missing", actionable: true, event: {} }] })).toThrow();
  expect(() => itemsOf({ items: Array(101).fill(items[0]) })).toThrow();
  expect(render(items[0]!)).toContain("untrusted sender content");
  expect(() => identityOf({ user_email: identity.user.email, identity_full: "foreign/be" }, enrollment)).toThrow();
});
