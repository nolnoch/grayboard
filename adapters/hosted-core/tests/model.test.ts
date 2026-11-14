// #454: the addresses a server reports (held, primary, an inbox item's) are
// shown to the model and the user, so they carry no control or bidi characters.
import { expect, test } from "bun:test";
import { validAddress, validHeld } from "../src/model.ts";

test("validAddress refuses whitespace, C0/C1 controls and bidi overrides and isolates, and over 160 chars", () => {
  expect(validAddress("you@example.com/be")).toBe(true);
  expect(validAddress("id:0123abcd")).toBe(true);
  expect(validAddress("you@exämple.com/bé")).toBe(true);
  for (const bad of ["you@example.com/b e", "a\x00b", "a\x7fb", "a\x85b", "a\x9fb", "you@example.com/‮eb", "a‪b", "a⁦b", "a⁩b", "", "x".repeat(161)]) {
    expect(validAddress(bad)).toBe(false);
  }
  expect(validHeld(["you@example.com/be", "you@example.com/‮eb"])).toBe(false);
});
