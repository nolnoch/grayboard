// The site pages (docs/site/*.html) are the human, linked overviews: index.html is the README's
// marketing version, the others explain one mechanism. A minor or major release moves package.json
// past the version a page names, so the release has to revisit the pages' claims; a patch release
// doesn't. Their theme colors are generated from docs/site/tokens.json and never hand-edited
// (docs/site/README.md).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { PAGES, TOKENS, regenerated } from "../../scripts/site_tokens.ts";

const root = new URL("../..", import.meta.url).pathname;
const { version } = JSON.parse(readFileSync(`${root}package.json`, "utf8")) as { version: string };
const minor = version.split(".").slice(0, 2).join(".");
const tokens = JSON.parse(readFileSync(TOKENS, "utf8"));

test("docs/site has the one-pager and at least one other page", () => {
  expect(PAGES.map(p => basename(p))).toContain("index.html");
  expect(PAGES.length).toBeGreaterThan(1);
});

for (const path of PAGES) {
  const name = basename(path);
  test(`${name} names package.json's major.minor version everywhere`, () => {
    const named = [...readFileSync(path, "utf8").matchAll(/grayboard v(\d+\.\d+)/g)].map(m => m[1]);
    expect(named.length).toBeGreaterThan(0);
    expect(new Set(named)).toEqual(new Set([minor]));
  });
  test(`${name}'s theme block matches tokens.json`, () => {
    const page = readFileSync(path, "utf8");
    expect(regenerated(page, tokens, name)).toBe(page);
  });
}
