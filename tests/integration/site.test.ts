// The one-pager (docs/site/index.html) is the linked marketing version of the README.
// A minor or major release moves package.json past the version the page names, so the
// release has to revisit the page's claims; a patch release doesn't. Its theme colors are
// generated from docs/site/tokens.json and never hand-edited (docs/site/README.md).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PAGE, TOKENS, regenerated } from "../../scripts/site_tokens.ts";

const root = new URL("../..", import.meta.url).pathname;

test("the one-pager names package.json's major.minor version everywhere", () => {
  const { version } = JSON.parse(readFileSync(`${root}package.json`, "utf8")) as { version: string };
  const minor = version.split(".").slice(0, 2).join(".");
  const named = [...readFileSync(PAGE, "utf8").matchAll(/grayboard v(\d+\.\d+)/g)].map(m => m[1]);
  expect(named.length).toBeGreaterThan(0);
  expect(new Set(named)).toEqual(new Set([minor]));
});

test("the one-pager's theme block matches tokens.json", () => {
  const page = readFileSync(PAGE, "utf8");
  expect(regenerated(page, JSON.parse(readFileSync(TOKENS, "utf8")))).toBe(page);
});
