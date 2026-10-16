import { expect, test } from "bun:test";

import { newer } from "./update.ts";

test("newer compares release tags numerically", () => {
  expect(newer("v1.0.1", "1.0.0")).toBe(true);
  expect(newer("v1.10.0", "1.9.3")).toBe(true);
  expect(newer("v1.0.0", "1.0.0")).toBe(false);
  expect(newer("v0.9.0", "1.0.0")).toBe(false);
  expect(newer("v2", "1.9.9")).toBe(true);
});
