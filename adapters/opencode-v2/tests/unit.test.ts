import { expect, test } from "bun:test";
import type { Context } from "@opencode/plugin/promise/plugin";
import { Controller } from "../src/controller.js";
import { METADATA, admitPrefix, enrollmentHash, identityOf, itemsOf, render, stableID, type Enrollment } from "../src/model.js";
const enrollment: Enrollment = { version: 1, sessionID: "ses_root", mcpName: "grayboard", configuration: { type: "remote", url: "https://grayboard.example.com/mcp", identity: "be", clientID: "opencode", scope: "grayboard:delivery grayboard:tools", discovery: "https://grayboard.example.com/.well-known/oauth-authorization-server" }, integrationID: "native", connectionID: "selected", identity: { user: { id: 1, email: "you@example.com" }, identity: "be", identity_full: "you@example.com/be", issuer: "https://grayboard.example.com", resource: "https://grayboard.example.com/mcp" } };
test("enrollment fingerprint pins every logical binding field independently of object key order", () => {
  const hash = enrollmentHash(enrollment);
  expect(enrollmentHash({ ...enrollment, identity: Object.fromEntries(Object.entries(enrollment.identity).reverse()) as typeof enrollment.identity })).toBe(hash);
  for (const changed of [
    { ...enrollment, sessionID: "ses_other" },
    { ...enrollment, connectionID: "other" },
    { ...enrollment, configuration: { ...enrollment.configuration, clientID: "other" } },
    { ...enrollment, identity: { ...enrollment.identity, user: { id: 2, email: "other@example.com" } } },
  ]) expect(enrollmentHash(changed)).not.toBe(hash);
});
test("edited root metadata cannot manufacture a restored enrollment or reach credentials", async () => {
  const stored: Record<string, unknown> = { rootSessionID: enrollment.sessionID, enrollmentHash: enrollmentHash(enrollment) };
  const ctx = {
    storage: { get: async (key: string) => stored[key] },
    session: { get: async () => ({ id: enrollment.sessionID, time: {}, metadata: { [METADATA]: { enabled: true, enrollment: { ...enrollment, connectionID: "forged" } } } }) },
  } as unknown as Context;
  await expect(new Controller(ctx, { mcpName: "grayboard", issuer: "" }).restore()).rejects.toThrow("Saved enrollment was edited");
});
const items = [{ id: "direct:1", actionable: true, event: { body: "untrusted" } }, { id: "direct:2", actionable: true, event: {} }];
test("stable IDs bind principal, issuer, resource, identity, item and target, not credential selection", () => {
  const id = stableID(enrollment, "direct:1");
  expect(id).toMatch(/^msg_[a-f0-9]{64}$/);
  expect(stableID({ ...enrollment, connectionID: "new" }, "direct:1")).toBe(id);
  expect(stableID({ ...enrollment, sessionID: "ses_other" }, "direct:1")).not.toBe(id);
  expect(stableID({ ...enrollment, identity: { ...enrollment.identity, user: { id: 2, email: "you@example.com" } } }, "direct:1")).not.toBe(id);
});
test("admission failure stops the prefix; retry is not a poisoned chain", async () => {
  const admitted: string[] = [], receipts: string[] = [];
  await expect(admitPrefix(items, async () => { throw new Error("failed"); }, async ids => { receipts.push(...ids); })).rejects.toThrow("failed");
  expect(receipts).toEqual([]);
  await admitPrefix(items, async i => { admitted.push(i.id); }, async ids => { receipts.push(...ids); });
  expect(admitted).toEqual(["direct:1", "direct:2"]); expect(receipts).toEqual(admitted);
});
test("lost receipt cannot skip a later direct item; retry uses identical stable admission ID", async () => {
  const admitted: string[] = [], receipts: string[] = [];
  await expect(admitPrefix(items, async i => { admitted.push(stableID(enrollment, i.id)); }, async () => { throw new Error("lost response"); })).rejects.toThrow();
  expect(admitted).toHaveLength(1);
  await admitPrefix(items, async i => { admitted.push(stableID(enrollment, i.id)); }, async ids => { receipts.push(...ids); });
  expect(admitted[0]).toBe(admitted[1]); expect(receipts).toEqual(["direct:1", "direct:2"]);
});
test("exact metadata issuer keeps raw default port while the resource remains canonical", () => {
  const issuer = "https://grayboard.example.com:443/hosted", resource = "https://grayboard.example.com/hosted/mcp";
  const identity = identityOf({ ...enrollment.identity, issuer, resource });
  expect(identity.issuer).toBe(issuer); expect(identity.resource).toBe(resource);
  expect(identity.issuer).not.toBe(new URL(issuer).href);
});
test("payload remains user data and resource batches are bounded", () => {
  expect(render(items[0]!)).toContain("untrusted sender content");
  expect(itemsOf({ items })).toEqual(items);
  expect(() => itemsOf({ items: Array(101).fill(items[0]) })).toThrow();
  expect(() => identityOf({ ...enrollment.identity, identity_full: "foreign/be" })).toThrow();
});
