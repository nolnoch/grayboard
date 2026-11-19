// json_safe.ts's own rows (#807 P3 C7 decision 3); the stores' use of it is pinned by the audit and Slack contracts
// (U8, L8).
import { expect, test } from "bun:test";
import { jsonSafe, jsonTextSafe } from "./json_safe.ts";

test("jsonSafe keeps a __proto__ key as an own property and leaves the copy's prototype alone", () => {
  const input = JSON.parse('{"__proto__": {"x": "a\\u0000b"}, "y": 1}') as Record<string, unknown>;
  const out = jsonSafe(input);
  expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  expect(Object.keys(out)).toEqual(["__proto__", "y"]);
  expect(JSON.stringify(out)).toBe('{"__proto__":{"x":"a�b"},"y":1}');
  expect(JSON.parse(jsonTextSafe('{"__proto__": {"x": "a\\u0000b"}}'))).toEqual(JSON.parse('{"__proto__": {"x": "a�b"}}'));
  expect(jsonTextSafe('{"__proto__":{"x":"a\\u0000b"}}')).toBe('{"__proto__":{"x":"a�b"}}');
});
