// #807 P3 C1: the row mappers, and what Bun.SQL actually returns for int8 (the second half needs Postgres).
import { expect, test } from "bun:test";
import { describePg, pgEmptyDatabase } from "../../../../tests/support/pg.ts";
import type { AuditFields } from "../identity.ts";
import { int8, int8OrNull, type AuditDetail, type JsonParam } from "./sql.ts";

test("int8 maps strings, numbers and bigints to a safe integer and refuses the rest", () => {
  expect(int8("1")).toBe(1);
  expect(int8("-42")).toBe(-42);
  expect(int8(7)).toBe(7);
  expect(int8(9n)).toBe(9);
  expect(int8("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
  expect(() => int8("9007199254740993")).toThrow("not a safe integer");
  expect(() => int8(2n ** 60n)).toThrow("not a safe integer");
  expect(() => int8("1.5")).toThrow("not a safe integer");
  expect(() => int8("")).toThrow("not a safe integer");
  expect(() => int8(null)).toThrow("unexpected null");
  expect(int8OrNull(null)).toBeNull();
  expect(int8OrNull(undefined)).toBeNull();
  expect(int8OrNull("3")).toBe(3);
  expect(() => int8OrNull("x")).toThrow("not a safe integer");
});

test("JsonParam refuses a string at the top, and takes strings inside", () => {
  const ok: JsonParam = { a: [1, true, null, { b: 2, c: "x" }], d: "y", e: ["z"] };
  // An audit row's detail as the identity store builds it (#807 P3 C3b): AuditFields fit with no cast.
  const audit: AuditFields = { as_admin: true, via: "test" };
  const detail: JsonParam = { binding: 1, scope: null, ...audit };
  // @ts-expect-error a string bound to ::jsonb is stored as a JSON string scalar, not parsed
  const bad: JsonParam = JSON.stringify(ok);
  expect(typeof bad).toBe("string");
  expect(detail).toMatchObject({ via: "test" });
});

test("AuditDetail takes an object only: a top-level number, boolean, null or string can't reach the jsonb insert", () => {
  const audit: AuditFields = { as_admin: true, via: "test" };
  const detail: AuditDetail = { binding: 1, scope: null, nested: { a: [1, "x"] }, ...audit };
  // @ts-expect-error bound uncast, a number fails jsonb's type check (42804)
  const n: AuditDetail = 42;
  // @ts-expect-error as does a boolean
  const b: AuditDetail = true;
  // @ts-expect-error null stores SQL NULL, not a JSON null
  const z: AuditDetail = null;
  // @ts-expect-error a string is stored as a JSON string scalar
  const s: AuditDetail = JSON.stringify(detail);
  expect([n, b, z, typeof s, detail.via]).toEqual([42, true, null, "string", "test"]);
});

describePg("Bun.SQL's int8 (the mappers exist for this)", () => {
  test("int8, count(*) and GREATEST over int8 come back as strings; int4 as a number", async () => {
    await using db = await pgEmptyDatabase();
    const [row] = await db.sql`SELECT 1::int8 AS a, count(*) AS n, GREATEST(1::int8, 2) AS g, 1::int4 AS i FROM (VALUES (1)) v`;
    expect(row).toEqual({ a: "1", n: "1", g: "2", i: 1 });
  });
});
