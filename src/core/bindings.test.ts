import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { aliasScope, addressParts } from "./addresses.ts";
import { actingAs, asSessionId, holdAlias, holdsOf, idAddress, mintSessionKey, primaryOf, sessionAddresses } from "./bindings.ts";
import { CoreError } from "./errors.ts";
import { initCoreSchema } from "./schema.ts";
import { SESSION_ID, crockford13 } from "./session_id.ts";

// #284 decision 2: the session ID is the same 64 bits, as 13 Crockford characters.
test("crockford13 encodes 64 bits as 13 lowercase Crockford characters, big-endian", () => {
  expect(crockford13("0000000000000000")).toBe("0000000000000");
  expect(crockford13("0000000000000001")).toBe("0000000000001");
  expect(crockford13("000000000000001f")).toBe("000000000000z");
  expect(crockford13("0000000000000020")).toBe("0000000000010");
  // The top character carries the 4 bits left over.
  expect(crockford13("ffffffffffffffff")).toBe("fzzzzzzzzzzzz");
  expect(crockford13("0123456789abcdef")).toMatch(/^[0-9abcdefghjkmnpqrstvwxyz]{13}$/);
});

test("idAddress is id: and the key's SHA-256's first 64 bits", () => {
  const key = "a".repeat(64);
  const hex = createHash("sha256").update(key).digest("hex").slice(0, 16);
  expect(idAddress(key)).toBe(`id:${crockford13(hex)}`);
  expect(idAddress(key)).toMatch(SESSION_ID);
  expect(idAddress(mintSessionKey())).not.toBe(idAddress(mintSessionKey()));
});

test("a 1.x session ID is re-encoded; an id: one is left as it is", () => {
  expect(asSessionId("0123456789abcdef")).toBe(`id:${crockford13("0123456789abcdef")}`);
  const id = idAddress("b".repeat(64));
  expect(asSessionId(id)).toBe(id);
});

// #284 decision 16.
test("addressParts: IDs, team broadcasts, person and principal aliases, bare names", () => {
  const id = idAddress("d".repeat(64));
  expect(addressParts(id)).toEqual({ kind: "id", address: id });
  expect(addressParts("team:eng")).toEqual({ kind: "team", address: "team:eng", name: "eng" });
  expect(addressParts("You@Example.com/be")).toEqual({ kind: "alias", address: "you@example.com/be", scope: "you@example.com", scopeKind: "person", name: "be" });
  expect(addressParts("eng/deploy-bot")).toEqual({ kind: "alias", address: "eng/deploy-bot", scope: "eng", scopeKind: "principal", name: "deploy-bot" });
  expect(addressParts("be")).toEqual({ kind: "bare", address: "be", name: "be" });
  // A scope is one segment: the split is at the first "/", so the name can't hold another.
  expect(addressParts("eng/x/y")).toBeNull();
  expect(addressParts("a@mail.co.uk/my_identity-1")?.kind).toBe("alias");
  expect(addressParts(`b@example.com/${"a".repeat(32)}`)?.kind).toBe("alias");
  for (const bad of [
    "", "/be", "you@example.com/", "team:", "team:my team", "id:short", "~tail-1", "not@an-email/be", "a@localhost/fe",
    "alice@example.com", "channel:foo", `a@example.com/${"x".repeat(33)}`,
  ]) expect(addressParts(bad)).toBeNull();
});

test("aliasScope: a person's alias, local mode's bare name, or a principal's scope by its kind", () => {
  expect(aliasScope("you@example.com/be")).toEqual({ scope_kind: "person", scope_ref: "you@example.com", name: "be" });
  expect(aliasScope("be")).toEqual({ scope_kind: "person", scope_ref: null, name: "be" });
  const kinds = (n: string) => (n === "eng" ? "team" : n === "ci" ? "service" : null);
  expect(aliasScope("eng/x", kinds)).toEqual({ scope_kind: "team", scope_ref: "eng", name: "x" });
  expect(aliasScope("ci/x", kinds)).toEqual({ scope_kind: "service", scope_ref: "ci", name: "x" });
  // A principal scope needs the lookup, and a principal that owns it.
  expect(() => aliasScope("eng/x")).toThrow(/no team or service is named "eng"/);
  expect(() => aliasScope("ops/x", kinds)).toThrow(/no team or service is named "ops"/);
  for (const bad of ["team:eng", idAddress("e".repeat(64)), "~tail-1"]) expect(() => aliasScope(bad, kinds)).toThrow(/isn't an alias/);
});

// #284 S1: holds in bind order, the ID last; the primary is the oldest hold.
test("sessionAddresses and primaryOf follow bind order, even within one millisecond", () => {
  const db = new Database(":memory:");
  initCoreSchema(db);
  const id = idAddress("e".repeat(64));
  expect(sessionAddresses(db, id)).toEqual([id]);
  expect(primaryOf(holdsOf(db, id), id)).toBe(id);
  holdAlias(db, "zed", id, 5);
  holdAlias(db, "alpha", id, 5);
  holdAlias(db, "mid", id, 4);
  expect(sessionAddresses(db, id)).toEqual(["zed", "alpha", "mid", id]);
  expect(primaryOf(holdsOf(db, id), id)).toBe("zed");
  // Another session's holds don't push this one's clock.
  const other = idAddress("f".repeat(64));
  holdAlias(db, "solo", other, 1);
  expect(holdsOf(db, other)).toEqual(["solo"]);
});

// #284 S3.
test("actingAs resolves a bare name in the caller's scope and refuses an address it doesn't hold", () => {
  const id = idAddress("e".repeat(64));
  const server = ["you@example.com/a", "eng/x", id];
  expect(actingAs("a", server, "you@example.com")).toBe("you@example.com/a");
  expect(actingAs("ENG/x", server, "you@example.com")).toBe("eng/x");
  expect(actingAs(id, server, "you@example.com")).toBe(id);
  expect(() => actingAs("b", server, "you@example.com")).toThrow(new CoreError(`"b" isn't one of this session's addresses: you@example.com/a, eng/x, ${id}`));
  expect(() => actingAs("team:eng", ["team:eng"], "you@example.com")).toThrow(CoreError);
  expect(() => actingAs("not an address", server, "you@example.com")).toThrow(CoreError);
  expect(actingAs("a", ["a", id], null)).toBe("a");
  expect(() => actingAs("you@example.com/a", ["a", id], null)).toThrow(CoreError);
});

// #284 S12; AC 6: an alias carries labels, never a task reference.
test("the schema has the ID and alias metadata columns and no task_ref", () => {
  const db = new Database(":memory:");
  initCoreSchema(db);
  initCoreSchema(db);
  const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
  expect(cols("ids")).toEqual(expect.arrayContaining(["harness", "model", "effort"]));
  expect(cols("aliases")).toEqual(expect.arrayContaining(["task", "owner", "source_board", "spec_hash", "description", "last_bound_at"]));
  expect(cols("aliases")).not.toContain("task_ref");
});
