import { expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { repositoryGitEnv } from "../../scripts/hosted-evidence.ts";
import { brokenSectionRefs, resolves, sectionKeys, sectionRefs } from "./doc_sections.ts";

// Every relative link and image in the repo's tracked markdown resolves to a
// file, and every #anchor to a heading GitHub renders; every § reference to a
// section (#886); every Tier-2 doc fits the CONTRACT §4 cap. A docs-only PR
// runs only this test (test.yml scope, #601), so it is what keeps such a PR
// from merging a broken link.

const root = resolve(import.meta.dir, "../..");

/** GitHub's heading slug: lowercased, punctuation dropped, spaces to hyphens, repeats numbered. */
export function headingAnchors(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  let fence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    const m = fence ? null : /^#{1,6} (.*)$/.exec(line);
    if (!m) continue;
    const base = m[1]!.trim().toLowerCase().replace(/`/g, "").replace(/[^\p{L}\p{N}\- _]/gu, "").replace(/ /g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

/** Relative link targets in a markdown file, outside code fences and inline code. */
export function relativeLinks(markdown: string): string[] {
  const out: string[] = [];
  let fence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const text = line.replace(/`[^`]*`/g, "");
    for (const m of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\b(?:src|srcset)="([^"]+)"/g)) {
      const url = (m[1] ?? m[2])!;
      if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) out.push(url);
    }
  }
  return out;
}

test("headingAnchors follows GitHub's slugs", () => {
  const a = headingAnchors("# Two operating modes\n## 7. Backups (optional)\n## `grayboard mcp`: the server\n## Install\n## Install\n```\n# not a heading\n```\n");
  expect([...a]).toEqual(["two-operating-modes", "7-backups-optional", "grayboard-mcp-the-server", "install", "install-1"]);
});

test("relativeLinks skips code, external URLs and mailto", () => {
  const links = relativeLinks("[a](docs/x.md#y) [b](https://e.com) `[c](no.md)` <img src=\"assets/i.png\">\n```\n[d](no.md)\n```\n[e](mailto:x@example.com) [f](#local \"title\")");
  expect(links).toEqual(["docs/x.md#y", "assets/i.png", "#local"]);
});

test("every relative link and anchor in tracked markdown resolves", () => {
  const r = Bun.spawnSync(["git", "ls-files", "*.md"], { cwd: root, env: repositoryGitEnv(process.env), stdout: "pipe", stderr: "pipe" });
  expect(r.exitCode).toBe(0);
  const files = r.stdout.toString().split("\n").filter(Boolean);
  expect(files).toContain("README.md");
  const anchors = new Map<string, Set<string>>();
  const anchorsOf = (path: string) => {
    let set = anchors.get(path);
    if (!set) anchors.set(path, set = headingAnchors(readFileSync(join(root, path), "utf8")));
    return set;
  };
  const broken: string[] = [];
  for (const file of files) {
    for (const url of relativeLinks(readFileSync(join(root, file), "utf8"))) {
      const [path, fragment] = url.split("#", 2) as [string, string | undefined];
      const target = path ? normalize(join(dirname(file), decodeURIComponent(path))) : file;
      if (!existsSync(join(root, target))) { broken.push(`${file}: ${url} (no such file)`); continue; }
      if (fragment && target.endsWith(".md") && statSync(join(root, target)).isFile() && !anchorsOf(target).has(fragment)) broken.push(`${file}: ${url} (no such heading)`);
    }
  }
  expect(broken).toEqual([]);
});

const tracked = (...patterns: string[]) => {
  const r = Bun.spawnSync(["git", "ls-files", ...patterns], { cwd: root, env: repositoryGitEnv(process.env), stdout: "pipe", stderr: "pipe" });
  expect(r.exitCode).toBe(0);
  return r.stdout.toString().split("\n").filter(Boolean);
};

test("sectionRefs binds a § to the adjacent file, a chained §, else the containing file; skips issues and RFCs", () => {
  const refs = sectionRefs("`a.md` §3, §4 and §5. README §Install here. Then (§2) and `b.md`), x (§6). #523 §3a, RFC 8252 §7.3, §8.1.");
  expect(refs.map(r => [r.file, r.also, r.section])).toEqual([
    ["a.md", undefined, "3"], ["a.md", undefined, "4"], ["a.md", undefined, "5"], ["README.md", undefined, "Install here"],
    [undefined, "README.md", "2"], [undefined, "b.md", "6"],
  ]);
});

test("resolves matches heading numbers and label word prefixes, headings, bold leads and top-level bullets", () => {
  const keys = sectionKeys("# T\n## 3. Boards and posts\n**Legacy GET streams** (#431). x\n- **Hosted core** (x) y\n- opencode (`adapters/opencode/`): z\n  - Nested thing\n```\n## 9. fenced\n```\n");
  for (const yes of ["3", "Boards", "Boards and posts", "Legacy GET streams", "Hosted core", "opencode", "Hosted core and more words"]) expect(resolves(keys, yes)).toBe(true);
  for (const no of ["9", "3.1", "Boards and claims", "Nested", "Legacy POST"]) expect(resolves(keys, no)).toBe(false);
});

test("every § reference in tracked docs and code resolves to a section", () => {
  const md = tracked("*.md");
  const files = tracked("*.md", "*.ts", "*.sh", "*.mjs", "*.js", "*.yml")
    .filter(f => !f.startsWith(".github/release-notes/") && !f.startsWith("tests/integration/doc_")); // the checker's own fixtures
  expect(brokenSectionRefs(root, files, md)).toEqual([]);
});

// CONTRACT §4: a Tier-2 doc (docs/*.md; not the human guide/ or future/) stays at or under 25 KB.
test("every Tier-2 doc fits the 25 KB cap", () => {
  const over = tracked("docs/*.md").filter(f => !f.includes("/", 5)).map(f => [f, statSync(join(root, f)).size] as const).filter(([, n]) => n > 25 * 1024);
  expect(over).toEqual([]);
});
