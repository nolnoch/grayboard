import { expect, test } from "bun:test";
import { refusalOf } from "../src/results.ts";

const text = (t: string) => [{ type: "text" as const, text: t }];

test("#1220: a refusal's reason is its structured message, else its text, so a schema refusal shows the SDK's reason", () => {
  // An input-schema refusal: the code is structured, the reason only in the text.
  const reason = "Input validation error: Invalid arguments for tool bind: name: expected string, received number";
  expect(refusalOf({ content: text(reason), structuredContent: { code: "bad_request" }, isError: true })).toEqual({ code: "bad_request", why: reason });
  // A structured message wins over the text.
  expect(refusalOf({ content: text("other"), structuredContent: { code: "alias_held", message: "held by you@example.com/be" }, isError: true })).toEqual({ code: "alias_held", why: "held by you@example.com/be" });
  // Text only, as an older server answers: no code, the text without its "error: " prefix.
  expect(refusalOf({ content: text("error: name taken"), isError: true })).toEqual({ code: undefined, why: "name taken" });
  // Nothing to show.
  expect(refusalOf({ content: [], structuredContent: { code: "refused" }, isError: true })).toEqual({ code: "refused", why: "no reason given" });
  expect(refusalOf({ content: [], isError: true })).toEqual({ code: undefined, why: "no reason given" });
});
