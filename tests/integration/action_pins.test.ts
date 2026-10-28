import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");

function usesIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(usesIn);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => {
    if (key !== "uses") return usesIn(child);
    if (typeof child !== "string") throw new Error("Action reference must be a string");
    return [child];
  });
}

function pinned(reference: string): boolean {
  return /^[\w.-]+\/[\w.-]+(?:\/[\w.-]+)*@[0-9a-f]{40}$/.test(reference);
}

test("all workflows and recursively reachable local actions pin external actions to full commit SHAs", () => {
  const pending = readdirSync(resolve(root, ".github/workflows"))
    .filter((file) => /\.ya?ml$/.test(file))
    .map((file) => `.github/workflows/${file}`);
  const seen = new Set<string>();
  const external = new Set<string>();
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const document = Bun.YAML.parse(readFileSync(resolve(root, file), "utf8"));
    for (const reference of usesIn(document)) {
      if (reference.startsWith("./")) {
        expect(reference, file).not.toContain("..");
        const local = reference.slice(2);
        if (/\.ya?ml$/.test(local)) pending.push(local);
        else {
          const manifest = readdirSync(resolve(root, local)).find((name) => /^action\.ya?ml$/.test(name));
          expect(manifest, reference).toBeDefined();
          pending.push(`${local}/${manifest!}`);
        }
      } else {
        expect(pinned(reference), `${file}: ${reference}`).toBe(true);
        external.add(reference);
      }
    }
  }
  expect(seen.has(".github/actions/setup/action.yml")).toBe(true);
  expect(seen.has(".github/workflows/hosted.yml")).toBe(true);
  expect(external.size).toBeGreaterThan(0);
});

test("action pin policy rejects tags, short hashes and mutable or malformed references", () => {
  for (const ref of ["actions/checkout@v7.0.1", "actions/checkout@main", "actions/checkout@3d3c42e", "actions/checkout", "docker://image:latest"])
    expect(pinned(ref), ref).toBe(false);
  expect(pinned(`actions/checkout@${"a".repeat(40)}`)).toBe(true);
  expect(pinned(`owner/repo/subdir@${"b".repeat(40)}`)).toBe(true);
  expect(usesIn({ jobs: { gate: { uses: "./.github/workflows/hosted.yml" } }, steps: [{ uses: "./.github/actions/setup" }] }))
    .toEqual(["./.github/workflows/hosted.yml", "./.github/actions/setup"]);
});
