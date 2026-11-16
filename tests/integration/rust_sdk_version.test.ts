// The Rust SDK's crate version moves with the release (AGENTS.md §Releasing):
// a consumer pins it by release tag, so a crate that lagged package.json would
// name a release it isn't (#929). No cargo needed.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");

test("the Rust SDK crate carries package.json's version", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  const manifest = readFileSync(join(root, "sdk/rust/grayboard/Cargo.toml"), "utf8");
  const pkgSection = manifest.split(/^\[/m).find((s) => s.startsWith("package]"));
  const version = pkgSection?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  expect(version).toBe(pkg.version);
  const lock = readFileSync(join(root, "sdk/rust/Cargo.lock"), "utf8");
  expect(lock).toContain(`name = "grayboard"\nversion = "${pkg.version}"`);
});
