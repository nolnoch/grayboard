import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, normalize } from "node:path";

// Section references (`docs/x.md` §3, README §Updating the server, a bare §8 after a file on the same line) resolve
// to a heading, a bold lead or a top-level bullet in their file (#886). A number matches a heading numbered with it; a
// label (its words up to punctuation) matches a heading, lead or bullet when either's words begin the other's. A § names the file just
// before it (only spaces, backticks or an opening parenthesis between) or, after a comma or "and", the previous §'s
// target; else the containing file or the last file named earlier on the line, whichever has it. After an issue (#523 §3a) or an RFC (RFC 8252 §7.3) it names neither.

/** A doc's section keys: heading numbers ("3", "3.2") and lowercased heading, bold-lead and top-level bullet texts. */
export function sectionKeys(markdown: string): { numbers: Set<string>; labels: string[] } {
  const numbers = new Set<string>(), labels: string[] = [];
  let fence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const heading = /^#{1,6} (.*)$/.exec(line)?.[1];
    const lead = /^\s*(?:(?:[-*]|\d+\.) )?\*\*([^*]+)\*\*/.exec(line)?.[1];
    const text = heading ?? lead ?? /^[-*] (.*)$/.exec(line)?.[1];
    if (text === undefined) continue;
    const plain = text.replace(/`/g, "").trim();
    const n = /^(\d+(?:\.\d+)*)\.?\s/.exec(plain)?.[1];
    if (n) numbers.add(n);
    labels.push(plain.replace(/^\d+(?:\.\d+)*\.?\s+/, "").toLowerCase());
  }
  return { numbers, labels };
}

// `also`: for a § no file is adjacent to, the last file named earlier on its line, tried after the containing one.
export type SectionRef = { line: number; file: string | undefined; also?: string; section: string };
const FOREIGN = "";

const NAMED: Record<string, string> = { README: "README.md", CONTRACT: "docs/CONTRACT.md", AGENTS: "AGENTS.md", CONTRIBUTING: "CONTRIBUTING.md" };

/** The § references in one file's text. `file` is the doc a reference names, or undefined for the containing file. */
export function sectionRefs(text: string): SectionRef[] {
  const out: SectionRef[] = [];
  for (const [i, line] of text.split("\n").entries()) {
    // The last token: a file (or FOREIGN), or a § reference and the target it resolved to.
    let last: { end: number; target: string | undefined; ref: boolean } | undefined, named: string | undefined;
    const tokens = /([A-Za-z0-9_./-]+\.md)|\b(README|CONTRACT|AGENTS|CONTRIBUTING)\b(?=`?\s*§)|(#\d+|\bRFC \d+)(?=\s*§)|§(\d+(?:\.\d+)*[a-z]?|[A-Za-z][\w-]*(?: [A-Za-z][\w-]*)*)/g;
    for (const m of line.matchAll(tokens)) {
      const end = m.index! + m[0].length;
      if (m[1] || m[2] || m[3]) {
        last = { end, target: m[1] ?? (m[2] ? NAMED[m[2]] : FOREIGN), ref: false };
        if (last.target !== FOREIGN) named = last.target;
        continue;
      }
      const gap = last ? line.slice(last.end, m.index) : "";
      const bound = last && (last.ref ? /^`?(?:,|,? and| or)\s*`?$/.test(gap) : /^[`\s(]*$/.test(gap));
      const target = bound ? last!.target : undefined;
      last = { end, target, ref: true };
      if (target !== FOREIGN) out.push({ line: i + 1, file: target, ...(!bound && named ? { also: named } : {}), section: m[4]! });
    }
  }
  return out;
}

/** The repo path a reference's file names, from the referring file: as given, beside it, or a unique basename. */
export function resolveDoc(root: string, from: string, name: string, tracked: string[]): string | undefined {
  for (const p of [normalize(name), normalize(join(dirname(from), name))]) if (existsSync(join(root, p))) return p;
  const hits = tracked.filter(t => basename(t) === basename(name));
  return hits.length === 1 ? hits[0] : undefined;
}

const words = (text: string) => text.toLowerCase().split(/\s+/).map(w => w.replace(/^[(]+|[:.,;()]+$/g, "")).filter(Boolean);
export function resolves(keys: ReturnType<typeof sectionKeys>, section: string): boolean {
  if (/^\d/.test(section)) return keys.numbers.has(section);
  const ref = words(section);
  return keys.labels.some(label => {
    const key = words(label), n = Math.min(key.length, ref.length);
    return key.slice(0, n).every((w, i) => w === ref[i]);
  });
}

/** Every unresolved reference in `files` (repo paths), as "file:line: ref (reason)". */
export function brokenSectionRefs(root: string, files: string[], tracked: string[]): string[] {
  const cache = new Map<string, ReturnType<typeof sectionKeys>>();
  const keysOf = (p: string) => { let k = cache.get(p); if (!k) cache.set(p, k = sectionKeys(readFileSync(join(root, p), "utf8"))); return k; };
  const broken: string[] = [];
  for (const file of files) {
    for (const ref of sectionRefs(readFileSync(join(root, file), "utf8"))) {
      // Outside markdown a § no file is adjacent to names only the file named before it on its line.
      const md = file.endsWith(".md"), name = ref.file ?? (md ? undefined : ref.also);
      if (!md && name === undefined) continue;
      const target = name === undefined ? file : resolveDoc(root, file, name, tracked);
      if (!target) { broken.push(`${file}:${ref.line}: ${name} §${ref.section} (no such file)`); continue; }
      if (resolves(keysOf(target), ref.section)) continue;
      const also = md && ref.also && resolveDoc(root, file, ref.also, tracked);
      if (also && resolves(keysOf(also), ref.section)) continue;
      broken.push(`${file}:${ref.line}: ${target}${also ? ` or ${also}` : ""} §${ref.section} (no such section)`);
    }
  }
  return broken;
}
