import { expect, test } from "bun:test";
import { formatClaim } from "./claims.ts";

// #871: a holder the server withholds (a team's alias, outside the team) prints as nobody named, with no note.
test("formatClaim prints a withheld holder as someone you can't see", () => {
  const at = Date.UTC(2026, 0, 2, 3, 4);
  expect(formatClaim({ key: "ticket:ENG-1", holder: null, note: null, expires_at: at } as Parameters<typeof formatClaim>[0])).toBe(
    "ticket:ENG-1 held by someone you can't see until 2026-01-02T03:04Z",
  );
  expect(formatClaim({ key: "ticket:ENG-2", holder: "bob@example.com/fe", note: "bob's", expires_at: at } as Parameters<typeof formatClaim>[0])).toBe(
    "ticket:ENG-2 held by bob@example.com/fe until 2026-01-02T03:04Z: bob's",
  );
});
