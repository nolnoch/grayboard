import { expect, test } from "bun:test";

import { retryWait } from "./client.ts";

test("a rate-limited client trusts the server's wait only within bounds", () => {
  expect(retryWait(1500, 4000)).toBe(1500);
  expect(retryWait(10, 4000)).toBe(100);
  expect(retryWait(10 * 2 ** 31, 4000)).toBe(30_000);
  for (const bad of [undefined, null, "500", Number.NaN, Number.POSITIVE_INFINITY, -1]) expect(retryWait(bad, 4000)).toBe(4000);
});
