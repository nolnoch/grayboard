import { expect, test } from "bun:test";
import type { Context } from "@opencode/plugin/promise/plugin";
import { Controller } from "../src/controller.js";
import { METADATA, admitPrefix, enrollmentHash, identityOf, itemsOf, leaseOf, render, stableID, type Enrollment } from "../src/model.js";
export const enrollment: Enrollment = { version: 2, sessionID: "ses_root", mcpName: "grayboard", configuration: { type: "remote", url: "https://grayboard.example.com/mcp", issuer: "https://grayboard.example.com", clientID: "opencode", scope: "grayboard:delivery grayboard:tools", configHash: "config" }, integrationID: "native", connectionID: "selected", name: "be" };
export const identity = { user: { id: 1, email: "you@example.com" }, identity: "be", identity_full: "you@example.com/be", issuer: enrollment.configuration.issuer, resource: enrollment.configuration.url };
test("enrollment fingerprint pins all logical fields independently of key order", () => {
  const hash = enrollmentHash(enrollment);
  expect(enrollmentHash({ ...enrollment, configuration: Object.fromEntries(Object.entries(enrollment.configuration).reverse()) as typeof enrollment.configuration })).toBe(hash);
  for (const changed of [{ ...enrollment, sessionID: "other" }, { ...enrollment, name: "fe" }, { ...enrollment, connectionID: "other" }, { ...enrollment, configuration: { ...enrollment.configuration, clientID: "other" } }]) expect(enrollmentHash(changed)).not.toBe(hash);
});
test("edited root metadata cannot manufacture restored approval", async () => {
  const stored: Record<string, unknown> = { rootSessionIDs: [enrollment.sessionID], [`enrollmentHash:${enrollment.sessionID}`]: enrollmentHash(enrollment) };
  const ctx = { storage: { get: async (key: string) => stored[key] }, session: { get: async () => ({ id: enrollment.sessionID, time: {}, metadata: { [METADATA]: { enabled: true, enrollment: { ...enrollment, connectionID: "forged" } } } }) } } as unknown as Context;
  await expect(new Controller(ctx, { mcpName: "grayboard" }).restore()).rejects.toThrow("Saved enrollment was edited");
});
export const items = [{ id: "direct:1", actionable: true, event: { body: "untrusted" }, ownership: 1, bind_gen: 1, name: "be" }, { id: "direct:2", actionable: false, event: {}, ownership: 1, bind_gen: 1, name: "be" }];
test("stable admission IDs pin principal/name/root but survive new capability/generation", () => {
  const id = stableID(enrollment, "direct:1", identity);
  expect(id).toMatch(/^msg_[a-f0-9]{64}$/);
  expect(stableID({ ...enrollment, connectionID: "new" }, "direct:1", identity)).toBe(id);
  expect(stableID({ ...enrollment, sessionID: "other" }, "direct:1", identity)).not.toBe(id);
  expect(stableID(enrollment, "direct:1", { ...identity, user: { ...identity.user, id: 2 } })).not.toBe(id);
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
test("lease projection and issued batches require ownership, generation, name and exact issuer", () => {
  const lease = { capability: "a".repeat(43), identity, ownership: 1, bind_gen: 1, expiresAt: Date.now() + 30_000 };
  expect(leaseOf(lease, enrollment).ownership).toBe(1);
  expect(() => leaseOf({ ...lease, bind_gen: 0 }, enrollment)).toThrow();
  expect(() => leaseOf({ ...lease, identity: { ...identity, issuer: identity.issuer + ":443" } }, enrollment)).toThrow();
  expect(itemsOf({ items })).toEqual(items);
  expect(() => itemsOf({ items: [{ id: "missing", actionable: true, event: {} }] })).toThrow();
  expect(() => itemsOf({ items: Array(101).fill(items[0]) })).toThrow();
  expect(render(items[0]!)).toContain("untrusted sender content");
  expect(() => identityOf({ ...identity, identity_full: "foreign/be" })).toThrow();
});
