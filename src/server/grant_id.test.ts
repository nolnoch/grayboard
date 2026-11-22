// #1583: a new grant id never starts with '-', which a command line reads as an option; the shape stays 43 base64url.
import { expect, test } from "bun:test";
import { newGrantId } from "./oauth-types.ts";

test("a draw whose base64url starts with '-' is redrawn", () => {
  // 0xf8's top six bits are 62, base64url's '-'.
  const draws = [Buffer.alloc(32, 0xf8), Buffer.alloc(32, 0x01)];
  let n = 0;
  const id = newGrantId(() => draws[n++]!);
  expect(n).toBe(2);
  expect(id).toBe(Buffer.alloc(32, 0x01).toString("base64url"));
  expect(Buffer.alloc(32, 0xf8).toString("base64url")[0]).toBe("-");
});

test("random grant ids keep the issued shape and none starts with '-'", () => {
  // Unredrawn, 4096 draws all missing '-' as the first character has probability (63/64)^4096, about 1e-28.
  for (let i = 0; i < 4096; i++) expect(newGrantId()).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_-]{42}$/);
});
