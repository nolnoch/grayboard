// Regenerates the theme custom properties in docs/site/index.html from docs/site/tokens.json,
// so the page's colors never drift by hand. Dark-first: dark values on bare :root, light under
// prefers-color-scheme (unless the viewer chose dark) and under data-theme="light", dark again
// under data-theme="dark", and .dark-scope for surfaces that stay dark in both themes.
//
// Usage: bun scripts/site_tokens.ts          rewrite the block in place
//        bun scripts/site_tokens.ts --check  exit 1 if the block differs from tokens.json
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
export const PAGE = join(root, "docs/site/index.html");
export const TOKENS = join(root, "docs/site/tokens.json");
const BEGIN = "/* BEGIN generated tokens: bun scripts/site_tokens.ts writes this block from docs/site/tokens.json; do not edit. */";
const END = "/* END generated tokens */";

interface Tokens {
  color: { tokens: { name: string; value: { dark: string; light: string } }[] };
  type: { families: { sans: string; mono: string } };
  spacing: { tokens: { name: string; value: string }[] };
  radius: { tokens: { name: string; value: string }[] };
  stroke: { tokens: { name: string; value: string }[] };
}

export function tokensCss(t: Tokens): string {
  const block = (theme: "dark" | "light", indent = "  ") => t.color.tokens.map(c => `${indent}--${c.name}: ${c.value[theme]};\n`).join("");
  const fixed = [`  --font-sans: ${t.type.families.sans};\n`, `  --font-mono: ${t.type.families.mono};\n`,
    ...(["spacing", "radius", "stroke"] as const).flatMap(g => t[g].tokens.map(x => `  --${x.name}: ${x.value};\n`))].join("");
  return `${BEGIN}\n`
    + `:root {\n${block("dark")}${fixed}  color-scheme: dark;\n}\n`
    + `@media (prefers-color-scheme: light) {\n  :root:not([data-theme="dark"]) {\n${block("light", "    ")}    color-scheme: light;\n  }\n}\n`
    + `:root[data-theme="light"] {\n${block("light")}  color-scheme: light;\n}\n`
    + `:root[data-theme="dark"] {\n${block("dark")}  color-scheme: dark;\n}\n`
    + `.dark-scope {\n${block("dark")}  color-scheme: dark;\n}\n`
    + END;
}

/** The page with its generated block replaced from tokens.json. Throws when the markers are missing. */
export function regenerated(page: string, tokens: Tokens): string {
  const a = page.indexOf(BEGIN), b = page.indexOf(END);
  if (a < 0 || b < a) throw new Error(`docs/site/index.html: generated-tokens markers missing or out of order`);
  return page.slice(0, a) + tokensCss(tokens) + page.slice(b + END.length);
}

if (import.meta.main) {
  const page = readFileSync(PAGE, "utf8");
  const next = regenerated(page, JSON.parse(readFileSync(TOKENS, "utf8")));
  if (process.argv.includes("--check")) {
    if (next !== page) { console.error("docs/site/index.html: theme block is stale; run bun scripts/site_tokens.ts"); process.exit(1); }
  } else if (next !== page) {
    writeFileSync(PAGE, next);
    console.log("docs/site/index.html: theme block regenerated");
  }
}
