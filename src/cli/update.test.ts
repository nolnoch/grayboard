import { expect, test } from "bun:test";

import { newer, releasesOrigin } from "./update.ts";

test("newer compares release tags numerically", () => {
  expect(newer("v1.0.1", "1.0.0")).toBe(true);
  expect(newer("v1.10.0", "1.9.3")).toBe(true);
  expect(newer("v1.0.0", "1.0.0")).toBe(false);
  expect(newer("v0.9.0", "1.0.0")).toBe(false);
  expect(newer("v2", "1.9.9")).toBe(true);
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
});
