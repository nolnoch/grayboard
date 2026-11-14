import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db.ts";
import { HEALTH_TTL_MS, healthz } from "./http.ts";

let store: ReturnType<typeof openDatabase>;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gb-healthz-"));
  store = openDatabase(":memory:", { blobDir: dir });
});
afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

// #275: an unauthenticated flood costs one database probe per HEALTH_TTL_MS.
test("healthz probes the database at most once per window and reports the version", async () => {
  const probe = spyOn(store.repo.users, "findByEmail");
  for (let i = 0; i < 100; i++) {
    const r = healthz(store.repo, 5_000 + i);
    expect(r.status).toBe(200);
  }
  expect(probe).toHaveBeenCalledTimes(1);
  expect(await healthz(store.repo, 5_000 + HEALTH_TTL_MS - 1).json()).toMatchObject({ ok: true, version: expect.any(String) });
  expect(probe).toHaveBeenCalledTimes(1);
  healthz(store.repo, 5_000 + HEALTH_TTL_MS);
  expect(probe).toHaveBeenCalledTimes(2);
});

test("a failed probe is cached too: one 503 and one log line per window, then recovery is seen", () => {
  const probe = spyOn(store.repo.users, "findByEmail").mockImplementation(() => { throw new Error("disk I/O error"); });
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (let i = 0; i < 50; i++) expect(healthz(store.repo, 9_000 + i).status).toBe(503);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    probe.mockRestore();
    expect(healthz(store.repo, 9_000 + HEALTH_TTL_MS).status).toBe(200);
  } finally { log.mockRestore(); probe.mockRestore(); }
});

test("each repo has its own cache", () => {
  const other = openDatabase(":memory:", { blobDir: dir });
  try {
    const failing = spyOn(other.repo.users, "findByEmail").mockImplementation(() => { throw new Error("gone"); });
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(healthz(store.repo, 1_000).status).toBe(200);
      expect(healthz(other.repo, 1_000).status).toBe(503);
    } finally { failing.mockRestore(); log.mockRestore(); }
  } finally { other.db.close(); }
});
