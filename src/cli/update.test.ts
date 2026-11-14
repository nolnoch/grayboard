import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { STALE_TEMP_MS, newer, releasesOrigin, sweepStaleTemps, versionOrder } from "./update.ts";

test("newer compares release versions in semver order", () => {
  expect(newer("v1.0.1", "1.0.0")).toBe(true);
  expect(newer("v1.10.0", "1.9.3")).toBe(true);
  expect(newer("v1.0.0", "1.0.0")).toBe(false);
  expect(newer("v0.9.0", "1.0.0")).toBe(false);
  // A pre-release sorts before its release, so an rc user updates to the release (#511 audit).
  expect(newer("v2.3.1", "2.3.1-rc1")).toBe(true);
  expect(newer("v2.3.1-rc2", "2.3.1-rc1")).toBe(true);
  expect(newer("v2.3.1-rc1", "2.3.1")).toBe(false);
  // Anything but X.Y.Z[-pre] is refused, not guessed at.
  expect(() => newer("v2", "1.9.9")).toThrow('"v2" isn\'t a release version');
  expect(() => versionOrder("2.3.1", "")).toThrow('"" isn\'t a release version');
});

test("releasesOrigin: unset or empty is GitHub, trailing slashes go, http only to this machine", () => {
  expect(releasesOrigin(undefined)).toBeUndefined();
  expect(releasesOrigin("")).toBeUndefined();
  expect(releasesOrigin("https://mirror.example.com//")).toBe("https://mirror.example.com");
  expect(releasesOrigin("http://localhost:8080/")).toBe("http://localhost:8080");
  expect(releasesOrigin("http://127.0.0.1:9")).toBe("http://127.0.0.1:9");
  expect(releasesOrigin("http://[::1]:9")).toBe("http://[::1]:9");
  expect(() => releasesOrigin("http://mirror.example.com")).toThrow("must be https (or http to localhost): http://mirror.example.com");
  expect(() => releasesOrigin("mirror.example.com")).toThrow("isn't a URL");
  for (const raw of ["http://localhost:@evil.example.com", "https://user:pw@mirror.example.com"]) {
    expect(() => releasesOrigin(raw), raw).toThrow(`must not carry user info: ${raw}`);
  }
});

test("sweepStaleTemps removes only an interrupted update's old temp binaries (#317)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-update-"));
  const now = Date.now();
  const old = (now - STALE_TEMP_MS - 1000) / 1000;
  const file = (name: string, aged = true) => {
    const path = join(dir, name);
    writeFileSync(path, "x");
    if (aged) utimesSync(path, old, old);
    return path;
  };
  const stale = file(".grayboard-v2.4.2-0123456789abcdef");
  const rc = file(".grayboard-v1.3.0-rc1-fedcba9876543210");
  const fresh = file(".grayboard-v2.4.2-aaaaaaaaaaaaaaaa", false); // an update running now
  const binary = file("grayboard");
  const other = file(".grayboard-backup");
  const short = file(".grayboard-v2.4.2-0123");
  const target = file("target");
  symlinkSync(target, join(dir, ".grayboard-v2.4.2-bbbbbbbbbbbbbbbb"));
  mkdirSync(join(dir, ".grayboard-v2.4.2-cccccccccccccccc"));
  expect(sweepStaleTemps(dir, now).sort()).toEqual([rc, stale].sort());
  for (const kept of [fresh, binary, other, short, target, join(dir, ".grayboard-v2.4.2-bbbbbbbbbbbbbbbb"), join(dir, ".grayboard-v2.4.2-cccccccccccccccc")]) expect(existsSync(kept)).toBe(true);
  expect(sweepStaleTemps(join(dir, "missing"), now)).toEqual([]);
});
