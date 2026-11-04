import { expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { repositoryGitEnv } from "../../scripts/hosted-evidence.ts";

// Every relative link and image in the repo's tracked markdown resolves to a
// file, and every #anchor to a heading GitHub renders. A docs-only PR runs
// only this test (test.yml scope, #601), so it is what keeps such a PR from
// merging a broken link.

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
