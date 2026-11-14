import { expect, test } from "bun:test";

import { get, newer, releasesOrigin, versionOrder } from "./update.ts";

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

// #316: a body with no Content-Length is counted as it streams, and reading stops past the cap.
test("get refuses a body over its cap, stated or streamed, and returns one at the cap", async () => {
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/stated") return new Response(new Uint8Array(2048));
      if (path === "/exact") return new Response(new Uint8Array(1024));
      // Endless, with no Content-Length: only a reader that stops can finish.
      return new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(512)); } }));
    },
  });
  try {
    const url = (p: string) => `http://localhost:${srv.port}${p}`;
    await expect(get(url("/stated"), "the stated file", 5000, 1024)).rejects.toThrow(`the stated file from ${url("/stated")} is larger than 1024 bytes; not updating`);
    await expect(get(url("/streamed"), "the streamed file", 5000, 1024)).rejects.toThrow(`the streamed file from ${url("/streamed")} is larger than 1024 bytes; not updating`);
    expect((await get(url("/exact"), "the exact file", 5000, 1024)).byteLength).toBe(1024);
  } finally {
    srv.stop(true);
  }
});
